//! Update channels.
//!
//! Stable clients read the manifest GitHub serves for the latest (non-pre-)
//! release, which is what `tauri.conf.json` configures. Beta clients read
//! `beta.json` from the `channels` branch, which the release train rewrites
//! every time a build is published as a prerelease. Promotion to stable is a
//! flag flip on the same release, so beta is always at or ahead of stable.
//!
//! The channel is the `update_channel` setting (`stable` | `beta`). Two
//! environment variables exist for test rigs; production builds honour them
//! as well, and the plugin's https and signature checks still apply:
//!   HERMES_UPDATE_ENDPOINT=<https url>   read this manifest instead
//!   HERMES_DISABLE_UPDATE_CHECK=1        never check (installed-artifact smoke)

use serde::Serialize;
use tauri::{Manager, Runtime};
use tauri_plugin_updater::UpdaterExt;

pub const STABLE: &str = "stable";
pub const BETA: &str = "beta";
pub const BETA_MANIFEST_URL: &str =
    "https://raw.githubusercontent.com/hermes-hq/hermes-ide/channels/beta.json";

/// Normalise whatever is stored: anything but "beta" is stable.
pub fn channel_from_setting(value: Option<&str>) -> &'static str {
    match value.map(str::trim) {
        Some(v) if v.eq_ignore_ascii_case(BETA) => BETA,
        _ => STABLE,
    }
}

/// The manifest URL to read for a channel, or `None` for the configured
/// stable endpoint. `endpoint_override` is `HERMES_UPDATE_ENDPOINT`.
pub fn endpoint_for(channel: &str, endpoint_override: Option<&str>) -> Option<String> {
    if let Some(url) = endpoint_override.map(str::trim).filter(|u| !u.is_empty()) {
        return Some(url.to_string());
    }
    if channel == BETA {
        Some(BETA_MANIFEST_URL.to_string())
    } else {
        None
    }
}

/// Whether checks are suppressed for this process.
pub fn checks_disabled(env_value: Option<&str>, self_test: bool) -> bool {
    self_test || matches!(env_value.map(str::trim), Some("1") | Some("true"))
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateChannelInfo {
    pub channel: String,
    /// The manifest the next check will read.
    pub endpoint: String,
    pub disabled: bool,
}

/// Same shape as the updater plugin's own `check` result, so the frontend
/// can wrap it in the plugin's `Update` class and download/install as usual.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    pub rid: tauri::ResourceId,
    pub current_version: String,
    pub version: String,
    pub date: Option<String>,
    pub body: Option<String>,
    pub raw_json: serde_json::Value,
}

fn stored_channel<R: Runtime>(app: &tauri::AppHandle<R>) -> &'static str {
    let stored = app.try_state::<crate::AppState>().and_then(|s| {
        s.db.lock()
            .ok()
            .and_then(|db| db.get_setting("update_channel").ok().flatten())
    });
    channel_from_setting(stored.as_deref())
}

fn describe<R: Runtime>(app: &tauri::AppHandle<R>) -> UpdateChannelInfo {
    let channel = stored_channel(app);
    let env_endpoint = std::env::var("HERMES_UPDATE_ENDPOINT").ok();
    let endpoint = endpoint_for(channel, env_endpoint.as_deref()).unwrap_or_else(|| {
        app.config()
            .plugins
            .0
            .get("updater")
            .and_then(|u| u.get("endpoints"))
            .and_then(|e| e.get(0))
            .and_then(|e| e.as_str())
            .unwrap_or("")
            .to_string()
    });
    UpdateChannelInfo {
        channel: channel.to_string(),
        endpoint,
        disabled: checks_disabled(
            std::env::var("HERMES_DISABLE_UPDATE_CHECK").ok().as_deref(),
            crate::self_test::active(),
        ),
    }
}

#[tauri::command]
pub fn get_update_channel_info(app: tauri::AppHandle) -> UpdateChannelInfo {
    describe(&app)
}

/// Check for an update on the configured channel. Returns `None` when the
/// app is up to date or checks are disabled for this process.
#[tauri::command]
pub async fn check_for_update(
    app: tauri::AppHandle,
    webview: tauri::Webview,
) -> Result<Option<UpdateMetadata>, String> {
    let info = describe(&app);
    if info.disabled {
        log::info!("[updater] check skipped (disabled for this process)");
        return Ok(None);
    }
    let channel = info.channel.clone();
    let env_endpoint = std::env::var("HERMES_UPDATE_ENDPOINT").ok();

    let mut builder = app.updater_builder();
    if let Some(url) = endpoint_for(&channel, env_endpoint.as_deref()) {
        let parsed = tauri::Url::parse(&url).map_err(|e| format!("bad update endpoint: {}", e))?;
        builder = builder.endpoints(vec![parsed]).map_err(|e| e.to_string())?;
    }
    let updater = builder.build().map_err(|e| e.to_string())?;
    log::info!(
        "[updater] checking channel '{}' at {}",
        channel,
        info.endpoint
    );
    let update = updater.check().await.map_err(|e| e.to_string())?;

    Ok(update.map(|u| {
        let date = u.date.map(|d| d.to_string());
        UpdateMetadata {
            current_version: u.current_version.clone(),
            version: u.version.clone(),
            date,
            body: u.body.clone(),
            raw_json: u.raw_json.clone(),
            rid: webview.resources_table().add(u),
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_or_missing_channel_is_stable() {
        assert_eq!(channel_from_setting(None), STABLE);
        assert_eq!(channel_from_setting(Some("")), STABLE);
        assert_eq!(channel_from_setting(Some("nightly")), STABLE);
        assert_eq!(channel_from_setting(Some("stable")), STABLE);
    }

    #[test]
    fn beta_is_recognised_loosely() {
        assert_eq!(channel_from_setting(Some("beta")), BETA);
        assert_eq!(channel_from_setting(Some(" Beta ")), BETA);
    }

    #[test]
    fn stable_uses_the_configured_endpoint() {
        assert_eq!(endpoint_for(STABLE, None), None);
        assert_eq!(endpoint_for(STABLE, Some("  ")), None);
    }

    #[test]
    fn beta_reads_the_channels_branch() {
        assert_eq!(endpoint_for(BETA, None).as_deref(), Some(BETA_MANIFEST_URL));
        assert!(BETA_MANIFEST_URL.starts_with("https://"));
    }

    #[test]
    fn environment_override_wins_on_every_channel() {
        let url = "https://example.test/staging/latest.json";
        assert_eq!(endpoint_for(STABLE, Some(url)).as_deref(), Some(url));
        assert_eq!(endpoint_for(BETA, Some(url)).as_deref(), Some(url));
    }

    #[test]
    fn checks_are_disabled_by_env_or_self_test() {
        assert!(!checks_disabled(None, false));
        assert!(!checks_disabled(Some("0"), false));
        assert!(checks_disabled(Some("1"), false));
        assert!(checks_disabled(Some("true"), false));
        assert!(checks_disabled(None, true));
    }
}
