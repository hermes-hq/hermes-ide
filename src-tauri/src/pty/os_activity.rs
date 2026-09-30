//! The OS layer of agent status: facts from the process table, used only
//! below what an agent reports itself.
//!
//! For every agent Hermes started through `hi run <session>`, one shared
//! thread looks at the process table twice a second:
//!
//! - whether the agent (the helper's child) is alive, and whether the helper
//!   itself is gone without having said so (a killed helper);
//! - whether a tool command runs under the agent: a shell among its
//!   descendants (Claude, Codex and Antigravity run every command through
//!   one; MCP servers and the agent's own helpers are not shells). A shell
//!   that has been there since the agent started (an MCP server or helper
//!   started through one) or one a package runner started (`npx` running an
//!   MCP server, `npm run dev` in the background) is not a command;
//! - how much CPU the agent's process tree used since the last look.
//!
//! What it concludes goes out as ordinary session events with the source
//! `"os"` and confidence `guessed`: `working` while a tool command runs or
//! the tree keeps a core busy, `idle` once it has been quiet for a moment
//! (which the frontend reads as "no opinion": see deriveStatus). The
//! frontend ranks them above the terminal's screen heuristics and below
//! everything an agent reports, so a fact from the process table never
//! overrides an exact signal (docs/adr/004-2.0-contracts.md; deriveStatus).
//!
//! It also backs the one guess an agent without an approval event needs
//! (Antigravity, whose catalog lists `tool_pending`): a tool call announced
//! by the agent's own hook that neither starts a command nor finishes within
//! [`APPROVAL_GUESS_AFTER`], while the tree is quiet, is most likely waiting
//! for the person's approval. That guess is sent with the hook's own source,
//! so the agent's next report (the tool finishing) replaces it, and at
//! `guessed` confidence, so it never raises an inbox item (the frontend's
//! status bridge). Once a command starts under the agent, or the tree gets
//! busy, after the guess, the person has answered: the layer takes the
//! guess back with a guessed `working` under the same source.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use std::sync::{Arc, Mutex as StdMutex};

use tauri::{AppHandle, Emitter};

use super::adapters::now;
use super::models::{AgentStartup, AgentStartupState, Session, SessionUpdate};
use crate::contract::{AgentStatus, AgentStatusKind, Confidence, SessionEvent};

/// The source of every event this layer sends.
pub const OS_SOURCE: &str = "os";
/// How often the process table is read.
pub const TICK: Duration = Duration::from_millis(500);
/// Share of one core the agent's tree must use, over a tick, to count as
/// busy. An agent sitting at its prompt redraws a cursor and nothing more;
/// one streaming an answer or running its own code is well above this.
pub const BUSY_CPU_SHARE: f64 = 0.10;
/// Consecutive busy ticks before CPU alone says `working`.
pub const BUSY_TICKS: u32 = 2;
/// Consecutive quiet ticks before `working` goes back to "no opinion".
pub const QUIET_TICKS: u32 = 3;
/// A pending tool call (see the module docs) older than this, with no tool
/// command running and a quiet tree, is reported as waiting for approval.
pub const APPROVAL_GUESS_AFTER: Duration = Duration::from_millis(1500);
/// An agent that sends no start signal of its own (Codex before its first
/// prompt, Antigravity, the agents with no hooks at all) is taken as
/// started once its process has lived this long and is quiet.
pub const STARTED_AFTER: Duration = Duration::from_secs(3);
/// After the helper disappeared, how many ticks to wait for its own exit
/// report before saying the agent is gone.
const GONE_GRACE_TICKS: u32 = 3;
/// A watched session whose helper never showed up in this long (the launch
/// line was never run: the shell closed first, or the person typed over it)
/// is dropped.
pub const HELPER_WAIT: Duration = Duration::from_secs(60);
/// A shell started within this many seconds of the agent itself (process
/// start times have a one-second resolution) is part of the agent's own
/// startup (an MCP server or a helper started through a shell), not a
/// command it runs for the person.
pub const STARTUP_SHELL_GRACE_S: u64 = 2;

// ─── Pure parts ──────────────────────────────────────────────────────

/// Program names that mean "a command is running": the shells agents run
/// their tool commands through.
pub fn is_tool_process(name: &str) -> bool {
    let base = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(name)
        .trim_start_matches('-')
        .to_ascii_lowercase();
    let base = base.strip_suffix(".exe").unwrap_or(&base);
    matches!(
        base,
        "sh" | "bash"
            | "zsh"
            | "fish"
            | "dash"
            | "ksh"
            | "tcsh"
            | "csh"
            | "nu"
            | "pwsh"
            | "powershell"
            | "cmd"
    )
}

