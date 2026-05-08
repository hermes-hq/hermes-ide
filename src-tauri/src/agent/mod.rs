//! Agent-mode subprocess lifecycle.
//!
//! Owns one `claude --print --output-format stream-json --input-format stream-json`
//! child process per session and bridges its NDJSON stdout / stderr stream to the
//! frontend via Tauri events.  See `docs/adr/001-agent-mode.md` for the design
//! rationale and `wondrous-wishing-quilt` plan for the phase-by-phase build.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;
use tokio::time::timeout;

// ─── State ─────────────────────────────────────────────────────────

type SessionMap = Arc<Mutex<HashMap<String, AgentChild>>>;

/// Per-process registry of live agent subprocesses keyed by h-ide's internal
/// session id.  The inner map is `Arc`-shared so detached reader / waiter
/// tasks can clean themselves up without holding a Tauri `State<'_>` borrow.
pub struct AgentState {
    sessions: SessionMap,
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl AgentState {
    fn handle(&self) -> SessionMap {
        Arc::clone(&self.sessions)
    }
}

struct AgentChild {
    /// Owned handle to the `claude` child process.  Wrapped in `Option` so the
    /// child waiter task can take it out at exit time without holding the
    /// state lock for the full duration of `wait()`.
    child: Option<Child>,
    /// Buffered writer for the subprocess stdin.  Wrapped in `Option` so that
    /// `close_agent_session` can drop it independently of the child handle to
    /// signal EOF to the subprocess.
    stdin: Option<ChildStdin>,
    /// PID of the subprocess (best-effort).
    #[allow(dead_code)]
    pid: Option<u32>,
}

// ─── Public types ──────────────────────────────────────────────────

/// Resolved metadata about the `claude` binary on the user's machine.
/// Returned by [`check_claude_cli`] for the frontend to decide whether
/// Agent mode is available at all.
#[derive(Serialize)]
pub struct ClaudeCliInfo {
    /// Version string parsed from `claude --version`, e.g. `"2.1.126"`.
    pub version: String,
    /// Resolved absolute path to the binary, e.g. `"/usr/local/bin/claude"`.
    pub path: String,
}

/// Argument vector + working directory bundle.  Pulled out of the spawn path
/// so the flag-ordering can be unit-tested without touching the filesystem
/// or actually spawning a child.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnArgs {
    pub args: Vec<String>,
    pub working_dir: String,
}

// ─── Bridge resolution ────────────────────────────────────────────

/// Locate the Hermes Claude bridge (`hermes-claude-bridge.mjs`).
///
/// Search order (first hit wins):
///   1. `HERMES_BRIDGE_PATH` env var  — explicit override (used in tests).
///   2. `<CARGO_MANIFEST_DIR>/bridge/hermes-claude-bridge.mjs`  — dev path.
///   3. The Tauri resource dir under `bridge/hermes-claude-bridge.mjs`  —
///      production path (populated by the bundler in M11).
fn resolve_bridge_path() -> Result<std::path::PathBuf, String> {
    if let Ok(p) = std::env::var("HERMES_BRIDGE_PATH") {
        let pb = std::path::PathBuf::from(p);
        if pb.exists() {
            return Ok(pb);
        }
        return Err(format!(
            "HERMES_BRIDGE_PATH points to a non-existent file: {}",
            pb.display()
        ));
    }
    let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let dev = manifest.join("bridge").join("hermes-claude-bridge.mjs");
    if dev.exists() {
        return Ok(dev);
    }
    Err(format!(
        "could not locate hermes-claude-bridge.mjs (looked at: {})",
        dev.display()
    ))
}

// ─── Hermes IDE state file ─────────────────────────────────────────

/// Write the initial Hermes IDE state JSON for this session.  The bridge's
/// `mcp__hermes__get_project_state` tool reads from this file on demand,
/// so the value Claude sees stays in sync with whatever Hermes most
/// recently wrote.
///
/// File layout:
///   ~/.hermes-ide/sessions/<sid>/state.json  →  { cwd, attachedPaths, ... }
///
/// Returns the absolute path to the state file (so we can pass it to the
/// bridge via `--hermes-state-path`).  On error, returns the error string;
/// the spawn falls back to a no-op MCP server (the bridge gracefully
/// returns empty state when the path is missing).
pub fn ensure_hermes_state_file(
    session_id: &str,
    working_dir: &str,
    add_dirs: &[String],
) -> Result<String, String> {
    use std::fs;
    let home = std::env::var("HOME").map_err(|_| "HOME env var unset".to_string())?;
    let dir = std::path::PathBuf::from(home)
        .join(".hermes-ide")
        .join("sessions")
        .join(session_id);
    fs::create_dir_all(&dir).map_err(|e| format!("create state dir: {}", e))?;
    let path = dir.join("state.json");

    let payload = serde_json::json!({
        "cwd": working_dir,
        "attachedPaths": add_dirs,
        "memory": [],
        "pinnedFiles": [],
    });
    fs::write(
        &path,
        serde_json::to_vec_pretty(&payload).unwrap_or_default(),
    )
    .map_err(|e| format!("write state file: {}", e))?;
    path.to_str()
        .map(String::from)
        .ok_or_else(|| "non-utf8 state path".to_string())
}

