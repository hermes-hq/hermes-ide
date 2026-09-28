//! Fleet controls (Hermes 2.0: F31 spend caps, N22 task queue).
//!
//! Two questions the frontend asks about the agents it runs, whatever the
//! agent is:
//!
//! - [`fleet_agent_load`]: is something running in this session's shell
//!   (the agent), and how much memory does it use? The task queue counts
//!   running agents and their memory against the caps the user set.
//! - [`interrupt_session_agent`]: stop the running agent the way Ctrl+C at a
//!   shell would, because a spend cap the user set was reached.
//!
//! Hermes decides nothing here: both commands are answers and actions the
//! frontend asks for, only when the user has turned a cap on.

use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Manager, State};

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
                    let pid = mgr.sessions.get(&id).and_then(|s| s.child.process_id());
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
/// - macOS and Linux: SIGINT to the terminal's foreground process group, the
///   signal Ctrl+C makes the terminal send. Nothing is typed.
/// - Windows has no signals for console programs; the pseudo console turns
///   a Ctrl+C character into the console's interrupt event, so that one
///   character is sent, only while a program is running.
#[tauri::command]
pub fn interrupt_session_agent(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<bool, String> {
    let mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
    let session = mgr
        .sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session {session_id} not found"))?;
    let shell_pid = session
        .child
        .process_id()
        .ok_or_else(|| "the session has no shell process".to_string())?;

    #[cfg(unix)]
    {
        let shell_pgid = unsafe { libc::getpgid(shell_pid as i32) };
        if let Some(foreground) = session.master.process_group_leader() {
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
    {
        if !crate::pty::commands::has_child_process(shell_pid) {
            return Ok(false);
        }
        let mut w = session
            .writer
            .lock()
            .map_err(|e| format!("Writer lock failed: {e}"))?;
        use std::io::Write;
        w.write_all(b"\x03")
            .map_err(|e| format!("Write failed: {e}"))?;
        w.flush().map_err(|e| format!("Flush failed: {e}"))?;
        log::info!("[fleet] cap interrupt: Ctrl+C to the console of {session_id}");
        Ok(true)
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