/// Whether a process is a package runner (`npx`, `npm exec`, `npm run`,
/// pnpm, yarn, bun): a shell below one is the program it runs (an MCP
/// server, a dev server), not a command the agent runs.
pub fn is_package_runner(name: &str, cmd: &[String]) -> bool {
    const RUNNERS: [&str; 7] = ["npm", "npx", "pnpm", "pnpx", "yarn", "bun", "bunx"];
    const SCRIPTS: [&str; 5] = [
        "npm-cli.js",
        "npx-cli.js",
        "pnpm.cjs",
        "yarn.js",
        "yarn.cjs",
    ];
    let base = |s: &str| {
        let b = s
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(s)
            .to_ascii_lowercase();
        let b = b.strip_suffix(".exe").unwrap_or(&b).to_string();
        b.strip_suffix(".cmd").unwrap_or(&b).to_string()
    };
    if RUNNERS.contains(&base(name).as_str()) {
        return true;
    }
    // npm sets its process title to "npm exec ...", which is what the
    // process table shows as its first argument.
    let first = cmd.first().map(|a| a.as_str()).unwrap_or("");
    let first_word = first.split_whitespace().next().unwrap_or("");
    if RUNNERS.contains(&base(first_word).as_str()) {
        return true;
    }
    cmd.iter()
        .skip(1)
        .take(2)
        .any(|a| SCRIPTS.contains(&base(a).as_str()))
}

/// Whether a command line is `hi run <session_id>` (the helper may be
/// started by path, or through an interpreter in tests).
pub fn is_launch_of(cmd: &[String], session_id: &str) -> bool {
    cmd.windows(3).any(|w| {
        let name = w[0].rsplit(['/', '\\']).next().unwrap_or(&w[0]);
        (name == "hi" || name.eq_ignore_ascii_case("hi.exe")) && w[1] == "run" && w[2] == session_id
    })
}

/// One look at an agent's process tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sample {
    /// The helper (`hi run <session>`) is in the process table.
    pub helper_alive: bool,
    /// The agent (the helper's child) is in the process table.
    pub agent_alive: bool,
    /// The name of a tool command running under the agent, if any.
    pub tool: Option<String>,
    /// CPU time the agent's tree used since the previous sample, ms.
    pub cpu_ms: u64,
    /// Wall time since the previous sample, ms.
    pub interval_ms: u64,
}

/// What the layer says after a sample, when it changed its mind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Working, with the reason (a tool command, or CPU).
    Working(String),
    /// Back to no opinion.
    Quiet,
}

/// The hysteresis between samples and verdicts. Pure.
#[derive(Debug, Default)]
pub struct Judge {
    busy: u32,
    quiet: u32,
    working: bool,
    reason: String,
}

impl Judge {
    /// Whether the tree used at least [`BUSY_CPU_SHARE`] of a core.
    pub fn cpu_busy(sample: &Sample) -> bool {
        sample.interval_ms > 0
            && (sample.cpu_ms as f64) >= BUSY_CPU_SHARE * sample.interval_ms as f64
    }

    /// Feed one sample; returns a verdict when the layer's opinion changed.
    pub fn observe(&mut self, sample: &Sample) -> Option<Verdict> {
        if !sample.agent_alive {
            self.busy = 0;
            self.quiet = 0;
            if self.working {
                self.working = false;
                return Some(Verdict::Quiet);
            }
            return None;
        }
        let reason = if let Some(tool) = &sample.tool {
            self.busy = BUSY_TICKS;
            Some(format!("a command is running ({tool})"))
        } else if Self::cpu_busy(sample) {
            self.busy += 1;
            (self.busy >= BUSY_TICKS).then(|| "the agent is using the CPU".to_string())
        } else {
            self.busy = 0;
            None
        };
        match reason {
            Some(reason) => {
                self.quiet = 0;
                if !self.working || self.reason != reason {
                    self.working = true;
                    self.reason = reason.clone();
                    return Some(Verdict::Working(reason));
                }
                None
            }
            None => {
                if !self.working {
                    return None;
                }
                self.quiet += 1;
                if self.quiet >= QUIET_TICKS {
                    self.working = false;
                    self.quiet = 0;
                    return Some(Verdict::Quiet);
                }
                None
            }
        }
    }
}

