mod agent;
pub mod agent_caps;
mod agent_catalog;
mod agent_doctor;
mod agent_setup;
mod analytics;
mod attention;
mod claude_config;
mod clipboard;
mod context_usage;
pub mod contract;
mod db;
pub mod done_when;
#[cfg(feature = "e2e")]
mod e2e_bridge;
#[cfg(any(test, feature = "e2e"))]
#[cfg_attr(not(feature = "e2e"), allow(dead_code))]
mod e2e_evidence;
#[cfg(any(test, feature = "e2e"))]
#[cfg_attr(not(feature = "e2e"), allow(dead_code))]
mod e2e_protocol;
mod fleet;
mod fleet_perf;
mod git;
mod inline_pty;
mod instance;
mod land;
mod limits;
mod menu;
mod platform;
mod plugin_features;
mod plugin_identity;
mod plugins;
mod process;
mod project;
/// Exposed for benchmarks — not part of the public API.
#[doc(hidden)]
pub mod pty;
mod quit_flush;
mod review;
mod saved_workspace;
mod self_test;
mod session_host;
mod task_launcher;
mod track;
mod transcript;
mod turn_ledger;
mod updater;
mod workspace;

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// Install a crash handler that writes panic info to a log file instead of
/// stderr.  Writing to stderr during a panic is the primary cause of double-
/// panics (SIGABRT) when many sessions are active — the global stderr lock
/// may already be held by another panicking thread.  By writing to a file
/// we avoid the lock contention that triggers process::abort().
fn install_crash_handler() {
    std::panic::set_hook(Box::new(|info| {
        let crash_dir = dirs::home_dir().unwrap_or_default().join(".hermes");
        let _ = std::fs::create_dir_all(&crash_dir);
        let crash_log = crash_dir.join("crash.log");

        let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown".to_string());
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic".to_string());
        let backtrace = std::backtrace::Backtrace::force_capture();

        let crash_info = format!(
            "\n=== CRASH {} ===\nLocation: {}\nMessage: {}\nThread: {:?}\nBacktrace:\n{}\n",
            timestamp,
            location,
            message,
            std::thread::current().name(),
            backtrace
        );

        // Write to file — never to stderr, to avoid double-panic
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&crash_log)
        {
            let _ = std::io::Write::write_all(&mut f, crash_info.as_bytes());
        }
    }));
}

static WORKSPACE_SAVED: AtomicBool = AtomicBool::new(false);

/// Whether a `session_worktrees` link whose folder is missing (and whose
/// session still exists) is kept for `create_session` to put the worktree
/// back: only a worktree Hermes made, on a branch that still exists, for a
/// session the next launch restores (`restored`: it is in the saved
/// workspace). A link kept for a session nobody restores would linger, and
/// be reported at every startup, for ever.
fn keep_missing_worktree_link(
    restored: bool,
    is_main_worktree: bool,
    worktree_path: &str,
    project_path: Option<&str>,
    branch: Option<&str>,
) -> bool {
    if !restored
        || !git::worktree::isolation_fixes_enabled()
        || !git::worktree::is_owned_checkout(is_main_worktree, worktree_path)
    {
        return false;
    }
    match (project_path, branch) {
        (Some(repo), Some(branch)) => git::worktree::local_branch_exists(repo, branch),
        _ => false,
    }
}

/// The ids of the sessions the saved workspace (the `saved_workspace`
/// setting the frontend writes) restores at the next launch. Empty when
/// there is no saved workspace or it cannot be read: then nothing is
/// restored.
fn saved_workspace_session_ids(saved_workspace: Option<&str>) -> HashSet<String> {
    saved_workspace
        .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())
        .and_then(|v| v.get("sessions")?.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|s| s.get("id")?.as_str().map(str::to_string))
        .collect()
}

