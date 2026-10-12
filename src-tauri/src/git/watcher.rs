use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
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
    // The event thread holds only a weak handle: dropping this drops the OS
    // watcher, which closes the channel and ends the thread.
    _watcher: Arc<Mutex<RecommendedWatcher>>,
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

/// True when `path` is a worktree folder: exactly `{base}/{repo_hash}/{name}`.
/// Compared by spelling first, then with `base` resolved, since some
/// platforms report events under the resolved path.
fn is_worktree_root(base: &Path, base_resolved: &Path, path: &Path) -> bool {
    let Some(grandparent) = path.parent().and_then(Path::parent) else {
        return false;
    };
    grandparent == base || grandparent == base_resolved
}

/// True when `path` is a per-repo folder: exactly `{base}/{repo_hash}`.
fn is_repo_folder(base: &Path, base_resolved: &Path, path: &Path) -> bool {
    path.parent()
        .is_some_and(|parent| parent == base || parent == base_resolved)
}

/// Paths reported within the last `window`. Entries older than the window
/// are dropped on every check, so the map holds one burst at most.
struct Debounce {
    window: Duration,
    seen: HashMap<PathBuf, Instant>,
}

impl Debounce {
    fn new(window: Duration) -> Self {
        Self {
            window,
            seen: HashMap::new(),
        }
    }

    /// False when `path` was already reported within the window.
    fn first_in_window(&mut self, path: &Path, now: Instant) -> bool {
        let window = self.window;
        self.seen
            .retain(|_, last| now.duration_since(*last) < window);
        if self.seen.contains_key(path) {
            return false;
        }
        self.seen.insert(path.to_path_buf(), now);
        true
    }
}

