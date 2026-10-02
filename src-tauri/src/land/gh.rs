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
    /// The remote a pull request would go to is not on a GitHub host gh
    /// knows (a local path, GitLab, Bitbucket, …).
    NotGithub,
}

/// The host of a remote URL: `https://host/…`, `ssh://user@host:port/…`,
/// `user@host:path` (scp style). None for a local path or `file://`.
pub fn remote_host(url: &str) -> Option<String> {
    let url = url.trim();
    if let Some((scheme, rest)) = url.split_once("://") {
        if scheme.eq_ignore_ascii_case("file") {
            return None;
        }
        let authority = rest.split('/').next().unwrap_or("");
        let host = authority.rsplit('@').next().unwrap_or("");
        let host = host.split(':').next().unwrap_or("");
        return (!host.is_empty()).then(|| host.to_lowercase());
    }
    // scp style: [user@]host:path — but not a Windows drive (C:\…) or a
    // path that merely contains a colon after a slash.
    let (before, _) = url.split_once(':')?;
    if before.contains('/') || before.contains('\\') || before.len() <= 1 {
        return None;
    }
    let host = before.rsplit('@').next().unwrap_or("");
    (!host.is_empty()).then(|| host.to_lowercase())
}

/// The URL of `remote` in `repo_path`, as written in the configuration
/// (before any `url.<base>.insteadOf` rewriting, which is how git fetches
/// it, not what repository it names).
pub fn remote_url(repo_path: &Path, remote: &str) -> Option<String> {
    let repo = git2::Repository::open(repo_path).ok()?;
    let cfg = repo.config().ok()?;
    cfg.get_string(&format!("remote.{remote}.url"))
        .ok()
        .or_else(|| repo.find_remote(remote).ok()?.url().map(str::to_string))
}

