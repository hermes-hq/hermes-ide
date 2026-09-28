use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex as StdMutex};
use std::thread;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::db::{Database, SessionWorktreeRow};
use crate::pty::adapters::now;
use crate::pty::analyzer::OutputAnalyzer;
use crate::pty::models::*;
use crate::pty::{
    ai_launch_command, channels_suffix, detect_shell, get_working_directory, PtySession,
};
use crate::AppState;

// ─── SSH / tmux helpers ─────────────────────────────────────────────

/// Normalize the SSH user. Blank or absent means "let ssh decide", so a Host
/// alias in ~/.ssh/config can supply its own `User` (falls back to the local
/// user, exactly like plain `ssh host`).
fn resolve_ssh_user(user: Option<String>) -> String {
    user.map(|u| u.trim().to_string()).unwrap_or_default()
}

/// The ssh destination argument: `user@host`, or the bare host/alias when no
/// user is set.
fn ssh_destination(user: &str, host: &str) -> String {
    if user.is_empty() {
        host.to_string()
    } else {
        format!("{}@{}", user, host)
    }
}

/// Directory for SSH ControlMaster sockets.
fn ssh_control_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join("hermes-ssh-mux");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// ControlMaster socket path for a connection.
fn ssh_socket_path(user: &str, host: &str, port: u16) -> std::path::PathBuf {
    ssh_control_dir().join(format!("{}:{}", ssh_destination(user, host), port))
}

/// Build a base SSH command with common options and connection multiplexing.
fn ssh_command(
    user: &str,
    host: &str,
    port: u16,
    jump_host: Option<&str>,
) -> std::process::Command {
    let mut cmd = std::process::Command::new("ssh");
    cmd.arg("-o").arg("ConnectTimeout=5");
    cmd.arg("-o").arg("BatchMode=yes");
    // Reuse existing TCP connection if available, or establish a new persistent one
    let socket_path = ssh_socket_path(user, host, port);
    cmd.arg("-o")
        .arg(format!("ControlPath={}", socket_path.display()));
    cmd.arg("-o").arg("ControlMaster=auto");
    cmd.arg("-o").arg("ControlPersist=300");
    if port != 22 {
        cmd.arg("-p").arg(port.to_string());
    }
    if let Some(jump) = normalize_jump_host(jump_host) {
        cmd.arg("-J").arg(jump);
    }
    // `--` stops option parsing so a host starting with '-' is never read as an option.
    cmd.arg("--");
    cmd.arg(ssh_destination(user, host));
    cmd
}

/// Build the interactive `ssh` command for an SSH terminal session.
fn ssh_pty_command(info: &SshConnectionInfo, cols: u16, rows: u16) -> CommandBuilder {
    let mut c = CommandBuilder::new("ssh");
    c.arg("-t"); // Force TTY allocation
    c.arg("-o");
    c.arg("ServerAliveInterval=15");
    c.arg("-o");
    c.arg("ServerAliveCountMax=3");
    let socket_path = ssh_socket_path(&info.user, &info.host, info.port);
    c.arg("-o");
    c.arg(format!("ControlPath={}", socket_path.display()));
    c.arg("-o");
    c.arg("ControlMaster=auto");
    c.arg("-o");
    c.arg("ControlPersist=300");
    if info.port != 22 {
        c.arg("-p");
        c.arg(info.port.to_string());
    }
    if let Some(ref id_file) = info.identity_file {
        c.arg("-i");
        c.arg(id_file);
    }
    if let Some(jump) = normalize_jump_host(info.jump_host.as_deref()) {
        c.arg("-J");
        c.arg(jump);
    }
    c.arg("--");
    c.arg(ssh_destination(&info.user, &info.host));
    // Attach to tmux session if specified.
    // `new-session -A` attaches if it exists, creates if it doesn't.
    if let Some(ref tmux_name) = info.tmux_session {
        c.arg(format!(
            "tmux new-session -A -s '{}' -x {} -y {}",
            tmux_name.replace('\'', "'\\''"),
            cols,
            rows
        ));
    }
    c
}

/// Trimmed jump host, or `None` when unset/blank.
fn normalize_jump_host(jump_host: Option<&str>) -> Option<&str> {
    jump_host.map(str::trim).filter(|j| !j.is_empty())
}

