//! Binds every plugin IPC call to the plugin that really makes it.
//!
//! Plugin bundles run inside the host webview, so any of them can reach
//! `window.__TAURI_INTERNALS__.invoke` and name whatever plugin id it likes.
//! A permission check keyed on a caller-supplied id therefore proves nothing.
//!
//! Instead:
//!
//! * The host (the app's own frontend) claims a random **host key** exactly
//!   once per page load, before it executes any plugin bundle. Every later
//!   claim in the same page is refused, so a bundle that runs afterwards can
//!   never obtain it.
//! * With the host key the host mints one unguessable **plugin token** per
//!   plugin and hands it to that plugin's API object only. The commands a
//!   plugin may use take the token, never an id; the id is resolved here.
//! * Management commands (installing, granting permissions, enabling) take
//!   the host key, so a plugin cannot grant itself anything either.
//!
//! A page reload starts over: the keys of the previous page are forgotten,
//! and the new page's host claims a fresh key first.

use std::sync::Mutex;

use tauri::{Manager, State};

/// Random, 256-bit, hex. Same shape for the host key and the plugin tokens.
fn random_secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Compare without leaking the match length through timing.
fn secret_matches(given: &str, expected: &str) -> bool {
    let (a, b) = (given.as_bytes(), expected.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Debug)]
pub struct PluginIdentity {
    host_key: String,
    host_key_claimed: bool,
    /// (plugin id, current token). One token per plugin at a time.
    tokens: Vec<(String, String)>,
}

impl Default for PluginIdentity {
    fn default() -> Self {
        Self::new()
    }
}

impl PluginIdentity {
    pub fn new() -> Self {
        Self {
            host_key: random_secret(),
            host_key_claimed: false,
            tokens: Vec::new(),
        }
    }

    /// Forget everything: a new page is loading and its host claims anew.
    pub fn reset(&mut self) {
        *self = Self::new();
    }

    /// Hand out the host key. Works once per page load; refused afterwards.
    pub fn claim_host_key(&mut self) -> Result<String, String> {
        if self.host_key_claimed {
            return Err(
                "the plugin host key was already claimed for this page; only the app itself may hold it"
                    .to_string(),
            );
        }
        self.host_key_claimed = true;
        Ok(self.host_key.clone())
    }

    pub fn require_host(&self, host_key: &str) -> Result<(), String> {
        if self.host_key_claimed && secret_matches(host_key, &self.host_key) {
            Ok(())
        } else {
            Err("this command is reserved for the app itself (invalid host key)".to_string())
        }
    }

    /// The current token for `plugin_id`, minting one when there is none.
    /// Host only. Idempotent so that host UI can address a plugin without
    /// invalidating the token that plugin's API object already holds.
    pub fn issue_token(&mut self, host_key: &str, plugin_id: &str) -> Result<String, String> {
        self.require_host(host_key)?;
        if plugin_id.is_empty() {
            return Err("plugin id must not be empty".to_string());
        }
        if let Some((_, token)) = self.tokens.iter().find(|(id, _)| id == plugin_id) {
            return Ok(token.clone());
        }
        let token = random_secret();
        self.tokens.push((plugin_id.to_string(), token.clone()));
        Ok(token)
    }

    /// Invalidate the plugin's current token (on deactivate / unload).
    pub fn revoke_token(&mut self, host_key: &str, plugin_id: &str) -> Result<(), String> {
        self.require_host(host_key)?;
        self.tokens.retain(|(id, _)| id != plugin_id);
        Ok(())
    }

    /// The plugin a token belongs to.
    pub fn resolve(&self, token: &str) -> Result<String, String> {
        // Check every entry so a miss costs the same as a hit.
        let mut found: Option<&str> = None;
        for (id, expected) in &self.tokens {
            if secret_matches(token, expected) {
                found = Some(id);
            }
        }
        found.map(str::to_string).ok_or_else(|| {
            "plugin token is not valid: the call is not bound to a loaded plugin".to_string()
        })
    }
}

/// Managed Tauri state.
#[derive(Default)]
pub struct PluginIdentityState(pub Mutex<PluginIdentity>);

impl PluginIdentityState {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, PluginIdentity>, String> {
        self.0
            .lock()
            .map_err(|_| "plugin identity state is poisoned".to_string())
    }

    /// The plugin id behind a token, or an error for the caller.
    pub fn plugin_for(&self, token: &str) -> Result<String, String> {
        self.lock()?.resolve(token)
    }

    pub fn require_host(&self, host_key: &str) -> Result<(), String> {
        self.lock()?.require_host(host_key)
    }
}

/// Called for every page load of the main webview: the page that was there
/// before is gone, and with it every key it held.
pub fn on_page_load(webview: &tauri::Webview, payload: &tauri::webview::PageLoadPayload<'_>) {
    if webview.label() != "main" {
        return;
    }
    if payload.event() != tauri::webview::PageLoadEvent::Started {
        return;
    }
    if let Some(state) = webview.app_handle().try_state::<PluginIdentityState>() {
        if let Ok(mut identity) = state.lock() {
            identity.reset();
        }
    }
}

