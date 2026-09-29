//! Starting an agent through the bundled `hi` helper, and resuming it.
//!
//! Hermes never types a vendor command line into the shell here. It writes a
//! launch file (program, argv, env, cwd) under the app's data folder and
//! types the shell-neutral line `hi run <session-id>`; `hi` (see
//! `src-tauri/hi/`) reads the file and starts the agent. That removes every
//! quoting difference between zsh, bash, fish, PowerShell and cmd.
//!
//! The recipe per agent is the `terminal` block of the agent catalog
//! (`src/catalog/agents.json`, read through `crate::agent_catalog`): how to
//! pre-assign a conversation id, how to resume one, how to pass a first
//! prompt, and how the agent can signal Hermes per launch (Claude: a
//! `SessionStart` hook in a settings file passed with `--settings`; Gemini:
//! a defaults file named by an environment variable). Nothing is written to
//! any vendor's global config. On restore the launch file carries the resume
//! command plus a fresh-start fallback for agents whose catalog entry says
//! how the vendor reports a missing conversation (`resume.not_found`: an
//! exit code and the text it prints). This module watches the terminal
//! output for that text and leaves `hi` a note when it appears; only a resume
//! that ends that way is replaced, so Ctrl-C at a resumed agent's trust
//! prompt keeps the conversation. The fallback prints one line, starts fresh
//! and reports the new id through the signal spool; Hermes keeps the old id
//! until the fresh conversation has actually started.

use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::adapters::now;
use super::models::{AgentStartup, AgentStartupState, Session, SessionPhase, SessionUpdate};
use crate::agent_catalog::Agent;

/// Launch-file format version; `hi` refuses any other.
pub const SPEC_VERSION: u64 = 1;
/// No start signal within this long after the launch line was typed means
/// the agent is most likely sitting at a startup prompt.
pub const STARTUP_PROMPT_GUESS_AFTER: Duration = Duration::from_secs(5);
/// A resume that ends the vendor's "not found" way within this window is a
/// failed resume.
pub const RESUME_FALLBACK_AFTER_MS: u64 = 3000;
const LAUNCH_FILE: &str = "launch.json";
const SIGNALS_FILE: &str = "signals.ndjson";
/// Written (holding the launch's nonce) when the terminal showed the
/// vendor's "conversation not found" text; `hi` needs it to fall back.
const NOT_FOUND_EVIDENCE_FILE: &str = "resume-not-found";
/// How long the terminal output is searched for that text after the launch
/// line was typed (the shell starting, then `hi`, then the vendor's check).
const NOT_FOUND_WATCH_FOR: Duration = Duration::from_secs(30);
/// How much recent output is kept to find text split across reads.
const NOT_FOUND_TAIL_BYTES: usize = 8 * 1024;
const SPOOL_POLL: Duration = Duration::from_millis(250);

// ─── Recipes (the agent catalog) ─────────────────────────────────────

/// The catalog entry of an agent Hermes can start through `hi`: a known
/// agent with a command of its own. The Custom agent has none (the user's
/// command line stays the user's), so it keeps the typed launch.
pub fn recipe_for(provider: &str) -> Option<&'static Agent> {
    let agent = crate::agent_catalog::agent(provider)?;
    if agent.custom || agent.terminal.argv.is_empty() {
        return None;
    }
    Some(agent)
}

/// Replace `{name}` placeholders in an argument template.
fn fill(template: &[String], vars: &[(&str, &str)]) -> Vec<String> {
    template
        .iter()
        .map(|arg| {
            let mut out = arg.clone();
            for (name, value) in vars {
                out = out.replace(&format!("{{{name}}}"), value);
            }
            out
        })
        .collect()
}

// ─── Planning (pure) ─────────────────────────────────────────────────

/// Everything the plan needs; no app handle, so it is unit-testable.
pub struct LaunchInput<'a> {
    pub session_id: &'a str,
    pub provider: &'a str,
    pub permission_mode: &'a str,
    pub custom_prefix: &'a str,
    pub custom_suffix: &'a str,
    pub channels: &'a [String],
    pub cwd: &'a str,
    /// The session's context file, when the session has project context to
    /// hand to the agent on its first prompt.
    pub context_path: Option<&'a str>,
    /// The task the user described in the task launcher (F15), handed to
    /// the agent as its first prompt on a fresh start.
    pub task: Option<&'a str>,
    /// The conversation to resume (a restored session's saved id).
    pub resume_id: Option<&'a str>,
    /// N19: the first prompt of a session started by "Continue in another
    /// agent" / "Duplicate to another agent" (the task and the work so far).
    /// It travels as a launch argument, never typed.
    pub seed_prompt: Option<&'a str>,
    /// N19: the user has a status line of their own configured for this
    /// agent, so Hermes must not set one (the vendor's `rate_limits` then
    /// never reach Hermes, and a limit has no reset time).
    pub user_status_line: bool,
    /// Absolute path of the `hi` helper.
    pub hi: &'a Path,
    /// The session's launch folder (`<app data>/launch/<session id>`).
    pub session_dir: &'a Path,
    /// Pre-assigned conversation id for a fresh start (a UUID v4).
    pub new_session_id: &'a str,
    /// Per-launch secret that `hi` copies into every spool line it writes;
    /// lines without it (an earlier launch of the same session, a stray
    /// process) are ignored.
    pub nonce: &'a str,
    /// A free loopback port and a per-launch password, for an agent that
    /// exposes a local event stream (OpenCode). Unused by the others.
    pub stream_port: u16,
    pub stream_secret: &'a str,
}

/// The launch file `hi run` reads. Field names are the wire format.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LaunchSpec {
    pub v: u64,
    pub session_id: String,
    pub agent: String,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub program: String,
    pub args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback: Option<FallbackSpec>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FallbackSpec {
    pub program: String,
    pub args: Vec<String>,
    pub after_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vendor_session_id: Option<String>,
    pub message: String,
    /// How the vendor says the conversation does not exist; `hi` falls back
    /// only on that.
    pub not_found: NotFoundSpec,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NotFoundSpec {
    /// Empty: any exit code but an interrupt.
    pub exit_codes: Vec<i32>,
    /// Set when the vendor's "not found" text must also have been seen.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence_file: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchPlan {
    pub spec: LaunchSpec,
    /// Extra files to write before the launch (path, contents).
    pub files: Vec<(PathBuf, String)>,
    /// The conversation id Hermes should remember for this session.
    pub vendor_session_id: Option<String>,
    /// True when the main command resumes a saved conversation.
    pub resumes: bool,
    /// True when the agent will send a start signal, so silence means a
    /// startup prompt.
    pub expects_start_signal: bool,
    /// True when the project-context prompt travels as an argument.
    pub context_in_args: bool,
    /// True when the seed prompt (N19) travels as an argument.
    pub seed_in_args: bool,
    /// The nonce every spool line of this launch must carry.
    pub nonce: String,
    /// The vendor's "conversation not found" texts to look for in the
    /// terminal while the resume starts (empty when there is no fallback).
    pub not_found_output: Vec<String>,
    /// Paths written into the session's folder (a Hermes-owned worktree)
    /// that git must ignore, relative to `spec.cwd`.
    pub git_excludes: Vec<String>,
    /// The local event stream to read, for an agent that has one.
    pub stream: Option<StreamSpec>,
    /// How sure a signal from this agent's hooks is (the catalog's
    /// `signals.confidence`).
    pub confidence: String,
    /// True when the agent's stop runs the Done-When checks itself (F27),
    /// so Hermes does not run them again at its turn end.
    pub check_hook: bool,
}

fn split_words(fragment: &str) -> Vec<String> {
    fragment
        .replace(['\n', '\r'], " ")
        .split_whitespace()
        .map(str::to_string)
        .collect()
}

fn context_prompt(context_path: &str) -> String {
    format!("Read the file at {context_path} for project context about the attached workspaces.")
}

/// The first prompt of a fresh start: the launcher's task, then the pointer
/// to the session's context file, or whichever of the two there is. On
/// Windows it is one line, because an agent installed as a `.cmd` shim is
/// started through cmd.exe, which cannot take a line break in an argument.
fn first_prompt(task: Option<&str>, context_path: Option<&str>) -> Option<String> {
    let task = task.map(str::trim).filter(|t| !t.is_empty());
    let text = match (task, context_path) {
        (Some(t), Some(ctx)) => format!("{t}\n\n{}", context_prompt(ctx)),
        (Some(t), None) => t.to_string(),
        (None, Some(ctx)) => context_prompt(ctx),
        (None, None) => return None,
    };
    Some(if cfg!(windows) { one_line(&text) } else { text })
}

/// Line breaks become single spaces.
fn one_line(text: &str) -> String {
    text.split(['\r', '\n'])
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Path as it goes into a hook command string: forward slashes work for
/// cmd.exe, PowerShell and bash alike, and need no escaping inside quotes.
fn hook_path(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// `hi signal --agent <id> [--event <name>]` as one shell command line, for
/// hook formats that only take a command string (Gemini, Antigravity,
/// goose). The quoted path works in sh, bash, PowerShell and cmd.
fn signal_command(hi: &Path, agent_id: &str, event: Option<&str>) -> String {
    let mut cmd = format!("\"{}\" signal --agent {agent_id}", hook_path(hi));
    if let Some(event) = event {
        cmd.push_str(" --event ");
        cmd.push_str(event);
    }
    cmd
}

/// The same call in exec form (no shell at all): what Claude's `args` and
/// Copilot's `exec`/`args` take. Same on every OS, no quoting anywhere.
fn signal_args(agent_id: &str, event: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "signal".to_string(),
        "--agent".to_string(),
        agent_id.to_string(),
    ];
    if let Some(event) = event {
        args.push("--event".to_string());
        args.push(event.to_string());
    }
    args
}

/// The vendor events the catalog lists for `status` that a hook file can
/// name directly (without the `Event:Matcher` part).
fn plain_events<'a>(agent: &'a Agent, status: &str) -> impl Iterator<Item = &'a str> {
    agent
        .terminal
        .signals
        .events
        .get(status)
        .into_iter()
        .flatten()
        .map(String::as_str)
        .filter(|e| !e.contains(':'))
}

/// Every vendor event the catalog names for this agent, with the matchers
/// listed for it (`PreToolUse:AskUserQuestion` -> `PreToolUse` with matcher
/// `AskUserQuestion`). An event listed once without a matcher matches
/// everything (`None`). Sorted, so generated files are stable.
fn catalog_hooks(agent: &Agent) -> BTreeMap<String, Option<Vec<String>>> {
    let mut hooks: BTreeMap<String, Option<Vec<String>>> = BTreeMap::new();
    // `statusLine` (N19) is the status line setting, not a hook event.
    let mut names: Vec<&String> = agent
        .terminal
        .signals
        .events
        .values()
        .flatten()
        .filter(|name| name.split(':').next() != Some(STATUS_LINE_EVENT))
        .collect();
    names.sort();
    for name in names {
        let (event, matcher) = match name.split_once(':') {
            Some((e, m)) => (e.to_string(), Some(m.to_string())),
            None => (name.clone(), None),
        };
        let entry = hooks.entry(event).or_insert_with(|| Some(Vec::new()));
        match (entry.as_mut(), matcher) {
            (Some(list), Some(m)) => {
                if !list.contains(&m) {
                    list.push(m);
                }
            }
            _ => *entry = None,
        }
    }
    hooks
}

/// Hook events whose matcher is a tool name (the only ones where a matcher
/// narrows anything Hermes wants narrowed: every notification is wanted,
/// its type is in the payload).
fn takes_tool_matcher(event: &str) -> bool {
    matches!(event, "PreToolUse" | "PostToolUse" | "PostToolUseFailure")
}

/// Hooks whose answer Claude never waits for: tool completions are frequent
/// and Hermes only counts them.
fn is_async_hook(event: &str) -> bool {
    matches!(
        event,
        "PostToolUse" | "PostToolUseFailure" | "PostToolBatch"
    )
}

/// How long the agent waits for the Done-When Stop hook (F27): the checks'
/// own time budget (`hi`'s default, 600 s) plus room to start and report.
/// The hook runs `hi check --stop-hook`, which refuses the stop while the
/// repository's checks fail.
pub const CHECK_HOOK_TIMEOUT_SECS: u64 = 660;

/// Add one hook group under `event`, after any group already there.
fn push_hook(
    hooks: &mut serde_json::Map<String, serde_json::Value>,
    event: &str,
    hook: serde_json::Value,
) {
    let group = serde_json::json!({ "hooks": [hook] });
    match hooks.get_mut(event) {
        Some(serde_json::Value::Array(groups)) => groups.push(group),
        _ => {
            hooks.insert(event.to_string(), serde_json::json!([group]));
        }
    }
}

/// N19: the catalog's `limited` entries — the vendor events that start,
/// update or end a usage limit — as `(event, matcher)`. They become hooks
/// through [`catalog_hooks`] like every other status's events; the
/// pseudo-event `statusLine` is the status line command instead (its input
/// carries `rate_limits`).
fn limit_events(agent: &Agent) -> impl Iterator<Item = (&str, Option<&str>)> {
    agent
        .terminal
        .signals
        .events
        .get("limited")
        .into_iter()
        .flatten()
        .map(|e| match e.split_once(':') {
            Some((event, matcher)) => (event, Some(matcher)),
            None => (e.as_str(), None),
        })
}

/// The catalog's pseudo-event for the status line command (N19).
const STATUS_LINE_EVENT: &str = "statusLine";

/// Whether the agent reports its limits through its status line input.
fn limits_via_status_line(agent: &Agent) -> bool {
    limit_events(agent).any(|(event, _)| event == STATUS_LINE_EVENT)
}

/// The per-launch hook file for the `settings_file` method (Claude's
/// settings shape): hooks, so it merges on top of the user's own settings
/// without replacing anything — plus, for N19, a status line that reports
/// the vendor's `rate_limits`, but only when `status_line` says the user has
/// none of their own (a status line is one setting, not a list: ours would
/// replace theirs).
pub fn settings_file_json(agent: &Agent, hi: &Path, status_line: bool) -> String {
    let mut hooks = serde_json::Map::new();
    for (event, matchers) in catalog_hooks(agent) {
        let mut hook = serde_json::json!({
            "type": "command",
            "command": hook_path(hi),
            "args": signal_args(&agent.id, None),
            "timeout": 5
        });
        if is_async_hook(&event) {
            hook["async"] = serde_json::Value::Bool(true);
        }
        let mut entry = serde_json::json!({ "hooks": [hook] });
        if let Some(list) = matchers.filter(|_| takes_tool_matcher(&event)) {
            entry["matcher"] = serde_json::Value::String(list.join("|"));
        }
        hooks.insert(event, serde_json::json!([entry]));
    }
    if let Some(event) = agent.terminal.signals.check_hook.as_deref() {
        push_hook(
            &mut hooks,
            event,
            serde_json::json!({
                "type": "command",
                "command": hook_path(hi),
                "args": ["check", "--stop-hook"],
                "timeout": CHECK_HOOK_TIMEOUT_SECS
            }),
        );
    }
    // N19: the `limited` events are hooks like any other (catalog_hooks);
    // the status line is one setting, set only when the user has none.
    let mut settings = serde_json::json!({ "hooks": hooks });
    if status_line && limits_via_status_line(agent) {
        settings["statusLine"] = serde_json::json!({
            "type": "command",
            "command": signal_command(hi, &agent.id, Some("StatusLine")),
        });
    }
    serde_json::to_string_pretty(&settings).unwrap_or_default()
}

