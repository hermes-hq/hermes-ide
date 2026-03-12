use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex as StdMutex};
use std::thread;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::db::ExecutionNode;
use crate::pty::adapters::now;
use crate::pty::analyzer::{CommandPredictionEvent, OutputAnalyzer};
use crate::pty::models::*;
use crate::pty::{ai_launch_command, detect_shell, get_working_directory, PtySession};
use crate::AppState;

// ─── SSH / tmux helpers ─────────────────────────────────────────────

fn resolve_ssh_user(user: Option<String>) -> String {
    user.unwrap_or_else(|| {
        std::env::var("USER")
            .or_else(|_| std::env::var("USERNAME"))
            .unwrap_or_else(|_| "root".to_string())
    })
}

/// Directory for SSH ControlMaster sockets.
fn ssh_control_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join("hermes-ssh-mux");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Build a base SSH command with common options and connection multiplexing.
fn ssh_command(user: &str, host: &str, port: u16) -> std::process::Command {
    let mut cmd = std::process::Command::new("ssh");
    cmd.arg("-o").arg("ConnectTimeout=5");
    cmd.arg("-o").arg("BatchMode=yes");
    // Reuse existing TCP connection if available, or establish a new persistent one
    let socket_path = ssh_control_dir().join(format!("{}@{}:{}", user, host, port));
    cmd.arg("-o")
        .arg(format!("ControlPath={}", socket_path.display()));
    cmd.arg("-o").arg("ControlMaster=auto");
    cmd.arg("-o").arg("ControlPersist=300");
    if port != 22 {
        cmd.arg("-p").arg(port.to_string());
    }
    cmd.arg(format!("{}@{}", user, host));
    cmd
}

/// Run a remote SSH command and return (stdout, stderr, success).
fn ssh_exec(
    user: &str,
    host: &str,
    port: u16,
    remote_cmd: &str,
) -> Result<(String, String, bool), String> {
    let mut cmd = ssh_command(user, host, port);
    cmd.arg(remote_cmd);
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run ssh: {}", e))?;
    Ok((
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
        output.status.success(),
    ))
}

// ─── SSH File Types ─────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct SshFileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_hidden: bool,
    pub size: Option<u64>,
}

#[derive(serde::Serialize)]
pub struct SshFileContent {
    pub content: String,
    pub file_name: String,
    pub language: String,
    pub is_binary: bool,
    pub size: u64,
}

// ─── Tauri Commands ─────────────────────────────────────────────────

#[tauri::command]
pub async fn ssh_list_directory(
    state: State<'_, AppState>,
    session_id: String,
    path: Option<String>,
) -> Result<Vec<SshFileEntry>, String> {
    // Look up SSH connection info from the session
    let (user, host, port) = {
        let mgr = state
            .pty_manager
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        let pty_session = mgr
            .sessions
            .get(&session_id)
            .ok_or_else(|| "Session not found".to_string())?;
        let session = pty_session
            .session
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        let ssh = session
            .ssh_info
            .as_ref()
            .ok_or_else(|| "Not an SSH session".to_string())?;
        (ssh.user.clone(), ssh.host.clone(), ssh.port)
    };

    // Use the given path, or detect the remote working directory via pwd
    let target = match &path {
        Some(p) if !p.is_empty() => p.clone(),
        _ => {
            // Ask the remote host for its home directory (session.working_directory is local)
            let (pwd_out, _, ok) = ssh_exec(&user, &host, port, "echo $HOME")?;
            if ok && !pwd_out.trim().is_empty() {
                pwd_out.trim().to_string()
            } else {
                "/".to_string()
            }
        }
    };

    // Run ls with machine-readable output (portable: no GNU-only flags)
    // -1: one entry per line, -a: show hidden, -p: append / to dirs
    // For sizes: try GNU stat (-c) first, fall back to BSD/macOS stat (-f)
    let remote_cmd = format!(
        "ls -1ap {} 2>/dev/null && echo '---SIZES---' && (stat -c '%s %n' {}/* {}/.* 2>/dev/null || stat -f '%z %N' {}/* {}/.* 2>/dev/null)",
        shell_escape(&target), shell_escape(&target), shell_escape(&target), shell_escape(&target), shell_escape(&target)
    );

    let (stdout, _stderr, success) = ssh_exec(&user, &host, port, &remote_cmd)?;
    if !success && stdout.is_empty() {
        return Err(format!("Failed to list directory: {}", target));
    }

    let parts: Vec<&str> = stdout.splitn(2, "---SIZES---").collect();
    let ls_output = parts.first().unwrap_or(&"");
    let sizes_output = parts.get(1).unwrap_or(&"");

    // Parse sizes into a map
    let mut size_map: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
    for line in sizes_output.lines() {
        let line = line.trim();
        if let Some(space_idx) = line.find(' ') {
            if let Ok(size) = line[..space_idx].parse::<u64>() {
                let name = &line[space_idx + 1..];
                // Extract just the filename from the full path
                if let Some(basename) = name.rsplit('/').next() {
                    size_map.insert(basename.to_string(), size);
                }
            }
        }
    }

    let mut entries = Vec::new();
    for line in ls_output.lines() {
        let line = line.trim();
        if line.is_empty() || line == "." || line == ".." || line == "./" || line == "../" {
            continue;
        }

        let is_dir = line.ends_with('/');
        let name = if is_dir {
            &line[..line.len() - 1]
        } else {
            line
        };
        let is_hidden = name.starts_with('.');

        let full_path = if target.ends_with('/') {
            format!("{}{}", target, name)
        } else {
            format!("{}/{}", target, name)
        };

        let size = if is_dir {
            None
        } else {
            size_map.get(name).copied()
        };

        entries.push(SshFileEntry {
            name: name.to_string(),
            path: full_path,
            is_dir,
            is_hidden,
            size,
        });
    }

    // Sort directories first, then alphabetically
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
pub async fn ssh_read_file(
    state: State<'_, AppState>,
    session_id: String,
    file_path: String,
) -> Result<SshFileContent, String> {
    let (user, host, port) = {
        let mgr = state
            .pty_manager
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        let pty_session = mgr
            .sessions
            .get(&session_id)
            .ok_or_else(|| "Session not found".to_string())?;
        let session = pty_session
            .session
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        let ssh = session
            .ssh_info
            .as_ref()
            .ok_or_else(|| "Not an SSH session".to_string())?;
        (ssh.user.clone(), ssh.host.clone(), ssh.port)
    };

    let file_name = file_path
        .rsplit('/')
        .next()
        .unwrap_or(&file_path)
        .to_string();
    let extension = file_name.rsplit('.').next().unwrap_or("").to_lowercase();

    let language = match extension.as_str() {
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "py" => "python",
        "rb" => "ruby",
        "go" => "go",
        "java" => "java",
        "c" | "h" => "c",
        "cpp" | "hpp" | "cc" | "cxx" => "cpp",
        "cs" => "csharp",
        "swift" => "swift",
        "kt" | "kts" => "kotlin",
        "html" | "htm" => "html",
        "css" | "scss" | "sass" | "less" => "css",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "xml" | "svg" => "xml",
        "sql" => "sql",
        "sh" | "bash" | "zsh" => "bash",
        "md" | "markdown" => "markdown",
        "dockerfile" => "dockerfile",
        "dart" => "dart",
        "lua" => "lua",
        "php" => "php",
        "ex" | "exs" => "elixir",
        _ => "plaintext",
    }
    .to_string();

    // Single SSH call: get size, binary check, and content in one round-trip
    let escaped = shell_escape(&file_path);
    let combined_cmd = format!(
        concat!(
            "SIZE=$(stat -c '%s' {f} 2>/dev/null || stat -f '%z' {f} 2>/dev/null); ",
            "echo \"SIZE:$SIZE\"; ",
            "if [ \"$SIZE\" -gt 1048576 ] 2>/dev/null; then echo 'TOO_LARGE'; exit 0; fi; ",
            "ORIG=$(head -c 8192 {f} | wc -c | tr -d ' '); ",
            "CLEAN=$(head -c 8192 {f} | tr -d '\\0' | wc -c | tr -d ' '); ",
            "if [ \"$ORIG\" -gt 0 ] && [ \"$CLEAN\" -lt \"$ORIG\" ]; then echo 'BINARY'; exit 0; fi; ",
            "echo '---CONTENT---'; cat {f}",
        ),
        f = escaped,
    );
    let (stdout, _, success) = ssh_exec(&user, &host, port, &combined_cmd)?;
    if !success && stdout.is_empty() {
        return Err(format!("Failed to read file: {}", file_path));
    }

    // Parse size from first line
    let mut size: u64 = 0;
    let mut rest = stdout.as_str();
    if let Some(size_line) = rest.lines().next() {
        if let Some(s) = size_line.strip_prefix("SIZE:") {
            size = s.trim().parse().unwrap_or(0);
        }
        // Advance past first line
        if let Some(idx) = rest.find('\n') {
            rest = &rest[idx + 1..];
        }
    }

    // Check for too-large or binary markers
    let first_remaining = rest.lines().next().unwrap_or("");
    if first_remaining.trim() == "TOO_LARGE" {
        return Ok(SshFileContent {
            content: String::new(),
            file_name,
            language,
            is_binary: false,
            size,
        });
    }
    if first_remaining.trim() == "BINARY" {
        return Ok(SshFileContent {
            content: String::new(),
            file_name,
            language,
            is_binary: true,
            size,
        });
    }

    // Extract content after the marker
    let content = if let Some(idx) = rest.find("---CONTENT---\n") {
        rest[idx + "---CONTENT---\n".len()..].to_string()
    } else if let Some(idx) = rest.find("---CONTENT---") {
        rest[idx + "---CONTENT---".len()..]
            .trim_start_matches('\n')
            .to_string()
    } else {
        rest.to_string()
    };

    Ok(SshFileContent {
        content,
        file_name,
        language,
        is_binary: false,
        size,
    })
}

/// Escape a string for use in a remote shell command (single-quote wrapping).
fn shell_escape(s: &str) -> String {
    // Replace single quotes with '\'' and wrap in single quotes
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[tauri::command]
pub async fn ssh_list_tmux_sessions(
    host: String,
    port: Option<u16>,
    user: Option<String>,
) -> Result<Vec<TmuxSessionEntry>, String> {
    let user = resolve_ssh_user(user);
    let port = port.unwrap_or(22);

    let (stdout, stderr, success) = ssh_exec(
        &user,
        &host,
        port,
        "tmux list-sessions -F '#{session_name}|||#{session_windows}|||#{session_attached}'",
    )?;

    if !success {
        if stderr.contains("no server running") || stderr.contains("no sessions") {
            return Ok(Vec::new());
        }
        if stderr.contains("not found") || stderr.contains("No such file") {
            return Err("tmux is not installed on the remote host".to_string());
        }
        return Err(format!("Failed to list tmux sessions: {}", stderr.trim()));
    }

    let entries: Vec<TmuxSessionEntry> = stdout
        .lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let line = line.trim().trim_matches('\'');
            let parts: Vec<&str> = line.split("|||").collect();
            if parts.len() >= 3 {
                Some(TmuxSessionEntry {
                    name: parts[0].to_string(),
                    windows: parts[1].parse().unwrap_or(0),
                    attached: parts[2] == "1",
                })
            } else {
                None
            }
        })
        .collect();

    Ok(entries)
}

