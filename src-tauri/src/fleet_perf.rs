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
//!
//! Two things the OS's process table can get wrong, and how the walk copes:
//!
//! * A process's recorded parent is only the pid of whoever created it. On
//!   Windows a process whose creator has exited keeps that pid, and when the
//!   pid is handed to a new process (Hermes, a shell, a web view helper) the
//!   stranger looks like its child. A process that started before its
//!   recorded parent cannot be that parent's child, so the walk drops the
//!   link and reports the stranger under `disowned`.
//! * The table is read fresh on every call. A table kept between calls
//!   remembers a process by pid, and on Windows also by a handle opened when
//!   the pid was first seen; when the pid is reused the entry keeps the dead
//!   process's name and last memory figure.

use std::collections::{HashMap, HashSet};

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

/// Processes of one program, as the breakdowns list them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramMemory {
    pub name: String,
    pub processes: u32,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetMemory {
    /// Hermes without its sessions, in bytes.
    pub app_bytes: u64,
    pub app_processes: u32,
    /// What `app_bytes` is made of, by program, largest first.
    pub app_by_program: Vec<ProgramMemory>,
    /// Processes whose recorded parent is Hermes or something below it but
    /// that started before that parent: strangers left by pid reuse, not
    /// counted anywhere. Empty unless the OS reused a pid.
    pub disowned: Vec<ProgramMemory>,
    pub sessions: Vec<SessionMemory>,
}

/// One process as the tree walk needs it.
#[derive(Debug, Clone)]
pub struct Proc {
    pub pid: u32,
    pub ppid: Option<u32>,
    pub bytes: u64,
    /// A thread of another process (Linux lists them as processes, with
    /// the whole process's memory): never counted.
    pub thread: bool,
    /// When it started, in seconds since the epoch; 0 when the OS did not
    /// say (then the parent link is taken as it is).
    pub start: u64,
    pub name: String,
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

fn by_program<'a>(
    pids: impl Iterator<Item = &'a u32>,
    procs: &HashMap<u32, &Proc>,
) -> Vec<ProgramMemory> {
    let mut groups: HashMap<&str, ProgramMemory> = HashMap::new();
    for pid in pids {
        if let Some(p) = procs.get(pid) {
            let g = groups
                .entry(p.name.as_str())
                .or_insert_with(|| ProgramMemory {
                    name: p.name.clone(),
                    processes: 0,
                    bytes: 0,
                });
            g.processes += 1;
            g.bytes += p.bytes;
        }
    }
    let mut out: Vec<ProgramMemory> = groups.into_values().collect();
    out.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.name.cmp(&b.name)));
    out
}

/// Pure: split the process table into sessions and the app. A session whose
/// root process is gone reports 0 bytes and 0 processes.
pub fn fleet_from(procs: &[Proc], app_pid: u32, roots: &[(String, u32)]) -> FleetMemory {
    let procs: HashMap<u32, &Proc> = procs
        .iter()
        .filter(|p| !p.thread)
        .map(|p| (p.pid, p))
        .collect();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    // Links dropped because the child started before its recorded parent.
    let mut dropped: Vec<(u32, u32)> = Vec::new();
    for p in procs.values() {
        let Some(ppid) = p.ppid.filter(|pp| *pp != p.pid) else {
            continue;
        };
        let stale = procs
            .get(&ppid)
            .is_some_and(|parent| p.start != 0 && parent.start != 0 && p.start < parent.start);
        if stale {
            dropped.push((p.pid, ppid));
        } else {
            children.entry(ppid).or_default().push(p.pid);
        }
    }
    let bytes_of = |tree: &[u32]| {
        tree.iter()
            .map(|p| procs.get(p).map_or(0, |p| p.bytes))
            .sum::<u64>()
    };
    let mut claimed = HashSet::new();
    // The app itself is never part of a session's tree.
    claimed.insert(app_pid);
    let mut sessions = Vec::with_capacity(roots.len());
    for (id, root) in roots {
        let tree: Vec<u32> = if procs.contains_key(root) && *root != app_pid {
            subtree(*root, &children, &mut claimed)
        } else {
            Vec::new()
        };
        sessions.push(SessionMemory {
            session_id: id.clone(),
            bytes: bytes_of(&tree),
            processes: tree.len() as u32,
        });
    }
    claimed.remove(&app_pid);
    let app_tree = subtree(app_pid, &children, &mut claimed);
    // `claimed` now holds every pid attributed to a session or the app.
    let disowned: Vec<u32> = dropped
        .iter()
        .filter(|(_, ppid)| claimed.contains(ppid))
        .map(|(pid, _)| *pid)
        .collect();
    FleetMemory {
        app_bytes: bytes_of(&app_tree),
        app_processes: app_tree.len() as u32,
        app_by_program: by_program(app_tree.iter(), &procs),
        disowned: by_program(disowned.iter(), &procs),
        sessions,
    }
}