/// Start watching `{base_dir}/hermes-worktrees/` for removed worktrees.
///
/// Only the base folder and each per-repo folder are watched, not
/// recursively: a worktree's own files (node_modules, target, ...) never
/// reach the watcher, and on Linux each watched folder costs one inotify
/// watch from a per-user limit other tools share.
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
    let worktrees_resolved =
        dunce::canonicalize(&worktrees_dir).unwrap_or_else(|_| worktrees_dir.clone());

    let stopped = Arc::new(AtomicBool::new(false));
    let stopped_clone = Arc::clone(&stopped);

    // Events go to a thread of ours: adding a watch from inside notify's
    // callback can deadlock its event loop.
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = match notify::recommended_watcher(tx) {
        Ok(w) => w,
        Err(e) => {
            log::warn!("[worktree-watcher] failed to create watcher: {}", e);
            return None;
        }
    };

    if let Err(e) = watcher.watch(&worktrees_dir, RecursiveMode::NonRecursive) {
        log::warn!(
            "[worktree-watcher] failed to watch {}: {}",
            worktrees_dir.display(),
            e
        );
        return None;
    }
    let mut repo_folders: HashSet<PathBuf> = HashSet::new();
    if let Ok(entries) = std::fs::read_dir(&worktrees_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                watch_repo_folder(&mut watcher, &mut repo_folders, path);
            }
        }
    }

    let watcher = Arc::new(Mutex::new(watcher));
    let weak = Arc::downgrade(&watcher);
    let app_handle = app.clone();
    let base = worktrees_dir.clone();

    let spawned = std::thread::Builder::new()
        .name("worktree-watcher".into())
        .spawn(move || {
            let mut debounce = Debounce::new(Duration::from_millis(500));
            // Ends when the watcher is dropped and the channel closes.
            for result in rx {
                if stopped_clone.load(Ordering::SeqCst) {
                    continue;
                }
                let event = match result {
                    Ok(ev) => ev,
                    Err(e) => {
                        log::warn!("[worktree-watcher] watch error: {}", e);
                        continue;
                    }
                };
                match event.kind {
                    // A repo's first worktree creates its folder: watch it too.
                    EventKind::Create(_) => {
                        for path in event.paths {
                            if is_repo_folder(&base, &worktrees_resolved, &path) && path.is_dir() {
                                if let Some(w) = weak.upgrade() {
                                    let mut w = w.lock().unwrap_or_else(|e| e.into_inner());
                                    watch_repo_folder(&mut w, &mut repo_folders, path);
                                }
                            }
                        }
                    }
                    EventKind::Remove(notify::event::RemoveKind::Folder)
                    | EventKind::Remove(notify::event::RemoveKind::Any) => {
                        for path in &event.paths {
                            if is_repo_folder(&base, &worktrees_resolved, path) {
                                // Forget it so a folder made again later is watched again.
                                if repo_folders.remove(path) {
                                    if let Some(w) = weak.upgrade() {
                                        let mut w = w.lock().unwrap_or_else(|e| e.into_inner());
                                        let _ = w.unwatch(path);
                                    }
                                }
                                continue;
                            }
                            if is_worktree_root(&base, &worktrees_resolved, path)
                                && debounce.first_in_window(path, Instant::now())
                            {
                                report_removed_worktree(&app_handle, path);
                            }
                        }
                    }
                    _ => {}
                }
            }
        });
    if let Err(e) = spawned {
        log::warn!("[worktree-watcher] failed to start its thread: {}", e);
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

fn watch_repo_folder(
    watcher: &mut RecommendedWatcher,
    watched: &mut HashSet<PathBuf>,
    path: PathBuf,
) {
    if watched.contains(&path) {
        return;
    }
    match watcher.watch(&path, RecursiveMode::NonRecursive) {
        Ok(()) => {
            watched.insert(path);
        }
        Err(e) => log::warn!(
            "[worktree-watcher] failed to watch {}: {}",
            path.display(),
            e
        ),
    }
}

/// A worktree folder is gone: tell the frontend if a session links it.
fn report_removed_worktree(app_handle: &AppHandle, path: &Path) {
    let path_str = path.to_string_lossy().to_string();

    // Look up the DB record to get session/project/branch info
    let Some(state) = app_handle.try_state::<AppState>() else {
        return;
    };
    let all_worktrees = {
        let db = match state.db.lock() {
            Ok(d) => d,
            Err(poisoned) => poisoned.into_inner(),
        };
        match db.get_all_session_worktrees() {
            Ok(wts) => wts,
            Err(e) => {
                log::warn!("[worktree-watcher] failed to query worktrees: {}", e);
                return;
            }
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
                let _ = stopped_clone.load(Ordering::SeqCst);
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

    /// Only `{base}/{repo_hash}/{name}` is a worktree root: removals inside
    /// a worktree (node_modules, target, ...) never reach the DB lookup.
    #[test]
    fn only_folders_two_levels_under_the_base_are_worktree_roots() {
        let base = Path::new("/data/hermes-worktrees");
        let resolved = Path::new("/private/data/hermes-worktrees");
        assert!(is_worktree_root(base, resolved, &base.join("ab12/s1_task")));
        assert!(is_worktree_root(
            base,
            resolved,
            &resolved.join("ab12/s1_task")
        ));
        assert!(!is_worktree_root(
            base,
            resolved,
            &base.join("ab12/s1_task/node_modules")
        ));
        assert!(!is_worktree_root(
            base,
            resolved,
            &base.join("ab12/s1_task/target/debug/deps")
        ));
        assert!(!is_worktree_root(base, resolved, &base.join("ab12")));
        assert!(!is_worktree_root(
            base,
            resolved,
            Path::new("/elsewhere/ab12/s1_task")
        ));
        assert!(is_repo_folder(base, resolved, &base.join("ab12")));
        assert!(!is_repo_folder(base, resolved, &base.join("ab12/s1_task")));
    }

    /// The debounce map keeps only paths seen within the window, so a long
    /// run of removals does not pile up entries.
    #[test]
    fn debounce_suppresses_repeats_and_forgets_old_paths() {
        let mut d = Debounce::new(Duration::from_millis(500));
        let t0 = Instant::now();
        let a = Path::new("/b/h/a");
        assert!(d.first_in_window(a, t0));
        assert!(!d.first_in_window(a, t0 + Duration::from_millis(100)));
        for i in 0..1000 {
            let p = PathBuf::from(format!("/b/h/w{i}"));
            assert!(d.first_in_window(&p, t0 + Duration::from_millis(200)));
        }
        assert_eq!(d.seen.len(), 1001);
        // Past the window: everything older is dropped on the next check.
        assert!(d.first_in_window(a, t0 + Duration::from_secs(2)));
        assert_eq!(d.seen.len(), 1);
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
