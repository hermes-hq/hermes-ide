mod db;
mod git;
mod menu;
mod platform;
mod process;
mod pty;
mod realm;
mod workspace;

use std::sync::Mutex;
use tauri::Manager;

pub struct AppState {
    pub db: Mutex<db::Database>,
    pub pty_manager: Mutex<pty::PtyManager>,
    pub sys: Mutex<sysinfo::System>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let app_dir = app.path().app_data_dir()
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

            let mut sys = sysinfo::System::new();
            sys.refresh_all(); // baseline for CPU delta computation

            let state = AppState {
                db: Mutex::new(database),
                pty_manager: Mutex::new(pty::PtyManager::new()),
                sys: Mutex::new(sys),
            };

            app.manage(state);

            // Build and set native menu bar
            let handle = app.handle().clone();
            match menu::build_app_menu(&handle) {
                Ok(m) => {
                    app.set_menu(m).expect("Failed to set menu");
                    app.on_menu_event(move |app_handle, event| {
                        menu::handle_menu_event(app_handle, event);
                    });
                }
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
            pty::get_sessions,
            pty::get_session_detail,
            pty::get_session_metadata,
            pty::get_session_output,
            pty::update_session_label,
            pty::update_session_color,
            pty::add_workspace_path,
            pty::update_session_group,
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
            // Menu
            menu::show_context_menu,
            menu::update_menu_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running HERMES-IDE");
}
