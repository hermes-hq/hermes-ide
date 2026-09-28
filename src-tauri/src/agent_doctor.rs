//! The agent doctor (F16): for every agent in the catalog, is it installed,
//! which version, is it signed in, how exactly Hermes can tell what it is
//! doing, and can it resume a conversation.
//!
//! It asks the CLIs themselves — `detect.command` (usually `--version`) and
//! `auth.check` from `src/catalog/agents.json` — with the same PATH a new
//! terminal gets (the login shell's, then this process's, then the usual
//! install folders), so "installed" here means "a terminal can start it".
//! Only exit codes and the version number are kept; whatever else a CLI
//! prints (an account name, an e-mail) is dropped on the spot.

use serde::Serialize;
use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::agent_catalog::Agent;

/// How long a `--version` may take before the agent is reported as not
/// answering (a first run of an npm-installed CLI can be slow).
const VERSION_TIMEOUT: Duration = Duration::from_secs(8);
/// How long a sign-in check may take.
const AUTH_TIMEOUT: Duration = Duration::from_secs(8);
/// Output kept from a probe; a version line is short.
const OUTPUT_CAP: usize = 16 * 1024;

/// One catalog agent as the doctor sees it. Field names are the wire format
/// (`src/api/doctor.ts`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DoctorRow {
    pub id: String,
    pub name: String,
    pub installed: bool,
    /// The version the CLI reported, when it answered with one.
    pub version: Option<String>,
    pub min_version: Option<String>,
    /// False when the version is below `min_version`; None when either is unknown.
    pub version_ok: Option<bool>,
    /// "yes", "no" or "unknown" (no sign-in check, or it did not answer).
    pub signed_in: String,
    /// "exact" (the agent reports its own events), "signal" (notifications
    /// any program could print) or "none" (guessed from the terminal).
    pub signals: String,
    /// Whether Hermes can continue a conversation after a restart.
    pub resume: bool,
    /// The vendor retired this tool.
    pub retired: bool,
    pub retired_note: Option<String>,
    /// Shown only with the agentCatalog flag.
    pub beta: bool,
}

/// What running a probe command gave.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Probe {
    Exited { code: i32, output: String },
    TimedOut,
    Failed,
}

// ─── Pure parts ──────────────────────────────────────────────────────

/// The first version-looking token of a CLI's output ("2.1.283 (Claude
/// Code)" → "2.1.283", "codex-cli 0.145.0" → "0.145.0").
pub fn parse_version(output: &str) -> Option<String> {
    lazy_static::lazy_static! {
        static ref VERSION: regex::Regex =
            regex::Regex::new(r"(?:^|[^0-9.])v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.\-]+)?)").unwrap();
    }
    VERSION
        .captures(output)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

fn numeric_parts(v: &str) -> Vec<u64> {
    v.split(['-', '+'])
        .next()
        .unwrap_or("")
        .split('.')
        .map(|p| p.parse::<u64>().unwrap_or(0))
        .collect()
}

/// Whether `version` is at least `min` (numeric, component by component;
/// a pre-release suffix is ignored).
pub fn version_at_least(version: &str, min: &str) -> bool {
    let a = numeric_parts(version);
    let b = numeric_parts(min);
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    true
}

/// The catalog's confidence as the doctor names it.
pub fn signals_label(confidence: &str) -> &'static str {
    match confidence {
        "exact" => "exact",
        "signal" => "signal",
        _ => "none",
    }
}

/// File names a command may have in a folder on this OS.
fn candidate_names(name: &str) -> Vec<String> {
    if cfg!(windows) {
        let has_ext = Path::new(name).extension().is_some();
        let mut out = Vec::new();
        if has_ext {
            out.push(name.to_string());
        }
        let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
        for ext in exts.split(';').filter(|e| !e.is_empty()) {
            out.push(format!("{name}{}", ext.to_ascii_lowercase()));
        }
        out
    } else {
        vec![name.to_string()]
    }
}

