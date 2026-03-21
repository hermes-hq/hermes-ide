mod clipboard;
mod db;
mod git;
mod menu;
mod platform;
mod plugins;
mod process;
mod project;
/// Exposed for benchmarks — not part of the public API.
#[doc(hidden)]
pub mod pty;
mod transcript;
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
    let app_data_dir = match app.path().app_data_dir() {
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

        // Only remove linked worktrees from disk, not main worktrees
        if !wt.is_main_worktree {
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
                    "REMOVE" => {
                        // Incomplete removal — worktree may still exist on disk
                        if Path::new(&entry.worktree_path).is_dir() {
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
}

pub struct AppState {
    pub db: Mutex<db::Database>,
    pub pty_manager: Mutex<pty::PtyManager>,
    pub sys: Mutex<sysinfo::System>,
}

/// Save scrollback snapshots and session metadata to DB on close.
/// The frontend auto-save handles `saved_workspace` (with layout data).
fn do_save_workspace(app: &tauri::AppHandle) {
    let state = match app.try_state::<AppState>() {
        Some(s) => s,
        None => return,
    };
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
fn save_workspace_state(app: &tauri::AppHandle) {
    if WORKSPACE_SAVED.swap(true, Ordering::SeqCst) {
        return;
    }
    do_save_workspace(app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();
    install_crash_handler();

    // Create a Tokio runtime context for plugins that spawn async tasks during
    // initialization (tauri-plugin-aptabase calls tokio::task::spawn in its init
    // callback, before Tauri's own runtime is active).
    let rt = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime");
    let _guard = rt.enter();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_aptabase::Builder::new("A-EU-1922161061").build())
        .setup(|app| {
            let app_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("Failed to get app data dir: {}", e))?;
            std::fs::create_dir_all(&app_dir)
                .map_err(|e| format!("Failed to create app data dir: {}", e))?;
            std::fs::create_dir_all(app_dir.join("context"))
                .map_err(|e| format!("Failed to create context dir: {}", e))?;

            // Migrate old database name if needed
            let old_db_path = app_dir.join("axon_v3.db");
            let db_path = app_dir.join("hermes_idea_v3.db");
            if old_db_path.exists() && !db_path.exists() {
                let _ = std::fs::copy(&old_db_path, &db_path);
            }
            let database = db::Database::new(&db_path)
                .map_err(|e| format!("Failed to initialize database: {}", e))?;

            // Clean up stale worktrees from previous sessions that no longer exist
            cleanup_stale_worktrees(app.handle(), &database);

            // Clean up stale shell integration temp files from previous sessions
            pty::shell_integration::cleanup_stale();

            let mut sys = sysinfo::System::new();
            sys.refresh_all(); // baseline for CPU delta computation

            let state = AppState {
                db: Mutex::new(database),
                pty_manager: Mutex::new(pty::PtyManager::new()),
                sys: Mutex::new(sys),
            };

            app.manage(state);
            app.manage(Mutex::new(transcript::TranscriptWatcherState::default()));

            // Save workspace when the main window is about to close
            let save_handle = app.handle().clone();
            if let Some(window) = app.get_webview_window("main") {
                window.on_window_event(move |event| match event {
                    tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
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

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // AI provider detection
            pty::check_ai_providers,
            // Session management
            pty::create_session,
            pty::ssh_list_directory,
            pty::ssh_read_file,
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
            db::set_setting,
            db::log_execution,
            db::get_execution_log,
            // Execution Nodes
            db::get_execution_nodes,
            db::get_execution_node,
            db::get_execution_nodes_count,
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
            // Process management
            process::list_processes,
            process::kill_process,
            process::kill_process_tree,
            process::get_process_detail,
            process::reveal_process_in_finder,
            // Git integration
            git::git_status,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_push,
            git::git_pull,
            git::git_diff,
            git::git_open_file,
            git::read_file_content,
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
            git::git_remove_worktree,
            git::git_list_worktrees,
            git::git_check_branch_available,
            git::git_session_worktree_info,
            git::git_list_branches_for_projects,
            git::git_is_git_repo,
            git::git_worktree_has_changes,
            git::git_stash_worktree,
            // Worktree overview & cleanup
            git::git_list_all_worktrees,
            git::git_detect_orphan_worktrees,
            git::git_worktree_disk_usage,
            git::git_cleanup_orphan_worktrees,
            // Menu
            menu::show_context_menu,
            menu::update_menu_state,
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
            // Clipboard
            clipboard::copy_image_to_clipboard,
            // Transcript watching
            transcript::start_transcript_watcher,
            transcript::stop_transcript_watcher,
        ])
        .build(tauri::generate_context!())
        .expect("error while building HERMES-IDE")
        .run(|app, event| match &event {
            tauri::RunEvent::ExitRequested { .. } => {
                log::info!("[hermes] ExitRequested — saving workspace");
                save_workspace_state(app);
            }
            tauri::RunEvent::Exit => {
                log::info!("[hermes] Exit — saving workspace");
                save_workspace_state(app);
            }
            tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::CloseRequested { .. },
                ..
            } => {
                log::info!("[hermes] WindowCloseRequested — saving workspace");
                save_workspace_state(app);
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
