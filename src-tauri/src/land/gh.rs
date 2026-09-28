//! The GitHub CLI (`gh`) for the Land sheet: is it there and signed in,
//! open and close a pull request, read its checks and a failing check's log.
//!
//! Hermes only ever runs `gh` the person installed; it never handles a token.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GhState {
    Ready,
    Missing,
    SignedOut,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GhStatus {
    pub state: GhState,
    /// One line for people (the account, or why it is unavailable).
    pub detail: String,
}

/// How to run gh: the program, plus arguments that go before gh's own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GhCommand {
    pub program: PathBuf,
    pub prefix: Vec<String>,
}

/// Test builds only (cargo feature `e2e` and `HERMES_E2E=1`):
/// `HERMES_E2E_GH` points at a stand-in gh script run with node, or is
/// `none` to act as if gh were not installed.
fn e2e_override() -> Option<Option<GhCommand>> {
    #[cfg(feature = "e2e")]
    {
        parse_override(
            std::env::var("HERMES_E2E").ok().as_deref(),
            std::env::var("HERMES_E2E_GH").ok().as_deref(),
        )
    }
    #[cfg(not(feature = "e2e"))]
    {
        None
    }
}

#[cfg(any(test, feature = "e2e"))]
fn parse_override(e2e: Option<&str>, value: Option<&str>) -> Option<Option<GhCommand>> {
    if !crate::e2e_protocol::is_enabled(e2e) {
        return None;
    }
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    if value == "none" {
        return Some(None);
    }
    Some(Some(GhCommand {
        program: PathBuf::from("node"),
        prefix: vec![value.to_string()],
    }))
}

fn exe_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["gh.exe", "gh.cmd", "gh"]
    } else {
        &["gh"]
    }
}

/// Look for gh on `path_var`, then where installers put it (a GUI app
/// launched from the Dock does not see the shell's PATH).
pub fn find_gh_in(path_var: Option<std::ffi::OsString>, extra: &[PathBuf]) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = path_var
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs.extend(extra.iter().cloned());
    for dir in dirs {
        for name in exe_names() {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn well_known_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
    ];
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local/bin"));
    }
    if cfg!(windows) {
        if let Some(pf) = std::env::var_os("ProgramFiles") {
            dirs.push(PathBuf::from(pf).join("GitHub CLI"));
        }
    }
    dirs
}

pub fn gh_command() -> Option<GhCommand> {
    if let Some(forced) = e2e_override() {
        return forced;
    }
    find_gh_in(std::env::var_os("PATH"), &well_known_dirs()).map(|program| GhCommand {
        program,
        prefix: Vec::new(),
    })
}

pub struct GhOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub fn run(
    gh: &GhCommand,
    dir: &Path,
    args: &[&str],
    stdin: Option<&str>,
) -> Result<GhOutput, String> {
    let mut cmd = Command::new(&gh.program);
    cmd.args(&gh.prefix)
        .args(args)
        .current_dir(dir)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Could not run gh: {e}"))?;
    if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
        pipe.write_all(text.as_bytes())
            .map_err(|e| format!("Could not talk to gh: {e}"))?;
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("gh did not finish: {e}"))?;
    Ok(GhOutput {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
    })
}

fn first_line(s: &str) -> String {
    s.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .to_string()
}

pub fn status(dir: &Path) -> GhStatus {
    let Some(gh) = gh_command() else {
        return GhStatus {
            state: GhState::Missing,
            detail: "GitHub CLI (gh) is not installed".into(),
        };
    };
    match run(&gh, dir, &["auth", "status"], None) {
        Ok(out) if out.code == 0 => GhStatus {
            state: GhState::Ready,
            detail: first_line(&format!("{}\n{}", out.stdout, out.stderr)),
        },
        Ok(out) => GhStatus {
            state: GhState::SignedOut,
            detail: {
                let line = first_line(&format!("{}\n{}", out.stderr, out.stdout));
                if line.is_empty() {
                    "gh is not signed in".into()
                } else {
                    line
                }
            },
        },
        Err(e) => GhStatus {
            state: GhState::Missing,
            detail: e,
        },
    }
}

fn fail(what: &str, out: &GhOutput) -> String {
    let why = first_line(&format!("{}\n{}", out.stderr, out.stdout));
    format!("{what}: {why}")
}

/// Open a pull request; returns its URL. The body goes through stdin so no
/// shell ever sees it.
pub fn create_pr(
    gh: &GhCommand,
    dir: &Path,
    base: &str,
    branch: &str,
    title: &str,
    body: &str,
) -> Result<String, String> {
    let out = run(
        gh,
        dir,
        &[
            "pr",
            "create",
            "--base",
            base,
            "--head",
            branch,
            "--title",
            title,
            "--body-file",
            "-",
        ],
        Some(body),
    )?;
    if out.code != 0 {
        return Err(fail("gh could not open the pull request", &out));
    }
    out.stdout
        .lines()
        .map(str::trim)
        .rfind(|l| l.starts_with("http"))
        .map(str::to_string)
        .ok_or_else(|| "gh did not say where the pull request is".to_string())
}

