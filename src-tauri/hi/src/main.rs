//! `hi` — the small helper Hermes ships next to its main binary and puts on
//! PATH inside every Hermes terminal.
//!
//! ```text
//! hi run <session-id | launch-file>    start the agent a launch file describes
//! hi signal [--agent A] [--event E]    append one line to $HERMES_SIGNAL_FILE
//!           [--argv-json <json>]       (payload from the last argument, as
//!                                       Codex's notify program gets it)
//! hi --version
//! ```
//!
//! Hermes types only `hi run <session-id>` into the shell. Everything that
//! would otherwise need shell quoting — paths with spaces, prompts, flags —
//! lives in the launch file Hermes wrote, so the same typed line works in
//! zsh, bash, fish, PowerShell and cmd.
//!
//! `hi run` stays the parent of the agent so it can notice a resume that
//! fails right away because the vendor does not know the conversation, and
//! start a fresh one instead, saying so in one visible line. Only the way the
//! catalog says the vendor reports a missing conversation counts (its exit
//! code, and the text Hermes saw it print); an agent that ends early for any
//! other reason (Ctrl-C at its trust prompt, a signal, a crash) keeps its
//! conversation for the next launch. Ctrl-C is left
//! to the agent: `hi` ignores it and only reports the agent's exit status —
//! to the shell, and to Hermes as a `hermes.exited` spool line, so Hermes
//! knows the agent is gone even when it ended without running any hook
//! (a declined trust prompt, Ctrl-C at a prompt, a command not found).
//!
//! Every spool line carries the launch's nonce (`HERMES_SIGNAL_NONCE`, set
//! by Hermes per launch); Hermes ignores lines without the current one.
//!
//! `hi signal` is what agents call from their hooks. It reads the hook's JSON
//! from stdin, keeps a few small fields and appends one line to the spool
//! file Hermes watches. It prints nothing and always exits 0, so a hook can
//! never break an agent.

use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const VERSION: &str = env!("CARGO_PKG_VERSION");
/// The launch-file format this build understands.
const SPEC_VERSION: u64 = 1;
/// Environment variable Hermes sets in every terminal: the folder that holds
/// one sub-folder per session with its `launch.json`.
const LAUNCH_DIR_ENV: &str = "HERMES_LAUNCH_DIR";
const SIGNAL_FILE_ENV: &str = "HERMES_SIGNAL_FILE";
const SESSION_ID_ENV: &str = "HERMES_SESSION_ID";
const AGENT_ENV: &str = "HERMES_AGENT";
const NONCE_ENV: &str = "HERMES_SIGNAL_NONCE";
const LAUNCH_FILE_NAME: &str = "launch.json";
const EXIT_USAGE: i32 = 2;
const EXIT_NOT_FOUND: i32 = 127;
const MAX_STDIN_BYTES: usize = 64 * 1024;
const MAX_FIELD_CHARS: usize = 1024;

// ─── Launch file ─────────────────────────────────────────────────────

/// What Hermes writes for one launch. Field names are the wire format.
#[derive(Debug, Clone)]
pub struct LaunchSpec {
    pub session_id: String,
    pub agent: String,
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
    pub program: String,
    pub args: Vec<String>,
    pub fallback: Option<Fallback>,
}

/// What to run instead when the main command finds no conversation to resume.
#[derive(Debug, Clone)]
pub struct Fallback {
    pub program: String,
    pub args: Vec<String>,
    /// A failure later than this is the agent's own business, not a failed
    /// resume: the user may have quit it or it may have hit an error later.
    pub after_ms: u64,
    /// The vendor session id the fallback pre-assigns, reported to Hermes.
    pub vendor_session_id: Option<String>,
    /// The one line shown before the fallback starts.
    pub message: Option<String>,
    /// How the vendor says the conversation does not exist. Without it the
    /// fallback never runs: an early exit alone proves nothing.
    pub not_found: Option<NotFound>,
}

/// The vendor's own "no such conversation", from the agent catalog.
#[derive(Debug, Clone, Default)]
pub struct NotFound {
    /// Exit codes that can mean it; empty means any code but an interrupt.
    pub exit_codes: Vec<i32>,
    /// Hermes writes this file (holding the launch's nonce) when it saw the
    /// vendor print its "not found" text in the terminal. When set, the
    /// fallback also needs that file.
    pub evidence_file: Option<PathBuf>,
    /// How long to wait for the evidence after the agent exited: Hermes reads
    /// the terminal output on its own thread.
    pub evidence_wait_ms: u64,
}

const DEFAULT_EVIDENCE_WAIT_MS: u64 = 2000;

fn field_str(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(str::to_string)
}