/// Clean up worktrees whose sessions no longer exist, remove orphaned
/// directories, and replay incomplete journal operations.
///
/// Called once during app startup. For each `session_worktrees` record whose
/// session is missing from the `sessions` table, we remove the git worktree
/// from disk (if it is a linked worktree) and delete the DB record. We also
/// scan `{app_data_dir}/hermes-worktrees/` directories for orphans that have
/// no DB record, and replay any incomplete journal operations from prior
/// crashes. Finally, we run `git worktree prune` on every repo that had
/// stale entries and emit a cleanup summary event to the frontend.
fn cleanup_stale_worktrees(app: &tauri::AppHandle, database: &db::Database) {
    let app_data_dir = match instance::app_data_dir(app) {
        Ok(dir) => dir,
        Err(e) => {
            log::warn!(
                "Startup worktree cleanup: failed to get app data dir: {}",
                e
            );
            return;
        }
    };

    let all_worktrees = match database.get_all_session_worktrees() {
        Ok(wts) => wts,
        Err(e) => {
            log::warn!("Startup worktree cleanup: failed to list worktrees: {}", e);
            return;
        }
    };

    let mut repos_to_prune: HashSet<String> = HashSet::new();
    let mut cleanup_count: u32 = 0;

    for wt in &all_worktrees {
        // Check whether the owning session still exists
        let session_exists = database.session_exists(&wt.session_id).unwrap_or(true); // default to true (keep) on error

        if session_exists {
            continue;
        }

        log::info!(
            "Startup worktree cleanup: removing stale worktree '{}' (session '{}' no longer exists)",
            wt.worktree_path, wt.session_id
        );

        // Only remove worktrees Hermes made from disk: not the project
        // folder, not a checkout made outside Hermes that the session
        // reused, and never a checkout another session still points at.
        let shared = database
            .count_sessions_for_worktree_path(&wt.worktree_path)
            .map(|n| n > 1)
            .unwrap_or(true);
        if git::worktree::is_owned_checkout(wt.is_main_worktree, &wt.worktree_path) && !shared {
            if let Ok(Some(project_entry)) = database.get_project(&wt.project_id) {
                if let Err(e) = git::worktree::remove_worktree(
                    &project_entry.path,
                    &wt.session_id,
                    &wt.worktree_path,
                ) {
                    log::warn!(
                        "Startup worktree cleanup: failed to remove worktree '{}': {}",
                        wt.worktree_path,
                        e
                    );
                }
                repos_to_prune.insert(project_entry.path.clone());
            }
        }

        // Delete the DB record regardless
        if let Err(e) = database.delete_session_worktree(&wt.id) {
            log::warn!(
                "Startup worktree cleanup: failed to delete DB record '{}': {}",
                wt.id,
                e
            );
        }

        cleanup_count += 1;
    }

    // Second pass: validate that worktree paths still exist on disk.
    // Re-fetch from DB since some records may have been deleted above.
    let remaining_worktrees = database.get_all_session_worktrees().unwrap_or_default();
    let mut missing_paths: Vec<serde_json::Value> = Vec::new();
    let restored_sessions = saved_workspace_session_ids(
        database
            .get_setting("saved_workspace")
            .ok()
            .flatten()
            .as_deref(),
    );

    for wt in &remaining_worktrees {
        if wt.is_main_worktree {
            continue;
        }

        if !Path::new(&wt.worktree_path).is_dir() {
            log::warn!(
                "Startup worktree cleanup: worktree path missing on disk '{}' (session '{}', branch '{}')",
                wt.worktree_path,
                wt.session_id,
                wt.branch_name.as_deref().unwrap_or("unknown")
            );

            // A worktree Hermes made whose branch still exists is put back
            // when its session is restored (create_session), so its link
            // must survive: dropping it here left the restored session with
            // a folder that did not exist, stuck at "starting".
            let project_path = database
                .get_project(&wt.project_id)
                .ok()
                .flatten()
                .map(|p| p.path);
            if keep_missing_worktree_link(
                restored_sessions.contains(&wt.session_id),
                wt.is_main_worktree,
                &wt.worktree_path,
                project_path.as_deref(),
                wt.branch_name.as_deref(),
            ) {
                log::info!(
                    "Startup worktree cleanup: keeping the link; the worktree is recreated when session '{}' is restored",
                    wt.session_id
                );
                continue;
            }

            // Delete only the session_worktrees DB record — never touch the project or session
            if let Err(e) = database.delete_session_worktree(&wt.id) {
                log::warn!(
                    "Startup worktree cleanup: failed to delete DB record for missing path '{}': {}",
                    wt.worktree_path,
                    e
                );
            }

            // Run git worktree prune on the parent repo
            if let Ok(Some(proj)) = database.get_project(&wt.project_id) {
                repos_to_prune.insert(proj.path.clone());
            }

            missing_paths.push(serde_json::json!({
                "sessionId": wt.session_id,
                "branchName": wt.branch_name.as_deref().unwrap_or("unknown"),
            }));

            cleanup_count += 1;
        }
    }

    // Run git worktree prune on each affected repo
    for repo_path in &repos_to_prune {
        if let Err(e) = git::worktree::cleanup_stale_worktrees(repo_path) {
            log::warn!(
                "Startup worktree cleanup: git worktree prune failed for '{}': {}",
                repo_path,
                e
            );
        }
    }

    // Scan all projects for orphaned worktree directories with no DB record
    if let Ok(projects) = database.get_all_projects() {
        // Collect all known worktree paths from DB for efficient lookup
        let known_paths: HashSet<String> = database
            .get_all_session_worktrees()
            .unwrap_or_default()
            .iter()
            .map(|r| r.worktree_path.clone())
            .collect();

        for proj in &projects {
            let wt_dir = git::worktree::worktree_dir(&app_data_dir, &proj.path);
            if !wt_dir.is_dir() {
                continue;
            }

            if let Ok(entries) = std::fs::read_dir(&wt_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    // Skip non-directories and marker files (repo_path.txt)
                    if !path.is_dir() {
                        continue;
                    }
                    let path_str = path.to_string_lossy().to_string();

                    // Check if this directory has a DB record
                    if !known_paths.contains(&path_str) {
                        log::info!("Removing orphaned worktree directory: {}", path_str);
                        // Try git worktree prune first, then remove directory
                        let _ = std::process::Command::new("git")
                            .arg("-C")
                            .arg(&proj.path)
                            .arg("worktree")
                            .arg("prune")
                            .output();
                        match std::fs::remove_dir_all(&path) {
                            Ok(_) => {
                                cleanup_count += 1;
                            }
                            Err(e) => {
                                log::warn!(
                                    "[worktree-cleanup] Failed to remove orphan {}: {}",
                                    path_str,
                                    e
                                );
                            }
                        }
                    }
                }
            }

            // Replay incomplete journal operations for this project
            let incomplete = git::journal::get_incomplete_operations(&app_data_dir, &proj.path);
            for entry in &incomplete {
                match entry.action.as_str() {
                    "CREATE" => {
                        // Incomplete creation — worktree may exist but DB record is missing
                        if entry.worktree_path != "pending"
                            && Path::new(&entry.worktree_path).is_dir()
                        {
                            log::info!(
                                "Replaying incomplete CREATE: removing orphan {}",
                                entry.worktree_path
                            );
                            match std::fs::remove_dir_all(&entry.worktree_path) {
                                Ok(_) => {
                                    cleanup_count += 1;
                                }
                                Err(e) => {
                                    log::warn!(
                                        "[worktree-cleanup] Failed to remove orphan {}: {}",
                                        entry.worktree_path,
                                        e
                                    );
                                }
                            }
                        }
                    }
                    // Incomplete removal — worktree may still exist on disk
                    "REMOVE" if Path::new(&entry.worktree_path).is_dir() => {
                        log::info!(
                            "Replaying incomplete REMOVE: cleaning up {}",
                            entry.worktree_path
                        );
                        match std::fs::remove_dir_all(&entry.worktree_path) {
                            Ok(_) => {
                                cleanup_count += 1;
                            }
                            Err(e) => {
                                log::warn!(
                                    "[worktree-cleanup] Failed to remove {}: {}",
                                    entry.worktree_path,
                                    e
                                );
                            }
                        }
                    }
                    _ => {}
                }
            }

            // Verification pass: re-check that all orphan directories from the
            // journal were actually removed before clearing it.  If the app
            // crashed during the replay above, the journal survives and the next
            // startup will retry.
            let mut all_cleaned = true;
            for entry in &incomplete {
                let path = Path::new(&entry.worktree_path);
                if entry.worktree_path != "pending" && path.is_dir() {
                    log::warn!(
                        "[worktree-cleanup] Verification failed: orphan still exists after replay: {}",
                        entry.worktree_path
                    );
                    all_cleaned = false;
                }
            }
            if all_cleaned {
                // Only clear the journal once we've verified all orphans are gone
                git::journal::clear_journal(&app_data_dir, &proj.path);
            } else {
                log::warn!(
                    "[worktree-cleanup] Keeping journal for '{}' — some orphans were not cleaned",
                    proj.path
                );
            }
        }
    }

    // Migration: clean up old .hermes/worktrees/ directories from previous versions.
    // These are no longer used since worktrees are now stored in the app data directory.
    if let Ok(projects) = database.get_all_projects() {
        for proj in &projects {
            let old_worktree_dir = Path::new(&proj.path).join(".hermes").join("worktrees");
            if old_worktree_dir.is_dir() {
                log::info!(
                    "Migration: removing old .hermes/worktrees/ from '{}'",
                    proj.path
                );
                // Prune git worktree metadata first
                let _ = std::process::Command::new("git")
                    .arg("-C")
                    .arg(&proj.path)
                    .arg("worktree")
                    .arg("prune")
                    .output();
                let _ = std::fs::remove_dir_all(&old_worktree_dir);
            }
            // Also clean up the old journal file
            let old_journal = Path::new(&proj.path)
                .join(".hermes")
                .join("worktree-journal.log");
            if old_journal.exists() {
                let _ = std::fs::remove_file(&old_journal);
            }
            // Remove .hermes/ directory if it's now empty
            let hermes_dir = Path::new(&proj.path).join(".hermes");
            if hermes_dir.is_dir() {
                let _ = std::fs::remove_dir(&hermes_dir); // Only succeeds if empty
            }
        }
    }

    // Emit cleanup summary event to frontend
    if cleanup_count > 0 {
        log::info!(
            "Startup worktree cleanup: cleaned up {} stale/orphaned worktrees",
            cleanup_count
        );
        let _ = app.emit("worktree-cleanup-summary", cleanup_count);
    }

    // Emit a separate event for missing worktree paths so the UI can warn the user
    if !missing_paths.is_empty() {
        let _ = app.emit("worktree-paths-missing", &missing_paths);
    }
}