/// Update the Hermes IDE state file for an active session.  Called from
/// `update_hermes_state` IPC when the frontend changes attached projects,
/// active file, etc.  The file is the single source of truth the bridge's
/// MCP tools query, so writing here makes the change visible to Claude on
/// its next tool call (no respawn required).
pub fn update_hermes_state_file(session_id: &str, state: &serde_json::Value) -> Result<(), String> {
    use std::fs;
    let home = std::env::var("HOME").map_err(|_| "HOME env var unset".to_string())?;
    let path = std::path::PathBuf::from(home)
        .join(".hermes-ide")
        .join("sessions")
        .join(session_id)
        .join("state.json");
    if !path.parent().map(|p| p.exists()).unwrap_or(false) {
        return Err(format!(
            "state dir for session {} does not exist; spawn the agent first",
            session_id
        ));
    }
    fs::write(&path, serde_json::to_vec_pretty(state).unwrap_or_default())
        .map_err(|e| format!("write state file: {}", e))
}

// ─── Spawn-args builder ────────────────────────────────────────────

/// Build the argv we hand to `claude`.  Kept pure so unit tests can pin the
/// flag order and prevent accidental drift.
///
/// Three spawn shapes:
///
///   * **Initial** (`prior_uuid = None`): emits `--session-id <session_id>`.
///   * **Continue** (`prior_uuid = Some, fork = false`): emits
///     `--resume <uuid>` only.  This is the auto-respawn between turns;
///     Claude reloads the session and keeps its original model + permission
///     mode.  Passing new `--model` / `--permission-mode` flags here is a
///     silent no-op (Claude ignores them on plain resume).
///   * **Fork** (`prior_uuid = Some, fork = true`): emits
///     `--session-id <new_id> --resume <prior_uuid> --fork-session`.  This
///     branches a fresh session from the prior history; new `--model` /
///     `--permission-mode` flags now actually apply.  Used when the user
///     explicitly switches model or permission mode mid-conversation.
///
/// `permission_mode` accepts Claude's published values: `default`,
/// `acceptEdits`, `plan`, `bypassPermissions`.  Any other value (or `None`)
/// means we omit the flag and let Claude pick its own default.
///
/// The argument count is intentionally large — every flag Claude accepts is
/// exposed here.  Reducing it would force callers to construct intermediate
/// option structs that wouldn't add clarity.
#[allow(clippy::too_many_arguments)]
pub fn build_spawn_args(
    session_id: &str,
    working_dir: &str,
    prior_uuid: Option<&str>,
    model: Option<&str>,
    permission_mode: Option<&str>,
    effort: Option<&str>,
    add_dirs: &[String],
    fork: bool,
) -> SpawnArgs {
    let mut args: Vec<String> = vec![
        "--print".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--input-format".into(),
        "stream-json".into(),
        "--include-partial-messages".into(),
        "--verbose".into(),
    ];
    match prior_uuid {
        Some(uuid) if fork => {
            // Fork: new session id branched from `uuid`'s history.
            args.push("--session-id".into());
            args.push(session_id.to_string());
            args.push("--resume".into());
            args.push(uuid.to_string());
            args.push("--fork-session".into());
        }
        Some(uuid) => {
            // Plain resume — keep the existing session id; new --model and
            // --permission-mode flags are silently ignored by Claude in
            // this mode (this is what motivated the fork branch above).
            args.push("--resume".into());
            args.push(uuid.to_string());
        }
        None => {
            args.push("--session-id".into());
            args.push(session_id.to_string());
        }
    }
    if let Some(m) = model {
        args.push("--model".into());
        args.push(m.to_string());
    }
    if let Some(p) = permission_mode {
        // Whitelist the values we know Claude accepts.  Passing an unknown
        // value would make the subprocess exit immediately with an error.
        if matches!(
            p,
            "default" | "acceptEdits" | "plan" | "bypassPermissions" | "auto" | "dontAsk"
        ) {
            args.push("--permission-mode".into());
            args.push(p.to_string());
        }
    }
    if let Some(e) = effort {
        // Real CLI flag (`--effort`) — verified via `claude --help`.
        // Values: low, medium, high, xhigh, max.
        if matches!(e, "low" | "medium" | "high" | "xhigh" | "max") {
            args.push("--effort".into());
            args.push(e.to_string());
        }
    }
    // `--add-dir <directories...>` — attached project paths, so Claude's
    // tool access extends beyond the primary working directory.  The CLI
    // accepts repeated `--add-dir` values OR a space-separated list after
    // a single flag; passing one flag per dir keeps the argv readable.
    for dir in add_dirs {
        if !dir.is_empty() {
            args.push("--add-dir".into());
            args.push(dir.clone());
        }
    }
    SpawnArgs {
        args,
        working_dir: working_dir.to_string(),
    }
}