/// Whether any of these settings files sets a status line (N19). A file
/// that is missing or unreadable sets none.
pub fn settings_set_status_line(files: &[PathBuf]) -> bool {
    files.iter().any(|f| {
        std::fs::read_to_string(f)
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .is_some_and(|v| v.get("statusLine").is_some_and(|s| !s.is_null()))
    })
}

/// The settings files where a user may have set Claude's status line: their
/// own (`$CLAUDE_CONFIG_DIR` or `~/.claude`) and the project's.
fn claude_settings_files(cwd: &str) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let config_dir = std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .or_else(|| crate::platform::home_dir().map(|h| h.join(".claude")));
    if let Some(dir) = config_dir {
        files.push(dir.join("settings.json"));
    }
    let project = Path::new(cwd).join(".claude");
    files.push(project.join("settings.json"));
    files.push(project.join("settings.local.json"));
    files
}

/// The per-launch defaults file for the `env_file` method (Gemini's
/// settings shape, lowest precedence). Its hooks run in a sanitized
/// environment, so the Hermes variables travel in each hook's `env`. The
/// same file switches Gemini's own terminal notifications on (OSC 9), the
/// fallback Hermes reads from the terminal.
pub fn env_file_json(agent: &Agent, hi: &Path, env: &BTreeMap<String, String>) -> String {
    let hook_env: serde_json::Map<String, serde_json::Value> = env
        .iter()
        .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
        .collect();
    let mut hooks = serde_json::Map::new();
    for event in catalog_hooks(agent).keys() {
        hooks.insert(
            event.to_string(),
            serde_json::json!([{ "hooks": [{
                "name": format!("hermes-{}", event.to_lowercase()),
                "type": "command",
                "command": signal_command(hi, &agent.id, Some(event)),
                "env": hook_env,
                "timeout": 5000
            }]}]),
        );
    }
    serde_json::to_string_pretty(&serde_json::json!({
        "general": { "enableNotifications": true, "notificationMethod": "osc9" },
        "hooks": hooks
    }))
    .unwrap_or_default()
}

/// The per-launch plugin folder's `hooks.json` for the `plugin_dir` method
/// (Copilot's shape): exec form, with the Hermes variables in each hook's
/// `env`.
pub fn plugin_hooks_json(agent: &Agent, hi: &Path, env: &BTreeMap<String, String>) -> String {
    let hook_env: serde_json::Map<String, serde_json::Value> = env
        .iter()
        .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
        .collect();
    let mut hooks = serde_json::Map::new();
    for event in catalog_hooks(agent).keys() {
        hooks.insert(
            event.to_string(),
            serde_json::json!([{
                "type": "command",
                "exec": hook_path(hi),
                "args": signal_args(&agent.id, Some(event)),
                "env": hook_env,
                "timeoutSec": 5
            }]),
        );
    }
    serde_json::to_string_pretty(&serde_json::json!({ "version": 1, "hooks": hooks }))
        .unwrap_or_default()
}

/// The hook entry Hermes adds to a file inside its own worktree
/// (`worktree_file` method): Antigravity's `.agents/hooks.json` keyed by
/// hook name, or the Claude-like `{"hooks": {...}}` shape goose plugins use.
/// `existing` is the file's current content, kept as it is: only the
/// `hermes-signal` entry is added or replaced.
pub fn worktree_hooks_json(agent: &Agent, hi: &Path, existing: Option<&str>) -> String {
    let command = |event: &str| {
        serde_json::json!({
            "type": "command",
            "command": signal_command(hi, &agent.id, Some(event)),
            "timeout": 5
        })
    };
    let mut events = serde_json::Map::new();
    for event in catalog_hooks(agent).keys() {
        events.insert(
            event.to_string(),
            serde_json::json!([{ "hooks": [command(event)] }]),
        );
    }
    let mut root = existing
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));
    if agent.id == "antigravity" {
        let mut entry = serde_json::Map::new();
        entry.insert("enabled".to_string(), serde_json::Value::Bool(true));
        entry.extend(events);
        root["hermes-signal"] = serde_json::Value::Object(entry);
    } else {
        let hooks = root
            .get_mut("hooks")
            .and_then(serde_json::Value::as_object_mut)
            .map(|h| {
                h.extend(events.clone());
                serde_json::Value::Object(h.clone())
            })
            .unwrap_or(serde_json::Value::Object(events));
        root["hooks"] = hooks;
    }
    serde_json::to_string_pretty(&root).unwrap_or_default()
}

/// The local event stream an agent exposes for one launch (OpenCode's
/// server on a loopback port, protected by a per-launch password).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamSpec {
    pub port: u16,
    pub secret: String,
}

/// What the catalog's `signals` block becomes for one launch.
struct SignalSetup {
    args: Vec<String>,
    env: BTreeMap<String, String>,
    files: Vec<(PathBuf, String)>,
    /// Paths (relative to the session's folder) written into a Hermes-owned
    /// worktree, to be kept out of git through `info/exclude`.
    git_excludes: Vec<String>,
    expects_start_signal: bool,
    stream: Option<StreamSpec>,
    check_hook: bool,
}

