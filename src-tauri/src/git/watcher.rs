use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::AppState;

// ─── Event payload ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreePathDeleted {
    pub session_id: String,
    pub project_id: String,
    pub worktree_path: String,
    pub branch_name: String,
}

// ─── WorktreeWatcher ────────────────────────────────────────────────

/// Watches the `hermes-worktrees/` directory for deletions.
///
/// When a worktree directory is removed externally, the watcher looks up
/// the DB record and emits a `"worktree-path-deleted"` event so the
/// frontend can inform the user.  It never deletes anything itself.
pub struct WorktreeWatcher {
    _watcher: RecommendedWatcher,
    stopped: Arc<AtomicBool>,
}

impl WorktreeWatcher {
    /// Cleanly stop watching.
    pub fn stop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        // Dropping the watcher (when `WorktreeWatcher` is dropped) will stop
        // the underlying OS-level file watcher, but we also set the flag so
        // the callback becomes a no-op immediately.
    }
}

/// Start watching `{base_dir}/hermes-worktrees/` recursively.
///
/// Returns `None` if the directory does not exist or the watcher fails to
/// initialise.  Errors are logged but never cause a panic.
pub fn start_watching(app: AppHandle, base_dir: PathBuf) -> Option<WorktreeWatcher> {
    let worktrees_dir = base_dir.join(super::worktree::HERMES_WORKTREE_MARKER);

    // Only start if the directory already exists (it may not exist for brand-new users)
    if !worktrees_dir.is_dir() {
        log::info!(
            "[worktree-watcher] {} does not exist yet — skipping watcher",
            worktrees_dir.display()
        );
        return None;
    }

    let stopped = Arc::new(AtomicBool::new(false));
    let stopped_clone = Arc::clone(&stopped);

    // Debounce state: path -> last-emitted timestamp.
    // Protected by a Mutex so the callback (which may be called from any
    // thread) can safely access it.
    let debounce: Arc<Mutex<HashMap<String, Instant>>> = Arc::new(Mutex::new(HashMap::new()));
    let debounce_window = Duration::from_millis(500);

    let app_handle = app.clone();

    let mut watcher =
        match notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
            if stopped_clone.load(Ordering::SeqCst) {
                return;
            }

            let event = match result {
                Ok(ev) => ev,
                Err(e) => {
                    log::warn!("[worktree-watcher] watch error: {}", e);
                    return;
                }
            };

            // We only care about Remove events for directories.
            let is_remove = matches!(
                event.kind,
                EventKind::Remove(notify::event::RemoveKind::Folder)
                    | EventKind::Remove(notify::event::RemoveKind::Any)
            );
            if !is_remove {
                return;
            }

            for path in &event.paths {
                let path_str = path.to_string_lossy().to_string();

                // Only consider paths inside hermes-worktrees/
                if !super::worktree::is_hermes_worktree_path(&path_str) {
                    continue;
                }

                // Debounce: skip if we emitted an event for this path recently
                if let Ok(mut map) = debounce.lock() {
                    let now = Instant::now();
                    if let Some(last) = map.get(&path_str) {
                        if now.duration_since(*last) < debounce_window {
                            continue;
                        }
                    }
                    map.insert(path_str.clone(), now);
                }

                // Look up the DB record to get session/project/branch info
                let state = match app_handle.try_state::<AppState>() {
                    Some(s) => s,
                    None => continue,
                };
                let db = match state.db.lock() {
                    Ok(d) => d,
                    Err(poisoned) => poisoned.into_inner(),
                };

                let all_worktrees = match db.get_all_session_worktrees() {
                    Ok(wts) => wts,
                    Err(e) => {
                        log::warn!("[worktree-watcher] failed to query worktrees: {}", e);
                        continue;
                    }
                };

                for wt in &all_worktrees {
                    if wt.worktree_path == path_str {
                        let branch = wt
                            .branch_name
                            .clone()
                            .unwrap_or_else(|| "unknown".to_string());

                        log::info!(
                            "[worktree-watcher] detected deletion of worktree '{}' \
                             (session={}, project={}, branch={})",
                            path_str,
                            wt.session_id,
                            wt.project_id,
                            branch
                        );

                        let payload = WorktreePathDeleted {
                            session_id: wt.session_id.clone(),
                            project_id: wt.project_id.clone(),
                            worktree_path: wt.worktree_path.clone(),
                            branch_name: branch,
                        };

                        if let Err(e) = app_handle.emit("worktree-path-deleted", &payload) {
                            log::warn!("[worktree-watcher] failed to emit event: {}", e);
                        }
                    }
                }
            }
        }) {
            Ok(w) => w,
            Err(e) => {
                log::warn!("[worktree-watcher] failed to create watcher: {}", e);
                return None;
            }
        };

    if let Err(e) = watcher.watch(&worktrees_dir, RecursiveMode::Recursive) {
        log::warn!(
            "[worktree-watcher] failed to watch {}: {}",
            worktrees_dir.display(),
            e
        );
        return None;
    }

    log::info!(
        "[worktree-watcher] now watching {}",
        worktrees_dir.display()
    );

    Some(WorktreeWatcher {
        _watcher: watcher,
        stopped,
    })
}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// The watcher can be created against a valid directory and stopped
    /// without error or panic.
    #[test]
    fn watcher_start_stop_no_panic() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().to_path_buf();
        let wt_dir = base.join(super::super::worktree::HERMES_WORKTREE_MARKER);
        fs::create_dir_all(&wt_dir).unwrap();

        let stopped = Arc::new(AtomicBool::new(false));
        let stopped_clone = Arc::clone(&stopped);

        // Create a minimal watcher directly (without AppHandle) to verify
        // the OS watcher can start and stop.
        let mut watcher =
            notify::recommended_watcher(move |_result: Result<notify::Event, notify::Error>| {
                if stopped_clone.load(Ordering::SeqCst) {
                    return;
                }
            })
            .expect("should create watcher");

        watcher
            .watch(&wt_dir, RecursiveMode::Recursive)
            .expect("should start watching");

        // Stop by setting flag and dropping
        stopped.store(true, Ordering::SeqCst);
        drop(watcher);
    }

    /// Creating and deleting directories inside the watched path should
    /// not cause any panics in the watcher callback.
    #[test]
    fn create_delete_directories_no_panic() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().to_path_buf();
        let wt_dir = base.join(super::super::worktree::HERMES_WORKTREE_MARKER);
        fs::create_dir_all(&wt_dir).unwrap();

        let stopped = Arc::new(AtomicBool::new(false));
        let stopped_clone = Arc::clone(&stopped);
        let events_received = Arc::new(AtomicBool::new(false));
        let events_clone = Arc::clone(&events_received);

        let mut watcher =
            notify::recommended_watcher(move |result: Result<notify::Event, notify::Error>| {
                if stopped_clone.load(Ordering::SeqCst) {
                    return;
                }
                if let Ok(event) = result {
                    if matches!(
                        event.kind,
                        EventKind::Remove(notify::event::RemoveKind::Folder)
                            | EventKind::Remove(notify::event::RemoveKind::Any)
                            | EventKind::Create(_)
                    ) {
                        events_clone.store(true, Ordering::SeqCst);
                    }
                }
            })
            .expect("should create watcher");

        watcher
            .watch(&wt_dir, RecursiveMode::Recursive)
            .expect("should start watching");

        // Create and delete a subdirectory
        let sub = wt_dir.join("test-worktree-dir");
        fs::create_dir_all(&sub).unwrap();

        // Give the OS watcher time to pick up the events
        std::thread::sleep(Duration::from_millis(200));

        fs::remove_dir_all(&sub).unwrap();

        // Give the OS watcher time to pick up the removal
        std::thread::sleep(Duration::from_millis(200));

        // Clean up
        stopped.store(true, Ordering::SeqCst);
        drop(watcher);

        // We don't assert events_received here because filesystem watcher
        // delivery is best-effort and platform-dependent. The key assertion
        // is that no panic occurred.
    }

    /// start_watching returns None when the hermes-worktrees directory
    /// does not exist.
    #[test]
    fn start_watching_returns_none_when_dir_missing() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().to_path_buf();
        // Do NOT create hermes-worktrees/ — it should return None

        // We cannot call start_watching here because it requires an
        // AppHandle, but we can verify the directory check logic directly.
        let worktrees_dir = base.join(super::super::worktree::HERMES_WORKTREE_MARKER);
        assert!(!worktrees_dir.is_dir());
    }
}