/// "origin (<url>) is not a GitHub repository".
pub fn not_github_message(remote: &str, url: &str) -> String {
    format!("{remote} ({url}) is not a GitHub repository")
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
        match pipe.write_all(text.as_bytes()) {
            // gh stopped before reading all of it (it refused early, for
            // example because the pull request exists); its exit code and
            // message below say why, which is what the user needs to see.
            Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => {}
            r => r.map_err(|e| format!("Could not talk to gh: {e}"))?,
        }
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

/// Whether gh can open a pull request for `remote` of `dir`: installed,
/// the remote on a GitHub host, and signed in to that host. A remote that
/// is a local path, or on a host gh is not signed in to and that is not
/// github.com, is `NotGithub`.
pub fn status_for(dir: &Path, remote: Option<&str>) -> GhStatus {
    status_for_with(gh_command(), dir, remote)
}

fn status_for_with(gh: Option<GhCommand>, dir: &Path, remote: Option<&str>) -> GhStatus {
    let remote = remote.unwrap_or("origin");
    let url = remote_url(dir, remote);
    let host = url.as_deref().and_then(remote_host);
    if let (Some(url), None) = (&url, &host) {
        return GhStatus {
            state: GhState::NotGithub,
            detail: not_github_message(remote, url),
        };
    }
    let Some(gh) = gh else {
        return GhStatus {
            state: GhState::Missing,
            detail: "GitHub CLI (gh) is not installed".into(),
        };
    };
    let Some(host) = host else {
        // No remote at all: the sheet says so on its own.
        return status_with(&gh, dir, &["auth", "status"]);
    };
    let st = status_with(&gh, dir, &["auth", "status", "--hostname", &host]);
    if st.state == GhState::SignedOut && host != "github.com" && !host.ends_with(".github.com") {
        return GhStatus {
            state: GhState::NotGithub,
            detail: not_github_message(remote, url.as_deref().unwrap_or_default()),
        };
    }
    st
}

fn status_with(gh: &GhCommand, dir: &Path, args: &[&str]) -> GhStatus {
    match run(gh, dir, args, None) {
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
        let said = format!("{}\n{}", out.stderr, out.stdout);
        if said.contains("known GitHub host") || said.contains("not a GitHub repository") {
            let remote = "origin";
            if let Some(url) = remote_url(dir, remote) {
                return Err(not_github_message(remote, &url));
            }
        }
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

    #[test]
    fn a_job_part_that_is_not_a_number_is_left_out() {
        assert_eq!(
            run_and_job("https://github.com/o/r/actions/runs/123/job/abc"),
            Some(("123".into(), None))
        );
        assert_eq!(
            run_and_job("https://github.com/o/r/actions/runs/123/job/"),
            Some(("123".into(), None))
        );
        assert_eq!(
            run_and_job("https://github.com/o/r/actions/runs/123/attempts/2"),
            Some(("123".into(), None))
        );
    }

    /// A stand-in gh: a shell script that logs its arguments and runs `body`.
    /// `sh` reads the script rather than the script being executed itself: a
    /// file written a moment ago can still be open for writing in a process
    /// another test is forking in parallel, and executing it then fails with
    /// "Text file busy" (ETXTBSY) on Linux.
    #[cfg(unix)]
    fn script_gh(dir: &Path, body: &str) -> (GhCommand, PathBuf) {
        let log = dir.join("gh.log");
        let script = dir.join("gh");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\necho \"ARGS $*\" >> '{}'\n{body}\n",
                log.display()
            ),
        )
        .unwrap();
        (
            GhCommand {
                program: PathBuf::from("/bin/sh"),
                prefix: vec![script.display().to_string()],
            },
            log,
        )
    }

    #[test]
    fn remote_hosts_are_read_from_every_url_shape() {
        assert_eq!(
            remote_host("https://github.com/a/b.git").as_deref(),
            Some("github.com")
        );
        assert_eq!(
            remote_host("git@github.com:a/b.git").as_deref(),
            Some("github.com")
        );
        assert_eq!(
            remote_host("ssh://git@gitlab.example.com:2222/a/b").as_deref(),
            Some("gitlab.example.com")
        );
        assert_eq!(
            remote_host("https://user:tok@GHE.Example.com/a").as_deref(),
            Some("ghe.example.com")
        );
        assert_eq!(remote_host("/srv/git/repo.git"), None);
        assert_eq!(remote_host("file:///srv/git/repo.git"), None);
        assert_eq!(remote_host("C:\\repos\\x.git"), None);
        assert_eq!(remote_host("../sibling.git"), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_remote_that_is_not_on_a_github_host_is_not_offered_a_pull_request() {
        let dir = TempDir::new().unwrap();
        let repo = dir.path().join("r");
        fs::create_dir_all(&repo).unwrap();
        let r = git2::Repository::init(&repo).unwrap();
        // gh signed in to github.com only.
        let (gh, _) = script_gh(
            dir.path(),
            "case \"$*\" in *github.com*) echo ok; exit 0;; *) echo 'not logged in' >&2; exit 1;; esac",
        );
        r.remote("origin", "/srv/git/local.git").unwrap();
        let st = status_for_with(Some(gh.clone()), &repo, Some("origin"));
        assert_eq!(st.state, GhState::NotGithub);
        assert_eq!(
            st.detail,
            "origin (/srv/git/local.git) is not a GitHub repository"
        );
        r.remote_set_url("origin", "git@gitlab.example.com:team/x.git")
            .unwrap();
        assert_eq!(
            status_for_with(Some(gh.clone()), &repo, Some("origin")).state,
            GhState::NotGithub
        );
        r.remote_set_url("origin", "https://github.com/team/x.git")
            .unwrap();
        assert_eq!(
            status_for_with(Some(gh.clone()), &repo, Some("origin")).state,
            GhState::Ready
        );
        // Not installed still says so for a GitHub remote.
        assert_eq!(
            status_for_with(None, &repo, Some("origin")).state,
            GhState::Missing
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_refused_pull_request_says_what_gh_said() {
        let dir = TempDir::new().unwrap();
        let (gh, _) = script_gh(
            dir.path(),
            "echo 'noise on stdout'\necho '  ' >&2\necho 'a pull request already exists' >&2\nexit 1",
        );
        let err = create_pr(&gh, dir.path(), "main", "task", "Title", "Body").unwrap_err();
        assert_eq!(
            err,
            "gh could not open the pull request: a pull request already exists"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_gh_that_refuses_before_reading_the_body_still_says_why() {
        // A body far larger than a pipe's buffer, and a gh that never reads
        // it: writing the body always meets a closed pipe.
        let dir = TempDir::new().unwrap();
        let (gh, _) = script_gh(
            dir.path(),
            "exec 0<&-\necho 'a pull request already exists' >&2\nexit 1",
        );
        let body = "x".repeat(4 * 1024 * 1024);
        let err = create_pr(&gh, dir.path(), "main", "task", "Title", &body).unwrap_err();
        assert_eq!(
            err,
            "gh could not open the pull request: a pull request already exists"
        );
    }

    #[cfg(unix)]
    #[test]
    fn checks_come_back_from_gh_json_even_when_gh_exits_non_zero() {
        let dir = TempDir::new().unwrap();
        let (gh, log) = script_gh(
            dir.path(),
            "echo '[{\"name\":\"test\",\"state\":\"FAILURE\",\"bucket\":\"fail\",\"link\":\"L\",\"workflow\":\"CI\"}]'\nexit 8",
        );
        let checks = pr_checks(&gh, dir.path(), "https://github.test/o/r/pull/7").unwrap();
        assert_eq!(checks.len(), 1);
        assert_eq!(
            (checks[0].name.as_str(), checks[0].bucket.as_str()),
            ("test", "fail")
        );
        assert!(fs::read_to_string(log)
            .unwrap()
            .contains("pr checks https://github.test/o/r/pull/7 --json"));
    }

    #[cfg(unix)]
    #[test]
    fn the_failed_log_of_one_job_is_what_gh_prints() {
        let dir = TempDir::new().unwrap();
        let (gh, log) = script_gh(dir.path(), "printf 'step 3 failed\\nerror: boom\\n'");
        let text = failed_log(
            &gh,
            dir.path(),
            "https://github.com/o/r/actions/runs/123/job/456",
        )
        .unwrap();
        assert_eq!(text, "step 3 failed\nerror: boom\n");
        assert!(fs::read_to_string(log)
            .unwrap()
            .contains("run view 123 --log-failed --job 456"));
        // gh failing is an error that says why.
        let (gh, _) = script_gh(dir.path(), "echo 'HTTP 404' >&2\nexit 1");
        let err = failed_log(&gh, dir.path(), "https://github.com/o/r/actions/runs/1").unwrap_err();
        assert_eq!(err, "gh could not fetch the log: HTTP 404");
    }
}