fn signal_setup(
    agent: &Agent,
    hi: &Path,
    session_dir: &Path,
    cwd: &Path,
    hermes_env: &BTreeMap<String, String>,
    stream: (u16, &str),
    status_line: bool,
) -> SignalSetup {
    let signals = &agent.terminal.signals;
    let has_start = plain_events(agent, "session_start").next().is_some();
    let mut setup = SignalSetup {
        args: Vec::new(),
        env: BTreeMap::new(),
        files: Vec::new(),
        git_excludes: Vec::new(),
        expects_start_signal: false,
        stream: None,
        check_hook: false,
    };
    let mut signals_dir = session_dir.to_path_buf();
    let file = match signals.method.as_str() {
        "settings_file" => Some((
            session_dir.join(format!("{}.settings.json", agent.id)),
            settings_file_json(agent, hi, status_line),
        )),
        "env_file" => Some((
            session_dir.join(format!("{}.defaults.json", agent.id)),
            env_file_json(agent, hi, hermes_env),
        )),
        "plugin_dir" => {
            signals_dir = session_dir.join(format!("{}-plugin", agent.id));
            Some((
                signals_dir.join("hooks.json"),
                plugin_hooks_json(agent, hi, hermes_env),
            ))
        }
        // Config flags carry `{hi}` and need no file.
        "config_flags" => None,
        // The agent has no per-launch flag at all: the hook file goes into
        // the folder it runs in, but only when that folder is a worktree
        // Hermes made (never into the user's own checkout), and git is told
        // to ignore it.
        "worktree_file" => {
            if crate::git::worktree::is_hermes_worktree_path(&cwd.to_string_lossy()) {
                for rel in &signals.files {
                    let path = cwd.join(rel);
                    let existing = std::fs::read_to_string(&path).ok();
                    setup
                        .files
                        .push((path, worktree_hooks_json(agent, hi, existing.as_deref())));
                    // Exclude the plugin's whole folder when it has one.
                    let exclude = match rel.find("/hooks/") {
                        Some(at) => format!("{}/", &rel[..at]),
                        None => rel.clone(),
                    };
                    setup.git_excludes.push(exclude);
                }
            }
            None
        }
        "event_stream" => {
            setup.stream = Some(StreamSpec {
                port: stream.0,
                secret: stream.1.to_string(),
            });
            None
        }
        _ => return setup,
    };
    let file_str = file
        .as_ref()
        .map(|(p, _)| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let dir_str = signals_dir.to_string_lossy().to_string();
    let hi_str = hook_path(hi);
    let port_str = stream.0.to_string();
    let vars: [(&str, &str); 5] = [
        ("signals_file", file_str.as_str()),
        ("signals_dir", dir_str.as_str()),
        ("hi", hi_str.as_str()),
        ("port", port_str.as_str()),
        ("secret", stream.1),
    ];
    setup.args = fill(&signals.args, &vars);
    for (k, v) in &signals.env {
        setup
            .env
            .insert(k.clone(), fill(std::slice::from_ref(v), &vars).remove(0));
    }
    if let Some(f) = file {
        setup.files.push(f);
        // Only a hook file we wrote can carry the start hook.
        setup.expects_start_signal = has_start;
        // ...and the Done-When Stop hook (only the settings file has one).
        setup.check_hook = signals.method == "settings_file" && signals.check_hook.is_some();
    }
    setup
}

// ─── Claude over SSH: in-band markers ────────────────────────────────

/// The terminal marker a hook makes Claude print on the remote host, where
/// there is no `hi`: an OSC 777 notification the PTY parser recognises and
/// verifies by nonce. `OSC 777 ; notify ; hermes-signal ; v1:<nonce>:<event> BEL`.
pub fn ssh_marker_sequence(nonce: &str, event: &str) -> String {
    format!("\u{1b}]777;notify;hermes-signal;v1:{nonce}:{event}\u{7}")
}

/// Claude's settings for a session over SSH, as a JSON string for
/// `--settings`: hooks that print the marker (exec form: `printf %s <json>`,
/// so nothing passes through a shell) for the events Hermes reads.
pub fn ssh_settings_json(nonce: &str) -> String {
    let hook = |event: &str| {
        let output = serde_json::json!({ "terminalSequence": ssh_marker_sequence(nonce, event) });
        serde_json::json!({
            "type": "command",
            "command": "printf",
            "args": ["%s", output.to_string()],
            "timeout": 5
        })
    };
    let plain = |event: &str| serde_json::json!([{ "hooks": [hook(event)] }]);
    let hooks = serde_json::json!({
        "SessionStart": plain("SessionStart"),
        "UserPromptSubmit": plain("UserPromptSubmit"),
        "PermissionRequest": plain("PermissionRequest"),
        "PreToolUse": [
            { "matcher": "AskUserQuestion", "hooks": [hook("AskUserQuestion")] },
            { "matcher": "ExitPlanMode", "hooks": [hook("ExitPlanMode")] }
        ],
        "Stop": plain("Stop"),
        "StopFailure": plain("StopFailure"),
        "SessionEnd": plain("SessionEnd")
    });
    serde_json::json!({ "hooks": hooks }).to_string()
}

/// `json` as one double-quoted argument for the remote login shell. Double
/// quotes are the one quoting bash, zsh and fish agree on: `\"` and `\\`
/// are the escapes, `$` and a backtick are escaped so nothing expands.
pub fn ssh_settings_argument(json: &str) -> String {
    let mut out = String::with_capacity(json.len() + 2);
    out.push('"');
    for c in json.chars() {
        match c {
            '"' | '\\' | '$' | '`' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The `--settings` argument for a Claude session over SSH (the flag on),
/// or None for anything else. Nothing is written anywhere: the settings
/// travel on the command line.
pub(crate) fn ssh_signal_args(s: &Session) -> Option<(String, String)> {
    if !s.launch_helper || s.ssh_info.is_none() || s.ai_provider.as_deref() != Some("claude") {
        return None;
    }
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let arg = format!(
        "--settings {}",
        ssh_settings_argument(&ssh_settings_json(&nonce))
    );
    Some((arg, nonce))
}

/// Build the launch plan for a session, or None when the provider has no
/// recipe (the caller then falls back to the typed vendor line).
pub fn plan_launch(input: &LaunchInput<'_>) -> Option<LaunchPlan> {
    let agent = recipe_for(input.provider)?;
    let terminal = &agent.terminal;
    let prefix = split_words(input.custom_prefix);
    let suffix = split_words(input.custom_suffix);
    let permission: Vec<String> = terminal
        .permission_flags
        .get(input.permission_mode)
        .cloned()
        .unwrap_or_default();

    // The command head: an optional wrapper (caffeinate, nice, wsl) then the
    // agent program and its fixed arguments.
    let (program, head): (String, Vec<String>) = match prefix.split_first() {
        Some((first, rest)) => {
            let mut head: Vec<String> = rest.to_vec();
            head.push(terminal.argv[0].clone());
            (first.clone(), head)
        }
        None => (terminal.argv[0].clone(), Vec::new()),
    };
    let base: Vec<String> = terminal.argv[1..].to_vec();

    let mut env = BTreeMap::new();
    env.insert(
        "HERMES_SESSION_ID".to_string(),
        input.session_id.to_string(),
    );
    env.insert("HERMES_AGENT".to_string(), agent.id.clone());
    env.insert("HERMES_SIGNAL_NONCE".to_string(), input.nonce.to_string());
    env.insert(
        "HERMES_SIGNAL_FILE".to_string(),
        input
            .session_dir
            .join(SIGNALS_FILE)
            .to_string_lossy()
            .to_string(),
    );
    let signals = signal_setup(
        agent,
        input.hi,
        input.session_dir,
        Path::new(input.cwd),
        &env,
        (input.stream_port, input.stream_secret),
        !input.user_status_line,
    );
    env.extend(signals.env.iter().map(|(k, v)| (k.clone(), v.clone())));

    // Claude reads a positional argument after --channels as another
    // channel, so channels go last (after the prompt).
    let channel_args: Vec<String> = if agent.id == "claude" {
        input
            .channels
            .iter()
            .flat_map(|c| ["--channels".to_string(), c.clone()])
            .collect()
    } else {
        Vec::new()
    };

    // A fresh conversation, with the id pre-assigned where the vendor allows.
    let fresh_id = terminal
        .new_session_id
        .as_ref()
        .map(|_| input.new_session_id.to_string());
    // The task of the first start: a handoff's seed (N19) or the task
    // launcher's task (F15); both when both are set, the seed first.
    let seed = input.seed_prompt.map(str::trim).filter(|p| !p.is_empty());
    let task = input.task.map(str::trim).filter(|t| !t.is_empty());
    let task_text = match (seed, task) {
        (Some(seed), Some(task)) => Some(format!("{seed}\n\n{task}")),
        (seed, task) => seed.or(task).map(str::to_string),
    };
    let prompt_args: Vec<String> = match (
        &terminal.initial_prompt,
        first_prompt(task_text.as_deref(), input.context_path),
    ) {
        (Some(template), Some(prompt)) => fill(template, &[("prompt", &prompt)]),
        _ => Vec::new(),
    };
    let context_in_args = !prompt_args.is_empty() && input.context_path.is_some();
    let seed_in_args = !prompt_args.is_empty() && seed.is_some();
    let fresh_args = {
        let mut args = head.clone();
        args.extend(base.iter().cloned());
        if let (Some(template), Some(id)) = (&terminal.new_session_id, fresh_id.as_deref()) {
            args.extend(fill(template, &[("session_id", id)]));
        }
        args.extend(permission.iter().cloned());
        args.extend(signals.args.iter().cloned());
        args.extend(prompt_args.iter().cloned());
        args.extend(channel_args.iter().cloned());
        args.extend(suffix.iter().cloned());
        args
    };

    let resume = match (input.resume_id, &terminal.resume.by_id) {
        (Some(id), Some(template)) if !id.is_empty() => {
            Some((fill(template, &[("session_id", id)]), id))
        }
        _ => None,
    };

    let evidence_file = input
        .session_dir
        .join(NOT_FOUND_EVIDENCE_FILE)
        .to_string_lossy()
        .to_string();
    let not_found = terminal.resume.not_found.as_ref().map(|nf| NotFoundSpec {
        exit_codes: nf.exit_codes.clone(),
        evidence_file: (!nf.output.is_empty()).then(|| evidence_file.clone()),
    });
    let (args, fallback, vendor_session_id, resumes) = match resume {
        Some((resume_args, id)) => {
            let mut args = head.clone();
            // `codex resume <id> --sandbox ...`, `goose session --resume
            // --session-id <id>`: the resume words follow the command.
            args.extend(base.iter().cloned());
            args.extend(resume_args);
            args.extend(permission.iter().cloned());
            args.extend(signals.args.iter().cloned());
            args.extend(channel_args.iter().cloned());
            args.extend(suffix.iter().cloned());
            // Only a vendor that says how it reports a missing conversation
            // gets a fallback: an early exit alone (Ctrl-C at a trust
            // prompt) must never cost the user the conversation.
            let fallback = not_found.map(|not_found| FallbackSpec {
                program: program.clone(),
                args: fresh_args.clone(),
                after_ms: RESUME_FALLBACK_AFTER_MS,
                vendor_session_id: fresh_id.clone(),
                message: "could not resume the previous conversation; starting a new one"
                    .to_string(),
                not_found,
            });
            (args, fallback, Some(id.to_string()), true)
        }
        None => (fresh_args, None, fresh_id, false),
    };

    let not_found_output = match (&fallback, &terminal.resume.not_found) {
        (Some(fb), Some(nf)) if fb.not_found.evidence_file.is_some() => nf.output.clone(),
        _ => Vec::new(),
    };
    Some(LaunchPlan {
        spec: LaunchSpec {
            v: SPEC_VERSION,
            session_id: input.session_id.to_string(),
            agent: agent.id.clone(),
            cwd: input.cwd.to_string(),
            env,
            program,
            args,
            fallback,
        },
        files: signals.files,
        vendor_session_id,
        resumes,
        expects_start_signal: signals.expects_start_signal,
        // A resumed conversation already has its context; the prompt is
        // only on the fresh command (which the fallback also carries).
        context_in_args: context_in_args && !resumes,
        seed_in_args: seed_in_args && !resumes,
        nonce: input.nonce.to_string(),
        not_found_output,
        git_excludes: signals.git_excludes,
        stream: signals.stream,
        confidence: agent.terminal.signals.confidence.clone(),
        check_hook: signals.check_hook,
    })
}

/// Keep the hook files Hermes wrote into its own worktree out of git:
/// append each pattern to `<git common dir>/info/exclude` unless it is
/// there already. The user's tracked files and `.gitignore` are untouched.
pub fn add_git_excludes(cwd: &Path, patterns: &[String]) -> std::io::Result<()> {
    if patterns.is_empty() {
        return Ok(());
    }
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(["rev-parse", "--git-common-dir"])
        .output()?;
    if !out.status.success() {
        return Err(std::io::Error::other("not a git repository"));
    }
    let common = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let common = if Path::new(&common).is_absolute() {
        PathBuf::from(common)
    } else {
        cwd.join(common)
    };
    let info = common.join("info");
    std::fs::create_dir_all(&info)?;
    let exclude = info.join("exclude");
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    let present: std::collections::HashSet<&str> = existing.lines().map(str::trim).collect();
    let mut text = existing.clone();
    for pattern in patterns {
        if present.contains(pattern.as_str()) {
            continue;
        }
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(pattern);
        text.push('\n');
    }
    if text != existing {
        std::fs::write(&exclude, text)?;
    }
    Ok(())
}

// ─── Locations ───────────────────────────────────────────────────────

fn hi_file_name() -> &'static str {
    if cfg!(windows) {
        "hi.exe"
    } else {
        "hi"
    }
}

/// Where the bundled `hi` helper is: next to the app binary, or in the
/// app's resource folder. None when this build ships without it.
pub fn hi_path<R: tauri::Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let name = hi_file_name();
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    if let Ok(resources) = app.path().resource_dir() {
        // The Windows and Linux bundles carry it as the resource helpers/hi
        // (tauri.<platform>.conf.json).
        for candidate in [resources.join("helpers").join(name), resources.join(name)] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// `<app data>/launch`: one sub-folder per session with its launch file,
/// generated settings and signal spool. Handed to every terminal as
/// `HERMES_LAUNCH_DIR`.
pub fn launch_dir<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(crate::instance::app_data_dir(app)?.join("launch"))
}

/// Every launch writes its session's folder afresh (a restored session keeps
/// its id, and gets a new launch file and a new nonce), so whatever is in
/// the launch folder at startup belongs to the previous run and goes.
///
/// Sessions the session host kept running (`keep`) are the exception: their
/// agent is still writing signals into its folder.
pub fn clear_launch_dir<R: tauri::Runtime>(app: &AppHandle<R>, keep: &[String]) {
    if let Ok(dir) = launch_dir(app) {
        clear_dir_except(&dir, keep);
    }
}

fn clear_dir_except(dir: &Path, keep: &[String]) {
    if !dir.is_dir() {
        return;
    }
    if keep.is_empty() {
        if let Err(e) = std::fs::remove_dir_all(dir) {
            log::warn!("[LAUNCH] could not clear {}: {}", dir.display(), e);
        }
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if keep.iter().any(|k| k == &name) {
            continue;
        }
        let path = entry.path();
        let removed = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        if let Err(e) = removed {
            log::warn!("[LAUNCH] could not remove {}: {}", path.display(), e);
        }
    }
}

pub fn remove_session_files<R: tauri::Runtime>(app: &AppHandle<R>, session_id: &str) {
    if let Ok(dir) = launch_dir(app) {
        let session_dir = dir.join(session_id);
        if session_dir.is_dir() {
            let _ = std::fs::remove_dir_all(&session_dir);
        }
    }
}

// ─── Runtime ─────────────────────────────────────────────────────────

/// What the caller types and watches after `prepare_helper_launch`.
pub(crate) struct PreparedLaunch {
    /// The shell-neutral line to type: `hi run <session id>`.
    pub line: String,
    pub context_in_args: bool,
    pub watch: SignalWatch,
}

/// Everything the spool watcher needs for one launch.
#[derive(Debug, Clone)]
pub(crate) struct SignalWatch {
    pub session_dir: PathBuf,
    pub expects_start_signal: bool,
    /// The nonce every spool line of this launch must carry.
    pub nonce: String,
    /// Catalog agent id, for the events' `source`.
    pub agent: String,
    /// How sure a hook signal from this agent is.
    pub confidence: crate::contract::Confidence,
    pub stream: Option<StreamSpec>,
}

fn confidence_of(name: &str) -> crate::contract::Confidence {
    match name {
        "exact" => crate::contract::Confidence::Exact,
        "signal" => crate::contract::Confidence::Signal,
        _ => crate::contract::Confidence::Guessed,
    }
}

/// A loopback port nothing listens on right now, for an agent's local
/// event stream. 0 when none could be found (the agent then picks its own,
/// and Hermes reads nothing).
fn free_loopback_port() -> u16 {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(0)
}

/// Write the launch file for a session and return the line to type, or None
/// when the helper path does not apply (flag off, SSH, no recipe, no `hi`),
/// in which case the caller types the vendor command as before.
///
/// Mutates the session: records the pre-assigned or resumed conversation id
/// and marks the agent as launching.
pub(crate) fn prepare_helper_launch(app: &AppHandle, s: &mut Session) -> Option<PreparedLaunch> {
    if !s.launch_helper || s.ssh_info.is_some() {
        return None;
    }
    let provider = s.ai_provider.clone()?;
    let agent = recipe_for(&provider)?;
    let Some(hi) = hi_path(app) else {
        log::warn!(
            "[LAUNCH] hi helper not found next to the app; typing the {} command instead",
            provider
        );
        return None;
    };
    let session_dir = launch_dir(app).ok()?.join(&s.id);
    let context_path = if s.has_initial_context {
        crate::project::attunement::session_context_path(app, &s.id)
            .ok()
            .map(|p| p.to_string_lossy().to_string())
    } else {
        None
    };
    let new_session_id = uuid::Uuid::new_v4().to_string();
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let stream_secret = uuid::Uuid::new_v4().simple().to_string();
    let plan = plan_launch(&LaunchInput {
        session_id: &s.id,
        provider: &provider,
        permission_mode: &s.permission_mode,
        custom_prefix: &s.custom_prefix,
        custom_suffix: &s.custom_suffix,
        channels: &s.channels,
        cwd: &s.working_directory,
        context_path: context_path.as_deref(),
        task: s.task_prompt.as_deref(),
        resume_id: s.vendor_session_id.as_deref(),
        seed_prompt: s.seed_prompt.as_deref(),
        user_status_line: limits_via_status_line(agent)
            && settings_set_status_line(&claude_settings_files(&s.working_directory)),
        hi: &hi,
        session_dir: &session_dir,
        new_session_id: &new_session_id,
        nonce: &nonce,
        stream_port: free_loopback_port(),
        stream_secret: &stream_secret,
    })?;

    if let Err(e) = write_plan(&session_dir, &plan) {
        log::warn!(
            "[LAUNCH] could not write the launch file for {}: {}; typing the {} command instead",
            s.id,
            e,
            provider
        );
        return None;
    }
    log::info!(
        "[LAUNCH] {} → hi run (agent {}, {}{})",
        s.id,
        provider,
        if plan.resumes { "resume " } else { "new" },
        plan.vendor_session_id.as_deref().unwrap_or("")
    );
    let evidence = session_dir.join(NOT_FOUND_EVIDENCE_FILE);
    let _ = std::fs::remove_file(&evidence);
    if plan.not_found_output.is_empty() {
        end_output_watch(&s.id);
    } else {
        start_output_watch(&s.id, &plan.not_found_output, evidence, &plan.nonce);
    }
    if s.seed_prompt.is_some() && !plan.seed_in_args {
        log::warn!(
            "[LAUNCH] {}: {} takes no first prompt, so the handoff task was not passed (it is never typed)",
            s.id,
            provider
        );
    }
    // The seed is for this session's first start only; it now lives in the
    // launch file.
    s.seed_prompt = None;
    s.vendor_session_id = plan.vendor_session_id.clone();
    s.signal_nonce = Some(plan.nonce.clone());
    s.agent_startup = Some(AgentStartup {
        state: AgentStartupState::Launching,
        since: now(),
        confidence: "exact".to_string(),
        detail: plan
            .resumes
            .then(|| "resuming the previous conversation".to_string()),
    });
    crate::done_when::set_hook(app, &s.id, plan.check_hook);
    Some(PreparedLaunch {
        line: format!("hi run {}", s.id),
        context_in_args: plan.context_in_args,
        watch: SignalWatch {
            session_dir,
            expects_start_signal: plan.expects_start_signal,
            nonce: plan.nonce,
            agent: plan.spec.agent.clone(),
            confidence: confidence_of(&plan.confidence),
            stream: plan.stream,
        },
    })
}

/// A launcher task (F15) the typed vendor command cannot carry: the helper
/// launch fell through (no `hi` next to the app, no recipe, the launch file
/// not written), so without this the task would be lost silently. Only for
/// agents the catalog says take a first prompt; for the others the task
/// launcher already put the task on the clipboard. Taken, so it is reported
/// once.
pub(crate) fn take_undelivered_task(s: &mut Session) -> Option<String> {
    let task = s.task_prompt.take()?;
    let provider = s.ai_provider.as_deref()?;
    crate::agent_catalog::agent(provider)?
        .terminal
        .initial_prompt
        .as_ref()?;
    Some(task)
}

fn write_plan(session_dir: &Path, plan: &LaunchPlan) -> std::io::Result<()> {
    std::fs::create_dir_all(session_dir)?;
    for (path, contents) in &plan.files {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, contents)?;
    }
    if !plan.git_excludes.is_empty() {
        if let Err(e) = add_git_excludes(Path::new(&plan.spec.cwd), &plan.git_excludes) {
            log::warn!(
                "[LAUNCH] could not exclude the hook files from git in {}: {}",
                plan.spec.cwd,
                e
            );
        }
    }
    let json = serde_json::to_string_pretty(&plan.spec)
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    std::fs::write(session_dir.join(LAUNCH_FILE), json)
}

// ─── The vendor's "conversation not found" text ──────────────────────

/// Terminal text reduced to what matching needs: escape sequences (colours,
/// cursor moves, titles) removed, every blank and control character dropped,
/// lower case. A message the terminal wrapped, coloured or redrew with
/// cursor moves between its words still matches its catalog text.
pub fn squash(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.next() {
                // CSI: parameters up to a final byte.
                Some('[') => {
                    for n in chars.by_ref() {
                        if ('\x40'..='\x7e').contains(&n) {
                            break;
                        }
                    }
                }
                // OSC, DCS, APC, PM: up to BEL or ESC \.
                Some(']') | Some('P') | Some('_') | Some('^') => {
                    while let Some(n) = chars.next() {
                        if n == '\x07' {
                            break;
                        }
                        if n == '\x1b' {
                            chars.next();
                            break;
                        }
                    }
                }
                // Character-set designations carry one more character.
                Some('(') | Some(')') | Some('*') | Some('+') => {
                    chars.next();
                }
                _ => {}
            }
            continue;
        }
        if c.is_whitespace() || c.is_control() {
            continue;
        }
        out.extend(c.to_lowercase());
    }
    out
}

/// Whether `output` shows one of the vendor's "not found" texts.
pub fn shows_not_found(output: &str, patterns: &[String]) -> bool {
    let seen = squash(output);
    patterns.iter().any(|p| {
        let p = squash(p);
        !p.is_empty() && seen.contains(&p)
    })
}