/// The session event a verdict is sent as.
pub fn verdict_event(verdict: &Verdict, at: i64) -> SessionEvent {
    let (kind, detail) = match verdict {
        Verdict::Working(reason) => (AgentStatusKind::Working, reason.clone()),
        Verdict::Quiet => (AgentStatusKind::Idle, String::new()),
    };
    SessionEvent::Status {
        at,
        source: Some(OS_SOURCE.to_string()),
        tags: None,
        status: AgentStatus {
            kind,
            confidence: Confidence::Guessed,
            detail,
        },
    }
}

/// A tool call the agent announced and has not finished (see module docs).
#[derive(Debug, Clone)]
struct Pending {
    since: Instant,
    tool: String,
    source: String,
    reported: bool,
}

/// Whether a pending tool call now looks like it waits for approval.
pub fn approval_due(pending_for: Duration, sample: &Sample) -> bool {
    pending_for >= APPROVAL_GUESS_AFTER
        && sample.agent_alive
        && sample.tool.is_none()
        && !Judge::cpu_busy(sample)
}

/// Whether an agent with no start signal of its own looks started: alive for
/// [`STARTED_AFTER`], and neither running a command nor busy.
pub fn start_settled_by_process(alive_for: Duration, sample: &Sample) -> bool {
    alive_for >= STARTED_AFTER
        && sample.agent_alive
        && sample.tool.is_none()
        && !Judge::cpu_busy(sample)
}

/// A session still "launching" once [`start_settled_by_process`] holds:
/// started, as a guess (the agent never said so). True when it changed.
pub fn mark_started_by_process(s: &mut Session) -> bool {
    let launching = matches!(
        s.agent_startup.as_ref().map(|a| a.state),
        Some(AgentStartupState::Launching)
    );
    if !launching {
        return false;
    }
    s.agent_startup = Some(AgentStartup {
        state: AgentStartupState::Started,
        since: now(),
        confidence: "guessed".to_string(),
        detail: Some("the agent's process is up and quiet".to_string()),
    });
    true
}

/// After a guessed approval: the reason to take it back, when the person
/// has evidently answered (a command started under the agent, or the layer
/// newly saw it working), else None. `verdict`: what the layer concluded
/// from this sample, if it changed its mind.
pub fn approval_answered(verdict: Option<&Verdict>, sample: &Sample) -> Option<String> {
    match (verdict, &sample.tool) {
        (Some(Verdict::Working(reason)), _) => Some(reason.clone()),
        (_, Some(tool)) => Some(format!("a command is running ({tool})")),
        _ => None,
    }
}

/// Taking a guessed approval back: a guessed `working` under the guess's
/// own source, so it replaces the guess (a source may correct itself) and
/// yields to the agent's next report.
pub fn approval_answered_event(reason: &str, source: &str, at: i64) -> SessionEvent {
    SessionEvent::Status {
        at,
        source: Some(source.to_string()),
        tags: None,
        status: AgentStatus {
            kind: AgentStatusKind::Working,
            confidence: Confidence::Guessed,
            detail: reason.to_string(),
        },
    }
}

/// The guessed "needs approval" for a pending tool call.
pub fn approval_guess_event(tool: &str, source: &str, at: i64) -> SessionEvent {
    SessionEvent::Status {
        at,
        source: Some(source.to_string()),
        tags: None,
        status: AgentStatus {
            kind: AgentStatusKind::NeedsApproval,
            confidence: Confidence::Guessed,
            detail: tool.to_string(),
        },
    }
}

// ─── The process table ───────────────────────────────────────────────

/// One process, as far as this layer cares.
#[derive(Debug, Clone)]
pub struct Proc {
    pub pid: u32,
    pub parent: Option<u32>,
    pub name: String,
    pub cmd: Vec<String>,
    pub cpu_ms: u64,
    /// When the process started, seconds since the epoch.
    pub start_s: u64,
}

/// Every descendant of `root` (not `root` itself).
pub fn descendants(procs: &[Proc], root: u32) -> Vec<&Proc> {
    let mut out = Vec::new();
    let mut frontier = vec![root];
    let mut seen: HashSet<u32> = HashSet::from([root]);
    while let Some(parent) = frontier.pop() {
        for p in procs.iter().filter(|p| p.parent == Some(parent)) {
            if seen.insert(p.pid) {
                out.push(p);
                frontier.push(p.pid);
            }
        }
    }
    out
}

