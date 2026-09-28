//! F24: what each session costs in memory, and what Hermes itself does.
//!
//! A session's memory is the resident memory of its terminal's process tree:
//! the shell, the agent it runs and everything the agent started (language
//! servers, MCP servers, a Node bridge). Hermes's own memory is its process
//! and every descendant that is not part of a session (on Windows and Linux
//! that includes the web view; on macOS the web view runs as a system
//! service outside Hermes's process tree and is not counted).
//!
//! Works for any program in any terminal: nothing here knows which agent,
//! if any, is running.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::State;

use crate::AppState;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMemory {
    pub session_id: String,
    /// Resident memory of the session's process tree, in bytes.
    pub bytes: u64,
    /// How many processes that tree has (the shell counts).
    pub processes: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetMemory {
    /// Hermes without its sessions, in bytes.
    pub app_bytes: u64,
    pub app_processes: u32,
    pub sessions: Vec<SessionMemory>,
}

/// One process as the tree walk needs it.
#[derive(Debug, Clone, Copy)]
pub struct Proc {
    pub pid: u32,
    pub ppid: Option<u32>,
    pub bytes: u64,
    /// A thread of another process (Linux lists them as processes, with
    /// the whole process's memory): never counted.
    pub thread: bool,
}

fn subtree(root: u32, children: &HashMap<u32, Vec<u32>>, seen: &mut HashSet<u32>) -> Vec<u32> {
    let mut out = Vec::new();
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue; // a pid reused as its own ancestor, or claimed already
        }
        out.push(pid);
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids.iter().copied());
        }
    }
    out
}

/// Pure: split the process table into sessions and the app. A session whose
/// root process is gone reports 0 bytes and 0 processes.
pub fn fleet_from(procs: &[Proc], app_pid: u32, roots: &[(String, u32)]) -> FleetMemory {
    let procs: Vec<&Proc> = procs.iter().filter(|p| !p.thread).collect();
    let bytes: HashMap<u32, u64> = procs.iter().map(|p| (p.pid, p.bytes)).collect();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for p in procs {
        if let Some(ppid) = p.ppid.filter(|pp| *pp != p.pid) {
            children.entry(ppid).or_default().push(p.pid);
        }
    }
    let mut claimed = HashSet::new();
    // The app itself is never part of a session's tree.
    claimed.insert(app_pid);
    let mut sessions = Vec::with_capacity(roots.len());
    for (id, root) in roots {
        let tree: Vec<u32> = if bytes.contains_key(root) && *root != app_pid {
            subtree(*root, &children, &mut claimed)
        } else {
            Vec::new()
        };
        sessions.push(SessionMemory {
            session_id: id.clone(),
            bytes: tree
                .iter()
                .map(|p| bytes.get(p).copied().unwrap_or(0))
                .sum(),
            processes: tree.len() as u32,
        });
    }
    claimed.remove(&app_pid);
    let app_tree = subtree(app_pid, &children, &mut claimed);
    FleetMemory {
        app_bytes: app_tree
            .iter()
            .map(|p| bytes.get(p).copied().unwrap_or(0))
            .sum(),
        app_processes: app_tree.len() as u32,
        sessions,
    }
}

/// Its own process table, so the Processes panel's CPU readings (which need
/// two refreshes of the same table) are left alone.
fn table() -> &'static Mutex<System> {
    static TABLE: OnceLock<Mutex<System>> = OnceLock::new();
    TABLE.get_or_init(|| Mutex::new(System::new()))
}

/// Batch terminal output into fewer web view events (fleetPerf flag, read
/// by the frontend at startup). See pty/output_batch.rs.
#[tauri::command]
pub fn fleet_set_output_batching(enabled: bool) {
    crate::pty::output_batch::set_batching(enabled);
}