fn field_args(v: &serde_json::Value, key: &str) -> Result<Vec<String>, String> {
    match v.get(key) {
        None | Some(serde_json::Value::Null) => Ok(Vec::new()),
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .map(|a| {
                a.as_str()
                    .map(str::to_string)
                    .ok_or_else(|| format!("{key}: every entry must be a string"))
            })
            .collect(),
        Some(_) => Err(format!("{key}: must be a list of strings")),
    }
}

fn field_codes(v: &serde_json::Value, key: &str) -> Result<Vec<i32>, String> {
    match v.get(key) {
        None | Some(serde_json::Value::Null) => Ok(Vec::new()),
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .map(|c| {
                c.as_i64()
                    .and_then(|c| i32::try_from(c).ok())
                    .ok_or_else(|| format!("{key}: every entry must be an integer"))
            })
            .collect(),
        Some(_) => Err(format!("{key}: must be a list of integers")),
    }
}

impl LaunchSpec {
    pub fn parse(text: &str) -> Result<LaunchSpec, String> {
        let v: serde_json::Value =
            serde_json::from_str(text).map_err(|e| format!("not valid JSON: {e}"))?;
        let version = v.get("v").and_then(|x| x.as_u64()).unwrap_or(0);
        if version != SPEC_VERSION {
            return Err(format!(
                "launch file version {version} is not supported by this hi ({SPEC_VERSION}); update Hermes and hi together"
            ));
        }
        let program = field_str(&v, "program").filter(|p| !p.is_empty());
        let Some(program) = program else {
            return Err("program is missing".to_string());
        };
        let mut env = BTreeMap::new();
        if let Some(map) = v.get("env").and_then(|e| e.as_object()) {
            for (k, val) in map {
                if let Some(s) = val.as_str() {
                    env.insert(k.clone(), s.to_string());
                }
            }
        }
        let fallback = match v.get("fallback") {
            None | Some(serde_json::Value::Null) => None,
            Some(f) => {
                let program = field_str(f, "program")
                    .filter(|p| !p.is_empty())
                    .ok_or_else(|| "fallback.program is missing".to_string())?;
                let not_found = match f.get("not_found") {
                    None | Some(serde_json::Value::Null) => None,
                    Some(n) => Some(NotFound {
                        exit_codes: field_codes(n, "exit_codes")?,
                        evidence_file: field_str(n, "evidence_file")
                            .filter(|p| !p.is_empty())
                            .map(PathBuf::from),
                        evidence_wait_ms: n
                            .get("evidence_wait_ms")
                            .and_then(|x| x.as_u64())
                            .unwrap_or(DEFAULT_EVIDENCE_WAIT_MS),
                    }),
                };
                Some(Fallback {
                    program,
                    args: field_args(f, "args")?,
                    after_ms: f.get("after_ms").and_then(|x| x.as_u64()).unwrap_or(3000),
                    vendor_session_id: field_str(f, "vendor_session_id"),
                    message: field_str(f, "message"),
                    not_found,
                })
            }
        };
        Ok(LaunchSpec {
            session_id: field_str(&v, "session_id").unwrap_or_default(),
            agent: field_str(&v, "agent").unwrap_or_default(),
            cwd: field_str(&v, "cwd").filter(|c| !c.is_empty()),
            env,
            program,
            args: field_args(&v, "args")?,
            fallback,
        })
    }
}

/// Where the launch file for `arg` is: `arg` itself when it is a file,
/// otherwise `<launch dir>/<arg>/launch.json`.
pub fn locate_spec(arg: &str, launch_dir: Option<&Path>) -> Result<PathBuf, String> {
    let direct = Path::new(arg);
    if direct.is_file() {
        return Ok(direct.to_path_buf());
    }
    if arg.is_empty() || arg.contains(['/', '\\']) || arg.contains("..") {
        return Err(format!("hi: no launch file at {arg}"));
    }
    match launch_dir {
        Some(dir) => {
            let candidate = dir.join(arg).join(LAUNCH_FILE_NAME);
            if candidate.is_file() {
                Ok(candidate)
            } else {
                Err(format!(
                    "hi: no launch file for session {arg} (looked in {})",
                    dir.display()
                ))
            }
        }
        None => Err(format!(
            "hi: no launch file for {arg} and {LAUNCH_DIR_ENV} is not set; run this inside a Hermes terminal"
        )),
    }
}

// ─── Finding the program ─────────────────────────────────────────────

