use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::process::Command;
use sysinfo::{Pid, ProcessStatus, System, Users};
use tauri::State;

use crate::AppState;

// ─── Data Models ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
    pub exe_path: String,
    pub cmd_line: Vec<String>,
    pub cpu_percent: f32,
    pub memory_bytes: u64,
    pub memory_percent: f32,
    pub threads: u32,
    pub user: String,
    pub status: String,
    pub start_time: u64,
    pub fd_count: Option<u32>,
    pub is_hermes_session: bool,
    pub is_zombie: bool,
    pub is_protected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessSnapshot {
    pub processes: Vec<ProcessInfo>,
    pub total_cpu_percent: f32,
    pub total_memory_bytes: u64,
    pub total_memory_available: u64,
    pub timestamp: u64,
}

// ─── Protected Processes ────────────────────────────────────────────

#[cfg(target_os = "macos")]
const PROTECTED_NAMES: &[&str] = &[
    "launchd",
    "kernel_task",
    "WindowServer",
    "loginwindow",
    "mds",
    "mds_stores",
    "fseventsd",
    "syslogd",
    "configd",
    "diskarbitrationd",
    "coreaudiod",
    "securityd",
    "opendirectoryd",
    "distnoted",
    "logd",
    "UserEventAgent",
    "SystemUIServer",
];

#[cfg(target_os = "linux")]
const PROTECTED_NAMES: &[&str] = &[
    "systemd",
    "init",
    "kthreadd",
    "kworker",
    "ksoftirqd",
    "rcu_sched",
    "rcu_bh",
    "migration",
    "watchdog",
    "dbus-daemon",
    "NetworkManager",
    "udevd",
    "journald",
    "logind",
];

#[cfg(target_os = "windows")]
const PROTECTED_NAMES: &[&str] = &[
    "System",
    "Registry",
    "smss.exe",
    "csrss.exe",
    "wininit.exe",
    "services.exe",
    "lsass.exe",
    "svchost.exe",
    "winlogon.exe",
    "dwm.exe",
    "explorer.exe",
    "fontdrvhost.exe",
];

fn is_protected(name: &str, pid: u32, uid: Option<u32>) -> bool {
    if PROTECTED_NAMES.contains(&name) {
        return true;
    }
    // UID 0 processes with PID < 200
    if pid < 200 && uid == Some(0) {
        return true;
    }
    false
}

// ─── Helpers ────────────────────────────────────────────────────────

fn status_string(status: ProcessStatus) -> String {
    match status {
        ProcessStatus::Run => "running".to_string(),
        ProcessStatus::Sleep => "sleeping".to_string(),
        ProcessStatus::Stop => "stopped".to_string(),
        ProcessStatus::Zombie => "zombie".to_string(),
        ProcessStatus::Dead => "dead".to_string(),
        _ => "unknown".to_string(),
    }
}

fn get_hermes_child_pids(sys: &System) -> HashSet<u32> {
    // Find our own process and collect all descendant PIDs
    let our_pid = std::process::id();
    let mut hermes_pids = HashSet::new();
    hermes_pids.insert(our_pid);

    // Walk through all processes, iteratively finding children
    let mut changed = true;
    while changed {
        changed = false;
        for (pid, process) in sys.processes() {
            let ppid = process.parent().map(|p| p.as_u32()).unwrap_or(0);
            let p = pid.as_u32();
            if hermes_pids.contains(&ppid) && !hermes_pids.contains(&p) {
                hermes_pids.insert(p);
                changed = true;
            }
        }
    }

    // Remove our own PID — we only want children
    hermes_pids.remove(&our_pid);
    hermes_pids
}

fn get_uid_for_process(process: &sysinfo::Process) -> Option<u32> {
    #[cfg(unix)]
    {
        process.user_id().map(|uid| **uid)
    }
    #[cfg(windows)]
    {
        let _ = process;
        None
    }
}