// ─── Tauri commands ────────────────────────────────────────────────

/// Spawn a Claude agent subprocess for `session_id`.  Returns the Claude session
/// UUID we passed via `--session-id` so the frontend can track it for resume.
///
/// The argument list mirrors `build_spawn_args` plus the Tauri `State` and
/// `AppHandle` — same justification: each is a real Claude flag.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn spawn_agent_session(
    state: State<'_, AgentState>,
    app: AppHandle,
    session_id: String,
    working_dir: String,
    prior_uuid: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    effort: Option<String>,
    add_dirs: Option<Vec<String>>,
    fork: Option<bool>,
) -> Result<String, String> {
    let fork = fork.unwrap_or(false);
    let claude_session_id = match (prior_uuid.as_deref(), fork) {
        (Some(uuid), false) => uuid.to_string(),
        (Some(_), true) | (None, _) => uuid::Uuid::new_v4().to_string(),
    };
    let dirs: Vec<String> = add_dirs.unwrap_or_default();
    let plan = build_spawn_args(
        &claude_session_id,
        &working_dir,
        prior_uuid.as_deref(),
        model.as_deref(),
        permission_mode.as_deref(),
        effort.as_deref(),
        &dirs,
        fork,
    );

    // ─── M1 SDK adoption ────────────────────────────────────────────
    // We no longer spawn `claude` directly.  Instead we spawn a Node
    // bridge (`hermes-claude-bridge.mjs`) that drives the Claude Agent
    // SDK in-process and pipes the SDK's message stream back out as the
    // same NDJSON format `claude --print stream-json` produces — so the
    // existing message-store reducer and IPC plumbing work unchanged.
    //
    // The bridge gives us the SDK's superpowers (interrupt(), setModel(),
    // setMcpServers(), rewindFiles(), canUseTool, in-process MCP).
    // Toggle back to direct claude with HERMES_AGENT_DIRECT=1 for one-off
    // debugging.  The bridge path is the default and the e2e suite runs
    // through it.
    let use_direct = std::env::var("HERMES_AGENT_DIRECT")
        .map(|v| v == "1" || v == "true")
        .unwrap_or(false);
    let bridge_path = resolve_bridge_path()?;

    log::info!(
        "[agent spawn] sid={} cwd={} bridge={} use_direct={} argv={:?}",
        session_id,
        plan.working_dir,
        bridge_path.display(),
        use_direct,
        plan.args,
    );
    eprintln!(
        "[agent spawn] sid={} cwd={} bridge={} use_direct={} argv={:?}",
        session_id,
        plan.working_dir,
        bridge_path.display(),
        use_direct,
        plan.args,
    );

    // Hermes IDE state file: a JSON blob the bridge's MCP tools read on
    // demand to answer "what does the IDE see right now?".  Lives under
    // `~/.hermes-ide/sessions/<sid>/state.json`.  Initial content is the
    // attached project paths + cwd; future updates (active file, git
    // status, memory pins) write to the same path.
    let state_path =
        ensure_hermes_state_file(&session_id, &working_dir, &dirs).unwrap_or_else(|err| {
            log::warn!("[agent spawn] could not init hermes state file: {}", err);
            String::new()
        });

    let mut cmd = if use_direct {
        let mut c = Command::new("claude");
        c.args(&plan.args);
        c
    } else {
        let mut c = Command::new("node");
        c.arg(&bridge_path);
        // The bridge needs --working-dir as a flag (it sets the SDK `cwd`).
        // We still set Command::current_dir below so any relative paths in
        // the SDK's spawn of the claude binary resolve from the same place.
        c.args(["--working-dir", &plan.working_dir]);
        if !state_path.is_empty() {
            c.args(["--hermes-state-path", &state_path]);
        }
        c.args(&plan.args);
        c
    };
    cmd.current_dir(&plan.working_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn agent runtime: {}", e))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to capture child stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture child stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture child stderr".to_string())?;
    let pid = child.id();

    // stdout reader: parse each line as JSON, emit on `agent-event-{session_id}`.
    {
        let app = app.clone();
        let sid = session_id.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => emit_stdout_line(&app, &sid, &line),
                    Ok(None) => break,
                    Err(e) => {
                        log::warn!("agent[{}] stdout read error: {}", sid, e);
                        break;
                    }
                }
            }
        });
    }

    // stderr reader: emit raw lines on `agent-stderr-{session_id}`.  The
    // frontend's <AgentSessionView> listener types this channel as `string`,
    // so we must emit a bare string (not a `{ line }` envelope) — otherwise
    // it concatenates `[object Object]` into the rendered stderr buffer.
    // Trailing newline is added so concatenated lines stay one-per-line in
    // the UI.
    {
        let app = app.clone();
        let sid = session_id.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        let mut payload = line;
                        payload.push('\n');
                        let _ = app.emit(&format!("agent-stderr-{}", sid), &payload);
                    }
                    Ok(None) => break,
                    Err(e) => {
                        log::warn!("agent[{}] stderr read error: {}", sid, e);
                        break;
                    }
                }
            }
        });
    }

    // Stash the live child + stdin for later input / interrupt / close.
    let sessions_handle = state.handle();
    {
        let mut sessions = sessions_handle.lock().await;
        if sessions.contains_key(&session_id) {
            return Err(format!("Agent session '{}' already exists", session_id));
        }
        sessions.insert(
            session_id.clone(),
            AgentChild {
                child: Some(child),
                stdin: Some(stdin),
                pid,
            },
        );
    }

    // Child waiter: takes ownership of the Child handle out of the state map
    // when the process exits, emits an `agent-exit-{session_id}` event, and
    // removes the entry so subsequent `send_agent_input` calls fail fast.
    {
        let app = app.clone();
        let sid = session_id.clone();
        let waiter_handle = Arc::clone(&sessions_handle);
        tokio::spawn(async move {
            await_child_exit(waiter_handle, app, sid).await;
        });
    }

    Ok(claude_session_id)
}

