//! Done-When contracts (F27), the app side.
//!
//! A repository says when an agent's work counts as done with `done_when`
//! commands (`.hermes/features/<slug>/feature.md`, else
//! `.hermes/worktree.toml`). The bundled `hi` helper finds and runs them
//! (`src-tauri/hi/src/done_when.rs`); this module decides when, keeps the
//! results per session and tells the frontend.
//!
//! Two ways a check runs:
//!
//! - **Blocking, for Claude in a terminal**: the per-launch settings file
//!   (`pty::launch`) adds `hi check --stop-hook` as Claude's `Stop` hook.
//!   While the checks fail Claude is sent back to work with the failures,
//!   at most three times per turn and within a time budget. Every run is
//!   reported on the session's signal spool as `hermes.check`, which lands
//!   in [`on_hook_report`]; when the hook gives up the session becomes
//!   `check_failed`.
//! - **Observe and send back, for every other agent**: when a turn ends
//!   (the frontend sees `turn_end`), [`done_when_run`] runs `hi check
//!   --json` in the session's folder. The frontend shows a chip with the
//!   result and a "Send failures back" action (a person clicks it; Hermes
//!   never types on its own). After [`MAX_FAILED_TURNS`] turn ends in a row
//!   with failing checks the session becomes `check_failed`.
//!
//! The same command runs the checks on request (`manual`) and before Land
//! (`land`, for the Land sheet, F22).

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::contract::{self, AgentStatus, AgentStatusKind, Confidence, SessionEvent};

/// The Tauri event every check result travels on.
pub const DONE_WHEN_EVENT: &str = "hermes:done-when";
/// Turn ends in a row with failing checks before an agent that cannot be
/// blocked is marked `check_failed`.
pub const MAX_FAILED_TURNS: u32 = 3;
/// Results kept per session (newest last).
const HISTORY_CAP: usize = 50;
/// Where a run was asked for.
pub const TRIGGERS: [&str; 3] = ["turn_end", "manual", "land"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckSource {
    /// `feature` or `worktree`.
    pub kind: String,
    /// The file, relative to the checkout.
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandOutcome {
    pub command: String,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub timed_out: bool,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub output_tail: String,
}

impl CommandOutcome {
    pub fn passed(&self) -> bool {
        self.exit_code == Some(0) && !self.timed_out
    }
}

fn yes() -> bool {
    true
}

/// One run of the checks, as `hi check --json` prints it and a
/// `hermes.check` spool line carries it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckRun {
    /// `passed`, `failed`, `error` (a done_when file cannot be read) or
    /// `none` (nothing to check).
    pub state: String,
    /// `stop_hook`, `turn_end`, `manual`, `land` or `cli`.
    pub trigger: String,
    #[serde(default)]
    pub source: Option<CheckSource>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub commands: Vec<CommandOutcome>,
    #[serde(default)]
    pub started_at: u64,
    #[serde(default)]
    pub duration_ms: u64,
    /// Stop hook only: which automatic continuation this was.
    #[serde(default)]
    pub attempt: Option<u32>,
    #[serde(default)]
    pub max_attempts: Option<u32>,
    /// Stop hook only: the agent was sent back to work.
    #[serde(default)]
    pub blocking: bool,
    /// False while the Stop hook will still send the agent back.
    #[serde(default = "yes", rename = "final")]
    pub is_final: bool,
    /// Stop hook only: attempts or budget used up with checks failing.
    #[serde(default)]
    pub gave_up: bool,
}

impl CheckRun {
    pub fn failed_commands(&self) -> Vec<String> {
        self.commands
            .iter()
            .filter(|c| !c.passed())
            .map(|c| c.command.clone())
            .collect()
    }
}

/// A run as the frontend receives it (event payload and command result).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckRecord {
    pub session_id: String,
    /// The turn it belongs to, when known.
    pub turn: Option<u32>,
    pub run: CheckRun,
    /// The session is `check_failed` after this run.
    pub check_failed: bool,
    /// Turn ends in a row whose checks failed.
    pub failed_turns: u32,
    /// The agent's stop is refused by a hook for this session, so a failure
    /// goes back to it on its own; otherwise a person sends it back.
    pub hook: bool,
}