/// The helper, the agent and what runs under it, from a process list.
/// `cpu_before`: the tree's CPU total at the previous look (None the first
/// time). Returns the sample and the new total.
pub fn sample_of(
    procs: &[Proc],
    session_id: &str,
    cpu_before: Option<u64>,
    interval_ms: u64,
) -> (Sample, u64) {
    let helper = procs.iter().find(|p| is_launch_of(&p.cmd, session_id));
    let Some(helper) = helper else {
        return (
            Sample {
                helper_alive: false,
                agent_alive: false,
                tool: None,
                cpu_ms: 0,
                interval_ms,
            },
            cpu_before.unwrap_or(0),
        );
    };
    let agent = procs
        .iter()
        .filter(|p| p.parent == Some(helper.pid))
        .max_by_key(|p| p.pid);
    let Some(agent) = agent else {
        return (
            Sample {
                helper_alive: true,
                agent_alive: false,
                tool: None,
                cpu_ms: 0,
                interval_ms,
            },
            cpu_before.unwrap_or(0),
        );
    };
    let below = descendants(procs, agent.pid);
    let tool = below
        .iter()
        .find(|p| is_command_shell(procs, agent, p))
        .map(|p| p.name.clone());
    let total: u64 = agent.cpu_ms + below.iter().map(|p| p.cpu_ms).sum::<u64>();
    let cpu_ms = cpu_before.map_or(0, |b| total.saturating_sub(b));
    (
        Sample {
            helper_alive: true,
            agent_alive: true,
            tool,
            cpu_ms,
            interval_ms,
        },
        total,
    )
}

/// Whether `shell`, a descendant of `agent`, is a command the agent runs: a
/// shell that started after the agent's own startup, and not below a
/// package runner (see the module docs).
fn is_command_shell(procs: &[Proc], agent: &Proc, shell: &Proc) -> bool {
    if !is_tool_process(&shell.name) {
        return false;
    }
    if shell.start_s <= agent.start_s + STARTUP_SHELL_GRACE_S {
        return false;
    }
    let mut parent = shell.parent;
    while let Some(pid) = parent {
        if pid == agent.pid {
            return true;
        }
        let Some(p) = procs.iter().find(|p| p.pid == pid) else {
            return true;
        };
        if is_package_runner(&p.name, &p.cmd) {
            return false;
        }
        parent = p.parent;
    }
    true
}

/// Read the process table: names and parents for everything, command lines
/// once per process, CPU time for every process (cheap: one call each).
fn read_processes(sys: &mut sysinfo::System) -> Vec<Proc> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, UpdateKind};
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cpu()
            .with_cmd(UpdateKind::OnlyIfNotSet),
    );
    sys.processes()
        .iter()
        .map(|(pid, p)| Proc {
            pid: pid.as_u32(),
            parent: p.parent().map(|pp| pp.as_u32()),
            name: p.name().to_string_lossy().to_string(),
            cmd: p
                .cmd()
                .iter()
                .map(|a| a.to_string_lossy().to_string())
                .collect(),
            cpu_ms: p.accumulated_cpu_time(),
            start_s: p.start_time(),
        })
        .collect()
}

// ─── The shared watcher ──────────────────────────────────────────────

struct Watched {
    app: AppHandle,
    session: Arc<StdMutex<Session>>,
    /// The agent sends a start signal of its own (its hook file has one).
    expects_start: bool,
    /// Since when the agent's process has been seen alive.
    alive_since: Option<Instant>,
    /// The start was settled by this layer.
    start_settled: bool,
    judge: Judge,
    cpu_total: Option<u64>,
    last: Instant,
    /// When the watch began, for [`HELPER_WAIT`].
    since: Instant,
    seen_helper: bool,
    gone_ticks: u32,
    pending: Option<Pending>,
}

fn registry() -> &'static Mutex<HashMap<String, Watched>> {
    static REG: OnceLock<Mutex<HashMap<String, Watched>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn running() -> &'static Mutex<bool> {
    static RUNNING: OnceLock<Mutex<bool>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(false))
}

/// Start watching the agent Hermes launched in `session_id` (through
/// `hi run <session_id>`). Watching again restarts the session's state (a
/// relaunch). Ends by itself once the helper is gone.
pub fn watch(
    app: AppHandle,
    session: Arc<StdMutex<Session>>,
    session_id: &str,
    expects_start_signal: bool,
) {
    if let Ok(mut reg) = registry().lock() {
        reg.insert(
            session_id.to_string(),
            Watched {
                app,
                session,
                expects_start: expects_start_signal,
                alive_since: None,
                start_settled: false,
                judge: Judge::default(),
                cpu_total: None,
                last: Instant::now(),
                since: Instant::now(),
                seen_helper: false,
                gone_ticks: 0,
                pending: None,
            },
        );
    }
    let mut on = running().lock().unwrap_or_else(|e| e.into_inner());
    if !*on {
        *on = true;
        std::thread::spawn(run);
    }
}

