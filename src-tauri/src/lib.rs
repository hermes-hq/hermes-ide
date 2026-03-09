mod clipboard;
mod db;
mod git;
mod menu;
mod platform;
mod process;
mod pty;
mod realm;
mod workspace;

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::Manager;

static WORKSPACE_SAVED: AtomicBool = AtomicBool::new(false);

/// Clean up worktrees whose sessions no longer exist.
///
/// Called once during app startup. For each `session_worktrees` record whose
/// session is missing from the `sessions` table, we remove the git worktree
/// from disk (if it is a linked worktree) and delete the DB record. Finally,
/// we run `git worktree prune` on every repo that had stale entries.
fn cleanup_stale_worktrees(database: &db::Database) {
    let all_worktrees = match database.get_all_session_worktrees() {
        Ok(wts) => wts,
        Err(e) => {
            log::warn!("Startup worktree cleanup: failed to list worktrees: {}", e);
            return;
        }
    };

    let mut repos_to_prune: HashSet<String> = HashSet::new();

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
            if let Ok(Some(realm)) = database.get_realm(&wt.realm_id) {
                if let Err(e) =
                    git::worktree::remove_worktree(&realm.path, &wt.session_id, &wt.worktree_path)
                {
                    log::warn!(
                        "Startup worktree cleanup: failed to remove worktree '{}': {}",
                        wt.worktree_path,
                        e
                    );
                }
                repos_to_prune.insert(realm.path.clone());
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
        Err(_) => return,
    };
    let db = match state.db.lock() {
        Ok(d) => d,
        Err(_) => return,
    };

    for (session_id, pty_session) in &mgr.sessions {
        // Save session metadata first (INSERT OR REPLACE resets the row)
        if let Ok(s) = pty_session.session.lock() {
            let update = pty::SessionUpdate::from(&*s);
            db.create_session_v2(&update).ok();
        }

        // Save scrollback snapshot AFTER metadata (since create_session_v2 replaces the row)
        if let Ok(analyzer) = pty_session.analyzer.lock() {
            let snapshot = analyzer.get_stripped_output();
            db.save_session_snapshot(session_id, &snapshot).ok();

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
            cleanup_stale_worktrees(&database);

            let mut sys = sysinfo::System::new();
            sys.refresh_all(); // baseline for CPU delta computation

            let state = AppState {
                db: Mutex::new(database),
                pty_manager: Mutex::new(pty::PtyManager::new()),
                sys: Mutex::new(sys),
            };

            app.manage(state);

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
            // Session management
            pty::create_session,
            pty::write_to_session,
            pty::nudge_realm_context,
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
            pty::update_session_group,
            pty::get_available_shells,
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
            // Workspace
            workspace::scan_directory,
            workspace::detect_project,
            workspace::get_projects,
            // Realms
            realm::create_realm,
            realm::get_realms,
            realm::get_realm,
            realm::delete_realm,
            realm::attach_session_realm,
            realm::detach_session_realm,
            realm::get_session_realms,
            realm::scan_realm,
            realm::attunement::assemble_session_context,
            realm::attunement::apply_context,
            realm::attunement::fork_session_context,
            realm::attunement::load_hermes_project_config,
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
            // Git branch management
            git::git_list_branches,
            git::git_list_branches_for_realm,
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
            // Menu
            menu::show_context_menu,
            menu::update_menu_state,
            // Clipboard
            clipboard::copy_image_to_clipboard,
        ])
        .build(tauri::generate_context!())
        .expect("error while building HERMES-IDE")
        .run(|app, event| match &event {
            tauri::RunEvent::ExitRequested { .. } => {
                eprintln!("[hermes] ExitRequested — saving workspace");
                save_workspace_state(app);
            }
            tauri::RunEvent::Exit => {
                eprintln!("[hermes] Exit — saving workspace");
                save_workspace_state(app);
            }
            tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::CloseRequested { .. },
                ..
            } => {
                eprintln!("[hermes] WindowCloseRequested — saving workspace");
                save_workspace_state(app);
            }
            tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::Destroyed,
                ..
            } => {
                eprintln!("[hermes] WindowDestroyed — saving workspace");
                save_workspace_state(app);
            }
            _ => {}
        });
}