/// What Hermes knows about one session's checks.
#[derive(Debug, Clone, Default)]
pub struct SessionChecks {
    pub hook: bool,
    pub running: bool,
    pub failed_turns: u32,
    pub check_failed: bool,
    pub history: Vec<CheckRecord>,
}

/// A change to the session's status that a run causes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StatusChange {
    CheckFailed {
        detail: String,
    },
    /// A `check_failed` session whose checks now pass at the agent's stop
    /// (`turn_end`, `stop_hook`) is done.
    Cleared,
}

/// One line naming what failed, for the status detail.
pub fn failure_detail(run: &CheckRun) -> String {
    let failed = run.failed_commands();
    let text = if failed.is_empty() {
        run.error.clone().unwrap_or_default()
    } else {
        failed.join(", ")
    };
    if text.chars().count() > 120 {
        let cut: String = text.chars().take(119).collect();
        format!("{cut}…")
    } else {
        text
    }
}

/// Fold one run into a session's checks (pure; the table tests drive it).
pub fn fold_run(
    sc: &mut SessionChecks,
    session_id: &str,
    run: CheckRun,
    turn: Option<u32>,
) -> (CheckRecord, Option<StatusChange>) {
    let mut change = None;
    match run.state.as_str() {
        "passed" => {
            sc.failed_turns = 0;
            if sc.check_failed {
                sc.check_failed = false;
                // Only a run at the agent's stop says the agent is done now.
                // A manual run or one before Land can come while the agent
                // works again; the frontend clears those only while the
                // session still shows check_failed (controller.ts).
                if run.trigger == "turn_end" || run.trigger == "stop_hook" {
                    change = Some(StatusChange::Cleared);
                }
            }
        }
        "failed" => {
            let gives_up = if run.trigger == "stop_hook" {
                run.gave_up
            } else if run.trigger == "turn_end" {
                sc.failed_turns += 1;
                sc.failed_turns >= MAX_FAILED_TURNS
            } else {
                false
            };
            if run.trigger == "stop_hook" && run.gave_up {
                sc.failed_turns += 1;
            }
            if gives_up && !sc.check_failed {
                sc.check_failed = true;
                change = Some(StatusChange::CheckFailed {
                    detail: failure_detail(&run),
                });
            }
        }
        _ => {}
    }
    let record = CheckRecord {
        session_id: session_id.to_string(),
        turn,
        check_failed: sc.check_failed,
        failed_turns: sc.failed_turns,
        hook: sc.hook,
        run,
    };
    if record.run.state != "none" {
        sc.history.push(record.clone());
        if sc.history.len() > HISTORY_CAP {
            let drop = sc.history.len() - HISTORY_CAP;
            sc.history.drain(..drop);
        }
    }
    (record, change)
}

/// Per-session check state, managed by the app.
#[derive(Default)]
pub struct DoneWhenState {
    sessions: Mutex<HashMap<String, SessionChecks>>,
}

impl DoneWhenState {
    fn with<T>(&self, session_id: &str, f: impl FnOnce(&mut SessionChecks) -> T) -> T {
        let mut map = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        f(map.entry(session_id.to_string()).or_default())
    }

    pub fn forget(&self, session_id: &str) {
        let mut map = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(session_id);
    }
}

