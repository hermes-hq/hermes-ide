//! Built-in self-test: `hermes-ide --self-test=<report.json>`.
//!
//! Starts the REAL app (same binary, same data folder rules), proves the
//! essentials work, writes a JSON report and exits with 0 (all good) or 1.
//! It is what the release train runs on every installed artifact before a
//! build can be published, and what a user can run to diagnose an install.
//!
//! Checks, in order:
//!   1. `database`         — the app database opened and answers a query.
//!   2. `bridge_resources` — the bundled Claude bridge runtime is present.
//!   3. `webview`          — the main window rendered the UI.
//!   4. `pty_echo`         — a shell started in a PTY, ran a command we typed,
//!      and we read its output back.
//!
//! Nothing here talks to the network. The update check is suppressed while a
//! self-test runs (see `updater.rs`).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

/// Hard ceiling for the whole run: past this the report says "timeout" and
/// the process exits 1, whatever a check is stuck on.
const WATCHDOG: Duration = Duration::from_secs(90);
const WEBVIEW_TIMEOUT: Duration = Duration::from_secs(45);
const PTY_TIMEOUT: Duration = Duration::from_secs(25);

static REPORT_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
static FINISHED: AtomicBool = AtomicBool::new(false);

/// Parse `--self-test=<path>` / `--self-test <path>` out of an argument list
/// (the program name already stripped). Returns `None` when absent.
pub fn report_path_from_args<I>(args: I) -> Option<PathBuf>
where
    I: IntoIterator,
    I::Item: AsRef<str>,
{
    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        let arg = arg.as_ref();
        if let Some(rest) = arg.strip_prefix("--self-test=") {
            if !rest.is_empty() {
                return Some(PathBuf::from(rest));
            }
        } else if arg == "--self-test" {
            if let Some(next) = it.next() {
                let next = next.as_ref();
                if !next.is_empty() && !next.starts_with("--") {
                    return Some(PathBuf::from(next));
                }
            }
            // Bare flag: a report next to the executable is not useful; use cwd.
            return Some(PathBuf::from("hermes-self-test.json"));
        }
    }
    None
}

/// The report path when this process was started as a self-test.
pub fn requested() -> Option<&'static Path> {
    REPORT_PATH
        .get_or_init(|| report_path_from_args(std::env::args().skip(1)))
        .as_deref()
}

/// True while a self-test run is in progress in this process.
pub fn active() -> bool {
    requested().is_some()
}

/// Kick off the checks on a background thread. Call once, from `setup`,
/// after the app state is managed. The thread writes the report and exits
/// the process; the caller never hears back.
pub fn start(app: &AppHandle, report_path: PathBuf, db_path: PathBuf) {
    let app = app.clone();
    let watchdog_path = report_path.clone();
    let watchdog_app = app.clone();
    std::thread::Builder::new()
        .name("self-test-watchdog".into())
        .spawn(move || {
            std::thread::sleep(WATCHDOG);
            if !FINISHED.swap(true, Ordering::SeqCst) {
                let report = json!({
                    "ok": false,
                    "error": format!("self-test did not finish within {} s", WATCHDOG.as_secs()),
                    "version": watchdog_app.package_info().version.to_string(),
                });
                let _ = write_report(&watchdog_path, &report);
                log::error!("[self-test] watchdog fired — exiting 1");
                std::process::exit(1);
            }
        })
        .expect("spawn self-test watchdog");

    std::thread::Builder::new()
        .name("self-test".into())
        .spawn(move || {
            let started = Instant::now();
            let mut checks = Map::new();
            checks.insert("database".into(), check_database(&app, &db_path));
            checks.insert("bridge_resources".into(), check_bridge_resources(&app));
            checks.insert("webview".into(), check_webview(&app, WEBVIEW_TIMEOUT));
            checks.insert("pty_echo".into(), check_pty_echo_guarded(PTY_TIMEOUT));

            let ok = checks
                .values()
                .all(|c| c.get("ok") == Some(&Value::Bool(true)));
            let report = json!({
                "ok": ok,
                "version": app.package_info().version.to_string(),
                "identifier": app.config().identifier,
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "duration_ms": started.elapsed().as_millis() as u64,
                "checks": Value::Object(checks),
            });
            if FINISHED.swap(true, Ordering::SeqCst) {
                return; // the watchdog already reported
            }
            match write_report(&report_path, &report) {
                Ok(()) => log::info!(
                    "[self-test] {} — report written to {}",
                    if ok { "PASS" } else { "FAIL" },
                    report_path.display()
                ),
                Err(e) => {
                    log::error!("[self-test] could not write report: {}", e);
                    std::process::exit(1);
                }
            }
            finish(&app, if ok { 0 } else { 1 });
        })
        .expect("spawn self-test thread");
}

