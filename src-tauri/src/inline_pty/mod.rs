//! Lightweight one-shot PTY for embedded slash-command terminals.
//!
//! Hermes' main `PtyManager` is heavyweight: it persists sessions to
//! the database, tracks worktrees, runs agent-detection nudges, and
//! is keyed off Hermes session ids.  None of that fits when the user
//! picks `/mcp` from the slash dropdown and just wants to run
//! `claude /mcp` interactively in a 280-px-tall xterm above the
//! composer.
//!
//! This module exposes a focused IPC surface for that use case:
//!
//!   spawn_inline_pty(command, args, cwd, rows, cols) -> pty_id
//!   write_inline_pty(pty_id, data)
//!   resize_inline_pty(pty_id, rows, cols)
//!   kill_inline_pty(pty_id)
//!
//! Each spawn registers a fresh PTY with a unique id.  A background
//! reader thread streams output to the frontend as Tauri events:
//!
//!   `inline-pty-output-{pty_id}` — UTF-8 chunks of stdout/stderr
//!   `inline-pty-exit-{pty_id}`   — fired once when the child exits,
//!                                  with the exit code (or null on
//!                                  signal).

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

#[derive(Serialize, Clone)]
pub struct InlinePtyExitPayload {
    pub code: Option<i32>,
}

struct InlinePty {
    /// Process kill handle — drop on close to terminate the child.
    killer: Box<dyn ChildKiller + Send>,
    /// Writes to the PTY master (stdin to the child).
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// Master PTY — kept alive so resize works.  Wrapped in Arc<Mutex>
    /// so the resize command can borrow it without locking out the
    /// writer.
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
}

#[derive(Default)]
pub struct InlinePtyManager {
    inner: Mutex<HashMap<String, InlinePty>>,
}

impl InlinePtyManager {
    pub fn new() -> Self {
        Self::default()
    }
}

#[tauri::command]
pub fn spawn_inline_pty(
    app: AppHandle,
    state: State<'_, InlinePtyManager>,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
) -> Result<String, String> {
    if command.trim().is_empty() {
        return Err("command is required".to_string());
    }
    let rows = rows.unwrap_or(24);
    let cols = cols.unwrap_or(80);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let mut cmd = CommandBuilder::new(&command);
    for a in &args {
        cmd.arg(a);
    }
    if let Some(d) = cwd.as_deref().filter(|s| !s.is_empty()) {
        cmd.cwd(d);
    }
    // Forward TERM so xterm.js sees a recognizable terminal type.
    cmd.env("TERM", "xterm-256color");
    // Hint to interactive CLIs that this IS a TTY.
    cmd.env("COLORTERM", "truecolor");

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn: {e}"))?;
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer: {e}"))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader: {e}"))?;
    let killer = child.clone_killer();

    let pty_id = format!("ipty-{}", Uuid::new_v4());

    // Reader thread — emits output chunks until the master EOFs
    // (which happens when the child closes).
    {
        let app = app.clone();
        let pty_id = pty_id.clone();
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 4096];
            loop {
                match std::io::Read::read(&mut reader, &mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                        let event = format!("inline-pty-output-{pty_id}");
                        let _ = app.emit(&event, chunk);
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // Wait thread — emits an exit event once the child terminates.
    {
        let app = app.clone();
        let pty_id = pty_id.clone();
        std::thread::spawn(move || {
            let exit_code = match child.wait() {
                Ok(status) => {
                    if status.success() {
                        Some(0)
                    } else {
                        // portable_pty's ExitStatus exposes exit_code()
                        Some(status.exit_code() as i32)
                    }
                }
                Err(_) => None,
            };
            let event = format!("inline-pty-exit-{pty_id}");
            let _ = app.emit(&event, InlinePtyExitPayload { code: exit_code });
        });
    }

    let mut map = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    map.insert(
        pty_id.clone(),
        InlinePty {
            killer,
            writer: Arc::new(Mutex::new(writer)),
            master: Arc::new(Mutex::new(pair.master)),
        },
    );

    Ok(pty_id)
}

#[tauri::command]
pub fn write_inline_pty(
    state: State<'_, InlinePtyManager>,
    pty_id: String,
    data: String,
) -> Result<(), String> {
    let map = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    let entry = map.get(&pty_id).ok_or("inline pty not found")?;
    let mut w = entry.writer.lock().unwrap_or_else(|e| e.into_inner());
    w.write_all(data.as_bytes())
        .map_err(|e| format!("write: {e}"))?;
    w.flush().map_err(|e| format!("flush: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn resize_inline_pty(
    state: State<'_, InlinePtyManager>,
    pty_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let map = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    let entry = map.get(&pty_id).ok_or("inline pty not found")?;
    let master = entry.master.lock().unwrap_or_else(|e| e.into_inner());
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn kill_inline_pty(state: State<'_, InlinePtyManager>, pty_id: String) -> Result<(), String> {
    let mut map = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut entry) = map.remove(&pty_id) {
        let _ = entry.killer.kill();
    }
    Ok(())
}