/// Record whether this session's agent has the blocking Stop hook (set at
/// every launch through `hi`).
pub fn set_hook(app: &AppHandle, session_id: &str, hook: bool) {
    if let Some(state) = app.try_state::<DoneWhenState>() {
        state.with(session_id, |sc| sc.hook = hook);
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn publish(app: &AppHandle, record: &CheckRecord, change: Option<StatusChange>) {
    if let Err(e) = app.emit(DONE_WHEN_EVENT, record) {
        log::warn!("[done-when] could not emit a result: {e}");
    }
    let status = match change {
        None => return,
        Some(StatusChange::CheckFailed { detail }) => AgentStatus {
            kind: AgentStatusKind::CheckFailed,
            confidence: Confidence::Exact,
            detail,
        },
        Some(StatusChange::Cleared) => AgentStatus {
            kind: AgentStatusKind::DoneUnread,
            confidence: Confidence::Exact,
            detail: String::new(),
        },
    };
    log::info!("[done-when] {} is now {:?}", record.session_id, status.kind);
    contract::emit_session_event(
        app,
        &record.session_id,
        SessionEvent::Status {
            at: now_ms(),
            source: Some("checks".to_string()),
            tags: None,
            status,
        },
    );
}

/// A `hermes.check` line from the session's spool: a run of the Stop hook,
/// or `hi check` typed by the agent itself.
pub fn on_hook_report(app: &AppHandle, session_id: &str, payload: &serde_json::Value) {
    let run: CheckRun = match serde_json::from_value(payload.clone()) {
        Ok(r) => r,
        Err(e) => {
            log::warn!("[done-when] unreadable check report for {session_id}: {e}");
            return;
        }
    };
    let Some(state) = app.try_state::<DoneWhenState>() else {
        return;
    };
    let (record, change) = state.with(session_id, |sc| fold_run(sc, session_id, run, None));
    publish(app, &record, change);
}

/// The result of [`done_when_run`]: a record, or why nothing ran.
#[derive(Debug, Clone, Serialize)]
pub struct RunOutcome {
    /// `hook` (the agent's own Stop hook checks it), `running` (a run is
    /// already under way), `ssh` (the checkout is on another machine).
    pub skipped: Option<String>,
    pub record: Option<CheckRecord>,
}

fn session_folder(app: &AppHandle, session_id: &str) -> Result<(String, bool), String> {
    let state = app.state::<crate::AppState>();
    let mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
    let pty = mgr
        .sessions
        .get(session_id)
        .ok_or_else(|| format!("no session {session_id}"))?;
    let s = pty
        .session
        .lock()
        .map_err(|_| "session is busy".to_string())?;
    Ok((s.working_directory.clone(), s.ssh_info.is_some()))
}

/// The PATH the checks run with. An app started from the Dock or a desktop
/// launcher gets a bare PATH (`/usr/bin:/bin:…` on macOS), so a check naming
/// `node`, `npm` or `cargo` would fail with "command not found" although it
/// runs in the person's terminal. The Stop hook runs inside the terminal and
/// has its PATH; this gives the runs Hermes starts the same one: the login
/// shell's PATH (asked once), then the app's own with the usual install
/// folders (`agent::enriched_path_var`).
pub fn check_path_var() -> OsString {
    static LOGIN: OnceLock<Option<OsString>> = OnceLock::new();
    let login = LOGIN.get_or_init(|| login_shell_path(&crate::pty::detect_shell(), None));
    merge_path_vars(login.as_deref(), &crate::agent::enriched_path_var())
}

/// `first`'s folders, then `rest`'s, each once.
pub fn merge_path_vars(first: Option<&OsStr>, rest: &OsStr) -> OsString {
    let mut seen = std::collections::HashSet::new();
    let dirs: Vec<PathBuf> = first
        .into_iter()
        .flat_map(std::env::split_paths)
        .chain(std::env::split_paths(rest))
        .filter(|d| !d.as_os_str().is_empty() && seen.insert(d.clone()))
        .collect();
    std::env::join_paths(dirs).unwrap_or_else(|_| rest.to_os_string())
}

#[cfg(unix)]
const PATH_MARKER: &str = "__HERMES_DONE_WHEN_PATH__=";
/// A login shell whose profile hangs must not hold the checks up for long.
#[cfg(unix)]
const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(5);

/// The PATH line a login shell printed, among whatever its profile printed.
#[cfg(unix)]
fn parse_login_path(stdout: &str) -> Option<OsString> {
    stdout
        .lines()
        .rev()
        .find_map(|l| l.trim_end_matches('\r').strip_prefix(PATH_MARKER))
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(OsString::from)
}

/// The PATH an interactive login `shell` sets up (its profile and rc files,
/// where nvm, volta, pnpm or cargo add theirs), or None when it cannot say
/// within [`LOGIN_SHELL_TIMEOUT`]. `home` runs it with that home folder's
/// files instead of the app's (tests).
#[cfg(unix)]
pub fn login_shell_path(shell: &str, home: Option<&Path>) -> Option<OsString> {
    use std::io::Read;
    let script = format!("printf '\\n{PATH_MARKER}%s\\n' \"$PATH\"");
    let mut cmd = std::process::Command::new(shell);
    cmd.args(["-l", "-i", "-c", &script])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        // Headless: no prompt, nothing written to the history.
        .env("PS1", "")
        .env("PROMPT", "")
        .env("RPROMPT", "")
        .env("HISTFILE", "/dev/null");
    if let Some(home) = home {
        cmd.env("HOME", home).env_remove("ZDOTDIR");
    }
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        let _ = tx.send(out);
    });
    let deadline = std::time::Instant::now() + LOGIN_SHELL_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                log::warn!("[done-when] the login shell {shell} did not give its PATH in time");
                return None;
            }
        }
    }
    // Something the profile started in the background can keep the pipe
    // open; the PATH line is printed before the shell exits.
    let out = rx.recv_timeout(Duration::from_millis(500)).ok()?;
    parse_login_path(&String::from_utf8_lossy(&out))
}