fn finish(app: &AppHandle, code: i32) {
    // Same clean-shutdown bookkeeping a normal quit does.
    if let Some(state) = app.try_state::<crate::AppState>() {
        let _ = std::fs::remove_file(&state.startup_marker_path);
    }
    app.exit(code);
    // `exit` asks the event loop to stop; if that never happens (a stuck
    // webview teardown, for instance) the exit code still has to be right.
    std::thread::sleep(Duration::from_secs(10));
    std::process::exit(code);
}

fn write_report(path: &Path, report: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    let text = serde_json::to_string_pretty(report).map_err(|e| e.to_string())?;
    std::fs::write(path, text + "\n").map_err(|e| e.to_string())
}

// ─── Checks ──────────────────────────────────────────────────────────

fn check_database(app: &AppHandle, db_path: &Path) -> Value {
    let started = Instant::now();
    let state = match app.try_state::<crate::AppState>() {
        Some(s) => s,
        None => return json!({ "ok": false, "error": "app state not initialised" }),
    };
    let query = state
        .db
        .lock()
        .map_err(|e| e.to_string())
        .and_then(|db| db.get_setting("update_channel"));
    match query {
        Ok(_) => json!({
            "ok": db_path.exists(),
            "path": display_path(db_path),
            "exists": db_path.exists(),
            "ms": started.elapsed().as_millis() as u64,
        }),
        Err(e) => json!({ "ok": false, "error": e, "path": display_path(db_path) }),
    }
}

fn check_bridge_resources(app: &AppHandle) -> Value {
    let bridge = match crate::agent::resolve_bridge_path(app) {
        Ok(p) => p,
        Err(e) => return json!({ "ok": false, "error": e }),
    };
    let dir = bridge.parent().map(Path::to_path_buf).unwrap_or_default();
    let required = [
        "package.json",
        "canUseToolHelpers.mjs",
        "bridgeRuntimeHelpers.mjs",
        "node_modules/@anthropic-ai/claude-agent-sdk/package.json",
    ];
    let missing: Vec<String> = required
        .iter()
        .filter(|rel| !dir.join(rel).exists())
        .map(|rel| rel.to_string())
        .collect();
    let node = crate::agent::which_node().map(|p| display_path(&p));
    json!({
        "ok": missing.is_empty(),
        "bridge": display_path(&bridge),
        "missing": missing,
        // Informational: node comes from the user's machine, not the bundle.
        "node": node,
    })
}

/// A path for the report. The report leaves the machine, so the home
/// folder (which carries the user name) is shown as `~`.
fn display_path(path: &Path) -> String {
    shorten_home(path, dirs::home_dir().as_deref())
}

/// `home` and everything under it is written as `~`; other paths are
/// unchanged. Only a whole-component match counts: `~testing` is not under
/// `~test`.
pub fn shorten_home(path: &Path, home: Option<&Path>) -> String {
    let Some(home) = home.filter(|h| !h.as_os_str().is_empty()) else {
        return path.display().to_string();
    };
    match path.strip_prefix(home) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".to_string(),
        Ok(rest) => format!("~{}{}", std::path::MAIN_SEPARATOR, rest.display()),
        Err(_) => path.display().to_string(),
    }
}