/// Stop watching a session (its helper reported the agent's exit, or the
/// session closed). Nothing more is sent for it.
pub fn unwatch(session_id: &str) {
    if let Ok(mut reg) = registry().lock() {
        reg.remove(session_id);
    }
}

/// The agent announced a tool call (a `tool_pending` event of its catalog).
pub fn note_tool_pending(session_id: &str, tool: &str, source: &str) {
    if let Ok(mut reg) = registry().lock() {
        if let Some(w) = reg.get_mut(session_id) {
            w.pending = Some(Pending {
                since: Instant::now(),
                tool: tool.to_string(),
                source: source.to_string(),
                reported: false,
            });
        }
    }
}

/// The agent reported anything else: a pending tool call is settled.
pub fn note_agent_signal(session_id: &str) {
    if let Ok(mut reg) = registry().lock() {
        if let Some(w) = reg.get_mut(session_id) {
            w.pending = None;
        }
    }
}

fn run() {
    let mut sys = sysinfo::System::new();
    loop {
        std::thread::sleep(TICK);
        let empty = registry().lock().map(|r| r.is_empty()).unwrap_or(true);
        if empty {
            let mut on = running().lock().unwrap_or_else(|e| e.into_inner());
            // Re-check under the flag: a watch may have just arrived.
            if registry().lock().map(|r| r.is_empty()).unwrap_or(true) {
                *on = false;
                return;
            }
            continue;
        }
        let procs = read_processes(&mut sys);
        let now_ms = crate::turn_ledger::now_ms();
        let mut out: Vec<(AppHandle, String, SessionEvent)> = Vec::new();
        let mut settle: Vec<(AppHandle, Arc<StdMutex<Session>>)> = Vec::new();
        if let Ok(mut reg) = registry().lock() {
            let mut done: Vec<String> = Vec::new();
            for (sid, w) in reg.iter_mut() {
                let interval = w.last.elapsed().as_millis() as u64;
                w.last = Instant::now();
                let (sample, total) = sample_of(&procs, sid, w.cpu_total, interval);
                w.cpu_total = Some(total);
                if sample.helper_alive {
                    w.seen_helper = true;
                    w.gone_ticks = 0;
                } else if !w.seen_helper {
                    // The launch line never ran: nothing to watch.
                    if w.since.elapsed() >= HELPER_WAIT {
                        done.push(sid.clone());
                    }
                    continue;
                } else {
                    // The helper is gone and has not reported it (its
                    // report unwatches the session first).
                    w.gone_ticks += 1;
                    if w.gone_ticks >= GONE_GRACE_TICKS {
                        out.push((
                            w.app.clone(),
                            sid.clone(),
                            SessionEvent::Exit {
                                at: now_ms,
                                source: Some(OS_SOURCE.to_string()),
                                tags: None,
                                code: None,
                                signal: None,
                            },
                        ));
                        done.push(sid.clone());
                    }
                    continue;
                }
                let verdict = w.judge.observe(&sample);
                if let Some(verdict) = &verdict {
                    out.push((w.app.clone(), sid.clone(), verdict_event(verdict, now_ms)));
                }
                if sample.agent_alive {
                    let since = *w.alive_since.get_or_insert_with(Instant::now);
                    if !w.expects_start
                        && !w.start_settled
                        && start_settled_by_process(since.elapsed(), &sample)
                    {
                        w.start_settled = true;
                        settle.push((w.app.clone(), Arc::clone(&w.session)));
                    }
                } else {
                    w.alive_since = None;
                }
                let mut answered = false;
                if let Some(p) = w.pending.as_mut() {
                    if p.reported {
                        // The guess stands until the person evidently
                        // answered it.
                        if let Some(reason) = approval_answered(verdict.as_ref(), &sample) {
                            answered = true;
                            out.push((
                                w.app.clone(),
                                sid.clone(),
                                approval_answered_event(&reason, &p.source, now_ms),
                            ));
                        }
                    } else if approval_due(p.since.elapsed(), &sample) {
                        p.reported = true;
                        out.push((
                            w.app.clone(),
                            sid.clone(),
                            approval_guess_event(&p.tool, &p.source, now_ms),
                        ));
                    }
                }
                if answered {
                    w.pending = None;
                }
            }
            for sid in done {
                reg.remove(&sid);
            }
        }
        for (app, sid, event) in out {
            crate::contract::emit_session_event(&app, &sid, event);
        }
        for (app, session) in settle {
            let Ok(mut s) = session.lock() else { continue };
            if mark_started_by_process(&mut s) {
                let update = SessionUpdate::from(&*s);
                let _ = app.emit("session-updated", &update);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(tool: Option<&str>, cpu_ms: u64) -> Sample {
        Sample {
            helper_alive: true,
            agent_alive: true,
            tool: tool.map(str::to_string),
            cpu_ms,
            interval_ms: 500,
        }
    }

    #[test]
    fn shells_are_tool_commands_and_other_programs_are_not() {
        for name in [
            "zsh",
            "/bin/bash",
            "-zsh",
            "sh",
            "pwsh.exe",
            "cmd.exe",
            "fish",
        ] {
            assert!(is_tool_process(name), "{name}");
        }
        for name in [
            "node", "claude", "codex", "python3", "hi", "git", "rg", "shx",
        ] {
            assert!(!is_tool_process(name), "{name}");
        }
    }

    #[test]
    fn the_helper_is_found_by_its_session_id_only() {
        let cmd = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(is_launch_of(&cmd(&["/app/hi", "run", "s-1"]), "s-1"));
        assert!(is_launch_of(
            &cmd(&["C:\\app\\hi.exe", "run", "s-1"]),
            "s-1"
        ));
        assert!(is_launch_of(
            &cmd(&["/bin/sh", "/tmp/x/hi", "run", "s-1"]),
            "s-1"
        ));
        assert!(!is_launch_of(&cmd(&["/app/hi", "run", "s-2"]), "s-1"));
        assert!(!is_launch_of(&cmd(&["/app/hi", "signal", "s-1"]), "s-1"));
        assert!(!is_launch_of(&cmd(&["/app/high", "run", "s-1"]), "s-1"));
        assert!(!is_launch_of(&cmd(&["hi", "run"]), "s-1"));
    }

    #[test]
    fn a_running_command_says_working_at_once_and_quiet_needs_a_moment() {
        let mut j = Judge::default();
        assert_eq!(
            j.observe(&sample(None, 0)),
            None,
            "quiet from the start says nothing"
        );
        assert_eq!(
            j.observe(&sample(Some("zsh"), 0)),
            Some(Verdict::Working("a command is running (zsh)".into()))
        );
        assert_eq!(j.observe(&sample(Some("zsh"), 0)), None, "no repeat");
        assert_eq!(j.observe(&sample(None, 0)), None);
        assert_eq!(j.observe(&sample(None, 0)), None);
        assert_eq!(j.observe(&sample(None, 0)), Some(Verdict::Quiet));
        assert_eq!(j.observe(&sample(None, 0)), None);
    }

    #[test]
    fn cpu_alone_needs_two_busy_looks_and_a_blip_is_not_work() {
        let mut j = Judge::default();
        assert_eq!(j.observe(&sample(None, 200)), None, "one busy look");
        assert_eq!(j.observe(&sample(None, 1)), None, "then quiet: a blip");
        assert_eq!(j.observe(&sample(None, 60)), None);
        assert_eq!(
            j.observe(&sample(None, 60)),
            Some(Verdict::Working("the agent is using the CPU".into()))
        );
        // Below 10% of a core is quiet.
        assert!(!Judge::cpu_busy(&sample(None, 49)));
        assert!(Judge::cpu_busy(&sample(None, 50)));
    }

    #[test]
    fn an_agent_that_ended_ends_the_working_verdict() {
        let mut j = Judge::default();
        j.observe(&sample(Some("bash"), 0));
        let gone = Sample {
            agent_alive: false,
            ..sample(None, 0)
        };
        assert_eq!(j.observe(&gone), Some(Verdict::Quiet));
        assert_eq!(j.observe(&gone), None);
    }

    #[test]
    fn verdicts_are_guesses_from_the_os() {
        match verdict_event(&Verdict::Working("x".into()), 5) {
            SessionEvent::Status {
                source, status, at, ..
            } => {
                assert_eq!(source.as_deref(), Some(OS_SOURCE));
                assert_eq!(status.confidence, Confidence::Guessed);
                assert_eq!(status.kind, AgentStatusKind::Working);
                assert_eq!(at, 5);
            }
            other => panic!("{other:?}"),
        }
        match verdict_event(&Verdict::Quiet, 6) {
            SessionEvent::Status { status, .. } => assert_eq!(status.kind, AgentStatusKind::Idle),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_pending_tool_call_looks_like_an_approval_only_when_nothing_runs() {
        let quiet = sample(None, 0);
        assert!(
            !approval_due(Duration::from_millis(1000), &quiet),
            "too early"
        );
        assert!(approval_due(Duration::from_millis(1600), &quiet));
        assert!(
            !approval_due(Duration::from_millis(5000), &sample(Some("bash"), 0)),
            "the command runs"
        );
        assert!(
            !approval_due(Duration::from_millis(5000), &sample(None, 400)),
            "the agent is busy"
        );
        match approval_guess_event("run_command", "hook:antigravity", 9) {
            SessionEvent::Status { source, status, .. } => {
                assert_eq!(source.as_deref(), Some("hook:antigravity"));
                assert_eq!(status.kind, AgentStatusKind::NeedsApproval);
                assert_eq!(status.confidence, Confidence::Guessed);
                assert_eq!(status.detail, "run_command");
            }
            other => panic!("{other:?}"),
        }
    }

    fn p(pid: u32, parent: u32, name: &str, cmd: &[&str], cpu_ms: u64) -> Proc {
        Proc {
            pid,
            parent: Some(parent),
            name: name.to_string(),
            cmd: cmd.iter().map(|s| s.to_string()).collect(),
            cpu_ms,
            start_s: 1000,
        }
    }

    /// A process that started `secs` after the others.
    fn later(mut proc: Proc, secs: u64) -> Proc {
        proc.start_s += secs;
        proc
    }

    #[test]
    fn a_sample_reads_the_helper_the_agent_and_the_command_under_it() {
        let mut procs = vec![
            p(10, 1, "zsh", &["-zsh"], 5),
            p(11, 10, "hi", &["/app/hi", "run", "s-1"], 1),
            p(12, 11, "claude", &["claude", "--session-id", "x"], 1000),
            p(13, 12, "node", &["node", "mcp-server.js"], 300),
            p(20, 1, "hi", &["/app/hi", "run", "s-2"], 1),
        ];
        let (first, total) = sample_of(&procs, "s-1", None, 500);
        assert!(first.helper_alive && first.agent_alive);
        assert_eq!(first.tool, None, "an MCP server is not a command");
        assert_eq!(first.cpu_ms, 0, "no delta on the first look");
        assert_eq!(total, 1300);
        procs[2].cpu_ms = 1200;
        procs.push(later(
            p(14, 12, "zsh", &["/bin/zsh", "-c", "npm test"], 10),
            30,
        ));
        let (second, total) = sample_of(&procs, "s-1", Some(total), 500);
        assert_eq!(second.tool.as_deref(), Some("zsh"));
        assert_eq!(second.cpu_ms, 210);
        assert_eq!(total, 1510);
        // The other session's helper has no agent.
        let (other, _) = sample_of(&procs, "s-2", None, 500);
        assert!(other.helper_alive && !other.agent_alive);
        let (none, _) = sample_of(&procs, "s-3", None, 500);
        assert!(!none.helper_alive);
    }

    #[test]
    fn shells_from_the_agents_startup_or_a_package_runner_are_not_commands() {
        let base = vec![
            p(11, 1, "hi", &["/app/hi", "run", "s-1"], 1),
            p(12, 11, "agy", &["agy"], 100),
            // An MCP server the agent started through a shell at startup.
            p(13, 12, "sh", &["/bin/sh", "-c", "mcp-server-git"], 1),
            // One started later through npx (npm's process title), and a
            // dev server started by `npm run dev` long after.
            later(p(14, 12, "node", &["npm exec @mcp/fetch"], 5), 20),
            later(p(15, 14, "sh", &["sh", "-c", "mcp-fetch"], 1), 21),
            later(
                p(
                    16,
                    12,
                    "node",
                    &[
                        "node",
                        "/usr/lib/node_modules/npm/bin/npm-cli.js",
                        "run",
                        "dev",
                    ],
                    5,
                ),
                40,
            ),
            later(p(17, 16, "sh", &["sh", "-c", "vite"], 1), 41),
        ];
        let (s, _) = sample_of(&base, "s-1", None, 500);
        assert!(s.agent_alive);
        assert_eq!(s.tool, None, "long-lived shells are not commands");
        // Within the grace, still startup; after it, a command.
        let mut procs = base.clone();
        procs.push(later(
            p(18, 12, "zsh", &["/bin/zsh", "-c", "ls"], 1),
            STARTUP_SHELL_GRACE_S,
        ));
        assert_eq!(sample_of(&procs, "s-1", None, 500).0.tool, None);
        procs.push(later(
            p(19, 12, "zsh", &["/bin/zsh", "-c", "cargo test"], 1),
            60,
        ));
        assert_eq!(
            sample_of(&procs, "s-1", None, 500).0.tool.as_deref(),
            Some("zsh")
        );
        // A command the agent runs that itself uses npm still counts: its
        // own shell is the agent's.
        let mut npm_test = base.clone();
        npm_test.push(later(p(20, 12, "bash", &["bash", "-c", "npm test"], 1), 60));
        npm_test.push(later(p(21, 20, "npm", &["npm", "test"], 1), 60));
        npm_test.push(later(p(22, 21, "sh", &["sh", "-c", "vitest"], 1), 61));
        assert_eq!(
            sample_of(&npm_test, "s-1", None, 500).0.tool.as_deref(),
            Some("bash")
        );
    }

    #[test]
    fn package_runners_are_known_by_name_title_or_script() {
        let cmd = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(is_package_runner("npx", &[]));
        assert!(is_package_runner("npm.cmd", &[]));
        assert!(is_package_runner("C:\\nodejs\\pnpm.exe", &[]));
        assert!(is_package_runner("node", &cmd(&["npm exec @scope/server"])));
        assert!(is_package_runner(
            "node",
            &cmd(&["node", "/x/npm/bin/npx-cli.js", "-y", "server"])
        ));
        assert!(!is_package_runner("node", &cmd(&["node", "server.js"])));
        assert!(!is_package_runner("zsh", &cmd(&["zsh", "-c", "npm test"])));
    }

    #[test]
    fn a_guessed_approval_is_taken_back_once_a_command_starts_or_the_agent_works() {
        let quiet = sample(None, 0);
        assert_eq!(approval_answered(None, &quiet), None, "still waiting");
        assert_eq!(
            approval_answered(None, &sample(Some("zsh"), 0)),
            Some("a command is running (zsh)".to_string())
        );
        assert_eq!(
            approval_answered(
                Some(&Verdict::Working("the agent is using the CPU".into())),
                &sample(None, 400)
            ),
            Some("the agent is using the CPU".to_string())
        );
        assert_eq!(approval_answered(Some(&Verdict::Quiet), &quiet), None);
        match approval_answered_event("a command is running (zsh)", "hook:antigravity", 9) {
            SessionEvent::Status { source, status, .. } => {
                assert_eq!(
                    source.as_deref(),
                    Some("hook:antigravity"),
                    "the guess's own source"
                );
                assert_eq!(status.kind, AgentStatusKind::Working);
                assert_eq!(status.confidence, Confidence::Guessed);
                assert_eq!(status.detail, "a command is running (zsh)");
            }
            other => panic!("{other:?}"),
        }
    }

    /// The real process table: a helper started as `hi run <id>` (a shell
    /// script named hi), its agent, and a command the agent starts later.
    #[cfg(unix)]
    #[test]
    fn the_real_process_table_shows_the_agent_and_its_command() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let hi = dir.path().join("hi");
        // The "agent" (a shell) waits past its startup, then runs a "tool
        // command" (another shell) for a while.
        std::fs::write(
            &hi,
            "#!/bin/sh\n/bin/sh -c 'sleep 4; /bin/sh -c \"sleep 3; true\"; sleep 2'\n",
        )
        .unwrap();
        std::fs::set_permissions(&hi, std::fs::Permissions::from_mode(0o755)).unwrap();
        let sid = format!("os-test-{}", std::process::id());
        let mut child = std::process::Command::new(&hi)
            .args(["run", &sid])
            .spawn()
            .unwrap();
        let mut sys = sysinfo::System::new();
        let deadline = Instant::now() + Duration::from_secs(12);
        let (mut saw_agent, mut saw_tool) = (false, false);
        while Instant::now() < deadline && !(saw_agent && saw_tool) {
            let procs = read_processes(&mut sys);
            let (s, _) = sample_of(&procs, &sid, None, 500);
            saw_agent |= s.agent_alive;
            saw_tool |= s.tool.is_some();
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = child.kill();
        let _ = child.wait();
        assert!(saw_agent, "the helper's child was not found");
        assert!(saw_tool, "the command under the agent was not found");
    }
}