pub fn close_pr(gh: &GhCommand, dir: &Path, url: &str) -> Result<(), String> {
    let out = run(
        gh,
        dir,
        &[
            "pr",
            "close",
            url,
            "--comment",
            "Closed from Hermes (landing undone).",
        ],
        None,
    )?;
    if out.code == 0 || format!("{}{}", out.stdout, out.stderr).contains("already closed") {
        Ok(())
    } else {
        Err(fail("gh could not close the pull request", &out))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrCheck {
    pub name: String,
    #[serde(default)]
    pub state: String,
    /// pass, fail, pending, skipping or cancel.
    #[serde(default)]
    pub bucket: String,
    #[serde(default)]
    pub link: String,
    #[serde(default)]
    pub workflow: String,
}

pub fn parse_checks(stdout: &str) -> Option<Vec<PrCheck>> {
    serde_json::from_str::<Vec<PrCheck>>(stdout.trim()).ok()
}

/// The checks on a pull request. gh exits non-zero while checks fail or are
/// pending, so the JSON on stdout is what counts.
pub fn pr_checks(gh: &GhCommand, dir: &Path, url: &str) -> Result<Vec<PrCheck>, String> {
    let out = run(
        gh,
        dir,
        &[
            "pr",
            "checks",
            url,
            "--json",
            "name,state,bucket,link,workflow",
        ],
        None,
    )?;
    if let Some(checks) = parse_checks(&out.stdout) {
        return Ok(checks);
    }
    if format!("{}{}", out.stdout, out.stderr).contains("no checks reported") {
        return Ok(Vec::new());
    }
    Err(fail("gh could not read the checks", &out))
}

/// Run and job ids from a check link like
/// `https://github.com/o/r/actions/runs/123/job/456`.
pub fn run_and_job(link: &str) -> Option<(String, Option<String>)> {
    let rest = link.split("/actions/runs/").nth(1)?;
    let mut parts = rest.split('/');
    let run = parts
        .next()
        .filter(|r| r.chars().all(|c| c.is_ascii_digit()) && !r.is_empty())?;
    let job = match (parts.next(), parts.next()) {
        (Some("job"), Some(j)) if !j.is_empty() && j.chars().all(|c| c.is_ascii_digit()) => {
            Some(j.to_string())
        }
        _ => None,
    };
    Some((run.to_string(), job))
}

/// The log of the failed steps of a check.
pub fn failed_log(gh: &GhCommand, dir: &Path, link: &str) -> Result<String, String> {
    let (run_id, job) =
        run_and_job(link).ok_or_else(|| format!("Not a GitHub Actions check: {link}"))?;
    let mut args = vec!["run", "view", run_id.as_str(), "--log-failed"];
    if let Some(job) = job.as_deref() {
        args.push("--job");
        args.push(job);
    }
    let out = run(gh, dir, &args, None)?;
    if out.code != 0 {
        return Err(fail("gh could not fetch the log", &out));
    }
    Ok(out.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn the_override_needs_e2e_mode() {
        assert_eq!(parse_override(None, Some("/x/fake-gh.mjs")), None);
        assert_eq!(parse_override(Some("0"), Some("none")), None);
        assert_eq!(parse_override(Some("1"), None), None);
        assert_eq!(parse_override(Some("1"), Some("none")), Some(None));
        assert_eq!(
            parse_override(Some("1"), Some("/x/fake-gh.mjs")),
            Some(Some(GhCommand {
                program: PathBuf::from("node"),
                prefix: vec!["/x/fake-gh.mjs".into()]
            }))
        );
    }

    #[cfg(not(feature = "e2e"))]
    #[test]
    fn a_normal_build_ignores_the_override() {
        std::env::set_var("HERMES_E2E_GH", "none");
        assert_eq!(e2e_override(), None);
        std::env::remove_var("HERMES_E2E_GH");
    }

    #[test]
    fn gh_is_found_on_path_or_in_a_well_known_folder() {
        let a = TempDir::new().unwrap();
        let b = TempDir::new().unwrap();
        assert_eq!(
            find_gh_in(Some(a.path().as_os_str().to_owned()), &[b.path().into()]),
            None
        );
        let exe = b.path().join(exe_names()[0]);
        fs::write(&exe, "").unwrap();
        assert_eq!(
            find_gh_in(Some(a.path().as_os_str().to_owned()), &[b.path().into()]),
            Some(exe.clone())
        );
        let first = a.path().join(exe_names()[0]);
        fs::write(&first, "").unwrap();
        assert_eq!(
            find_gh_in(Some(a.path().as_os_str().to_owned()), &[b.path().into()]),
            Some(first),
            "PATH wins"
        );
    }

    #[test]
    fn checks_parse_from_gh_json_and_ignore_extra_fields() {
        let json = r#"[{"name":"test","state":"FAILURE","bucket":"fail","link":"https://github.com/o/r/actions/runs/9/job/10","workflow":"CI","extra":1},
                       {"name":"lint","state":"SUCCESS","bucket":"pass","link":"","workflow":"CI"}]"#;
        let checks = parse_checks(json).unwrap();
        assert_eq!(checks.len(), 2);
        assert_eq!(checks[0].bucket, "fail");
        assert_eq!(parse_checks("no checks"), None);
    }

    #[test]
    fn run_and_job_ids_come_from_the_check_link() {
        assert_eq!(
            run_and_job("https://github.com/o/r/actions/runs/123/job/456"),
            Some(("123".into(), Some("456".into())))
        );
        assert_eq!(
            run_and_job("https://github.com/o/r/actions/runs/123"),
            Some(("123".into(), None))
        );
        assert_eq!(run_and_job("https://example.com/status/1"), None);
        assert_eq!(
            run_and_job("https://github.com/o/r/actions/runs/x/job/1"),
            None
        );
    }
}