/// Ask the main webview whether the app UI rendered. Polls because the page
/// may still be loading when the checks start.
fn check_webview(app: &AppHandle, timeout: Duration) -> Value {
    let started = Instant::now();
    let deadline = started + timeout;
    let window = match app.get_webview_window("main") {
        Some(w) => w,
        None => return json!({ "ok": false, "error": "no main window" }),
    };
    let probe = r#"(function () {
  try {
    var root = document.getElementById("root");
    return { ready: document.readyState, rendered: !!(root && root.firstElementChild), title: document.title };
  } catch (e) { return { error: String(e) }; }
})()"#;
    let mut last = Value::Null;
    while Instant::now() < deadline {
        let (tx, rx) = mpsc::channel::<String>();
        if let Err(e) = window.eval_with_callback(probe.to_string(), move |result| {
            let _ = tx.send(result);
        }) {
            last = json!({ "error": format!("eval failed: {}", e) });
        } else if let Ok(raw) = rx.recv_timeout(Duration::from_secs(2)) {
            last = serde_json::from_str(&raw).unwrap_or(Value::String(raw));
            if last.get("rendered") == Some(&Value::Bool(true)) {
                return json!({
                    "ok": true,
                    "title": last.get("title").cloned().unwrap_or(Value::Null),
                    "ms": started.elapsed().as_millis() as u64,
                });
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    json!({
        "ok": false,
        "error": format!("the UI did not render within {} s", timeout.as_secs()),
        "last": last,
    })
}

/// What to type so the shell prints `marker`, without the typed line itself
/// containing the marker (the PTY echoes what we type, and we must not
/// mistake that echo for the shell's answer).
pub fn echo_command(shell: &str, marker: &str) -> Vec<String> {
    let (prefix, rest) = marker.split_at(marker.len().min(5));
    let shell_name = Path::new(shell)
        .file_name()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if shell_name.starts_with("pwsh") || shell_name.starts_with("powershell") {
        vec![format!("Write-Output ('{}' + '{}')\r\n", prefix, rest)]
    } else if shell_name.starts_with("cmd") {
        // cmd.exe expands %VAR% when the line is read, so set it on its own line.
        vec![
            format!("set HERMES_SELF_TEST={}\r\n", rest),
            format!("echo {}%HERMES_SELF_TEST%\r\n", prefix),
        ]
    } else {
        // sh, bash, zsh, fish: adjacent quoted words join into one word.
        vec![format!("echo \"{}\"'{}'\n", prefix, rest)]
    }
}

/// True once `output` shows the marker as the shell's own answer.
pub fn saw_marker(output: &str, marker: &str) -> bool {
    output.contains(marker)
}

/// Names this machine would print in a shell prompt: the user and host
/// names the environment reports, plus the home folder's last component.
fn local_names() -> Vec<String> {
    let mut names: Vec<String> = ["USER", "USERNAME", "LOGNAME", "HOSTNAME", "COMPUTERNAME"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .collect();
    if let Some(home) = dirs::home_dir() {
        if let Some(last) = home.file_name().and_then(|n| n.to_str()) {
            names.push(last.to_string());
        }
    }
    names
}

/// What the report keeps of the shell transcript. The report leaves the
/// machine (CI uploads it, users are asked to send it in), so the shell
/// prompt must not travel with it. On success only the line that carried
/// the marker (the shell's own answer) is kept. On failure the tail is
/// kept for diagnosis, with terminal escapes removed, every `user@host`
/// token blanked and the names in `names` (user, host, home folder)
/// blanked wherever they appear.
pub fn transcript_excerpt(transcript: &str, marker: &str, ok: bool, names: &[String]) -> String {
    if ok {
        return transcript
            .lines()
            .find(|l| saw_marker(l, marker))
            .map(|l| strip_escapes(l).trim().to_string())
            .unwrap_or_default();
    }
    let tail: String = transcript
        .chars()
        .rev()
        .take(600)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let mut out = strip_escapes(&tail)
        .split_inclusive(char::is_whitespace)
        .map(|tok| {
            if tok.trim_end().contains('@') {
                let ws: String = tok.chars().skip_while(|c| !c.is_whitespace()).collect();
                format!("<user@host>{ws}")
            } else {
                tok.to_string()
            }
        })
        .collect::<String>();
    for name in names {
        if name.len() >= 2 {
            out = out.replace(name.as_str(), "<redacted>");
        }
    }
    out
}

/// Drop ANSI/OSC escape sequences so prompt decorations cannot hide names.
fn strip_escapes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match chars.next() {
            // CSI: ESC [ ... final byte in 0x40..=0x7e
            Some('[') => {
                for n in chars.by_ref() {
                    if ('@'..='~').contains(&n) {
                        break;
                    }
                }
            }
            // OSC: ESC ] ... BEL or ESC \
            Some(']') => {
                let mut prev = '\0';
                for n in chars.by_ref() {
                    if n == '\x07' || (prev == '\x1b' && n == '\\') {
                        break;
                    }
                    prev = n;
                }
            }
            _ => {}
        }
    }
    out
}

/// DSR "report cursor position" (`ESC [ 6 n`), which line editors such as
/// PSReadLine send before they accept input.
const CURSOR_QUERY: &str = "\x1b[6n";
/// Our answer: cursor at row 1, column 1.
const CURSOR_REPLY: &[u8] = b"\x1b[1;1R";

/// How many cursor-position queries the shell has sent so far.
pub fn count_cursor_queries(output: &str) -> usize {
    output.matches(CURSOR_QUERY).count()
}

/// The PTY check on its own thread: if the PTY layer hangs (seen once on a
/// Windows Server runner), the report still gets written and says at which
/// stage it stopped, instead of the whole run hitting the watchdog.
fn check_pty_echo_guarded(timeout: Duration) -> Value {
    let stage = Arc::new(Mutex::new(String::from("start")));
    let stage_for_check = Arc::clone(&stage);
    let (tx, rx) = mpsc::channel::<Value>();
    let spawned = std::thread::Builder::new()
        .name("self-test-pty".into())
        .spawn(move || {
            let _ = tx.send(check_pty_echo(timeout, &stage_for_check));
        });
    if let Err(e) = spawned {
        return json!({ "ok": false, "error": format!("could not start the PTY check: {}", e) });
    }
    match rx.recv_timeout(timeout + Duration::from_secs(15)) {
        Ok(v) => v,
        Err(_) => json!({
            "ok": false,
            "error": format!(
                "the PTY check did not finish within {} s (stuck at: {})",
                timeout.as_secs() + 15,
                stage.lock().map(|s| s.clone()).unwrap_or_default()
            ),
        }),
    }
}

fn set_stage(stage: &Mutex<String>, what: &str) {
    if let Ok(mut s) = stage.lock() {
        *s = what.to_string();
    }
}

fn check_pty_echo(timeout: Duration, stage: &Mutex<String>) -> Value {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};

    let started = Instant::now();
    let shell = crate::pty::detect_shell();
    let marker = format!("hsts-{}", uuid::Uuid::new_v4().simple());
    set_stage(stage, "openpty");

    let pty_system = native_pty_system();
    let size = PtySize {
        rows: 24,
        cols: 120,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = match pty_system.openpty(size) {
        Ok(p) => p,
        Err(e) => return json!({ "ok": false, "shell": shell, "error": format!("openpty: {}", e) }),
    };
    let _ = pair.master.resize(size);

    set_stage(stage, "spawn shell");
    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(crate::pty::get_working_directory());
    cmd.env("TERM", "xterm-256color");
    cmd.env("HERMES_SELF_TEST", "1");

    #[cfg(target_os = "macos")]
    let child = {
        let tty = match pair.master.tty_name() {
            Some(t) => t,
            None => return json!({ "ok": false, "shell": shell, "error": "no tty name" }),
        };
        drop(pair.slave);
        match crate::pty::spawn::posix_spawn_in_pty(&cmd, &tty) {
            Ok(c) => c,
            Err(e) => {
                return json!({ "ok": false, "shell": shell, "error": format!("spawn: {}", e) })
            }
        }
    };
    #[cfg(not(target_os = "macos"))]
    let child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "shell": shell, "error": format!("spawn: {}", e) }),
    };
    let mut child = child;

    set_stage(stage, "open reader/writer");
    let mut reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => return json!({ "ok": false, "shell": shell, "error": format!("reader: {}", e) }),
    };
    let mut writer = match pair.master.take_writer() {
        Ok(w) => w,
        Err(e) => return json!({ "ok": false, "shell": shell, "error": format!("writer: {}", e) }),
    };

    let output = Arc::new(Mutex::new(String::new()));
    let sink = Arc::clone(&output);
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut s) = sink.lock() {
                        s.push_str(&String::from_utf8_lossy(&buf[..n]));
                    }
                }
            }
        }
    });

    let snapshot = || output.lock().map(|s| s.clone()).unwrap_or_default();
    let deadline = started + timeout;

    // Give the shell a moment to start (typed-ahead input is kept by the
    // line discipline either way, this only makes the transcript tidier).
    set_stage(stage, "wait for first output");
    let settle = Instant::now() + Duration::from_secs(2);
    while Instant::now() < settle && snapshot().is_empty() {
        std::thread::sleep(Duration::from_millis(50));
    }
    let first_output_ms = started.elapsed().as_millis() as u64;

    set_stage(stage, "type the command");
    let lines = echo_command(&shell, &marker);
    for line in &lines {
        if let Err(e) = writer
            .write_all(line.as_bytes())
            .and_then(|_| writer.flush())
        {
            return json!({ "ok": false, "shell": shell, "error": format!("write: {}", e) });
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    let typed_ms = started.elapsed().as_millis() as u64;

    set_stage(stage, "wait for the answer");
    let mut ok = false;
    let mut queries_answered = 0usize;
    while Instant::now() < deadline {
        let text = snapshot();
        if saw_marker(&text, &marker) {
            ok = true;
            break;
        }
        // A real terminal answers the shell's "where is the cursor?" query;
        // PowerShell's line editor waits for that answer before it reads
        // any input. Play the terminal's part.
        let queries = count_cursor_queries(&text);
        while queries_answered < queries {
            let _ = writer.write_all(CURSOR_REPLY).and_then(|_| writer.flush());
            queries_answered += 1;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let answered_ms = started.elapsed().as_millis() as u64;

    // Ask the shell to leave, then make sure it is gone.
    set_stage(stage, "shell exit");
    let _ = writer.write_all(b"exit\r\n").and_then(|_| writer.flush());
    let exit_deadline = Instant::now() + Duration::from_secs(3);
    let mut exit_status: Option<String> = None;
    while Instant::now() < exit_deadline {
        match child.try_wait() {
            Ok(Some(status)) => {
                exit_status = Some(format!("{:?}", status));
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => {
                exit_status = Some(format!("wait error: {}", e));
                break;
            }
        }
    }
    if exit_status.is_none() {
        set_stage(stage, "kill shell");
        let _ = child.kill();
        let _ = child.wait();
        exit_status = Some("killed".into());
    }
    set_stage(stage, "close pty");
    drop(writer);
    drop(pair.master);

    let transcript = snapshot();
    let tail = transcript_excerpt(&transcript, &marker, ok, &local_names());
    json!({
        "ok": ok,
        "shell": shell,
        "marker": marker,
        "first_output_ms": first_output_ms,
        "typed_ms": typed_ms,
        "answered_ms": answered_ms,
        "shell_exit": exit_status,
        "transcript_tail": tail,
        "error": if ok { Value::Null } else { Value::String("the shell never printed the marker".into()) },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_equals_form() {
        let p = report_path_from_args(["--self-test=/tmp/r.json"]);
        assert_eq!(p, Some(PathBuf::from("/tmp/r.json")));
    }

    #[test]
    fn parses_separate_argument_form() {
        let p = report_path_from_args(["--verbose", "--self-test", "out/r.json"]);
        assert_eq!(p, Some(PathBuf::from("out/r.json")));
    }

    #[test]
    fn bare_flag_uses_default_file_name() {
        let p = report_path_from_args(["--self-test"]);
        assert_eq!(p, Some(PathBuf::from("hermes-self-test.json")));
        let p = report_path_from_args(["--self-test", "--other"]);
        assert_eq!(p, Some(PathBuf::from("hermes-self-test.json")));
    }

    #[test]
    fn absent_flag_means_normal_start() {
        assert_eq!(report_path_from_args(["--pty-setup", "x"]), None);
        assert_eq!(report_path_from_args(Vec::<String>::new()), None);
        assert_eq!(report_path_from_args(["--self-test="]), None);
    }

    #[test]
    fn typed_line_never_contains_the_marker_itself() {
        let marker = "hsts-0123456789abcdef";
        for shell in [
            "/bin/zsh",
            "/bin/bash",
            "/usr/bin/fish",
            "sh",
            "pwsh",
            "powershell.exe",
            "C:\\Windows\\system32\\cmd.exe",
        ] {
            let lines = echo_command(shell, marker);
            assert!(!lines.is_empty(), "{shell}");
            for line in &lines {
                assert!(
                    !saw_marker(line, marker),
                    "{shell}: typed text {line:?} would be mistaken for the answer"
                );
            }
        }
    }

    #[test]
    fn posix_shells_get_one_line_windows_shells_their_own_syntax() {
        let marker = "hsts-abc";
        assert_eq!(
            echo_command("/bin/bash", marker),
            vec!["echo \"hsts-\"'abc'\n".to_string()]
        );
        assert_eq!(
            echo_command("pwsh", marker),
            vec!["Write-Output ('hsts-' + 'abc')\r\n".to_string()]
        );
        assert_eq!(
            echo_command("cmd.exe", marker),
            vec![
                "set HERMES_SELF_TEST=abc\r\n".to_string(),
                "echo hsts-%HERMES_SELF_TEST%\r\n".to_string()
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_real_shell_answers_the_echo_command() {
        // `sh -c` is enough to prove the quoting produces the marker.
        let marker = "hsts-feedface";
        let line = echo_command("/bin/sh", marker).remove(0);
        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(line.trim_end())
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(saw_marker(&text, marker), "got {text:?}");
    }

    #[test]
    fn cursor_position_queries_are_counted_so_each_gets_one_answer() {
        assert_eq!(count_cursor_queries(""), 0);
        assert_eq!(count_cursor_queries("prompt> \x1b[6n"), 1);
        assert_eq!(count_cursor_queries("\x1b[6n\x1b[?25l\x1b[6n"), 2);
        assert_eq!(count_cursor_queries("\x1b[6c"), 0);
        assert!(std::str::from_utf8(CURSOR_REPLY).unwrap().ends_with('R'));
    }

    #[test]
    fn success_keeps_only_the_shells_answer_line() {
        let marker = "hsts-cafe";
        let names = vec!["test".to_string(), "test-host".to_string()];
        let transcript = "test@test-host ~ % echo hsts-'cafe'\r\n\x1b[?25lhsts-cafe  \x1b[?25h\r\ntest@test-host ~ % ";
        let kept = transcript_excerpt(transcript, marker, true, &names);
        assert_eq!(kept, "hsts-cafe");
        assert!(!kept.contains("test-host"));
    }

    #[test]
    fn failure_tail_carries_no_user_or_host_name() {
        let marker = "hsts-cafe";
        let names = vec![
            "test".to_string(),
            "test-host".to_string(),
            "test".to_string(),
        ];
        let transcript = "\x1b]0;test@test-host:~\x07\x1b[32mtest@test-host\x1b[0m:~$ echo hsts-'cafe'\r\nzsh: command not found\r\n[test@test-host ~]$ ";
        let kept = transcript_excerpt(transcript, marker, false, &names);
        assert!(!kept.contains("test-host"), "host leaked: {kept:?}");
        assert!(!kept.contains("test@"), "user leaked: {kept:?}");
        assert!(!kept.contains('\x1b'), "escapes kept: {kept:?}");
        assert!(
            kept.contains("command not found"),
            "diagnostic lost: {kept:?}"
        );
        assert!(
            kept.contains("<user@host>"),
            "prompt token not blanked: {kept:?}"
        );
    }

    #[test]
    fn failure_tail_is_bounded() {
        let long = "x".repeat(5000);
        let kept = transcript_excerpt(&long, "hsts-none", false, &[]);
        assert_eq!(kept.chars().count(), 600);
    }

    #[test]
    fn report_paths_show_the_home_folder_as_tilde() {
        let home = PathBuf::from("/srv/homes/test");
        let sep = std::path::MAIN_SEPARATOR;
        assert_eq!(
            shorten_home(
                &home
                    .join("Library")
                    .join("Application Support")
                    .join("app.db"),
                Some(&home)
            ),
            format!("~{sep}Library{sep}Application Support{sep}app.db")
        );
        assert_eq!(shorten_home(&home, Some(&home)), "~");
    }

    #[test]
    fn paths_outside_the_home_folder_are_kept_whole() {
        let home = PathBuf::from("/srv/homes/test");
        let outside = PathBuf::from("/opt/homebrew/bin/node");
        assert_eq!(
            shorten_home(&outside, Some(&home)),
            outside.display().to_string()
        );
        // A sibling that merely starts with the same characters is not home.
        let sibling = PathBuf::from("/srv/homes/testing/app.db");
        assert_eq!(
            shorten_home(&sibling, Some(&home)),
            sibling.display().to_string()
        );
        assert_eq!(shorten_home(&sibling, None), sibling.display().to_string());
        assert_eq!(
            shorten_home(&sibling, Some(Path::new(""))),
            sibling.display().to_string()
        );
    }

    #[test]
    fn report_is_written_with_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("report.json");
        write_report(&path, &json!({ "ok": true })).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap()["ok"], true);
    }
}