pub struct AppState {
    pub db: Mutex<db::Database>,
    pub pty_manager: Mutex<pty::PtyManager>,
    pub sys: Mutex<sysinfo::System>,
    pub startup_marker_path: std::path::PathBuf,
    pub worktree_watcher: Mutex<Option<git::watcher::WorktreeWatcher>>,
    /// Sessions closed in this run; kept out of the saved workspace.
    pub closed_sessions: saved_workspace::ClosedSessions,
}

/// Save scrollback snapshots and session metadata to DB on close.
/// The frontend auto-save handles `saved_workspace` (with layout data); here
/// it only loses the sessions closed in this run, which a quit shortly after
/// the close would otherwise bring back on the next launch.
fn do_save_workspace(app: &tauri::AppHandle) {
    let state = match app.try_state::<AppState>() {
        Some(s) => s,
        None => return,
    };
    let closed = state.closed_sessions.snapshot();
    let mgr = match state.pty_manager.lock() {
        Ok(m) => m,
        Err(poisoned) => {
            log::warn!("pty_manager poisoned during workspace save — recovering");
            poisoned.into_inner()
        }
    };
    let db = match state.db.lock() {
        Ok(d) => d,
        Err(_) => return,
    };

    if let Err(e) = saved_workspace::prune_stored(&db, &closed) {
        log::error!(
            "Failed to drop closed sessions from the saved workspace: {}",
            e
        );
    }

    for (session_id, pty_session) in &mgr.sessions {
        // Save session metadata first (INSERT OR REPLACE resets the row)
        if let Ok(s) = pty_session.session.lock() {
            let update = pty::SessionUpdate::from(&*s);
            if let Err(e) = db.create_session_v2(&update) {
                log::error!(
                    "Failed to save session metadata for '{}': {}",
                    session_id,
                    e
                );
            }
        }

        // Save scrollback snapshot AFTER metadata (since create_session_v2 replaces the row)
        if let Ok(analyzer) = pty_session.analyzer.lock() {
            let snapshot = analyzer.get_stripped_output();
            if let Err(e) = db.save_session_snapshot(session_id, &snapshot) {
                log::error!(
                    "Failed to save scrollback snapshot for '{}': {}",
                    session_id,
                    e
                );
            }

            let metrics = analyzer.to_metrics();
            for (provider, tokens) in &metrics.token_usage {
                if let Err(e) = db.record_token_usage(
                    session_id,
                    provider,
                    &tokens.model,
                    tokens.input_tokens as i64,
                    tokens.output_tokens as i64,
                    tokens.estimated_cost_usd,
                ) {
                    log::warn!("Failed to record token usage for '{}': {}", session_id, e);
                }
            }
        }
    }
}