fn get_username_for_uid(users: &Users, process: &sysinfo::Process) -> String {
    if let Some(uid) = process.user_id() {
        for user in users.list() {
            if user.id() == uid {
                return user.name().to_string();
            }
        }
    }
    String::new()
}

fn get_fd_count(pid: u32) -> Option<u32> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("lsof")
            .args(["-p", &pid.to_string()])
            .output()
            .ok()?;
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let count = stdout.lines().count().saturating_sub(1);
            Some(count as u32)
        } else {
            None
        }
    }

    #[cfg(target_os = "linux")]
    {
        let fd_dir = format!("/proc/{}/fd", pid);
        match std::fs::read_dir(&fd_dir) {
            Ok(entries) => Some(entries.count() as u32),
            Err(_) => None,
        }
    }

    #[cfg(target_os = "windows")]
    {
        let _ = pid;
        None
    }
}

fn collect_descendants(sys: &System, root_pid: u32) -> Vec<u32> {
    let mut descendants = Vec::new();
    let mut visited = HashSet::new();
    visited.insert(root_pid);
    let mut stack = vec![root_pid];

    while let Some(parent) = stack.pop() {
        for (pid, process) in sys.processes() {
            let ppid = process.parent().map(|p| p.as_u32()).unwrap_or(0);
            let p = pid.as_u32();
            if ppid == parent && !visited.contains(&p) {
                visited.insert(p);
                descendants.push(p);
                stack.push(p);
            }
        }
    }

    descendants
}

// ─── Tauri Commands ─────────────────────────────────────────────────

#[tauri::command]
pub fn list_processes(state: State<'_, AppState>) -> Result<ProcessSnapshot, String> {
    let mut sys = state.sys.lock().map_err(|e| e.to_string())?;
    sys.refresh_all();

    let users = Users::new_with_refreshed_list();
    let hermes_pids = get_hermes_child_pids(&sys);
    let total_memory = sys.total_memory();

    let mut processes = Vec::new();
    let mut total_cpu: f32 = 0.0;
    let mut total_mem: u64 = 0;

    for (pid, process) in sys.processes() {
        let p = pid.as_u32();
        let name = process.name().to_string_lossy().to_string();
        let ppid = process.parent().map(|p| p.as_u32()).unwrap_or(0);
        let uid = get_uid_for_process(process);
        let memory_bytes = process.memory();
        let cpu_percent = process.cpu_usage();
        let memory_percent = if total_memory > 0 {
            (memory_bytes as f64 / total_memory as f64 * 100.0) as f32
        } else {
            0.0
        };
        let status = status_string(process.status());
        let is_zombie = status == "zombie";
        let protected = is_protected(&name, p, uid);

        total_cpu += cpu_percent;
        total_mem += memory_bytes;

        processes.push(ProcessInfo {
            pid: p,
            ppid,
            name,
            exe_path: process
                .exe()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default(),
            cmd_line: process
                .cmd()
                .iter()
                .map(|s| s.to_string_lossy().to_string())
                .collect(),
            cpu_percent,
            memory_bytes,
            memory_percent,
            threads: process.tasks().map(|t| t.len() as u32).unwrap_or(0),
            user: get_username_for_uid(&users, process),
            status,
            start_time: process.start_time(),
            fd_count: None,
            is_hermes_session: hermes_pids.contains(&p),
            is_zombie,
            is_protected: protected,
        });
    }

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    Ok(ProcessSnapshot {
        processes,
        total_cpu_percent: total_cpu,
        total_memory_bytes: total_mem,
        total_memory_available: total_memory,
        timestamp,
    })
}

