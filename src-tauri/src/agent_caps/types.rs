//! The launch contract's wire format. Field names are camelCase on the wire,
//! exactly as `src/agent/capabilities/types.ts`. Additions only.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileEnv {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccount {
    pub id: String,
    pub label: String,
    /// A short fact ("Max plan", "ChatGPT account"). Never an e-mail.
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_env: Option<ProfileEnv>,
    pub signed_in: bool,
    /// "signed-in", "signed-out" or "unknown" (no read-only probe; signedIn
    /// is then true, so nothing is blocked on a guess).
    pub sign_in_state: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub efforts: Vec<String>,
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    /// Why, as a code: "refused" (the account refused it at a launch).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalModeOption {
    pub id: String,
    pub label: String,
    pub flag: Vec<String>,
    pub note: String,
    pub danger: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    pub agent_id: String,
    pub cli_version: Option<String>,
    pub installed: bool,
    pub verified_on_real_install: bool,
    pub accounts: Vec<AgentAccount>,
    pub active_account_id: Option<String>,
    pub can_add_account: bool,
    /// Always starts with {id: "default"}.
    pub models: Vec<ModelOption>,
    /// "cli-list", "aliases" or "free-text".
    pub model_source: String,
    pub approval_modes: Vec<ApprovalModeOption>,
    /// "exact" or "guessed".
    pub status_source: String,
    pub agent_name: String,
    pub effort_values: Vec<String>,
    /// "cli", "server" or "none".
    pub effort_validated_by: String,
    pub accepts_typed_model: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_note: Option<String>,
    pub default_approval_mode_id: String,
    pub checked_at: i64,
    /// The folder the default profile uses when Hermes's environment sets
    /// the agent's profile variable (`CODEX_HOME=…`): its config lives
    /// there, not in the catalog's `~/.codex`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_profile_dir: Option<String>,
}