/// Resolve a program name the way the shell would: a name with a path
/// separator is used as given; a bare name is searched on PATH, trying the
/// PATHEXT extensions on Windows (so an npm-installed `claude.cmd` is found).
pub fn resolve_program(
    program: &str,
    path: Option<&OsStr>,
    pathext: Option<&OsStr>,
) -> Option<PathBuf> {
    let direct = Path::new(program);
    if program.contains(['/', '\\']) {
        return if direct.is_file() {
            Some(direct.to_path_buf())
        } else {
            None
        };
    }
    let exts: Vec<String> = if cfg!(windows) {
        let raw = pathext
            .map(|p| p.to_string_lossy().to_string())
            .filter(|p| !p.trim().is_empty())
            .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_string());
        raw.split(';')
            .map(|e| e.trim().to_string())
            .filter(|e| !e.is_empty())
            .collect()
    } else {
        Vec::new()
    };
    let has_ext = direct.extension().is_some();
    for dir in std::env::split_paths(path.unwrap_or_default()) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let plain = dir.join(program);
        if is_executable(&plain) {
            return Some(plain);
        }
        if !has_ext || cfg!(windows) {
            for ext in &exts {
                let with_ext = dir.join(format!("{program}{ext}"));
                if is_executable(&with_ext) {
                    return Some(with_ext);
                }
            }
        }
    }
    None
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.is_file()
            && std::fs::metadata(path)
                .map(|m| m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

// ─── Running ─────────────────────────────────────────────────────────

/// How the agent process ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ended {
    /// It exited with this code.
    Code(i32),
    /// A signal ended it (Unix).
    Signal(i32),
}

impl Ended {
    fn of(status: ExitStatus) -> Ended {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            if let Some(sig) = status.signal() {
                return Ended::Signal(sig);
            }
        }
        Ended::Code(status.code().unwrap_or(1))
    }

    /// The status a shell would report.
    pub fn code(self) -> i32 {
        match self {
            Ended::Code(c) => c,
            Ended::Signal(s) => 128 + s,
        }
    }

    /// Ended by the user or the system rather than by the agent deciding to
    /// exit: a signal, a shell-style `128 + signal` code (130 is Ctrl-C), or
    /// Windows' STATUS_CONTROL_C_EXIT.
    pub fn is_interrupt(self) -> bool {
        const STATUS_CONTROL_C_EXIT: i32 = 0xC000_013Au32 as i32;
        match self {
            Ended::Signal(_) => true,
            Ended::Code(c) => (129..=128 + 64).contains(&c) || c == STATUS_CONTROL_C_EXIT,
        }
    }
}

/// What an ended resume means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeVerdict {
    /// The conversation stays: the agent ran, was interrupted, or ended in a
    /// way that does not say the conversation is missing.
    Keep,
    /// The exit fits; the fallback also needs Hermes to have seen the
    /// vendor's "not found" text.
    NeedsEvidence,
    /// The vendor said the conversation does not exist: start fresh.
    FallBack,
}

/// Whether a resume that just ended failed because the vendor does not know
/// the conversation. Never for an interrupt (Ctrl-C at a trust prompt, a
/// signal), never after the window, and never unless the catalog says how
/// the vendor reports a missing conversation.
pub fn resume_verdict(
    ended: Ended,
    elapsed: Duration,
    fallback: Option<&Fallback>,
) -> ResumeVerdict {
    let Some(f) = fallback else {
        return ResumeVerdict::Keep;
    };
    let Some(nf) = &f.not_found else {
        return ResumeVerdict::Keep;
    };
    if elapsed > Duration::from_millis(f.after_ms) || ended.is_interrupt() {
        return ResumeVerdict::Keep;
    }
    let Ended::Code(code) = ended else {
        return ResumeVerdict::Keep;
    };
    let code_fits = nf.exit_codes.is_empty() || nf.exit_codes.contains(&code);
    if !code_fits {
        ResumeVerdict::Keep
    } else if nf.evidence_file.is_some() {
        ResumeVerdict::NeedsEvidence
    } else {
        ResumeVerdict::FallBack
    }
}

/// Whether Hermes wrote the "not found" evidence for this launch: the file
/// holds the launch's nonce (a file from another launch does not count).
pub fn evidence_present(file: &Path, nonce: Option<&str>) -> bool {
    match std::fs::read_to_string(file) {
        Ok(text) => {
            let text = text.trim();
            match nonce {
                Some(n) => text == n,
                None => !text.is_empty(),
            }
        }
        Err(_) => false,
    }
}

/// Wait up to `wait` for the evidence; Hermes reads the terminal output on
/// its own thread, so it can land a moment after the agent exited.
fn wait_for_evidence(file: &Path, nonce: Option<&str>, wait: Duration) -> bool {
    let deadline = Instant::now() + wait;
    loop {
        if evidence_present(file, nonce) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Leave Ctrl-C to the agent: `hi` only reports how the agent ended.
fn ignore_interrupts() {
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGINT, libc::SIG_IGN);
        libc::signal(libc::SIGQUIT, libc::SIG_IGN);
    }
    #[cfg(windows)]
    unsafe {
        // A handler that says "handled" keeps hi alive; the agent, on the
        // same console, still receives the event. (Passing a null handler
        // would set an "ignore" flag that children inherit — not wanted.)
        SetConsoleCtrlHandler(Some(swallow_ctrl_event), 1);
    }
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn SetConsoleCtrlHandler(
        handler: Option<unsafe extern "system" fn(ctrl_type: u32) -> i32>,
        add: i32,
    ) -> i32;
    fn GetStdHandle(std_handle: u32) -> isize;
    fn GetConsoleMode(handle: isize, mode: *mut u32) -> i32;
}