/// Write one NDJSON event to the agent's stdin.  `payload` is serialized + a
/// trailing newline appended; callers should pass a Claude-input-format-shaped
/// JSON value (typically a `user` envelope).
#[tauri::command]
pub async fn send_agent_input(
    state: State<'_, AgentState>,
    session_id: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    let sessions_handle = state.handle();
    let mut sessions = sessions_handle.lock().await;
    let entry = sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("Agent session '{}' not found", session_id))?;
    let stdin = entry
        .stdin
        .as_mut()
        .ok_or_else(|| format!("Agent session '{}' has no stdin (closed?)", session_id))?;

    let mut line =
        serde_json::to_vec(&payload).map_err(|e| format!("Failed to serialize payload: {}", e))?;
    line.push(b'\n');

    stdin
        .write_all(&line)
        .await
        .map_err(|e| format!("Failed to write to agent stdin: {}", e))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush agent stdin: {}", e))?;
    Ok(())
}

/// Send SIGINT (Unix) / kill-equivalent (Windows) to the subprocess to interrupt
/// the in-flight turn without tearing down the session.  The next user input
/// starts a fresh turn.
#[tauri::command]
pub async fn interrupt_agent(
    state: State<'_, AgentState>,
    session_id: String,
) -> Result<(), String> {
    let sessions_handle = state.handle();

    #[cfg(unix)]
    {
        let sessions = sessions_handle.lock().await;
        let entry = sessions
            .get(&session_id)
            .ok_or_else(|| format!("Agent session '{}' not found", session_id))?;
        let pid = entry
            .child
            .as_ref()
            .and_then(|c| c.id())
            .ok_or_else(|| format!("Agent session '{}' has no live PID", session_id))?;

        if pid > i32::MAX as u32 {
            return Err(format!("PID {} out of range for SIGINT", pid));
        }
        // Safety: libc::kill is FFI; we pass a validated PID and a known
        // signal constant.  No unsafe state is mutated here.
        let rc = unsafe { libc::kill(pid as i32, libc::SIGINT) };
        if rc != 0 {
            return Err(format!(
                "kill(SIGINT) failed for pid {}: {}",
                pid,
                std::io::Error::last_os_error()
            ));
        }
    }

    #[cfg(windows)]
    {
        // Windows has no clean per-process SIGINT equivalent without a shared
        // console group.  Best-effort: terminate the child.  The waiter task
        // will clean up the state map and emit the exit event.
        let mut sessions = sessions_handle.lock().await;
        let entry = sessions
            .get_mut(&session_id)
            .ok_or_else(|| format!("Agent session '{}' not found", session_id))?;
        if let Some(child) = entry.child.as_mut() {
            child
                .start_kill()
                .map_err(|e| format!("Failed to terminate agent child: {}", e))?;
        }
    }

    Ok(())
}

/// Graceful shutdown: drop stdin (signals EOF), wait briefly, then kill.
/// Removes the entry from state so the session id can be reused.
#[tauri::command]
pub async fn close_agent_session(
    state: State<'_, AgentState>,
    session_id: String,
) -> Result<(), String> {
    let sessions_handle = state.handle();

    let entry_opt = {
        let mut sessions = sessions_handle.lock().await;
        sessions.remove(&session_id)
    };

    let mut entry = match entry_opt {
        Some(e) => e,
        None => return Err(format!("Agent session '{}' not found", session_id)),
    };

    // Drop stdin to signal EOF to the subprocess.
    drop(entry.stdin.take());

    let mut child = match entry.child.take() {
        Some(c) => c,
        None => return Ok(()),
    };

    match timeout(Duration::from_secs(1), child.wait()).await {
        Ok(Ok(_status)) => Ok(()),
        Ok(Err(e)) => Err(format!("Wait failed for agent child: {}", e)),
        Err(_) => {
            child
                .start_kill()
                .map_err(|e| format!("Failed to kill agent child: {}", e))?;
            let _ = child.wait().await;
            Ok(())
        }
    }
}

