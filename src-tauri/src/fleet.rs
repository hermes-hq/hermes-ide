//! Fleet controls (Hermes 2.0: F31 spend caps, N22 task queue).
//!
//! Two questions the frontend asks about the agents it runs, whatever the
//! agent is:
//!
//! - [`fleet_agent_load`]: is something running in this session's shell
//!   (the agent), and how much memory does it use? The task queue counts
//!   running agents and their memory against the caps the user set.
//! - [`interrupt_session_agent`]: stop the running agent the way Ctrl+C at a
//!   shell would, because a spend cap the user set was reached. It signals;
//!   it never types into the terminal.
//!
//! Hermes decides nothing here: both commands are answers and actions the
//! frontend asks for, only when the user has turned a cap on.

use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Manager};

use crate::pty::commands::counts_as_shell_child;
use crate::AppState;

/// What one session's agent costs the machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLoad {
    pub session_id: String,
    /// Whether the session's shell has a program running (its agent).
    /// `None` when Hermes has no shell process for the session (an Agent
    /// view session, or one that is gone).
    pub running: Option<bool>,
    /// Resident memory of everything the shell started, in bytes.
    pub memory_bytes: u64,
}

/// One row of the process table, as far as the load needs it.
#[derive(Debug, Clone)]
pub(crate) struct ProcRow {
    pub pid: u32,
    pub parent: Option<u32>,
    /// Seconds since the epoch; 0 when the OS would not say.
    pub start_time: u64,
    pub memory: u64,
    pub name: String,
}

/// Pure: whether the shell has a program running, and the memory of every
/// process below it (the shell itself not included).
pub(crate) fn tree_load(rows: &[ProcRow], shell_pid: u32) -> (bool, u64) {
    let shell_started = rows
        .iter()
        .find(|r| r.pid == shell_pid)
        .map_or(0, |r| r.start_time);
    let mut stack: Vec<u32> = rows
        .iter()
        .filter(|r| {
            r.parent == Some(shell_pid)
                && r.pid != shell_pid
                && counts_as_shell_child(shell_started, r.start_time, &r.name)
        })
        .map(|r| r.pid)
        .collect();
    let running = !stack.is_empty();
    let mut seen = std::collections::HashSet::new();
    let mut memory: u64 = 0;
    while let Some(pid) = stack.pop() {
        if pid == shell_pid || !seen.insert(pid) {
            continue;
        }
        if let Some(row) = rows.iter().find(|r| r.pid == pid) {
            memory = memory.saturating_add(row.memory);
        }
        stack.extend(
            rows.iter()
                .filter(|r| r.parent == Some(pid) && !seen.contains(&r.pid))
                .map(|r| r.pid),
        );
    }
    (running, memory)
}

fn process_rows() -> Vec<ProcRow> {
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_memory(),
    );
    sys.processes()
        .iter()
        .map(|(pid, p)| ProcRow {
            pid: pid.as_u32(),
            parent: p.parent().map(Pid::as_u32),
            start_time: p.start_time(),
            memory: p.memory(),
            name: p.name().to_string_lossy().into_owned(),
        })
        .collect()
}

/// For each session: is its agent running, and how much memory it uses.
/// Reads the process table once, on a blocking thread, and holds the PTY
/// manager lock only to look up the shells' process ids.
#[tauri::command]
pub async fn fleet_agent_load(
    app: AppHandle,
    session_ids: Vec<String>,
) -> Result<Vec<AgentLoad>, String> {
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let shells: Vec<(String, Option<u32>)> = {
            let mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
            session_ids
                .into_iter()
                .map(|id| {
                    let pid = mgr.sessions.get(&id).and_then(|s| s.transport.pid());
                    (id, pid)
                })
                .collect()
        };
        if shells.iter().all(|(_, pid)| pid.is_none()) {
            return shells
                .into_iter()
                .map(|(session_id, _)| AgentLoad {
                    session_id,
                    running: None,
                    memory_bytes: 0,
                })
                .collect();
        }
        let rows = process_rows();
        shells
            .into_iter()
            .map(|(session_id, pid)| match pid {
                Some(pid) => {
                    let (running, memory_bytes) = tree_load(&rows, pid);
                    AgentLoad {
                        session_id,
                        running: Some(running),
                        memory_bytes,
                    }
                }
                None => AgentLoad {
                    session_id,
                    running: None,
                    memory_bytes: 0,
                },
            })
            .collect()
    })
    .await
    .map_err(|e| format!("could not read the process table: {e}"))
}

