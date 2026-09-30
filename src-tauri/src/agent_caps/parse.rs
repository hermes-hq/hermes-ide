//! Parsers for what the CLIs' read-only probes print. Pure; tested on the
//! verbatim outputs recorded in the capability matrix (e-mails, org names
//! and paths replaced by synthetic ones). Only the facts Hermes shows are
//! kept: signed in or not, the plan or sign-in method, model ids, labels and
//! effort levels. An e-mail, an org name or a token never leaves a parser.

use serde_json::Value;

/// What an account probe said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthInfo {
    /// None: the probe did not say (it failed or printed something else).
    pub signed_in: Option<bool>,
    /// "Max plan", "ChatGPT account", "API key"… ("" when unknown).
    pub detail: String,
}

impl AuthInfo {
    fn unknown() -> Self {
        AuthInfo {
            signed_in: None,
            detail: String::new(),
        }
    }
}

/// One model a CLI listed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedModel {
    pub id: String,
    pub label: String,
    pub note: Option<String>,
    /// Effort levels the CLI says the model takes; None when it does not say.
    pub efforts: Option<Vec<String>>,
}

fn plan_label(subscription: &str) -> String {
    match subscription.to_ascii_lowercase().as_str() {
        "max" => "Max plan".to_string(),
        "pro" => "Pro plan".to_string(),
        "team" => "Team plan".to_string(),
        "enterprise" => "Enterprise plan".to_string(),
        "free" => "Free plan".to_string(),
        other if !other.is_empty() => {
            let mut c = other.chars();
            let first = c
                .next()
                .map(|f| f.to_uppercase().collect::<String>())
                .unwrap_or_default();
            format!("{first}{} plan", c.as_str())
        }
        _ => String::new(),
    }
}

/// `claude auth status --json` (exit 0 signed in, 1 not). Keeps loggedIn,
/// the plan and the sign-in method; drops email, orgId, orgName.
pub fn claude_auth(output: &str, exit_code: i32) -> AuthInfo {
    let json = output
        .find('{')
        .and_then(|start| serde_json::from_str::<Value>(output[start..].trim()).ok());
    let Some(v) = json else {
        return match exit_code {
            0 => AuthInfo {
                signed_in: Some(true),
                detail: String::new(),
            },
            1 => AuthInfo {
                signed_in: Some(false),
                detail: "not signed in".to_string(),
            },
            _ => AuthInfo::unknown(),
        };
    };
    let logged_in = v.get("loggedIn").and_then(Value::as_bool);
    if logged_in != Some(true) {
        return AuthInfo {
            signed_in: Some(false),
            detail: "not signed in".to_string(),
        };
    }
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("");
    let detail = match (s("apiProvider"), s("authMethod"), s("subscriptionType")) {
        ("bedrock", _, _) => "Amazon Bedrock".to_string(),
        ("vertex", _, _) => "Google Vertex AI".to_string(),
        ("foundry", _, _) => "Microsoft Foundry".to_string(),
        (_, _, sub) if !sub.is_empty() => plan_label(sub),
        (_, "apiKey" | "api_key" | "console", _) => "API key".to_string(),
        (_, "claude.ai", _) => "Claude account".to_string(),
        _ => String::new(),
    };
    AuthInfo {
        signed_in: Some(true),
        detail,
    }
}

/// `codex login status`: "Logged in using ChatGPT" (exit 0) or "Not logged
/// in" (exit 1).
pub fn codex_login_status(output: &str, exit_code: i32) -> AuthInfo {
    let lower = output.to_ascii_lowercase();
    if lower.contains("not logged in") {
        return AuthInfo {
            signed_in: Some(false),
            detail: "not signed in".to_string(),
        };
    }
    if lower.contains("logged in") {
        let detail = if lower.contains("chatgpt") {
            "ChatGPT account"
        } else if lower.contains("api key") {
            "API key"
        } else {
            ""
        };
        return AuthInfo {
            signed_in: Some(true),
            detail: detail.to_string(),
        };
    }
    exit_code_auth(exit_code)
}

/// A sign-in check that only says it by its exit code.
pub fn exit_code_auth(exit_code: i32) -> AuthInfo {
    match exit_code {
        0 => AuthInfo {
            signed_in: Some(true),
            detail: String::new(),
        },
        1 => AuthInfo {
            signed_in: Some(false),
            detail: "not signed in".to_string(),
        },
        _ => AuthInfo::unknown(),
    }
}