// ─── Commands ─────────────────────────────────────────────────────────

/// The app frontend calls this once, before it loads any plugin bundle.
#[tauri::command]
pub fn claim_plugin_host_key(state: State<'_, PluginIdentityState>) -> Result<String, String> {
    state.lock()?.claim_host_key()
}

#[tauri::command]
pub fn issue_plugin_token(
    host_key: String,
    plugin_id: String,
    state: State<'_, PluginIdentityState>,
) -> Result<String, String> {
    state.lock()?.issue_token(&host_key, &plugin_id)
}

#[tauri::command]
pub fn revoke_plugin_token(
    host_key: String,
    plugin_id: String,
    state: State<'_, PluginIdentityState>,
) -> Result<(), String> {
    state.lock()?.revoke_token(&host_key, &plugin_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claimed() -> (PluginIdentity, String) {
        let mut id = PluginIdentity::new();
        let key = id.claim_host_key().expect("first claim");
        (id, key)
    }

    #[test]
    fn host_key_can_be_claimed_once_per_page() {
        let mut id = PluginIdentity::new();
        let key = id.claim_host_key().unwrap();
        assert_eq!(key.len(), 64);
        assert!(id.claim_host_key().is_err(), "a second claim is refused");
        assert!(id.require_host(&key).is_ok());
    }

    #[test]
    fn a_new_page_load_forgets_the_old_keys_and_allows_a_new_claim() {
        let (mut id, old_key) = claimed();
        let old_token = id.issue_token(&old_key, "acme.good").unwrap();
        id.reset();
        assert!(id.require_host(&old_key).is_err(), "old host key is dead");
        assert!(id.resolve(&old_token).is_err(), "old plugin token is dead");
        let new_key = id.claim_host_key().expect("the new page claims again");
        assert_ne!(new_key, old_key);
    }

    #[test]
    fn nothing_works_before_the_host_claimed_its_key() {
        let mut id = PluginIdentity::new();
        assert!(id.require_host("").is_err());
        assert!(id.issue_token("", "acme.good").is_err());
        assert!(id.resolve("").is_err());
    }

    #[test]
    fn only_the_host_key_mints_tokens() {
        let (mut id, key) = claimed();
        assert!(id.issue_token("not-the-key", "acme.good").is_err());
        assert!(id.issue_token("", "acme.good").is_err());
        assert!(id.issue_token(&key[..63], "acme.good").is_err());
        assert!(id.issue_token(&key, "acme.good").is_ok());
        assert!(id.issue_token(&key, "").is_err(), "empty ids are refused");
    }

    #[test]
    fn a_token_resolves_to_its_own_plugin_only() {
        let (mut id, key) = claimed();
        let good = id.issue_token(&key, "acme.good").unwrap();
        let rogue = id.issue_token(&key, "acme.rogue").unwrap();
        assert_ne!(good, rogue);
        assert_eq!(id.resolve(&good).unwrap(), "acme.good");
        assert_eq!(id.resolve(&rogue).unwrap(), "acme.rogue");
        // Naming a plugin is not being that plugin.
        assert!(id.resolve("acme.good").is_err());
        assert!(
            id.resolve(&key).is_err(),
            "the host key is not a plugin token"
        );
        assert!(id.resolve(&good[..63]).is_err());
        assert!(id.resolve(&format!("{good} ")).is_err());
    }

    #[test]
    fn issuing_again_returns_the_same_token_until_it_is_revoked() {
        let (mut id, key) = claimed();
        let first = id.issue_token(&key, "acme.good").unwrap();
        assert_eq!(id.issue_token(&key, "acme.good").unwrap(), first);
        id.revoke_token(&key, "acme.good").unwrap();
        assert!(id.resolve(&first).is_err(), "revoked token is dead");
        let second = id.issue_token(&key, "acme.good").unwrap();
        assert_ne!(second, first);
        assert_eq!(id.resolve(&second).unwrap(), "acme.good");
    }

    #[test]
    fn revoking_needs_the_host_key_and_leaves_other_plugins_alone() {
        let (mut id, key) = claimed();
        let good = id.issue_token(&key, "acme.good").unwrap();
        let other = id.issue_token(&key, "acme.other").unwrap();
        assert!(id.revoke_token("nope", "acme.good").is_err());
        assert_eq!(id.resolve(&good).unwrap(), "acme.good");
        id.revoke_token(&key, "acme.good").unwrap();
        assert!(id.resolve(&good).is_err());
        assert_eq!(id.resolve(&other).unwrap(), "acme.other");
    }

    #[test]
    fn secrets_are_random() {
        let a = random_secret();
        let b = random_secret();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
    }
}