/// Interrupt the agent running in a session's terminal, because a spend cap
/// was reached. Returns `false` when nothing was running (nothing is sent).
///
/// Nothing is typed into the terminal on any platform:
///
/// - macOS and Linux: SIGINT to the terminal's foreground process group, the
///   signal Ctrl+C makes the terminal send.
/// - Windows: the console's Ctrl+C event, raised with
///   `GenerateConsoleCtrlEvent` by a short-lived copy of Hermes attached to
///   the session's console (see [`console_interrupt_helper`]); Hermes itself
///   never attaches to a session's console.
#[tauri::command]
pub async fn interrupt_session_agent(app: AppHandle, session_id: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || interrupt_blocking(&app, &session_id))
        .await
        .map_err(|e| format!("could not interrupt the agent: {e}"))?
}

#[cfg(unix)]
fn interrupt_blocking(app: &AppHandle, session_id: &str) -> Result<bool, String> {
    let state = app.state::<AppState>();
    let mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
    let session = mgr
        .sessions
        .get(session_id)
        .ok_or_else(|| format!("Session {session_id} not found"))?;
    let shell_pid = session
        .transport
        .pid()
        .ok_or_else(|| "the session has no shell process".to_string())?;

    let shell_pgid = unsafe { libc::getpgid(shell_pid as i32) };
    if let Some(foreground) = session.transport.foreground_group() {
        if foreground > 0 && foreground != shell_pgid {
            let sent = unsafe { libc::kill(-foreground, libc::SIGINT) } == 0;
            log::info!(
                "[fleet] cap interrupt: SIGINT to group {foreground} of {session_id}: {sent}"
            );
            return Ok(sent);
        }
    }
    // The terminal could not say (or the shell owns it): signal the
    // shell's children directly.
    let children = crate::pty::commands::enumerate_child_pids(shell_pid);
    let mut sent = false;
    for pid in children {
        if pid == 0 || pid > i32::MAX as u32 {
            continue;
        }
        let pid = pid as i32;
        let group = unsafe { libc::kill(-pid, libc::SIGINT) } == 0;
        let own = group || unsafe { libc::kill(pid, libc::SIGINT) } == 0;
        sent |= own;
    }
    log::info!("[fleet] cap interrupt: SIGINT to the children of {session_id}: {sent}");
    Ok(sent)
}

#[cfg(not(unix))]
fn interrupt_blocking(app: &AppHandle, session_id: &str) -> Result<bool, String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let shell_pid = {
        let state = app.state::<AppState>();
        let mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
        let session = mgr
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("Session {session_id} not found"))?;
        session
            .transport
            .pid()
            .ok_or_else(|| "the session has no shell process".to_string())?
    };
    if !crate::pty::commands::has_child_process(shell_pid) {
        return Ok(false);
    }
    // DETACHED_PROCESS: the helper starts with no console of its own, then
    // attaches to the session's.
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    let exe = std::env::current_exe().map_err(|e| format!("could not find Hermes: {e}"))?;
    let mut child = Command::new(exe)
        .arg(INTERRUPT_HELPER_ARG)
        .arg(shell_pid.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(DETACHED_PROCESS)
        .spawn()
        .map_err(|e| format!("could not start the interrupt helper: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                return Err("the interrupt helper did not finish".to_string());
            }
            Err(e) => return Err(format!("could not wait for the interrupt helper: {e}")),
        }
    };
    let mut said = String::new();
    if let Some(mut out) = child.stdout.take() {
        use std::io::Read;
        let _ = out.read_to_string(&mut said);
    }
    let sent = status.success();
    log::info!(
        "[fleet] cap interrupt: console Ctrl+C event to {session_id} (shell {shell_pid}): {sent} ({status}); {}",
        said.trim()
    );
    Ok(sent)
}

/// Windows: let programs in Hermes's terminals receive Ctrl+C even when
/// Hermes itself was started with Ctrl+C turned off (a process started in
/// a new process group has it off, and every process it starts inherits
/// that, the shells in its terminals included). Hermes has no console
/// window of its own to press Ctrl+C in, so this changes nothing for it.
pub fn let_terminals_receive_ctrl_c() {
    #[cfg(windows)]
    // SAFETY: a plain Win32 call on this process's own console state.
    unsafe {
        windows_sys::Win32::System::Console::SetConsoleCtrlHandler(None, 0);
    }
}

/// The argument that starts Hermes as the Windows interrupt helper.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) const INTERRUPT_HELPER_ARG: &str = "--hermes-interrupt-console";

