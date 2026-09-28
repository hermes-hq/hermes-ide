//! The agent catalog, shared with the frontend.
//!
//! Every agent Hermes can start in a terminal is described once, in
//! `src/catalog/agents.json` (schema: `src/catalog/agents.schema.json`,
//! validated by `src/__tests__/agent-catalog.test.ts`). The binary embeds
//! that file, so the launch line (`pty::ai_launch_command`) and the "is it
//! installed" check (`platform::check_ai_cli_availability`) read the same
//! data as the New Session screen. Only the fields the backend needs are
//! deserialised here; the rest is ignored.

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

const CATALOG_JSON: &str = include_str!("../../src/catalog/agents.json");

#[derive(Debug, Deserialize)]
pub struct Catalog {
    pub agents: Vec<Agent>,
}

#[derive(Debug, Deserialize)]
pub struct Agent {
    pub id: String,
    pub name: String,
    /// `stable` (everyone) or `beta` (behind the agentCatalog flag in the UI).
    pub channel: String,
    /// The "Custom agent" entry: the user types the command.
    #[serde(default)]
    pub custom: bool,
    pub terminal: Terminal,
    pub detect: Option<Detect>,
    /// Where the agent reads its instruction files, settings, skills and MCP
    /// servers (`crate::agent_setup`). Absent for the Custom agent.
    #[serde(default)]
    pub setup: Option<Setup>,
}

#[derive(Debug, Deserialize)]
pub struct Setup {
    pub instructions: Instructions,
    pub settings: SetupPaths,
    pub skills: SetupPaths,
    pub mcp: Option<Vec<McpSource>>,
}

#[derive(Debug, Deserialize)]
pub struct Instructions {
    /// Relative to a project folder. `a|b` = the first that exists; `*`
    /// matches file names in one folder.
    pub project: Vec<String>,
    /// `~/`-relative.
    pub global: Vec<String>,
    /// Whether the agent follows `@path` imports inside these files.
    pub imports: bool,
}

#[derive(Debug, Deserialize)]
pub struct SetupPaths {
    pub project: Vec<String>,
    pub global: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct McpSource {
    pub path: String,
    /// `project` or `global`.
    pub scope: String,
    /// `json` (servers under `key`), `toml` (`[key.<name>]` tables) or
    /// `claude_local` (`projects.<folder>.<key>` in `~/.claude.json`).
    pub format: String,
    pub key: String,
}

#[derive(Debug, Deserialize)]
pub struct Terminal {
    /// Starts a new session; every other argument list is appended to it.
    pub argv: Vec<String>,
    /// How to continue a conversation: `by_id` takes `{session_id}`.
    pub resume: Resume,
    /// Arguments that pre-assign the conversation id (`{session_id}`), or
    /// null when the vendor has no such flag (the id is then read from the
    /// agent's first signal).
    #[serde(default)]
    pub new_session_id: Option<Vec<String>>,
    /// Arguments that pass a first prompt (`{prompt}`), or null.
    #[serde(default)]
    pub initial_prompt: Option<Vec<String>>,
    /// How the agent tells Hermes what it is doing, per launch.
    pub signals: Signals,
    /// Permission mode (`default`, `acceptEdits`, ...) -> extra arguments.
    pub permission_flags: HashMap<String, Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct Resume {
    #[serde(default)]
    pub by_id: Option<Vec<String>>,
    #[serde(default)]
    pub latest: Option<Vec<String>>,
    /// How the vendor says the conversation to resume does not exist. Only a
    /// resume that ends this way is replaced by a fresh start; without it a
    /// failed resume is left to the user.
    #[serde(default)]
    pub not_found: Option<NotFound>,
}

#[derive(Debug, Deserialize, Default)]
pub struct NotFound {
    /// Exit codes the vendor uses for it; empty means any code that is not an
    /// interrupt.
    #[serde(default)]
    pub exit_codes: Vec<i32>,
    /// Text the vendor prints for it; one must appear in the terminal.
    #[serde(default)]
    pub output: Vec<String>,
}

/// The per-launch hook setup of an agent (see `pty::launch`). Placeholders
/// in `args` and `env`: `{signals_file}`, `{signals_dir}`, `{hi}`.
#[derive(Debug, Deserialize)]
pub struct Signals {
    /// `settings_file`, `config_flags`, `env_file`, `plugin_dir`,
    /// `worktree_file`, `event_stream` or `none`.
    pub method: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// `worktree_file` only: the hook files, relative to the folder the
    /// agent runs in.
    #[serde(default)]
    pub files: Vec<String>,
    /// Hermes status -> the vendor events that mean it.
    #[serde(default)]
    pub events: HashMap<String, Vec<String>>,
    /// How sure a signal from this agent's hooks is: `exact` (the hook fires
    /// only when the state is real), `signal` (it can fire for a tool that
    /// was already approved) or `guessed` (no hooks at all).
    #[serde(default = "default_confidence")]
    pub confidence: String,
}

fn default_confidence() -> String {
    "guessed".to_string()
}

#[derive(Debug, Deserialize)]
pub struct Detect {
    /// `[binary, args...]`; the binary is what the availability check looks for.
    pub command: Vec<String>,
}

fn parse(json: &str) -> Result<Catalog, String> {
    serde_json::from_str(json).map_err(|e| format!("agent catalog is not valid: {e}"))
}

/// The embedded catalog. Its validity is enforced by tests (here and in the
/// frontend schema test), so a broken file never reaches a build.
pub fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| parse(CATALOG_JSON).expect("embedded agent catalog"))
}

