mod db;
mod pty;
mod realm;
mod workspace;

use std::sync::Mutex;
use tauri::Manager;

pub struct AppState {
    pub db: Mutex<db::Database>,
    pub pty_manager: Mutex<pty::PtyManager>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
            std::fs::create_dir_all(&app_dir).expect("Failed to create app data dir");
            std::fs::create_dir_all(app_dir.join("context")).expect("Failed to create context dir");

            // Migrate old database name if needed
            let old_db_path = app_dir.join("axon_v3.db");
            let db_path = app_dir.join("hermes_idea_v3.db");
            if old_db_path.exists() && !db_path.exists() {
                let _ = std::fs::copy(&old_db_path, &db_path);
            }
            let database = db::Database::new(&db_path).expect("Failed to initialize database");

            let state = AppState {
                db: Mutex::new(database),
                pty_manager: Mutex::new(pty::PtyManager::new()),
            };

            app.manage(state);
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
            // Error Patterns
            db::find_error_match,
            db::set_error_resolution,
            db::find_error_correlations,
            db::get_error_resolutions,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running HERMES-IDE");
}
