//! Bridge runtime prewarmer.
//!
//! Spawns a one-shot Node process at app startup that imports the
//! Claude Agent SDK and exits.  This is purely best-effort: the goal is
//! to populate the OS file cache (and Node's V8 module cache where
//! applicable) so the FIRST agent session a user creates spawns
//! noticeably faster — typically saving the bulk of the cold-start
//! "awaiting claude" delay.
//!
//! Failure modes are silent.  If `node` isn't on PATH, the bridge dir
//! isn't resolvable, or the prewarm hits a permission issue, the only
//! consequence is "first session is as slow as before" — never a hard
//! failure.  No user-visible UI surface.
//!
//! Re-entrancy: harmless if invoked twice.  Each call spawns its own
//! short-lived Node process and they don't share state.

use std::process::Stdio;
use std::time::Duration;

use tauri::AppHandle;
use tokio::process::Command;

use super::{resolve_bridge_path, which_node};

/// Spawn a non-blocking, best-effort prewarm of the bridge runtime.
///
/// Returns immediately; the actual prewarm happens on a background
/// tokio task.  Safe to call from `setup()` even before the main
/// window is shown.
pub fn prewarm_bridge_runtime(app: &AppHandle) {
    let app = app.clone();
    tokio::spawn(async move {
        let bridge_path = match resolve_bridge_path(&app) {
            Ok(p) => p,
            Err(e) => {
                log::debug!("[prewarm] skipping — bridge not resolvable: {}", e);
                return;
            }
        };
        let bridge_dir = match bridge_path.parent() {
            Some(p) => p.to_path_buf(),
            None => {
                log::debug!("[prewarm] skipping — bridge has no parent dir");
                return;
            }
        };
        let node = match which_node() {
            Some(n) => n,
            None => {
                log::debug!("[prewarm] skipping — node not on PATH");
                return;
            }
        };

        // Tiny ESM eval: import the SDK so Node loads + parses its
        // module graph.  The catch handler keeps the exit clean even
        // if the SDK throws on import (extremely unlikely).
        let mut cmd = Command::new(&node);
        cmd.arg("--input-type=module")
            .arg("--eval")
            .arg("import('@anthropic-ai/claude-agent-sdk').catch(()=>{});")
            .current_dir(&bridge_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        match cmd.spawn() {
            Ok(mut child) => {
                let timed = tokio::time::timeout(Duration::from_secs(10), child.wait()).await;
                match timed {
                    Ok(Ok(status)) => {
                        log::info!(
                            "[prewarm] bridge runtime warm-up complete (exit {:?})",
                            status.code()
                        );
                    }
                    Ok(Err(e)) => {
                        log::debug!("[prewarm] node child wait error: {}", e);
                    }
                    Err(_) => {
                        log::debug!("[prewarm] timeout — killing child");
                        let _ = child.kill().await;
                    }
                }
            }
            Err(e) => {
                log::debug!("[prewarm] failed to spawn node: {}", e);
            }
        }
    });
}