/// Where the agent runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum LaunchWhere {
    #[serde(rename = "new-worktree")]
    NewWorktree {
        #[serde(rename = "baseBranch", default)]
        base_branch: String,
        #[serde(default)]
        branch: String,
    },
    #[serde(rename = "existing-branch")]
    ExistingBranch { branch: String },
    #[serde(rename = "current-checkout")]
    CurrentCheckout,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchChoice {
    pub agent_id: String,
    pub account_id: String,
    pub approval_mode_id: String,
    /// "default" omits the model flag.
    pub model_id: String,
    pub effort: Option<String>,
    #[serde(default)]
    pub extra_args: String,
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub channels: Vec<String>,
    #[serde(rename = "where")]
    pub where_: LaunchWhere,
    #[serde(default)]
    pub track_as_feature: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub also_on: Option<Box<LaunchChoice>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceIssue {
    /// "agent", "model", "effort", "account" or "approval".
    pub field: String,
    /// The sentence in English (`code` and `params` say it in the person's
    /// language: the UI key `agentsSettings.issue.<code>`).
    pub message: String,
    pub was: Option<String>,
    pub now: Option<String>,
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub params: std::collections::BTreeMap<String, String>,
    /// About the choice's "Also on" agent.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub also_on: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckedChoice {
    pub choice: LaunchChoice,
    pub issues: Vec<ChoiceIssue>,
    pub launchable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsualLaunchChoice {
    pub choice: LaunchChoice,
    pub issues: Vec<ChoiceIssue>,
    pub launchable: bool,
    /// "repo", "global" or "catalog".
    pub source: String,
    pub count: i64,
    pub last_used_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckedPreset {
    pub id: String,
    pub name: String,
    pub choice: LaunchChoice,
    pub issues: Vec<ChoiceIssue>,
    pub launchable: bool,
    pub effective: LaunchChoice,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RememberResult {
    pub count: i64,
    pub suggest_preset: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddedAccount {
    pub account: AgentAccount,
    pub reused: bool,
    pub signed_in: bool,
}

/// `validate_launch`'s answer: `{ok: true}` or `{ok: false, field, message}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum LaunchValidation {
    Ok {
        ok: bool,
    },
    Refused {
        ok: bool,
        field: String,
        message: String,
    },
}

impl LaunchValidation {
    pub fn ok() -> Self {
        LaunchValidation::Ok { ok: true }
    }
    pub fn refused(field: &str, message: impl Into<String>) -> Self {
        LaunchValidation::Refused {
            ok: false,
            field: field.to_string(),
            message: message.into(),
        }
    }
    pub fn is_ok(&self) -> bool {
        matches!(self, LaunchValidation::Ok { .. })
    }
}

/// create_session's `agentLaunch` and relaunch_agent's options.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLaunchOptions {
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
    /// "agent" (default) or "login".
    #[serde(default)]
    pub purpose: Option<String>,
}

/// What a terminal session was launched with, kept on the session and sent
/// to the frontend (the model chip's "requested" fallback, the banner).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLaunch {
    /// None: the default model (no flag).
    pub model_id: Option<String>,
    pub effort: Option<String>,
    /// None: the default profile.
    pub account_id: Option<String>,
    /// The account's profile environment, resolved when the session was
    /// created (so a restore resumes in the same profile).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_env: Option<ProfileEnv>,
    /// Run the CLI's sign-in instead of the agent.
    #[serde(default)]
    pub login: bool,
    /// The next launch starts again after a refused one (the banner's
    /// buttons): `hi` clears the screen first, so a terminal that repaints
    /// its screen (Windows' ConPTY) cannot replay the old refusal. Never
    /// saved or sent.
    #[serde(skip)]
    pub relaunch: bool,
    /// The last launch resumed a saved conversation, so starting again
    /// after its refusal resumes that conversation too. Never saved or sent.
    #[serde(skip)]
    pub resumed: bool,
}

impl SessionLaunch {
    pub fn is_empty(&self) -> bool {
        self.model_id.is_none()
            && self.effort.is_none()
            && self.account_id.is_none()
            && self.profile_env.is_none()
            && !self.login
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_launch_choice_reads_and_writes_the_typescript_shape() {
        let raw = json!({
            "agentId": "claude", "accountId": "work", "approvalModeId": "acceptEdits",
            "modelId": "opus", "effort": "high", "extraArgs": "", "prefix": "caffeinate -i",
            "channels": ["plugin:x"], "where": {"kind": "new-worktree", "baseBranch": "main", "branch": "hermes/x"},
            "trackAsFeature": true,
            "alsoOn": {"agentId": "codex", "accountId": "default", "approvalModeId": "auto", "modelId": "default",
                       "effort": null, "extraArgs": "", "prefix": "", "channels": [], "where": {"kind": "current-checkout"}, "trackAsFeature": false}
        });
        let c: LaunchChoice = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(
            c.where_,
            LaunchWhere::NewWorktree {
                base_branch: "main".into(),
                branch: "hermes/x".into()
            }
        );
        assert_eq!(
            c.also_on.as_ref().unwrap().where_,
            LaunchWhere::CurrentCheckout
        );
        assert_eq!(serde_json::to_value(&c).unwrap(), raw);
        let existing: LaunchWhere =
            serde_json::from_value(json!({"kind": "existing-branch", "branch": "dev"})).unwrap();
        assert_eq!(
            existing,
            LaunchWhere::ExistingBranch {
                branch: "dev".into()
            }
        );
        assert!(serde_json::from_value::<LaunchWhere>(json!({"kind": "elsewhere"})).is_err());
    }

    #[test]
    fn validation_serialises_as_ok_true_or_a_field_and_message() {
        assert_eq!(
            serde_json::to_value(LaunchValidation::ok()).unwrap(),
            json!({"ok": true})
        );
        assert_eq!(
            serde_json::to_value(LaunchValidation::refused("effort", "no")).unwrap(),
            json!({"ok": false, "field": "effort", "message": "no"})
        );
    }
}