/// A resume whose terminal output is being searched for the vendor's "not
/// found" text.
struct OutputWatch {
    patterns: Vec<String>,
    evidence: PathBuf,
    nonce: String,
    tail: Vec<u8>,
    until: Instant,
}

fn output_watches() -> &'static StdMutex<HashMap<String, OutputWatch>> {
    static WATCHES: OnceLock<StdMutex<HashMap<String, OutputWatch>>> = OnceLock::new();
    WATCHES.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn start_output_watch(session_id: &str, patterns: &[String], evidence: PathBuf, nonce: &str) {
    if let Ok(mut w) = output_watches().lock() {
        w.insert(
            session_id.to_string(),
            OutputWatch {
                patterns: patterns.to_vec(),
                evidence,
                nonce: nonce.to_string(),
                tail: Vec::new(),
                until: Instant::now() + NOT_FOUND_WATCH_FOR,
            },
        );
    }
}

fn end_output_watch(session_id: &str) {
    if let Ok(mut w) = output_watches().lock() {
        w.remove(session_id);
    }
}

/// Feed a session's terminal output (called for every read of its PTY).
/// While its resume is starting, look for the vendor's "not found" text and,
/// when it shows, write the evidence `hi` waits for.
pub(crate) fn observe_output(session_id: &str, data: &[u8]) {
    let Ok(mut watches) = output_watches().lock() else {
        return;
    };
    if watches.is_empty() {
        return;
    }
    let Some(watch) = watches.get_mut(session_id) else {
        return;
    };
    if Instant::now() > watch.until {
        watches.remove(session_id);
        return;
    }
    watch.tail.extend_from_slice(data);
    if watch.tail.len() > NOT_FOUND_TAIL_BYTES {
        let cut = watch.tail.len() - NOT_FOUND_TAIL_BYTES;
        watch.tail.drain(..cut);
    }
    if !shows_not_found(&String::from_utf8_lossy(&watch.tail), &watch.patterns) {
        return;
    }
    match std::fs::write(&watch.evidence, format!("{}\n", watch.nonce)) {
        Ok(()) => log::info!(
            "[LAUNCH] {} the vendor says the conversation to resume does not exist",
            session_id
        ),
        Err(e) => log::warn!(
            "[LAUNCH] {} could not note the missing conversation for hi: {}",
            session_id,
            e
        ),
    }
    watches.remove(session_id);
}

/// A parsed spool line; only the events this module acts on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpoolEvent {
    Started {
        vendor_session_id: Option<String>,
    },
    ResumeFallback {
        vendor_session_id: Option<String>,
    },
    /// The fresh agent `hi` started after a failed resume is still running
    /// past the quick-failure window.
    FallbackRunning,
    Ended,
    /// `hi run` itself reporting that the agent process is gone (it is the
    /// agent's parent, so this comes even when no SessionEnd hook ran: a
    /// declined trust prompt, Ctrl-C at a prompt, a command not found).
    Exited {
        exit_code: i64,
        error: Option<String>,
    },
    /// A Done-When check ran inside the agent (its Stop hook, or `hi check`
    /// typed by the agent): the report, for `crate::done_when`.
    Check(serde_json::Value),
    Other,
}

/// Parse one spool line. Only lines that carry this launch's `nonce` count;
/// anything else (a line from an earlier launch of the same session, or a
/// stray writer) is None, like a line that is not JSON.
pub fn parse_spool_line(line: &str, nonce: &str) -> Option<SpoolEvent> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("nonce").and_then(|n| n.as_str()) != Some(nonce) {
        return None;
    }
    let event = v.get("event")?.as_str()?;
    let payload = v.get("payload");
    let payload_str = |key: &str| {
        payload
            .and_then(|p| p.get(key))
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    Some(match event {
        "SessionStart" => SpoolEvent::Started {
            vendor_session_id: payload_str("session_id")
                .or_else(|| payload_str("sessionId"))
                .or_else(|| payload_str("thread-id"))
                .or_else(|| payload_str("thread_id")),
        },
        "hermes.resume_fallback" => SpoolEvent::ResumeFallback {
            vendor_session_id: payload_str("vendor_session_id"),
        },
        "hermes.fallback_running" => SpoolEvent::FallbackRunning,
        "SessionEnd" => SpoolEvent::Ended,
        "hermes.exited" => SpoolEvent::Exited {
            exit_code: payload
                .and_then(|p| p.get("exit_code"))
                .and_then(|x| x.as_i64())
                .unwrap_or(-1),
            error: payload_str("error"),
        },
        "hermes.check" => match payload {
            Some(p @ serde_json::Value::Object(_)) => SpoolEvent::Check(p.clone()),
            _ => SpoolEvent::Other,
        },
        _ => SpoolEvent::Other,
    })
}

fn is_starting(s: &Session) -> bool {
    matches!(
        s.agent_startup.as_ref().map(|a| a.state),
        Some(AgentStartupState::Launching | AgentStartupState::WaitingAtStartupPrompt)
    )
}

fn started(s: &mut Session) {
    s.agent_startup = Some(AgentStartup {
        state: AgentStartupState::Started,
        since: now(),
        confidence: "exact".to_string(),
        detail: None,
    });
}

/// What the spool watcher of one launch remembers between lines.
#[derive(Debug, Default)]
pub struct LaunchWatch {
    /// The agent sends a start signal of its own (its hook file has one).
    pub expects_start_signal: bool,
    /// After a fallback: the fresh conversation's id (None when the vendor
    /// cannot pre-assign one), adopted once that conversation has started.
    /// Until then the session keeps the conversation it had.
    pending_fresh_id: Option<Option<String>>,
}

impl LaunchWatch {
    pub fn new(expects_start_signal: bool) -> Self {
        Self {
            expects_start_signal,
            pending_fresh_id: None,
        }
    }

    fn adopt_fresh_id(&mut self, s: &mut Session) -> bool {
        match self.pending_fresh_id.take() {
            Some(id) => {
                let changed = s.vendor_session_id != id;
                s.vendor_session_id = id;
                changed
            }
            None => false,
        }
    }

    /// Apply one spool event to the session. Returns true when something
    /// the frontend shows changed.
    pub fn apply(&mut self, s: &mut Session, event: &SpoolEvent) -> bool {
        apply_spool_event(self, s, event)
    }
}

/// Apply one spool event to the session. Returns true when something the
/// frontend shows changed.
fn apply_spool_event(w: &mut LaunchWatch, s: &mut Session, event: &SpoolEvent) -> bool {
    match event {
        SpoolEvent::Started { vendor_session_id } => {
            match vendor_session_id {
                Some(id) => {
                    w.pending_fresh_id = None;
                    s.vendor_session_id = Some(id.clone());
                }
                None => {
                    w.adopt_fresh_id(s);
                }
            }
            started(s);
            true
        }
        SpoolEvent::ResumeFallback { vendor_session_id } => {
            // The old id stays until the fresh conversation has started:
            // if the fresh agent never gets going, nothing is lost.
            w.pending_fresh_id = Some(vendor_session_id.clone());
            s.agent_startup = Some(AgentStartup {
                state: AgentStartupState::Launching,
                since: now(),
                confidence: "exact".to_string(),
                detail: Some(
                    "the previous conversation could not be resumed; a new one started".to_string(),
                ),
            });
            true
        }
        // An agent with no start signal of its own: still running past the
        // quick-failure window is the best sign its conversation started.
        SpoolEvent::FallbackRunning if !w.expects_start_signal => w.adopt_fresh_id(s),
        SpoolEvent::FallbackRunning => false,
        SpoolEvent::Ended => {
            s.agent_startup = Some(AgentStartup {
                state: AgentStartupState::Ended,
                since: now(),
                confidence: "exact".to_string(),
                detail: None,
            });
            true
        }
        SpoolEvent::Exited { exit_code, error } => {
            let detail = match (error, *exit_code) {
                (Some(e), _) => Some(e.clone()),
                (None, 0) => None,
                (None, code) => Some(format!("the agent exited with status {code}")),
            };
            s.agent_startup = Some(AgentStartup {
                state: AgentStartupState::Ended,
                since: now(),
                confidence: "exact".to_string(),
                detail,
            });
            true
        }
        // A check report changes no startup state; the watcher hands it to
        // `crate::done_when`.
        SpoolEvent::Check(_) => false,
        // Any other signal from the agent is the agent at work: whatever
        // startup prompt there was is behind it.
        SpoolEvent::Other => {
            let adopted = w.adopt_fresh_id(s);
            if is_starting(s) {
                started(s);
                true
            } else {
                adopted
            }
        }
    }
}