/// `codex debug models [--bundled]`: `{"models":[{slug, display_name,
/// visibility, supported_reasoning_levels:[{effort}], ...}]}`. Hidden models
/// (visibility "hide") are left out. Not filtered by plan: a listed model can
/// still be refused by the account at the first turn.
pub fn codex_models(output: &str) -> Option<Vec<ListedModel>> {
    let start = output.find('{')?;
    let v: Value = serde_json::from_str(output[start..].trim()).ok()?;
    let models = v.get("models")?.as_array()?;
    let mut out = Vec::new();
    for m in models {
        let Some(slug) = m.get("slug").and_then(Value::as_str) else {
            continue;
        };
        if m.get("visibility").and_then(Value::as_str) == Some("hide") {
            continue;
        }
        let label = m
            .get("display_name")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or(slug);
        let efforts = m
            .get("supported_reasoning_levels")
            .and_then(Value::as_array)
            .map(|levels| {
                levels
                    .iter()
                    .filter_map(|l| {
                        l.get("effort")
                            .and_then(Value::as_str)
                            .or_else(|| l.as_str())
                            .map(str::to_string)
                    })
                    .collect::<Vec<_>>()
            });
        let note = m
            .get("description")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(80).collect());
        out.push(ListedModel {
            id: slug.to_string(),
            label: label.to_string(),
            note,
            efforts,
        });
    }
    Some(out)
}

/// What `agy models` said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgyModels {
    Listed(Vec<ListedModel>),
    SignedOut,
}

/// `agy models`: one model per line, `slug<TAB>Display name` (1.0.6 on
/// newer builds) or the display name alone; a "Fetching…" line first. An
/// "Authentication required" line means signed out.
pub fn agy_models(output: &str) -> AgyModels {
    let mut out = Vec::new();
    for raw in output.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with("Authentication required") {
            return AgyModels::SignedOut;
        }
        if line.ends_with("...") || line.ends_with('…') || line.ends_with(':') {
            continue;
        }
        let (id, label) = match line.split_once('\t') {
            Some((slug, name)) => (slug.trim().to_string(), name.trim().to_string()),
            None => (line.to_string(), line.to_string()),
        };
        if id.is_empty() || out.iter().any(|m: &ListedModel| m.id == id) {
            continue;
        }
        out.push(ListedModel {
            id,
            label,
            note: None,
            efforts: None,
        });
    }
    AgyModels::Listed(out)
}

/// A plain list: one model id per line (`opencode models`). Lines with
/// spaces are headers or notes, not ids.
pub fn model_lines(output: &str) -> Vec<ListedModel> {
    let mut out: Vec<ListedModel> = Vec::new();
    for line in output.lines().map(str::trim) {
        if line.is_empty() || line.contains(char::is_whitespace) || out.iter().any(|m| m.id == line)
        {
            continue;
        }
        out.push(ListedModel {
            id: line.to_string(),
            label: line.to_string(),
            note: None,
            efforts: None,
        });
    }
    out
}

/// The extra models Claude Code offers this account, from its own cache in
/// `<config dir>/.claude.json` (`additionalModelOptionsCache`: `[{value,
/// label, …}]`). Undocumented: anything unexpected gives an empty list.
pub fn claude_model_cache(text: &str) -> Vec<ListedModel> {
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    let Some(list) = v
        .get("additionalModelOptionsCache")
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    list.iter()
        .filter_map(|m| {
            let id = m.get("value").and_then(Value::as_str)?.trim();
            if id.is_empty() || id.chars().any(|c| c.is_whitespace() || c.is_control()) {
                return None;
            }
            let label = m
                .get("label")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(id);
            Some(ListedModel {
                id: id.to_string(),
                label: label.trim().to_string(),
                note: Some("from this account".to_string()),
                efforts: None,
            })
        })
        .collect()
}