#[cfg(windows)]
unsafe extern "system" fn swallow_ctrl_event(_ctrl_type: u32) -> i32 {
    1
}

/// Run the agent to its end. With `running_after`, call it once when the
/// agent is still running after that long.
fn run_child(
    resolved: &Path,
    args: &[String],
    env: &BTreeMap<String, String>,
    cwd: Option<&Path>,
    running_after: Option<(Duration, &dyn Fn())>,
) -> std::io::Result<ExitStatus> {
    let mut cmd = Command::new(resolved);
    cmd.args(args);
    cmd.envs(env);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // The child must get the default Ctrl-C behaviour back.
        unsafe {
            cmd.pre_exec(|| {
                libc::signal(libc::SIGINT, libc::SIG_DFL);
                libc::signal(libc::SIGQUIT, libc::SIG_DFL);
                Ok(())
            });
        }
    }
    let mut child = cmd.spawn()?;
    if let Some((after, on_running)) = running_after {
        let started = Instant::now();
        loop {
            if let Some(status) = child.try_wait()? {
                return Ok(status);
            }
            if started.elapsed() >= after {
                on_running();
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    child.wait()
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn append_signal(file: &Path, line: &serde_json::Value) -> std::io::Result<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)?;
    let mut text = serde_json::to_string(line).unwrap_or_default();
    text.push('\n');
    f.write_all(text.as_bytes())
}

/// Where `hi run` reports to Hermes: the session's spool file, with the
/// session, agent and nonce every line carries. Silent when the launch file
/// names no spool (a launch file run by hand).
struct Reporter {
    file: Option<PathBuf>,
    session: String,
    agent: String,
    nonce: Option<String>,
}

impl Reporter {
    fn for_spec(spec: &LaunchSpec) -> Reporter {
        let from_spec_or_env = |name: &str| {
            spec.env
                .get(name)
                .cloned()
                .or_else(|| std::env::var(name).ok())
                .filter(|v| !v.is_empty())
        };
        Reporter {
            file: from_spec_or_env(SIGNAL_FILE_ENV).map(PathBuf::from),
            session: spec.session_id.clone(),
            agent: spec.agent.clone(),
            nonce: from_spec_or_env(NONCE_ENV),
        }
    }

    fn report(&self, event: &str, payload: serde_json::Value) {
        let Some(file) = &self.file else {
            return;
        };
        let mut line = serde_json::json!({
            "v": 1,
            "ts": now_unix(),
            "session": self.session,
            "agent": self.agent,
            "event": event,
            "payload": payload,
        });
        if let Some(nonce) = &self.nonce {
            line["nonce"] = serde_json::Value::String(nonce.clone());
        }
        if let Err(e) = append_signal(file, &line) {
            eprintln!("hi: could not report {event} to Hermes: {e}");
        }
    }

    /// The agent process is gone: tell Hermes how, and return the code to
    /// exit with.
    fn exited(&self, code: i32, error: Option<&str>) -> i32 {
        let mut payload = serde_json::json!({ "exit_code": code });
        if let Some(error) = error {
            payload["error"] = serde_json::Value::String(error.to_string());
        }
        self.report("hermes.exited", payload);
        code
    }
}

fn cmd_run(arg: &str) -> i32 {
    let launch_dir = std::env::var_os(LAUNCH_DIR_ENV).map(PathBuf::from);
    let spec_path = match locate_spec(arg, launch_dir.as_deref()) {
        Ok(p) => p,
        Err(msg) => {
            eprintln!("{msg}");
            return EXIT_USAGE;
        }
    };
    let text = match std::fs::read_to_string(&spec_path) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("hi: cannot read {}: {e}", spec_path.display());
            return EXIT_USAGE;
        }
    };
    let spec = match LaunchSpec::parse(&text) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("hi: {}: {e}", spec_path.display());
            return EXIT_USAGE;
        }
    };

    let cwd: Option<PathBuf> = match spec.cwd.as_deref().map(Path::new) {
        Some(dir) if dir.is_dir() => Some(dir.to_path_buf()),
        Some(dir) => {
            eprintln!(
                "hi: folder {} no longer exists; starting in the current folder",
                dir.display()
            );
            None
        }
        None => None,
    };
    let path = std::env::var_os("PATH");
    let pathext = std::env::var_os("PATHEXT");
    let reporter = Reporter::for_spec(&spec);

    ignore_interrupts();

    let Some(resolved) = resolve_program(&spec.program, path.as_deref(), pathext.as_deref()) else {
        let error = format!("{}: command not found", spec.program);
        eprintln!("hi: {error}");
        return reporter.exited(EXIT_NOT_FOUND, Some(&error));
    };
    let started = Instant::now();
    let status = match run_child(&resolved, &spec.args, &spec.env, cwd.as_deref(), None) {
        Ok(s) => s,
        Err(e) => {
            let error = format!("cannot start {}: {e}", resolved.display());
            eprintln!("hi: {error}");
            return reporter.exited(EXIT_NOT_FOUND, Some(&error));
        }
    };
    let elapsed = started.elapsed();
    let ended = Ended::of(status);
    let fall_back = match resume_verdict(ended, elapsed, spec.fallback.as_ref()) {
        ResumeVerdict::Keep => false,
        ResumeVerdict::FallBack => true,
        ResumeVerdict::NeedsEvidence => spec
            .fallback
            .as_ref()
            .and_then(|f| f.not_found.as_ref())
            .and_then(|nf| {
                nf.evidence_file.as_deref().map(|file| {
                    wait_for_evidence(
                        file,
                        reporter.nonce.as_deref(),
                        Duration::from_millis(nf.evidence_wait_ms),
                    )
                })
            })
            .unwrap_or(false),
    };
    if !fall_back {
        return reporter.exited(ended.code(), None);
    }

    // The vendor does not know the conversation: say so once, tell Hermes,
    // start fresh.
    let fallback = spec.fallback.as_ref().expect("checked above");
    let code = ended.code();
    let message = fallback.message.clone().unwrap_or_else(|| {
        format!("could not resume the previous conversation (exit {code}); starting a new one")
    });
    let mut out = std::io::stdout();
    let _ = write!(out, "\r\nhermes: {message}\r\n");
    let _ = out.flush();
    reporter.report(
        "hermes.resume_fallback",
        serde_json::json!({
            "exit_code": code,
            "elapsed_ms": elapsed.as_millis() as u64,
            "vendor_session_id": fallback.vendor_session_id,
        }),
    );
    let Some(resolved) = resolve_program(&fallback.program, path.as_deref(), pathext.as_deref())
    else {
        let error = format!("{}: command not found", fallback.program);
        eprintln!("hi: {error}");
        return reporter.exited(EXIT_NOT_FOUND, Some(&error));
    };
    // Tell Hermes once the fresh agent is past the quick-failure window, so
    // it can adopt the new conversation even from an agent that sends no
    // start signal of its own.
    let running = || {
        reporter.report(
            "hermes.fallback_running",
            serde_json::json!({ "vendor_session_id": fallback.vendor_session_id }),
        )
    };
    let after = Duration::from_millis(fallback.after_ms);
    match run_child(
        &resolved,
        &fallback.args,
        &spec.env,
        cwd.as_deref(),
        Some((after, &running)),
    ) {
        Ok(s) => reporter.exited(Ended::of(s).code(), None),
        Err(e) => {
            let error = format!("cannot start {}: {e}", resolved.display());
            eprintln!("hi: {error}");
            reporter.exited(EXIT_NOT_FOUND, Some(&error))
        }
    }
}

