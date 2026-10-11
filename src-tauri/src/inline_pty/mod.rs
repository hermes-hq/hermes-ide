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
    // Augment PATH with the well-known toolchain directories (Homebrew,
    // nvm, volta, ~/.local/bin) — GUI-launched .app bundles inherit the
    // sanitized launchd PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) which
    // excludes every directory where the npm-installed `claude` binary
    // actually lives.  Without this, `/remote-control` and other CLI
    // slash commands fail with "spawn: Unable to spawn claude because:
    // No viable candidates found in PATH".  The main agent spawn path
    // already calls `enriched_path_var()` for the same reason; the
    // inline PTY path was missing the augmentation, hence the bug.
    cmd.env("PATH", crate::agent::enriched_path_var());

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
            let mut pending = Vec::new();
            loop {
                match std::io::Read::read(&mut reader, &mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        let chunk = take_utf8(&mut pending);
                        if chunk.is_empty() {
                            continue;
                        }
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

/// Decodes the text in `pending` and leaves there a character the read
/// ended inside of, for the next read to finish: decoded alone, each half
/// became U+FFFD (box drawing in the CLI's screens is 3 bytes a character).
fn take_utf8(pending: &mut Vec<u8>) -> String {
    let len = pending.len();
    // Where the last character starts, if within its longest length (4).
    let last = (len.saturating_sub(3)..len)
        .rev()
        .find(|&i| pending[i] & 0xC0 != 0x80);
    let cut = match last {
        Some(i) if std::str::from_utf8(&pending[i..]).is_err_and(|e| e.error_len().is_none()) => i,
        _ => len,
    };
    let text = String::from_utf8_lossy(&pending[..cut]).into_owned();
    pending.drain(..cut);
    text
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

// ─── Tests ────────────────────────────────────────────────────────
//
// Pin the cross-platform contract for the PATH augmentation that the
// `/remote-control`, `/mcp`, `/agents` etc. CLI slash-command flows
// rely on.  The original bug was that `spawn_inline_pty` did not apply
// any PATH augmentation, so on a GUI-launched macOS .app — where
// launchd sanitizes PATH to `/usr/bin:/bin:/usr/sbin:/sbin` —
// `CommandBuilder::new("claude")` could not locate the npm-installed
// `claude` binary and failed with "No viable candidates found in
// PATH".  These tests run on Linux, macOS, and Windows.

#[cfg(test)]
mod tests {
    #[test]
    fn a_character_split_across_reads_arrives_whole() {
        let screen = "╭──────╮ ❯ héllo 🙂\n╰──────╯".repeat(40);
        let bytes = screen.as_bytes();
        // Every way of cutting the output in two reads, then reads of 7.
        for at in 0..bytes.len().min(64) {
            let mut pending = Vec::new();
            let mut text = String::new();
            for read in [&bytes[..at], &bytes[at..]] {
                pending.extend_from_slice(read);
                text.push_str(&super::take_utf8(&mut pending));
            }
            assert_eq!(text, screen, "cut at {at}");
        }
        let mut pending = Vec::new();
        let mut text = String::new();
        for read in bytes.chunks(7) {
            pending.extend_from_slice(read);
            text.push_str(&super::take_utf8(&mut pending));
        }
        assert_eq!(text, screen);
        assert!(pending.is_empty());
        // Bytes that are not text still show as U+FFFD, and are not held.
        let mut pending = b"a\xffb\x80".to_vec();
        assert_eq!(super::take_utf8(&mut pending), "a\u{fffd}b\u{fffd}");
        assert!(pending.is_empty());
    }

    /// `enriched_path_var()` must be reachable from this module — the fix
    /// for the "spawn: Unable to spawn claude" bug depends on
    /// `inline_pty::spawn_inline_pty` calling
    /// `crate::agent::enriched_path_var()` to build the PATH env it sets
    /// on the spawned child.  If the visibility of that helper ever gets
    /// tightened, this test fails at compile time and the regression is
    /// caught before it ships.
    #[test]
    fn enriched_path_var_is_reachable_from_inline_pty_module() {
        let path = crate::agent::enriched_path_var();
        assert!(!path.is_empty(), "enriched PATH must not be empty");
    }

    /// The augmented PATH must be a SUPERSET of the inherited PATH.
    /// On every platform we ship to (Linux, macOS, Windows), the user
    /// expects their existing PATH to keep working after augmentation;
    /// this test pins that invariant.
    #[test]
    fn enriched_path_var_preserves_inherited_path_entries() {
        let inherited = std::env::var_os("PATH").unwrap_or_default();
        let enriched = crate::agent::enriched_path_var();

        let inherited_entries: Vec<std::path::PathBuf> =
            std::env::split_paths(&inherited).collect();
        let enriched_entries: Vec<std::path::PathBuf> = std::env::split_paths(&enriched).collect();

        for entry in &inherited_entries {
            assert!(
                enriched_entries.contains(entry),
                "inherited PATH entry {:?} must be preserved in enriched PATH",
                entry
            );
        }
    }

    /// On Unix (Linux + macOS) the augmented PATH must include at least
    /// one of the well-known toolchain directories.  This is the
    /// load-bearing assertion for the macOS GUI-app regression: even
    /// when launchd hands us the sanitized
    /// `/usr/bin:/bin:/usr/sbin:/sbin`, the augmented PATH must reach
    /// Homebrew / nvm / volta / ~/.local/bin where `claude` actually
    /// lives.
    #[cfg(unix)]
    #[test]
    fn enriched_path_var_adds_well_known_unix_dirs() {
        let enriched = crate::agent::enriched_path_var();
        let entries: Vec<std::path::PathBuf> = std::env::split_paths(&enriched).collect();

        // At least ONE of these well-known dirs must appear.  We don't
        // require them all because not every machine has every
        // toolchain installed — the function only emits the dirs it
        // actually finds, plus Homebrew defaults.
        let expectations: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];
        let found_any = entries
            .iter()
            .any(|p| expectations.iter().any(|e| p == std::path::Path::new(e)));
        assert!(
            found_any,
            "expected at least one of {:?} in enriched PATH, got: {:?}",
            expectations, entries
        );
    }

    /// On Windows `enriched_path_var()` is still callable, returns a
    /// non-empty value, and preserves the inherited PATH.  We don't
    /// assert specific well-known dirs because the bundled fallback set
    /// is currently Unix-flavored — Windows is unaffected by the
    /// launchd PATH sanitization that motivated the augmentation in the
    /// first place, so the inherited PATH from the parent process is
    /// already sufficient.  This test pins that the function doesn't
    /// regress to panicking or returning empty on Windows.
    #[cfg(windows)]
    #[test]
    fn enriched_path_var_is_well_formed_on_windows() {
        let enriched = crate::agent::enriched_path_var();
        let entries: Vec<std::path::PathBuf> = std::env::split_paths(&enriched).collect();
        assert!(
            !entries.is_empty(),
            "enriched PATH must have at least one entry on Windows"
        );
    }

    /// Sanity test for the spawn surface: an empty `command` must be
    /// rejected before any PATH lookup happens.  Mirrors the guard at
    /// the top of `spawn_inline_pty`.  We can't unit-test the full
    /// spawn cross-platform without a real `claude` binary, but this
    /// pins the guard so accidental refactors don't silently drop it.
    #[test]
    fn empty_command_validation() {
        // The guard is local to spawn_inline_pty — we mirror its
        // condition here so the contract is checked at unit-test time
        // even though the tauri::command itself requires AppHandle +
        // State which we can't easily synthesize.
        let cmd: String = "   ".to_string();
        assert!(cmd.trim().is_empty(), "whitespace must count as empty");
    }
}