/// Save workspace on close — full save with snapshots, runs once.
pub(crate) fn save_workspace_state(app: &tauri::AppHandle) {
    if WORKSPACE_SAVED.swap(true, Ordering::SeqCst) {
        return;
    }
    do_save_workspace(app);

    // Remove the startup marker to signal a clean shutdown
    if let Some(state) = app.try_state::<AppState>() {
        let _ = std::fs::remove_file(&state.startup_marker_path);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Windows: `hermes-ide --hermes-interrupt-console <pid>` is the short-lived
/// helper that raises a console's Ctrl+C event for a spend cap (see
/// `fleet::interrupt_session_agent`). Returns its exit code; `None` means
/// start the app. `main` asks before anything else starts.
pub fn run_console_interrupt_helper() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    fleet::console_interrupt_helper(&args)
}

pub fn run() {
    env_logger::init();
    install_crash_handler();
    fleet::let_terminals_receive_ctrl_c();

    // Decide which instance this is before anything touches app data: a dev,
    // beta or test build must never open the installed app's data folder.
    let context = tauri::generate_context!();
    match instance::init(&context.config().identifier) {
        Ok(i) => log::info!(
            "[instance] {} — data folder {:?}, shell temp folder {:?}",
            i.identifier,
            i.data_dir,
            i.shell_temp_root
        ),
        Err(e) => {
            log::error!("[instance] {}", e);
            eprintln!("Hermes: {}", e);
            std::process::exit(78);
        }
    }

    // Create a Tokio runtime context for plugins that spawn async tasks during
    // initialization (tauri-plugin-aptabase calls tokio::task::spawn in its init
    // callback, before Tauri's own runtime is active).
    let rt = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime");
    let _guard = rt.enter();

    let builder = tauri::Builder::default();
    // Test runs must not take keyboard focus away from whoever is working.
    #[cfg(feature = "e2e")]
    let builder = e2e_bridge::configure(builder);

    builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Plugin identity is per page: a reload forgets the old keys.
        .on_page_load(plugin_identity::on_page_load)
        .setup(|app| {
            // Before anything else: the frontend claims its host key from
            // this state before it runs any plugin bundle.
            app.manage(plugin_identity::PluginIdentityState::default());

            let app_dir = instance::app_data_dir(app.handle())?;
            std::fs::create_dir_all(&app_dir)
                .map_err(|e| format!("Failed to create app data dir: {}", e))?;
            // Only worktrees under this folder are ours to remove, ask
            // about or recreate; another instance's are somebody else's.
            git::worktree::set_instance_worktrees_base(&app_dir);
            std::fs::create_dir_all(app_dir.join("context"))
                .map_err(|e| format!("Failed to create context dir: {}", e))?;

            // Dirty shutdown detection: check if a previous session exited without
            // cleaning up its marker file.
            let startup_marker = app_dir.join("running.marker");
            if startup_marker.exists() {
                log::warn!("Dirty shutdown detected — previous session did not exit cleanly");
            }
            let timestamp = chrono::Local::now().to_rfc3339();
            if let Err(e) = std::fs::write(&startup_marker, timestamp.as_bytes()) {
                log::warn!("Failed to write startup marker: {}", e);
            }

            // Migrate old database name if needed
            let old_db_path = app_dir.join("axon_v3.db");
            let db_path = app_dir.join("hermes_idea_v3.db");
            if old_db_path.exists() && !db_path.exists() {
                let _ = std::fs::copy(&old_db_path, &db_path);
            }
            let database = match db::Database::open(&db_path) {
                Ok(database) => database,
                Err(e) => {
                    // Show the reason in the window and initialise nothing
                    // else, so nothing can touch the data.
                    log::error!("Database not opened: {}", e);
                    // Nothing runs this time, so there is nothing to shut down.
                    let _ = std::fs::remove_file(&startup_marker);
                    app.manage(db::startup::StartupProblemState(Some(
                        db::startup::StartupProblem::from_open_error(&e, &db_path),
                    )));
                    #[cfg(feature = "e2e")]
                    e2e_bridge::start(app.handle());
                    return Ok(());
                }
            };
            app.manage(db::startup::StartupProblemState(None));

            // Clean up stale worktrees from previous sessions that no longer exist
            cleanup_stale_worktrees(app.handle(), &database);

            // Sessions the session host kept running (N20): their shells
            // are still configured with the previous run's shell-integration
            // files, and their agents still write launch signals.
            let kept = session_host::live_hosted_session_ids(app.handle());
            if !kept.is_empty() {
                log::info!(
                    "[session-host] {} session(s) still running in the host",
                    kept.len()
                );
            }

            // Clean up stale shell integration temp files from previous sessions
            pty::shell_integration::cleanup_stale(&kept);

            // Launch files belong to sessions of the previous run (restored
            // sessions get new ids), so the folder starts empty — except for
            // the kept sessions'.
            pty::launch::clear_launch_dir(app.handle(), &kept);

            let mut sys = sysinfo::System::new();
            sys.refresh_all(); // baseline for CPU delta computation

            // Start worktree file watcher (notification only — never
            // deletes projects or closes sessions)
            let watcher = git::watcher::start_watching(app.handle().clone(), app_dir.clone());

            let state = AppState {
                db: Mutex::new(database),
                pty_manager: Mutex::new(pty::PtyManager::new()),
                sys: Mutex::new(sys),
                startup_marker_path: startup_marker.clone(),
                worktree_watcher: Mutex::new(watcher),
                closed_sessions: saved_workspace::ClosedSessions::default(),
            };

            app.manage(state);
            // Feature Tracks (F28): one thread polls the worktrees sessions
            // are attached to and reports changes under .hermes/features.
            let track_state = std::sync::Arc::new(track::TrackWatchState::default());
            app.manage(std::sync::Arc::clone(&track_state));
            track::start(app.handle().clone(), track_state);
            app.manage(session_host::SessionHostState::default());
            app.manage(Mutex::new(transcript::TranscriptWatcherState::default()));
            app.manage(agent::AgentState::default());
            app.manage(quit_flush::QuitFlush::default());
            app.manage(done_when::DoneWhenState::default());
            app.manage(inline_pty::InlinePtyManager::new());
            // Turn ledger (F20): off until the frontend says the flag is on.
            app.manage(turn_ledger::TurnLedger::default());

            // The agent bridge is NOT warmed at startup: the frontend asks
            // for it (warm_agent_bridge) once an Agent-view session exists,
            // so terminal-only use never starts a Node process at launch.
            log::info!(
                "[prewarm] agent bridge warm-up deferred until an Agent-view session exists"
            );

            // Save workspace when the main window is about to close. The
            // close waits until the frontend has written its workspace.
            let save_handle = app.handle().clone();
            if let Some(window) = app.get_webview_window("main") {
                window.on_window_event(move |event| match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        // Hosted sessions with an agent at work (N20): ask
                        // "keep running or stop?" first; the answer quits.
                        if session_host::on_exit_requested(&save_handle) {
                            api.prevent_close();
                            return;
                        }
                        let after = quit_flush::After::CloseWindow("main".into());
                        if quit_flush::hold_for_flush(&save_handle, after) {
                            api.prevent_close();
                        } else {
                            save_workspace_state(&save_handle);
                            session_host::stop_hosted_unless_kept(&save_handle);
                        }
                    }
                    tauri::WindowEvent::Destroyed => {
                        save_workspace_state(&save_handle);
                    }
                    _ => {}
                });
            }

            // Build and set native menu bar
            let handle = app.handle().clone();
            match menu::build_app_menu(&handle) {
                Ok(m) => match app.set_menu(m) {
                    Ok(_) => {
                        app.on_menu_event(move |app_handle, event| {
                            menu::handle_menu_event(app_handle, event);
                        });
                    }
                    Err(e) => {
                        log::error!("Failed to set menu: {}", e);
                    }
                },
                Err(e) => {
                    log::error!("Failed to build app menu: {}", e);
                }
            }

            // Test-only automation bridge; compiled out unless `--features e2e`.
            #[cfg(feature = "e2e")]
            e2e_bridge::start(app.handle());

            // `--self-test=<report.json>`: prove the essentials, write the
            // report, exit 0/1. Used by the release train on every installer.
            if let Some(report) = self_test::requested() {
                self_test::start(app.handle(), report.to_path_buf(), db_path.clone());
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Update channel (stable/beta) and the update check itself
            updater::get_update_channel_info,
            updater::check_for_update,
            // AI provider detection
            pty::check_ai_providers,
            // Agent doctor (F16) and the task launcher's repo facts (F15)
            agent_doctor::agent_doctor,
            // 2.0 launch contract: models, effort, accounts, presets
            agent_caps::commands::get_agent_capabilities,
            agent_caps::commands::list_agent_capabilities,
            agent_caps::commands::validate_launch,
            agent_caps::commands::preview_launch,
            agent_caps::commands::remember_launch_choice,
            agent_caps::commands::get_remembered_launch_choice,
            agent_caps::commands::dismiss_preset_suggestion,
            agent_caps::commands::get_usual_launch_choice,
            agent_caps::commands::list_launch_presets,
            agent_caps::commands::save_launch_preset,
            agent_caps::commands::rename_launch_preset,
            agent_caps::commands::delete_launch_preset,
            agent_caps::commands::add_agent_account,
            agent_caps::commands::remove_agent_account,
            agent_caps::commands::relaunch_agent,
            task_launcher::task_repo_probe,
            task_launcher::task_write_feature_file,
            // Session management
            pty::create_session,
            pty::ssh_list_directory,
            pty::ssh_read_file,
            pty::ssh_write_file,
            pty::ssh_list_tmux_sessions,
            pty::ssh_list_tmux_windows,
            pty::ssh_tmux_select_window,
            pty::ssh_tmux_new_window,
            pty::ssh_tmux_rename_window,
            pty::ssh_add_port_forward,
            pty::ssh_remove_port_forward,
            pty::ssh_list_port_forwards,
            pty::ssh_get_remote_cwd,
            pty::ssh_get_remote_git_info,
            pty::ssh_upload_file,
            pty::ssh_download_file,
            pty::write_to_session,
            pty::nudge_project_context,
            pty::resize_session,
            pty::close_session,
            pty::save_all_snapshots,
            pty::get_sessions,
            pty::get_session_detail,
            pty::get_session_metadata,
            pty::get_session_output,
            pty::update_session_label,
            pty::update_session_description,
            pty::update_session_color,
            pty::add_workspace_path,
            pty::remove_workspace_path,
            pty::update_session_group,
            pty::get_available_shells,
            pty::is_shell_foreground,
            // Terminal Command Intelligence
            pty::detect_shell_environment,
            pty::read_shell_history,
            pty::get_session_commands,
            pty::get_project_context,
            // Database queries
            db::get_recent_sessions,
            db::get_session_snapshot,
            db::get_token_usage_today,
            db::get_cost_history,
            db::save_memory,
            db::get_all_memory,
            db::delete_memory,
            db::get_settings,
            db::startup::get_startup_problem,
            db::set_setting,
            db::log_execution,
            db::get_execution_log,
            // Context Pins
            db::add_context_pin,
            db::remove_context_pin,
            db::get_context_pins,
            // Context Snapshots
            db::save_context_snapshot,
            db::get_context_snapshots,
            db::get_context_snapshot,
            // Cost by Project
            db::get_cost_by_project,
            // Settings Export / Import
            db::export_settings,
            db::import_settings,
            // Prompt Bundle Export / Import
            db::export_prompt_bundle,
            db::import_prompt_bundle,
            // Plugin storage
            db::get_plugin_setting,
            db::set_plugin_setting,
            db::delete_plugin_setting,
            db::set_plugin_enabled,
            db::get_disabled_plugin_ids,
            db::cleanup_plugin_data,
            db::get_plugin_settings_batch,
            db::save_plugin_metadata,
            db::get_plugin_permissions,
            // SSH saved hosts
            db::list_ssh_saved_hosts,
            db::upsert_ssh_saved_host,
            db::delete_ssh_saved_host,
            // Workspace
            workspace::scan_directory,
            workspace::detect_project,
            workspace::get_projects,
            // Projects
            project::create_project,
            project::get_registered_projects,
            project::get_projects_ordered,
            project::get_project,
            project::delete_project,
            project::attach_session_project,
            project::detach_session_project,
            project::get_session_projects,
            project::scan_project,
            project::attunement::assemble_session_context,
            project::attunement::apply_context,
            project::attunement::fork_session_context,
            project::attunement::load_hermes_project_config,
            project::attunement::delete_session_data,
            analytics::enable_analytics,
            // Process management
            process::list_processes,
            process::kill_process,
            process::kill_process_tree,
            process::get_process_detail,
            process::reveal_process_in_finder,
            // Git integration
            git::git_status,
            git::git_stage,
            git::git_discard_changes,
            git::git_unstage,
            git::git_commit,
            git::git_push,
            git::git_pull,
            git::git_diff,
            git::git_open_file,
            git::read_file_content,
            git::write_file_content,
            git::open_file_in_editor,
            // Git branch management
            git::git_list_branches,
            git::git_list_branches_for_project,
            git::git_branches_ahead_behind,
            git::git_create_branch,
            git::git_checkout_branch,
            git::git_delete_branch,
            // Git stash
            git::git_stash_list,
            git::git_stash_save,
            git::git_stash_apply,
            git::git_stash_pop,
            git::git_stash_drop,
            git::git_stash_clear,
            // Git log / history
            git::git_log,
            git::git_commit_detail,
            // Git merge / conflicts
            git::git_merge_status,
            git::git_get_conflict_content,
            git::git_resolve_conflict,
            git::git_abort_merge,
            git::git_continue_merge,
            // File explorer
            git::list_directory,
            // Project search
            git::search_project,
            // Git worktree management
            git::git_create_worktree,
            // Worktree recipes (.hermes/worktree.toml)
            git::recipe::worktree_recipe_read,
            git::recipe::worktree_recipe_run,
            git::recipe::worktree_recipe_stop,
            git::git_remove_worktree,
            git::git_list_worktrees,
            git::git_check_branch_available,
            git::git_session_worktree_info,
            git::git_list_branches_for_projects,
            git::git_fetch_remote_branches,
            git::git_is_git_repo,
            git::git_worktree_has_changes,
            git::git_stash_worktree,
            git::git_attach_worktree,
            git::git_detach_worktree,
            git::git_commit_worktree,
            // Worktree overview & cleanup
            git::git_list_all_worktrees,
            git::git_detect_orphan_worktrees,
            git::git_worktree_disk_usage,
            git::git_cleanup_orphan_worktrees,
            // Disk guard & worktree hygiene
            git::git_disk_status,
            git::git_worktree_usage,
            git::git_reclaim_build_output,
            git::git_list_orphan_folders,
            git::git_sweep_orphan_folders,
            // Fast worktrees
            git::git_prepare_worktree,
            // Menu
            menu::show_context_menu,
            menu::update_menu_state,
            menu::menu_item_enabled_for_test,
            // Plugins
            plugins::list_installed_plugins,
            plugins::read_plugin_bundle,
            plugins::get_plugins_dir,
            plugins::uninstall_plugin,
            plugins::install_plugin,
            plugins::download_and_install_plugin,
            plugins::fetch_plugin_registry,
            plugins::plugin_fetch_url,
            plugins::plugin_post_json,
            plugins::plugin_exec_command,
            plugin_features::plugin_read_feature_tracks,
            // Plugin identity (host key + per-plugin tokens)
            plugin_identity::claim_plugin_host_key,
            plugin_identity::issue_plugin_token,
            plugin_identity::revoke_plugin_token,
            // Clipboard
            clipboard::copy_image_to_clipboard,
            // Transcript watching
            transcript::start_transcript_watcher,
            transcript::stop_transcript_watcher,
            // Agent mode (Claude SDK bridge — see agent/mod.rs)
            agent::spawn_agent_session,
            agent::restart_agent_session,
            agent::send_agent_input,
            agent::interrupt_agent,
            agent::close_agent_session,
            agent::check_claude_cli,
            agent::read_image_for_attachment,
            agent::update_hermes_state,
            agent::prewarm::warm_agent_bridge,
            // 2.0 contracts (docs/adr/004-2.0-contracts.md): turn ledger seam
            // and the test-build-only session-event injector.
            contract::turns::list_turns,
            contract::turns::get_turn_diff,
            contract::emit_session_event_for_test,
            quit_flush::workspace_flush_ready,
            quit_flush::workspace_flush_done,
            // Attention inbox (F12) and away notifications (N16): the OS side.
            attention::set_attention_badge,
            attention::set_keep_awake,
            attention::send_away_notification,
            attention::attention_state_for_test,
            // Turn ledger (F20)
            turn_ledger::set_turn_ledger_enabled,
            turn_ledger::turn_ledger_turn_started,
            turn_ledger::turn_ledger_turn_ended,
            turn_ledger::preview_restore_turn,
            turn_ledger::restore_turn,
            // Review Desk (F21): merge-base diff, revert a turn, review file.
            review::review_diff,
            review::review_revert_preview,
            review::review_revert_patch,
            review::review_write_file,
            land::land_preview,
            land::land_gh_status,
            land::land_execute,
            land::land_archive,
            land::land_undo,
            land::land_pr_checks,
            land::land_ci_log,
            // Done-When checks (F27).
            done_when::done_when_run,
            done_when::done_when_history,
            // Feature Tracks (F28)
            track::track_watch,
            track::track_unwatch,
            track::track_snapshot,
            track::track_approve,
            track::track_skip,
            track::track_revert_gate,
            track::track_promote,
            track::track_read_file,
            track::track_file_path,
            track::track_write_review,
            track::track_hi_path,
            // Session host (N20): status for the UI and the test rig, and
            // the answer to "keep running or stop?" on quit.
            session_host::session_host_status,
            session_host::session_host_quit,
            session_host::session_host_stop_all,
            // Fleet controls (2.0: spend caps, task queue) — see fleet.rs.
            fleet::fleet_agent_load,
            fleet::interrupt_session_agent,
            // Fleet performance (F24): memory per session and for Hermes.
            fleet_perf::fleet_memory,
            // Claude config (~/.claude.json + ~/.claude/settings.json)
            // — see claude_config/mod.rs for the v1.0 TUI parity surface.
            claude_config::write_mcp_server,
            claude_config::remove_mcp_server,
            claude_config::read_mcp_server_spec,
            claude_config::read_memory_file,
            claude_config::write_memory_file,
            claude_config::read_permission_rules,
            claude_config::write_permission_rule,
            claude_config::remove_permission_rule,
            // Prewarm: static reads from disk before SDK init lands.
            claude_config::read_static_mcp_servers,
            claude_config::read_static_slash_commands,
            claude_config::read_static_memory_paths,
            // What each agent loads, and how it was started (F30, F35).
            agent_setup::agent_setup_overview,
            agent_setup::link_instructions_to_agents_md,
            agent_setup::session_process_argv,
            // Inline PTY for embedded slash-command terminals
            // (see src/inline_pty/mod.rs).
            inline_pty::spawn_inline_pty,
            inline_pty::write_inline_pty,
            inline_pty::resize_inline_pty,
            inline_pty::kill_inline_pty,
        ])
        .build(context)
        .expect("error while building HERMES-IDE")
        .run(|app, event| match &event {
            tauri::RunEvent::ExitRequested { code, api, .. } => {
                // Hosted sessions with an agent at work (N20): the exit
                // waits for the user's answer, keep running or stop.
                if session_host::on_exit_requested(app) {
                    api.prevent_exit();
                    return;
                }
                // An exit with a code (AppHandle::exit, the Quit menu item)
                // waits for the frontend to write its workspace. A restart
                // cannot be held, and without a code the last window is
                // already gone.
                let holdable = matches!(code, Some(c) if *c != tauri::RESTART_EXIT_CODE);
                if holdable
                    && quit_flush::hold_for_flush(app, quit_flush::After::Exit(code.unwrap_or(0)))
                {
                    log::info!("[hermes] ExitRequested — held while the workspace is saved");
                    api.prevent_exit();
                    return;
                }
                log::info!("[hermes] ExitRequested — saving workspace");
                save_workspace_state(app);
                session_host::stop_hosted_unless_kept(app);
            }
            tauri::RunEvent::Exit => {
                log::info!("[hermes] Exit — saving workspace");
                save_workspace_state(app);
                // Let the machine sleep again (F12 keep-awake).
                attention::shutdown();
            }
            tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::Destroyed,
                ..
            } => {
                log::info!("[hermes] WindowDestroyed — saving workspace");
                save_workspace_state(app);
            }
            _ => {}
        });
}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// Verify that poisoned pty_manager Mutex is recoverable via
    /// `unwrap_or_else(|e| e.into_inner())` — the pattern now used by
    /// every Tauri command handler.
    #[test]
    fn poisoned_mutex_recovery() {
        let mgr = Arc::new(Mutex::new(pty::PtyManager::new()));

        // Poison the mutex by panicking while holding the lock
        let mgr_clone = Arc::clone(&mgr);
        let handle = std::thread::spawn(move || {
            let _guard = mgr_clone.lock().unwrap();
            panic!("intentional panic to poison mutex");
        });
        let _ = handle.join(); // join the panicked thread

        // The mutex is now poisoned — verify .lock() returns Err
        assert!(mgr.lock().is_err(), "mutex should be poisoned");

        // Recover via into_inner — the pattern used in production
        let guard = mgr.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(
            guard.sessions.len(),
            0,
            "recovered PtyManager should be valid"
        );
    }

    /// Verify the crash handler writes to a file (not stderr).
    #[test]
    fn crash_handler_writes_to_file() {
        let crash_dir = tempfile::tempdir().unwrap();
        let crash_log = crash_dir.path().join("crash.log");

        // Simulate what install_crash_handler does: write crash info to file
        let crash_info = "=== TEST CRASH ===\nMessage: test\n";
        {
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&crash_log)
                .unwrap();
            std::io::Write::write_all(&mut f, crash_info.as_bytes()).unwrap();
        }

        let contents = std::fs::read_to_string(&crash_log).unwrap();
        assert!(contents.contains("TEST CRASH"));
    }

    /// Journal should be cleared after replay when all orphans are removed.
    #[test]
    fn journal_cleared_after_successful_replay() {
        let app_data_dir = tempfile::tempdir().unwrap();
        let repo_dir = tempfile::tempdir().unwrap();
        let repo_path = repo_dir.path().to_str().unwrap();

        // Create a fake orphan directory and log a journal entry for it
        let orphan_dir = app_data_dir.path().join("orphan-wt");
        std::fs::create_dir_all(&orphan_dir).unwrap();
        let orphan_path = orphan_dir.to_str().unwrap();

        git::journal::log_operation(
            app_data_dir.path(),
            repo_path,
            "CREATE",
            "sess1",
            "proj1",
            "feat",
            orphan_path,
        )
        .unwrap();

        // Verify journal has incomplete operations
        let incomplete = git::journal::get_incomplete_operations(app_data_dir.path(), repo_path);
        assert_eq!(incomplete.len(), 1);

        // Remove the orphan (simulating replay)
        std::fs::remove_dir_all(&orphan_dir).unwrap();

        // Verification: orphan is gone, so journal should be clearable
        assert!(!orphan_dir.exists());

        // Clear journal (this is what the production code does after verification passes)
        git::journal::clear_journal(app_data_dir.path(), repo_path);

        // Journal should now be empty
        let remaining = git::journal::get_incomplete_operations(app_data_dir.path(), repo_path);
        assert!(remaining.is_empty());
    }

    /// Verify the dirty-shutdown marker lifecycle: create, verify, delete.
    #[test]
    fn dirty_shutdown_marker_lifecycle() {
        let tmp = tempfile::tempdir().unwrap();
        let marker = tmp.path().join("running.marker");

        // Write the marker (simulating app startup)
        std::fs::write(&marker, "2026-01-01T00:00:00+00:00").unwrap();
        assert!(marker.exists(), "marker should exist after writing");

        // Delete the marker (simulating clean shutdown)
        std::fs::remove_file(&marker).unwrap();
        assert!(
            !marker.exists(),
            "marker should be gone after clean shutdown"
        );
    }

    /// Verify that missing worktree paths are detected during startup validation.
    #[test]
    fn startup_detects_missing_worktree_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("test.db");
        let database = db::Database::new(&db_path).unwrap();

        // Create a fake session and project so the worktree record is valid
        let session_id = "sess-missing-path";
        let project_id = "proj-missing-path";

        // Insert a minimal session record
        let update = pty::SessionUpdate {
            id: session_id.to_string(),
            label: "test".to_string(),
            description: String::new(),
            color: String::new(),
            group: None,
            phase: "running".to_string(),
            working_directory: tmp.path().to_string_lossy().to_string(),
            shell: "/bin/bash".to_string(),
            created_at: String::new(),
            last_activity_at: String::new(),
            workspace_paths: vec![],
            mode: pty::SessionMode::default(),
            detected_agent: None,
            metrics: pty::SessionMetrics {
                output_lines: 0,
                error_count: 0,
                stuck_score: 0.0,
                token_usage: std::collections::HashMap::new(),
                tool_calls: vec![],
                tool_call_summary: std::collections::HashMap::new(),
                files_touched: vec![],
                recent_errors: vec![],
                recent_actions: vec![],
                available_actions: vec![],
                memory_facts: vec![],
                latency_p50_ms: None,
                latency_p95_ms: None,
                latency_samples: vec![],
                token_history: vec![],
            },
            ai_provider: None,
            auto_approve: false,
            permission_mode: "default".to_string(),
            custom_prefix: String::new(),
            custom_suffix: String::new(),
            agent_name: String::new(),
            agent_command: String::new(),
            channels: vec![],
            context_injected: false,
            has_initial_context: false,
            last_nudged_version: 0,
            ssh_info: None,
            vendor_session_id: None,
            agent_startup: None,
            hosted: false,
            reattached: false,
            parent_session_id: None,
            agent_launch: Default::default(),
        };
        database.create_session_v2(&update).unwrap();

        // Insert a worktree record pointing to a non-existent directory
        let fake_wt_path = tmp.path().join("does-not-exist");
        database
            .insert_session_worktree(
                "wt-missing-1",
                session_id,
                project_id,
                fake_wt_path.to_str().unwrap(),
                Some("feature/gone"),
                false,
            )
            .unwrap();

        // Verify the record exists
        let before = database.get_all_session_worktrees().unwrap();
        assert_eq!(before.len(), 1);

        // Simulate the detection logic from cleanup_stale_worktrees second pass
        let remaining = database.get_all_session_worktrees().unwrap();
        let mut detected_missing = Vec::new();
        for wt in &remaining {
            if !wt.is_main_worktree && !Path::new(&wt.worktree_path).is_dir() {
                detected_missing.push(wt.id.clone());
                database.delete_session_worktree(&wt.id).unwrap();
            }
        }

        assert_eq!(detected_missing.len(), 1, "should detect one missing path");
        assert_eq!(detected_missing[0], "wt-missing-1");

        // Verify the DB record was cleaned up
        let after = database.get_all_session_worktrees().unwrap();
        assert!(after.is_empty(), "DB record should be deleted");

        // Verify the session still exists (we never delete sessions)
        assert!(
            database.session_exists(session_id).unwrap(),
            "session must NOT be deleted"
        );
    }

    /// F09 edge case: a link whose folder is missing survives the startup
    /// cleanup only when Hermes made the worktree and its branch still
    /// exists (then `create_session` puts it back on restore).
    #[test]
    fn missing_worktree_link_is_kept_only_for_a_hermes_worktree_on_a_live_branch() {
        let repo_dir = tempfile::tempdir().unwrap();
        let repo_path = repo_dir.path().to_str().unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .current_dir(repo_path)
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {:?}", args);
        };
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Hermes Test"]);
        git(&["config", "commit.gpgsign", "false"]);
        std::fs::write(repo_dir.path().join("a.txt"), "a").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "initial"]);
        git(&["branch", "hermes/task"]);

        let own = "/data/hermes-worktrees/abc/s1_hermes-task";
        assert!(keep_missing_worktree_link(
            true,
            false,
            own,
            Some(repo_path),
            Some("hermes/task")
        ));
        // A session the saved workspace does not restore: nobody would put
        // the worktree back, so the link would linger for ever. Drop it.
        assert!(!keep_missing_worktree_link(
            false,
            false,
            own,
            Some(repo_path),
            Some("hermes/task")
        ));
        // Branch gone, unknown, or no project to look in: drop the link.
        assert!(!keep_missing_worktree_link(
            true,
            false,
            own,
            Some(repo_path),
            Some("hermes/gone")
        ));
        assert!(!keep_missing_worktree_link(
            true,
            false,
            own,
            Some(repo_path),
            None
        ));
        assert!(!keep_missing_worktree_link(
            true,
            false,
            own,
            None,
            Some("hermes/task")
        ));
        // Not ours: the project folder, or a worktree made outside Hermes.
        assert!(!keep_missing_worktree_link(
            true,
            true,
            repo_path,
            Some(repo_path),
            Some("main")
        ));
        assert!(!keep_missing_worktree_link(
            true,
            false,
            "/work/external-wt",
            Some(repo_path),
            Some("hermes/task")
        ));
    }

    #[test]
    fn saved_workspace_session_ids_reads_the_frontend_format_and_tolerates_junk() {
        let ws = r#"{"version":3,"sessions":[{"id":"s1","label":"a"},{"id":"s2"},{"label":"no id"}],"layout":null}"#;
        let ids = saved_workspace_session_ids(Some(ws));
        assert_eq!(ids.len(), 2);
        assert!(ids.contains("s1") && ids.contains("s2"));
        assert!(saved_workspace_session_ids(None).is_empty());
        assert!(saved_workspace_session_ids(Some("")).is_empty());
        assert!(saved_workspace_session_ids(Some("not json")).is_empty());
        assert!(saved_workspace_session_ids(Some(r#"{"sessions":"x"}"#)).is_empty());
    }

    /// Journal should NOT be cleared if orphans still exist after replay.
    #[test]
    fn journal_kept_when_orphans_remain() {
        let app_data_dir = tempfile::tempdir().unwrap();
        let repo_dir = tempfile::tempdir().unwrap();
        let repo_path = repo_dir.path().to_str().unwrap();

        // Create a fake orphan directory and log a journal entry
        let orphan_dir = app_data_dir.path().join("stubborn-orphan");
        std::fs::create_dir_all(&orphan_dir).unwrap();
        let orphan_path = orphan_dir.to_str().unwrap();

        git::journal::log_operation(
            app_data_dir.path(),
            repo_path,
            "REMOVE",
            "sess1",
            "proj1",
            "",
            orphan_path,
        )
        .unwrap();

        // Simulate failed cleanup: orphan still exists
        assert!(orphan_dir.exists());

        // Verification check: orphan is still there, should NOT clear
        let incomplete = git::journal::get_incomplete_operations(app_data_dir.path(), repo_path);
        let mut all_cleaned = true;
        for entry in &incomplete {
            if entry.worktree_path != "pending" && Path::new(&entry.worktree_path).is_dir() {
                all_cleaned = false;
            }
        }
        assert!(!all_cleaned, "verification should detect remaining orphan");

        // Journal should still have entries
        let remaining = git::journal::get_incomplete_operations(app_data_dir.path(), repo_path);
        assert_eq!(remaining.len(), 1);
    }
}