// ─── Signals ─────────────────────────────────────────────────────────

/// Small, well-known fields worth keeping from a hook payload. Anything else
/// (tool inputs, messages, transcripts) stays out of the spool.
const KEPT_FIELDS: &[&str] = &[
    "hook_event_name",
    "session_id",
    "sessionId",
    "thread-id",
    "thread_id",
    "conversationId",
    "type",
    "source",
    "reason",
    "cwd",
    "notification_type",
    "tool_name",
    "permission_mode",
    "stop_hook_active",
    "transcript_path",
    "title",
    "error",
];

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

/// One spool line. `event` comes from the payload's `hook_event_name` when
/// present, else from `--event`, else it is "unknown". `nonce` is the
/// launch's (from `HERMES_SIGNAL_NONCE`); without it Hermes ignores the line.
pub fn signal_line(
    event_flag: Option<&str>,
    agent: &str,
    session: &str,
    nonce: Option<&str>,
    payload: Option<&serde_json::Value>,
) -> serde_json::Value {
    let mut kept = serde_json::Map::new();
    if let Some(serde_json::Value::Object(map)) = payload {
        for key in KEPT_FIELDS {
            match map.get(*key) {
                Some(serde_json::Value::String(s)) => {
                    kept.insert(
                        key.to_string(),
                        serde_json::Value::String(truncate_chars(s, MAX_FIELD_CHARS)),
                    );
                }
                Some(v @ serde_json::Value::Bool(_)) | Some(v @ serde_json::Value::Number(_)) => {
                    kept.insert(key.to_string(), v.clone());
                }
                _ => {}
            }
        }
    }
    let event = kept
        .get("hook_event_name")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| event_flag.map(str::to_string))
        .filter(|e| !e.is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    let mut line = serde_json::json!({
        "v": 1,
        "ts": now_unix(),
        "session": session,
        "agent": agent,
        "event": truncate_chars(&event, 64),
        "payload": serde_json::Value::Object(kept),
    });
    if let Some(nonce) = nonce.filter(|n| !n.is_empty()) {
        line["nonce"] = serde_json::Value::String(truncate_chars(nonce, 128));
    }
    line
}