fn is_executable(p: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(p) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// The first executable called `name` in `dirs`, in order.
pub fn find_in(dirs: &[PathBuf], name: &str) -> Option<PathBuf> {
    if name.is_empty() || name.contains(['/', '\\']) {
        return None;
    }
    for dir in dirs {
        for candidate in candidate_names(name) {
            let p = dir.join(&candidate);
            if is_executable(&p) {
                return Some(p);
            }
        }
    }
    None
}

/// Diagnose one agent. `find` resolves a binary name, `probe` runs a
/// command; both are passed in so the logic is testable without real CLIs.
pub fn diagnose(
    agent: &Agent,
    find: &dyn Fn(&str) -> Option<PathBuf>,
    probe: &dyn Fn(&Path, &[String], Duration) -> Probe,
) -> DoctorRow {
    let terminal = &agent.terminal;
    let mut row = DoctorRow {
        id: agent.id.clone(),
        name: agent.name.clone(),
        installed: false,
        version: None,
        min_version: terminal.min_version.clone(),
        version_ok: None,
        signed_in: "unknown".to_string(),
        signals: signals_label(&terminal.signals.confidence).to_string(),
        resume: terminal.resume.by_id.is_some() || terminal.resume.latest.is_some(),
        retired: agent.status == "legacy",
        retired_note: if agent.status == "legacy" {
            agent.status_note.clone()
        } else {
            None
        },
        beta: agent.channel == "beta",
    };
    let Some(detect) = agent.detect.as_ref() else {
        return row;
    };
    let Some((bin, args)) = detect.command.split_first() else {
        return row;
    };
    let Some(path) = find(bin) else {
        return row;
    };
    row.installed = true;
    if let Probe::Exited { output, .. } = probe(&path, args, VERSION_TIMEOUT) {
        row.version = parse_version(&output);
    }
    row.version_ok = match (&row.version, &row.min_version) {
        (Some(v), Some(min)) => Some(version_at_least(v, min)),
        _ => None,
    };
    if let Some(check) = agent.auth.as_ref().and_then(|a| a.check.as_ref()) {
        if let Some((auth_bin, auth_args)) = check.split_first() {
            let auth_path = if auth_bin == bin {
                Some(path.clone())
            } else {
                find(auth_bin)
            };
            if let Some(auth_path) = auth_path {
                row.signed_in = match probe(&auth_path, auth_args, AUTH_TIMEOUT) {
                    Probe::Exited { code: 0, .. } => "yes",
                    Probe::Exited { .. } => "no",
                    Probe::TimedOut | Probe::Failed => "unknown",
                }
                .to_string();
            }
        }
    }
    row
}

// ─── The real environment ────────────────────────────────────────────

/// The login shell's PATH (Unix), so the doctor finds what a new terminal
/// finds. None when the shell does not answer.
#[cfg(unix)]
fn login_shell_path() -> Option<String> {
    const MARK: &str = "__HERMES_DOCTOR_PATH__=";
    let shell = crate::pty::detect_shell();
    let script = format!("printf '\\n{MARK}%s\\n' \"$PATH\"");
    let mut child = Command::new(&shell)
        .args(["-l", "-i", "-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("PS1", "")
        .env("PROMPT", "")
        .env("RPROMPT", "")
        .env("HISTFILE", "/dev/null")
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        let _ = tx.send(s);
    });
    let out = rx.recv_timeout(Duration::from_secs(10)).ok();
    let _ = child.kill();
    let _ = child.wait();
    let out = out?;
    out.lines()
        .rev()
        .find_map(|l| l.strip_prefix(MARK))
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
}

/// Where to look for agent CLIs, in order, without duplicates.
pub fn search_dirs() -> Vec<PathBuf> {
    if let Some(dirs) = e2e_search_dirs() {
        return dirs;
    }
    let mut dirs: Vec<PathBuf> = Vec::new();
    let push_all = |value: &OsStr, dirs: &mut Vec<PathBuf>| {
        for d in std::env::split_paths(value) {
            if !d.as_os_str().is_empty() && !dirs.contains(&d) {
                dirs.push(d);
            }
        }
    };
    #[cfg(unix)]
    if let Some(p) = login_shell_path() {
        push_all(OsStr::new(&p), &mut dirs);
    }
    if let Some(p) = std::env::var_os("PATH") {
        push_all(&p, &mut dirs);
    }
    #[cfg(unix)]
    for d in crate::platform::well_known_path_dirs() {
        if !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    dirs
}

/// Test builds only: `HERMES_E2E_AGENT_PATH` replaces the folders the doctor
/// looks in, so a real-app scenario can show "no agent installed" on a
/// machine that has some. Needs the `e2e` cargo feature (never in a release
/// build) AND `HERMES_E2E=1` at run time.
fn e2e_search_dirs() -> Option<Vec<PathBuf>> {
    #[cfg(feature = "e2e")]
    {
        if std::env::var("HERMES_E2E").ok().as_deref() != Some("1") {
            return None;
        }
        let value = std::env::var_os("HERMES_E2E_AGENT_PATH")?;
        Some(std::env::split_paths(&value).collect())
    }
    #[cfg(not(feature = "e2e"))]
    {
        None
    }
}

/// Run a probe command with a deadline. Its output is only read here.
pub fn run_probe(bin: &Path, args: &[String], path_env: &OsStr, timeout: Duration) -> Probe {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .env("PATH", path_env)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let Ok(mut child) = cmd.spawn() else {
        return Probe::Failed;
    };
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    for stream in [
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stream.take(OUTPUT_CAP as u64).read_to_end(&mut buf);
            let _ = tx.send(buf);
        });
    }
    drop(tx);
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Probe::TimedOut;
            }
            Err(_) => return Probe::Failed,
        }
    };
    // A child that left a grandchild holding the pipe open must not hang the doctor.
    let mut output = Vec::new();
    let settle = Instant::now() + Duration::from_secs(1);
    while let Some(left) = settle.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(left) {
            Ok(chunk) => output.extend(chunk),
            Err(_) => break,
        }
    }
    Probe::Exited {
        code: status.code().unwrap_or(-1),
        output: String::from_utf8_lossy(&output).into_owned(),
    }
}