/// Windows apps get the user's PATH from the registry; nothing to ask.
#[cfg(not(unix))]
pub fn login_shell_path(_shell: &str, _home: Option<&Path>) -> Option<OsString> {
    None
}

/// Run `hi check --json` in `cwd` with `path` as PATH and read its report.
pub fn run_hi_check(hi: &Path, cwd: &str, trigger: &str, path: &OsStr) -> Result<CheckRun, String> {
    let mut cmd = std::process::Command::new(hi);
    cmd.args(["check", "--json", "--trigger", trigger])
        .current_dir(cwd)
        .env("PATH", path)
        .stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        // The app has no console; without this every check would flash one.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("could not run the checks: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let line = stdout
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('{'));
    let Some(line) = line else {
        return Err(format!(
            "the checks gave no report (exit {:?}): {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    };
    serde_json::from_str(line).map_err(|e| format!("unreadable check report: {e}"))
}

/// Run a session's Done-When checks now: at a turn end (skipped when the
/// agent's own Stop hook checks it), on request, or before Land.
#[tauri::command]
pub async fn done_when_run(
    app: AppHandle,
    session_id: String,
    trigger: String,
    turn: Option<u32>,
) -> Result<RunOutcome, String> {
    if !TRIGGERS.contains(&trigger.as_str()) {
        return Err(format!("unknown trigger {trigger:?}"));
    }
    let skipped = |why: &str| {
        Ok(RunOutcome {
            skipped: Some(why.to_string()),
            record: None,
        })
    };
    let (cwd, ssh) = session_folder(&app, &session_id)?;
    if ssh {
        return skipped("ssh");
    }
    let state = app.state::<DoneWhenState>();
    let busy = state.with(&session_id, |sc| {
        if trigger == "turn_end" && sc.hook {
            return Some("hook");
        }
        if sc.running {
            return Some("running");
        }
        sc.running = true;
        None
    });
    if let Some(why) = busy {
        return skipped(why);
    }
    let hi = crate::pty::launch::hi_path(&app);
    let trigger_for_run = trigger.clone();
    let result = tauri::async_runtime::spawn_blocking(move || match hi {
        Some(hi) => run_hi_check(&hi, &cwd, &trigger_for_run, &check_path_var()),
        None => Err("the hi helper is missing from this build".to_string()),
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    let state = app.state::<DoneWhenState>();
    let (record, change) = state.with(&session_id, |sc| {
        sc.running = false;
        result.map(|run| fold_run(sc, &session_id, run, turn))
    })?;
    publish(&app, &record, change);
    Ok(RunOutcome {
        skipped: None,
        record: Some(record),
    })
}

/// Every recorded run of a session, oldest first.
#[tauri::command]
pub fn done_when_history(app: AppHandle, session_id: String) -> Vec<CheckRecord> {
    app.state::<DoneWhenState>()
        .with(&session_id, |sc| sc.history.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(state: &str, trigger: &str) -> CheckRun {
        serde_json::from_value(json!({
            "state": state,
            "trigger": trigger,
            "source": { "kind": "worktree", "path": ".hermes/worktree.toml" },
            "commands": [
                { "command": "npm run lint", "exit_code": 0, "timed_out": false, "duration_ms": 5, "output_tail": "" },
                { "command": "npm test", "exit_code": if state == "failed" { 1 } else { 0 }, "timed_out": false, "duration_ms": 9, "output_tail": "1 failing" }
            ],
            "started_at": 1, "duration_ms": 14
        }))
        .unwrap()
    }

    #[test]
    fn reads_the_report_hi_prints_and_the_spool_line_it_writes() {
        let hook: CheckRun = serde_json::from_value(json!({
            "v": 1, "state": "failed", "trigger": "stop_hook", "source": null, "error": null,
            "commands": [{ "command": "npm test", "exit_code": null, "timed_out": true, "duration_ms": 600000, "output_tail": "…" }],
            "started_at": 5, "duration_ms": 600001,
            "attempt": 4, "max_attempts": 3, "blocking": false, "final": true, "gave_up": true
        }))
        .unwrap();
        assert!(hook.gave_up && hook.is_final && !hook.blocking);
        assert_eq!(hook.attempt, Some(4));
        assert_eq!(hook.failed_commands(), vec!["npm test"]);
        // A plain `hi check --json` report has none of the hook fields.
        let plain = run("passed", "manual");
        assert!(plain.is_final && !plain.gave_up && plain.attempt.is_none());
    }

    #[test]
    fn three_failing_turn_ends_in_a_row_make_the_session_check_failed() {
        let mut sc = SessionChecks::default();
        for n in 1..=2 {
            let (rec, change) = fold_run(&mut sc, "s", run("failed", "turn_end"), Some(n));
            assert_eq!(change, None);
            assert_eq!(rec.failed_turns, n);
            assert!(!rec.check_failed);
        }
        // A manual run or a run before Land does not count as a turn end.
        let (_, change) = fold_run(&mut sc, "s", run("failed", "manual"), None);
        assert_eq!(change, None);
        let (_, change) = fold_run(&mut sc, "s", run("failed", "land"), None);
        assert_eq!(change, None);
        let (rec, change) = fold_run(&mut sc, "s", run("failed", "turn_end"), Some(3));
        assert_eq!(
            change,
            Some(StatusChange::CheckFailed {
                detail: "npm test".into()
            })
        );
        assert!(rec.check_failed && rec.failed_turns == 3);
        // Once is enough: a fourth failure does not raise it again.
        let (_, change) = fold_run(&mut sc, "s", run("failed", "turn_end"), Some(4));
        assert_eq!(change, None);
        // A passing turn end clears it and the count, and the agent is done.
        let (rec, change) = fold_run(&mut sc, "s", run("passed", "turn_end"), Some(5));
        assert_eq!(change, Some(StatusChange::Cleared));
        assert!(!rec.check_failed && rec.failed_turns == 0);
        assert_eq!(sc.history.len(), 7);
    }

    #[test]
    fn a_passing_manual_or_land_run_clears_check_failed_without_saying_done() {
        for trigger in ["manual", "land"] {
            let mut sc = SessionChecks::default();
            for n in 1..=3 {
                fold_run(&mut sc, "s", run("failed", "turn_end"), Some(n));
            }
            assert!(sc.check_failed);
            // The agent may be working again: no done status from here.
            let (rec, change) = fold_run(&mut sc, "s", run("passed", trigger), None);
            assert_eq!(change, None, "{trigger}");
            assert!(!rec.check_failed && rec.failed_turns == 0, "{trigger}");
        }
    }

    #[test]
    fn a_passing_turn_resets_the_count() {
        let mut sc = SessionChecks::default();
        fold_run(&mut sc, "s", run("failed", "turn_end"), Some(1));
        fold_run(&mut sc, "s", run("failed", "turn_end"), Some(2));
        fold_run(&mut sc, "s", run("passed", "turn_end"), Some(3));
        let (_, change) = fold_run(&mut sc, "s", run("failed", "turn_end"), Some(4));
        assert_eq!(change, None);
        assert_eq!(sc.failed_turns, 1);
    }

    #[test]
    fn the_stop_hook_makes_it_check_failed_only_when_it_gives_up() {
        let mut sc = SessionChecks {
            hook: true,
            ..Default::default()
        };
        for attempt in 1..=3 {
            let mut r = run("failed", "stop_hook");
            r.attempt = Some(attempt);
            r.blocking = true;
            r.is_final = false;
            let (rec, change) = fold_run(&mut sc, "s", r, None);
            assert_eq!(change, None, "attempt {attempt}");
            assert!(rec.hook && !rec.check_failed);
        }
        let mut last = run("failed", "stop_hook");
        last.attempt = Some(4);
        last.gave_up = true;
        let (rec, change) = fold_run(&mut sc, "s", last, None);
        assert!(matches!(change, Some(StatusChange::CheckFailed { .. })));
        assert!(rec.check_failed);
        // The agent then fixes it and its next stop passes.
        let (_, change) = fold_run(&mut sc, "s", run("passed", "stop_hook"), None);
        assert_eq!(change, Some(StatusChange::Cleared));
    }

    #[test]
    fn nothing_to_check_is_not_kept_and_an_unreadable_file_changes_no_status() {
        let mut sc = SessionChecks::default();
        let (_, change) = fold_run(&mut sc, "s", run("none", "turn_end"), Some(1));
        assert_eq!(change, None);
        assert!(sc.history.is_empty());
        let mut e = run("error", "turn_end");
        e.commands.clear();
        e.error = Some("worktree.toml can't be read (line 2): expected key = value".into());
        let (_, change) = fold_run(&mut sc, "s", e.clone(), Some(2));
        assert_eq!(change, None);
        assert_eq!(sc.failed_turns, 0);
        assert_eq!(
            failure_detail(&e),
            "worktree.toml can't be read (line 2): expected key = value"
        );
    }

    #[test]
    fn the_history_is_capped() {
        let mut sc = SessionChecks::default();
        for n in 0..(HISTORY_CAP as u32 + 10) {
            fold_run(&mut sc, "s", run("passed", "manual"), Some(n + 1));
        }
        assert_eq!(sc.history.len(), HISTORY_CAP);
        assert_eq!(sc.history[0].turn, Some(11));
    }

    #[test]
    fn a_record_serialises_with_the_field_names_the_frontend_reads() {
        let mut sc = SessionChecks::default();
        let (rec, _) = fold_run(&mut sc, "s1", run("failed", "turn_end"), Some(2));
        let v = serde_json::to_value(&rec).unwrap();
        assert_eq!(v["session_id"], "s1");
        assert_eq!(v["turn"], 2);
        assert_eq!(v["failed_turns"], 1);
        assert_eq!(v["check_failed"], false);
        assert_eq!(v["hook"], false);
        assert_eq!(v["run"]["state"], "failed");
        assert_eq!(v["run"]["final"], true);
        assert_eq!(v["run"]["commands"][1]["exit_code"], 1);
    }

    #[test]
    fn the_login_path_comes_first_and_every_folder_once() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let login =
            OsString::from(["/opt/test-nvm/versions/node/v22.0.0/bin", "/usr/bin"].join(sep));
        let app = OsString::from(["/usr/bin", "/bin", "", "/opt/homebrew/bin"].join(sep));
        let merged: Vec<PathBuf> =
            std::env::split_paths(&merge_path_vars(Some(&login), &app)).collect();
        let want: Vec<PathBuf> = [
            "/opt/test-nvm/versions/node/v22.0.0/bin",
            "/usr/bin",
            "/bin",
            "/opt/homebrew/bin",
        ]
        .iter()
        .map(PathBuf::from)
        .collect();
        assert_eq!(merged, want);
        // Without a login shell answer the app's PATH is used as it is.
        let alone: Vec<PathBuf> = std::env::split_paths(&merge_path_vars(None, &app)).collect();
        assert_eq!(alone.len(), 3);
    }

    #[cfg(unix)]
    #[test]
    fn the_path_line_is_found_among_what_a_profile_prints() {
        let out = format!(
            "Welcome back!\r\nnvm: using node v22\n\n{PATH_MARKER}/a/bin:/usr/bin\r\nbye\n"
        );
        assert_eq!(
            parse_login_path(&out),
            Some(OsString::from("/a/bin:/usr/bin"))
        );
        assert_eq!(parse_login_path("no marker here\n"), None);
        assert_eq!(parse_login_path(&format!("{PATH_MARKER}\n")), None);
    }

    /// The `hi` helper build.rs built from this checkout (its own target
    /// folder, so a target folder shared between checkouts cannot hand out
    /// another checkout's helper).
    #[cfg(unix)]
    fn built_hi() -> PathBuf {
        let profile = if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        };
        let hi = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/hi-build")
            .join(profile)
            .join("hi");
        assert!(
            hi.is_file(),
            "build.rs did not build the hi helper at {}",
            hi.display()
        );
        hi
    }

    /// A repository whose check names a tool that lives where a version
    /// manager puts it (`~/.nvm/versions/node/<v>/bin`), which only the
    /// login shell's profile adds to PATH, as on a real machine.
    #[cfg(unix)]
    fn repo_and_home_with_a_node_managed_tool() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let tools = home.join(".nvm/versions/node/v22.0.0/bin");
        std::fs::create_dir_all(&tools).unwrap();
        let tool = tools.join("f27-lint");
        std::fs::write(&tool, "#!/bin/sh\necho lint ok\n").unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        let profile = format!("export PATH=\"{}:$PATH\"\n", tools.display());
        for rc in [
            ".profile",
            ".bash_profile",
            ".bashrc",
            ".zprofile",
            ".zshrc",
        ] {
            std::fs::write(home.join(rc), &profile).unwrap();
        }
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(repo.join(".hermes")).unwrap();
        std::fs::write(
            repo.join(".hermes/worktree.toml"),
            "done_when = [\"f27-lint --all\"]\n",
        )
        .unwrap();
        (tmp, home, tools, repo)
    }

    /// The PATH an app started from the Dock gets on macOS.
    #[cfg(unix)]
    const BARE_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";

    #[cfg(unix)]
    #[test]
    fn with_the_bare_app_path_a_node_managed_tool_is_not_found() {
        let (_tmp, _home, _tools, repo) = repo_and_home_with_a_node_managed_tool();
        let run = run_hi_check(
            &built_hi(),
            repo.to_str().unwrap(),
            "turn_end",
            OsStr::new(BARE_PATH),
        )
        .unwrap();
        assert_eq!(run.state, "failed");
        assert_eq!(run.commands[0].exit_code, Some(127), "{:?}", run.commands);
    }

    #[cfg(unix)]
    #[test]
    fn the_checks_find_a_tool_the_login_shell_puts_on_path() {
        let (_tmp, home, tools, repo) = repo_and_home_with_a_node_managed_tool();
        for shell in ["/bin/bash", "/bin/zsh", "/bin/sh"] {
            if !Path::new(shell).exists() {
                continue;
            }
            let login = login_shell_path(shell, Some(&home))
                .unwrap_or_else(|| panic!("{shell} gave no PATH"));
            assert!(
                std::env::split_paths(&login).any(|d| d == tools),
                "{shell}: {login:?}"
            );
            let path = merge_path_vars(Some(&login), OsStr::new(BARE_PATH));
            let run = run_hi_check(&built_hi(), repo.to_str().unwrap(), "turn_end", &path).unwrap();
            assert_eq!(run.state, "passed", "{shell}: {:?}", run.commands);
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_login_shell_that_hangs_gives_up_in_time() {
        let tmp = tempfile::tempdir().unwrap();
        let shell = tmp.path().join("slow-shell");
        std::fs::write(&shell, "#!/bin/sh\nsleep 30\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();
        let t0 = std::time::Instant::now();
        assert_eq!(login_shell_path(shell.to_str().unwrap(), None), None);
        assert!(t0.elapsed() < LOGIN_SHELL_TIMEOUT + Duration::from_secs(2));
    }

    #[test]
    fn a_long_detail_is_cut_to_one_line() {
        let mut r = run("failed", "turn_end");
        r.commands[1].command = "x".repeat(300);
        let d = failure_detail(&r);
        assert_eq!(d.chars().count(), 120);
        assert!(d.ends_with('…'));
    }
}