/// Whether terminal input is something a person typed: a key, Enter,
/// Ctrl-C, Escape. The terminal's own answers to the agent's queries
/// (cursor position, device attributes, focus reports) and arrow keys, which
/// only move a selection, do not count.
pub fn is_keystroke(bytes: &[u8]) -> bool {
    if bytes == b"\x1b" {
        return true;
    }
    let text = String::from_utf8_lossy(bytes);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.next() {
                Some('[') | Some('O') => {
                    for n in chars.by_ref() {
                        if ('\x40'..='\x7e').contains(&n) {
                            break;
                        }
                    }
                }
                Some(']') | Some('P') | Some('_') | Some('^') => {
                    while let Some(n) = chars.next() {
                        if n == '\x07' {
                            break;
                        }
                        if n == '\x1b' {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        if matches!(c, '\r' | '\n' | '\x03' | '\x04') || !c.is_control() {
            return true;
        }
    }
    false
}

/// The user typed into the session while its agent was starting. At a
/// startup prompt that answers it: the "waiting" report goes (back to
/// launching; the start signal or the exit report settles it). Before the
/// report, it restarts the wait, so a prompt answered in time is never
/// reported. Returns true when the state the frontend shows changed.
pub fn note_user_input(s: &mut Session, bytes: &[u8]) -> bool {
    if !is_starting(s) || !is_keystroke(bytes) {
        return false;
    }
    let was_waiting = matches!(
        s.agent_startup.as_ref().map(|a| a.state),
        Some(AgentStartupState::WaitingAtStartupPrompt)
    );
    s.agent_startup = Some(AgentStartup {
        state: AgentStartupState::Launching,
        since: now(),
        confidence: "exact".to_string(),
        detail: was_waiting.then(|| "the startup prompt was answered".to_string()),
    });
    was_waiting
}

/// Reads whole lines appended to the spool since the last call.
struct SpoolReader {
    file: PathBuf,
    offset: u64,
    partial: String,
}

impl SpoolReader {
    fn new(file: PathBuf) -> Self {
        Self {
            file,
            offset: 0,
            partial: String::new(),
        }
    }

    fn poll(&mut self) -> Vec<String> {
        let mut lines = Vec::new();
        let Ok(mut f) = std::fs::File::open(&self.file) else {
            return lines;
        };
        if f.seek(SeekFrom::Start(self.offset)).is_err() {
            return lines;
        }
        let mut buf = String::new();
        let Ok(read) = f.read_to_string(&mut buf) else {
            return lines;
        };
        self.offset += read as u64;
        self.partial.push_str(&buf);
        while let Some(pos) = self.partial.find('\n') {
            let line = self.partial[..pos].to_string();
            self.partial = self.partial[pos + 1..].to_string();
            if !line.trim().is_empty() {
                lines.push(line);
            }
        }
        lines
    }
}

/// When to guess that a starting agent sits at a startup prompt: no start
/// signal for `STARTUP_PROMPT_GUESS_AFTER` since the agent last entered
/// "launching" (the launch, a fallback, the user typing), and at most once
/// per launch attempt. Once the user answered a prompt only a signal from
/// the agent or its exit changes the state again, so an agent whose start
/// signal never comes is not reported as waiting for ever.
struct PromptGuess {
    launched_at: Instant,
    timed_since: Option<String>,
    guessed: bool,
}

impl PromptGuess {
    fn new(now: Instant) -> Self {
        Self {
            launched_at: now,
            timed_since: None,
            guessed: false,
        }
    }

    /// A fallback started another agent: it gets its own guess.
    fn new_attempt(&mut self, now: Instant) {
        self.launched_at = now;
        self.guessed = false;
    }

    /// Whether to report the startup prompt now.
    fn due(&mut self, s: &Session, now: Instant) -> bool {
        let Some(since) = s
            .agent_startup
            .as_ref()
            .filter(|a| a.state == AgentStartupState::Launching)
            .map(|a| &a.since)
        else {
            return false;
        };
        if self.timed_since.as_ref() != Some(since) {
            self.timed_since = Some(since.clone());
            self.launched_at = now;
        }
        if self.guessed || now.duration_since(self.launched_at) < STARTUP_PROMPT_GUESS_AFTER {
            return false;
        }
        self.guessed = true;
        true
    }
}

/// Watch a session's signal spool from the launch until the agent process
/// is gone (or the session is): start and end signals, the resume fallback,
/// `hi run`'s own exit report, and the "no start signal yet" guess. Every
/// nonce-verified line also becomes the SessionEvents it means (F11), on
/// the one channel the frontend store reads; sub-agent hooks move a
/// counter that is reported as a `subagents` event.
pub(crate) fn watch_signals(app: AppHandle, session: Arc<StdMutex<Session>>, watch: SignalWatch) {
    let SignalWatch {
        session_dir,
        expects_start_signal,
        nonce,
        agent,
        confidence,
        stream,
    } = watch;
    let session_id = session.lock().map(|s| s.id.clone()).unwrap_or_default();
    if let Some(stream) = stream {
        super::opencode_stream::watch(app.clone(), Arc::clone(&session), stream, confidence);
    }
    std::thread::spawn(move || {
        use crate::contract::signal::{map_signal_record, parse_signal_line, subagent_delta};
        let mut reader = SpoolReader::new(session_dir.join(SIGNALS_FILE));
        let mut watch = LaunchWatch::new(expects_start_signal);
        let mut guess = PromptGuess::new(Instant::now());
        let source = format!("hook:{agent}");
        let mut subagents: i32 = 0;
        // N19: usage limits the agent reports, as contract session events.
        let mut limits = crate::limits::LimitTracker::new();
        loop {
            std::thread::sleep(SPOOL_POLL);
            let lines = reader.poll();
            let mut changed = false;
            let mut stop = false;
            let mut guess_waiting = false;
            // The events first (they do not need the session lock), so the
            // store is right before the session list is.
            for line in &lines {
                let Ok(record) = parse_signal_line(line) else {
                    continue;
                };
                // N19: a record that puts the agent under its usage limit is
                // told as a `limit` event and a `limited` status; its plain
                // meaning (an error for the rate-limited stop, an attention
                // for a quota notice) is not sent as well.
                let limit_events = limits.observe(&record, &nonce);
                let is_limit = record.nonce == nonce
                    && crate::limits::classify(&record) == crate::limits::LimitSignal::Limited;
                if !is_limit {
                    for event in map_signal_record(&record, &nonce, confidence, &source) {
                        crate::contract::emit_session_event(&app, &session_id, event);
                    }
                }
                for event in limit_events {
                    crate::contract::emit_session_event(&app, &session_id, event);
                }
                if record.nonce == nonce {
                    let delta = subagent_delta(&record);
                    if delta != 0 {
                        subagents = (subagents + delta).max(0);
                        crate::contract::emit_session_event(
                            &app,
                            &session_id,
                            crate::contract::SessionEvent::Subagents {
                                at: record.ts.saturating_mul(1000),
                                source: Some(source.clone()),
                                tags: None,
                                running: subagents as u32,
                            },
                        );
                    }
                }
            }
            let mut checks: Vec<serde_json::Value> = Vec::new();
            if let Ok(mut s) = session.lock() {
                if matches!(
                    s.phase,
                    SessionPhase::Destroyed | SessionPhase::Disconnected
                ) {
                    stop = true;
                }
                for line in &lines {
                    if let Some(event) = parse_spool_line(line, &nonce) {
                        if matches!(event, SpoolEvent::ResumeFallback { .. }) {
                            guess.new_attempt(Instant::now());
                        }
                        if !matches!(event, SpoolEvent::Other) {
                            // Started, gone or replaced: the resume's own
                            // output is no longer of interest.
                            end_output_watch(&session_id);
                        }
                        if let SpoolEvent::Check(report) = &event {
                            checks.push(report.clone());
                        }
                        if let SpoolEvent::Exited { exit_code, error } = &event {
                            log::info!(
                                "[LAUNCH] {} agent exited (status {exit_code}{})",
                                s.id,
                                error
                                    .as_deref()
                                    .map(|e| format!(", {e}"))
                                    .unwrap_or_default()
                            );
                            // The process is gone: nothing more will come,
                            // and no guess may follow.
                            stop = true;
                        }
                        changed |= watch.apply(&mut s, &event);
                    }
                }
                if expects_start_signal && !stop && guess.due(&s, Instant::now()) {
                    s.agent_startup = Some(AgentStartup {
                        state: AgentStartupState::WaitingAtStartupPrompt,
                        since: now(),
                        confidence: "guessed".to_string(),
                        detail: Some(
                            "no start signal yet; the agent may be waiting at a startup prompt (folder trust, login)"
                                .to_string(),
                        ),
                    });
                    changed = true;
                    guess_waiting = true;
                }
                if changed {
                    let update = SessionUpdate::from(&*s);
                    let _ = app.emit("session-updated", &update);
                }
            } else {
                stop = true;
            }
            // Outside the session lock: results go to the frontend, and a
            // hook that gave up turns the session `check_failed`.
            for report in &checks {
                crate::done_when::on_hook_report(&app, &session_id, report);
            }
            if stop && !session_id.is_empty() {
                // The agent is gone; nothing refuses its stops any more.
                crate::done_when::set_hook(&app, &session_id, false);
            }
            if guess_waiting {
                log::info!(
                    "[LAUNCH] no start signal after {:?}; reporting a startup prompt (guessed)",
                    STARTUP_PROMPT_GUESS_AFTER
                );
            }
            if stop {
                end_output_watch(&session_id);
                break;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input<'a>(
        provider: &'a str,
        resume_id: Option<&'a str>,
        hi: &'a Path,
        session_dir: &'a Path,
    ) -> LaunchInput<'a> {
        LaunchInput {
            session_id: "hermes-1",
            provider,
            permission_mode: "default",
            custom_prefix: "",
            custom_suffix: "",
            channels: &[],
            cwd: "/fixture-home/repo",
            context_path: None,
            task: None,
            resume_id,
            seed_prompt: None,
            user_status_line: false,
            hi,
            session_dir,
            new_session_id: "11111111-2222-4333-8444-555555555555",
            nonce: "n0nce",
            stream_port: 4321,
            stream_secret: "s3cret",
        }
    }

    #[test]
    fn a_fresh_claude_launch_preassigns_the_session_id_and_passes_hook_settings() {
        let hi = Path::new("/app/hi");
        let dir = Path::new("/data/launch/hermes-1");
        let plan = plan_launch(&input("claude", None, hi, dir)).unwrap();
        assert_eq!(plan.spec.program, "claude");
        let settings_path = dir
            .join("claude.settings.json")
            .to_string_lossy()
            .to_string();
        assert_eq!(
            plan.spec.args,
            vec![
                "--session-id",
                "11111111-2222-4333-8444-555555555555",
                "--settings",
                settings_path.as_str(),
            ]
        );
        assert_eq!(
            plan.vendor_session_id.as_deref(),
            Some("11111111-2222-4333-8444-555555555555")
        );
        assert!(!plan.resumes);
        assert!(plan.expects_start_signal);
        assert!(plan.spec.fallback.is_none());
        assert_eq!(plan.spec.env["HERMES_SESSION_ID"], "hermes-1");
        assert_eq!(plan.spec.env["HERMES_AGENT"], "claude");
        assert_eq!(plan.spec.env["HERMES_SIGNAL_NONCE"], "n0nce");
        assert_eq!(plan.nonce, "n0nce");
        assert!(plan.spec.env["HERMES_SIGNAL_FILE"].ends_with(SIGNALS_FILE));
        assert_eq!(plan.spec.cwd, "/fixture-home/repo");
        assert_eq!(plan.spec.v, SPEC_VERSION);

        // The settings file holds hooks, all calling hi, and (N19) a status
        // line that reports the rate limits, since this user has none.
        let (path, contents) = &plan.files[0];
        assert_eq!(path, &dir.join("claude.settings.json"));
        let json: serde_json::Value = serde_json::from_str(contents).unwrap();
        assert_eq!(
            json.as_object().unwrap().keys().collect::<Vec<_>>(),
            vec!["hooks", "statusLine"]
        );
        let hooks = json["hooks"].as_object().unwrap();
        let mut events: Vec<&String> = hooks.keys().collect();
        events.sort();
        assert_eq!(
            events,
            vec![
                "Notification",
                "PermissionDenied",
                "PermissionRequest",
                "PostToolUse",
                "PostToolUseFailure",
                "PreToolUse",
                "SessionEnd",
                "SessionStart",
                "Stop",
                "StopFailure",
                "SubagentStart",
                "SubagentStop",
                "UserPromptSubmit",
            ]
        );
        let start = &hooks["SessionStart"][0]["hooks"][0];
        assert_eq!(start["type"], "command");
        assert_eq!(start["command"], "/app/hi");
        assert_eq!(
            start["args"],
            serde_json::json!(["signal", "--agent", "claude"])
        );
        assert_eq!(start["timeout"], 5);
        assert!(hooks["SessionStart"][0].get("matcher").is_none());
        // The prompt-submitted hook carries the Review Desk's delivery
        // receipt (F21): the pasted `[hermes-review #n]` line comes back
        // through it. The turn's end (and a failed turn) say when a send
        // back held for a working agent may go through.
        for event in ["UserPromptSubmit", "Stop", "StopFailure"] {
            let hook = &hooks[event][0]["hooks"][0];
            assert_eq!(hook["command"], "/app/hi", "{event}");
            assert_eq!(
                hook["args"],
                serde_json::json!(["signal", "--agent", "claude"]),
                "{event}"
            );
        }
        // Tool hooks only for the tools Hermes reads; every notification.
        assert_eq!(
            hooks["PreToolUse"][0]["matcher"],
            "AskUserQuestion|ExitPlanMode"
        );
        assert!(hooks["Notification"][0].get("matcher").is_none());
        // Tool completions are only counted: Claude need not wait for them.
        assert_eq!(hooks["PostToolUse"][0]["hooks"][0]["async"], true);
        assert!(hooks["PermissionRequest"][0]["hooks"][0]
            .get("async")
            .is_none());
        // Observe only: no hook is anything but `hi signal`, and nothing in
        // the file could answer a permission.
        for (event, entries) in hooks {
            for hook in entries[0]["hooks"].as_array().unwrap() {
                assert_eq!(hook["command"], "/app/hi", "{event}");
                assert_eq!(hook["args"][0], "signal", "{event}");
            }
        }
        for word in ["decision", "permissionDecision", "allow", "deny"] {
            assert!(!contents.contains(word), "{word} in the settings file");
        }
        // Done-When (F27): Claude's stop also runs the checks, in a second
        // group after the signal hook, and can be refused.
        let stop = &hooks["Stop"][1]["hooks"][0];
        assert_eq!(stop["type"], "command");
        assert_eq!(stop["command"], "/app/hi");
        assert_eq!(stop["args"], serde_json::json!(["check", "--stop-hook"]));
        assert_eq!(stop["timeout"], CHECK_HOOK_TIMEOUT_SECS);
        assert!(plan.check_hook);
    }

    #[test]
    fn only_a_settings_file_agent_with_a_check_hook_gets_the_done_when_hook() {
        let hi = Path::new("/app/hi");
        let dir = Path::new("/data/launch/hermes-1");
        for provider in ["codex", "gemini"] {
            let plan = plan_launch(&input(provider, None, hi, dir)).unwrap();
            assert!(!plan.check_hook, "{provider}");
            for (_, contents) in &plan.files {
                assert!(!contents.contains("--stop-hook"), "{provider}");
            }
            assert!(!plan.spec.args.iter().any(|a| a.contains("--stop-hook")));
        }
    }

    #[test]
    fn copilot_gets_a_plugin_folder_and_opencode_a_port_and_password() {
        let hi = Path::new("/app/hi");
        let dir = Path::new("/data/launch/hermes-1");
        let plan = plan_launch(&input("copilot", None, hi, dir)).unwrap();
        let plugin_dir = dir.join("copilot-plugin");
        assert!(plan
            .spec
            .args
            .windows(2)
            .any(|w| w[0] == "--plugin-dir" && w[1] == plugin_dir.to_string_lossy()));
        assert_eq!(plan.files[0].0, plugin_dir.join("hooks.json"));
        let json: serde_json::Value = serde_json::from_str(&plan.files[0].1).unwrap();
        assert_eq!(json["version"], 1);
        let hook = &json["hooks"]["notification"][0];
        assert_eq!(hook["type"], "command");
        assert_eq!(hook["exec"], "/app/hi");
        assert_eq!(
            hook["args"],
            serde_json::json!(["signal", "--agent", "copilot", "--event", "notification"])
        );
        assert_eq!(hook["env"]["HERMES_SIGNAL_NONCE"], "n0nce");
        assert_eq!(hook["timeoutSec"], 5);
        assert!(json["hooks"]["agentStop"].is_array());
        assert!(json["hooks"]["errorOccurred"].is_array());
        assert!(json["hooks"]["sessionStart"].is_array());
        assert_eq!(plan.confidence, "signal");
        assert!(plan.stream.is_none());
        assert!(plan.expects_start_signal);

        let plan = plan_launch(&input("opencode", None, hi, dir)).unwrap();
        assert!(plan.files.is_empty());
        assert!(plan
            .spec
            .args
            .windows(2)
            .any(|w| w[0] == "--port" && w[1] == "4321"));
        assert!(plan
            .spec
            .args
            .windows(2)
            .any(|w| w[0] == "--hostname" && w[1] == "127.0.0.1"));
        assert_eq!(plan.spec.env["OPENCODE_SERVER_PASSWORD"], "s3cret");
        assert_eq!(
            plan.stream,
            Some(StreamSpec {
                port: 4321,
                secret: "s3cret".into()
            })
        );
        assert_eq!(plan.confidence, "exact");
    }

    #[test]
    fn gemini_defaults_switch_notifications_on_and_hook_every_catalog_event() {
        let hi = Path::new("/app/hi");
        let dir = Path::new("/data/launch/hermes-1");
        let plan = plan_launch(&input("gemini", None, hi, dir)).unwrap();
        let json: serde_json::Value = serde_json::from_str(&plan.files[0].1).unwrap();
        assert_eq!(json["general"]["enableNotifications"], true);
        assert_eq!(json["general"]["notificationMethod"], "osc9");
        let hooks = json["hooks"].as_object().unwrap();
        let mut events: Vec<&String> = hooks.keys().collect();
        events.sort();
        assert_eq!(
            events,
            vec!["AfterAgent", "BeforeAgent", "Notification", "SessionEnd"]
        );
        let n = &hooks["Notification"][0]["hooks"][0];
        assert_eq!(
            n["command"],
            "\"/app/hi\" signal --agent gemini --event Notification"
        );
        assert_eq!(n["name"], "hermes-notification");
        assert_eq!(n["env"]["HERMES_SESSION_ID"], "hermes-1");
    }

    /// Antigravity and goose take no per-launch flag: the hook file goes
    /// into the folder the agent runs in, only when it is a worktree Hermes
    /// made, and git is told to ignore it there.
    #[test]
    fn worktree_file_agents_get_hooks_only_inside_a_hermes_worktree_and_git_ignores_them() {
        let hi = Path::new("/app/hi");
        let dir = Path::new("/data/launch/hermes-1");
        // The user's own checkout: nothing is written there.
        let plain = plan_launch(&input("antigravity", None, hi, dir)).unwrap();
        assert!(plain.files.is_empty());
        assert!(plain.git_excludes.is_empty());
        assert_eq!(plain.spec.args, Vec::<String>::new());

        // A Hermes-owned worktree (a real git repository, so the exclude
        // file can be written and checked).
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp
            .path()
            .join("hermes-worktrees")
            .join("abc")
            .join("s1_task");
        std::fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        git(&["init", "-q"]);
        // A hooks file the repository already carries is merged, not replaced.
        std::fs::create_dir_all(repo.join(".agents")).unwrap();
        std::fs::write(
            repo.join(".agents/hooks.json"),
            r#"{"team-lint":{"enabled":true,"PostToolUse":[{"hooks":[{"type":"command","command":"lint"}]}]}}"#,
        )
        .unwrap();
        let cwd = repo.to_string_lossy().to_string();
        let mut inp = input("antigravity", None, hi, dir);
        inp.cwd = &cwd;
        let plan = plan_launch(&inp).unwrap();
        assert_eq!(plan.files.len(), 1);
        assert_eq!(plan.files[0].0, repo.join(".agents/hooks.json"));
        let json: serde_json::Value = serde_json::from_str(&plan.files[0].1).unwrap();
        assert_eq!(
            json["team-lint"]["enabled"], true,
            "the repository's own entry survives"
        );
        assert_eq!(json["hermes-signal"]["enabled"], true);
        assert_eq!(
            json["hermes-signal"]["Stop"][0]["hooks"][0]["command"],
            "\"/app/hi\" signal --agent antigravity --event Stop"
        );
        assert!(json["hermes-signal"]["PreToolUse"].is_array());
        assert_eq!(plan.git_excludes, vec![".agents/hooks.json".to_string()]);
        assert!(!plan.expects_start_signal);

        // Writing the plan writes the file and excludes it from git.
        write_plan(&tmp.path().join("launch").join("hermes-1"), &plan).unwrap();
        let written: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(repo.join(".agents/hooks.json")).unwrap(),
        )
        .unwrap();
        assert!(written.get("hermes-signal").is_some());
        let exclude = std::fs::read_to_string(repo.join(".git/info/exclude")).unwrap();
        assert!(
            exclude.lines().any(|l| l == ".agents/hooks.json"),
            "{exclude}"
        );
        assert_eq!(git(&["status", "--porcelain"]), "", "git sees nothing new");
        // A second launch does not duplicate the exclude line.
        write_plan(&tmp.path().join("launch").join("hermes-1"), &plan).unwrap();
        let exclude = std::fs::read_to_string(repo.join(".git/info/exclude")).unwrap();
        assert_eq!(exclude.matches(".agents/hooks.json").count(), 1);

        // goose: its own plugin folder, excluded as a folder.
        let mut inp = input("goose", None, hi, dir);
        inp.cwd = &cwd;
        let goose = plan_launch(&inp).unwrap();
        assert_eq!(
            goose.files[0].0,
            repo.join(".agents/plugins/hermes-signal/hooks/hooks.json")
        );
        let json: serde_json::Value = serde_json::from_str(&goose.files[0].1).unwrap();
        assert_eq!(
            json["hooks"]["Stop"][0]["hooks"][0]["command"],
            "\"/app/hi\" signal --agent goose --event Stop"
        );
        assert_eq!(
            goose.git_excludes,
            vec![".agents/plugins/hermes-signal/".to_string()]
        );
        write_plan(&tmp.path().join("launch").join("hermes-2"), &goose).unwrap();
        assert_eq!(git(&["status", "--porcelain"]), "");
        assert_eq!(goose.confidence, "guessed");
    }

    /// Claude over SSH: the settings travel on the command line and every
    /// hook prints the nonce-tagged marker through `printf`, in exec form.
    #[test]
    fn ssh_settings_print_nonce_tagged_markers_and_quote_for_every_login_shell() {
        let json = ssh_settings_json("n0nce");
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        let hooks = v["hooks"].as_object().unwrap();
        let mut events: Vec<&String> = hooks.keys().collect();
        events.sort();
        assert_eq!(
            events,
            vec![
                "PermissionRequest",
                "PreToolUse",
                "SessionEnd",
                "SessionStart",
                "Stop",
                "StopFailure",
                "UserPromptSubmit"
            ]
        );
        let stop = &hooks["Stop"][0]["hooks"][0];
        assert_eq!(stop["command"], "printf");
        assert_eq!(stop["args"][0], "%s");
        let printed: serde_json::Value =
            serde_json::from_str(stop["args"][1].as_str().unwrap()).unwrap();
        assert_eq!(
            printed["terminalSequence"],
            "\u{1b}]777;notify;hermes-signal;v1:n0nce:Stop\u{7}"
        );
        assert_eq!(hooks["PreToolUse"][0]["matcher"], "AskUserQuestion");
        assert_eq!(hooks["PreToolUse"][1]["matcher"], "ExitPlanMode");
        assert!(
            !json.contains('\''),
            "no single quote: the argument is double-quoted"
        );
        for word in ["decision", "permissionDecision", "allow", "deny"] {
            assert!(!json.contains(word));
        }

        let arg = ssh_settings_argument(&json);
        assert!(arg.starts_with('"') && arg.ends_with('"'));
        // What a POSIX login shell hands Claude is the JSON itself.
        #[cfg(unix)]
        {
            let out = std::process::Command::new("sh")
                .arg("-c")
                .arg(format!("printf %s {arg}"))
                .output()
                .unwrap();
            assert_eq!(String::from_utf8_lossy(&out.stdout), json);
            // And the hook, run as Claude runs it, prints the marker.
            let out = std::process::Command::new("printf")
                .arg("%s")
                .arg(stop["args"][1].as_str().unwrap())
                .output()
                .unwrap();
            let printed: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
            assert!(printed["terminalSequence"]
                .as_str()
                .unwrap()
                .contains("hermes-signal;v1:n0nce:Stop"));
        }
        let mut s = test_session();
        assert!(ssh_signal_args(&s).is_none(), "local sessions use hi");
        s.ssh_info = Some(super::super::models::SshConnectionInfo {
            host: "h".into(),
            user: "u".into(),
            port: 22,
            tmux_session: None,
            identity_file: None,
            jump_host: None,
            port_forwards: Vec::new(),
        });
        let (arg, nonce) = ssh_signal_args(&s).unwrap();
        assert!(arg.starts_with("--settings \""));
        assert!(arg.contains(&format!("v1:{nonce}:PermissionRequest")));
        s.launch_helper = false;
        assert!(ssh_signal_args(&s).is_none(), "the flag gates it");
    }

    #[test]
    fn a_second_hook_on_the_same_event_is_added_not_replaced() {
        let mut hooks = serde_json::Map::new();
        push_hook(&mut hooks, "Stop", serde_json::json!({ "command": "a" }));
        push_hook(&mut hooks, "Stop", serde_json::json!({ "command": "b" }));
        let groups = hooks["Stop"].as_array().unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0]["hooks"][0]["command"], "a");
        assert_eq!(groups[1]["hooks"][0]["command"], "b");
    }

    #[test]
    fn a_check_report_on_the_spool_is_handed_on_whole() {
        let line = r#"{"v":1,"ts":1,"session":"s","agent":"claude","nonce":"n0nce","event":"hermes.check","payload":{"state":"failed","trigger":"stop_hook","attempt":2}}"#;
        match parse_spool_line(line, "n0nce") {
            Some(SpoolEvent::Check(p)) => {
                assert_eq!(p["state"], "failed");
                assert_eq!(p["attempt"], 2);
            }
            other => panic!("{other:?}"),
        }
        // Another launch's nonce: ignored like any other line.
        assert_eq!(parse_spool_line(line, "other"), None);
        let no_payload = r#"{"v":1,"ts":1,"session":"s","agent":"claude","nonce":"n0nce","event":"hermes.check"}"#;
        assert_eq!(
            parse_spool_line(no_payload, "n0nce"),
            Some(SpoolEvent::Other)
        );
        let mut s = test_session();
        let mut w = LaunchWatch::new(true);
        assert!(!w.apply(&mut s, &SpoolEvent::Check(serde_json::json!({}))));
    }

    #[test]
    fn a_restored_claude_session_resumes_with_a_fresh_start_fallback() {
        let hi = Path::new("/app/hi");
        let dir = Path::new("/data/launch/hermes-1");
        let mut inp = input("claude", Some("old-id"), hi, dir);
        inp.permission_mode = "acceptEdits";
        let plan = plan_launch(&inp).unwrap();
        assert!(plan.resumes);
        assert_eq!(plan.vendor_session_id.as_deref(), Some("old-id"));
        assert_eq!(
            &plan.spec.args[..4],
            ["--resume", "old-id", "--permission-mode", "acceptEdits"]
        );
        let fb = plan.spec.fallback.unwrap();
        assert_eq!(fb.program, "claude");
        assert_eq!(
            &fb.args[..4],
            [
                "--session-id",
                "11111111-2222-4333-8444-555555555555",
                "--permission-mode",
                "acceptEdits"
            ]
        );
        assert_eq!(fb.after_ms, RESUME_FALLBACK_AFTER_MS);
        assert_eq!(
            fb.vendor_session_id.as_deref(),
            Some("11111111-2222-4333-8444-555555555555")
        );
        assert!(fb.message.contains("starting a new one"));
        // Only Claude's own "not found" (exit 1 and its message, which
        // Hermes watches the terminal for) replaces the conversation.
        let evidence = dir.join("resume-not-found").to_string_lossy().to_string();
        assert_eq!(
            fb.not_found,
            NotFoundSpec {
                exit_codes: vec![1],
                evidence_file: Some(evidence),
            }
        );
        assert_eq!(
            plan.not_found_output,
            vec!["No conversation found with session ID"]
        );
        // A fresh launch watches for nothing.
        let fresh = plan_launch(&input("claude", None, hi, dir)).unwrap();
        assert!(fresh.not_found_output.is_empty());
    }

    #[test]
    fn a_resume_without_a_catalog_not_found_entry_has_no_fallback() {
        // Kiro and goose resume by id but the catalog does not say how they
        // report a missing conversation: an early exit is left alone.
        let hi = Path::new("/app/hi");
        let dir = Path::new("/data/launch/hermes-1");
        for agent in ["kiro", "goose"] {
            let plan = plan_launch(&input(agent, Some("x-1"), hi, dir)).unwrap();
            assert!(plan.resumes, "{agent}");
            assert!(plan.spec.fallback.is_none(), "{agent}");
            assert!(plan.not_found_output.is_empty(), "{agent}");
        }
    }

    #[test]
    fn codex_resumes_with_a_subcommand_and_gemini_with_a_flag() {
        let hi = Path::new("/app/hi");
        let dir = Path::new("/data/launch/hermes-1");
        let mut codex = input("codex", Some("thread-9"), hi, dir);
        codex.permission_mode = "auto";
        let plan = plan_launch(&codex).unwrap();
        assert_eq!(
            &plan.spec.args[..6],
            [
                "resume",
                "thread-9",
                "--sandbox",
                "workspace-write",
                "--ask-for-approval",
                "on-request"
            ]
        );
        // Codex signals travel as config flags with the helper's path filled
        // in; no file, so no start signal is expected from a hook file.
        assert!(plan
            .spec
            .args
            .iter()
            .any(|a| a == r#"notify=["/app/hi","signal","--agent","codex","--argv-json"]"#));
        assert!(plan.files.is_empty());
        assert!(!plan.expects_start_signal);
        // Codex cannot pre-assign an id: a fresh start carries none. Its
        // "not found" is known by its text only, so any exit code but an
        // interrupt qualifies once Hermes saw the text.
        let fb = plan.spec.fallback.unwrap();
        assert_eq!(fb.vendor_session_id, None);
        assert!(fb.not_found.exit_codes.is_empty());
        assert!(fb.not_found.evidence_file.is_some());
        assert_eq!(
            plan.not_found_output,
            vec!["No saved session found with ID"]
        );
        let fresh_codex = plan_launch(&input("codex", None, hi, dir)).unwrap();
        assert_eq!(fresh_codex.vendor_session_id, None);
        assert_eq!(fresh_codex.spec.args[0], "-c");
        assert!(!fresh_codex.spec.args.iter().any(|a| a == "resume"));

        let gemini = plan_launch(&input("gemini", Some("g-1"), hi, dir)).unwrap();
        assert_eq!(gemini.spec.args, vec!["--resume", "g-1"]);
        assert_eq!(
            gemini.spec.fallback.as_ref().unwrap().not_found.exit_codes,
            vec![42]
        );
        // Gemini takes its hooks from a defaults file named by an
        // environment variable; the hooks carry the Hermes variables
        // themselves (Gemini runs hooks in a sanitized environment).
        let defaults = dir.join("gemini.defaults.json");
        assert_eq!(
            gemini.spec.env["GEMINI_CLI_SYSTEM_DEFAULTS_PATH"],
            defaults.to_string_lossy()
        );
        assert_eq!(gemini.files[0].0, defaults);
        let json: serde_json::Value = serde_json::from_str(&gemini.files[0].1).unwrap();
        let end = &json["hooks"]["SessionEnd"][0]["hooks"][0];
        assert_eq!(
            end["command"],
            "\"/app/hi\" signal --agent gemini --event SessionEnd"
        );
        assert_eq!(end["env"]["HERMES_SESSION_ID"], "hermes-1");
        assert_eq!(end["env"]["HERMES_SIGNAL_NONCE"], "n0nce");
        assert!(end["env"]["HERMES_SIGNAL_FILE"]
            .as_str()
            .unwrap()
            .ends_with(SIGNALS_FILE));
        // The catalog lists no start event for Gemini, so silence is not a
        // startup prompt there.
        assert!(!gemini.expects_start_signal);
        let fresh_gemini = plan_launch(&input("gemini", None, hi, dir)).unwrap();
        assert_eq!(
            fresh_gemini.spec.args,
            vec!["--session-id", "11111111-2222-4333-8444-555555555555"]
        );
    }

    #[test]
    fn agents_without_resume_start_fresh_even_with_a_saved_id() {
        let hi = Path::new("/app/hi");
        let dir = Path::new("/data/launch/hermes-1");
        // Aider has no resume-by-id in the catalog.
        let plan = plan_launch(&input("aider", Some("anything"), hi, dir)).unwrap();
        assert!(!plan.resumes);
        assert!(plan.spec.fallback.is_none());
        assert_eq!(plan.vendor_session_id, None);
        assert_eq!(plan.spec.program, "aider");
        assert!(plan.spec.args.is_empty());
        // Kiro resumes after its subcommand.
        let kiro = plan_launch(&input("kiro", Some("k-1"), hi, dir)).unwrap();
        assert_eq!(kiro.spec.program, "kiro-cli");
        assert_eq!(kiro.spec.args, vec!["chat", "--resume-id", "k-1"]);
        assert!(kiro.spec.fallback.is_none());
        // goose: `goose session --resume --session-id <id>`.
        let goose = plan_launch(&input("goose", Some("g-9"), hi, dir)).unwrap();
        assert_eq!(goose.spec.program, "goose");
        assert_eq!(
            goose.spec.args,
            vec!["session", "--resume", "--session-id", "g-9"]
        );
        // Unknown agents and the Custom agent keep the typed launch.
        assert!(plan_launch(&input("not-an-agent", None, hi, dir)).is_none());
        assert!(plan_launch(&input("custom", None, hi, dir)).is_none());
    }

    #[test]
    fn the_launcher_task_is_the_first_prompt_of_a_fresh_start_only() {
        let hi = Path::new("/app/hi");
        let dir = Path::new("/data/launch/hermes-1");
        let task = "Fix the login bug; it's in \"auth.ts\" & $HOME stays literal";
        // Claude: a positional prompt, one argument, nothing expanded.
        let mut inp = input("claude", None, hi, dir);
        inp.task = Some(task);
        let plan = plan_launch(&inp).unwrap();
        assert_eq!(plan.spec.args.last().map(String::as_str), Some(task));
        assert!(!plan.context_in_args, "no context file was handed over");
        // Codex and OpenCode take it the way their catalog entry says.
        let mut codex = input("codex", None, hi, dir);
        codex.task = Some("add tests");
        assert_eq!(
            plan_launch(&codex)
                .unwrap()
                .spec
                .args
                .last()
                .map(String::as_str),
            Some("add tests")
        );
        let mut opencode = input("opencode", None, hi, dir);
        opencode.task = Some("add tests");
        let args = plan_launch(&opencode).unwrap().spec.args;
        assert_eq!(&args[args.len() - 2..], ["--prompt", "add tests"]);
        // An agent with no way to take a first prompt gets none.
        let mut goose = input("goose", None, hi, dir);
        goose.task = Some("add tests");
        assert!(!plan_launch(&goose)
            .unwrap()
            .spec
            .args
            .iter()
            .any(|a| a == "add tests"));
        // With a context file, the task comes first and the pointer follows.
        inp.context_path = Some("/data/context/hermes-1.md");
        let both = plan_launch(&inp).unwrap();
        let prompt = both.spec.args.last().unwrap();
        assert!(prompt.starts_with(task), "{prompt}");
        assert!(prompt.ends_with("for project context about the attached workspaces."));
        assert!(both.context_in_args);
        // A blank task is no task.
        let mut blank = input("claude", None, hi, dir);
        blank.task = Some("  \n ");
        assert_eq!(
            plan_launch(&blank).unwrap().spec.args,
            plan_launch(&input("claude", None, hi, dir))
                .unwrap()
                .spec
                .args
        );
        // A resumed conversation never gets the task again.
        let mut resumed = input("claude", Some("old-id"), hi, dir);
        resumed.task = Some(task);
        assert!(!plan_launch(&resumed)
            .unwrap()
            .spec
            .args
            .iter()
            .any(|a| a == task));
    }

    #[test]
    fn a_multi_line_task_is_one_argument() {
        let prompt = first_prompt(Some("line one\nline two\r\n\nline three"), None).unwrap();
        if cfg!(windows) {
            assert_eq!(prompt, "line one line two line three");
        } else {
            assert_eq!(prompt, "line one\nline two\r\n\nline three");
        }
        assert_eq!(one_line(" a \r\n\n b\n"), "a b");
        assert_eq!(first_prompt(None, None), None);
        assert_eq!(first_prompt(Some(""), None), None);
    }

    #[test]
    fn prefix_suffix_context_and_channels_become_plain_arguments() {
        let hi = Path::new("/app/hi");
        let dir = Path::new("/data/launch/hermes-1");
        let channels = vec!["telegram".to_string()];
        let mut inp = input("claude", None, hi, dir);
        inp.custom_prefix = " caffeinate -i \n";
        inp.custom_suffix = "--verbose";
        inp.context_path = Some("/data/context/hermes-1.md");
        inp.channels = &channels;
        let plan = plan_launch(&inp).unwrap();
        assert_eq!(plan.spec.program, "caffeinate");
        assert_eq!(&plan.spec.args[..2], ["-i", "claude"]);
        assert!(plan.context_in_args);
        let prompt = plan
            .spec
            .args
            .iter()
            .find(|a| a.starts_with("Read the file at "))
            .unwrap();
        // The real path travels, no shell variable to expand.
        assert_eq!(
            prompt,
            "Read the file at /data/context/hermes-1.md for project context about the attached workspaces."
        );
        let prompt_at = plan.spec.args.iter().position(|a| a == prompt).unwrap();
        let channels_at = plan
            .spec
            .args
            .iter()
            .position(|a| a == "--channels")
            .unwrap();
        assert!(channels_at > prompt_at, "channels come after the prompt");
        assert_eq!(plan.spec.args.last().map(String::as_str), Some("--verbose"));

        // A resumed conversation does not get the prompt again, the fresh
        // fallback does.
        inp.resume_id = Some("old");
        let resumed = plan_launch(&inp).unwrap();
        assert!(!resumed.context_in_args);
        assert!(!resumed
            .spec
            .args
            .iter()
            .any(|a| a.starts_with("Read the file")));
        assert!(resumed
            .spec
            .fallback
            .unwrap()
            .args
            .iter()
            .any(|a| a.starts_with("Read the file")));
    }

    #[test]
    fn claude_gets_its_limit_hooks_and_a_status_line_only_when_the_user_has_none() {
        let hi = Path::new("/app/hi");
        let dir = Path::new("/data/launch/hermes-1");
        let plan = plan_launch(&input("claude", None, hi, dir)).unwrap();
        let json: serde_json::Value = serde_json::from_str(&plan.files[0].1).unwrap();
        let hooks = &json["hooks"];
        // The limit events are hooks like every other status's (F11): one
        // group each, calling hi in exec form. Only tool events take a
        // matcher, so StopFailure and Notification reach hi whatever their
        // error or type, and hi's payload says which it was.
        for event in ["StopFailure", "Notification", "UserPromptSubmit"] {
            let groups = hooks[event].as_array().unwrap();
            assert_eq!(groups.len(), 1, "{event}");
            assert!(groups[0].get("matcher").is_none(), "{event}");
            assert_eq!(groups[0]["hooks"][0]["command"], "/app/hi");
            assert_eq!(
                groups[0]["hooks"][0]["args"],
                serde_json::json!(["signal", "--agent", "claude"])
            );
        }
        assert!(hooks.get("statusLine").is_none(), "not a hook");
        assert_eq!(
            json["statusLine"],
            serde_json::json!({
                "type": "command",
                "command": "\"/app/hi\" signal --agent claude --event StatusLine"
            })
        );

        // The user has a status line of their own: ours would replace it.
        let mut inp = input("claude", None, hi, dir);
        inp.user_status_line = true;
        let plan = plan_launch(&inp).unwrap();
        let json: serde_json::Value = serde_json::from_str(&plan.files[0].1).unwrap();
        assert!(json.get("statusLine").is_none());
        assert!(json["hooks"]["StopFailure"].is_array());

        // An agent whose catalog entry lists no status line gets none.
        let gemini = plan_launch(&input("gemini", None, hi, dir)).unwrap();
        assert!(!gemini.files[0].1.contains("statusLine"));
    }

    #[test]
    fn a_status_line_in_any_settings_file_counts_as_the_users() {
        let tmp = tempfile::tempdir().unwrap();
        let none = tmp.path().join("none.json");
        let plain = tmp.path().join("plain.json");
        let with = tmp.path().join("with.json");
        let null = tmp.path().join("null.json");
        let broken = tmp.path().join("broken.json");
        std::fs::write(&plain, r#"{"model":"x"}"#).unwrap();
        std::fs::write(&with, r#"{"statusLine":{"type":"command","command":"x"}}"#).unwrap();
        std::fs::write(&null, r#"{"statusLine":null}"#).unwrap();
        std::fs::write(&broken, "{not json").unwrap();
        assert!(!settings_set_status_line(&[
            none.clone(),
            plain.clone(),
            null.clone(),
            broken.clone()
        ]));
        assert!(settings_set_status_line(&[none, plain, with]));
    }

    #[test]
    fn a_handoff_seed_travels_as_one_argument_before_the_context_line() {
        let hi = Path::new("/app/hi");
        let dir = Path::new("/data/launch/hermes-1");
        // Quotes, a newline and shell syntax: typed into a shell this would
        // split, run or submit early; as one argument it is just text.
        let seed = "Continue this task: \"fix login\"\n\nFiles changed so far:\n- M src/login.ts\n$(echo hi) `x` ; & |";
        for agent in ["codex", "claude", "copilot"] {
            let mut inp = input(agent, None, hi, dir);
            inp.seed_prompt = Some(seed);
            let plan = plan_launch(&inp).unwrap();
            assert!(plan.seed_in_args, "{agent}");
            assert!(!plan.context_in_args, "{agent}");
            // One line on Windows, where a `.cmd` shim cannot take a line
            // break in an argument (see first_prompt).
            let expected = if cfg!(windows) {
                one_line(seed)
            } else {
                seed.to_string()
            };
            assert!(
                plan.spec.args.contains(&expected),
                "{agent}: the seed is one untouched argument: {:?}",
                plan.spec.args
            );
        }
        // With project context too: one prompt, the task first.
        let mut inp = input("claude", None, hi, dir);
        inp.seed_prompt = Some("Do the task.");
        inp.context_path = Some("/data/context/hermes-1.md");
        let plan = plan_launch(&inp).unwrap();
        assert!(plan.seed_in_args && plan.context_in_args);
        let both = "Do the task.\n\nRead the file at /data/context/hermes-1.md for project context about the attached workspaces.";
        let both = if cfg!(windows) {
            one_line(both)
        } else {
            both.to_string()
        };
        assert!(plan.spec.args.contains(&both));
        // An agent that takes no first prompt cannot carry the seed.
        let mut inp = input("goose", None, hi, dir);
        inp.seed_prompt = Some("Do the task.");
        if let Some(plan) = plan_launch(&inp) {
            assert!(!plan.seed_in_args);
            assert!(!plan.spec.args.iter().any(|a| a.contains("Do the task.")));
        }
        // A blank seed is no seed.
        let mut inp = input("codex", None, hi, dir);
        inp.seed_prompt = Some("  \n ");
        assert!(!plan_launch(&inp).unwrap().seed_in_args);
    }

    #[test]
    fn the_launch_file_serialises_to_the_format_hi_reads() {
        let hi = Path::new("C:\\Program Files\\Hermes\\hi.exe");
        let dir = Path::new("C:\\data\\launch\\hermes-1");
        let plan = plan_launch(&input("claude", Some("old"), hi, dir)).unwrap();
        let json: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&plan.spec).unwrap()).unwrap();
        assert_eq!(json["v"], 1);
        assert_eq!(json["session_id"], "hermes-1");
        assert_eq!(json["program"], "claude");
        assert_eq!(json["args"][0], "--resume");
        assert_eq!(json["fallback"]["after_ms"], 3000);
        assert_eq!(json["fallback"]["not_found"]["exit_codes"][0], 1);
        assert!(json["fallback"]["not_found"]["evidence_file"]
            .as_str()
            .unwrap()
            .ends_with(NOT_FOUND_EVIDENCE_FILE));
        assert!(json["env"]["HERMES_SIGNAL_FILE"].is_string());
        // Hook paths use forward slashes; exec form needs no quoting at all.
        let settings: serde_json::Value = serde_json::from_str(&plan.files[0].1).unwrap();
        assert_eq!(
            settings["hooks"]["SessionStart"][0]["hooks"][0]["command"],
            "C:/Program Files/Hermes/hi.exe"
        );
        assert_eq!(
            settings["hooks"]["SessionStart"][0]["hooks"][0]["args"],
            serde_json::json!(["signal", "--agent", "claude"])
        );
    }

    #[test]
    fn spool_lines_drive_the_startup_state_and_the_vendor_id() {
        const N: &str = "n0nce";
        let started = parse_spool_line(
            r#"{"v":1,"nonce":"n0nce","event":"SessionStart","payload":{"session_id":"abc","cwd":"/x"}}"#,
            N,
        )
        .unwrap();
        assert_eq!(
            started,
            SpoolEvent::Started {
                vendor_session_id: Some("abc".into())
            }
        );
        let fallback = parse_spool_line(
            r#"{"v":1,"nonce":"n0nce","event":"hermes.resume_fallback","payload":{"vendor_session_id":"new","exit_code":1}}"#,
            N,
        )
        .unwrap();
        assert_eq!(
            parse_spool_line(r#"{"v":1,"nonce":"n0nce","event":"SessionEnd"}"#, N),
            Some(SpoolEvent::Ended)
        );
        assert_eq!(
            parse_spool_line(r#"{"v":1,"nonce":"n0nce","event":"Stop"}"#, N),
            Some(SpoolEvent::Other)
        );
        assert_eq!(
            parse_spool_line(
                r#"{"v":1,"nonce":"n0nce","event":"hermes.exited","payload":{"exit_code":127,"error":"claude: command not found"}}"#,
                N
            ),
            Some(SpoolEvent::Exited {
                exit_code: 127,
                error: Some("claude: command not found".into())
            })
        );
        assert_eq!(parse_spool_line("garbage", N), None);
        assert_eq!(parse_spool_line(r#"{"v":1,"nonce":"n0nce"}"#, N), None);
        // A line without this launch's nonce is not this launch's: an
        // earlier launch of the same session, or something else writing to
        // the spool, must not change what Hermes shows or resumes.
        assert_eq!(
            parse_spool_line(
                r#"{"v":1,"event":"SessionStart","payload":{"session_id":"other"}}"#,
                N
            ),
            None
        );
        assert_eq!(
            parse_spool_line(
                r#"{"v":1,"nonce":"stale","event":"SessionStart","payload":{"session_id":"other"}}"#,
                N
            ),
            None
        );

        assert_eq!(
            parse_spool_line(
                r#"{"v":1,"nonce":"n0nce","event":"hermes.fallback_running","payload":{"vendor_session_id":"new"}}"#,
                N
            ),
            Some(SpoolEvent::FallbackRunning)
        );

        let mut w = LaunchWatch::new(true);
        let mut s = test_session();
        s.vendor_session_id = Some("old".into());
        assert!(w.apply(&mut s, &fallback));
        // The fresh conversation has not started yet: the old one stays.
        assert_eq!(s.vendor_session_id.as_deref(), Some("old"));
        assert_eq!(
            s.agent_startup.as_ref().unwrap().state,
            AgentStartupState::Launching
        );
        assert!(w.apply(&mut s, &started));
        assert_eq!(s.vendor_session_id.as_deref(), Some("abc"));
        assert_eq!(
            s.agent_startup.as_ref().unwrap().state,
            AgentStartupState::Started
        );
        assert_eq!(s.agent_startup.as_ref().unwrap().confidence, "exact");
        assert!(!w.apply(&mut s, &SpoolEvent::Other));
        assert!(w.apply(&mut s, &SpoolEvent::Ended));
        assert_eq!(
            s.agent_startup.as_ref().unwrap().state,
            AgentStartupState::Ended
        );
    }

    #[test]
    fn the_helpers_exit_report_ends_the_startup_state_with_the_reason() {
        // An agent that never sent a start signal (declined trust prompt,
        // Ctrl-C at a prompt, command not found) still ends: hi run is its
        // parent and reports the exit.
        let mut s = test_session();
        s.agent_startup = Some(AgentStartup {
            state: AgentStartupState::WaitingAtStartupPrompt,
            since: now(),
            confidence: "guessed".into(),
            detail: None,
        });
        let mut w = LaunchWatch::new(true);
        assert!(w.apply(
            &mut s,
            &SpoolEvent::Exited {
                exit_code: 0,
                error: None
            }
        ));
        let st = s.agent_startup.clone().unwrap();
        assert_eq!(st.state, AgentStartupState::Ended);
        assert_eq!(st.confidence, "exact");
        assert_eq!(st.detail, None);

        w.apply(
            &mut s,
            &SpoolEvent::Exited {
                exit_code: 130,
                error: None,
            },
        );
        assert_eq!(
            s.agent_startup.as_ref().unwrap().detail.as_deref(),
            Some("the agent exited with status 130")
        );
        w.apply(
            &mut s,
            &SpoolEvent::Exited {
                exit_code: 127,
                error: Some("claude: command not found".into()),
            },
        );
        assert_eq!(
            s.agent_startup.as_ref().unwrap().detail.as_deref(),
            Some("claude: command not found")
        );
    }

    fn starting(state: AgentStartupState) -> Session {
        let mut s = test_session();
        s.vendor_session_id = Some("old".into());
        s.agent_startup = Some(AgentStartup {
            state,
            since: now(),
            confidence: "exact".into(),
            detail: None,
        });
        s
    }

    fn state(s: &Session) -> AgentStartupState {
        s.agent_startup.as_ref().unwrap().state
    }

    #[test]
    fn a_fallback_whose_fresh_agent_never_starts_keeps_the_old_conversation() {
        // The fresh agent after a fallback is stopped at its own trust
        // prompt (Ctrl-C there): Hermes must still resume the old id.
        let mut w = LaunchWatch::new(true);
        let mut s = starting(AgentStartupState::Launching);
        w.apply(
            &mut s,
            &SpoolEvent::ResumeFallback {
                vendor_session_id: Some("fresh".into()),
            },
        );
        // Still running past the window proves nothing for an agent that
        // sends its own start signal.
        assert!(!w.apply(&mut s, &SpoolEvent::FallbackRunning));
        w.apply(
            &mut s,
            &SpoolEvent::Exited {
                exit_code: 130,
                error: None,
            },
        );
        assert_eq!(s.vendor_session_id.as_deref(), Some("old"));
        assert_eq!(state(&s), AgentStartupState::Ended);
        w.apply(&mut s, &SpoolEvent::Ended);
        assert_eq!(s.vendor_session_id.as_deref(), Some("old"));
    }

    #[test]
    fn a_fresh_conversation_is_adopted_once_it_started() {
        // Claude's start signal carries its id; one without an id adopts
        // the pre-assigned one.
        let mut w = LaunchWatch::new(true);
        let mut s = starting(AgentStartupState::Launching);
        w.apply(
            &mut s,
            &SpoolEvent::ResumeFallback {
                vendor_session_id: Some("fresh".into()),
            },
        );
        w.apply(
            &mut s,
            &SpoolEvent::Started {
                vendor_session_id: None,
            },
        );
        assert_eq!(s.vendor_session_id.as_deref(), Some("fresh"));

        // An agent without a start signal (Gemini): still running past the
        // quick-failure window is when its conversation counts as started.
        let mut w = LaunchWatch::new(false);
        let mut s = starting(AgentStartupState::Launching);
        w.apply(
            &mut s,
            &SpoolEvent::ResumeFallback {
                vendor_session_id: Some("g-fresh".into()),
            },
        );
        assert_eq!(s.vendor_session_id.as_deref(), Some("old"));
        assert!(w.apply(&mut s, &SpoolEvent::FallbackRunning));
        assert_eq!(s.vendor_session_id.as_deref(), Some("g-fresh"));
        assert!(!w.apply(&mut s, &SpoolEvent::FallbackRunning), "once");

        // A vendor that cannot pre-assign an id (Codex): the dead id goes
        // once the fresh conversation runs, so the next launch starts fresh
        // instead of failing the same resume again.
        let mut w = LaunchWatch::new(false);
        let mut s = starting(AgentStartupState::Launching);
        w.apply(
            &mut s,
            &SpoolEvent::ResumeFallback {
                vendor_session_id: None,
            },
        );
        assert_eq!(s.vendor_session_id.as_deref(), Some("old"));
        w.apply(&mut s, &SpoolEvent::FallbackRunning);
        assert_eq!(s.vendor_session_id, None);
    }

    #[test]
    fn any_signal_from_the_agent_ends_the_startup_prompt_report() {
        for from in [
            AgentStartupState::WaitingAtStartupPrompt,
            AgentStartupState::Launching,
        ] {
            let mut w = LaunchWatch::new(true);
            let mut s = starting(from);
            assert!(w.apply(&mut s, &SpoolEvent::Other), "{from:?}");
            assert_eq!(state(&s), AgentStartupState::Started);
            assert_eq!(s.agent_startup.as_ref().unwrap().confidence, "exact");
        }
        // An ended agent stays ended.
        let mut w = LaunchWatch::new(true);
        let mut s = starting(AgentStartupState::Ended);
        assert!(!w.apply(&mut s, &SpoolEvent::Other));
        assert_eq!(state(&s), AgentStartupState::Ended);
    }

    #[test]
    fn typing_at_a_startup_prompt_clears_the_report() {
        let mut s = starting(AgentStartupState::WaitingAtStartupPrompt);
        assert!(note_user_input(&mut s, b"y"));
        assert_eq!(state(&s), AgentStartupState::Launching);
        assert_eq!(
            s.agent_startup.as_ref().unwrap().detail.as_deref(),
            Some("the startup prompt was answered")
        );
        for key in [&b"\r"[..], b"\x03", b"\x1b", b"1", "\u{e9}".as_bytes()] {
            let mut s = starting(AgentStartupState::WaitingAtStartupPrompt);
            assert!(note_user_input(&mut s, key), "{key:?}");
        }
        // The terminal answering the agent's own queries, focus reports and
        // arrow keys (which only move a selection) are not an answer.
        for noise in [
            &b"\x1b[12;40R"[..],
            b"\x1b[?62;22c",
            b"\x1b[>0;276;0c",
            b"\x1b[I",
            b"\x1b[O",
            b"\x1b]11;rgb:0000/0000/0000\x1b\\",
            b"\x1b[A",
            b"\x1bOB",
        ] {
            let mut s = starting(AgentStartupState::WaitingAtStartupPrompt);
            assert!(!note_user_input(&mut s, noise), "{noise:?}");
            assert_eq!(state(&s), AgentStartupState::WaitingAtStartupPrompt);
        }
        // Typing before the report restarts its wait (no visible change);
        // after the start, typing changes nothing.
        let mut s = starting(AgentStartupState::Launching);
        let before = s.agent_startup.clone().unwrap().since;
        std::thread::sleep(Duration::from_millis(2));
        assert!(!note_user_input(&mut s, b"x"));
        assert_eq!(state(&s), AgentStartupState::Launching);
        assert_ne!(s.agent_startup.as_ref().unwrap().since, before);
        let mut s = starting(AgentStartupState::Started);
        assert!(!note_user_input(&mut s, b"y"));
        assert_eq!(state(&s), AgentStartupState::Started);
    }

    #[test]
    fn the_startup_prompt_guess_comes_once_and_waits_for_typing() {
        let t0 = Instant::now();
        let at = |secs: u64| t0 + Duration::from_secs(secs);
        let mut g = PromptGuess::new(t0);
        let mut s = starting(AgentStartupState::Launching);
        assert!(!g.due(&s, at(0)));
        assert!(!g.due(&s, at(4)));
        assert!(g.due(&s, at(5)), "no start signal for 5 s");
        // The report is shown; the user answers the prompt.
        s.agent_startup.as_mut().unwrap().state = AgentStartupState::WaitingAtStartupPrompt;
        assert!(!g.due(&s, at(6)));
        std::thread::sleep(Duration::from_millis(2));
        note_user_input(&mut s, b"y");
        // An agent whose start signal never comes (hooks turned off) is
        // not reported as waiting again.
        assert!(!g.due(&s, at(7)));
        assert!(!g.due(&s, at(60)));

        // Typing before the report restarts the wait.
        let mut g = PromptGuess::new(t0);
        let mut s = starting(AgentStartupState::Launching);
        assert!(!g.due(&s, at(0)));
        std::thread::sleep(Duration::from_millis(2));
        note_user_input(&mut s, b"y");
        assert!(!g.due(&s, at(4)), "timer restarted at 4 s");
        assert!(!g.due(&s, at(8)));
        assert!(g.due(&s, at(9)));

        // A fallback's fresh agent gets its own guess.
        g.new_attempt(at(10));
        let mut w = LaunchWatch::new(true);
        std::thread::sleep(Duration::from_millis(2));
        w.apply(
            &mut s,
            &SpoolEvent::ResumeFallback {
                vendor_session_id: None,
            },
        );
        assert!(!g.due(&s, at(10)));
        assert!(g.due(&s, at(15)));

        // Nothing is due once the agent started or ended.
        let mut g = PromptGuess::new(t0);
        for st in [AgentStartupState::Started, AgentStartupState::Ended] {
            assert!(!g.due(&starting(st), at(30)));
        }
    }

    #[test]
    fn the_not_found_text_is_found_through_colours_wraps_and_redraws() {
        let claude = vec!["No conversation found with session ID".to_string()];
        let id = "0b6f5a1e-1111-4222-8333-444455556666";
        let cases = [
            // Plain, as a vendor printing to stderr does.
            format!("No conversation found with session ID: {id}\r\n"),
            // Coloured, as Claude's own error screen draws it.
            format!("\x1b[31mNo conversation found with session ID: {id}\x1b[39m\r\n"),
            // Wrapped by a narrow terminal.
            format!("No conversation found with\r\nsession ID: {id}"),
            // A redraw with cursor moves and a title between the words
            // (Windows' pseudo console does this).
            format!(
                "\x1b]0;claude\x07\x1b[1;1HNo conversation\x1b[1Cfound with session\x1b[K ID: {id}"
            ),
        ];
        for text in &cases {
            assert!(shows_not_found(text, &claude), "{text:?}");
        }
        for text in [
            "Do you trust the files in this folder?",
            "No conversation to continue",
            "fake-cli: bye (SIGINT)",
            "",
        ] {
            assert!(!shows_not_found(text, &claude), "{text:?}");
        }
        assert!(!shows_not_found("anything", &[String::new()]));
        assert_eq!(squash("\x1b(B A\tb\x1b[0m C"), "abc");
    }

    #[test]
    fn the_terminal_output_leaves_hi_the_evidence_once_the_text_shows() {
        let dir = tempfile::tempdir().unwrap();
        let evidence = dir.path().join(NOT_FOUND_EVIDENCE_FILE);
        let patterns = vec!["No conversation found with session ID".to_string()];
        start_output_watch("hermes-ev-1", &patterns, evidence.clone(), "n-ev");
        observe_output("hermes-ev-1", b"$ hi run hermes-ev-1\r\n\x1b[31mNo conver");
        assert!(!evidence.exists(), "half the text is not the text");
        // Another session's output is not this one's.
        observe_output(
            "hermes-ev-other",
            b"No conversation found with session ID: x",
        );
        assert!(!evidence.exists());
        observe_output(
            "hermes-ev-1",
            b"sation found with session ID: abc\x1b[39m\r\n",
        );
        assert_eq!(std::fs::read_to_string(&evidence).unwrap(), "n-ev\n");
        // The watch is over: it is not written again.
        std::fs::remove_file(&evidence).unwrap();
        observe_output("hermes-ev-1", b"No conversation found with session ID: abc");
        assert!(!evidence.exists());

        // A trust prompt interrupted with Ctrl-C shows no such text.
        start_output_watch("hermes-ev-2", &patterns, evidence.clone(), "n-ev2");
        observe_output(
            "hermes-ev-2",
            "Do you trust the files in this folder?\r\n^C".as_bytes(),
        );
        assert!(!evidence.exists());
        // A watch that ended (the agent started or exited) writes nothing.
        end_output_watch("hermes-ev-2");
        observe_output("hermes-ev-2", b"No conversation found with session ID: abc");
        assert!(!evidence.exists());
    }

    #[test]
    fn the_spool_reader_returns_only_whole_new_lines() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(SIGNALS_FILE);
        let mut reader = SpoolReader::new(file.clone());
        assert!(reader.poll().is_empty(), "no file yet");
        std::fs::write(&file, "{\"a\":1}\n{\"b\":").unwrap();
        assert_eq!(reader.poll(), vec!["{\"a\":1}".to_string()]);
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap();
        f.write_all(b"2}\n\n{\"c\":3}\n").unwrap();
        drop(f);
        assert_eq!(
            reader.poll(),
            vec!["{\"b\":2}".to_string(), "{\"c\":3}".to_string()]
        );
        assert!(reader.poll().is_empty());
    }

    #[test]
    fn a_task_the_fallback_launch_cannot_carry_is_handed_back_once() {
        let mut s = test_session();
        s.task_prompt = Some("fix the login bug".into());
        assert_eq!(
            take_undelivered_task(&mut s).as_deref(),
            Some("fix the login bug")
        );
        assert_eq!(s.task_prompt, None);
        assert_eq!(take_undelivered_task(&mut s), None);
    }

    #[test]
    fn no_task_means_nothing_to_hand_back() {
        let mut s = test_session();
        assert_eq!(take_undelivered_task(&mut s), None);
    }

    #[test]
    fn an_agent_without_a_first_prompt_already_had_its_task_copied() {
        let mut s = test_session();
        s.ai_provider = Some("custom".into());
        s.task_prompt = Some("fix the login bug".into());
        assert_eq!(take_undelivered_task(&mut s), None);
        assert_eq!(s.task_prompt, None);
    }

    fn test_session() -> Session {
        use super::super::models::{SessionMetrics, SessionMode};
        use std::collections::HashMap;
        Session {
            id: "hermes-1".into(),
            label: "t".into(),
            description: String::new(),
            color: String::new(),
            group: None,
            phase: SessionPhase::Idle,
            working_directory: "/fixture-home".into(),
            shell: "/bin/zsh".into(),
            created_at: now(),
            last_activity_at: now(),
            workspace_paths: vec![],
            detected_agent: None,
            metrics: SessionMetrics {
                output_lines: 0,
                error_count: 0,
                stuck_score: 0.0,
                token_usage: HashMap::new(),
                tool_calls: vec![],
                tool_call_summary: HashMap::new(),
                files_touched: vec![],
                recent_errors: vec![],
                recent_actions: vec![],
                available_actions: vec![],
                memory_facts: vec![],
                latency_p50_ms: None,
                latency_p95_ms: None,
                latency_samples: vec![],
                token_history: vec![],
            },
            ai_provider: Some("claude".into()),
            auto_approve: false,
            permission_mode: "default".into(),
            custom_prefix: String::new(),
            custom_suffix: String::new(),
            agent_name: String::new(),
            agent_command: String::new(),
            channels: vec![],
            context_injected: false,
            has_initial_context: false,
            last_nudged_version: 0,
            pending_nudge: None,
            ssh_info: None,
            mode: SessionMode::Terminal,
            vendor_session_id: None,
            agent_startup: None,
            hosted: false,
            launch_helper: true,
            signal_nonce: None,
            task_prompt: None,
            seed_prompt: None,
            parent_session_id: None,
        }
    }
}