fn stdin_is_terminal() -> bool {
    #[cfg(unix)]
    unsafe {
        libc::isatty(0) == 1
    }
    #[cfg(windows)]
    unsafe {
        const STD_INPUT_HANDLE: u32 = -10i32 as u32;
        let handle = GetStdHandle(STD_INPUT_HANDLE);
        let mut mode = 0u32;
        GetConsoleMode(handle, &mut mode) != 0
    }
}

fn read_stdin_json() -> Option<serde_json::Value> {
    if stdin_is_terminal() {
        return None;
    }
    let mut buf = Vec::new();
    let mut limited = std::io::stdin().take(MAX_STDIN_BYTES as u64);
    if limited.read_to_end(&mut buf).is_err() || buf.is_empty() {
        return None;
    }
    serde_json::from_slice(&buf).ok()
}

fn cmd_signal(args: &[String]) -> i32 {
    let mut agent: Option<String> = None;
    let mut event: Option<String> = None;
    // Codex's `notify` program gets the event as one JSON argument instead
    // of stdin; `--argv-json` says the payload is the last argument.
    let mut argv_json = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--agent" if i + 1 < args.len() => {
                agent = Some(args[i + 1].clone());
                i += 1;
            }
            "--event" if i + 1 < args.len() => {
                event = Some(args[i + 1].clone());
                i += 1;
            }
            "--argv-json" => argv_json = true,
            _ => {}
        }
        i += 1;
    }
    let Some(file) = std::env::var_os(SIGNAL_FILE_ENV).filter(|f| !f.is_empty()) else {
        // Not started by Hermes: nothing to report to, nothing to say.
        return 0;
    };
    let agent = agent
        .or_else(|| std::env::var(AGENT_ENV).ok())
        .unwrap_or_else(|| "unknown".to_string());
    let session = std::env::var(SESSION_ID_ENV).unwrap_or_default();
    let nonce = std::env::var(NONCE_ENV).ok();
    let payload = if argv_json {
        args.last()
            .filter(|a| a.len() <= MAX_STDIN_BYTES)
            .and_then(|a| serde_json::from_str::<serde_json::Value>(a).ok())
    } else {
        read_stdin_json()
    };
    let line = signal_line(
        event.as_deref(),
        &agent,
        &session,
        nonce.as_deref(),
        payload.as_ref(),
    );
    // A hook must never fail the agent, so errors are swallowed on purpose.
    let _ = append_signal(Path::new(&file), &line);
    0
}

// ─── Entry point ─────────────────────────────────────────────────────