/// The effort levels a model takes: what the CLI listed for it, else the
/// catalog's first `per_model` rule whose pattern matches the id, else every
/// level. [] when the agent has no effort control at launch.
pub fn efforts_for(
    effort: Option<&crate::agent_catalog::EffortCaps>,
    model_id: &str,
    listed: Option<&[String]>,
) -> Vec<String> {
    let Some(effort) = effort else {
        return Vec::new();
    };
    if let Some(listed) = listed {
        return listed
            .iter()
            .filter(|e| effort.values.contains(e))
            .cloned()
            .collect();
    }
    if let Some(rules) = &effort.per_model {
        for rule in rules {
            if regex::Regex::new(&rule.pattern).is_ok_and(|re| re.is_match(model_id)) {
                return rule.values.clone();
            }
        }
    }
    effort.values.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── Verbatim outputs from the capability matrix (redacted) ─────
    const CLAUDE_AUTH_IN: &str = r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","configDirectory":"/tmp/hermes-test/.claude","email":"person@example.com","orgId":"00000000-0000-4000-8000-000000000000","orgName":"Example Org","subscriptionType":"max"}"#;
    const CLAUDE_AUTH_OUT: &str =
        r#"{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}"#;

    #[test]
    fn claude_auth_status_keeps_the_plan_and_drops_the_email_and_org() {
        let info = claude_auth(CLAUDE_AUTH_IN, 0);
        assert_eq!(
            info,
            AuthInfo {
                signed_in: Some(true),
                detail: "Max plan".into()
            }
        );
        let debug = format!("{info:?}");
        assert!(!debug.contains("example.com") && !debug.contains("Example Org"));
        assert_eq!(claude_auth(CLAUDE_AUTH_OUT, 1).signed_in, Some(false));
        let api = r#"{"loggedIn":true,"authMethod":"apiKey","apiProvider":"firstParty"}"#;
        assert_eq!(claude_auth(api, 0).detail, "API key");
        let bedrock = r#"{"loggedIn":true,"authMethod":"none","apiProvider":"bedrock"}"#;
        assert_eq!(claude_auth(bedrock, 0).detail, "Amazon Bedrock");
        assert_eq!(
            claude_auth(r#"{"loggedIn":true,"subscriptionType":"pro"}"#, 0).detail,
            "Pro plan"
        );
    }

    #[test]
    fn claude_auth_without_json_falls_back_to_the_exit_code() {
        assert_eq!(claude_auth("", 0).signed_in, Some(true));
        assert_eq!(claude_auth("Not logged in", 1).signed_in, Some(false));
        assert_eq!(
            claude_auth("error: unknown option '--json'", 2).signed_in,
            None
        );
    }

    #[test]
    fn codex_login_status_reads_the_sign_in_method() {
        assert_eq!(
            codex_login_status("Logged in using ChatGPT\n", 0),
            AuthInfo {
                signed_in: Some(true),
                detail: "ChatGPT account".into()
            }
        );
        assert_eq!(
            codex_login_status("Logged in using an API key - sk-proj-***ABCD\n", 0).detail,
            "API key"
        );
        assert_eq!(
            codex_login_status("Not logged in\n", 1).signed_in,
            Some(false)
        );
        assert_eq!(codex_login_status("", 1).signed_in, Some(false));
        assert_eq!(codex_login_status("", 101).signed_in, None);
    }

    const CODEX_MODELS: &str = r#"{"models":[
      {"slug":"gpt-5.6-terra","display_name":"GPT-5.6-Terra","description":"Balanced agentic coding model for everyday work.","default_reasoning_level":"medium","supported_reasoning_levels":[{"effort":"low","description":"Fast responses with lighter reasoning"},{"effort":"medium"},{"effort":"high"},{"effort":"xhigh"},{"effort":"max"},{"effort":"ultra"}],"visibility":"list","base_instructions":"You are Codex..."},
      {"slug":"gpt-5.6-luna","display_name":"GPT-5.6-Luna","default_reasoning_level":"medium","supported_reasoning_levels":[{"effort":"low"},{"effort":"medium"},{"effort":"high"},{"effort":"xhigh"},{"effort":"max"}],"visibility":"list"},
      {"slug":"gpt-5.5","display_name":"GPT-5.5","supported_reasoning_levels":[{"effort":"low"},{"effort":"medium"},{"effort":"high"},{"effort":"xhigh"}],"visibility":"list"},
      {"slug":"gpt-reserve","display_name":"GPT Reserve","supported_reasoning_levels":[],"visibility":"hide"},
      {"slug":"codex-auto-review","display_name":"Codex Auto Review","supported_reasoning_levels":[{"effort":"low"}],"visibility":"hide"}
    ]}"#;

    #[test]
    fn codex_debug_models_lists_the_visible_models_with_their_efforts() {
        let models = codex_models(CODEX_MODELS).unwrap();
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);
        assert_eq!(models[0].label, "GPT-5.6-Terra");
        assert_eq!(
            models[0].efforts.as_deref().unwrap(),
            ["low", "medium", "high", "xhigh", "max", "ultra"]
        );
        assert_eq!(
            models[2].efforts.as_deref().unwrap(),
            ["low", "medium", "high", "xhigh"]
        );
        assert_eq!(
            models[0].note.as_deref(),
            Some("Balanced agentic coding model for everyday work.")
        );
        // A warning line before the JSON is skipped; garbage is None.
        assert_eq!(
            codex_models(&format!("WARNING: stale cache\n{CODEX_MODELS}"))
                .unwrap()
                .len(),
            3
        );
        assert!(codex_models("not json").is_none());
        assert!(codex_models(r#"{"data":[]}"#).is_none());
    }

    #[test]
    fn agy_models_reads_both_output_shapes_and_signed_out() {
        // 1.0.6 as recorded in the capability matrix: display names only.
        let old = "Gemini 3.6 Flash (High)\nGemini 3.6 Flash (Medium)\nGemini 3.6 Flash (Low)\nGemini 3.1 Pro (High)\nGemini 3.1 Pro (Low)\nClaude Sonnet 4.6 (Thinking)\nClaude Opus 4.6 (Thinking)\nGPT-OSS 120B (Medium)\n";
        let AgyModels::Listed(models) = agy_models(old) else {
            panic!("signed out?")
        };
        assert_eq!(models.len(), 8);
        assert_eq!(models[0].id, "Gemini 3.6 Flash (High)");
        // Current builds: "Fetching…", then slug<TAB>name.
        let new = "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.1-pro-low\tGemini 3.1 Pro (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n";
        let AgyModels::Listed(models) = agy_models(new) else {
            panic!("signed out?")
        };
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            [
                "gemini-3.8-flash-high",
                "gemini-3.1-pro-low",
                "claude-sonnet-4-6"
            ]
        );
        assert_eq!(models[1].label, "Gemini 3.1 Pro (Low)");
        let out = "Authentication required. Please visit the URL to log in:\nhttps://accounts.example.com/o/oauth2/auth?x=1\n";
        assert_eq!(agy_models(out), AgyModels::SignedOut);
    }

    #[test]
    fn plain_model_lines_skip_headers() {
        let models = model_lines(
            "Available models:\nanthropic/claude-sonnet-4-6\nopenai/gpt-5.5\n\nopenai/gpt-5.5\n",
        );
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["anthropic/claude-sonnet-4-6", "openai/gpt-5.5"]
        );
    }

    #[test]
    fn claude_model_cache_reads_the_account_extras() {
        let text = r#"{"numStartups":3,"oauthAccount":{"emailAddress":"person@example.com"},"additionalModelOptionsCache":[{"value":"claude-fable-5-1[1m]","label":"Fable","description":"x"},{"value":"bad id","label":"x"},{"label":"no value"}]}"#;
        let models = claude_model_cache(text);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "claude-fable-5-1[1m]");
        assert_eq!(models[0].label, "Fable");
        assert!(claude_model_cache("{}").is_empty());
        assert!(claude_model_cache("garbage").is_empty());
    }

    #[test]
    fn efforts_per_model_follow_the_catalog_rules() {
        let claude = crate::agent_catalog::agent("claude").unwrap();
        let effort = claude.capabilities.as_ref().unwrap().effort.as_ref();
        let all = ["low", "medium", "high", "xhigh", "max"];
        assert_eq!(efforts_for(effort, "default", None), all);
        assert_eq!(efforts_for(effort, "opus", None), all);
        assert_eq!(efforts_for(effort, "claude-opus-5-5", None), all);
        assert_eq!(efforts_for(effort, "claude-fable-5-1[1m]", None), all);
        assert_eq!(efforts_for(effort, "claude-opus-4-7", None), all);
        assert!(efforts_for(effort, "haiku", None).is_empty());
        assert!(efforts_for(effort, "claude-haiku-4-5-20251001", None).is_empty());
        assert_eq!(
            efforts_for(effort, "claude-sonnet-4-6", None),
            ["low", "medium", "high", "max"]
        );
        assert!(efforts_for(effort, "claude-sonnet-4-5", None).is_empty());
        assert!(efforts_for(effort, "claude-opus-4-1-20250805", None).is_empty());
        assert!(efforts_for(effort, "claude-3-opus-20240229", None).is_empty());
        let codex = crate::agent_catalog::agent("codex").unwrap();
        let effort = codex.capabilities.as_ref().unwrap().effort.as_ref();
        let listed = vec![
            "low".to_string(),
            "medium".to_string(),
            "ultra".to_string(),
            "bogus".to_string(),
        ];
        assert_eq!(
            efforts_for(effort, "gpt-5.6-terra", Some(&listed)),
            ["low", "medium", "ultra"]
        );
        assert!(efforts_for(None, "x", None).is_empty());
    }
}
