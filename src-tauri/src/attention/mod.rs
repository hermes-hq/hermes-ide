//! Attention: the OS side of the attention inbox (F12) and away
//! notifications (N16). The inbox itself lives in the frontend
//! (src/components/AttentionCenter.tsx); these commands are what it asks of
//! the OS.

pub mod away;
pub mod badge;
pub mod keep_awake;

use tauri::{AppHandle, State};

use crate::AppState;

/// Show the Blocked on you count on the app icon: `count` agents blocked on
/// you, and `notices` Hermes notices (a "!" when they are all there is).
/// Returns how this platform shows it ("dock-badge", "taskbar-overlay",
/// "urgency-hint").
#[tauri::command]
pub fn set_attention_badge(
    app: AppHandle,
    count: u32,
    notices: Option<u32>,
) -> Result<String, String> {
    badge::apply(&app, count, notices.unwrap_or(0)).map(str::to_string)
}

/// Keep the machine awake (`true`) or let it sleep again (`false`).
#[tauri::command]
pub async fn set_keep_awake(active: bool) -> Result<keep_awake::KeepAwakeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || keep_awake::set(active))
        .await
        .map_err(|e| e.to_string())
}

/// Send one away message. The address is read here, from the settings; with
/// none set this returns `unset` without any network call.
#[tauri::command]
pub async fn send_away_notification(
    state: State<'_, AppState>,
    payload: away::AwayPayload,
) -> Result<away::AwaySendResult, String> {
    let url = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_setting(away::AWAY_NOTIFY_URL_KEY)?
            .unwrap_or_default()
    };
    Ok(away::send(&url, &payload).await)
}

/// Let the machine sleep again when Hermes quits.
pub fn shutdown() {
    keep_awake::set(false);
}

/// Test builds: what the OS was asked for, and (where the OS lets an app
/// read it back) what it shows. macOS reads the dock tile's badge label;
/// Linux reads the window's urgency hint from GTK.
#[cfg(feature = "e2e")]
#[tauri::command]
pub async fn attention_state_for_test(app: AppHandle) -> Result<serde_json::Value, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<serde_json::Value>();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(read_os_badge(&handle));
    })
    .map_err(|e| e.to_string())?;
    let os = rx.await.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "badge": { "count": badge::last_count(), "label": badge::last_label(), "mechanism": badge::mechanism(), "os": os },
        "keepAwake": keep_awake::status(),
    }))
}

#[cfg(all(feature = "e2e", target_os = "macos"))]
fn read_os_badge(_app: &AppHandle) -> serde_json::Value {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;
    let Some(mtm) = MainThreadMarker::new() else {
        return serde_json::json!({ "error": "not on the main thread" });
    };
    let label = NSApplication::sharedApplication(mtm)
        .dockTile()
        .badgeLabel()
        .map(|s| s.to_string());
    serde_json::json!({ "dockBadgeLabel": label })
}

#[cfg(all(feature = "e2e", target_os = "linux"))]
fn read_os_badge(app: &AppHandle) -> serde_json::Value {
    use gtk::prelude::GtkWindowExt;
    use tauri::Manager;
    match app.get_webview_window("main").map(|w| w.gtk_window()) {
        Some(Ok(w)) => serde_json::json!({ "urgencyHint": w.is_urgency_hint() }),
        Some(Err(e)) => serde_json::json!({ "error": e.to_string() }),
        None => serde_json::json!({ "error": "no main window" }),
    }
}

/// Windows has no way to read a taskbar overlay back.
#[cfg(all(feature = "e2e", windows))]
fn read_os_badge(_app: &AppHandle) -> serde_json::Value {
    serde_json::json!({ "readable": false })
}

#[cfg(not(feature = "e2e"))]
#[tauri::command]
pub fn attention_state_for_test() -> Result<(), String> {
    Err("only available in a test build".to_string())
}