/// The OS's process table as the walk needs it, read fresh (see the module
/// notes on why it is never kept between calls).
pub fn process_table() -> Vec<Proc> {
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_memory().without_tasks(),
    );
    sys.processes()
        .iter()
        .map(|(pid, p)| Proc {
            pid: pid.as_u32(),
            ppid: p.parent().map(|pp| pp.as_u32()),
            bytes: p.memory(),
            thread: p.thread_kind().is_some(),
            start: p.start_time(),
            name: p.name().to_string_lossy().into_owned(),
        })
        .collect()
}

/// Memory of every session's process tree and of Hermes itself.
#[tauri::command]
pub fn fleet_memory(state: State<'_, AppState>) -> Result<FleetMemory, String> {
    let roots: Vec<(String, u32)> = {
        let mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
        mgr.sessions
            .iter()
            .filter_map(|(id, s)| s.transport.pid().map(|pid| (id.clone(), pid)))
            .collect()
    };
    Ok(fleet_from(&process_table(), std::process::id(), &roots))
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
            start: 0,
            name: format!("prog{pid}"),
        }
    }

    fn named(name: &str, start: u64, proc_: Proc) -> Proc {
        Proc {
            name: name.into(),
            start,
            ..proc_
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
        assert!(fleet.disowned.is_empty());
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

    #[test]
    fn a_process_that_started_before_its_recorded_parent_is_a_stranger() {
        // Windows: a shell whose creator exited keeps the creator's pid as
        // its parent; Hermes was then started with that pid. The shell (and
        // the agent below it) must not count as Hermes's, nor as a session's.
        let procs = vec![
            named("hermes", 1000, p(100, 1, 200)),
            named("webview", 1000, p(101, 100, 300)),
            named("pwsh", 1001, p(200, 100, 90)), // a real session shell
            named("pwsh", 900, p(300, 100, 94)),  // started before Hermes: a stranger
            named("node", 901, p(301, 300, 50)),  // its child, also not ours
            named("pwsh", 950, p(400, 200, 94)), // claims the session shell as parent, but predates it
        ];
        let fleet = fleet_from(&procs, 100, &[("s1".into(), 200)]);
        assert_eq!(fleet.app_bytes, 500 * 1024 * 1024, "Hermes + web view only");
        assert_eq!(fleet.app_processes, 2);
        assert_eq!(
            (fleet.sessions[0].bytes, fleet.sessions[0].processes),
            (90 * 1024 * 1024, 1),
            "the session is its shell alone"
        );
        assert_eq!(
            fleet.disowned,
            vec![ProgramMemory {
                name: "pwsh".into(),
                processes: 2,
                bytes: 188 * 1024 * 1024
            }],
            "the strangers whose recorded parent is ours are reported, their own children are not"
        );
    }

    #[test]
    fn unknown_start_times_keep_the_parent_link() {
        // No start time from the OS (0): the recorded parent is trusted.
        let procs = vec![
            named("hermes", 1000, p(100, 1, 200)),
            named("conhost", 0, p(101, 100, 6)),
            named("pwsh", 1000, p(200, 100, 90)), // same second as Hermes: fine
        ];
        let fleet = fleet_from(&procs, 100, &[("s1".into(), 200)]);
        assert_eq!(fleet.app_bytes, 206 * 1024 * 1024);
        assert_eq!(fleet.sessions[0].processes, 1);
        assert!(fleet.disowned.is_empty());
    }

    #[test]
    fn the_app_breakdown_names_each_program_largest_first() {
        let procs = vec![
            named("hermes", 1, p(100, 1, 50)),
            named("webview", 1, p(101, 100, 160)),
            named("webview", 1, p(102, 100, 40)),
            named("conhost", 1, p(103, 100, 6)),
            named("pwsh", 1, p(200, 100, 90)),
        ];
        let fleet = fleet_from(&procs, 100, &[("s1".into(), 200)]);
        let names: Vec<(&str, u32, u64)> = fleet
            .app_by_program
            .iter()
            .map(|g| (g.name.as_str(), g.processes, g.bytes / (1024 * 1024)))
            .collect();
        assert_eq!(
            names,
            vec![("webview", 2, 200), ("hermes", 1, 50), ("conhost", 1, 6)]
        );
        assert_eq!(fleet.app_bytes, 256 * 1024 * 1024);
    }

    #[test]
    fn the_real_table_lists_this_process_with_its_start_time() {
        let started = std::time::Instant::now();
        let table = process_table();
        let took = started.elapsed();
        let me = table
            .iter()
            .find(|p| p.pid == std::process::id())
            .expect("this process is in the table");
        assert!(me.start > 0, "start time known");
        assert!(!me.name.is_empty());
        assert!(me.ppid.is_some());
        eprintln!("process table: {} processes in {:?}", table.len(), took);
        assert!(took.as_secs() < 5, "reading the table took {took:?}");
    }
}