/// Run a remote SSH command and return (stdout, stderr, success).
fn ssh_exec(
    user: &str,
    host: &str,
    port: u16,
    jump_host: Option<&str>,
    remote_cmd: &str,
) -> Result<(String, String, bool), String> {
    let mut cmd = ssh_command(user, host, port, jump_host);
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
    let (user, host, port, jump_host) = {
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
        (
            ssh.user.clone(),
            ssh.host.clone(),
            ssh.port,
            ssh.jump_host.clone(),
        )
    };

    // Use the given path, or detect the remote working directory via pwd
    let target = match &path {
        Some(p) if !p.is_empty() => p.clone(),
        _ => {
            // Ask the remote host for its home directory (session.working_directory is local)
            let (pwd_out, _, ok) =
                ssh_exec(&user, &host, port, jump_host.as_deref(), "echo $HOME")?;
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

    let (stdout, _stderr, success) =
        ssh_exec(&user, &host, port, jump_host.as_deref(), &remote_cmd)?;
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
    let (user, host, port, jump_host) = {
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
        (
            ssh.user.clone(),
            ssh.host.clone(),
            ssh.port,
            ssh.jump_host.clone(),
        )
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
    let (stdout, _, success) = ssh_exec(&user, &host, port, jump_host.as_deref(), &combined_cmd)?;
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

#[tauri::command]
pub async fn ssh_write_file(
    state: State<'_, AppState>,
    session_id: String,
    file_path: String,
    content: String,
) -> Result<(), String> {
    let (user, host, port, jump_host) = {
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
        (
            ssh.user.clone(),
            ssh.host.clone(),
            ssh.port,
            ssh.jump_host.clone(),
        )
    };

    let escaped = shell_escape(&file_path);
    let cmd = format!("cat > {}", escaped);
    let mut child = ssh_command(&user, &host, port, jump_host.as_deref())
        .arg(cmd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn SSH: {}", e))?;

    if let Some(ref mut stdin) = child.stdin {
        use std::io::Write;
        stdin
            .write_all(content.as_bytes())
            .map_err(|e| format!("Failed to write to SSH stdin: {}", e))?;
    }
    // Drop stdin to close the pipe and let cat finish
    child.stdin.take();

    let output = child
        .wait_with_output()
        .map_err(|e| format!("SSH command failed: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("SSH write failed: {}", stderr));
    }
    Ok(())
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
    jump_host: Option<String>,
) -> Result<Vec<TmuxSessionEntry>, String> {
    let user = resolve_ssh_user(user);
    let port = port.unwrap_or(22);

    let (stdout, stderr, success) = ssh_exec(
        &user,
        &host,
        port,
        jump_host.as_deref(),
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
    jump_host: Option<String>,
    tmux_session: String,
) -> Result<Vec<TmuxWindowEntry>, String> {
    let user = resolve_ssh_user(user);
    let port = port.unwrap_or(22);

    let remote_cmd = format!(
        "tmux list-windows -t '{}' -F '#{{window_index}}|||#{{window_name}}|||#{{window_active}}'",
        tmux_session.replace('\'', "'\\''")
    );
    let (stdout, stderr, success) =
        ssh_exec(&user, &host, port, jump_host.as_deref(), &remote_cmd)?;

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
    jump_host: Option<String>,
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
    let (_stdout, stderr, success) =
        ssh_exec(&user, &host, port, jump_host.as_deref(), &remote_cmd)?;

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
    jump_host: Option<String>,
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
    let (_stdout, stderr, success) =
        ssh_exec(&user, &host, port, jump_host.as_deref(), &remote_cmd)?;

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
    jump_host: Option<String>,
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
    let (_stdout, stderr, success) =
        ssh_exec(&user, &host, port, jump_host.as_deref(), &remote_cmd)?;

    if !success {
        return Err(format!("Failed to rename tmux window: {}", stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
pub fn check_ai_providers(include_beta: Option<bool>) -> std::collections::HashMap<String, bool> {
    crate::platform::check_ai_cli_availability(include_beta.unwrap_or(false))
}

/// The line typed into a session's shell to start its agent.
struct AgentLaunch {
    cmd: String,
    provider: String,
    /// The project-context prompt travels with the command (no later nudge).
    context_in_args: bool,
    /// With the `hi` helper: the session's launch folder to watch for
    /// signals, whether silence means a startup prompt, and the nonce the
    /// launch's spool lines carry.
    watch: Option<(std::path::PathBuf, bool, String)>,
}

/// Resolve the launch line once the shell is ready: through the bundled `hi`
/// helper when the `launchHelper` flag is on (see `launch.rs`), else the
/// vendor command typed as before. None when the session has no agent, or
/// an agent Hermes does not know.
fn resolve_agent_launch(app: &AppHandle, session: &Arc<StdMutex<Session>>) -> Option<AgentLaunch> {
    let mut s = session.lock().ok()?;
    let provider = s.ai_provider.clone()?;
    if let Some(prepared) = crate::pty::launch::prepare_helper_launch(app, &mut s) {
        return Some(AgentLaunch {
            cmd: prepared.line,
            provider,
            context_in_args: prepared.context_in_args,
            watch: Some((
                prepared.session_dir,
                prepared.expects_start_signal,
                prepared.nonce,
            )),
        });
    }
    // Only launch known/allowed AI providers (reject unknown values)
    let Some(launch_cmd) = ai_launch_command(
        &provider,
        &s.permission_mode,
        &s.custom_prefix,
        &s.custom_suffix,
        &s.agent_command,
    ) else {
        log::warn!("Unknown AI provider rejected: {}", provider);
        return None;
    };
    // For Claude/Gemini: pass context instruction as CLI argument
    // so it's processed immediately without PTY injection timing issues
    let supports_cli_prompt = provider == "claude" || provider == "gemini";
    let context_in_args = s.has_initial_context && supports_cli_prompt;
    // Build command: base+flags, then prompt, then --channels
    // (channels must come AFTER prompt so CLI doesn't treat prompt as a channel entry)
    let mut cmd = if context_in_args {
        format!(
            "{} {}",
            launch_cmd,
            crate::pty::context_prompt_arg(&s.shell)
        )
    } else {
        launch_cmd
    };
    if provider == "claude" && !s.channels.is_empty() {
        cmd.push_str(&channels_suffix(&s.channels));
    }
    Some(AgentLaunch {
        cmd,
        provider,
        context_in_args,
        watch: None,
    })
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
    project_ids: Option<Vec<String>>,
    auto_approve: Option<bool>,
    permission_mode: Option<String>,
    custom_prefix: Option<String>,
    custom_suffix: Option<String>,
    agent_name: Option<String>,
    agent_command: Option<String>,
    channels: Option<Vec<String>>,
    ssh_host: Option<String>,
    ssh_port: Option<u16>,
    ssh_user: Option<String>,
    tmux_session: Option<String>,
    ssh_identity_file: Option<String>,
    ssh_jump_host: Option<String>,
    initial_rows: Option<u16>,
    initial_cols: Option<u16>,
    // `mode` is the frontend-chosen runtime mode.  `"terminal"` (default)
    // spawns a PTY; `"agent"` skips PTY spawn and lets the frontend drive
    // the Claude subprocess via `agent::spawn_agent_session` after this
    // command returns.
    mode: Option<SessionMode>,
    // Feature flag `launchHelper` (evaluated by the frontend): start the
    // agent through the bundled `hi` helper and resume it on restore.
    launch_helper: Option<bool>,
    // A restored session's saved conversation id; with the helper on, the
    // agent resumes it (see `launch.rs`).
    vendor_session_id: Option<String>,
) -> Result<SessionUpdate, String> {
    let session_mode = mode.unwrap_or(SessionMode::Terminal);
    let session_id = session_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    state.closed_sessions.mark_created(&session_id);
    let shell = state
        .db
        .lock()
        .map_err(|e| e.to_string())
        .and_then(|db| db.get_setting("default_shell"))
        .ok()
        .flatten()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(detect_shell);
    // Hermes inline suggestions on (default) → disable the shell's own
    // autosuggestion plugins so the two don't overlap.
    let disable_native_suggestions = crate::pty::shell_integration::hermes_suggestions_enabled(
        state
            .db
            .lock()
            .ok()
            .and_then(|db| db.get_setting("shell_suggestions").ok().flatten())
            .as_deref(),
    );
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

    let mut mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
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
        permission_mode: permission_mode.unwrap_or_else(|| {
            if auto_approve.unwrap_or(false) {
                "bypassPermissions".to_string()
            } else {
                "default".to_string()
            }
        }),
        custom_prefix: custom_prefix.unwrap_or_default(),
        custom_suffix: custom_suffix.unwrap_or_default(),
        agent_name: agent_name.unwrap_or_default(),
        agent_command: agent_command.unwrap_or_default(),
        channels: channels.unwrap_or_default(),
        context_injected: false,
        has_initial_context: ssh_host.is_none()
            && project_ids.as_ref().is_some_and(|ids| !ids.is_empty()),
        last_nudged_version: 0,
        pending_nudge: None,
        ssh_info: ssh_host.as_ref().map(|host| SshConnectionInfo {
            host: host.clone(),
            port: ssh_port.unwrap_or(22),
            user: resolve_ssh_user(ssh_user),
            tmux_session: tmux_session.clone(),
            identity_file: ssh_identity_file.clone(),
            jump_host: normalize_jump_host(ssh_jump_host.as_deref()).map(str::to_string),
            port_forwards: Vec::new(),
        }),
        mode: session_mode,
        vendor_session_id: vendor_session_id.filter(|id| !id.is_empty()),
        agent_startup: None,
        launch_helper: launch_helper.unwrap_or(false),
    };

    // ─── Agent-mode short-circuit ───────────────────────────────────────
    //
    // For agent-mode sessions (Claude-only in 1.0.0) we skip PTY spawn
    // entirely.  The frontend is responsible for calling
    // `spawn_agent_session` after this returns to bring up the Claude
    // subprocess; here we only need to:
    //
    //   1. Persist the session row so subsequent get_session_* calls work.
    //   2. Attach project_ids exactly like the terminal path does.
    //   3. Emit `session-updated` so the UI can render `<AgentSessionView>`
    //      immediately, even before the agent has fully booted.
    //
    // Note: `mgr` (the PtyManager guard) is held above; we don't insert a
    // PtySession into it for agent-mode sessions because there is no PTY.
    // That's fine — code that iterates `mgr.sessions` will simply skip
    // agent sessions, and writes via `write_to_session` will return a
    // "not found" error, which is the right behaviour (composer should
    // route through `send_agent_input` instead).
    if session.mode == SessionMode::Agent {
        // Mark the session as ready for input — there's no shell prompt to
        // wait for in agent mode, the agent subprocess takes over input
        // handling immediately.
        let mut s = session;
        s.phase = SessionPhase::ShellReady;

        // Resolve project_ids → paths and fold them into workspace_paths
        // BEFORE emitting `session-updated`.  The frontend reads
        // `session.workspace_paths` to build the SDK's `--add-dir` list when
        // it calls `spawn_agent_session`, so if we don't populate it here
        // the agent boots with a single-directory sandbox even when the
        // user attached multiple repos in the creator.
        //
        // Include EVERY attached project path, even one that equals
        // `working_directory` — that path is still a "project" from the
        // user's perspective, and the Hermes MCP `list_projects` tool
        // reads the same list to tell Claude what's attached.  Dropping
        // the cwd-equal entry made `list_projects` reply with N-1
        // projects ("the user attached two but Claude only sees one"
        // bug).  The SDK is fine with the cwd appearing in
        // additionalDirectories — it's redundant, not harmful.
        if let Some(ref ids) = project_ids {
            if let Ok(db) = state.db.lock() {
                for proj_id in ids {
                    if let Ok(Some(proj)) = db.get_project(proj_id) {
                        let p = proj.path;
                        if !p.is_empty() && !s.workspace_paths.iter().any(|w| w == &p) {
                            s.workspace_paths.push(p);
                        }
                    }
                }
            }
        }

        let result = SessionUpdate::from(&s);
        let _ = app.emit("session-updated", &result);

        // Drop the PTY-manager lock before touching the DB so we don't hold
        // two locks at once.
        drop(mgr);

        if let Ok(db) = state.db.lock() {
            db.create_session_v2(&result).ok();
            if let Some(ref ids) = project_ids {
                for proj_id in ids {
                    db.attach_session_project(&session_id, proj_id, "primary")
                        .ok();
                    db.upsert_project_usage(proj_id).ok();
                }
                if !ids.is_empty() {
                    crate::project::attunement::write_session_context_file(&app, &db, &session_id)
                        .ok();
                }
            }
        }
        return Ok(result);
    }

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
    let pty_size = PtySize {
        rows: pty_rows,
        cols: pty_cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = pty_system
        .openpty(pty_size)
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    // Workaround: portable-pty's openpty() does not apply the initial window
    // size on macOS — get_size() returns (0, 0) right after creation.
    // Explicitly resize to ensure the PTY starts with the correct dimensions.
    let _ = pair.master.resize(pty_size);

    let is_ssh = ssh_info_clone.is_some();

    // Set up shell integration (disables conflicting autosuggestion plugins).
    // Only for local sessions — SSH sessions run on the remote host where we
    // can't create temp files.
    let shell_integration = if !is_ssh {
        crate::pty::shell_integration::setup(&shell, &session_id, disable_native_suggestions)
    } else {
        crate::pty::shell_integration::ShellIntegration::None
    };

    let mut cmd = if let Some(ref info) = ssh_info_clone {
        ssh_pty_command(info, pty_cols, pty_rows)
    } else {
        #[cfg(unix)]
        {
            let mut c = CommandBuilder::new("env");
            c.arg("-u");
            c.arg("CLAUDECODE");
            c.arg("-u");
            c.arg("CLAUDE_CODE");
            // Strip COLUMNS/LINES so the shell reads actual PTY dimensions
            // from ioctl instead of inheriting stale values from the GUI app.
            c.arg("-u");
            c.arg("COLUMNS");
            c.arg("-u");
            c.arg("LINES");
            c.arg(&shell);

            // Shell-specific launch args depend on integration type
            match &shell_integration {
                crate::pty::shell_integration::ShellIntegration::Bash { rcfile } => {
                    // --rcfile replaces -l; the init script manually sources
                    // /etc/profile and ~/.bash_profile for login-like behavior.
                    c.arg("--rcfile");
                    c.arg(rcfile.to_string_lossy().as_ref());
                }
                crate::pty::shell_integration::ShellIntegration::Fish => {
                    c.arg("-l");
                    c.arg("-C");
                    c.arg(crate::pty::shell_integration::fish_init_command(
                        disable_native_suggestions,
                    ));
                }
                _ => {
                    // Zsh, unknown, or no integration — use login shell
                    c.arg("-l");
                }
            }
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

    // Apply ZDOTDIR env vars for zsh shell integration
    if let crate::pty::shell_integration::ShellIntegration::Zsh { ref zdotdir } = shell_integration
    {
        // Preserve the user's current ZDOTDIR (or HOME) so our .zshenv can
        // restore it before sourcing the user's real .zshenv.
        let original = std::env::var("ZDOTDIR").unwrap_or_else(|_| {
            crate::platform::home_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default()
        });
        let zdotdir_str = zdotdir.to_string_lossy();
        log::info!(
            "[SHELL-INTEGRATION] Setting ZDOTDIR={:?}, HERMES_ORIGINAL_ZDOTDIR={:?}",
            zdotdir,
            original
        );
        cmd.env("HERMES_ORIGINAL_ZDOTDIR", &original);
        cmd.env("ZDOTDIR", zdotdir_str.as_ref());
        // _HERMES_ZDOTDIR remembers our temp dir path so each wrapper script
        // can re-point ZDOTDIR back after sourcing the user's file.
        cmd.env("_HERMES_ZDOTDIR", zdotdir_str.as_ref());
    } else {
        log::info!(
            "[SHELL-INTEGRATION] No zsh integration (variant: {})",
            if shell_integration.is_active() {
                "active-non-zsh"
            } else {
                "none"
            }
        );
    }

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
        if let Ok(context_path) =
            crate::project::attunement::session_context_path(&app, &session_id)
        {
            cmd.env("HERMES_CONTEXT", context_path.to_string_lossy().as_ref());
        }
        cmd.env("HERMES_SESSION_ID", &session_id);

        // The bundled `hi` helper, only while the `launchHelper` flag is on
        // (a stable user's PATH stays exactly as it was): first on PATH for
        // this terminal so `hi run` is unambiguous (the shell integration
        // re-adds it after the user's profile ran), plus where it finds the
        // session's launch file. The PATH it goes in front of is the one the
        // terminal would get anyway (on Windows the terminal library rebuilds
        // it from the registry, not from this process).
        if launch_helper.unwrap_or(false) {
            if let Some(dir) = crate::pty::launch::hi_path(&app)
                .and_then(|hi| hi.parent().map(|d| d.to_path_buf()))
            {
                let mut paths = vec![dir.clone()];
                if let Some(existing) = cmd.get_env("PATH").map(|p| p.to_os_string()) {
                    paths.extend(std::env::split_paths(&existing));
                }
                if let Ok(joined) = std::env::join_paths(paths) {
                    cmd.env("PATH", joined);
                }
                cmd.env("HERMES_BIN_DIR", dir.as_os_str());
            }
            if let Ok(launch_dir) = crate::pty::launch::launch_dir(&app) {
                cmd.env("HERMES_LAUNCH_DIR", launch_dir.as_os_str());
            }
        }
    }

    // On macOS, portable-pty's spawn_command() uses fork() + pre_exec which
    // crashes in multi-threaded processes ("multi-threaded process forked").
    // Use posix_spawn() instead which atomically creates the child process.
    // See issue #31 and issue-31-investigation.md.
    #[cfg(target_os = "macos")]
    let child = {
        let tty_path = pair
            .master
            .tty_name()
            .ok_or_else(|| "Failed to get PTY device path for posix_spawn".to_string())?;
        // Drop the slave end — the child opens the TTY by path via posix_spawn
        // file actions.  CTT assignment is handled by the --pty-setup trampoline.
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
    let writer_for_silence = Arc::clone(&writer);

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
        // Wrap the reader loop in catch_unwind so that a panic inside the
        // reader (e.g. in portable_pty or output analysis) does NOT poison
        // the shared session/analyzer Mutexes.  Without this, one crashed
        // reader thread would make every subsequent Tauri command fail with
        // PoisonError, eventually leading to a double-panic SIGABRT.
        let session_for_cleanup = Arc::clone(&session_clone);
        let app_for_cleanup = app_clone.clone();
        let exit_id = event_session_id.clone();

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let mut buf = [0u8; 4096];
            let mut last_metrics_emit = std::time::Instant::now();

            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        if let Ok(mut s) = session_clone.lock() {
                            s.phase = if s.ssh_info.is_some() {
                                SessionPhase::Disconnected
                            } else {
                                SessionPhase::Destroyed
                            };
                            let update = SessionUpdate::from(&*s);
                            let _ = app_clone.emit("session-updated", &update);
                        }
                        let _ = app_clone.emit(&format!("pty-exit-{}", event_session_id), ());
                        break;
                    }
                    Ok(n) => {
                        // Session was closed but something still holds the PTY
                        // open (e.g. a TUI that ignored SIGHUP).  Stop reading so
                        // we never re-announce a closed session; exiting also
                        // drops our master fd so the kernel hangs up the PTY.
                        if session_clone
                            .lock()
                            .map(|s| s.phase == SessionPhase::Destroyed)
                            .unwrap_or(false)
                        {
                            break;
                        }
                        let data = &buf[..n];

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

                            if let Some(new_phase) = a.take_pending_phase() {
                                if let Ok(mut s) = session_clone.lock() {
                                    if s.phase.can_transition_to(&new_phase) {
                                        s.phase = new_phase.clone();
                                        s.last_activity_at = now();
                                        s.detected_agent = a.detected_agent.clone();
                                        // Skip expensive to_metrics() clone here — the periodic
                                        // 5-second emit will pick up metrics. Phase changes only
                                        // need phase + agent + activity timestamp.
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
                            // Skip metrics clone here — only update agent info which
                            // is the lightweight field that actually changed.
                            if a.detected_agent.is_some() {
                                if let Ok(mut s) = session_clone.lock() {
                                    if agent_model_needs_emit(&s.detected_agent, &a.detected_agent)
                                    {
                                        if s.detected_agent.is_none() {
                                            s.last_activity_at = now();
                                        }
                                        s.detected_agent = a.detected_agent.clone();
                                        let update = SessionUpdate::from(&*s);
                                        let _ = app_clone.emit("session-updated", &update);
                                    }
                                }
                            }

                            // Auto-launch AI agent when shell is ready
                            if a.pending_ai_launch {
                                a.pending_ai_launch = false;
                                if let Some(launch) =
                                    resolve_agent_launch(&app_clone, &session_clone)
                                {
                                    // Set up "command not found" detection window
                                    a.ai_launching_provider = Some(launch.provider.clone());
                                    a.ai_launch_check_remaining = 10; // scan next 10 lines
                                    if let Ok(mut w) = writer_for_reader.lock() {
                                        let _ = w.write_all(format!("{}\r", launch.cmd).as_bytes());
                                        let _ = w.flush();
                                    }
                                    // Mark context as injected if it was baked into the launch command
                                    if launch.context_in_args {
                                        a.context_injected = true;
                                    }
                                    if let Ok(mut s) = session_clone.lock() {
                                        if launch.context_in_args {
                                            s.context_injected = true;
                                        }
                                        s.phase = SessionPhase::LaunchingAgent;
                                        let update = SessionUpdate::from(&*s);
                                        let _ = app_clone.emit("session-updated", &update);
                                    }
                                    if let Some((dir, expects_start_signal, nonce)) = launch.watch {
                                        crate::pty::launch::watch_signals(
                                            app_clone.clone(),
                                            Arc::clone(&session_clone),
                                            dir,
                                            expects_start_signal,
                                            nonce,
                                        );
                                    }
                                }
                            }

                            // Emit event if AI CLI was not found
                            if let Some(failed_provider) = a.ai_launch_failed.take() {
                                let _ = app_clone.emit("ai-launch-failed", &failed_provider);
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

                            // Throttle periodic metrics emission to at most once per 5 seconds
                            if last_metrics_emit.elapsed() >= std::time::Duration::from_secs(5) {
                                last_metrics_emit = std::time::Instant::now();
                                if let Ok(mut s) = session_clone.lock() {
                                    s.detected_agent = a.detected_agent.clone();
                                    s.metrics = a.to_metrics();
                                    // Don't update last_activity_at here — periodic metrics
                                    // syncs shouldn't be treated as user/output activity.
                                    // Phase-change paths already set it on real activity.
                                    let update = SessionUpdate::from(&*s);
                                    let _ = app_clone.emit("session-updated", &update);
                                }
                            }
                        }

                        use base64::Engine;
                        let encoded = base64::engine::general_purpose::STANDARD.encode(data);
                        let _ =
                            app_clone.emit(&format!("pty-output-{}", event_session_id), encoded);
                    }
                    Err(_) => {
                        if let Ok(mut s) = session_clone.lock() {
                            s.phase = if s.ssh_info.is_some() {
                                SessionPhase::Disconnected
                            } else {
                                SessionPhase::Destroyed
                            };
                            let update = SessionUpdate::from(&*s);
                            let _ = app_clone.emit("session-updated", &update);
                        }
                        let _ = app_clone.emit(&format!("pty-exit-{}", event_session_id), ());
                        break;
                    }
                }
            }
        })); // end catch_unwind

        // If the reader panicked, ensure the session is marked destroyed so
        // the frontend doesn't hang waiting for output that will never come.
        if let Err(panic_info) = result {
            log::error!(
                "PTY reader thread panicked for session {}: {:?}",
                exit_id,
                panic_info.downcast_ref::<String>().or_else(|| panic_info
                    .downcast_ref::<&str>()
                    .map(|s| {
                        // Cannot return &String from &&str, just log it
                        let _ = s;
                        &exit_id // dummy — the log::error above already captured it
                    }))
            );
            if let Ok(mut s) = session_for_cleanup.lock() {
                s.phase = if s.ssh_info.is_some() {
                    SessionPhase::Disconnected
                } else {
                    SessionPhase::Destroyed
                };
            }
            let _ = app_for_cleanup.emit(&format!("pty-exit-{}", exit_id), ());
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
                // Check if session is destroyed → stop.
                // Acquire and release session lock quickly — never hold both locks.
                let is_stopped = session_silence
                    .lock()
                    .ok()
                    .map(|s| {
                        matches!(
                            s.phase,
                            SessionPhase::Destroyed | SessionPhase::Disconnected
                        )
                    })
                    .unwrap_or(false);
                if is_stopped {
                    break;
                }

                // Phase 1: acquire ONLY the analyzer lock, compute state changes.
                // Collect everything we need, then release the lock before touching session.
                let silence_result = if let Ok(mut a) = analyzer_silence.lock() {
                    if let Some(last) = a.last_output_at {
                        if a.is_busy && last.elapsed() >= silence_threshold {
                            a.check_silence();
                            let new_phase = a.take_pending_phase();
                            let detected_agent = a.detected_agent.clone();
                            let metrics = if new_phase.is_some() {
                                Some(a.to_metrics())
                            } else {
                                None
                            };

                            // Check fallback auto-launch
                            let launch_info = if a.pending_ai_launch {
                                a.pending_ai_launch = false;
                                Some(a.context_injected)
                            } else {
                                None
                            };

                            Some((new_phase, detected_agent, metrics, launch_info))
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    None
                };
                // ← analyzer lock is RELEASED here

                // Phase 2: apply state changes using ONLY the session lock.
                if let Some((new_phase, detected_agent, metrics, launch_info)) = silence_result {
                    if let Some(new_phase) = new_phase {
                        if let (Some(metrics), Ok(mut s)) = (metrics, session_silence.lock()) {
                            if s.phase.can_transition_to(&new_phase) {
                                s.phase = new_phase.clone();
                                s.detected_agent = detected_agent;
                                s.metrics = metrics;
                                s.last_activity_at = now();
                                let update = SessionUpdate::from(&*s);
                                let _ = app_silence.emit("session-updated", &update);
                            }
                        }
                    }

                    // Fallback auto-launch
                    if launch_info.is_some() {
                        if let Some(launch) = resolve_agent_launch(&app_silence, &session_silence) {
                            if let Ok(mut w) = writer_for_silence.lock() {
                                let _ = w.write_all(format!("{}\r", launch.cmd).as_bytes());
                                let _ = w.flush();
                            }
                            // Update session state — need analyzer lock for context_injected
                            if launch.context_in_args {
                                if let Ok(mut a) = analyzer_silence.lock() {
                                    a.context_injected = true;
                                }
                            }
                            if let Ok(mut s) = session_silence.lock() {
                                if launch.context_in_args {
                                    s.context_injected = true;
                                }
                                s.phase = SessionPhase::LaunchingAgent;
                                let update = SessionUpdate::from(&*s);
                                let _ = app_silence.emit("session-updated", &update);
                            }
                            if let Some((dir, expects_start_signal, nonce)) = launch.watch {
                                crate::pty::launch::watch_signals(
                                    app_silence.clone(),
                                    Arc::clone(&session_silence),
                                    dir,
                                    expects_start_signal,
                                    nonce,
                                );
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
        shell_integration,
        hermes_suggestions: disable_native_suggestions,
    };
    mgr.sessions.insert(session_id.clone(), pty_session);

    // Save to DB
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.create_session_v2(&result).ok();

        // Attach projects if provided
        if let Some(ref ids) = project_ids {
            for proj_id in ids {
                db.attach_session_project(&session_id, proj_id, "primary")
                    .ok();
                // Track project usage for smart ordering
                db.upsert_project_usage(proj_id).ok();
            }
            // Write context file so AI agents can read project info
            // (only for local sessions — the file isn't accessible over SSH)
            if !is_ssh && !ids.is_empty() {
                crate::project::attunement::write_session_context_file(&app, &db, &session_id).ok();
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
            fn proc_listchildpids(
                ppid: libc::pid_t,
                buffer: *mut libc::c_void,
                buffersize: libc::c_int,
            ) -> libc::c_int;
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
    let mut mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
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

    // ── Direct SIGINT delivery (macOS only) ──
    //
    // Writing \x03 to the PTY master should cause the line discipline to
    // generate SIGINT for the foreground process group.  However, on macOS
    // with posix_spawn-based PTY sessions the signal sometimes doesn't
    // reach the child.  As a reliable fallback we:
    //   1. Try tcgetpgrp() on the slave device to find the foreground pgrp.
    //   2. If that fails (it does from a non-session-leader process), send
    //      SIGINT to every child of the shell using sysctl/proc enumeration.
    //
    // This must stay macOS-only (issue #394): the PTY line discipline
    // already delivers SIGINT reliably on Linux (see the definitive test in
    // spawn.rs), so also firing this fallback there sent SIGINT twice per
    // Ctrl-C — bash then misreports $? or drops the next typed line.
    #[cfg(target_os = "macos")]
    if bytes.contains(&0x03) {
        // Diagnostic: check termios on the slave to see if ISIG is enabled
        // Send SIGINT to the shell's child processes directly.
        // The shell's PID is known; we enumerate its children via sysctl
        // and send SIGINT to each child's process group.
        if let Some(shell_pid) = session.child.process_id() {
            let child_pids = enumerate_child_pids(shell_pid);
            if !child_pids.is_empty() {
                for &cpid in &child_pids {
                    if cpid > 0 && cpid <= i32::MAX as u32 {
                        unsafe {
                            // Send to the child's process group (covers the child
                            // and any of its own children)
                            libc::kill(-(cpid as i32), libc::SIGINT);
                        }
                    }
                }
            } else {
                // No children found — the shell is at the prompt.
                // Send to the shell's own process group so it sees the interrupt.
                if shell_pid > 0 && shell_pid <= i32::MAX as u32 {
                    unsafe {
                        libc::kill(-(shell_pid as i32), libc::SIGINT);
                    }
                }
            }
        }
    }
    Ok(())
}

/// Check whether the shell is the foreground process in the PTY.
///
/// Returns `true` when the shell itself owns the terminal's foreground process
/// group — i.e. the user is at a shell prompt and no child program (Claude Code,
/// vim, htop, etc.) is running in the foreground.
///
/// Strategy:
///   1. macOS and Linux — `tcgetpgrp()` on the PTY master gives the
///      terminal's foreground process group; compare it with the shell's.
///      (The slave side cannot be used: on macOS `tcgetpgrp()` on a terminal
///      that is not this process's controlling terminal fails with ENOTTY.)
///   2. Linux fallback — read `/proc/{pid}/stat` to obtain `pgrp` and `tpgid`.
///   3. Windows (no process groups on a pseudo console) and the last Unix
///      fallback — the shell is at its prompt when it has no child process.
///      A program the shell started, such as an agent CLI, is its child.
///      Without process groups a background job (`npm run dev &`) cannot be
///      told apart from a foreground one, so on Windows suggestions also stay
///      off while the shell has one running. Erring that way never draws over
///      an agent.
///
/// The frontend asks every 300 ms and before each suggestion. The check runs
/// on a blocking thread, and the PTY manager lock is held only for step 1:
/// keystrokes are written under the same lock, and steps 2 and 3 (the Windows
/// one scans the whole process table) must never make typing wait.
#[tauri::command]
pub async fn is_shell_foreground(app: AppHandle, session_id: String) -> Result<bool, String> {
    use tauri::Manager;
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        foreground_lock_released_for_scan(
            &state.pty_manager,
            |mgr| {
                let probe = probe_foreground(mgr, &session_id);
                #[cfg(feature = "e2e")]
                let probe = e2e_slow_foreground::probe(probe);
                probe
            },
            |shell_pid| {
                #[cfg(feature = "e2e")]
                e2e_slow_foreground::scan();
                shell_at_prompt_by_process_table(shell_pid)
            },
        )
    })
    .await
    .map_err(|e| format!("Foreground check failed: {}", e))?
}

/// Run `probe` under the PTY manager lock and, only after releasing it,
/// `scan` when the probe could not tell. `probe` gives the shell's pid and,
/// when the terminal can say, whether the shell owns it; `scan` answers from
/// the process table.
fn foreground_lock_released_for_scan<M>(
    manager: &StdMutex<M>,
    probe: impl FnOnce(&M) -> Result<(u32, Option<bool>), String>,
    scan: impl FnOnce(u32) -> bool,
) -> Result<bool, String> {
    let (shell_pid, from_terminal) = {
        let mgr = manager.lock().unwrap_or_else(|e| e.into_inner());
        probe(&mgr)?
    };
    match from_terminal {
        Some(owns) => Ok(owns),
        None => Ok(scan(shell_pid)),
    }
}

/// The session's shell pid and, on Unix, whether its process group is the
/// terminal's foreground group (one `tcgetpgrp()` on the master).
fn probe_foreground(
    mgr: &super::PtyManager,
    session_id: &str,
) -> Result<(u32, Option<bool>), String> {
    let session = mgr
        .sessions
        .get(session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;
    let shell_pid = session
        .child
        .process_id()
        .ok_or_else(|| "Shell process ID not available".to_string())?;
    #[cfg(unix)]
    let from_master = shell_group_is_foreground(session.master.as_ref(), shell_pid);
    #[cfg(not(unix))]
    let from_master: Option<bool> = None;
    Ok((shell_pid, from_master))
}

/// Whether the shell is at its prompt, from the process table (steps 2 and 3
/// above). Slow on Windows; never call it holding the PTY manager lock.
fn shell_at_prompt_by_process_table(shell_pid: u32) -> bool {
    // ── Linux: read tpgid from /proc/{pid}/stat ──
    #[cfg(target_os = "linux")]
    {
        if let Ok(stat) = std::fs::read_to_string(format!("/proc/{}/stat", shell_pid)) {
            // stat format: pid (comm) state ppid pgrp session tty_nr tpgid ...
            // comm can contain spaces/parens — find the last ')' first.
            if let Some(after_comm) = stat.rfind(')').map(|i| &stat[i + 2..]) {
                let fields: Vec<&str> = after_comm.split_whitespace().collect();
                // fields: [0]=state [1]=ppid [2]=pgrp [3]=session [4]=tty_nr [5]=tpgid
                if fields.len() > 5 {
                    if let (Ok(pgrp), Ok(tpgid)) =
                        (fields[2].parse::<i32>(), fields[5].parse::<i32>())
                    {
                        return tpgid == pgrp;
                    }
                }
            }
        }
    }

    // ── Fallback: no direct children → shell is at prompt ──
    #[cfg(unix)]
    {
        enumerate_child_pids(shell_pid).is_empty()
    }
    #[cfg(not(unix))]
    {
        !has_child_process(shell_pid)
    }
}

/// e2e builds only: make the foreground check slow on purpose, so the
/// real-app scenario F03-foreground-check-lock can show that typing does not
/// wait for it. `HERMES_E2E_FOREGROUND_SCAN_MS` sends every check down the
/// process-table path and makes that scan take this long. With
/// `HERMES_E2E_FOREGROUND_SCAN_UNDER_LOCK=1` the delay is spent while the
/// PTY manager lock is held instead (the scenario's negative control).
#[cfg(feature = "e2e")]
mod e2e_slow_foreground {
    use std::time::Duration;

    fn delay() -> Option<Duration> {
        std::env::var("HERMES_E2E_FOREGROUND_SCAN_MS")
            .ok()?
            .parse()
            .ok()
            .map(Duration::from_millis)
    }

    fn under_lock() -> bool {
        std::env::var("HERMES_E2E_FOREGROUND_SCAN_UNDER_LOCK").as_deref() == Ok("1")
    }

    /// Runs under the lock.
    pub fn probe(
        probe: Result<(u32, Option<bool>), String>,
    ) -> Result<(u32, Option<bool>), String> {
        let Some(delay) = delay() else { return probe };
        if under_lock() {
            std::thread::sleep(delay);
        }
        probe.map(|(pid, _)| (pid, None))
    }

    /// Runs with the lock released.
    pub fn scan() {
        if let Some(delay) = delay() {
            if !under_lock() {
                std::thread::sleep(delay);
            }
        }
    }
}

/// Whether the shell's process group is the terminal's foreground process
/// group, or `None` when either cannot be read.
#[cfg(unix)]
fn shell_group_is_foreground(
    master: &(dyn portable_pty::MasterPty + Send),
    shell_pid: u32,
) -> Option<bool> {
    let foreground = master.process_group_leader()?;
    let shell_pgid = unsafe { libc::getpgid(shell_pid as i32) };
    if shell_pgid <= 0 {
        return None;
    }
    Some(foreground == shell_pgid)
}

/// Whether any running process has `parent_pid` as its parent and counts as
/// a program the shell started (see [`counts_as_shell_child`]).
#[cfg(any(not(unix), test))]
fn has_child_process(parent_pid: u32) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let parent = Pid::from_u32(parent_pid);
    let parent_started = sys.process(parent).map_or(0, |p| p.start_time());
    sys.processes().values().any(|p| {
        p.parent() == Some(parent)
            && counts_as_shell_child(parent_started, p.start_time(), &p.name().to_string_lossy())
    })
}

/// Whether a process whose parent id is the shell's pid is a program the
/// shell started. Start times are in whole seconds since the epoch; 0 means
/// the OS would not say (Windows cannot open some processes).
///
/// - Windows reuses process ids and keeps an orphan's old parent id, so a
///   process that started before the shell was the child of an earlier
///   process with the same id: it does not count.
/// - The times have one-second granularity. A child started in the same
///   second as the shell counts; so does an orphan of a reused id started
///   in that second, which only keeps suggestions off (never draws over an
///   agent).
/// - An unknown time counts, for the same reason.
/// - The console host Windows may start for a console program is not a
///   program the user ran, so it does not count.
#[cfg(any(not(unix), test))]
fn counts_as_shell_child(shell_started: u64, started: u64, name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    if name == "conhost.exe" || name == "openconsole.exe" {
        return false;
    }
    shell_started == 0 || started == 0 || started >= shell_started
}

#[tauri::command]
pub fn nudge_project_context(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<bool, String> {
    // Check if there are projects attached
    let has_context = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let projects = db.get_session_projects(&session_id)?;
        !projects.is_empty()
    };

    if !has_context {
        return Ok(false);
    }

    let mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
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
    let mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
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

    // Explicitly send SIGWINCH to the child process.
    // On macOS with posix_spawn(POSIX_SPAWN_SETSID), ioctl(TIOCSWINSZ) on the
    // master fd does NOT automatically deliver SIGWINCH because the parent
    // process is in a different session than the child.  tcgetpgrp() returns -1
    // from the parent's context.  Send SIGWINCH directly to the child's process
    // group (negative PID = entire process group) so the shell and its children
    // pick up the new terminal dimensions.
    #[cfg(unix)]
    {
        if let Some(child_pid) = session.child.process_id() {
            if child_pid > 0 && child_pid <= i32::MAX as u32 {
                let pgid = child_pid as i32;
                unsafe {
                    // Send to the process group (negative PID), not just the shell.
                    // This ensures child processes (e.g. Claude Code) also receive it.
                    libc::kill(-(pgid), libc::SIGWINCH);
                }
            }
        }
    }

    // Sync remote tmux dimensions when resizing SSH+tmux sessions.
    // Fire-and-forget on a background thread so resize doesn't block.
    let ssh_tmux_info = session.session.lock().ok().and_then(|s| {
        s.ssh_info.as_ref().and_then(|info| {
            info.tmux_session.as_ref().map(|tmux_name| {
                (
                    info.user.clone(),
                    info.host.clone(),
                    info.port,
                    info.jump_host.clone(),
                    tmux_name.clone(),
                )
            })
        })
    });
    if let Some((user, host, port, jump_host, tmux_name)) = ssh_tmux_info {
        let resize_cols = cols;
        let resize_rows = rows;
        thread::spawn(move || {
            let remote_cmd = format!(
                "tmux resize-window -t '{}' -x {} -y {}",
                tmux_name.replace('\'', "'\\''"),
                resize_cols,
                resize_rows
            );
            let _ = ssh_exec(&user, &host, port, jump_host.as_deref(), &remote_cmd);
        });
    }

    Ok(())
}

/// Whether the analyzer's agent info should be pushed to the session and
/// emitted: first detection, or any model change (None→Some and Some(a)→Some(b),
/// e.g. `/model sonnet` → `/model opus`).
fn agent_model_needs_emit(current: &Option<AgentInfo>, detected: &Option<AgentInfo>) -> bool {
    match (current, detected) {
        (None, Some(_)) => true,
        (Some(cur), Some(new)) => new.model.is_some() && cur.model != new.model,
        _ => false,
    }
}

/// Drain the DB-side state for `session_id`: mark the session as
/// destroyed, clean up session-scoped pins, and dispose of every linked
/// worktree row that does NOT require filesystem removal (main worktrees
/// + worktrees still referenced by another session — i.e. shared).
///
/// Returns the remaining worktree rows that DO require `git worktree
/// remove`; the caller is responsible for running disk removal and then
/// calling `delete_session_worktree` for each row that was successfully
/// removed.  Failed disk removals leave their rows in place so they can
/// be retried on next startup.
///
/// This helper is mode-agnostic: it runs for both terminal and agent
/// sessions.  Bug 1 (1.2.x): before this extraction, every line of
/// close-time cleanup sat inside `if let Some(_) = mgr.sessions.remove(...)`,
/// which is always `None` for agent sessions — so worktrees, DB rows,
/// pins, and status updates all leaked on agent close.
pub fn drain_session_db_state(db: &Database, session_id: &str) -> Vec<SessionWorktreeRow> {
    // Status + pin cleanup are best-effort: an UPDATE against a missing
    // session row is a no-op, and pin cleanup just returns 0.  We swallow
    // errors here so a single failure doesn't block the worktree pass.
    let _ = db.update_session_status(session_id, "destroyed");
    let _ = db.cleanup_session_pins(session_id);

    let worktrees = match db.get_session_worktrees(session_id) {
        Ok(rows) => rows,
        Err(e) => {
            log::warn!(
                "drain_session_db_state: get_session_worktrees('{}') failed: {}",
                session_id,
                e,
            );
            return Vec::new();
        }
    };

    let mut needs_disk_removal: Vec<SessionWorktreeRow> = Vec::new();

    for wt in worktrees {
        if wt.is_main_worktree {
            // Main worktrees live in the project repo itself; close must
            // never remove them from disk.  Drop the link row.
            if let Err(e) = db.delete_session_worktree(&wt.id) {
                log::warn!("Failed to delete main-worktree DB row '{}': {}", wt.id, e,);
            }
            continue;
        }

        let ref_count = db
            .count_sessions_for_worktree_path(&wt.worktree_path)
            .unwrap_or(1);
        if ref_count > 1 {
            // Another session still references this path — drop our row
            // only, leave the disk alone.  Tests guarantee the surviving
            // session keeps its own row.
            if let Err(e) = db.delete_session_worktree(&wt.id) {
                log::warn!("Failed to delete shared-worktree DB row '{}': {}", wt.id, e,);
            }
            continue;
        }

        // Owned, non-main, non-shared — caller must run `git worktree
        // remove` THEN `delete_session_worktree`.
        needs_disk_removal.push(wt);
    }

    needs_disk_removal
}

/// Filesystem half of the worktree cleanup: for each owned worktree,
/// run `git worktree remove` and delete the DB row on success.  Failures
/// leave the row in place so they can be retried on next launch, and
/// emit `worktree-cleanup-failed` so the UI can surface them.
///
/// Always runs `git worktree prune` for every distinct repo touched so
/// stale `.git/worktrees/<ref>` entries don't accumulate even when the
/// directory was already gone.
fn remove_owned_worktrees_from_disk(
    app: &AppHandle,
    db: &Database,
    session_id: &str,
    worktrees: Vec<SessionWorktreeRow>,
) {
    let mut repos_to_prune: std::collections::HashSet<String> = std::collections::HashSet::new();

    for wt in worktrees {
        let Ok(Some(proj)) = db.get_project(&wt.project_id) else {
            // Project gone — we can't locate the parent repo to run
            // `git worktree remove`, but we can still drop the dangling
            // DB row so it doesn't accumulate.
            if let Err(e) = db.delete_session_worktree(&wt.id) {
                log::warn!("Failed to delete orphan-worktree DB row '{}': {}", wt.id, e,);
            }
            continue;
        };

        repos_to_prune.insert(proj.path.clone());

        match crate::git::worktree::remove_worktree(&proj.path, session_id, &wt.worktree_path) {
            Ok(()) => {
                if let Err(e) = db.delete_session_worktree(&wt.id) {
                    log::warn!(
                        "Failed to delete worktree DB row '{}' after successful disk removal: {}",
                        wt.id,
                        e,
                    );
                }
            }
            Err(e) => {
                log::warn!(
                    "Failed to remove worktree '{}' for session '{}': {} — keeping DB record for retry",
                    wt.worktree_path,
                    session_id,
                    e,
                );
                let _ = app.emit(
                    "worktree-cleanup-failed",
                    serde_json::json!({
                        "sessionId": session_id,
                        "branchName": wt.branch_name.as_deref().unwrap_or("unknown"),
                        "error": e.to_string(),
                    }),
                );
            }
        }
    }

    for repo_path in &repos_to_prune {
        if let Err(e) = crate::git::worktree::cleanup_stale_worktrees(repo_path) {
            log::warn!(
                "git worktree prune failed for '{}' during session close: {}",
                repo_path,
                e,
            );
        }
    }
}

#[tauri::command]
pub fn close_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let mut mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());

    // ── PTY-only cleanup (terminal sessions) ────────────────────────
    // Pulled into its own block so we can release the PTY-manager lock
    // before touching the DB / filesystem.  Agent sessions never insert
    // into `mgr.sessions` — for them this branch is a no-op and the
    // mode-agnostic cleanup below runs unconditionally.
    if let Some(mut pty_session) = mgr.sessions.remove(&session_id) {
        // Kill the child shell process FIRST — it may still be using ZDOTDIR
        // temp files. Don't block on wait() since the process may be hung.
        pty_session.child.kill().ok();

        // Clean up shell integration temp files after killing the child
        crate::pty::shell_integration::cleanup(&pty_session.shell_integration);

        let mut child = pty_session.child;
        thread::spawn(move || {
            child.wait().ok();
        });

        // Save snapshot and persist token data.  Note: status update +
        // pin cleanup + worktree removal used to live in this block — for
        // Bug 1 (1.2.x) those moved into the mode-agnostic section below
        // so agent sessions get the same treatment.
        if let Ok(analyzer) = pty_session.analyzer.lock() {
            let snapshot = analyzer.get_stripped_output();
            let metrics = analyzer.to_metrics();
            if let Ok(db) = state.db.lock() {
                db.save_session_snapshot(&session_id, &snapshot).ok();
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
    }

    // ── Mode-agnostic cleanup ───────────────────────────────────────
    // Runs for EVERY close, terminal or agent.  Without this, agent
    // sessions leaked worktrees, DB rows, pins, the session-removed
    // event, and the "destroyed" status — because the entire body above
    // is unreachable when `mgr.sessions.remove(...)` returns None.
    drop(mgr); // release PTY-manager lock before touching DB / filesystem
    let _ = app.emit("session-removed", &session_id);
    crate::project::attunement::delete_session_context_file(&app, &session_id);
    crate::pty::launch::remove_session_files(&app, &session_id);

    // Drop it from the saved workspace now: a quit right after this close
    // must not bring it back on the next launch.
    state.closed_sessions.mark_closed(&session_id);
    let closed = state.closed_sessions.snapshot();

    if let Ok(db) = state.db.lock() {
        if let Err(e) = crate::saved_workspace::prune_stored(&db, &closed) {
            log::warn!(
                "close_session: could not drop '{}' from the saved workspace: {}",
                session_id,
                e
            );
        }
        let needs_disk = drain_session_db_state(&db, &session_id);
        if !needs_disk.is_empty() {
            remove_owned_worktrees_from_disk(&app, &db, &session_id, needs_disk);
        }
    }

    Ok(())
}

#[tauri::command]
pub fn get_sessions(state: State<'_, AppState>) -> Result<Vec<SessionUpdate>, String> {
    let mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
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
    let mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
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
    let mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
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
    {
        let mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(session) = mgr.sessions.get(&session_id) {
            let mut s = session.session.lock().map_err(|e| e.to_string())?;
            s.label = label.clone();
            let update = SessionUpdate::from(&*s);
            let _ = app.emit("session-updated", &update);
            drop(s);
            let db = state.db.lock().map_err(|e| e.to_string())?;
            db.update_session_label(&session_id, &label)?;
            return Ok(());
        }
    }
    // Agent-mode (no PtySession): write to DB and emit the focused
    // metadata-update event so the frontend can merge into state.
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.update_session_label(&session_id, &label)?;
    let _ = app.emit(
        "session-metadata-updated",
        SessionMetadataUpdate {
            session_id,
            label: Some(label),
            ..Default::default()
        },
    );
    Ok(())
}

#[tauri::command]
pub fn update_session_description(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    description: String,
) -> Result<(), String> {
    {
        let mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(session) = mgr.sessions.get(&session_id) {
            let mut s = session.session.lock().map_err(|e| e.to_string())?;
            s.description = description.clone();
            let update = SessionUpdate::from(&*s);
            let _ = app.emit("session-updated", &update);
            drop(s);
            let db = state.db.lock().map_err(|e| e.to_string())?;
            db.update_session_description(&session_id, &description)?;
            return Ok(());
        }
    }
    // Agent-mode fallback.
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.update_session_description(&session_id, &description)?;
    let _ = app.emit(
        "session-metadata-updated",
        SessionMetadataUpdate {
            session_id,
            description: Some(description),
            ..Default::default()
        },
    );
    Ok(())
}

#[tauri::command]
pub fn update_session_color(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    color: String,
) -> Result<(), String> {
    {
        let mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(session) = mgr.sessions.get(&session_id) {
            let mut s = session.session.lock().map_err(|e| e.to_string())?;
            s.color = color.clone();
            let update = SessionUpdate::from(&*s);
            let _ = app.emit("session-updated", &update);
            drop(s);
            let db = state.db.lock().map_err(|e| e.to_string())?;
            db.update_session_color(&session_id, &color)?;
            return Ok(());
        }
    }
    // Agent-mode fallback.
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.update_session_color(&session_id, &color)?;
    let _ = app.emit(
        "session-metadata-updated",
        SessionMetadataUpdate {
            session_id,
            color: Some(color),
            ..Default::default()
        },
    );
    Ok(())
}

/// Add `path` to the session's `workspace_paths`.
///
/// Two storage layers depending on runtime mode:
///   - **Terminal sessions**: a PtySession lives in `pty_manager.sessions`;
///     mutate the in-memory `Session` struct so subsequent reads see the
///     new path immediately, and emit `session-updated` from there.
///   - **Agent sessions**: no PtySession entry exists.  Persist directly
///     to the `sessions` table so the next agent respawn picks the path
///     up via `--add-dir`, then read the row back to build the
///     `session-updated` payload (the source of truth for the frontend).
///
/// The earlier implementation only handled the terminal branch; agent
/// sessions silently no-op'd, which is the bug behind "I attached a
/// folder but Claude never saw it".
#[tauri::command]
pub fn add_workspace_path(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    {
        let mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(session) = mgr.sessions.get(&session_id) {
            let mut s = session.session.lock().map_err(|e| e.to_string())?;
            if !s.workspace_paths.contains(&path) {
                s.workspace_paths.push(path);
            }
            let update = SessionUpdate::from(&*s);
            let _ = app.emit("session-updated", &update);
            return Ok(());
        }
    }

    // Agent-mode (or restored) session: no PTY entry — go through the DB.
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut paths = db.get_session_workspace_paths(&session_id)?;
    if !paths.contains(&path) {
        paths.push(path);
    }
    db.update_session_workspace_paths(&session_id, &paths)?;
    let _ = app.emit(
        "session-workspace-paths-updated",
        WorkspacePathsUpdate {
            session_id: session_id.clone(),
            workspace_paths: paths,
        },
    );
    Ok(())
}

#[tauri::command]
pub fn remove_workspace_path(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    {
        let mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(session) = mgr.sessions.get(&session_id) {
            let mut s = session.session.lock().map_err(|e| e.to_string())?;
            s.workspace_paths.retain(|p| p != &path);
            let update = SessionUpdate::from(&*s);
            let _ = app.emit("session-updated", &update);
            return Ok(());
        }
    }

    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut paths = db.get_session_workspace_paths(&session_id)?;
    paths.retain(|p| p != &path);
    db.update_session_workspace_paths(&session_id, &paths)?;
    let _ = app.emit(
        "session-workspace-paths-updated",
        WorkspacePathsUpdate {
            session_id: session_id.clone(),
            workspace_paths: paths,
        },
    );
    Ok(())
}

/// Lightweight payload for `session-workspace-paths-updated`.  Used by
/// the agent-mode branches of `add_workspace_path` / `remove_workspace_path`
/// because rebuilding a full `SessionUpdate` from the DB row is a lot of
/// plumbing for a single-field change.  The frontend merges this into the
/// React-side `workspace_paths` of the matching session.
#[derive(serde::Serialize, Clone)]
struct WorkspacePathsUpdate {
    session_id: String,
    workspace_paths: Vec<String>,
}

/// Lightweight payload for `session-metadata-updated`.  Sibling of
/// WorkspacePathsUpdate above, but for the four metadata fields (label,
/// description, color, group).  Each field is `Option<...>`; only the
/// fields the IPC actually mutated are `Some`, the rest stay `None`
/// (and are skipped when serialized via `skip_serializing_if`).
///
/// Used by the agent-mode fallback in `update_session_label/description/
/// color/group` — terminal-mode keeps emitting the full `session-updated`
/// shape from in-memory state.
#[derive(serde::Serialize, Clone, Default)]
struct SessionMetadataUpdate {
    session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    color: Option<String>,
    /// Outer Option = "this field was set"; inner Option = "the new
    /// value is None" (group cleared).  `None` outer ⇒ field unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    group: Option<Option<String>>,
}

#[tauri::command]
pub fn update_session_group(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    group: Option<String>,
) -> Result<(), String> {
    {
        let mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(pty_session) = mgr.sessions.get(&session_id) {
            let mut s = pty_session.session.lock().map_err(|e| e.to_string())?;
            s.group = group.clone();
            let update = SessionUpdate::from(&*s);
            let _ = app.emit("session-updated", &update);
            drop(s);
            let db = state.db.lock().map_err(|e| e.to_string())?;
            db.update_session_group(&session_id, group.as_deref())?;
            return Ok(());
        }
    }
    // Agent-mode fallback.  group=None clears the group.
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.update_session_group(&session_id, group.as_deref())?;
    let _ = app.emit(
        "session-metadata-updated",
        SessionMetadataUpdate {
            session_id,
            group: Some(group),
            ..Default::default()
        },
    );
    Ok(())
}

#[tauri::command]
pub fn get_session_output(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<String, String> {
    let mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
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
    let mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
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
    let mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
    let session = mgr
        .sessions
        .get(&session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;
    let s = session.session.lock().map_err(|e| e.to_string())?;
    let home = crate::platform::home_dir().unwrap_or_default();
    Ok(build_shell_environment(
        &s.shell,
        s.ssh_info.is_some(),
        &home,
        session.shell_integration.is_active(),
        session.hermes_suggestions,
    ))
}

/// `shellType` reported for SSH sessions. The shell and its config live on
/// the remote host, so nothing about the local shell applies: no local
/// history is loaded and local autosuggest plugins don't suppress Hermes.
pub(crate) const REMOTE_SHELL_TYPE: &str = "remote";

/// Build the shell environment for a session. `shell` is the local shell
/// setting; for SSH sessions it is ignored (see `REMOTE_SHELL_TYPE`).
fn build_shell_environment(
    shell: &str,
    is_ssh: bool,
    home_path: &std::path::Path,
    integration_active: bool,
    hermes_suggestions: bool,
) -> ShellEnvironment {
    if is_ssh {
        return ShellEnvironment {
            shell_type: REMOTE_SHELL_TYPE.to_string(),
            plugins_detected: Vec::new(),
            has_native_autosuggest: false,
            has_oh_my_zsh: false,
            has_syntax_highlighting: false,
            has_starship: false,
            has_powerlevel10k: false,
            shell_integration_active: false,
            hermes_suggestions,
        };
    }

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

    let mut plugins = Vec::new();
    let mut has_oh_my_zsh = false;
    let mut has_autosuggest = false;
    let mut has_syntax_highlighting = false;
    let mut has_starship = false;
    let mut has_powerlevel10k = false;

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

    if shell_type == "powershell" {
        plugins.push("PSReadLine".to_string());
        if powershell_predicts_by_default(shell) {
            has_autosuggest = true;
        }
    }

    ShellEnvironment {
        shell_type: shell_type.to_string(),
        plugins_detected: plugins,
        has_native_autosuggest: has_autosuggest,
        has_oh_my_zsh,
        has_syntax_highlighting,
        has_starship,
        has_powerlevel10k,
        shell_integration_active: integration_active,
        hermes_suggestions,
    }
}

#[tauri::command]
pub fn read_shell_history(shell: String, limit: usize) -> Result<Vec<String>, String> {
    // An SSH session's history lives on the remote host; the local history
    // file belongs to a different machine.
    if shell == REMOTE_SHELL_TYPE {
        return Ok(Vec::new());
    }
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
        // PowerShell history via PSReadLine. On Windows, PowerShell 7+ and
        // Windows PowerShell 5.1 share this file.
        #[cfg(windows)]
        {
            let appdata = std::env::var("APPDATA").unwrap_or_default();
            format!(
                "{}\\Microsoft\\Windows\\PowerShell\\PSReadLine\\ConsoleHost_history.txt",
                appdata
            )
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

    // Lossy: zsh stores non-ASCII bytes "metafied" (not valid UTF-8), which
    // would otherwise fail the whole read over one entry.
    let bytes = std::fs::read(&history_path)
        .map_err(|e| format!("Cannot read history file {}: {}", history_path, e))?;
    let content = String::from_utf8_lossy(&bytes);

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

// ─── SSH File Transfer Commands ───────────────────────────────────────

#[tauri::command]
pub async fn ssh_upload_file(
    state: State<'_, AppState>,
    session_id: String,
    local_path: String,
    remote_dir: String,
) -> Result<(), String> {
    let info = get_ssh_params(&state, &session_id)?;

    let local = std::path::Path::new(&local_path);
    if !local.exists() {
        return Err(format!("Local file not found: {}", local_path));
    }
    let file_name = local
        .file_name()
        .ok_or("Invalid file name")?
        .to_string_lossy();
    let remote_path = format!("{}/{}", remote_dir.trim_end_matches('/'), file_name);

    // Pipe local file through ssh into cat on the remote side.
    // This reuses the ControlMaster socket from ssh_command() and avoids
    // the scp quoting issues with remote paths.
    let local_file = std::fs::File::open(&local_path)
        .map_err(|e| format!("Failed to open local file: {}", e))?;

    let mut cmd = ssh_command(&info.user, &info.host, info.port, info.jump_host.as_deref());
    cmd.arg(format!("cat > {}", shell_escape(&remote_path)));
    cmd.stdin(std::process::Stdio::from(local_file));

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run ssh upload: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "Upload failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    Ok(())
}

#[tauri::command]
pub async fn ssh_download_file(
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
    local_path: String,
) -> Result<(), String> {
    let info = get_ssh_params(&state, &session_id)?;

    // Pipe remote file through ssh cat to a local file.
    // This reuses the ControlMaster socket from ssh_command().
    let local_file = std::fs::File::create(&local_path)
        .map_err(|e| format!("Failed to create local file: {}", e))?;

    let mut cmd = ssh_command(&info.user, &info.host, info.port, info.jump_host.as_deref());
    cmd.arg(format!("cat {}", shell_escape(&remote_path)));
    cmd.stdout(local_file);
    cmd.stderr(std::process::Stdio::piped());

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to run ssh download: {}", e))?;
    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for ssh download: {}", e))?;

    if !output.status.success() {
        // Clean up the (possibly empty/partial) local file on failure
        let _ = std::fs::remove_file(&local_path);
        return Err(format!(
            "Download failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    Ok(())
}

/// Helper: look up SSH connection params from a session by ID.
fn get_ssh_params(state: &State<AppState>, session_id: &str) -> Result<SshConnectionInfo, String> {
    let mgr = state
        .pty_manager
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;
    let pty_session = mgr
        .sessions
        .get(session_id)
        .ok_or_else(|| "Session not found".to_string())?;
    let session = pty_session
        .session
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;
    session
        .ssh_info
        .clone()
        .ok_or_else(|| "Not an SSH session".to_string())
}

// ─── Port Forwarding Commands ────────────────────────────────────────

#[tauri::command]
pub fn ssh_add_port_forward(
    state: State<'_, AppState>,
    session_id: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
    label: Option<String>,
) -> Result<(), String> {
    let info = get_ssh_params(&state, &session_id)?;
    let socket_path = ssh_socket_path(&info.user, &info.host, info.port);

    let spec = format!("{}:{}:{}", local_port, remote_host, remote_port);
    let output = std::process::Command::new("ssh")
        .arg("-O")
        .arg("forward")
        .arg("-L")
        .arg(&spec)
        .arg("-S")
        .arg(socket_path.to_string_lossy().as_ref())
        .arg("--")
        .arg(ssh_destination(&info.user, &info.host))
        .output()
        .map_err(|e| format!("Failed to add port forward: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "Port forward failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    // Update session state
    let mgr = state
        .pty_manager
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;
    if let Some(pty_session) = mgr.sessions.get(&session_id) {
        if let Ok(mut s) = pty_session.session.lock() {
            if let Some(ref mut ssh) = s.ssh_info {
                ssh.port_forwards.push(PortForward {
                    local_port,
                    remote_host,
                    remote_port,
                    label,
                });
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub fn ssh_remove_port_forward(
    state: State<'_, AppState>,
    session_id: String,
    local_port: u16,
) -> Result<(), String> {
    let info = get_ssh_params(&state, &session_id)?;
    let socket_path = ssh_socket_path(&info.user, &info.host, info.port);

    // Find the forward to cancel
    let forward = info
        .port_forwards
        .iter()
        .find(|f| f.local_port == local_port)
        .ok_or_else(|| format!("No forward on port {}", local_port))?;

    let spec = format!(
        "{}:{}:{}",
        forward.local_port, forward.remote_host, forward.remote_port
    );
    let output = std::process::Command::new("ssh")
        .arg("-O")
        .arg("cancel")
        .arg("-L")
        .arg(&spec)
        .arg("-S")
        .arg(socket_path.to_string_lossy().as_ref())
        .arg("--")
        .arg(ssh_destination(&info.user, &info.host))
        .output()
        .map_err(|e| format!("Failed to remove port forward: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "Cancel forward failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    // Update session state
    let mgr = state
        .pty_manager
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;
    if let Some(pty_session) = mgr.sessions.get(&session_id) {
        if let Ok(mut s) = pty_session.session.lock() {
            if let Some(ref mut ssh) = s.ssh_info {
                ssh.port_forwards.retain(|f| f.local_port != local_port);
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub fn ssh_list_port_forwards(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<PortForward>, String> {
    let info = get_ssh_params(&state, &session_id)?;
    Ok(info.port_forwards)
}

// ─── Remote CWD & Git Info Commands ──────────────────────────────────

#[tauri::command]
pub fn ssh_get_remote_cwd(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<String, String> {
    let info = get_ssh_params(&state, &session_id)?;

    let remote_cmd = if let Some(ref tmux_name) = info.tmux_session {
        format!(
            "tmux display-message -t '{}' -p '#{{pane_current_path}}'",
            tmux_name.replace('\'', "'\\''")
        )
    } else {
        "pwd".to_string()
    };

    let (stdout, stderr, success) = ssh_exec(
        &info.user,
        &info.host,
        info.port,
        info.jump_host.as_deref(),
        &remote_cmd,
    )?;
    if !success {
        return Err(format!("Failed to get remote CWD: {}", stderr.trim()));
    }
    Ok(stdout.trim().to_string())
}

#[tauri::command]
pub fn ssh_get_remote_git_info(
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
) -> Result<RemoteGitInfo, String> {
    let info = get_ssh_params(&state, &session_id)?;

    let remote_cmd = format!(
        "git -C '{}' rev-parse --abbrev-ref HEAD 2>/dev/null; git -C '{}' status --porcelain 2>/dev/null | wc -l",
        remote_path.replace('\'', "'\\''"),
        remote_path.replace('\'', "'\\''")
    );

    let (stdout, _stderr, _success) = ssh_exec(
        &info.user,
        &info.host,
        info.port,
        info.jump_host.as_deref(),
        &remote_cmd,
    )?;
    let lines: Vec<&str> = stdout.lines().collect();

    let branch = lines.first().and_then(|l| {
        let b = l.trim();
        if b.is_empty() || b.contains("fatal") {
            None
        } else {
            Some(b.to_string())
        }
    });

    let change_count = lines
        .get(1)
        .and_then(|l| l.trim().parse::<i32>().ok())
        .unwrap_or(0);

    Ok(RemoteGitInfo {
        branch,
        change_count,
    })
}

// ─── Tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::drain_session_db_state;
    use crate::db::Database;
    use tempfile::NamedTempFile;

    fn test_db() -> Database {
        let tmp = NamedTempFile::new().unwrap();
        Database::new(tmp.path()).expect("Failed to create test database")
    }

    // ── Bug 1 — drain_session_db_state runs for any session id ──────
    //
    // Reproducer for the 1.2.x regression where closing an agent session
    // left worktree rows + on-disk worktrees in place because the entire
    // `close_session` cleanup body sat inside
    // `if let Some(_) = mgr.sessions.remove(...)`, which is always None
    // for agent sessions.  The fix extracts the DB-side cleanup into
    // `drain_session_db_state` so it runs regardless of PTY presence.
    //
    // These tests cover the worktree-row branches; the session-status
    // side effect is covered by an integration check in
    // `close_session_invokes_drain` below.

    #[test]
    fn drain_session_db_state_returns_owned_worktrees_for_disk_removal() {
        let db = test_db();
        // Single owned, non-main worktree linked to an agent session.
        db.insert_session_worktree(
            "wt1",
            "agent-1",
            "proj-1",
            "/tmp/wt-agent-1",
            Some("feature-x"),
            false,
        )
        .unwrap();

        let needs_disk = drain_session_db_state(&db, "agent-1");

        assert_eq!(
            needs_disk.len(),
            1,
            "owned non-main worktree must be returned for git worktree remove"
        );
        assert_eq!(needs_disk[0].worktree_path, "/tmp/wt-agent-1");

        // DB row is kept so the caller can delete it AFTER successful disk
        // removal — failures stay in the table for retry on next startup.
        let remaining = db.get_session_worktrees("agent-1").unwrap();
        assert_eq!(remaining.len(), 1);
    }

    #[test]
    fn drain_session_db_state_drops_main_worktree_row_without_disk_removal() {
        let db = test_db();
        db.insert_session_worktree("wt-main", "agent-1", "proj-1", "/repo", Some("main"), true)
            .unwrap();

        let needs_disk = drain_session_db_state(&db, "agent-1");

        assert!(
            needs_disk.is_empty(),
            "main worktree is never removed from disk by close"
        );
        let rows = db.get_session_worktrees("agent-1").unwrap();
        assert!(rows.is_empty(), "main worktree DB row should be dropped");
    }

    #[test]
    fn drain_session_db_state_drops_shared_worktree_row_without_disk_removal() {
        let db = test_db();
        // Two sessions reference the same worktree_path → ref_count = 2.
        db.insert_session_worktree(
            "wt-shared-a",
            "agent-1",
            "proj-1",
            "/tmp/wt-shared",
            Some("feature-x"),
            false,
        )
        .unwrap();
        db.insert_session_worktree(
            "wt-shared-b",
            "agent-2",
            "proj-1",
            "/tmp/wt-shared",
            Some("feature-x"),
            false,
        )
        .unwrap();

        let needs_disk = drain_session_db_state(&db, "agent-1");

        assert!(
            needs_disk.is_empty(),
            "shared worktree must not be removed while another session uses it"
        );
        // Our row is gone; the other session's row survives.
        let ours = db.get_session_worktrees("agent-1").unwrap();
        let theirs = db.get_session_worktrees("agent-2").unwrap();
        assert!(ours.is_empty());
        assert_eq!(theirs.len(), 1);
    }

    #[test]
    fn drain_session_db_state_handles_missing_session() {
        // The agent close path may call drain for a session id that has
        // no worktree rows AND no sessions row (e.g. close called twice).
        // It must be safe to invoke — no panic, no error, just a no-op.
        let db = test_db();
        let needs_disk = drain_session_db_state(&db, "ghost-session");
        assert!(needs_disk.is_empty());
    }

    // ── Regression suite for the close path (Bug 1) ─────────────────
    //
    // The user explicitly asked that the terminal-mode path NOT regress
    // when the close cleanup was extracted into helpers.  These tests
    // exercise scenarios that the OLD pre-refactor code handled, so any
    // regression in `drain_session_db_state` (or the new close flow that
    // calls it) trips one of these.

    use rusqlite::params;

    /// Insert a minimal `sessions` row so we can verify `phase` transitions.
    /// Bypasses the typed API to stay independent of unrelated columns.
    fn insert_minimal_session(db: &Database, id: &str, mode: &str) {
        db.conn
            .execute(
                "INSERT INTO sessions (id, label, description, color, group_name, phase, working_directory, shell, workspace_paths, created_at, ssh_info)
                 VALUES (?1, ?2, '', '#000', NULL, 'idle', '/tmp', '/bin/sh', '[]', '2026-05-13', NULL)",
                params![id, format!("S-{}-{}", mode, id)],
            )
            .unwrap();
    }

    fn phase_of(db: &Database, id: &str) -> Option<String> {
        db.conn
            .query_row(
                "SELECT phase FROM sessions WHERE id = ?1",
                params![id],
                |r| r.get::<_, String>(0),
            )
            .ok()
    }

    #[test]
    fn drain_sets_phase_destroyed_for_terminal_session() {
        // Terminal sessions had their phase flipped to "destroyed" via the
        // PTY-block's `update_session_status` call before this refactor.
        // The same transition must happen now via drain_session_db_state.
        let db = test_db();
        insert_minimal_session(&db, "term-1", "terminal");
        assert_eq!(phase_of(&db, "term-1").as_deref(), Some("idle"));

        drain_session_db_state(&db, "term-1");

        assert_eq!(
            phase_of(&db, "term-1").as_deref(),
            Some("destroyed"),
            "terminal session phase must still flip to 'destroyed' after the close refactor",
        );
    }

    #[test]
    fn drain_sets_phase_destroyed_for_agent_session_regression() {
        // The 1.2.x bug: agent sessions never had `update_session_status`
        // called on close.  The fix is that drain runs unconditionally.
        let db = test_db();
        insert_minimal_session(&db, "agent-1", "agent");
        drain_session_db_state(&db, "agent-1");
        assert_eq!(
            phase_of(&db, "agent-1").as_deref(),
            Some("destroyed"),
            "agent close must flip phase to 'destroyed' (Bug 1 regression)",
        );
    }

    #[test]
    fn drain_handles_mixed_worktree_set_for_one_session() {
        // A session with a main worktree on project A AND an owned
        // non-main worktree on project B.  Drain must:
        //   - drop the main row immediately,
        //   - return the owned row for disk removal,
        //   - leave the owned row in the DB until the caller deletes it.
        //
        // Two different projects because session_worktrees has
        // UNIQUE(session_id, realm_id) — multi-project attachment is the
        // realistic scenario for a single session having both kinds of
        // worktree rows.
        let db = test_db();
        insert_minimal_session(&db, "term-mix", "terminal");
        db.insert_session_worktree("wt-main", "term-mix", "proj-A", "/repo-a", None, true)
            .unwrap();
        db.insert_session_worktree(
            "wt-feat",
            "term-mix",
            "proj-B",
            "/tmp/wt-feat",
            Some("feature-y"),
            false,
        )
        .unwrap();

        let needs_disk = drain_session_db_state(&db, "term-mix");

        assert_eq!(
            needs_disk.len(),
            1,
            "only the owned non-main worktree needs disk removal"
        );
        assert_eq!(needs_disk[0].id, "wt-feat");
        // Main row was dropped; owned row is kept for the caller.
        let remaining: Vec<String> = db
            .get_session_worktrees("term-mix")
            .unwrap()
            .into_iter()
            .map(|w| w.id)
            .collect();
        assert_eq!(remaining, vec!["wt-feat".to_string()]);
        assert_eq!(phase_of(&db, "term-mix").as_deref(), Some("destroyed"));
    }

    #[test]
    fn drain_is_idempotent_for_session_with_owned_worktree() {
        // Calling drain twice (e.g. on retry) must be safe: the second
        // call sees an unchanged DB and returns the same owned worktree
        // for retry.  No panic, no duplicate side effects.
        let db = test_db();
        insert_minimal_session(&db, "agent-retry", "agent");
        db.insert_session_worktree(
            "wt-retry",
            "agent-retry",
            "proj-1",
            "/tmp/wt-retry",
            Some("feature-z"),
            false,
        )
        .unwrap();

        let first = drain_session_db_state(&db, "agent-retry");
        let second = drain_session_db_state(&db, "agent-retry");

        assert_eq!(first.len(), 1);
        assert_eq!(
            second.len(),
            1,
            "second drain must see the same row (caller didn't delete after failure)"
        );
        assert_eq!(first[0].id, "wt-retry");
        assert_eq!(second[0].id, "wt-retry");
        assert_eq!(phase_of(&db, "agent-retry").as_deref(), Some("destroyed"));
    }

    #[test]
    fn drain_does_not_affect_other_live_sessions() {
        // Two unrelated sessions in the DB.  Closing one must NOT touch
        // the other's row, worktrees, or phase.  Important when the user
        // has many sessions open and closes one.
        let db = test_db();
        insert_minimal_session(&db, "closing", "agent");
        insert_minimal_session(&db, "surviving", "terminal");
        db.insert_session_worktree(
            "wt-c",
            "closing",
            "proj-1",
            "/tmp/wt-c",
            Some("feat-c"),
            false,
        )
        .unwrap();
        db.insert_session_worktree(
            "wt-s",
            "surviving",
            "proj-1",
            "/tmp/wt-s",
            Some("feat-s"),
            false,
        )
        .unwrap();

        drain_session_db_state(&db, "closing");

        assert_eq!(
            phase_of(&db, "surviving").as_deref(),
            Some("idle"),
            "the other session must not be touched"
        );
        let surviving_wts = db.get_session_worktrees("surviving").unwrap();
        assert_eq!(surviving_wts.len(), 1);
        assert_eq!(surviving_wts[0].id, "wt-s");
    }

    #[test]
    fn drain_clears_session_pins_for_terminal_session() {
        // Session-scoped pins must be cleared on close for both modes.
        // Project-scoped pins (session_id IS NULL) must survive — they
        // belong to the project, not the session that pinned them.
        let db = test_db();
        insert_minimal_session(&db, "term-pin", "terminal");
        db.conn
            .execute(
                "INSERT INTO context_pins (session_id, project_id, kind, target, label)
                 VALUES ('term-pin', 'proj-1', 'file', '/repo/a', 'A')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO context_pins (session_id, project_id, kind, target, label)
                 VALUES (NULL, 'proj-1', 'file', '/repo/b', 'B')",
                [],
            )
            .unwrap();

        drain_session_db_state(&db, "term-pin");

        let surviving_labels: Vec<String> = db
            .conn
            .prepare("SELECT label FROM context_pins ORDER BY label")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(
            surviving_labels,
            vec!["B".to_string()],
            "project-scoped pin must survive; session-scoped pin must be cleaned",
        );
    }

    #[test]
    fn drain_clears_session_pins_for_agent_session_regression() {
        // The mirror of the above for agent mode — proves the Bug 1 fix
        // also restores pin cleanup, which used to live inside the
        // unreachable `if let Some(pty_session)` block.
        let db = test_db();
        insert_minimal_session(&db, "agent-pin", "agent");
        db.conn
            .execute(
                "INSERT INTO context_pins (session_id, project_id, kind, target, label)
                 VALUES ('agent-pin', 'proj-1', 'file', '/repo/a', 'A')",
                [],
            )
            .unwrap();

        drain_session_db_state(&db, "agent-pin");

        let count: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM context_pins", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            count, 0,
            "agent-session pin must be cleaned (Bug 1 regression)"
        );
    }

    // ── #317 — terminal-mode model changes must reach the UI ────────

    fn agent(model: Option<&str>) -> Option<crate::pty::models::AgentInfo> {
        Some(crate::pty::models::AgentInfo {
            name: "Claude Code".into(),
            provider: "anthropic".into(),
            model: model.map(Into::into),
            detected_at: String::new(),
            confidence: 1.0,
        })
    }

    #[test]
    fn agent_model_emit_on_first_detection_and_enrichment() {
        assert!(super::agent_model_needs_emit(&None, &agent(None)));
        assert!(super::agent_model_needs_emit(
            &agent(None),
            &agent(Some("opus"))
        ));
    }

    #[test]
    fn agent_model_emit_on_some_to_some_change() {
        assert!(super::agent_model_needs_emit(
            &agent(Some("sonnet")),
            &agent(Some("opus"))
        ));
    }

    #[test]
    fn agent_model_no_emit_when_unchanged_or_lost() {
        assert!(!super::agent_model_needs_emit(
            &agent(Some("opus")),
            &agent(Some("opus"))
        ));
        assert!(!super::agent_model_needs_emit(
            &agent(Some("opus")),
            &agent(None)
        ));
        assert!(!super::agent_model_needs_emit(&agent(None), &None));
    }

    // ─── SSH command construction ───────────────────────────────────

    fn ssh_info(jump_host: Option<&str>) -> super::SshConnectionInfo {
        super::SshConnectionInfo {
            host: "db.internal".to_string(),
            port: 2222,
            user: "alice".to_string(),
            tmux_session: None,
            identity_file: None,
            jump_host: jump_host.map(str::to_string),
            port_forwards: Vec::new(),
        }
    }

    fn pty_argv(info: &super::SshConnectionInfo) -> Vec<String> {
        super::ssh_pty_command(info, 80, 24)
            .get_argv()
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    fn exec_argv(jump_host: Option<&str>) -> Vec<String> {
        super::ssh_command("alice", "db.internal", 2222, jump_host)
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    /// `-J <jump>` must appear before the destination so ssh treats it as
    /// an option rather than part of the remote command.
    fn assert_jump_before_dest(argv: &[String], jump: &str) {
        let j = argv.iter().position(|a| a == "-J").expect("missing -J");
        assert_eq!(argv[j + 1], jump);
        let dest = argv.iter().position(|a| a == "alice@db.internal").unwrap();
        assert!(j < dest, "-J must precede destination: {:?}", argv);
    }

    #[test]
    fn pty_ssh_command_passes_jump_host() {
        let argv = pty_argv(&ssh_info(Some("bastion.example.com")));
        assert_jump_before_dest(&argv, "bastion.example.com");
    }

    #[test]
    fn pty_ssh_command_without_jump_host_has_no_j_flag() {
        for jump in [None, Some(""), Some("   ")] {
            let argv = pty_argv(&ssh_info(jump));
            assert!(!argv.iter().any(|a| a == "-J"), "{:?}", argv);
            assert_eq!(argv.last().unwrap(), "alice@db.internal");
        }
    }

    #[test]
    fn exec_ssh_command_passes_jump_host() {
        let argv = exec_argv(Some(" admin@bastion:2200 "));
        assert_jump_before_dest(&argv, "admin@bastion:2200");
    }

    #[test]
    fn exec_ssh_command_without_jump_host_has_no_j_flag() {
        for jump in [None, Some("")] {
            let argv = exec_argv(jump);
            assert!(!argv.iter().any(|a| a == "-J"), "{:?}", argv);
            assert_eq!(argv.last().unwrap(), "alice@db.internal");
        }
    }

    #[test]
    fn ssh_info_without_jump_host_deserializes() {
        // ssh_info rows persisted before jump_host existed must still load.
        let info: super::SshConnectionInfo =
            serde_json::from_str(r#"{"host":"h","port":22,"user":"u"}"#).unwrap();
        assert!(info.jump_host.is_none());
    }

    // ── #117 — per-session Hermes suggestions flag reaches the frontend ──
    //
    // The frontend's `ShellEnvironment.hermesSuggestions` gates ghost text,
    // the suggestion list and Tab per session, so the wire name must match.
    #[test]
    fn shell_environment_serializes_hermes_suggestions_for_frontend() {
        let env = crate::pty::models::ShellEnvironment {
            shell_type: "zsh".into(),
            plugins_detected: vec![],
            has_native_autosuggest: true,
            has_oh_my_zsh: false,
            has_syntax_highlighting: false,
            has_starship: false,
            has_powerlevel10k: false,
            shell_integration_active: true,
            hermes_suggestions: false,
        };
        let json = serde_json::to_value(&env).unwrap();
        assert_eq!(json["hermesSuggestions"], serde_json::json!(false));
    }

    // The frontend `ShellEnvironment` type reads every field camelCase. A
    // snake_case name reaches it as `undefined` (shell type unknown to
    // history loading, integration/autosuggest checks never taken).
    #[test]
    fn shell_environment_serializes_every_field_camel_case() {
        let env = crate::pty::models::ShellEnvironment {
            shell_type: "zsh".into(),
            plugins_detected: vec!["zsh-autosuggestions".into()],
            has_native_autosuggest: true,
            has_oh_my_zsh: true,
            has_syntax_highlighting: false,
            has_starship: true,
            has_powerlevel10k: false,
            shell_integration_active: true,
            hermes_suggestions: true,
        };
        let json = serde_json::to_value(&env).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "shellType": "zsh",
                "pluginsDetected": ["zsh-autosuggestions"],
                "hasNativeAutosuggest": true,
                "hasOhMyZsh": true,
                "hasSyntaxHighlighting": false,
                "hasStarship": true,
                "hasPowerlevel10k": false,
                "shellIntegrationActive": true,
                "hermesSuggestions": true,
            })
        );
    }

    // ── SSH sessions: the local shell environment must not apply ──

    /// A home dir whose .zshrc loads zsh-autosuggestions, plus oh-my-zsh.
    fn home_with_zsh_autosuggestions() -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            home.path().join(".zshrc"),
            "plugins=(git zsh-autosuggestions zsh-syntax-highlighting)\n",
        )
        .unwrap();
        std::fs::create_dir(home.path().join(".oh-my-zsh")).unwrap();
        home
    }

    #[test]
    fn ssh_session_ignores_local_shell_config() {
        let home = home_with_zsh_autosuggestions();
        for hermes_suggestions in [true, false] {
            let env = super::build_shell_environment(
                "/bin/zsh",
                true,
                home.path(),
                false,
                hermes_suggestions,
            );
            assert_eq!(env.shell_type, super::REMOTE_SHELL_TYPE);
            assert!(!env.has_native_autosuggest);
            assert!(!env.has_oh_my_zsh);
            assert!(!env.has_syntax_highlighting);
            assert!(!env.has_starship);
            assert!(!env.has_powerlevel10k);
            assert!(env.plugins_detected.is_empty());
            assert!(!env.shell_integration_active);
            // The user's Hermes-suggestions choice still applies over SSH.
            assert_eq!(env.hermes_suggestions, hermes_suggestions);
        }
    }

    #[test]
    fn local_zsh_session_still_reads_local_shell_config() {
        let home = home_with_zsh_autosuggestions();
        let env = super::build_shell_environment("/bin/zsh", false, home.path(), true, true);
        assert_eq!(env.shell_type, "zsh");
        assert!(env.has_native_autosuggest);
        assert!(env.has_oh_my_zsh);
        assert!(env.has_syntax_highlighting);
        assert!(env.shell_integration_active);
        assert!(env
            .plugins_detected
            .contains(&"zsh-autosuggestions".to_string()));
    }

    #[test]
    fn ssh_session_environment_serializes_remote_shell_type() {
        let home = tempfile::tempdir().unwrap();
        let env = super::build_shell_environment("/bin/zsh", true, home.path(), false, true);
        let json = serde_json::to_value(&env).unwrap();
        assert_eq!(json["shellType"], serde_json::json!("remote"));
        assert_eq!(json["hasNativeAutosuggest"], serde_json::json!(false));
    }

    #[test]
    fn remote_shell_history_is_empty() {
        // Never falls back to a local history file for an SSH session.
        let history = super::read_shell_history(super::REMOTE_SHELL_TYPE.to_string(), 500);
        assert_eq!(history, Ok(Vec::new()));
    }
}

/// PSReadLine inline prediction is on by default only in PowerShell 7
/// (`pwsh`). Windows PowerShell 5.1 ships an older PSReadLine with
/// prediction off, so Hermes suggestions must stay on there.
fn powershell_predicts_by_default(shell: &str) -> bool {
    shell.to_ascii_lowercase().contains("pwsh")
}

#[cfg(test)]
mod powershell_prediction_tests {
    use super::powershell_predicts_by_default;

    #[test]
    fn only_pwsh_counts_as_native_autosuggest() {
        assert!(powershell_predicts_by_default("pwsh"));
        assert!(powershell_predicts_by_default(
            r"C:\Program Files\PowerShell\7\pwsh.exe"
        ));
        assert!(!powershell_predicts_by_default("powershell"));
        assert!(!powershell_predicts_by_default(
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
        ));
    }
}

#[cfg(test)]
mod ssh_command_tests {
    use super::{resolve_ssh_user, ssh_command, ssh_destination, ssh_pty_command};

    #[test]
    fn jump_host_goes_before_end_of_options_and_destination() {
        let args = std_args(&ssh_command("alice", "example.com", 22, Some("bastion")));
        let j = args.iter().position(|a| a == "-J").expect("-J present");
        let dd = args.iter().position(|a| a == "--").expect("-- present");
        assert_eq!(args[j + 1], "bastion");
        assert!(j < dd);
        assert_eq!(args[dd + 1], "alice@example.com");

        let mut i = info("", "lima-test-agent");
        i.jump_host = Some("  bastion  ".to_string());
        let pty: Vec<String> = ssh_pty_command(&i, 80, 24)
            .get_argv()
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let j = pty.iter().position(|a| a == "-J").expect("-J present");
        let dd = pty.iter().position(|a| a == "--").expect("-- present");
        assert_eq!(pty[j + 1], "bastion");
        assert!(j < dd);
        assert_eq!(pty[dd + 1], "lima-test-agent");
    }
    use crate::pty::models::SshConnectionInfo;

    fn info(user: &str, host: &str) -> SshConnectionInfo {
        SshConnectionInfo {
            host: host.to_string(),
            port: 22,
            user: user.to_string(),
            tmux_session: None,
            identity_file: None,
            port_forwards: Vec::new(),
            jump_host: None,
        }
    }

    fn std_args(cmd: &std::process::Command) -> Vec<String> {
        cmd.get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    fn pty_args(info: &SshConnectionInfo) -> Vec<String> {
        ssh_pty_command(info, 80, 24)
            .get_argv()
            .iter()
            .skip(1) // program name
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn blank_user_is_left_to_ssh_config() {
        assert_eq!(resolve_ssh_user(None), "");
        assert_eq!(resolve_ssh_user(Some("   ".to_string())), "");
        assert_eq!(resolve_ssh_user(Some(" alice ".to_string())), "alice");
    }

    #[test]
    fn destination_is_bare_host_without_user() {
        assert_eq!(ssh_destination("", "lima-test-agent"), "lima-test-agent");
        assert_eq!(ssh_destination("alice", "example.com"), "alice@example.com");
    }

    #[test]
    fn exec_command_passes_bare_alias_when_user_blank() {
        let args = std_args(&ssh_command("", "lima-test-agent", 22, None));
        assert_eq!(args.last().unwrap(), "lima-test-agent");
        assert!(!args.iter().any(|a| a.contains("@lima-test-agent")));
    }

    #[test]
    fn exec_command_keeps_user_at_host_when_user_given() {
        let args = std_args(&ssh_command("alice", "example.com", 2222, None));
        assert_eq!(args.last().unwrap(), "alice@example.com");
        assert!(args.windows(2).any(|w| w[0] == "-p" && w[1] == "2222"));
    }

    #[test]
    fn pty_command_passes_bare_alias_when_user_blank() {
        let args = pty_args(&info("", "lima-test-agent"));
        assert_eq!(args.last().unwrap(), "lima-test-agent");
        assert!(!args.iter().any(|a| a.contains("@lima-test-agent")));
    }

    #[test]
    fn pty_command_keeps_user_at_host_and_appends_tmux() {
        let mut i = info("alice", "example.com");
        i.tmux_session = Some("main".to_string());
        let args = pty_args(&i);
        let dest = args.iter().position(|a| a == "alice@example.com").unwrap();
        assert_eq!(args[dest + 1], "tmux new-session -A -s 'main' -x 80 -y 24");
    }

    #[test]
    fn destination_follows_end_of_options_marker() {
        let exec = std_args(&ssh_command("", "-oProxyCommand=x", 22, None));
        assert_eq!(exec[exec.len() - 2], "--");
        let mut i = info("", "-oProxyCommand=x");
        i.tmux_session = Some("main".to_string());
        let pty = pty_args(&i);
        let dest = pty.iter().position(|a| a == "-oProxyCommand=x").unwrap();
        assert_eq!(pty[dest - 1], "--");
    }
}

// These tests drive foreground_lock_released_for_scan with injected probe and
// scan closures (plus the real probe and process scan where noted). The wiring
// in is_shell_foreground itself (probe_foreground, then
// shell_at_prompt_by_process_table on spawn_blocking) is covered by the
// real-app scenario e2e/app/scenarios/F03-foreground-check-lock.mjs.
#[cfg(test)]
mod foreground_tests {
    use super::{
        counts_as_shell_child, foreground_lock_released_for_scan, has_child_process,
        probe_foreground,
    };
    use crate::pty::PtyManager;
    #[cfg(unix)]
    use std::io::Write;
    use std::process::{Child, Command};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    /// A process that starts a child of its own and waits for it.
    fn parent_with_child() -> Child {
        #[cfg(windows)]
        let child = Command::new("cmd")
            .args(["/C", "ping -n 30 127.0.0.1 >NUL"])
            .spawn();
        #[cfg(not(windows))]
        let child = Command::new("sh").args(["-c", "sleep 30; true"]).spawn();
        child.unwrap()
    }

    /// A process that starts nothing.
    fn lone_process() -> Child {
        #[cfg(windows)]
        let child = Command::new("ping").args(["-n", "30", "127.0.0.1"]).spawn();
        #[cfg(not(windows))]
        let child = Command::new("sleep").arg("30").spawn();
        child.unwrap()
    }

    fn eventually(mut check: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if check() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[test]
    fn a_program_the_shell_started_is_seen_as_its_child() {
        let mut shell = parent_with_child();
        let seen = eventually(|| has_child_process(shell.id()));
        let _ = shell.kill();
        let _ = shell.wait();
        assert!(seen, "the running child was not found");
    }

    /// An interactive shell in a PTY, started the way sessions start it.
    #[cfg(unix)]
    fn interactive_shell() -> (
        portable_pty::PtyPair,
        Box<dyn portable_pty::Child + Send + Sync>,
        Box<dyn std::io::Write + Send>,
    ) {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-i");
        cmd.env("PS1", "$ ");
        cmd.cwd(std::env::temp_dir());
        #[cfg(target_os = "macos")]
        let child = {
            let tty = pair.master.tty_name().unwrap();
            crate::pty::spawn::posix_spawn_in_pty(&cmd, &tty).unwrap()
        };
        #[cfg(not(target_os = "macos"))]
        let child = pair.slave.spawn_command(cmd).unwrap();
        // Keep the PTY drained so the shell never blocks on output.
        let mut reader = pair.master.try_clone_reader().unwrap();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = std::io::Read::read(&mut reader, &mut buf) {
                if n == 0 {
                    break;
                }
            }
        });
        let writer = pair.master.take_writer().unwrap();
        (pair, child, writer)
    }

    #[cfg(unix)]
    #[test]
    fn a_program_started_at_the_prompt_owns_the_terminal_until_it_exits() {
        use super::shell_group_is_foreground;
        let (pair, mut shell, mut input) = interactive_shell();
        let pid = shell.process_id().unwrap();
        let owns = || shell_group_is_foreground(pair.master.as_ref(), pid);

        let at_prompt = eventually(|| owns() == Some(true));
        input.write_all(b"sleep 3\n").unwrap();
        input.flush().unwrap();
        let while_running = eventually(|| owns() == Some(false));
        let after_exit = eventually(|| owns() == Some(true));

        let _ = shell.kill();
        let _ = shell.wait();
        assert!(at_prompt, "the shell owns the terminal at its prompt");
        assert!(while_running, "the program owns the terminal while it runs");
        assert!(
            after_exit,
            "the shell owns the terminal again after it exits"
        );
    }

    /// Whether another thread can take the lock right now.
    fn free_for_another_thread<T: Send>(lock: &Mutex<T>) -> bool {
        std::thread::scope(|s| s.spawn(|| lock.try_lock().is_ok()).join().unwrap())
    }

    #[test]
    fn the_process_table_scan_runs_with_the_pty_manager_lock_released() {
        let manager = Mutex::new(PtyManager::new());
        // A "shell" at its prompt: a process that starts nothing.
        let mut shell = lone_process();
        let mut free_during_probe = None;
        let mut free_during_scan = None;
        let at_prompt = foreground_lock_released_for_scan(
            &manager,
            |_| {
                free_during_probe = Some(free_for_another_thread(&manager));
                Ok((shell.id(), None))
            },
            |pid| {
                free_during_scan = Some(free_for_another_thread(&manager));
                // The real scan: keystrokes must not wait for it.
                !has_child_process(pid)
            },
        );
        let _ = shell.kill();
        let _ = shell.wait();
        // The probe really does run under the lock, so this check can fail.
        assert_eq!(free_during_probe, Some(false));
        assert_eq!(
            free_during_scan,
            Some(true),
            "another thread could not take the PTY manager lock during the scan"
        );
        assert_eq!(at_prompt, Ok(true), "the real scan found no child");
    }

    #[test]
    fn a_keystroke_waiting_for_the_lock_does_not_wait_for_the_scan() {
        let manager = Mutex::new(PtyManager::new());
        let scan_started = AtomicBool::new(false);
        let scan_done = AtomicBool::new(false);
        std::thread::scope(|s| {
            let typist = s.spawn(|| {
                while !scan_started.load(Ordering::SeqCst) {
                    std::thread::yield_now();
                }
                // What write_to_session does for each keystroke.
                let _guard = manager.lock().unwrap();
                scan_done.load(Ordering::SeqCst)
            });
            let _ = foreground_lock_released_for_scan(
                &manager,
                |_| Ok((1, None)),
                |_| {
                    scan_started.store(true, Ordering::SeqCst);
                    // A slow enumerator: long enough for the keystroke to be
                    // written first unless the lock is still held.
                    std::thread::sleep(Duration::from_millis(500));
                    scan_done.store(true, Ordering::SeqCst);
                    true
                },
            );
            let waited_for_scan = typist.join().unwrap();
            assert!(!waited_for_scan, "the keystroke waited for the scan");
        });
    }

    #[test]
    fn an_answer_from_the_terminal_skips_the_scan() {
        let manager = Mutex::new(PtyManager::new());
        for owns in [true, false] {
            let mut scanned = false;
            let got = foreground_lock_released_for_scan(
                &manager,
                |_| Ok((1, Some(owns))),
                |_| {
                    scanned = true;
                    !owns
                },
            );
            assert_eq!(got, Ok(owns));
            assert!(!scanned);
        }
    }

    #[test]
    fn an_unknown_session_is_an_error_and_nothing_is_scanned() {
        let manager = Mutex::new(PtyManager::new());
        let mut scanned = false;
        let got = foreground_lock_released_for_scan(
            &manager,
            |mgr| probe_foreground(mgr, "no-such-session"),
            |_| {
                scanned = true;
                true
            },
        );
        assert_eq!(got, Err("Session no-such-session not found".to_string()));
        assert!(!scanned);
        assert!(free_for_another_thread(&manager), "the lock was left held");
    }

    // Start times are whole seconds since the epoch, as the OS reports them.
    const SHELL_STARTED: u64 = 1_800_000_000;

    #[test]
    fn a_program_started_after_the_shell_is_its_child() {
        assert!(counts_as_shell_child(
            SHELL_STARTED,
            SHELL_STARTED + 5,
            "node.exe"
        ));
    }

    #[test]
    fn a_program_started_in_the_same_second_as_the_shell_is_its_child() {
        // One-second clock: an agent launched right away must not be missed.
        assert!(counts_as_shell_child(
            SHELL_STARTED,
            SHELL_STARTED,
            "claude.exe"
        ));
    }

    #[test]
    fn an_orphan_of_an_earlier_process_with_the_reused_pid_is_not_a_child() {
        // Windows reused the shell's pid; the orphan still names it as its
        // parent but started before the shell existed.
        assert!(!counts_as_shell_child(
            SHELL_STARTED,
            SHELL_STARTED - 1,
            "node.exe"
        ));
        assert!(!counts_as_shell_child(
            SHELL_STARTED,
            1_700_000_000,
            "node.exe"
        ));
    }

    #[test]
    fn an_unknown_start_time_counts_as_a_child() {
        // Windows cannot open some processes: err towards "an agent may be
        // running", which only keeps suggestions off.
        assert!(counts_as_shell_child(SHELL_STARTED, 0, "elevated.exe"));
        assert!(counts_as_shell_child(0, SHELL_STARTED - 60, "node.exe"));
    }

    #[test]
    fn the_console_host_is_not_a_program_the_user_ran() {
        for name in ["conhost.exe", "CONHOST.EXE", "OpenConsole.exe"] {
            assert!(!counts_as_shell_child(
                SHELL_STARTED,
                SHELL_STARTED + 1,
                name
            ));
        }
    }

    #[test]
    fn a_process_with_nothing_running_has_no_child() {
        let mut lone = lone_process();
        // Give it time to start; it never gains a child.
        std::thread::sleep(Duration::from_millis(300));
        let found = has_child_process(lone.id());
        let _ = lone.kill();
        let _ = lone.wait();
        assert!(!found, "found a child that does not exist");
    }
}