#[tauri::command]
pub async fn ssh_list_tmux_windows(
    host: String,
    port: Option<u16>,
    user: Option<String>,
    tmux_session: String,
) -> Result<Vec<TmuxWindowEntry>, String> {
    let user = resolve_ssh_user(user);
    let port = port.unwrap_or(22);

    let remote_cmd = format!(
        "tmux list-windows -t '{}' -F '#{{window_index}}|||#{{window_name}}|||#{{window_active}}'",
        tmux_session.replace('\'', "'\\''")
    );
    let (stdout, stderr, success) = ssh_exec(&user, &host, port, &remote_cmd)?;

    if !success {
        return Err(format!("Failed to list tmux windows: {}", stderr.trim()));
    }

    let entries: Vec<TmuxWindowEntry> = stdout
        .lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let line = line.trim().trim_matches('\'');
            let parts: Vec<&str> = line.split("|||").collect();
            if parts.len() >= 3 {
                Some(TmuxWindowEntry {
                    index: parts[0].parse().unwrap_or(0),
                    name: parts[1].to_string(),
                    active: parts[2] == "1",
                })
            } else {
                None
            }
        })
        .collect();

    Ok(entries)
}

#[tauri::command]
pub async fn ssh_tmux_select_window(
    host: String,
    port: Option<u16>,
    user: Option<String>,
    tmux_session: String,
    window_index: u32,
) -> Result<(), String> {
    let user = resolve_ssh_user(user);
    let port = port.unwrap_or(22);

    let remote_cmd = format!(
        "tmux select-window -t '{}:{}'",
        tmux_session.replace('\'', "'\\''"),
        window_index
    );
    let (_stdout, stderr, success) = ssh_exec(&user, &host, port, &remote_cmd)?;

    if !success {
        return Err(format!("Failed to select tmux window: {}", stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_tmux_new_window(
    host: String,
    port: Option<u16>,
    user: Option<String>,
    tmux_session: String,
    window_name: Option<String>,
) -> Result<(), String> {
    let user = resolve_ssh_user(user);
    let port = port.unwrap_or(22);

    let remote_cmd = if let Some(name) = window_name {
        format!(
            "tmux new-window -t '{}' -n '{}'",
            tmux_session.replace('\'', "'\\''"),
            name.replace('\'', "'\\''")
        )
    } else {
        format!(
            "tmux new-window -t '{}'",
            tmux_session.replace('\'', "'\\''")
        )
    };
    let (_stdout, stderr, success) = ssh_exec(&user, &host, port, &remote_cmd)?;

    if !success {
        return Err(format!("Failed to create tmux window: {}", stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_tmux_rename_window(
    host: String,
    port: Option<u16>,
    user: Option<String>,
    tmux_session: String,
    window_index: u32,
    new_name: String,
) -> Result<(), String> {
    let user = resolve_ssh_user(user);
    let port = port.unwrap_or(22);

    let remote_cmd = format!(
        "tmux rename-window -t '{}:{}' '{}'",
        tmux_session.replace('\'', "'\\''"),
        window_index,
        new_name.replace('\'', "'\\''")
    );
    let (_stdout, stderr, success) = ssh_exec(&user, &host, port, &remote_cmd)?;

    if !success {
        return Err(format!("Failed to rename tmux window: {}", stderr.trim()));
    }
    Ok(())
}

// Tauri command handler — params come from frontend invocation
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn create_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: Option<String>,
    label: Option<String>,
    working_directory: Option<String>,
    color: Option<String>,
    workspace_paths: Option<Vec<String>>,
    ai_provider: Option<String>,
    realm_ids: Option<Vec<String>>,
    auto_approve: Option<bool>,
    ssh_host: Option<String>,
    ssh_port: Option<u16>,
    ssh_user: Option<String>,
    tmux_session: Option<String>,
    initial_rows: Option<u16>,
    initial_cols: Option<u16>,
) -> Result<SessionUpdate, String> {
    let session_id = session_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let shell = state
        .db
        .lock()
        .map_err(|e| e.to_string())
        .and_then(|db| db.get_setting("default_shell"))
        .ok()
        .flatten()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(detect_shell);
    let original_cwd = working_directory.unwrap_or_else(get_working_directory);

    // If this session has a linked worktree, use its path as the working directory.
    // The worktree row may have been inserted before create_session is called
    // (e.g. the frontend pre-generated the session_id and created the worktree first).
    let cwd = if let Ok(db) = state.db.lock() {
        if let Ok(worktrees) = db.get_session_worktrees(&session_id) {
            if let Some(primary) = worktrees.first() {
                let wt = std::path::Path::new(&primary.worktree_path);
                if wt.is_dir() {
                    primary.worktree_path.clone()
                } else {
                    log::warn!(
                        "Worktree directory '{}' does not exist for session {}; falling back to '{}'",
                        primary.worktree_path, session_id, original_cwd
                    );
                    original_cwd
                }
            } else {
                original_cwd
            }
        } else {
            original_cwd
        }
    } else {
        original_cwd
    };

    let mut mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    mgr.session_counter += 1;
    let counter = mgr.session_counter;

    let session_label = label.unwrap_or_else(|| format!("Session {}", counter));
    let session_color = color.unwrap_or_default();
    let now_str = now();

    let session = Session {
        id: session_id.clone(),
        label: session_label,
        description: String::new(),
        color: session_color,
        group: None,
        phase: SessionPhase::Creating,
        working_directory: cwd.clone(),
        shell: shell.clone(),
        created_at: now_str.clone(),
        last_activity_at: now_str,
        workspace_paths: workspace_paths.unwrap_or_default(),
        detected_agent: None,
        metrics: SessionMetrics {
            output_lines: 0,
            error_count: 0,
            stuck_score: 0.0,
            token_usage: HashMap::new(),
            tool_calls: Vec::new(),
            tool_call_summary: HashMap::new(),
            files_touched: Vec::new(),
            recent_errors: Vec::new(),
            recent_actions: Vec::new(),
            available_actions: Vec::new(),
            memory_facts: Vec::new(),
            latency_p50_ms: None,
            latency_p95_ms: None,
            latency_samples: Vec::new(),
            token_history: Vec::new(),
        },
        ai_provider: ai_provider.clone(),
        auto_approve: auto_approve.unwrap_or(false),
        context_injected: false,
        has_initial_context: ssh_host.is_none()
            && realm_ids.as_ref().is_some_and(|ids| !ids.is_empty()),
        last_nudged_version: 0,
        pending_nudge: None,
        ssh_info: ssh_host.as_ref().map(|host| SshConnectionInfo {
            host: host.clone(),
            port: ssh_port.unwrap_or(22),
            user: ssh_user.unwrap_or_else(|| {
                std::env::var("USER")
                    .or_else(|_| std::env::var("USERNAME"))
                    .unwrap_or_else(|_| "root".to_string())
            }),
            tmux_session: tmux_session.clone(),
        }),
    };

    let update = SessionUpdate::from(&session);
    let _ = app.emit("session-updated", &update);

    let ssh_info_clone = session.ssh_info.clone();
    let session_arc = Arc::new(StdMutex::new(session));

    // Spawn PTY
    // Use dimensions from the frontend if provided; otherwise fall back to 80x24.
    // Passing the real terminal size at PTY creation prevents the SIGWINCH race
    // condition where the shell starts at 80x24 and misses the initial resize
    // because its signal handler isn't installed yet.
    let pty_rows = initial_rows.unwrap_or(24);
    let pty_cols = initial_cols.unwrap_or(80);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: pty_rows,
            cols: pty_cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let is_ssh = ssh_info_clone.is_some();

    let mut cmd = if let Some(ref info) = ssh_info_clone {
        let mut c = CommandBuilder::new("ssh");
        c.arg("-t"); // Force TTY allocation
        if info.port != 22 {
            c.arg("-p");
            c.arg(info.port.to_string());
        }
        c.arg(format!("{}@{}", info.user, info.host));
        // Attach to tmux session if specified.
        // `new-session -A` attaches if it exists, creates if it doesn't.
        if let Some(ref tmux_name) = info.tmux_session {
            c.arg(format!(
                "tmux new-session -A -s '{}'",
                tmux_name.replace('\'', "'\\''")
            ));
        }
        c
    } else {
        #[cfg(unix)]
        {
            let mut c = CommandBuilder::new("env");
            c.arg("-u");
            c.arg("CLAUDECODE");
            c.arg("-u");
            c.arg("CLAUDE_CODE");
            c.arg(&shell);
            c.arg("-l");
            c
        }
        #[cfg(windows)]
        {
            let mut c = CommandBuilder::new(&shell);
            c.env_remove("CLAUDECODE");
            c.env_remove("CLAUDE_CODE");
            c
        }
    };

    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "HERMES-IDE");

    // Ensure UTF-8 locale so shells (especially old macOS bash 3.2) treat
    // multi-byte characters correctly.  Without this, readline interprets
    // UTF-8 bytes like 0xC3 0xA3 (ã) as two meta-key sequences (Meta-C +
    // Meta-#) instead of a single Unicode character.  macOS GUI apps don't
    // inherit terminal locale vars, so we must set them explicitly.
    if std::env::var("LANG").unwrap_or_default().is_empty() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    if std::env::var("LC_CTYPE").unwrap_or_default().is_empty() {
        cmd.env("LC_CTYPE", "UTF-8");
    }

    // Suppress zsh's PROMPT_SP indicator (the inverse `%` shown when the
    // previous output didn't end with a newline).  On a fresh PTY there is
    // no prior output, so the marker is always spurious.
    cmd.env("PROMPT_EOL_MARK", "");

    // Set context file env vars for local sessions only (not useful over SSH)
    if !is_ssh {
        if let Ok(context_path) = crate::realm::attunement::session_context_path(&app, &session_id)
        {
            cmd.env("HERMES_CONTEXT", context_path.to_string_lossy().as_ref());
        }
        cmd.env("HERMES_SESSION_ID", &session_id);
    }

    // On macOS, portable-pty's spawn_command() uses fork() + pre_exec which
    // crashes in multi-threaded processes ("multi-threaded process forked").
    // Use posix_spawn() instead which atomically creates the child process.
    // See issue #31 and issue-31-investigation.md.
    // Save the slave TTY path before spawning — needed later for direct
    // SIGINT delivery via tcgetpgrp()/kill() when the line discipline
    // fails to convert \x03 into a signal.
    #[cfg(unix)]
    let saved_tty_path = pair.master.tty_name();

    #[cfg(target_os = "macos")]
    let child = {
        let tty_path = saved_tty_path
            .clone()
            .ok_or_else(|| "Failed to get PTY device path for posix_spawn".to_string())?;
        // Drop the slave end — the child opens the TTY by path via posix_spawn
        // file actions, which also establishes it as the controlling terminal.
        drop(pair.slave);
        crate::pty::spawn::posix_spawn_in_pty(&cmd, &tty_path)
            .map_err(|e| format!("Failed to spawn shell: {}", e))?
    };

    #[cfg(not(target_os = "macos"))]
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;

    let writer = Arc::new(StdMutex::new(
        pair.master
            .take_writer()
            .map_err(|e| format!("Failed to get PTY writer: {}", e))?,
    ));
    let writer_for_reader = Arc::clone(&writer);

    // Transition to Initializing
    {
        let mut s = session_arc
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        s.phase = SessionPhase::Initializing;
        let update = SessionUpdate::from(&*s);
        let _ = app.emit("session-updated", &update);
    }

    let analyzer = Arc::new(StdMutex::new(OutputAnalyzer::new()));
    let analyzer_clone = Arc::clone(&analyzer);
    let session_clone = Arc::clone(&session_arc);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone reader: {}", e))?;
    let event_session_id = session_id.clone();
    let app_clone = app.clone();

    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut chunk_count: u64 = 0;

        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    if let Ok(mut s) = session_clone.lock() {
                        s.phase = SessionPhase::Destroyed;
                        let update = SessionUpdate::from(&*s);
                        let _ = app_clone.emit("session-updated", &update);
                    }
                    let _ = app_clone.emit(&format!("pty-exit-{}", event_session_id), ());
                    break;
                }
                Ok(n) => {
                    let data = &buf[..n];
                    chunk_count += 1;

                    if let Ok(mut a) = analyzer_clone.lock() {
                        a.process(data);

                        // Check for CWD change
                        if let Some(new_cwd) = a.take_pending_cwd() {
                            if let Ok(mut s) = session_clone.lock() {
                                s.working_directory = new_cwd.clone();
                            }
                            let _ = app_clone
                                .emit(&format!("cwd-changed-{}", event_session_id), &new_cwd);
                        }

                        // Drain completed nodes → insert into DB + emit events
                        let completed = a.drain_completed_nodes();

                        if !completed.is_empty() {
                            if let Ok(db) = app_clone.state::<AppState>().db.lock() {
                                for node in &completed {
                                    let node_id = db
                                        .insert_execution_node(
                                            &event_session_id,
                                            node.timestamp,
                                            &node.kind,
                                            node.input.as_deref(),
                                            node.output_summary.as_deref(),
                                            node.exit_code,
                                            &node.working_dir,
                                            node.duration_ms,
                                            None,
                                        )
                                        .ok();

                                    // Emit execution-node event
                                    if let Some(id) = node_id {
                                        let exec_node = ExecutionNode {
                                            id,
                                            session_id: event_session_id.clone(),
                                            timestamp: node.timestamp,
                                            kind: node.kind.clone(),
                                            input: node.input.clone(),
                                            output_summary: node.output_summary.clone(),
                                            exit_code: node.exit_code,
                                            working_dir: node.working_dir.clone(),
                                            duration_ms: node.duration_ms,
                                            metadata: None,
                                        };
                                        let _ = app_clone.emit(
                                            &format!("execution-node-{}", event_session_id),
                                            &exec_node,
                                        );
                                    }

                                    let project_id: Option<String> = Some(node.working_dir.clone());

                                    // Command sequence tracking — push FIRST then record
                                    if node.kind == "command" {
                                        if let Some(ref input) = node.input {
                                            let normalized = input
                                                .trim()
                                                .trim_start_matches('$')
                                                .trim()
                                                .to_string();
                                            if !normalized.is_empty() {
                                                // Push to recent_commands first
                                                a.recent_commands.push_back(normalized.clone());
                                                if a.recent_commands.len() > 5 {
                                                    a.recent_commands.pop_front();
                                                }

                                                // Now record sequences using the updated list
                                                let cmds: Vec<String> =
                                                    a.recent_commands.iter().cloned().collect();
                                                if cmds.len() >= 2 {
                                                    let prev: Vec<&str> = cmds[..cmds.len() - 1]
                                                        .iter()
                                                        .rev()
                                                        .take(2)
                                                        .map(|s| s.as_str())
                                                        .collect::<Vec<_>>()
                                                        .into_iter()
                                                        .rev()
                                                        .collect();
                                                    let seq_json = serde_json::to_string(&prev)
                                                        .unwrap_or_default();
                                                    db.record_command_sequence(
                                                        project_id.as_deref(),
                                                        &seq_json,
                                                        &normalized,
                                                    )
                                                    .ok();
                                                }
                                                if cmds.len() >= 3 {
                                                    let prev: Vec<&str> = cmds[..cmds.len() - 1]
                                                        .iter()
                                                        .rev()
                                                        .take(3)
                                                        .map(|s| s.as_str())
                                                        .collect::<Vec<_>>()
                                                        .into_iter()
                                                        .rev()
                                                        .collect();
                                                    let seq_json = serde_json::to_string(&prev)
                                                        .unwrap_or_default();
                                                    db.record_command_sequence(
                                                        project_id.as_deref(),
                                                        &seq_json,
                                                        &normalized,
                                                    )
                                                    .ok();
                                                }

                                                // Query predictions and emit
                                                let seq: Vec<&str> = cmds
                                                    .iter()
                                                    .rev()
                                                    .take(2)
                                                    .collect::<Vec<_>>()
                                                    .into_iter()
                                                    .rev()
                                                    .map(|s| s.as_str())
                                                    .collect();
                                                let seq_json =
                                                    serde_json::to_string(&seq).unwrap_or_default();
                                                if let Ok(predictions) = db.predict_next_command(
                                                    project_id.as_deref(),
                                                    &seq_json,
                                                    3,
                                                ) {
                                                    if !predictions.is_empty() {
                                                        let evt =
                                                            CommandPredictionEvent { predictions };
                                                        let _ = app_clone.emit(
                                                            &format!(
                                                                "command-prediction-{}",
                                                                event_session_id
                                                            ),
                                                            &evt,
                                                        );
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        if let Some(new_phase) = a.take_pending_phase() {
                            if let Ok(mut s) = session_clone.lock() {
                                if s.phase != new_phase {
                                    s.phase = new_phase.clone();
                                    s.last_activity_at = now();
                                    s.detected_agent = a.detected_agent.clone();
                                    s.metrics = a.to_metrics();
                                    let update = SessionUpdate::from(&*s);
                                    let _ = app_clone.emit("session-updated", &update);

                                    // Deliver any deferred context nudge now that the agent is idle
                                    if new_phase == SessionPhase::NeedsInput {
                                        super::PtyManager::deliver_pending_nudge_with_writer(
                                            &writer_for_reader,
                                            &mut s,
                                        );
                                    }
                                }
                            }
                        }

                        // Emit immediately when an agent is first detected,
                        // even if no phase change occurred (e.g. session was
                        // already Idle when the CLI startup + prompt arrived
                        // in the same chunk). Also emit when a model name is
                        // enriched (detected after the initial agent detection).
                        if a.detected_agent.is_some() {
                            if let Ok(mut s) = session_clone.lock() {
                                if s.detected_agent.is_none() {
                                    s.detected_agent = a.detected_agent.clone();
                                    s.metrics = a.to_metrics();
                                    s.last_activity_at = now();
                                    let update = SessionUpdate::from(&*s);
                                    let _ = app_clone.emit("session-updated", &update);
                                } else if let (Some(ref sa), Some(ref aa)) =
                                    (&s.detected_agent, &a.detected_agent)
                                {
                                    // Model enrichment: agent detected but model was unknown, now resolved
                                    if sa.model.is_none() && aa.model.is_some() {
                                        s.detected_agent = a.detected_agent.clone();
                                        s.metrics = a.to_metrics();
                                        let update = SessionUpdate::from(&*s);
                                        let _ = app_clone.emit("session-updated", &update);
                                    }
                                }
                            }
                        }

                        // Auto-launch AI agent when shell is ready
                        if a.pending_ai_launch {
                            a.pending_ai_launch = false;
                            let launch_info = session_clone.lock().ok().map(|s| {
                                (s.ai_provider.clone(), s.has_initial_context, s.auto_approve)
                            });
                            if let Some((Some(ref provider), has_context, auto_approve)) =
                                launch_info
                            {
                                // Only launch known/allowed AI providers (reject unknown values)
                                if let Some(launch_cmd) = ai_launch_command(provider, auto_approve)
                                {
                                    // For Claude/Gemini: pass context instruction as CLI argument
                                    // so it's processed immediately without PTY injection timing issues
                                    let supports_cli_prompt =
                                        provider == "claude" || provider == "gemini";
                                    let cmd = if has_context && supports_cli_prompt {
                                        format!("{} \"Read the file at $HERMES_CONTEXT for project context about the attached workspaces.\"", launch_cmd)
                                    } else {
                                        launch_cmd
                                    };
                                    if let Ok(mut w) = writer_for_reader.lock() {
                                        let _ = w.write_all(format!("{}\r", cmd).as_bytes());
                                        let _ = w.flush();
                                    }
                                    // Mark context as injected if it was baked into the launch command
                                    if has_context && supports_cli_prompt {
                                        a.context_injected = true;
                                        if let Ok(mut s) = session_clone.lock() {
                                            s.context_injected = true;
                                            s.phase = SessionPhase::LaunchingAgent;
                                            let update = SessionUpdate::from(&*s);
                                            let _ = app_clone.emit("session-updated", &update);
                                        }
                                    } else {
                                        if let Ok(mut s) = session_clone.lock() {
                                            s.phase = SessionPhase::LaunchingAgent;
                                            let update = SessionUpdate::from(&*s);
                                            let _ = app_clone.emit("session-updated", &update);
                                        }
                                    }
                                } else {
                                    log::warn!("Unknown AI provider rejected: {}", provider);
                                }
                            }
                        }

                        // Auto-inject context when agent prompt is first detected
                        // (fallback for non-Claude agents that can't take CLI args).
                        // Skip for SSH sessions — $HERMES_CONTEXT isn't set remotely.
                        let is_ssh_session = session_clone
                            .lock()
                            .ok()
                            .is_some_and(|s| s.ssh_info.is_some());
                        if a.pending_context_inject && !a.context_injected && !is_ssh_session {
                            a.pending_context_inject = false;
                            let mut write_ok = false;
                            if let Ok(mut w) = writer_for_reader.lock() {
                                let msg = "Read the file at $HERMES_CONTEXT for project context about the attached workspaces.\r";
                                if w.write_all(msg.as_bytes()).is_ok() {
                                    let _ = w.flush();
                                    write_ok = true;
                                }
                            }
                            if write_ok {
                                a.context_injected = true;
                                if let Ok(mut s) = session_clone.lock() {
                                    s.context_injected = true;
                                }
                            }
                            // If write failed, pending_context_inject is cleared but
                            // context_injected stays false — next prompt detection retries.
                        } else if is_ssh_session && a.pending_context_inject {
                            // Clear the flag so the analyzer doesn't keep retrying
                            a.pending_context_inject = false;
                            a.context_injected = true;
                        }

                        if chunk_count.is_multiple_of(30) {
                            if let Ok(mut s) = session_clone.lock() {
                                s.detected_agent = a.detected_agent.clone();
                                s.metrics = a.to_metrics();
                                s.last_activity_at = now();
                                let update = SessionUpdate::from(&*s);
                                let _ = app_clone.emit("session-updated", &update);
                            }
                        }
                    }

                    use base64::Engine;
                    let encoded = base64::engine::general_purpose::STANDARD.encode(data);
                    let _ = app_clone.emit(&format!("pty-output-{}", event_session_id), encoded);
                }
                Err(_) => {
                    if let Ok(mut s) = session_clone.lock() {
                        s.phase = SessionPhase::Destroyed;
                        let update = SessionUpdate::from(&*s);
                        let _ = app_clone.emit("session-updated", &update);
                    }
                    let _ = app_clone.emit(&format!("pty-exit-{}", event_session_id), ());
                    break;
                }
            }
        }
    });

    // ─── Silence timer thread ─────────────────────────────────────────
    // When the PTY goes silent for >1.5s while busy, transition to Idle
    // or NeedsInput. This replaces fragile per-line text matching as the
    // PRIMARY state transition mechanism for idle detection.
    {
        let analyzer_silence = Arc::clone(&analyzer);
        let session_silence = Arc::clone(&session_arc);
        let app_silence = app.clone();
        thread::spawn(move || {
            let interval = std::time::Duration::from_millis(500);
            let silence_threshold = std::time::Duration::from_millis(2000);
            loop {
                thread::sleep(interval);
                // Check if session is destroyed → stop
                if let Ok(s) = session_silence.lock() {
                    if matches!(s.phase, SessionPhase::Destroyed) {
                        break;
                    }
                }
                if let Ok(mut a) = analyzer_silence.lock() {
                    if let Some(last) = a.last_output_at {
                        if a.is_busy && last.elapsed() >= silence_threshold {
                            a.check_silence();
                            if let Some(new_phase) = a.take_pending_phase() {
                                if let Ok(mut s) = session_silence.lock() {
                                    if s.phase != new_phase {
                                        s.phase = new_phase;
                                        s.detected_agent = a.detected_agent.clone();
                                        s.metrics = a.to_metrics();
                                        s.last_activity_at = now();
                                        let update = SessionUpdate::from(&*s);
                                        let _ = app_silence.emit("session-updated", &update);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });
    }

    let result = {
        let s = session_arc
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        SessionUpdate::from(&*s)
    };

    let pty_session = PtySession {
        master: pair.master,
        writer,
        session: session_arc,
        analyzer,
        child,
        #[cfg(unix)]
        tty_path: saved_tty_path,
    };
    mgr.sessions.insert(session_id.clone(), pty_session);

    // Save to DB
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.create_session_v2(&result).ok();

        // Attach realms if provided
        if let Some(ref ids) = realm_ids {
            for realm_id in ids {
                db.attach_session_realm(&session_id, realm_id, "primary")
                    .ok();
            }
            // Write context file so AI agents can read project info
            // (only for local sessions — the file isn't accessible over SSH)
            if !is_ssh && !ids.is_empty() {
                crate::realm::attunement::write_session_context_file(&app, &db, &session_id).ok();
            }
        }
    }

    Ok(result)
}

/// Enumerate direct child PIDs of a given parent process.
#[cfg(unix)]
fn enumerate_child_pids(parent_pid: u32) -> Vec<u32> {
    let mut children = Vec::new();

    #[cfg(target_os = "macos")]
    {
        // Use proc_listchildpids (libproc, macOS-specific)
        extern "C" {
            fn proc_listchildpids(ppid: libc::pid_t, buffer: *mut libc::c_void, buffersize: libc::c_int) -> libc::c_int;
        }

        // First call with NULL to get count
        let count = unsafe { proc_listchildpids(parent_pid as i32, std::ptr::null_mut(), 0) };
        if count <= 0 {
            return children;
        }

        let buf_size = count as usize;
        let mut pids: Vec<libc::pid_t> = vec![0; buf_size];
        let ret = unsafe {
            proc_listchildpids(
                parent_pid as i32,
                pids.as_mut_ptr() as *mut libc::c_void,
                (buf_size * std::mem::size_of::<libc::pid_t>()) as libc::c_int,
            )
        };

        if ret > 0 {
            let actual = ret as usize / std::mem::size_of::<libc::pid_t>();
            for &pid in &pids[..actual] {
                if pid > 0 {
                    children.push(pid as u32);
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        // Linux: iterate /proc/*/stat and match ppid
        if let Ok(entries) = std::fs::read_dir("/proc") {
            for entry in entries.flatten() {
                if let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) {
                    let fields: Vec<&str> = stat.split_whitespace().collect();
                    if fields.len() > 3 {
                        if let Ok(ppid) = fields[3].parse::<u32>() {
                            if ppid == parent_pid {
                                if let Ok(pid) = fields[0].parse::<u32>() {
                                    children.push(pid);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    children
}

#[tauri::command]
pub fn write_to_session(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let mut mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    let session = mgr
        .sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;

    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| format!("Invalid base64 input: {}", e))?;

    if let Ok(mut a) = session.analyzer.lock() {
        a.mark_input_sent();

        let text = String::from_utf8_lossy(&bytes);
        let is_enter = text.contains('\r') || text.contains('\n');

        // Accumulate printable chars into the line buffer
        for ch in text.chars() {
            if ch == '\r' || ch == '\n' {
                // Enter pressed — commit the accumulated line
                continue;
            } else if ch == '\x7f' || ch == '\x08' {
                // Backspace — pop last char
                a.input_line_buffer.pop();
            } else if ch == '\x03' {
                // Ctrl+C — clear buffer
                a.input_line_buffer.clear();
            } else if !ch.is_control() {
                a.input_line_buffer.push(ch);
            }
        }

        if is_enter && !a.input_line_buffer.is_empty() {
            let line = a.input_line_buffer.drain(..).collect::<String>();
            a.mark_input_line(&line);
            let cwd = a.current_cwd.clone().unwrap_or_default();
            a.start_node(&cwd);
        } else if is_enter {
            // Enter with empty buffer — still mark activity
            a.input_line_buffer.clear();
        }
    }

    {
        let mut w = session
            .writer
            .lock()
            .map_err(|e| format!("Writer lock failed: {}", e))?;
        w.write_all(&bytes)
            .map_err(|e| format!("Write failed: {}", e))?;
        w.flush().map_err(|e| format!("Flush failed: {}", e))?;
    }

    // ── Direct SIGINT delivery (macOS/Unix) ──
    //
    // Writing \x03 to the PTY master should cause the line discipline to
    // generate SIGINT for the foreground process group.  However, on macOS
    // with posix_spawn-based PTY sessions the signal sometimes doesn't
    // reach the child.  As a reliable fallback we:
    //   1. Try tcgetpgrp() on the slave device to find the foreground pgrp.
    //   2. If that fails (it does from a non-session-leader process), send
    //      SIGINT to every child of the shell using sysctl/proc enumeration.
    #[cfg(unix)]
    if bytes.contains(&0x03) {
        // Diagnostic: check termios on the slave to see if ISIG is enabled
        // Send SIGINT to the shell's child processes directly.
        // The shell's PID is known; we enumerate its children via sysctl
        // and send SIGINT to each child's process group.
        if let Some(shell_pid) = session.child.process_id() {
            let child_pids = enumerate_child_pids(shell_pid);
            if !child_pids.is_empty() {
                for &cpid in &child_pids {
                    unsafe {
                        // Send to the child's process group (covers the child
                        // and any of its own children)
                        libc::kill(-(cpid as i32), libc::SIGINT);
                    }
                }
            } else {
                // No children found — the shell is at the prompt.
                // Send to the shell's own process group so it sees the interrupt.
                unsafe {
                    libc::kill(-(shell_pid as i32), libc::SIGINT);
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn nudge_realm_context(state: State<'_, AppState>, session_id: String) -> Result<bool, String> {
    // Check if there are realms attached
    let has_context = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let realms = db.get_session_realms(&session_id)?;
        !realms.is_empty()
    };

    if !has_context {
        return Ok(false);
    }

    let mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    let pty = match mgr.sessions.get(&session_id) {
        Some(p) => p,
        None => return Ok(false),
    };

    // Only nudge if an AI agent has been detected in this session
    let has_agent = pty
        .session
        .lock()
        .map_err(|e| format!("Session lock failed: {}", e))?
        .detected_agent
        .is_some();

    if !has_agent {
        return Ok(false);
    }

    // Send a minimal one-liner telling the agent to read the context file
    let msg =
        "Read the file at $HERMES_CONTEXT for project context about the attached workspaces.\r";
    let mut w = pty
        .writer
        .lock()
        .map_err(|e| format!("Writer lock failed: {}", e))?;
    w.write_all(msg.as_bytes())
        .map_err(|e| format!("Write failed: {}", e))?;
    w.flush().map_err(|e| format!("Flush failed: {}", e))?;

    Ok(true)
}

#[tauri::command]
pub fn resize_session(
    state: State<'_, AppState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    let session = mgr
        .sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Resize failed: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn close_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let mut mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;

    if let Some(mut pty_session) = mgr.sessions.remove(&session_id) {
        // Kill the child shell process — don't block on wait() since the
        // process may be hung. Spawn a reaper thread instead.
        pty_session.child.kill().ok();
        let mut child = pty_session.child;
        thread::spawn(move || {
            child.wait().ok();
        });

        // Save snapshot and persist token data
        if let Ok(analyzer) = pty_session.analyzer.lock() {
            let snapshot = analyzer.get_stripped_output();
            let metrics = analyzer.to_metrics();
            if let Ok(db) = state.db.lock() {
                db.save_session_snapshot(&session_id, &snapshot).ok();
                db.update_session_status(&session_id, "destroyed").ok();
                // Persist final token state
                for (provider, tokens) in &metrics.token_usage {
                    db.record_token_usage(
                        &session_id,
                        provider,
                        &tokens.model,
                        tokens.input_tokens as i64,
                        tokens.output_tokens as i64,
                        tokens.estimated_cost_usd,
                    )
                    .ok();
                }
                // Persist memory facts
                for fact in &metrics.memory_facts {
                    db.save_memory_entry(
                        "project",
                        "global",
                        &fact.key,
                        &fact.value,
                        &fact.source,
                        "auto",
                        fact.confidence as f64,
                    )
                    .ok();
                }
            }
        }

        if let Ok(mut s) = pty_session.session.lock() {
            s.phase = SessionPhase::Destroyed;
            let update = SessionUpdate::from(&*s);
            let _ = app.emit("session-updated", &update);
        }
        let _ = app.emit("session-removed", &session_id);

        // Clean up context file
        crate::realm::attunement::delete_session_context_file(&app, &session_id);

        // Clean up session-scoped pins (project-scoped pins survive)
        if let Ok(db) = state.db.lock() {
            let _ = db.cleanup_session_pins(&session_id);
        }

        // Clean up linked worktrees for this session
        if let Ok(db) = state.db.lock() {
            match db.get_session_worktrees(&session_id) {
                Ok(worktrees) => {
                    for wt in &worktrees {
                        if wt.is_main_worktree {
                            continue; // Don't remove the main worktree
                        }
                        // Look up realm path to run git worktree remove
                        if let Ok(Some(realm)) = db.get_realm(&wt.realm_id) {
                            if let Err(e) = crate::git::worktree::remove_worktree(
                                &realm.path,
                                &session_id,
                                &wt.worktree_path,
                            ) {
                                log::warn!(
                                    "Failed to remove worktree '{}' for session '{}': {}",
                                    wt.worktree_path,
                                    session_id,
                                    e
                                );
                            }
                        }
                    }
                    // Delete all worktree DB records for this session
                    if let Err(e) = db.delete_worktrees_for_session(&session_id) {
                        log::warn!(
                            "Failed to delete worktree records for session '{}': {}",
                            session_id,
                            e
                        );
                    }
                }
                Err(e) => {
                    log::warn!(
                        "Failed to get worktrees for session '{}': {}",
                        session_id,
                        e
                    );
                }
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub fn get_sessions(state: State<'_, AppState>) -> Result<Vec<SessionUpdate>, String> {
    let mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    Ok(mgr
        .sessions
        .values()
        .filter_map(|ps| ps.session.lock().ok().map(|s| SessionUpdate::from(&*s)))
        .collect())
}

/// Save scrollback snapshots for ALL live sessions without closing them.
/// Used before app quit / update relaunch so sessions can be restored on next launch.
#[tauri::command]
pub fn save_all_snapshots(state: State<'_, AppState>) -> Result<(), String> {
    let mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    let db = state.db.lock().map_err(|e| e.to_string())?;

    for (session_id, pty_session) in &mgr.sessions {
        // Save session metadata first (INSERT OR REPLACE resets the row)
        if let Ok(s) = pty_session.session.lock() {
            let update = SessionUpdate::from(&*s);
            db.create_session_v2(&update).ok();
        }

        // Save snapshot AFTER metadata to avoid INSERT OR REPLACE wiping it
        if let Ok(analyzer) = pty_session.analyzer.lock() {
            let snapshot = analyzer.get_stripped_output();
            db.save_session_snapshot(session_id, &snapshot).ok();

            // Persist token usage
            let metrics = analyzer.to_metrics();
            for (provider, tokens) in &metrics.token_usage {
                db.record_token_usage(
                    session_id,
                    provider,
                    &tokens.model,
                    tokens.input_tokens as i64,
                    tokens.output_tokens as i64,
                    tokens.estimated_cost_usd,
                )
                .ok();
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub fn get_session_detail(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionUpdate, String> {
    let mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    let session = mgr
        .sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;
    let s = session.session.lock().map_err(|e| e.to_string())?;
    Ok(SessionUpdate::from(&*s))
}

#[tauri::command]
pub fn update_session_label(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    label: String,
) -> Result<(), String> {
    let mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    let session = mgr
        .sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;
    {
        let mut s = session.session.lock().map_err(|e| e.to_string())?;
        s.label = label.clone();
        let update = SessionUpdate::from(&*s);
        let _ = app.emit("session-updated", &update);
    }
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.update_session_label(&session_id, &label)?;
    Ok(())
}

#[tauri::command]
pub fn update_session_description(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    description: String,
) -> Result<(), String> {
    let mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    let session = mgr
        .sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;
    {
        let mut s = session.session.lock().map_err(|e| e.to_string())?;
        s.description = description.clone();
        let update = SessionUpdate::from(&*s);
        let _ = app.emit("session-updated", &update);
    }
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.update_session_description(&session_id, &description)?;
    Ok(())
}

#[tauri::command]
pub fn update_session_color(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    color: String,
) -> Result<(), String> {
    let mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    let session = mgr
        .sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;
    {
        let mut s = session.session.lock().map_err(|e| e.to_string())?;
        s.color = color.clone();
        let update = SessionUpdate::from(&*s);
        let _ = app.emit("session-updated", &update);
    }
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.update_session_color(&session_id, &color)?;
    Ok(())
}

#[tauri::command]
pub fn add_workspace_path(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    let session = mgr
        .sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;
    let mut s = session.session.lock().map_err(|e| e.to_string())?;
    if !s.workspace_paths.contains(&path) {
        s.workspace_paths.push(path);
    }
    let update = SessionUpdate::from(&*s);
    let _ = app.emit("session-updated", &update);
    Ok(())
}

#[tauri::command]
pub fn update_session_group(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    group: Option<String>,
) -> Result<(), String> {
    let mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    let pty_session = mgr
        .sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;
    {
        let mut s = pty_session.session.lock().map_err(|e| e.to_string())?;
        s.group = group.clone();
        let update = SessionUpdate::from(&*s);
        let _ = app.emit("session-updated", &update);
    }
    // Persist
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.update_session_group(&session_id, group.as_deref())?;
    Ok(())
}

#[tauri::command]
pub fn get_session_output(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<String, String> {
    let mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    let session = mgr
        .sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;
    let analyzer = session.analyzer.lock().map_err(|e| e.to_string())?;
    Ok(analyzer.get_stripped_output())
}

#[tauri::command]
pub fn get_session_metadata(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionMetrics, String> {
    let mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    let session = mgr
        .sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;
    let analyzer = session.analyzer.lock().map_err(|e| e.to_string())?;
    Ok(analyzer.to_metrics())
}

/// Returns a list of `{ name, path }` objects for shells found on this machine.
#[tauri::command]
pub fn get_available_shells() -> Vec<ShellInfo> {
    let mut shells: Vec<ShellInfo> = Vec::new();

    #[cfg(unix)]
    {
        let candidates = [
            ("zsh", "/bin/zsh"),
            ("bash", "/bin/bash"),
            ("fish", "/usr/local/bin/fish"),
            ("fish", "/opt/homebrew/bin/fish"),
            ("nu", "/usr/local/bin/nu"),
            ("nu", "/opt/homebrew/bin/nu"),
            ("sh", "/bin/sh"),
        ];
        let mut seen = std::collections::HashSet::new();
        for (name, path) in candidates {
            if seen.contains(name) {
                continue;
            }
            if std::path::Path::new(path).exists() {
                seen.insert(name);
                shells.push(ShellInfo {
                    name: name.to_string(),
                    path: path.to_string(),
                });
            }
        }
    }

    #[cfg(windows)]
    {
        // PowerShell 7+ (pwsh)
        if crate::platform::command_exists("pwsh") {
            shells.push(ShellInfo {
                name: "PowerShell".to_string(),
                path: "pwsh".to_string(),
            });
        }
        // Windows PowerShell 5.x
        if crate::platform::command_exists("powershell") {
            shells.push(ShellInfo {
                name: "Windows PowerShell".to_string(),
                path: "powershell".to_string(),
            });
        }
        // cmd.exe
        if let Ok(comspec) = std::env::var("COMSPEC") {
            shells.push(ShellInfo {
                name: "Command Prompt".to_string(),
                path: comspec,
            });
        } else {
            shells.push(ShellInfo {
                name: "Command Prompt".to_string(),
                path: "cmd.exe".to_string(),
            });
        }
        // Git Bash
        let git_bash = "C:\\Program Files\\Git\\bin\\bash.exe";
        if std::path::Path::new(git_bash).exists() {
            shells.push(ShellInfo {
                name: "Git Bash".to_string(),
                path: git_bash.to_string(),
            });
        }
    }

    shells
}

#[tauri::command]
pub fn detect_shell_environment(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<ShellEnvironment, String> {
    let mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    let session = mgr
        .sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;
    let s = session.session.lock().map_err(|e| e.to_string())?;

    let shell = &s.shell;
    let shell_type = if shell.contains("zsh") {
        "zsh"
    } else if shell.contains("bash") {
        "bash"
    } else if shell.contains("fish") {
        "fish"
    } else if shell.contains("pwsh") || shell.contains("powershell") {
        "powershell"
    } else if shell.contains("cmd") {
        "cmd"
    } else {
        "unknown"
    };

    let home = crate::platform::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut plugins = Vec::new();
    let mut has_oh_my_zsh = false;
    let mut has_autosuggest = false;
    let mut has_syntax_highlighting = false;
    let mut has_starship = false;
    let mut has_powerlevel10k = false;

    let home_path = std::path::PathBuf::from(&home);

    // Check for Oh My Zsh (Unix only)
    if home_path.join(".oh-my-zsh").exists() {
        has_oh_my_zsh = true;
        plugins.push("oh-my-zsh".to_string());
    }

    // Check for starship (check config file and common install locations)
    let starship_in_path = crate::platform::command_exists("starship");
    if starship_in_path || home_path.join(".config").join("starship.toml").exists() {
        has_starship = true;
        plugins.push("starship".to_string());
    }

    // Read .zshrc for plugin detection
    if shell_type == "zsh" {
        if let Ok(zshrc) = std::fs::read_to_string(home_path.join(".zshrc")) {
            if zshrc.contains("zsh-autosuggestions") {
                has_autosuggest = true;
                plugins.push("zsh-autosuggestions".to_string());
            }
            if zshrc.contains("zsh-syntax-highlighting")
                || zshrc.contains("fast-syntax-highlighting")
            {
                has_syntax_highlighting = true;
                plugins.push("zsh-syntax-highlighting".to_string());
            }
            if zshrc.contains("powerlevel10k") || zshrc.contains("p10k") {
                has_powerlevel10k = true;
                plugins.push("powerlevel10k".to_string());
            }
        }
    }

    // Fish has built-in autosuggestions
    if shell_type == "fish" {
        has_autosuggest = true;
    }

    // PowerShell has PSReadLine autosuggestions
    if shell_type == "powershell" {
        has_autosuggest = true;
        plugins.push("PSReadLine".to_string());
    }

    Ok(ShellEnvironment {
        shell_type: shell_type.to_string(),
        plugins_detected: plugins,
        has_native_autosuggest: has_autosuggest,
        has_oh_my_zsh,
        has_syntax_highlighting,
        has_starship,
        has_powerlevel10k,
    })
}

#[tauri::command]
pub fn read_shell_history(shell: String, limit: usize) -> Result<Vec<String>, String> {
    let home_dir =
        crate::platform::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())?;

    let history_path = if shell.contains("zsh") || shell == "zsh" {
        home_dir.join(".zsh_history").to_string_lossy().to_string()
    } else if shell.contains("bash") || shell == "bash" {
        home_dir.join(".bash_history").to_string_lossy().to_string()
    } else if shell.contains("fish") || shell == "fish" {
        home_dir
            .join(".local")
            .join("share")
            .join("fish")
            .join("fish_history")
            .to_string_lossy()
            .to_string()
    } else if shell.contains("pwsh") || shell.contains("powershell") {
        // PowerShell history via PSReadLine
        #[cfg(windows)]
        {
            let appdata = std::env::var("APPDATA").unwrap_or_default();
            if shell.contains("pwsh") {
                // PowerShell 7+ (Core)
                format!(
                    "{}\\Microsoft\\PowerShell\\PSReadLine\\ConsoleHost_history.txt",
                    appdata
                )
            } else {
                // Windows PowerShell 5.1
                format!(
                    "{}\\Microsoft\\Windows\\PowerShell\\PSReadLine\\ConsoleHost_history.txt",
                    appdata
                )
            }
        }
        #[cfg(not(windows))]
        {
            home_dir
                .join(".local")
                .join("share")
                .join("powershell")
                .join("PSReadLine")
                .join("ConsoleHost_history.txt")
                .to_string_lossy()
                .to_string()
        }
    } else {
        // Try zsh first, then bash
        let zsh_path = home_dir.join(".zsh_history");
        if zsh_path.exists() {
            zsh_path.to_string_lossy().to_string()
        } else {
            home_dir.join(".bash_history").to_string_lossy().to_string()
        }
    };

    let content = std::fs::read_to_string(&history_path)
        .map_err(|e| format!("Cannot read history file {}: {}", history_path, e))?;

    let is_fish = shell.contains("fish") || shell == "fish";
    let is_zsh = shell.contains("zsh") || shell == "zsh";
    let mut commands = Vec::new();

    if is_fish {
        // Fish history format: "- cmd: <command>"
        for line in content.lines() {
            let trimmed = line.trim();
            if let Some(cmd) = trimmed.strip_prefix("- cmd: ") {
                let cmd = cmd.trim();
                if !cmd.is_empty() {
                    commands.push(cmd.to_string());
                }
            }
        }
    } else if is_zsh {
        // Zsh history can have format: ": timestamp:0;command"
        for line in content.lines() {
            let cmd = if line.starts_with(": ") {
                // Extended history format
                if let Some(idx) = line.find(';') {
                    &line[idx + 1..]
                } else {
                    line
                }
            } else {
                line
            };
            let cmd = cmd.trim();
            if !cmd.is_empty() {
                commands.push(cmd.to_string());
            }
        }
    } else {
        // Bash: one command per line
        for line in content.lines() {
            let cmd = line.trim();
            if !cmd.is_empty() && !cmd.starts_with('#') {
                commands.push(cmd.to_string());
            }
        }
    }

    // Return the last `limit` entries (most recent)
    let start = if commands.len() > limit {
        commands.len() - limit
    } else {
        0
    };
    Ok(commands[start..].to_vec())
}

#[tauri::command]
pub fn get_session_commands(
    state: State<'_, AppState>,
    session_id: String,
    limit: usize,
) -> Result<Vec<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let entries = db.get_execution_log_entries(&session_id, Some(limit as i64))?;
    Ok(entries
        .into_iter()
        .filter(|e| e.event_type == "command")
        .map(|e| e.content)
        .collect())
}

#[tauri::command]
pub fn get_project_context(path: String) -> Result<ProjectContextInfo, String> {
    let dir = std::path::Path::new(&path);
    if !dir.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    let has_git = dir.join(".git").exists();

    // Detect package manager
    let package_manager = if dir.join("bun.lockb").exists() || dir.join("bun.lock").exists() {
        Some("bun".to_string())
    } else if dir.join("pnpm-lock.yaml").exists() {
        Some("pnpm".to_string())
    } else if dir.join("yarn.lock").exists() {
        Some("yarn".to_string())
    } else if dir.join("package-lock.json").exists() || dir.join("package.json").exists() {
        Some("npm".to_string())
    } else {
        None
    };

    // Detect languages
    let mut languages = Vec::new();
    if dir.join("Cargo.toml").exists() {
        languages.push("rust".to_string());
    }
    if dir.join("tsconfig.json").exists() {
        languages.push("typescript".to_string());
    }
    if dir.join("package.json").exists() && !languages.contains(&"typescript".to_string()) {
        languages.push("javascript".to_string());
    }
    if dir.join("go.mod").exists() {
        languages.push("go".to_string());
    }
    if dir.join("requirements.txt").exists()
        || dir.join("pyproject.toml").exists()
        || dir.join("setup.py").exists()
    {
        languages.push("python".to_string());
    }
    if dir.join("Gemfile").exists() {
        languages.push("ruby".to_string());
    }
    if dir.join("pubspec.yaml").exists() {
        languages.push("dart".to_string());
    }

    // Detect frameworks
    let mut frameworks = Vec::new();
    if dir.join("next.config.js").exists()
        || dir.join("next.config.ts").exists()
        || dir.join("next.config.mjs").exists()
    {
        frameworks.push("next".to_string());
    }
    if dir.join("vite.config.ts").exists() || dir.join("vite.config.js").exists() {
        frameworks.push("vite".to_string());
    }
    if dir.join("remix.config.js").exists() || dir.join("remix.config.ts").exists() {
        frameworks.push("remix".to_string());
    }
    if dir.join("astro.config.mjs").exists() || dir.join("astro.config.ts").exists() {
        frameworks.push("astro".to_string());
    }
    if dir.join("nuxt.config.ts").exists() || dir.join("nuxt.config.js").exists() {
        frameworks.push("nuxt".to_string());
    }
    if dir.join("tauri.conf.json").exists() || dir.join("src-tauri").exists() {
        frameworks.push("tauri".to_string());
    }
    if dir.join("Dockerfile").exists()
        || dir.join("docker-compose.yml").exists()
        || dir.join("docker-compose.yaml").exists()
    {
        frameworks.push("docker".to_string());
    }
    if dir.join("Makefile").exists() {
        frameworks.push("make".to_string());
    }
    if dir.join("pubspec.yaml").exists() {
        frameworks.push("flutter".to_string());
    }
    if dir.join(".terraform").exists() || dir.join("main.tf").exists() {
        frameworks.push("terraform".to_string());
    }

    Ok(ProjectContextInfo {
        has_git,
        package_manager,
        languages,
        frameworks,
    })
}
