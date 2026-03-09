pub mod attunement;
pub mod cartography;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::AppState;

// ─── Types ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchitectureInfo {
    pub pattern: String,
    pub layers: Vec<String>,
    pub entry_points: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Convention {
    pub rule: String,
    pub source: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Realm {
    pub id: String,
    pub path: String,
    pub name: String,
    pub languages: Vec<String>,
    pub frameworks: Vec<String>,
    pub architecture: Option<ArchitectureInfo>,
    pub conventions: Vec<Convention>,
    pub scan_status: String,
    pub last_scanned_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

// ─── IPC Commands ────────────────────────────────────────────────────

#[tauri::command]
pub fn create_realm(
    state: State<'_, AppState>,
    app: AppHandle,
    path: String,
    name: Option<String>,
) -> Result<Realm, String> {
    // Canonicalize so "." / "./" becomes an absolute path
    let canonical =
        std::fs::canonicalize(&path).map_err(|e| format!("Cannot resolve path {}: {}", path, e))?;
    let resolved_path = canonical.to_string_lossy().to_string();

    if !canonical.is_dir() {
        return Err(format!("Path {} is not a directory", resolved_path));
    }

    let realm_name = name.unwrap_or_else(|| {
        canonical
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string()
    });

    let id = Uuid::new_v4().to_string();

    // Run surface scan immediately to get languages/frameworks
    let scan_result = cartography::surface_scan(&resolved_path);

    let languages_json =
        serde_json::to_string(&scan_result.languages).unwrap_or_else(|_| "[]".to_string());
    let frameworks_json =
        serde_json::to_string(&scan_result.frameworks).unwrap_or_else(|_| "[]".to_string());

    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.insert_realm(
        &id,
        &resolved_path,
        &realm_name,
        &languages_json,
        &frameworks_json,
    )?;
    db.update_realm_scan(
        &id,
        "surface",
        None,
        None,
        Some(&languages_json),
        Some(&frameworks_json),
    )?;

    let realm = db
        .get_realm(&id)?
        .ok_or_else(|| "Failed to fetch created realm".to_string())?;

    // Emit event for frontend
    let _ = app.emit("realm-updated", &realm);

    // Spawn background deep scan
    let app_clone = app.clone();
    let realm_id = id.clone();
    let scan_path = resolved_path.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(2));
        let deep_result = cartography::deep_scan(&scan_path);

        let arch_json = serde_json::to_string(&deep_result.architecture).ok();
        let conv_json = serde_json::to_string(&deep_result.conventions).ok();
        let langs_json = if !deep_result.languages.is_empty() {
            serde_json::to_string(&deep_result.languages).ok()
        } else {
            None
        };
        let fws_json = if !deep_result.frameworks.is_empty() {
            serde_json::to_string(&deep_result.frameworks).ok()
        } else {
            None
        };

        if let Some(state) = app_clone.try_state::<AppState>() {
            if let Ok(db) = state.db.lock() {
                let _ = db.update_realm_scan(
                    &realm_id,
                    "deep",
                    arch_json.as_deref(),
                    conv_json.as_deref(),
                    langs_json.as_deref(),
                    fws_json.as_deref(),
                );
                // Store conventions individually
                for conv in &deep_result.conventions {
                    let _ =
                        db.insert_convention(&realm_id, &conv.rule, &conv.source, conv.confidence);
                }
                // Emit updated realm
                if let Ok(Some(updated)) = db.get_realm(&realm_id) {
                    let _ = app_clone.emit("realm-updated", &updated);
                }
                // Update context files for all sessions attached to this realm
                if let Ok(session_ids) = db.get_sessions_for_realm(&realm_id) {
                    for sid in &session_ids {
                        let _ = attunement::write_session_context_file(&app_clone, &db, sid);
                    }
                }
            }
        }
    });

    Ok(realm)
}

#[tauri::command]
pub fn get_realms(state: State<'_, AppState>) -> Result<Vec<Realm>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_all_realms()
}

#[tauri::command]
pub fn get_realm(state: State<'_, AppState>, id: String) -> Result<Option<Realm>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_realm(&id)
}

#[tauri::command]
pub fn delete_realm(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.delete_realm(&id)
}

#[tauri::command]
pub fn attach_session_realm(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: String,
    realm_id: String,
    role: Option<String>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.attach_session_realm(
        &session_id,
        &realm_id,
        &role.unwrap_or_else(|| "primary".to_string()),
    )?;

    // Write context file for the session
    let _ = attunement::write_session_context_file(&app, &db, &session_id);

    // Emit updated realms list for the session
    let realms = db.get_session_realms(&session_id)?;
    let _ = app.emit(&format!("session-realms-updated-{}", session_id), &realms);

    // Notify frontend that realms changed (for debounced nudge)
    let _ = app.emit("session-realms-changed", &session_id);

    Ok(())
}

#[tauri::command]
pub fn detach_session_realm(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: String,
    realm_id: String,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.detach_session_realm(&session_id, &realm_id)?;

    // Write context file for the session (will delete file if no realms remain)
    let _ = attunement::write_session_context_file(&app, &db, &session_id);

    let realms = db.get_session_realms(&session_id)?;
    let _ = app.emit(&format!("session-realms-updated-{}", session_id), &realms);

    // Notify frontend that realms changed (for debounced nudge)
    let _ = app.emit("session-realms-changed", &session_id);

    Ok(())
}

#[tauri::command]
pub fn get_session_realms(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<Realm>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_session_realms(&session_id)
}

#[tauri::command]
pub fn scan_realm(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
    depth: Option<String>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let realm = db
        .get_realm(&id)?
        .ok_or_else(|| "Realm not found".to_string())?;
    drop(db);

    let depth = depth.unwrap_or_else(|| "deep".to_string());
    let scan_path = realm.path.clone();
    let realm_id = realm.id.clone();
    let app_clone = app.clone();

    std::thread::spawn(move || {
        let result = match depth.as_str() {
            "surface" => {
                let r = cartography::surface_scan(&scan_path);
                cartography::ScanResult {
                    languages: r.languages,
                    frameworks: r.frameworks,
                    architecture: None,
                    conventions: Vec::new(),
                }
            }
            "full" => cartography::full_scan(&scan_path),
            _ => cartography::deep_scan(&scan_path),
        };

        let arch_json = result
            .architecture
            .as_ref()
            .and_then(|a| serde_json::to_string(a).ok());
        let conv_json = serde_json::to_string(&result.conventions).ok();
        let langs_json = if !result.languages.is_empty() {
            serde_json::to_string(&result.languages).ok()
        } else {
            None
        };
        let fws_json = if !result.frameworks.is_empty() {
            serde_json::to_string(&result.frameworks).ok()
        } else {
            None
        };

        if let Some(state) = app_clone.try_state::<AppState>() {
            if let Ok(db) = state.db.lock() {
                let _ = db.update_realm_scan(
                    &realm_id,
                    &depth,
                    arch_json.as_deref(),
                    conv_json.as_deref(),
                    langs_json.as_deref(),
                    fws_json.as_deref(),
                );
                for conv in &result.conventions {
                    let _ =
                        db.insert_convention(&realm_id, &conv.rule, &conv.source, conv.confidence);
                }
                if let Ok(Some(updated)) = db.get_realm(&realm_id) {
                    let _ = app_clone.emit("realm-updated", &updated);
                }
                // Update context files for all sessions attached to this realm
                if let Ok(session_ids) = db.get_sessions_for_realm(&realm_id) {
                    for sid in &session_ids {
                        let _ = attunement::write_session_context_file(&app_clone, &db, sid);
                    }
                }
            }
        }
    });

    Ok(())
}