#[tauri::command]
pub fn kill_process(state: State<'_, AppState>, pid: u32, signal: String) -> Result<(), String> {
    // Safety: check if protected
    let sys = state.sys.lock().map_err(|e| e.to_string())?;

    if let Some(process) = sys.process(Pid::from_u32(pid)) {
        let name = process.name().to_string_lossy().to_string();
        let uid = get_uid_for_process(process);
        if is_protected(&name, pid, uid) {
            return Err(format!(
                "Cannot kill protected process: {} (PID {})",
                name, pid
            ));
        }
    }
    drop(sys);

    #[cfg(unix)]
    {
        let sig = match signal.as_str() {
            "SIGTERM" => "TERM",
            "SIGKILL" => "KILL",
            _ => return Err(format!("Unsupported signal: {}", signal)),
        };

        let output = Command::new("kill")
            .args([&format!("-{}", sig), &pid.to_string()])
            .output()
            .map_err(|e| format!("Failed to execute kill: {}", e))?;

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("kill failed: {}", stderr.trim()))
        }
    }

    #[cfg(windows)]
    {
        let _ = signal;
        let output = Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .output()
            .map_err(|e| format!("Failed to execute taskkill: {}", e))?;

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("taskkill failed: {}", stderr.trim()))
        }
    }
}

#[tauri::command]
pub fn kill_process_tree(
    state: State<'_, AppState>,
    pid: u32,
    signal: String,
) -> Result<(), String> {
    let sys = state.sys.lock().map_err(|e| e.to_string())?;

    // Check if root is protected
    if let Some(process) = sys.process(Pid::from_u32(pid)) {
        let name = process.name().to_string_lossy().to_string();
        let uid = get_uid_for_process(process);
        if is_protected(&name, pid, uid) {
            return Err(format!(
                "Cannot kill protected process tree: {} (PID {})",
                name, pid
            ));
        }
    }

    #[cfg(unix)]
    {
        // Collect descendants (leaf-first order by reversing)
        let mut descendants = collect_descendants(&sys, pid);
        descendants.reverse(); // Kill leaves first
        drop(sys);

        let sig = match signal.as_str() {
            "SIGTERM" => "TERM",
            "SIGKILL" => "KILL",
            _ => return Err(format!("Unsupported signal: {}", signal)),
        };

        // Kill children first, then parent
        let mut errors = Vec::new();
        for child_pid in &descendants {
            let output = Command::new("kill")
                .args([&format!("-{}", sig), &child_pid.to_string()])
                .output();
            if let Ok(out) = output {
                if !out.status.success() {
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    errors.push(format!("PID {}: {}", child_pid, stderr.trim()));
                }
            }
        }

        // Kill parent
        let output = Command::new("kill")
            .args([&format!("-{}", sig), &pid.to_string()])
            .output()
            .map_err(|e| format!("Failed to kill parent PID {}: {}", pid, e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            errors.push(format!("PID {}: {}", pid, stderr.trim()));
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(format!("Some kills failed: {}", errors.join("; ")))
        }
    }

    #[cfg(windows)]
    {
        let _ = signal;
        drop(sys);
        let output = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .output()
            .map_err(|e| format!("Failed to execute taskkill: {}", e))?;

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("taskkill failed: {}", stderr.trim()))
        }
    }
}

#[tauri::command]
pub fn get_process_detail(state: State<'_, AppState>, pid: u32) -> Result<ProcessInfo, String> {
    let mut sys = state.sys.lock().map_err(|e| e.to_string())?;
    sys.refresh_all();

    let users = Users::new_with_refreshed_list();
    let hermes_pids = get_hermes_child_pids(&sys);
    let total_memory = sys.total_memory();

    let process = sys
        .process(Pid::from_u32(pid))
        .ok_or_else(|| format!("Process {} not found", pid))?;

    let name = process.name().to_string_lossy().to_string();
    let ppid = process.parent().map(|p| p.as_u32()).unwrap_or(0);
    let uid = get_uid_for_process(process);
    let memory_bytes = process.memory();
    let memory_percent = if total_memory > 0 {
        (memory_bytes as f64 / total_memory as f64 * 100.0) as f32
    } else {
        0.0
    };
    let status = status_string(process.status());
    let is_zombie = status == "zombie";
    let protected = is_protected(&name, pid, uid);

    Ok(ProcessInfo {
        pid,
        ppid,
        name,
        exe_path: process
            .exe()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        cmd_line: process
            .cmd()
            .iter()
            .map(|s| s.to_string_lossy().to_string())
            .collect(),
        cpu_percent: process.cpu_usage(),
        memory_bytes,
        memory_percent,
        threads: process.tasks().map(|t| t.len() as u32).unwrap_or(0),
        user: get_username_for_uid(&users, process),
        status,
        start_time: process.start_time(),
        fd_count: get_fd_count(pid),
        is_hermes_session: hermes_pids.contains(&pid),
        is_zombie,
        is_protected: protected,
    })
}