fn usage() -> i32 {
    eprintln!(
        "hi {VERSION} — Hermes launch and signal helper\n\n\
         usage:\n  hi run <session-id | launch-file>\n  hi signal [--agent <id>] [--event <name>] [--argv-json <json>]\n  hi --version"
    );
    EXIT_USAGE
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        Some("run") => match args.get(1) {
            Some(arg) if args.len() == 2 => cmd_run(arg),
            _ => usage(),
        },
        Some("signal") => cmd_signal(&args[1..]),
        Some("--version") | Some("-V") | Some("version") => {
            println!("hi {VERSION} (launch file v{SPEC_VERSION})");
            0
        }
        _ => usage(),
    };
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_exe(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        p
    }

    #[test]
    fn parses_a_launch_file_with_a_fallback() {
        let spec = LaunchSpec::parse(
            r#"{"v":1,"session_id":"s1","agent":"claude","cwd":"/tmp/x","env":{"A":"1"},
                "program":"claude","args":["--resume","abc"],
                "fallback":{"program":"claude","args":["--session-id","def"],"after_ms":3000,"vendor_session_id":"def"}}"#,
        )
        .unwrap();
        assert_eq!(spec.program, "claude");
        assert_eq!(spec.args, vec!["--resume", "abc"]);
        assert_eq!(spec.env["A"], "1");
        let fb = spec.fallback.unwrap();
        assert_eq!(fb.args, vec!["--session-id", "def"]);
        assert_eq!(fb.vendor_session_id.as_deref(), Some("def"));
        assert_eq!(fb.after_ms, 3000);
    }

    #[test]
    fn refuses_other_versions_and_missing_programs() {
        assert!(LaunchSpec::parse(r#"{"v":2,"program":"x"}"#)
            .unwrap_err()
            .contains("version 2"));
        assert!(LaunchSpec::parse(r#"{"v":1}"#)
            .unwrap_err()
            .contains("program"));
        assert!(LaunchSpec::parse(r#"{"v":1,"program":"x","args":[1]}"#)
            .unwrap_err()
            .contains("args"));
        assert!(LaunchSpec::parse("nope").unwrap_err().contains("JSON"));
    }

    #[test]
    fn locates_the_launch_file_by_session_id_or_path() {
        let dir = tempfile::tempdir().unwrap();
        let sess = dir.path().join("abc-123");
        std::fs::create_dir_all(&sess).unwrap();
        std::fs::write(sess.join(LAUNCH_FILE_NAME), "{}").unwrap();
        assert_eq!(
            locate_spec("abc-123", Some(dir.path())).unwrap(),
            sess.join(LAUNCH_FILE_NAME)
        );
        let direct = sess.join(LAUNCH_FILE_NAME);
        assert_eq!(locate_spec(direct.to_str().unwrap(), None).unwrap(), direct);
        assert!(locate_spec("missing", Some(dir.path())).is_err());
        assert!(locate_spec("../abc-123", Some(dir.path())).is_err());
        assert!(locate_spec("abc-123", None)
            .unwrap_err()
            .contains(LAUNCH_DIR_ENV));
    }

    #[test]
    fn resolves_a_program_on_path() {
        let dir = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let name = if cfg!(windows) {
            "fake-agent.cmd"
        } else {
            "fake-agent"
        };
        let exe = write_exe(dir.path(), name);
        let path = std::env::join_paths([other.path(), dir.path()]).unwrap();
        // On Windows the extension comes from PATHEXT (`.CMD`), and the file
        // system does not care about case; compare without it there.
        let same_file = |a: &Path, b: &Path| {
            if cfg!(windows) {
                a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
            } else {
                a == b
            }
        };
        let found = resolve_program(
            "fake-agent",
            Some(&path),
            Some(OsStr::new(".COM;.EXE;.CMD")),
        )
        .expect("fake-agent is on PATH");
        assert!(same_file(&found, &exe), "{found:?} vs {exe:?}");
        assert_eq!(resolve_program("no-such-agent", Some(&path), None), None);
        // A path is used as given.
        assert_eq!(
            resolve_program(exe.to_str().unwrap(), Some(&path), None),
            Some(exe)
        );
        assert_eq!(
            resolve_program(dir.path().join("nope").to_str().unwrap(), None, None),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_file_without_the_execute_bit_is_not_a_program() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("script"), "x").unwrap();
        let path = std::env::join_paths([dir.path()]).unwrap();
        assert_eq!(resolve_program("script", Some(&path), None), None);
    }

    fn fallback(not_found: Option<NotFound>) -> Fallback {
        Fallback {
            program: "x".into(),
            args: vec![],
            after_ms: 3000,
            vendor_session_id: None,
            message: None,
            not_found,
        }
    }

    const QUICK: Duration = Duration::from_millis(200);

    #[test]
    fn an_interrupted_resume_never_falls_back() {
        // Ctrl-C at a resumed agent's trust prompt: exit 130, or killed by
        // SIGINT, or Windows' Ctrl-C status. The conversation must stay,
        // even with a catalog entry that accepts any exit code.
        let any_code = fallback(Some(NotFound::default()));
        for ended in [
            Ended::Code(130),
            Ended::Signal(2),
            Ended::Signal(15),
            Ended::Signal(9),
            Ended::Code(143),
            Ended::Code(0xC000_013Au32 as i32),
        ] {
            assert!(ended.is_interrupt(), "{ended:?}");
            assert_eq!(
                resume_verdict(ended, QUICK, Some(&any_code)),
                ResumeVerdict::Keep,
                "{ended:?}"
            );
        }
        assert!(!Ended::Code(1).is_interrupt());
        assert!(!Ended::Code(42).is_interrupt());
        assert!(!Ended::Code(128).is_interrupt());
        assert_eq!(Ended::Signal(2).code(), 130);
    }

    #[test]
    fn only_the_vendors_own_not_found_exit_falls_back() {
        // No catalog entry: an early exit proves nothing.
        assert_eq!(
            resume_verdict(Ended::Code(1), QUICK, Some(&fallback(None))),
            ResumeVerdict::Keep
        );
        assert_eq!(
            resume_verdict(Ended::Code(1), QUICK, None),
            ResumeVerdict::Keep
        );
        let codes = fallback(Some(NotFound {
            exit_codes: vec![1],
            ..NotFound::default()
        }));
        assert_eq!(
            resume_verdict(Ended::Code(1), QUICK, Some(&codes)),
            ResumeVerdict::FallBack
        );
        // Another code, a clean exit, or a late failure keeps it.
        assert_eq!(
            resume_verdict(Ended::Code(2), QUICK, Some(&codes)),
            ResumeVerdict::Keep
        );
        assert_eq!(
            resume_verdict(Ended::Code(0), QUICK, Some(&codes)),
            ResumeVerdict::Keep
        );
        assert_eq!(
            resume_verdict(Ended::Code(1), Duration::from_millis(3001), Some(&codes)),
            ResumeVerdict::Keep
        );
        // With a text to look for, the exit only qualifies; Hermes must
        // also have seen the text.
        let text = fallback(Some(NotFound {
            exit_codes: vec![1],
            evidence_file: Some(PathBuf::from("/nonexistent/evidence")),
            evidence_wait_ms: 10,
        }));
        assert_eq!(
            resume_verdict(Ended::Code(1), QUICK, Some(&text)),
            ResumeVerdict::NeedsEvidence
        );
        assert_eq!(
            resume_verdict(Ended::Code(130), QUICK, Some(&text)),
            ResumeVerdict::Keep
        );
    }

    #[test]
    fn evidence_counts_only_with_this_launchs_nonce() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("resume-not-found");
        assert!(!evidence_present(&file, Some("n1")));
        std::fs::write(&file, "n0\n").unwrap();
        assert!(!evidence_present(&file, Some("n1")), "another launch's");
        std::fs::write(&file, "n1\n").unwrap();
        assert!(evidence_present(&file, Some("n1")));
        assert!(evidence_present(&file, None));
        assert!(wait_for_evidence(&file, Some("n1"), Duration::ZERO));
        let start = Instant::now();
        assert!(!wait_for_evidence(
            &dir.path().join("none"),
            Some("n1"),
            Duration::from_millis(100)
        ));
        assert!(start.elapsed() >= Duration::from_millis(100));
    }

    #[test]
    fn parses_the_not_found_block() {
        let spec = LaunchSpec::parse(
            r#"{"v":1,"program":"claude","fallback":{"program":"claude",
                "not_found":{"exit_codes":[1,42],"evidence_file":"/x/resume-not-found"}}}"#,
        )
        .unwrap();
        let nf = spec.fallback.unwrap().not_found.unwrap();
        assert_eq!(nf.exit_codes, vec![1, 42]);
        assert_eq!(
            nf.evidence_file.as_deref(),
            Some(Path::new("/x/resume-not-found"))
        );
        assert_eq!(nf.evidence_wait_ms, DEFAULT_EVIDENCE_WAIT_MS);
        let none =
            LaunchSpec::parse(r#"{"v":1,"program":"x","fallback":{"program":"x"}}"#).unwrap();
        assert!(none.fallback.unwrap().not_found.is_none());
        assert!(LaunchSpec::parse(
            r#"{"v":1,"program":"x","fallback":{"program":"x","not_found":{"exit_codes":["1"]}}}"#
        )
        .unwrap_err()
        .contains("exit_codes"));
    }

    #[test]
    fn signal_lines_keep_only_small_known_fields() {
        let big = "x".repeat(5000);
        let payload = serde_json::json!({
            "hook_event_name": "SessionStart",
            "session_id": "abc",
            "cwd": "/repo",
            "tool_input": {"command": "rm -rf /"},
            "last_assistant_message": big,
            "transcript_path": big,
            "stop_hook_active": false,
        });
        let line = signal_line(
            Some("Other"),
            "claude",
            "hermes-1",
            Some("abc123"),
            Some(&payload),
        );
        assert_eq!(line["event"], "SessionStart");
        assert_eq!(line["agent"], "claude");
        assert_eq!(line["session"], "hermes-1");
        assert_eq!(line["nonce"], "abc123");
        assert_eq!(line["v"], 1);
        let kept = line["payload"].as_object().unwrap();
        assert_eq!(kept["session_id"], "abc");
        assert_eq!(kept["stop_hook_active"], false);
        assert!(kept.get("tool_input").is_none());
        assert!(kept.get("last_assistant_message").is_none());
        assert_eq!(
            kept["transcript_path"].as_str().unwrap().len(),
            MAX_FIELD_CHARS
        );
        assert!(serde_json::to_string(&line).unwrap().len() < 8 * 1024);
    }

    #[test]
    fn signal_event_falls_back_to_the_flag_then_unknown() {
        assert_eq!(
            signal_line(Some("Stop"), "codex", "s", None, None)["event"],
            "Stop"
        );
        assert_eq!(
            signal_line(None, "codex", "s", None, None)["event"],
            "unknown"
        );
        let not_object = serde_json::json!(["a"]);
        assert_eq!(
            signal_line(Some("E"), "x", "s", None, Some(&not_object))["event"],
            "E"
        );
    }

    #[test]
    fn a_line_without_a_nonce_has_no_nonce_field() {
        let line = signal_line(Some("Stop"), "x", "s", None, None);
        assert!(line.get("nonce").is_none());
        let empty = signal_line(Some("Stop"), "x", "s", Some(""), None);
        assert!(empty.get("nonce").is_none());
    }
}