pub fn agent(id: &str) -> Option<&'static Agent> {
    catalog().agents.iter().find(|a| a.id == id)
}

/// Whether the agent is on the `beta` channel (shown only with the
/// agentCatalog flag).
pub fn is_beta(id: &str) -> bool {
    agent(id).is_some_and(|a| a.channel == "beta")
}

/// `(agent id, binary)` for every agent that has a detect command, in
/// catalog order.
pub fn detect_binaries() -> Vec<(&'static str, &'static str)> {
    catalog()
        .agents
        .iter()
        .filter_map(|a| {
            let bin = a.detect.as_ref()?.command.first()?;
            Some((a.id.as_str(), bin.as_str()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_catalog_parses_and_has_the_expected_agents() {
        let ids: Vec<&str> = catalog().agents.iter().map(|a| a.id.as_str()).collect();
        for id in [
            "claude",
            "codex",
            "antigravity",
            "gemini",
            "copilot",
            "opencode",
            "goose",
            "hermes-agent",
            "aider",
            "kiro",
            "custom",
        ] {
            assert!(ids.contains(&id), "catalog is missing {id}: {ids:?}");
        }
    }

    #[test]
    fn only_the_custom_entry_has_no_command() {
        for a in &catalog().agents {
            if a.custom {
                assert!(a.terminal.argv.is_empty());
                assert!(a.detect.is_none());
            } else {
                assert!(!a.terminal.argv.is_empty(), "{} has no argv", a.id);
                assert!(a.detect.is_some(), "{} has no detect command", a.id);
            }
        }
    }

    #[test]
    fn detect_binaries_are_safe_to_put_in_a_shell_script() {
        // platform::build_detection_script interpolates these into `command -v`.
        let bins = detect_binaries();
        assert!(bins.len() >= 10);
        for (id, bin) in bins {
            assert!(
                !bin.is_empty()
                    && bin
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')),
                "{id}: unsafe binary name {bin:?}"
            );
        }
    }

    #[test]
    fn copilot_is_the_new_cli_not_the_retired_gh_extension() {
        let copilot = agent("copilot").unwrap();
        assert_eq!(copilot.terminal.argv, vec!["copilot".to_string()]);
        let bins = detect_binaries();
        assert!(bins.contains(&("copilot", "copilot")));
        assert!(!bins.iter().any(|(_, b)| *b == "gh"));
    }

    /// The frontend preview (buildLaunchPreview) runs the same table, so the
    /// line shown in the New Session screen is the line that gets typed.
    #[test]
    fn launch_lines_match_the_shared_cases() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../src/catalog/launch-cases.json")).unwrap();
        let cases = cases["cases"].as_array().unwrap();
        assert!(cases.len() >= 10);
        for c in cases {
            let s = |k: &str| c[k].as_str().unwrap().to_string();
            let got = crate::pty::ai_launch_command(
                &s("agent"),
                &s("mode"),
                &s("prefix"),
                &s("suffix"),
                &s("command"),
            );
            let want = c["expected"].as_str().map(str::to_string);
            assert_eq!(got, want, "case {c}");
        }
    }

    #[test]
    fn launch_recipes_carry_the_placeholders_pty_launch_fills_in() {
        for a in &catalog().agents {
            if let Some(by_id) = &a.terminal.resume.by_id {
                assert!(
                    by_id.iter().any(|x| x == "{session_id}"),
                    "{}: resume.by_id has no {{session_id}}",
                    a.id
                );
            }
            if let Some(new_id) = &a.terminal.new_session_id {
                assert!(
                    new_id.iter().any(|x| x == "{session_id}"),
                    "{}: new_session_id has no {{session_id}}",
                    a.id
                );
            }
            if let Some(prompt) = &a.terminal.initial_prompt {
                assert!(
                    prompt.iter().any(|x| x == "{prompt}"),
                    "{}: initial_prompt has no {{prompt}}",
                    a.id
                );
            }
        }
        let claude = agent("claude").unwrap();
        assert_eq!(claude.terminal.signals.method, "settings_file");
        assert_eq!(
            claude.terminal.signals.args,
            vec!["--settings", "{signals_file}"]
        );
        assert!(claude.terminal.signals.events.contains_key("session_start"));
        let gemini = agent("gemini").unwrap();
        assert_eq!(gemini.terminal.signals.method, "env_file");
        assert_eq!(
            gemini
                .terminal
                .signals
                .env
                .get("GEMINI_CLI_SYSTEM_DEFAULTS_PATH"),
            Some(&"{signals_file}".to_string())
        );
        assert_eq!(agent("custom").unwrap().terminal.signals.method, "none");
    }

    #[test]
    fn a_broken_catalog_is_rejected() {
        assert!(parse("{}").is_err());
        assert!(parse(r#"{"agents":[{"id":"x"}]}"#).is_err());
        assert!(parse(CATALOG_JSON).is_ok());
    }
}