#[tauri::command]
pub fn reveal_process_in_finder(path: String) -> Result<(), String> {
    crate::platform::reveal_in_file_manager(&path)
}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "macos")]
    fn protected_by_name_macos() {
        assert!(is_protected("launchd", 500, Some(501)));
        assert!(is_protected("kernel_task", 500, Some(501)));
        assert!(is_protected("WindowServer", 500, Some(501)));
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn protected_by_name_linux() {
        assert!(is_protected("systemd", 500, Some(501)));
        assert!(is_protected("kthreadd", 500, Some(501)));
        assert!(is_protected("journald", 500, Some(501)));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn protected_by_name_windows() {
        assert!(is_protected("csrss.exe", 500, None));
        assert!(is_protected("lsass.exe", 500, None));
        assert!(is_protected("svchost.exe", 500, None));
    }

    #[test]
    fn protected_by_low_pid_root() {
        assert!(is_protected("some-daemon", 1, Some(0)));
        assert!(is_protected("other-daemon", 100, Some(0)));
        assert!(is_protected("init-thing", 199, Some(0)));
    }

    #[test]
    fn not_protected_regular_process() {
        assert!(!is_protected("my-app", 50000, Some(501)));
        assert!(!is_protected("node", 1234, Some(501)));
        assert!(!is_protected("some-daemon", 200, Some(0)));
    }

    #[test]
    fn process_info_serializes() {
        let info = ProcessInfo {
            pid: 123,
            ppid: 1,
            name: "test".to_string(),
            exe_path: "/usr/bin/test".to_string(),
            cmd_line: vec!["test".to_string(), "--flag".to_string()],
            cpu_percent: 5.5,
            memory_bytes: 1024,
            memory_percent: 0.1,
            threads: 2,
            user: "root".to_string(),
            status: "running".to_string(),
            start_time: 1000000,
            fd_count: Some(10),
            is_hermes_session: false,
            is_zombie: false,
            is_protected: false,
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["pid"], 123);
        assert_eq!(json["name"], "test");
        assert_eq!(json["cpu_percent"], 5.5);
        assert_eq!(json["fd_count"], 10);
        assert_eq!(json["is_protected"], false);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn protected_process_names_are_complete_macos() {
        for name in &[
            "launchd",
            "kernel_task",
            "WindowServer",
            "loginwindow",
            "mds",
            "coreaudiod",
            "securityd",
        ] {
            assert!(
                is_protected(name, 500, Some(501)),
                "{} should be protected",
                name
            );
        }
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn protected_process_names_are_complete_linux() {
        for name in &["systemd", "init", "kthreadd", "dbus-daemon", "journald"] {
            assert!(
                is_protected(name, 500, Some(501)),
                "{} should be protected",
                name
            );
        }
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn protected_process_names_are_complete_windows() {
        for name in &[
            "csrss.exe",
            "lsass.exe",
            "svchost.exe",
            "winlogon.exe",
            "dwm.exe",
        ] {
            assert!(
                is_protected(name, 500, None),
                "{} should be protected",
                name
            );
        }
    }
}