/// Diagnostic: locate `claude` on PATH and return its version + resolved path.
/// Frontend calls this on startup to decide whether Agent mode is available.
/// Update the Hermes IDE state file the bridge's MCP tools read from.
/// Called by the frontend whenever per-session IDE state changes (active
/// file switched, project attached/detached, memory pin added, etc.).
///
/// The file is overwritten atomically; the next `mcp__hermes__*` tool call
/// from Claude reads the fresh value.  No respawn / refork needed.
#[tauri::command]
pub async fn update_hermes_state(
    session_id: String,
    state: serde_json::Value,
) -> Result<(), String> {
    update_hermes_state_file(&session_id, &state)
}

#[tauri::command]
pub async fn check_claude_cli() -> Result<ClaudeCliInfo, String> {
    let path = which_claude().ok_or_else(|| {
        "`claude` not found on PATH. Install Claude Code from https://claude.com/download"
            .to_string()
    })?;

    let output = Command::new(&path)
        .arg("--version")
        .output()
        .await
        .map_err(|e| format!("Failed to run `claude --version`: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "`claude --version` exited with status {:?}: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let raw = String::from_utf8_lossy(&output.stdout).to_string();
    let version = parse_claude_version(&raw).unwrap_or_else(|| raw.trim().to_string());
    Ok(ClaudeCliInfo {
        version,
        path: path.to_string_lossy().to_string(),
    })
}

/// Maximum byte size for `read_image_for_attachment`.  Mirrors the cap the
/// composer uses when accepting pasted clipboard images so a single dropped
/// file can't OOM the renderer when base64-encoded.
pub const MAX_IMAGE_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;

/// Allowed image extensions for `read_image_for_attachment`.  Matched
/// case-insensitively against the file's extension.  Anything else is
/// refused so this command can't be repurposed to slurp arbitrary files
/// off disk.
const ALLOWED_IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp"];

/// Read an image file from disk so the composer can build a base64 data URL
/// for the thumbnail preview AND embed it in the JSON-RPC message sent to
/// the agent subprocess.
///
/// Constraints:
/// - Path must end in one of [`ALLOWED_IMAGE_EXTENSIONS`].
/// - File size must be <= [`MAX_IMAGE_ATTACHMENT_BYTES`] (20 MB).
///
/// Returns the raw bytes; the caller (frontend) is responsible for
/// base64-encoding before transit.
#[tauri::command]
pub async fn read_image_for_attachment(path: String) -> Result<Vec<u8>, String> {
    let p = std::path::PathBuf::from(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    if !ALLOWED_IMAGE_EXTENSIONS
        .iter()
        .any(|allowed| *allowed == ext)
    {
        return Err(format!(
            "Refusing to read non-image file (extension '{}'): {}",
            ext, path
        ));
    }

    let meta = tokio::fs::metadata(&p)
        .await
        .map_err(|e| format!("Failed to stat '{}': {}", path, e))?;
    if !meta.is_file() {
        return Err(format!("Path is not a regular file: {}", path));
    }
    if meta.len() > MAX_IMAGE_ATTACHMENT_BYTES {
        return Err(format!(
            "Image too large ({} bytes > {} limit): {}",
            meta.len(),
            MAX_IMAGE_ATTACHMENT_BYTES,
            path
        ));
    }

    tokio::fs::read(&p)
        .await
        .map_err(|e| format!("Failed to read '{}': {}", path, e))
}

// ─── Internals ─────────────────────────────────────────────────────

/// Wait for a child to exit, emit `agent-exit-{session_id}`, and clean up
/// the state entry.  Designed to be `tokio::spawn`'d.
async fn await_child_exit(sessions: SessionMap, app: AppHandle, session_id: String) {
    let mut child = {
        let mut guard = sessions.lock().await;
        match guard.get_mut(&session_id) {
            Some(entry) => match entry.child.take() {
                Some(c) => c,
                None => return,
            },
            None => return,
        }
    };

    let status = match child.wait().await {
        Ok(s) => s,
        Err(e) => {
            log::warn!("agent[{}] wait error: {}", session_id, e);
            sessions.lock().await.remove(&session_id);
            let _ = app.emit(
                &format!("agent-exit-{}", session_id),
                serde_json::json!({
                    "code": serde_json::Value::Null,
                    "signal": serde_json::Value::Null,
                    "error": e.to_string(),
                }),
            );
            return;
        }
    };

    let code = status.code();
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.signal()
    };
    #[cfg(not(unix))]
    let signal: Option<i32> = None;

    sessions.lock().await.remove(&session_id);

    let _ = app.emit(
        &format!("agent-exit-{}", session_id),
        serde_json::json!({
            "code": code,
            "signal": signal,
        }),
    );
}

/// Best-effort UTF-8 decode + JSON parse + emit.  On parse failure we emit a
/// synthetic `parse_error` event so the frontend can surface it instead of
/// silently dropping the line.
fn emit_stdout_line(app: &AppHandle, session_id: &str, line: &str) {
    match serde_json::from_str::<serde_json::Value>(line) {
        Ok(value) => {
            let _ = app.emit(&format!("agent-event-{}", session_id), &value);
        }
        Err(e) => {
            log::warn!(
                "agent[{}] failed to parse NDJSON line: {} (line: {:?})",
                session_id,
                e,
                truncate_for_log(line, 200)
            );
            let _ = app.emit(
                &format!("agent-event-{}", session_id),
                serde_json::json!({
                    "type": "parse_error",
                    "raw": truncate_for_log(line, 4096),
                    "error": e.to_string(),
                }),
            );
        }
    }
}

fn truncate_for_log(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        let mut t = s[..max].to_string();
        t.push_str("…[truncated]");
        t
    }
}

/// Cross-platform `which`-style lookup for the `claude` binary.  Returns
/// `None` if not found on PATH.
fn which_claude() -> Option<std::path::PathBuf> {
    let exe_name = if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    };
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(exe_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Pull a semver-ish prefix out of `claude --version` output, e.g.
/// `"2.1.126 (Claude Code)"` -> `"2.1.126"`.
fn parse_claude_version(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let first_token = trimmed.split_whitespace().next()?;
    if first_token.chars().all(|c| c.is_ascii_digit() || c == '.') && first_token.contains('.') {
        Some(first_token.to_string())
    } else {
        None
    }
}

// ─── Tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod e2e_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(name: &str) -> PathBuf {
        let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        p.push("test-fixtures");
        p.push("agent-stream");
        p.push(name);
        p
    }

    fn read_fixture_lines(name: &str) -> Vec<String> {
        let path = fixture(name);
        let content = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("Failed to read fixture {:?}: {}", path, e));
        content
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| l.to_string())
            .collect()
    }

    fn assert_fixture_shape(name: &str) {
        let lines = read_fixture_lines(name);
        assert!(
            !lines.is_empty(),
            "fixture {} should contain at least one NDJSON line",
            name
        );

        let mut saw_assistant = false;
        for (i, line) in lines.iter().enumerate() {
            let parsed: serde_json::Value = serde_json::from_str(line).unwrap_or_else(|e| {
                panic!(
                    "fixture {} line {} failed to parse as JSON: {} (line: {:?})",
                    name, i, e, line
                )
            });
            let ty = parsed
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or_else(|| panic!("fixture {} line {} missing `type`", name, i));
            if ty == "assistant" {
                saw_assistant = true;
            }
        }

        let first: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(
            first.get("type").and_then(|v| v.as_str()),
            Some("system"),
            "fixture {}: first line must be a system event",
            name
        );
        assert_eq!(
            first.get("subtype").and_then(|v| v.as_str()),
            Some("init"),
            "fixture {}: first line must be system/init",
            name
        );

        let last: serde_json::Value = serde_json::from_str(lines.last().unwrap()).unwrap();
        assert_eq!(
            last.get("type").and_then(|v| v.as_str()),
            Some("result"),
            "fixture {}: last line must be a result event",
            name
        );
        let subtype = last
            .get("subtype")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        assert!(
            subtype == "success" || subtype == "error",
            "fixture {}: result subtype must be 'success' or 'error', got {:?}",
            name,
            subtype
        );

        assert!(
            saw_assistant,
            "fixture {}: expected at least one assistant event",
            name
        );
    }

    #[test]
    fn fixture_text_response_shape() {
        assert_fixture_shape("text-response.ndjson");
    }

    #[test]
    fn fixture_tool_bash_shape() {
        assert_fixture_shape("tool-bash.ndjson");
    }

    #[test]
    fn fixture_thinking_shape() {
        assert_fixture_shape("thinking.ndjson");
    }

    #[test]
    fn build_spawn_args_minimal() {
        let plan = build_spawn_args(
            "session-uuid",
            "/tmp/wd",
            None,
            None,
            None,
            None,
            &[],
            false,
        );
        assert_eq!(plan.working_dir, "/tmp/wd");
        assert_eq!(
            plan.args,
            vec![
                "--print",
                "--output-format",
                "stream-json",
                "--input-format",
                "stream-json",
                "--include-partial-messages",
                "--verbose",
                "--session-id",
                "session-uuid",
            ]
        );
    }

    #[test]
    fn build_spawn_args_resume_omits_session_id() {
        // Plain resume (no fork): claude rejects `--session-id` alongside
        // `--resume`, and we want to keep the same session id anyway.
        let plan = build_spawn_args(
            "ignored",
            "/work",
            Some("prior-uuid"),
            None,
            None,
            None,
            &[],
            false,
        );
        let s = plan.args.join(" ");
        assert!(!s.contains("--session-id"), "args were: {:?}", plan.args);
        assert!(
            s.contains("--resume prior-uuid"),
            "args were: {:?}",
            plan.args
        );
        assert!(!s.contains("--fork-session"), "args were: {:?}", plan.args);
    }

    #[test]
    fn build_spawn_args_initial_uses_session_id_not_resume() {
        let plan = build_spawn_args("brand-new", "/work", None, None, None, None, &[], false);
        let s = plan.args.join(" ");
        assert!(s.contains("--session-id brand-new"));
        assert!(!s.contains("--resume"));
        assert!(!s.contains("--fork-session"));
    }

    #[test]
    fn build_spawn_args_fork_emits_session_id_resume_and_fork_session() {
        // Fork branch: new session id + resume + --fork-session.  This is
        // the only mode in which `--model` and `--permission-mode` actually
        // apply when there's a prior conversation to inherit from.
        let plan = build_spawn_args(
            "new-id",
            "/work",
            Some("prior-uuid"),
            Some("opus"),
            Some("plan"),
            None,
            &[],
            true,
        );
        let s = plan.args.join(" ");
        assert!(
            s.contains("--session-id new-id"),
            "args were: {:?}",
            plan.args
        );
        assert!(
            s.contains("--resume prior-uuid"),
            "args were: {:?}",
            plan.args
        );
        assert!(s.contains("--fork-session"), "args were: {:?}", plan.args);
        assert!(s.contains("--model opus"), "args were: {:?}", plan.args);
        assert!(
            s.contains("--permission-mode plan"),
            "args were: {:?}",
            plan.args
        );
    }

    #[test]
    fn build_spawn_args_fork_without_prior_uuid_falls_back_to_initial_shape() {
        // `fork = true` is meaningless without a prior uuid to branch from —
        // pin that we don't emit a stray --fork-session in that case.
        let plan = build_spawn_args("new-id", "/work", None, None, None, None, &[], true);
        let s = plan.args.join(" ");
        assert!(s.contains("--session-id new-id"));
        assert!(!s.contains("--resume"));
        assert!(!s.contains("--fork-session"));
    }

    #[test]
    fn build_spawn_args_with_model() {
        let plan = build_spawn_args("sid", "/w", None, Some("haiku"), None, None, &[], false);
        assert_eq!(plan.args.last().map(String::as_str), Some("haiku"));
        assert_eq!(
            plan.args[plan.args.len() - 2..],
            ["--model".to_string(), "haiku".to_string()]
        );
    }

    #[test]
    fn build_spawn_args_resume_and_model_order() {
        let plan = build_spawn_args(
            "sid",
            "/w",
            Some("prior"),
            Some("sonnet"),
            None,
            None,
            &[],
            false,
        );
        let pos_resume = plan.args.iter().position(|a| a == "--resume").unwrap();
        let pos_model = plan.args.iter().position(|a| a == "--model").unwrap();
        assert!(pos_resume < pos_model);
        // No --session-id at all when resuming without fork.
        assert!(plan.args.iter().position(|a| a == "--session-id").is_none());
    }

    #[test]
    fn build_spawn_args_with_permission_mode_accepted() {
        for mode in ["default", "acceptEdits", "plan", "bypassPermissions"] {
            let plan = build_spawn_args("sid", "/w", None, None, Some(mode), None, &[], false);
            let s = plan.args.join(" ");
            assert!(
                s.contains(&format!("--permission-mode {}", mode)),
                "expected mode {:?} in {:?}",
                mode,
                plan.args,
            );
        }
    }

    #[test]
    fn build_spawn_args_rejects_unknown_permission_mode() {
        // Anything outside Claude's published list is dropped silently —
        // passing it through would make the subprocess exit at startup.
        let plan = build_spawn_args("sid", "/w", None, None, Some("god-mode"), None, &[], false);
        let s = plan.args.join(" ");
        assert!(!s.contains("--permission-mode"));
    }

    // ─── --add-dir multi-folder coverage (multi-attach bug guard) ─────
    //
    // When the user attaches multiple projects to a single session, every
    // path must reach the SDK as a separate `--add-dir <p>` pair so the
    // bridge's flag parser can re-pack them into the SDK's
    // `additionalDirectories` array.  A regression here would silently
    // drop attached projects from Claude's tool sandbox.

    #[test]
    fn build_spawn_args_initial_emits_one_add_dir_per_path_in_input_order() {
        let dirs = vec![
            "/Users/dev/proj-a".to_string(),
            "/Users/dev/proj-b".to_string(),
            "/Users/dev/proj-c".to_string(),
        ];
        let plan = build_spawn_args("sid", "/w", None, None, None, None, &dirs, false);

        // Three flag/value pairs, in input order.
        let pairs: Vec<(&str, &str)> = plan
            .args
            .windows(2)
            .filter(|w| w[0] == "--add-dir")
            .map(|w| (w[0].as_str(), w[1].as_str()))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("--add-dir", "/Users/dev/proj-a"),
                ("--add-dir", "/Users/dev/proj-b"),
                ("--add-dir", "/Users/dev/proj-c"),
            ],
        );
    }

    #[test]
    fn build_spawn_args_resume_carries_all_add_dirs_after_resume_flag() {
        // Plain --resume should still pick up the latest add-dir set; the
        // SDK's `additionalDirectories` is per-invocation, not persisted
        // in the session blob.  Without this, a respawn between turns
        // would silently strip the user's just-attached project.
        let dirs = vec![
            "/Users/dev/proj-a".to_string(),
            "/Users/dev/proj-b".to_string(),
        ];
        let plan = build_spawn_args(
            "sid",
            "/w",
            Some("prior-uuid"),
            None,
            None,
            None,
            &dirs,
            false,
        );

        let pos_resume = plan.args.iter().position(|a| a == "--resume").unwrap();
        let add_dir_positions: Vec<usize> = plan
            .args
            .iter()
            .enumerate()
            .filter(|(_, a)| *a == "--add-dir")
            .map(|(i, _)| i)
            .collect();

        assert_eq!(add_dir_positions.len(), 2);
        for pos in &add_dir_positions {
            assert!(
                *pos > pos_resume,
                "--add-dir at {} must come after --resume at {}; full args: {:?}",
                pos,
                pos_resume,
                plan.args,
            );
        }
        // Values present and in order.
        assert_eq!(plan.args[add_dir_positions[0] + 1], "/Users/dev/proj-a");
        assert_eq!(plan.args[add_dir_positions[1] + 1], "/Users/dev/proj-b");
    }

    #[test]
    fn build_spawn_args_fork_carries_all_add_dirs() {
        let dirs = vec![
            "/Users/dev/proj-a".to_string(),
            "/Users/dev/proj-b".to_string(),
        ];
        let plan = build_spawn_args(
            "new-id",
            "/w",
            Some("prior"),
            Some("opus"),
            Some("plan"),
            None,
            &dirs,
            true,
        );
        let count = plan.args.iter().filter(|a| *a == "--add-dir").count();
        assert_eq!(
            count, 2,
            "fork respawn must carry every --add-dir; got: {:?}",
            plan.args
        );
    }

    #[test]
    fn build_spawn_args_skips_empty_add_dir_strings() {
        // Defensive: an empty path would be a CLI error.  We silently drop
        // empties so a stray "" in the workspace_paths list (from a bad
        // restore or a UI bug) doesn't crash the spawn.
        let dirs = vec!["".to_string(), "/Users/dev/proj-a".to_string()];
        let plan = build_spawn_args("sid", "/w", None, None, None, None, &dirs, false);
        let count = plan.args.iter().filter(|a| *a == "--add-dir").count();
        assert_eq!(count, 1);
        let pos = plan.args.iter().position(|a| a == "--add-dir").unwrap();
        assert_eq!(plan.args[pos + 1], "/Users/dev/proj-a");
    }

    #[test]
    fn build_spawn_args_no_add_dir_when_empty_list() {
        let plan = build_spawn_args("sid", "/w", None, None, None, None, &[], false);
        assert!(
            !plan.args.iter().any(|a| a == "--add-dir"),
            "no --add-dir flag should be emitted for an empty list; got: {:?}",
            plan.args,
        );
    }

    #[test]
    fn parse_claude_version_strips_suffix() {
        assert_eq!(
            parse_claude_version("2.1.126 (Claude Code)"),
            Some("2.1.126".to_string())
        );
        assert_eq!(parse_claude_version("  3.0.1\n"), Some("3.0.1".to_string()));
    }

    #[test]
    fn parse_claude_version_rejects_non_semver() {
        assert_eq!(parse_claude_version("claude version unknown"), None);
        assert_eq!(parse_claude_version(""), None);
    }

    #[test]
    fn truncate_for_log_short_passthrough() {
        assert_eq!(truncate_for_log("hi", 100), "hi");
    }

    #[test]
    fn truncate_for_log_long_truncates() {
        let s = "x".repeat(50);
        let out = truncate_for_log(&s, 10);
        assert!(out.starts_with(&"x".repeat(10)));
        assert!(out.contains("truncated"));
    }

    #[test]
    fn agent_state_default_empty() {
        let state = AgentState::default();
        let map = state.handle();
        let len = futures_executor_block_on(async move {
            let guard = map.lock().await;
            guard.len()
        });
        assert_eq!(len, 0);
    }

    /// Live integration smoke test.  Run with:
    /// `cargo test --lib agent::tests::live_spawn_round_trip -- --ignored --nocapture`
    #[ignore]
    #[tokio::test]
    async fn live_spawn_round_trip() {
        let plan = build_spawn_args(
            "00000000-0000-0000-0000-000000000001",
            "/tmp",
            None,
            Some("haiku"),
            None,
            None,
            &[],
            false,
        );
        let out = Command::new("claude")
            .args(&plan.args)
            .arg("--max-turns")
            .arg("1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();
        assert!(out.is_ok(), "claude must be on PATH for the live test");
    }

    /// Tiny helper so we can call async code from a sync test without
    /// requiring `tokio_test` as a dep.
    fn futures_executor_block_on<F: std::future::Future>(fut: F) -> F::Output {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("Tokio runtime");
        rt.block_on(fut)
    }
}