/// Windows: when Hermes was started as `hermes-ide --hermes-interrupt-console
/// <shell pid>`, attach to that shell's console, raise its Ctrl+C event
/// (every program attached to it gets it, as when Ctrl+C is pressed in a
/// console, whatever mode the program put the console in) and return the
/// exit code: 0 sent, 2 bad arguments, 3 could not attach, 4 not sent.
/// `None` for any other command line: start the app. Always `None`
/// elsewhere.
pub fn console_interrupt_helper(args: &[String]) -> Option<i32> {
    if args.get(1).map(String::as_str) != Some(INTERRUPT_HELPER_ARG) {
        return None;
    }
    let Some(pid) = args.get(2).and_then(|a| a.parse::<u32>().ok()) else {
        return Some(2);
    };
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Console::{
            AttachConsole, FreeConsole, GenerateConsoleCtrlEvent, GetConsoleProcessList,
            SetConsoleCtrlHandler, CTRL_C_EVENT,
        };
        let mut attached = [0u32; 64];
        // SAFETY: plain Win32 calls on this short-lived process's own
        // console state; the one buffer passed is ours, with its length.
        let (sent, count) = unsafe {
            FreeConsole();
            if AttachConsole(pid) == 0 {
                return Some(3);
            }
            // The helper is attached too: it must not stop itself.
            SetConsoleCtrlHandler(None, 1);
            let count = GetConsoleProcessList(attached.as_mut_ptr(), attached.len() as u32);
            let sent = GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0) != 0;
            FreeConsole();
            (sent, count)
        };
        // For Hermes's log: which programs share the console (the helper
        // itself among them).
        let listed = &attached[..(count as usize).min(attached.len())];
        println!("attached to the console of {pid}: {listed:?} ({count} in all)");
        Some(if sent { 0 } else { 4 })
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pid: u32, parent: Option<u32>, start_time: u64, memory: u64, name: &str) -> ProcRow {
        ProcRow {
            pid,
            parent,
            start_time,
            memory,
            name: name.to_string(),
        }
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn the_app_starts_normally_unless_asked_to_be_the_interrupt_helper() {
        assert_eq!(console_interrupt_helper(&args(&["hermes-ide"])), None);
        assert_eq!(
            console_interrupt_helper(&args(&["hermes-ide", "--self-test=r.json"])),
            None
        );
        assert_eq!(
            console_interrupt_helper(&args(&["hermes-ide", INTERRUPT_HELPER_ARG])),
            Some(2)
        );
        assert_eq!(
            console_interrupt_helper(&args(&["hermes-ide", INTERRUPT_HELPER_ARG, "abc"])),
            Some(2)
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn outside_windows_the_helper_never_runs() {
        assert_eq!(
            console_interrupt_helper(&args(&["hermes-ide", INTERRUPT_HELPER_ARG, "123"])),
            None
        );
    }

    #[test]
    fn a_shell_at_its_prompt_runs_nothing_and_uses_no_agent_memory() {
        let rows = vec![
            row(1, None, 10, 5_000, "launchd"),
            row(100, Some(1), 20, 3_000, "zsh"),
        ];
        assert_eq!(tree_load(&rows, 100), (false, 0));
    }

    #[test]
    fn an_agent_and_everything_it_started_count_but_the_shell_does_not() {
        let rows = vec![
            row(100, Some(1), 20, 3_000, "zsh"),
            row(200, Some(100), 30, 400_000, "node"),
            row(201, Some(200), 31, 50_000, "rg"),
            row(202, Some(201), 32, 7_000, "git"),
            row(300, Some(1), 30, 999_999, "unrelated"),
        ];
        assert_eq!(tree_load(&rows, 100), (true, 457_000));
    }

    #[test]
    fn an_orphan_of_a_reused_pid_and_the_console_host_do_not_count() {
        let rows = vec![
            row(100, Some(1), 20, 3_000, "pwsh.exe"),
            // Started before the shell: the child of an earlier process 100.
            row(150, Some(100), 5, 80_000, "old.exe"),
            row(151, Some(100), 21, 9_000, "conhost.exe"),
        ];
        assert_eq!(tree_load(&rows, 100), (false, 0));
    }

    #[test]
    fn a_parent_cycle_in_a_bad_process_table_ends() {
        let rows = vec![
            row(100, Some(1), 20, 3_000, "zsh"),
            row(200, Some(100), 30, 10, "a"),
            row(201, Some(200), 30, 20, "b"),
            // 200 claims 201 as its parent too (pid reuse mid-scan).
            row(200, Some(201), 30, 10, "a"),
        ];
        let (running, memory) = tree_load(&rows, 100);
        assert!(running);
        assert_eq!(memory, 30);
    }
}