/// Diagnose every catalog agent this build shows (beta ones only with the
/// agentCatalog flag; the Custom agent has nothing to check).
pub fn run_doctor(include_beta: bool) -> Vec<DoctorRow> {
    let dirs = search_dirs();
    let path_env: OsString = std::env::join_paths(&dirs).unwrap_or_default();
    let agents: Vec<&'static Agent> = crate::agent_catalog::catalog()
        .agents
        .iter()
        .filter(|a| !a.custom && (include_beta || a.channel == "stable"))
        .collect();
    let handles: Vec<_> = agents
        .into_iter()
        .map(|agent| {
            let dirs = dirs.clone();
            let path_env = path_env.clone();
            std::thread::spawn(move || {
                diagnose(agent, &|name| find_in(&dirs, name), &|bin, args, t| {
                    run_probe(bin, args, &path_env, t)
                })
            })
        })
        .collect();
    handles.into_iter().filter_map(|h| h.join().ok()).collect()
}

#[tauri::command]
pub async fn agent_doctor(include_beta: Option<bool>) -> Result<Vec<DoctorRow>, String> {
    let include_beta = include_beta.unwrap_or(false);
    tokio::task::spawn_blocking(move || run_doctor(include_beta))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn agent(id: &str) -> &'static Agent {
        crate::agent_catalog::agent(id).unwrap()
    }

    #[test]
    fn versions_are_read_from_what_clis_print() {
        assert_eq!(
            parse_version("2.1.283 (Claude Code)").as_deref(),
            Some("2.1.283")
        );
        assert_eq!(
            parse_version("codex-cli 0.145.0\n").as_deref(),
            Some("0.145.0")
        );
        assert_eq!(parse_version("opencode v1.18.2").as_deref(), Some("1.18.2"));
        assert_eq!(
            parse_version("aider 0.86.1-dev").as_deref(),
            Some("0.86.1-dev")
        );
        assert_eq!(parse_version("goose 1.9").as_deref(), Some("1.9"));
        assert_eq!(parse_version("no version here"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn minimum_versions_compare_numerically() {
        assert!(version_at_least("2.1.283", "2.1.0"));
        assert!(version_at_least("2.10.0", "2.9.9"));
        assert!(version_at_least("2.1", "2.1.0"));
        assert!(!version_at_least("2.0.99", "2.1.0"));
        assert!(!version_at_least("0.144.9", "0.145.0"));
        assert!(version_at_least("1.0.0-beta.1", "1.0.0"));
    }

    #[test]
    fn a_missing_cli_is_not_installed_and_nothing_is_run() {
        let ran = RefCell::new(0);
        let row = diagnose(agent("claude"), &|_| None, &|_, _, _| {
            *ran.borrow_mut() += 1;
            Probe::Failed
        });
        assert!(!row.installed);
        assert_eq!(row.version, None);
        assert_eq!(row.signed_in, "unknown");
        assert_eq!(*ran.borrow(), 0);
        // What the catalog says holds even when it is not installed.
        assert_eq!(row.signals, "exact");
        assert!(row.resume);
        assert_eq!(row.min_version.as_deref(), Some("2.1.0"));
    }

    #[test]
    fn an_installed_signed_in_cli_reports_version_and_yes() {
        let calls = RefCell::new(Vec::<Vec<String>>::new());
        let row = diagnose(
            agent("claude"),
            &|name| Some(PathBuf::from(format!("/fake/{name}"))),
            &|bin, args, _| {
                calls.borrow_mut().push(
                    std::iter::once(bin.display().to_string())
                        .chain(args.iter().cloned())
                        .collect(),
                );
                if args.first().map(String::as_str) == Some("--version") {
                    Probe::Exited {
                        code: 0,
                        output: "2.1.300 (Claude Code)".into(),
                    }
                } else {
                    Probe::Exited {
                        code: 0,
                        output: "{\"loggedIn\":true,\"email\":\"x@y\"}".into(),
                    }
                }
            },
        );
        assert!(row.installed);
        assert_eq!(row.version.as_deref(), Some("2.1.300"));
        assert_eq!(row.version_ok, Some(true));
        assert_eq!(row.signed_in, "yes");
        assert_eq!(
            *calls.borrow(),
            vec![
                vec!["/fake/claude".to_string(), "--version".into()],
                vec!["/fake/claude".to_string(), "auth".into(), "status".into()],
            ]
        );
    }

    #[test]
    fn a_failing_auth_check_is_signed_out_and_a_hang_is_unknown() {
        let find = |name: &str| Some(PathBuf::from(format!("/fake/{name}")));
        let out = diagnose(agent("codex"), &find, &|_, args, _| {
            if args.first().map(String::as_str) == Some("--version") {
                Probe::Exited {
                    code: 0,
                    output: "codex-cli 0.100.0".into(),
                }
            } else {
                Probe::Exited {
                    code: 1,
                    output: "Not logged in".into(),
                }
            }
        });
        assert_eq!(out.signed_in, "no");
        assert_eq!(
            out.version_ok,
            Some(false),
            "0.100.0 is below the catalog minimum"
        );
        let hang = diagnose(agent("codex"), &find, &|_, args, _| {
            if args.first().map(String::as_str) == Some("--version") {
                Probe::Exited {
                    code: 0,
                    output: "0.145.0".into(),
                }
            } else {
                Probe::TimedOut
            }
        });
        assert_eq!(hang.signed_in, "unknown");
    }

    #[test]
    fn agents_without_a_sign_in_check_stay_unknown() {
        let row = diagnose(agent("aider"), &|n| Some(PathBuf::from(n)), &|_, _, _| {
            Probe::Exited {
                code: 0,
                output: "aider 0.86.0".into(),
            }
        });
        assert_eq!(row.signed_in, "unknown");
        assert_eq!(row.signals, "none");
    }

    #[test]
    fn retired_tools_are_flagged_with_the_catalog_note() {
        let row = diagnose(agent("gemini"), &|_| None, &|_, _, _| Probe::Failed);
        assert!(row.retired);
        assert!(row
            .retired_note
            .as_deref()
            .unwrap_or("")
            .contains("Retired"));
        assert!(!diagnose(agent("claude"), &|_| None, &|_, _, _| Probe::Failed).retired);
    }

    #[test]
    fn find_in_takes_the_first_executable_in_order() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let name = if cfg!(windows) { "tool.cmd" } else { "tool" };
        for dir in [a.path(), b.path()] {
            std::fs::write(dir.join(name), "echo").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(dir.join(name), std::fs::Permissions::from_mode(0o755))
                    .unwrap();
            }
        }
        let dirs = vec![
            PathBuf::from("/definitely/not/here"),
            b.path().to_path_buf(),
            a.path().to_path_buf(),
        ];
        assert_eq!(find_in(&dirs, "tool"), Some(b.path().join(name)));
        assert_eq!(find_in(&dirs, "other"), None);
        assert_eq!(
            find_in(&dirs, "../tool"),
            None,
            "a name with a path is never looked up"
        );
    }

    #[cfg(unix)]
    #[test]
    fn run_probe_reads_output_exit_codes_and_times_out() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fake");
        std::fs::write(
            &script,
            "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'fake 9.8.7'; exit 0; fi\nif [ \"$1\" = hang ]; then sleep 5; fi\nexit 3\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = std::env::var_os("PATH").unwrap_or_default();
        let ok = run_probe(
            &script,
            &["--version".to_string()],
            &path,
            Duration::from_secs(5),
        );
        assert_eq!(
            ok,
            Probe::Exited {
                code: 0,
                output: "fake 9.8.7\n".into()
            }
        );
        let bad = run_probe(
            &script,
            &["auth".to_string()],
            &path,
            Duration::from_secs(5),
        );
        assert!(matches!(bad, Probe::Exited { code: 3, .. }));
        let t0 = Instant::now();
        let hang = run_probe(
            &script,
            &["hang".to_string()],
            &path,
            Duration::from_millis(300),
        );
        assert_eq!(hang, Probe::TimedOut);
        assert!(t0.elapsed() < Duration::from_secs(4));
        assert_eq!(
            run_probe(
                &dir.path().join("missing"),
                &[],
                &path,
                Duration::from_secs(1)
            ),
            Probe::Failed
        );
    }

    #[cfg(not(feature = "e2e"))]
    #[test]
    fn the_test_path_override_is_ignored_outside_test_builds() {
        std::env::set_var("HERMES_E2E_AGENT_PATH", "/nowhere");
        assert_eq!(e2e_search_dirs(), None);
        std::env::remove_var("HERMES_E2E_AGENT_PATH");
    }

    #[test]
    fn every_catalog_agent_but_custom_gets_a_row_with_its_channel() {
        // Nothing is installed on this PATH, so no CLI is run.
        let rows: Vec<DoctorRow> = crate::agent_catalog::catalog()
            .agents
            .iter()
            .filter(|a| !a.custom)
            .map(|a| diagnose(a, &|_| None, &|_, _, _| Probe::Failed))
            .collect();
        assert!(rows.len() >= 10);
        assert!(rows.iter().any(|r| r.id == "opencode" && r.beta));
        assert!(rows
            .iter()
            .any(|r| r.id == "claude" && !r.beta && r.name == "Claude Code"));
    }
}
