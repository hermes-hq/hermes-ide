//! Usage analytics (Aptabase), private by default.
//!
//! The Aptabase plugin is registered only after the user has opted in
//! (`telemetry_enabled = "true"` in settings). Until then no Aptabase client,
//! no HTTP client and no background flush loop exist in the process, so
//! nothing can be sent even if a call site forgets to check the setting.
//!
//! - The frontend calls `enable_analytics` at startup when the stored setting
//!   is `"true"`, and again when the user opts in (onboarding or Settings >
//!   Privacy), so the choice takes effect without a restart. The command
//!   re-checks the stored setting itself.
//! - Opting out stops the frontend from tracking anything; the plugin only
//!   ever sends events that were explicitly tracked (audited against
//!   tauri-plugin-aptabase 1.0.0: its flush loop posts nothing while its
//!   queue is empty, and only `track_event` fills the queue).
//!
//! `HERMES_E2E=1` (how the real-app test rig and CI launch the app) always
//! keeps analytics away from Aptabase. A test build (cargo feature `e2e`) can
//! instead point it at a loopback sink with `HERMES_E2E_ANALYTICS_HOST`, so a
//! scenario can watch exactly what the app would send.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Runtime, State};

use crate::AppState;

const APP_KEY: &str = "A-EU-1922161061";
/// A self-hosted-style key, so the plugin accepts a custom host. Only ever
/// used with a loopback host.
const E2E_SINK_APP_KEY: &str = "A-SH-E2E";

/// Whether the plugin has been registered in this process.
static ACTIVE: AtomicBool = AtomicBool::new(false);

#[derive(Debug, PartialEq, Eq)]
enum Destination {
    /// Analytics can never run in this process.
    Nowhere,
    Aptabase,
    /// Test builds only: a loopback HTTP server run by a scenario.
    LocalSink(String),
}

fn is_loopback_host(host: &str) -> bool {
    let Ok(url) = tauri::Url::parse(host) else {
        return false;
    };
    url.scheme() == "http"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_some()
        && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"))
        && url.path() == "/"
}

fn destination(hermes_e2e: bool, sink_host: Option<String>) -> Destination {
    if !hermes_e2e {
        return Destination::Aptabase;
    }
    match sink_host {
        Some(host) if is_loopback_host(&host) => Destination::LocalSink(host),
        _ => Destination::Nowhere,
    }
}

fn current_destination() -> Destination {
    let hermes_e2e = std::env::var("HERMES_E2E").as_deref() == Ok("1");
    let sink_host = if cfg!(feature = "e2e") {
        std::env::var("HERMES_E2E_ANALYTICS_HOST").ok()
    } else {
        None
    };
    destination(hermes_e2e, sink_host)
}

fn plugin<R: Runtime>(destination: Destination) -> Option<TauriPlugin<R>> {
    match destination {
        Destination::Nowhere => None,
        Destination::Aptabase => Some(tauri_plugin_aptabase::Builder::new(APP_KEY).build()),
        Destination::LocalSink(host) => Some(
            tauri_plugin_aptabase::Builder::new(E2E_SINK_APP_KEY)
                .with_options(tauri_plugin_aptabase::InitOptions {
                    host: Some(host),
                    flush_interval: Some(Duration::from_millis(500)),
                })
                .build(),
        ),
    }
}

/// Turns analytics on for the running app after the user opted in.
///
/// Returns whether analytics is active. It stays off when the stored setting
/// is not `"true"` (the opt-in must be persisted first) or when this process
/// may never send analytics (`HERMES_E2E=1` without a loopback sink).
#[tauri::command]
pub fn enable_analytics(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    let opted_in = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.get_setting("telemetry_enabled")?.as_deref() == Some("true")
    };
    if !opted_in {
        return Ok(false);
    }
    if ACTIVE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok(true);
    }
    let Some(p) = plugin(current_destination()) else {
        ACTIVE.store(false, Ordering::SeqCst);
        return Ok(false);
    };
    if let Err(e) = app.plugin(p) {
        ACTIVE.store(false, Ordering::SeqCst);
        return Err(e.to_string());
    }
    log::info!("[analytics] opted in: analytics turned on");
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_runs_send_to_aptabase() {
        assert_eq!(destination(false, None), Destination::Aptabase);
        // The sink variable is ignored outside e2e runs.
        assert_eq!(
            destination(false, Some("http://127.0.0.1:9".into())),
            Destination::Aptabase
        );
    }

    #[test]
    fn e2e_runs_never_reach_aptabase() {
        assert_eq!(destination(true, None), Destination::Nowhere);
        assert_eq!(
            destination(true, Some("https://eu.aptabase.com".into())),
            Destination::Nowhere
        );
        assert_eq!(
            destination(true, Some("http://127.0.0.1.example.com".into())),
            Destination::Nowhere
        );
        assert_eq!(
            destination(true, Some("http://127.0.0.1:80@example.com".into())),
            Destination::Nowhere
        );
        assert_eq!(
            destination(true, Some("http://127.0.0.1".into())),
            Destination::Nowhere
        );
    }

    #[test]
    fn e2e_runs_may_use_a_loopback_sink() {
        assert_eq!(
            destination(true, Some("http://127.0.0.1:4567".into())),
            Destination::LocalSink("http://127.0.0.1:4567".into())
        );
        assert_eq!(
            destination(true, Some("http://localhost:4567".into())),
            Destination::LocalSink("http://localhost:4567".into())
        );
    }
}