/// Memory of every session's process tree and of Hermes itself.
#[tauri::command]
pub fn fleet_memory(state: State<'_, AppState>) -> Result<FleetMemory, String> {
    let roots: Vec<(String, u32)> = {
        let mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
        mgr.sessions
            .iter()
            .filter_map(|(id, s)| s.child.process_id().map(|pid| (id.clone(), pid)))
            .collect()
    };
    let mut sys = table().lock().map_err(|e| e.to_string())?;
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_memory().without_tasks(),
    );
    let procs: Vec<Proc> = sys
        .processes()
        .iter()
        .map(|(pid, p)| Proc {
            pid: pid.as_u32(),
            ppid: p.parent().map(|pp| pp.as_u32()),
            bytes: p.memory(),
            thread: p.thread_kind().is_some(),
        })
        .collect();
    Ok(fleet_from(&procs, std::process::id(), &roots))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: u32, ppid: u32, mb: u64) -> Proc {
        Proc {
            pid,
            ppid: Some(ppid),
            bytes: mb * 1024 * 1024,
            thread: false,
        }
    }

    #[test]
    fn threads_listed_as_processes_are_not_counted_again() {
        // Linux lists each thread with its process's whole memory and the
        // process as its parent; counting them multiplied Hermes's figure.
        let thread = |pid, ppid, mb| Proc {
            thread: true,
            ..p(pid, ppid, mb)
        };
        let procs = vec![
            p(100, 1, 200),
            thread(110, 100, 200),
            thread(111, 100, 200),
            p(200, 100, 5),
            thread(210, 200, 5),
        ];
        let fleet = fleet_from(&procs, 100, &[("s1".into(), 200)]);
        assert_eq!(fleet.app_bytes, 200 * 1024 * 1024);
        assert_eq!(fleet.app_processes, 1);
        assert_eq!(
            (fleet.sessions[0].bytes, fleet.sessions[0].processes),
            (5 * 1024 * 1024, 1)
        );
    }

    #[test]
    fn a_session_is_its_shell_and_everything_below_it_and_the_app_is_the_rest() {
        let procs = vec![
            p(1, 0, 1),       // init, not ours
            p(100, 1, 200),   // Hermes
            p(101, 100, 300), // web view (a child on Windows and Linux)
            p(200, 100, 5),   // shell of s1
            p(201, 200, 120), // agent in s1
            p(202, 201, 40),  // MCP server under the agent
            p(300, 100, 6),   // shell of s2
            p(900, 1, 999),   // someone else's program
        ];
        let fleet = fleet_from(&procs, 100, &[("s1".into(), 200), ("s2".into(), 300)]);
        assert_eq!(fleet.sessions[0].session_id, "s1");
        assert_eq!(fleet.sessions[0].bytes, 165 * 1024 * 1024);
        assert_eq!(fleet.sessions[0].processes, 3);
        assert_eq!(fleet.sessions[1].bytes, 6 * 1024 * 1024);
        assert_eq!(fleet.sessions[1].processes, 1);
        assert_eq!(
            fleet.app_bytes,
            500 * 1024 * 1024,
            "Hermes + web view, no sessions, no strangers"
        );
        assert_eq!(fleet.app_processes, 2);
    }

    #[test]
    fn a_gone_root_or_a_cycle_does_not_break_the_walk() {
        let procs = vec![p(100, 0, 10), p(5, 6, 1), p(6, 5, 1), p(7, 100, 2)];
        let fleet = fleet_from(
            &procs,
            100,
            &[
                ("dead".into(), 4242),
                ("loop".into(), 5),
                ("app".into(), 100),
            ],
        );
        assert_eq!(
            (fleet.sessions[0].bytes, fleet.sessions[0].processes),
            (0, 0)
        );
        assert_eq!(fleet.sessions[1].processes, 2, "each pid once");
        assert_eq!(
            (fleet.sessions[2].bytes, fleet.sessions[2].processes),
            (0, 0),
            "the app is never a session"
        );
        assert_eq!(fleet.app_processes, 2);
    }
}
