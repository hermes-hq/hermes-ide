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
//! command plus a fresh-start fallback; when the resume fails at once `hi`
//! prints one line, starts fresh and reports the new id through the signal
//! spool this module watches.

use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
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
/// A resume that exits non-zero within this window is a failed resume.
pub const RESUME_FALLBACK_AFTER_MS: u64 = 3000;
const LAUNCH_FILE: &str = "launch.json";
const SIGNALS_FILE: &str = "signals.ndjson";
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
    /// The conversation to resume (a restored session's saved id).
    pub resume_id: Option<&'a str>,
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
    /// The nonce every spool line of this launch must carry.
    pub nonce: String,
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

/// Path as it goes into a hook command string: forward slashes work for
/// cmd.exe, PowerShell and bash alike, and need no escaping inside quotes.
fn hook_path(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// The hook command that reports one event to Hermes.
fn signal_command(hi: &Path, agent_id: &str, event: &str) -> String {
    format!(
        "\"{}\" signal --agent {agent_id} --event {event}",
        hook_path(hi)
    )
}

/// The vendor events the catalog lists for `status` that a hook file can
/// name directly (an entry with a matcher, `Event:Matcher`, is left to F11).
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

/// The per-launch hook file for the `settings_file` method (Claude's
/// settings shape): hooks only, so it merges on top of the user's own
/// settings without replacing anything.
pub fn settings_file_json(agent: &Agent, hi: &Path) -> String {
    let mut hooks = serde_json::Map::new();
    for status in ["session_start", "exited"] {
        for event in plain_events(agent, status) {
            hooks.insert(
                event.to_string(),
                serde_json::json!([{ "hooks": [{
                    "type": "command",
                    "command": signal_command(hi, &agent.id, event),
                    "timeout": 5
                }]}]),
            );
        }
    }
    serde_json::to_string_pretty(&serde_json::json!({ "hooks": hooks })).unwrap_or_default()
}

/// The per-launch defaults file for the `env_file` method (Gemini's
/// settings shape, lowest precedence). Its hooks run in a sanitized
/// environment, so the Hermes variables travel in each hook's `env`.
pub fn env_file_json(agent: &Agent, hi: &Path, env: &BTreeMap<String, String>) -> String {
    let hook_env: serde_json::Map<String, serde_json::Value> = env
        .iter()
        .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
        .collect();
    let mut hooks = serde_json::Map::new();
    for status in ["session_start", "exited"] {
        for event in plain_events(agent, status) {
            hooks.insert(
                event.to_string(),
                serde_json::json!([{ "hooks": [{
                    "name": format!("hermes-{}", event.to_lowercase()),
                    "type": "command",
                    "command": signal_command(hi, &agent.id, event),
                    "env": hook_env,
                    "timeout": 5000
                }]}]),
            );
        }
    }
    serde_json::to_string_pretty(&serde_json::json!({ "hooks": hooks })).unwrap_or_default()
}

/// What the catalog's `signals` block becomes for one launch.
struct SignalSetup {
    args: Vec<String>,
    env: BTreeMap<String, String>,
    files: Vec<(PathBuf, String)>,
    expects_start_signal: bool,
}

fn signal_setup(
    agent: &Agent,
    hi: &Path,
    session_dir: &Path,
    hermes_env: &BTreeMap<String, String>,
) -> SignalSetup {
    let signals = &agent.terminal.signals;
    let has_start = plain_events(agent, "session_start").next().is_some();
    let mut setup = SignalSetup {
        args: Vec::new(),
        env: BTreeMap::new(),
        files: Vec::new(),
        expects_start_signal: false,
    };
    let file = match signals.method.as_str() {
        "settings_file" => Some((
            session_dir.join(format!("{}.settings.json", agent.id)),
            settings_file_json(agent, hi),
        )),
        "env_file" => Some((
            session_dir.join(format!("{}.defaults.json", agent.id)),
            env_file_json(agent, hi, hermes_env),
        )),
        // Config flags carry `{hi}` and need no file. Plugin folders,
        // worktree files and event streams are F11's work: no signal setup
        // for them yet, so those agents start with the plain command.
        "config_flags" => None,
        _ => return setup,
    };
    let file_str = file
        .as_ref()
        .map(|(p, _)| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let dir_str = session_dir.to_string_lossy().to_string();
    let hi_str = hook_path(hi);
    let vars: [(&str, &str); 3] = [
        ("signals_file", file_str.as_str()),
        ("signals_dir", dir_str.as_str()),
        ("hi", hi_str.as_str()),
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
    }
    setup
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
    let signals = signal_setup(agent, input.hi, input.session_dir, &env);
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
    let prompt_args: Vec<String> = match (&terminal.initial_prompt, input.context_path) {
        (Some(template), Some(ctx)) => fill(template, &[("prompt", &context_prompt(ctx))]),
        _ => Vec::new(),
    };
    let context_in_args = !prompt_args.is_empty();
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
            let fallback = FallbackSpec {
                program: program.clone(),
                args: fresh_args.clone(),
                after_ms: RESUME_FALLBACK_AFTER_MS,
                vendor_session_id: fresh_id.clone(),
                message: "could not resume the previous conversation; starting a new one"
                    .to_string(),
            };
            (args, Some(fallback), Some(id.to_string()), true)
        }
        None => (fresh_args, None, fresh_id, false),
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
        nonce: input.nonce.to_string(),
    })
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
pub fn clear_launch_dir<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Ok(dir) = launch_dir(app) {
        if dir.is_dir() {
            if let Err(e) = std::fs::remove_dir_all(&dir) {
                log::warn!("[LAUNCH] could not clear {}: {}", dir.display(), e);
            }
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
    pub session_dir: PathBuf,
    pub expects_start_signal: bool,
    pub nonce: String,
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
    recipe_for(&provider)?;
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
    let plan = plan_launch(&LaunchInput {
        session_id: &s.id,
        provider: &provider,
        permission_mode: &s.permission_mode,
        custom_prefix: &s.custom_prefix,
        custom_suffix: &s.custom_suffix,
        channels: &s.channels,
        cwd: &s.working_directory,
        context_path: context_path.as_deref(),
        resume_id: s.vendor_session_id.as_deref(),
        hi: &hi,
        session_dir: &session_dir,
        new_session_id: &new_session_id,
        nonce: &nonce,
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
    s.vendor_session_id = plan.vendor_session_id.clone();
    s.agent_startup = Some(AgentStartup {
        state: AgentStartupState::Launching,
        since: now(),
        confidence: "exact".to_string(),
        detail: plan
            .resumes
            .then(|| "resuming the previous conversation".to_string()),
    });
    Some(PreparedLaunch {
        line: format!("hi run {}", s.id),
        context_in_args: plan.context_in_args,
        session_dir,
        expects_start_signal: plan.expects_start_signal,
        nonce: plan.nonce,
    })
}

fn write_plan(session_dir: &Path, plan: &LaunchPlan) -> std::io::Result<()> {
    std::fs::create_dir_all(session_dir)?;
    for (path, contents) in &plan.files {
        std::fs::write(path, contents)?;
    }
    let json = serde_json::to_string_pretty(&plan.spec)
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    std::fs::write(session_dir.join(LAUNCH_FILE), json)
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
    Ended,
    /// `hi run` itself reporting that the agent process is gone (it is the
    /// agent's parent, so this comes even when no SessionEnd hook ran: a
    /// declined trust prompt, Ctrl-C at a prompt, a command not found).
    Exited {
        exit_code: i64,
        error: Option<String>,
    },
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
        "SessionEnd" => SpoolEvent::Ended,
        "hermes.exited" => SpoolEvent::Exited {
            exit_code: payload
                .and_then(|p| p.get("exit_code"))
                .and_then(|x| x.as_i64())
                .unwrap_or(-1),
            error: payload_str("error"),
        },
        _ => SpoolEvent::Other,
    })
}

/// Apply one spool event to the session. Returns true when something the
/// frontend shows changed.
pub fn apply_spool_event(s: &mut Session, event: &SpoolEvent) -> bool {
    match event {
        SpoolEvent::Started { vendor_session_id } => {
            if let Some(id) = vendor_session_id {
                s.vendor_session_id = Some(id.clone());
            }
            s.agent_startup = Some(AgentStartup {
                state: AgentStartupState::Started,
                since: now(),
                confidence: "exact".to_string(),
                detail: None,
            });
            true
        }
        SpoolEvent::ResumeFallback { vendor_session_id } => {
            s.vendor_session_id = vendor_session_id.clone();
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
        SpoolEvent::Other => false,
    }
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

/// Watch a session's signal spool from the launch until the agent process
/// is gone (or the session is): start and end signals, the resume fallback,
/// `hi run`'s own exit report, and the "no start signal yet" guess.
pub(crate) fn watch_signals(
    app: AppHandle,
    session: Arc<StdMutex<Session>>,
    session_dir: PathBuf,
    expects_start_signal: bool,
    nonce: String,
) {
    std::thread::spawn(move || {
        let mut reader = SpoolReader::new(session_dir.join(SIGNALS_FILE));
        let mut launched_at = Instant::now();
        loop {
            std::thread::sleep(SPOOL_POLL);
            let lines = reader.poll();
            let mut changed = false;
            let mut stop = false;
            let mut guess_waiting = false;
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
                            launched_at = Instant::now();
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
                        changed |= apply_spool_event(&mut s, &event);
                    }
                }
                let launching = matches!(
                    s.agent_startup.as_ref().map(|a| a.state),
                    Some(AgentStartupState::Launching)
                );
                if expects_start_signal
                    && launching
                    && !stop
                    && launched_at.elapsed() >= STARTUP_PROMPT_GUESS_AFTER
                {
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
            if guess_waiting {
                log::info!(
                    "[LAUNCH] no start signal after {:?}; reporting a startup prompt (guessed)",
                    STARTUP_PROMPT_GUESS_AFTER
                );
            }
            if stop {
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
            resume_id,
            hi,
            session_dir,
            new_session_id: "11111111-2222-4333-8444-555555555555",
            nonce: "n0nce",
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

        // The settings file holds hooks only, both calling hi.
        let (path, contents) = &plan.files[0];
        assert_eq!(path, &dir.join("claude.settings.json"));
        let json: serde_json::Value = serde_json::from_str(contents).unwrap();
        assert_eq!(
            json.as_object().unwrap().keys().collect::<Vec<_>>(),
            vec!["hooks"]
        );
        let start = &json["hooks"]["SessionStart"][0]["hooks"][0];
        assert_eq!(start["type"], "command");
        assert_eq!(
            start["command"],
            "\"/app/hi\" signal --agent claude --event SessionStart"
        );
        assert!(json["hooks"]["SessionEnd"].is_array());
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
        // Codex cannot pre-assign an id: a fresh start carries none.
        assert_eq!(plan.spec.fallback.unwrap().vendor_session_id, None);
        let fresh_codex = plan_launch(&input("codex", None, hi, dir)).unwrap();
        assert_eq!(fresh_codex.vendor_session_id, None);
        assert_eq!(fresh_codex.spec.args[0], "-c");
        assert!(!fresh_codex.spec.args.iter().any(|a| a == "resume"));

        let gemini = plan_launch(&input("gemini", Some("g-1"), hi, dir)).unwrap();
        assert_eq!(gemini.spec.args, vec!["--resume", "g-1"]);
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
        assert_eq!(kiro.spec.fallback.unwrap().args, vec!["chat"]);
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
        assert!(json["env"]["HERMES_SIGNAL_FILE"].is_string());
        // Hook command paths use forward slashes so cmd, PowerShell and bash
        // all accept them inside quotes.
        let settings: serde_json::Value = serde_json::from_str(&plan.files[0].1).unwrap();
        assert_eq!(
            settings["hooks"]["SessionStart"][0]["hooks"][0]["command"],
            "\"C:/Program Files/Hermes/hi.exe\" signal --agent claude --event SessionStart"
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

        let mut s = test_session();
        s.vendor_session_id = Some("old".into());
        assert!(apply_spool_event(&mut s, &fallback));
        assert_eq!(s.vendor_session_id.as_deref(), Some("new"));
        assert_eq!(
            s.agent_startup.as_ref().unwrap().state,
            AgentStartupState::Launching
        );
        assert!(apply_spool_event(&mut s, &started));
        assert_eq!(s.vendor_session_id.as_deref(), Some("abc"));
        assert_eq!(
            s.agent_startup.as_ref().unwrap().state,
            AgentStartupState::Started
        );
        assert_eq!(s.agent_startup.as_ref().unwrap().confidence, "exact");
        assert!(!apply_spool_event(&mut s, &SpoolEvent::Other));
        assert!(apply_spool_event(&mut s, &SpoolEvent::Ended));
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
        assert!(apply_spool_event(
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

        apply_spool_event(
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
        apply_spool_event(
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
            launch_helper: true,
        }
    }
}
