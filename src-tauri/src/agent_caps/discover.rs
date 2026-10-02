//! Capability discovery: run an installed CLI's read-only probes and build
//! what the launcher may offer for one agent and account.
//!
//! Probes are the catalog's (`capabilities.accounts.probe`,
//! `capabilities.model.list`) plus the detect command for the version. They
//! run with the PATH a new terminal gets (`agent_doctor::search_dirs`) and,
//! for an account Hermes added, that account's profile variable
//! (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, …), and only read: nothing here
//! signs in, signs out or writes a vendor file. What a probe prints is
//! parsed on the spot (`parse`) and dropped; only the facts in
//! `AgentCapabilities` are kept, and nothing a probe printed is logged.
//!
//! The result is cached per agent, account and CLI version (`CapsCache`):
//! an update of the CLI or a refresh asked for by the person runs the
//! probes again.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::choice::{DEFAULT_ACCOUNT, DEFAULT_MODEL};
use super::parse::{self, AgyModels, AuthInfo, ListedModel};
use super::store::StoredAccount;
use super::types::*;
use crate::agent_catalog::{Agent, ModelList};
use crate::agent_doctor::Probe;

const VERSION_TIMEOUT: Duration = Duration::from_secs(8);
const PROBE_TIMEOUT: Duration = Duration::from_secs(12);
/// A model list can be long (`codex debug models` carries instructions).
pub const LIST_OUTPUT_CAP: usize = 4 * 1024 * 1024;

/// A model an account refused at an earlier launch (`store::rejections`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub model: String,
    /// When (epoch ms).
    pub at: i64,
    /// The default model only: the model the CLI resolved "default" to, when
    /// its refusal named it (Codex's `model` in its config.toml).
    pub resolved: Option<String>,
}

/// Order of the approval modes, whatever order the catalog lists them in.
const MODE_ORDER: &[&str] = &[
    "default",
    "acceptEdits",
    "plan",
    "auto",
    "dontAsk",
    "bypassPermissions",
];

fn mode_text(id: &str) -> (&'static str, &'static str, bool) {
    match id {
        "default" => ("Ask", "Every edit and every command asks you first.", false),
        "acceptEdits" => (
            "Accept edits",
            "Edits inside the working folder run; commands, network and other folders ask.",
            false,
        ),
        "plan" => (
            "Plan first",
            "Reads and writes a plan. Nothing changes until you approve it.",
            false,
        ),
        "auto" => (
            "Auto",
            "Runs without asking; the agent's own safety checks stop risky actions.",
            false,
        ),
        "dontAsk" => (
            "Don't ask",
            "Only tools you allowed run; anything else is refused without asking.",
            false,
        ),
        "bypassPermissions" => (
            "Skip all",
            "Never asks, for anything. Only in a throwaway worktree.",
            true,
        ),
        _ => ("Mode", "", false),
    }
}

/// How discovery reaches the machine; the real one runs processes and
/// reads files, tests pass fakes.
pub trait Host {
    /// Resolve a binary name on the terminal PATH.
    fn find(&self, name: &str) -> Option<PathBuf>;
    /// Run a probe: binary, arguments, extra environment, output cap, deadline.
    fn run(
        &self,
        bin: &Path,
        args: &[String],
        env: &[(String, String)],
        cap: usize,
        timeout: Duration,
    ) -> Probe;
    /// Read a small file (a CLI's own cache); None when missing.
    fn read(&self, path: &Path) -> Option<String>;
    /// The home folder (profile folders and the default Claude config live there).
    fn home(&self) -> Option<PathBuf>;
    fn now_ms(&self) -> i64;
    /// A variable of Hermes's own environment, when set and not empty.
    fn env(&self, name: &str) -> Option<String>;
}

/// The accounts to probe for an agent: its default profile, then the ones
/// Hermes added (each with its profile variable).
pub fn account_list(
    agent: &Agent,
    stored: &[StoredAccount],
) -> Vec<(String, String, Option<ProfileEnv>)> {
    let mut out = vec![(
        DEFAULT_ACCOUNT.to_string(),
        "Default profile".to_string(),
        None,
    )];
    let env_name = agent
        .capabilities
        .as_ref()
        .and_then(|c| c.accounts.profile_env.clone());
    if let Some(name) = env_name {
        for a in stored {
            out.push((
                a.id.clone(),
                a.label.clone(),
                Some(ProfileEnv {
                    name: name.clone(),
                    value: a.profile_dir.clone(),
                }),
            ));
        }
    }
    out
}

fn env_of(p: &Option<ProfileEnv>) -> Vec<(String, String)> {
    p.iter()
        .map(|e| (e.name.clone(), e.value.clone()))
        .collect()
}

/// What a run of the account probe said.
fn probe_auth(
    host: &dyn Host,
    bin: &Path,
    args: &[String],
    parser: &str,
    env: &[(String, String)],
    list_output: &mut Option<Probe>,
) -> AuthInfo {
    let probe = if parser == "agy_models" {
        let p = host.run(bin, args, env, LIST_OUTPUT_CAP, PROBE_TIMEOUT);
        *list_output = Some(p.clone());
        p
    } else {
        host.run(bin, args, env, 64 * 1024, PROBE_TIMEOUT)
    };
    match probe {
        Probe::Exited { code, output } => match parser {
            "claude_auth_json" => parse::claude_auth(&output, code),
            "codex_login_status" => parse::codex_login_status(&output, code),
            "agy_models" => match parse::agy_models(&output) {
                AgyModels::SignedOut => AuthInfo {
                    signed_in: Some(false),
                    detail: "not signed in".into(),
                },
                AgyModels::Listed(m) if code == 0 && !m.is_empty() => AuthInfo {
                    signed_in: Some(true),
                    detail: "Google account".into(),
                },
                _ => AuthInfo {
                    signed_in: None,
                    detail: String::new(),
                },
            },
            _ => parse::exit_code_auth(code),
        },
        Probe::TimedOut | Probe::Failed => AuthInfo {
            signed_in: None,
            detail: String::new(),
        },
    }
}

/// Build one agent's capabilities for `account_id` (None: the active one).
/// `rejections`: the models the account refused at an earlier launch.
pub fn discover(
    agent: &Agent,
    stored: &[StoredAccount],
    account_id: Option<&str>,
    rejections: &dyn Fn(&str) -> Vec<Refusal>,
    host: &dyn Host,
) -> AgentCapabilities {
    let spec = agent.capabilities.as_ref();
    let terminal = &agent.terminal;
    let default_mode = terminal
        .safety
        .as_ref()
        .map(|s| s.default_mode.clone())
        .unwrap_or_else(|| "default".to_string());
    let approval_modes: Vec<ApprovalModeOption> = MODE_ORDER
        .iter()
        .filter_map(|id| {
            let flag = terminal.permission_flags.get(*id)?;
            let (label, note, danger) = mode_text(id);
            Some(ApprovalModeOption {
                id: id.to_string(),
                label: label.to_string(),
                flag: flag.clone(),
                note: note.to_string(),
                danger,
            })
        })
        .collect();
    let status_source = match terminal.signals.confidence.as_str() {
        "exact" | "signal" => "exact",
        _ => "guessed",
    }
    .to_string();

    let mut caps = AgentCapabilities {
        agent_id: agent.id.clone(),
        cli_version: None,
        installed: false,
        verified_on_real_install: spec.is_some_and(|s| s.verified_on_real_install),
        accounts: Vec::new(),
        active_account_id: None,
        can_add_account: spec
            .is_some_and(|s| s.accounts.profile_env.is_some() && s.accounts.profile_dir.is_some()),
        models: Vec::new(),
        model_source: "aliases".to_string(),
        approval_modes,
        status_source,
        agent_name: agent.name.clone(),
        effort_values: spec
            .and_then(|s| s.effort.as_ref())
            .map(|e| e.values.clone())
            .unwrap_or_default(),
        effort_validated_by: spec
            .and_then(|s| s.effort.as_ref())
            .map(|e| e.validated_by.clone())
            .unwrap_or_else(|| "none".to_string()),
        accepts_typed_model: spec.is_some_and(|s| s.model.typed && s.model.flag.is_some()),
        account_note: spec.and_then(|s| s.accounts.note.clone()),
        default_approval_mode_id: default_mode,
        checked_at: host.now_ms(),
        default_profile_dir: spec
            .and_then(|s| s.accounts.profile_env.as_deref())
            .and_then(|name| host.env(name)),
    };

    // Installed, and which version.
    let bin = agent
        .detect
        .as_ref()
        .and_then(|d| d.command.split_first())
        .and_then(|(bin, args)| host.find(bin).map(|p| (p, args.to_vec())));
    // A CLI that cannot start (see `agent_doctor::broken_reason`) cannot say
    // whether an account is signed in: its accounts are "unknown" with the
    // reason, never "signed out" (a sign-in would fail the same way).
    let mut broken: Option<String> = None;
    if let Some((path, args)) = &bin {
        caps.installed = true;
        let run = host.run(path, args, &[], 16 * 1024, VERSION_TIMEOUT);
        if let Probe::Exited { output, .. } = &run {
            caps.cli_version = crate::agent_doctor::parse_version(output);
        }
        broken = crate::agent_doctor::broken_reason(&run, caps.cli_version.as_deref());
    }

    // Accounts.
    let list = account_list(agent, stored);
    let mut list_output_by_account: HashMap<String, Probe> = HashMap::new();
    for (id, label, profile_env) in &list {
        let mut info = AuthInfo {
            signed_in: None,
            detail: broken
                .as_ref()
                .map(|why| format!("fails to start: {why}"))
                .unwrap_or_default(),
        };
        if let (true, None, Some(probe)) = (
            caps.installed,
            broken.as_ref(),
            spec.and_then(|s| s.accounts.probe.as_ref()),
        ) {
            if let Some((pbin, pargs)) = probe.command.split_first() {
                if let Some(ppath) = host.find(pbin) {
                    let mut listed = None;
                    info = probe_auth(
                        host,
                        &ppath,
                        pargs,
                        &probe.parser,
                        &env_of(profile_env),
                        &mut listed,
                    );
                    if let Some(p) = listed {
                        list_output_by_account.insert(id.clone(), p);
                    }
                }
            }
        }
        let state = match info.signed_in {
            Some(true) => "signed-in",
            Some(false) => "signed-out",
            None => "unknown",
        };
        let detail = if !info.detail.is_empty() {
            info.detail
        } else if state == "unknown" {
            "sign-in not checked".to_string()
        } else {
            String::new()
        };
        caps.accounts.push(AgentAccount {
            id: id.clone(),
            label: label.clone(),
            detail,
            profile_env: profile_env.clone(),
            signed_in: info.signed_in != Some(false),
            sign_in_state: state.to_string(),
        });
    }
    caps.active_account_id = account_id
        .filter(|want| caps.accounts.iter().any(|a| a.id == *want))
        .map(str::to_string)
        .or_else(|| {
            caps.accounts
                .iter()
                .find(|a| a.id == DEFAULT_ACCOUNT && a.signed_in)
                .or_else(|| caps.accounts.iter().find(|a| a.signed_in))
                .map(|a| a.id.clone())
        })
        .or_else(|| Some(DEFAULT_ACCOUNT.to_string()));
    let active = caps.active_account_id.clone().unwrap_or_default();
    let active_env = caps
        .accounts
        .iter()
        .find(|a| a.id == active)
        .and_then(|a| a.profile_env.clone());

    // Models: default first, then the catalog's aliases, then the CLI's list.
    let effort = spec.and_then(|s| s.effort.as_ref());
    let mut listed: Vec<ListedModel> = Vec::new();
    let mut from_cli = false;
    if let Some(spec) = spec {
        match (&spec.model.list, caps.installed) {
            (Some(ModelList::Command { command, parser }), true) => {
                let output = match list_output_by_account.remove(&active) {
                    Some(p) if parser == "agy_models" => Some(p),
                    _ => command.split_first().and_then(|(lbin, largs)| {
                        host.find(lbin).map(|lpath| {
                            host.run(
                                &lpath,
                                largs,
                                &env_of(&active_env),
                                LIST_OUTPUT_CAP,
                                PROBE_TIMEOUT,
                            )
                        })
                    }),
                };
                if let Some(Probe::Exited { code: 0, output }) = output {
                    let parsed = match parser.as_str() {
                        "codex_debug_models" => parse::codex_models(&output),
                        "agy_models" => match parse::agy_models(&output) {
                            AgyModels::Listed(m) => Some(m),
                            AgyModels::SignedOut => None,
                        },
                        _ => Some(parse::model_lines(&output)),
                    };
                    if let Some(models) = parsed.filter(|m| !m.is_empty()) {
                        listed = models;
                        from_cli = true;
                    }
                }
            }
            (Some(ModelList::Cache { source }), _) if source == "claude_model_cache" => {
                let file = match &active_env {
                    Some(p) => Some(PathBuf::from(&p.value).join(".claude.json")),
                    None => host.home().map(|h| h.join(".claude.json")),
                };
                if let Some(text) = file.and_then(|f| host.read(&f)) {
                    listed = parse::claude_model_cache(&text);
                }
            }
            _ => {}
        }
    }

    let default_efforts = if from_cli && listed.iter().any(|m| m.efforts.is_some()) {
        // Codex's default is whatever its config says: offer only the levels
        // every listed model takes.
        let mut common: Option<Vec<String>> = None;
        for m in &listed {
            let e = parse::efforts_for(effort, &m.id, m.efforts.as_deref());
            common = Some(match common {
                None => e,
                Some(c) => c.into_iter().filter(|x| e.contains(x)).collect(),
            });
        }
        common.unwrap_or_default()
    } else {
        parse::efforts_for(effort, DEFAULT_MODEL, None)
    };
    caps.models.push(ModelOption {
        id: DEFAULT_MODEL.to_string(),
        label: "Default".to_string(),
        note: Some(format!("{} picks", agent.name)),
        efforts: default_efforts,
        available: true,
        unavailable_reason: None,
        unavailable_code: None,
    });
    if let Some(spec) = spec {
        if spec.model.flag.is_some() {
            for a in &spec.model.aliases {
                caps.models.push(ModelOption {
                    id: a.id.clone(),
                    label: a.label.clone(),
                    note: a.note.clone(),
                    efforts: parse::efforts_for(effort, &a.id, None),
                    available: true,
                    unavailable_reason: None,
                    unavailable_code: None,
                });
            }
            for m in &listed {
                if caps.models.iter().any(|x| x.id == m.id) {
                    continue;
                }
                caps.models.push(ModelOption {
                    id: m.id.clone(),
                    label: m.label.clone(),
                    note: m.note.clone(),
                    efforts: parse::efforts_for(effort, &m.id, m.efforts.as_deref()),
                    available: true,
                    unavailable_reason: None,
                    unavailable_code: None,
                });
            }
        }
        caps.model_source = if from_cli {
            "cli-list"
        } else if !spec.model.aliases.is_empty()
            || !listed.is_empty()
            || !spec.model.typed
            || spec.model.flag.is_none()
        {
            "aliases"
        } else {
            "free-text"
        }
        .to_string();
    }
    for r in rejections(&active) {
        let Some(m) = caps.models.iter_mut().find(|m| m.id == r.model) else {
            continue;
        };
        if m.id == DEFAULT_MODEL {
            // The default stays launchable (the CLI's own setting may have
            // changed since), but it no longer reads as a sure thing.
            m.unavailable_reason = Some(match &r.resolved {
                Some(name) => format!(
                    "{}'s default model, {name}, was refused by this account at its last launch",
                    agent.name
                ),
                None => format!(
                    "{}'s default model was refused by this account at its last launch",
                    agent.name
                ),
            });
            m.unavailable_code = Some("refused".to_string());
            continue;
        }
        m.available = false;
        m.unavailable_reason = Some(format!(
            "{} was refused by this account at its last launch",
            m.id
        ));
        m.unavailable_code = Some("refused".to_string());
    }
    caps
}

// ─── The real machine ────────────────────────────────────────────────

pub struct RealHost {
    dirs: Vec<PathBuf>,
    path_env: OsString,
}

impl RealHost {
    pub fn new() -> Self {
        let dirs = crate::agent_doctor::search_dirs();
        let path_env = std::env::join_paths(&dirs).unwrap_or_default();
        RealHost { dirs, path_env }
    }
}

impl Default for RealHost {
    fn default() -> Self {
        Self::new()
    }
}

impl Host for RealHost {
    fn find(&self, name: &str) -> Option<PathBuf> {
        crate::agent_doctor::find_in(&self.dirs, name)
    }
    fn run(
        &self,
        bin: &Path,
        args: &[String],
        env: &[(String, String)],
        cap: usize,
        timeout: Duration,
    ) -> Probe {
        crate::agent_doctor::run_probe_with(bin, args, &self.path_env, env, cap, timeout)
    }
    fn read(&self, path: &Path) -> Option<String> {
        let meta = std::fs::metadata(path).ok()?;
        if meta.len() > 32 * 1024 * 1024 {
            return None;
        }
        std::fs::read_to_string(path).ok()
    }
    fn home(&self) -> Option<PathBuf> {
        dirs::home_dir()
    }
    fn now_ms(&self) -> i64 {
        crate::turn_ledger::now_ms()
    }
    fn env(&self, name: &str) -> Option<String> {
        std::env::var(name).ok().filter(|v| !v.is_empty())
    }
}

// ─── Cache ───────────────────────────────────────────────────────────

/// How long a result is trusted without asking the CLI for its version again.
const VERSION_RECHECK: Duration = Duration::from_secs(60);
/// How long a result is kept at most (sign-in can change outside Hermes).
const MAX_AGE: Duration = Duration::from_secs(2 * 60);
/// The same for a CLI whose probe rewrites its own sign-in files on every
/// run (Antigravity's `agy models` rewrites ~/.gemini/oauth_creds.json):
/// it is run at most this often, unless the person asks for a refresh or a
/// launch was refused.
const QUIET_MAX_AGE: Duration = Duration::from_secs(30 * 60);

/// Whether an agent's account probe rewrites the CLI's own files when it
/// runs (so it runs as rarely as possible).
fn probe_rewrites_vendor_files(agent: &Agent) -> bool {
    agent
        .capabilities
        .as_ref()
        .and_then(|c| c.accounts.probe.as_ref())
        .is_some_and(|p| p.parser == "agy_models")
}

#[derive(Debug, PartialEq, Eq)]
enum Freshness {
    Good,
    IfSameVersion,
    Stale,
}

fn freshness(age: Duration, quiet: bool) -> Freshness {
    if age < VERSION_RECHECK || (quiet && age < QUIET_MAX_AGE) {
        Freshness::Good
    } else if age < MAX_AGE {
        Freshness::IfSameVersion
    } else {
        Freshness::Stale
    }
}

struct Cached {
    caps: AgentCapabilities,
    at: Instant,
}

fn cache() -> &'static Mutex<HashMap<(String, String), Cached>> {
    static CACHE: OnceLock<Mutex<HashMap<(String, String), Cached>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A cached result for (agent, account) that is still good: younger than
/// VERSION_RECHECK, or younger than MAX_AGE with the same CLI version.
pub fn cached(
    agent: &Agent,
    account: &str,
    current_version: impl FnOnce() -> Option<String>,
) -> Option<AgentCapabilities> {
    let map = cache().lock().ok()?;
    let hit = map.get(&(agent.id.clone(), account.to_string()))?;
    match freshness(hit.at.elapsed(), probe_rewrites_vendor_files(agent)) {
        Freshness::Good => Some(hit.caps.clone()),
        Freshness::IfSameVersion => {
            let caps = hit.caps.clone();
            drop(map);
            (current_version() == caps.cli_version).then_some(caps)
        }
        Freshness::Stale => None,
    }
}

/// Any cached result of an agent, whatever its age or account (the model
/// list is the same for every account of the CLIs that list models).
pub fn peek(agent_id: &str) -> Option<AgentCapabilities> {
    let map = cache().lock().ok()?;
    map.iter()
        .filter(|((a, _), _)| a == agent_id)
        .max_by_key(|(_, c)| c.at)
        .map(|(_, c)| c.caps.clone())
}

/// How many times each agent's cached results were forgotten. A probe that
/// started before the last time (it read the accounts as they were then)
/// is not cached: an account added meanwhile would otherwise stay missing
/// until the result aged out.
fn generations() -> &'static Mutex<HashMap<String, u64>> {
    static GENERATIONS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    GENERATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The agent's cache generation now; pass it to `store_cached` after the probe.
pub fn generation(agent_id: &str) -> u64 {
    generations()
        .lock()
        .map(|g| g.get(agent_id).copied().unwrap_or(0))
        .unwrap_or(0)
}

/// Keeps a probe's result, unless the agent's results were forgotten since
/// the probe started (`started_at`, from `generation`).
pub fn store_cached(caps: &AgentCapabilities, requested_account: &str, started_at: u64) {
    if generation(&caps.agent_id) != started_at {
        return;
    }
    if let Ok(mut map) = cache().lock() {
        map.insert(
            (caps.agent_id.clone(), requested_account.to_string()),
            Cached {
                caps: caps.clone(),
                at: Instant::now(),
            },
        );
    }
}

/// Forget an agent's cached results (an account was added or removed, a
/// model was refused), and any probe of it still running.
pub fn invalidate(agent_id: &str) {
    if let Ok(mut g) = generations().lock() {
        *g.entry(agent_id.to_string()).or_insert(0) += 1;
    }
    if let Ok(mut map) = cache().lock() {
        map.retain(|(a, _), _| a != agent_id);
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::cell::RefCell;

    /// A machine with fake CLIs: `outputs` maps "bin args…" (plus " @ENV=value"
    /// for a profile) to (exit code, output).
    pub struct FakeHost {
        pub installed: Vec<&'static str>,
        pub outputs: HashMap<String, (i32, String)>,
        pub files: HashMap<PathBuf, String>,
        pub ran: RefCell<Vec<String>>,
        pub env: HashMap<String, String>,
    }

    impl FakeHost {
        pub fn new(installed: &[&'static str]) -> Self {
            FakeHost {
                installed: installed.to_vec(),
                outputs: HashMap::new(),
                files: HashMap::new(),
                ran: RefCell::new(Vec::new()),
                env: HashMap::new(),
            }
        }
        pub fn out(mut self, cmd: &str, code: i32, output: &str) -> Self {
            self.outputs
                .insert(cmd.to_string(), (code, output.to_string()));
            self
        }
    }

    impl Host for FakeHost {
        fn find(&self, name: &str) -> Option<PathBuf> {
            self.installed
                .contains(&name)
                .then(|| PathBuf::from(format!("/fake/bin/{name}")))
        }
        fn run(
            &self,
            bin: &Path,
            args: &[String],
            env: &[(String, String)],
            _cap: usize,
            _t: Duration,
        ) -> Probe {
            let mut key = format!(
                "{} {}",
                bin.file_name().unwrap().to_string_lossy(),
                args.join(" ")
            );
            for (k, v) in env {
                key.push_str(&format!(" @{k}={v}"));
            }
            self.ran.borrow_mut().push(key.clone());
            match self.outputs.get(&key) {
                Some((code, output)) => Probe::Exited {
                    code: *code,
                    output: output.clone(),
                },
                None => Probe::Failed,
            }
        }
        fn read(&self, path: &Path) -> Option<String> {
            self.files.get(path).cloned()
        }
        fn home(&self) -> Option<PathBuf> {
            Some(PathBuf::from("/home-fixture"))
        }
        fn now_ms(&self) -> i64 {
            1_800_000_000_000
        }
        fn env(&self, name: &str) -> Option<String> {
            self.env.get(name).cloned()
        }
    }

    fn agent(id: &str) -> &'static Agent {
        crate::agent_catalog::agent(id).unwrap()
    }

    fn none(_: &str) -> Vec<Refusal> {
        Vec::new()
    }

    #[test]
    fn claude_signed_in_default_and_a_signed_out_second_profile() {
        let mut host = FakeHost::new(&["claude"])
            .out("claude --version", 0, "2.1.284 (Claude Code)\n")
            .out("claude auth status --json", 0, r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"person@example.com","orgName":"Example","subscriptionType":"max"}"#)
            .out("claude auth status --json @CLAUDE_CONFIG_DIR=/profiles/.claude-work", 1, r#"{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}"#);
        host.files.insert(
            PathBuf::from("/home-fixture/.claude.json"),
            r#"{"additionalModelOptionsCache":[{"value":"claude-fable-5-1[1m]","label":"Fable"}]}"#
                .into(),
        );
        let stored = vec![StoredAccount {
            agent_id: "claude".into(),
            id: "work".into(),
            label: "Work".into(),
            profile_dir: "/profiles/.claude-work".into(),
        }];
        let caps = discover(agent("claude"), &stored, None, &none, &host);
        assert!(caps.installed && caps.verified_on_real_install);
        assert_eq!(caps.cli_version.as_deref(), Some("2.1.284"));
        assert_eq!(caps.accounts.len(), 2);
        assert_eq!(
            (caps.accounts[0].signed_in, caps.accounts[0].detail.as_str()),
            (true, "Max plan")
        );
        assert_eq!(
            (
                caps.accounts[1].signed_in,
                caps.accounts[1].sign_in_state.as_str()
            ),
            (false, "signed-out")
        );
        assert_eq!(
            caps.accounts[1].profile_env,
            Some(ProfileEnv {
                name: "CLAUDE_CONFIG_DIR".into(),
                value: "/profiles/.claude-work".into()
            })
        );
        assert_eq!(caps.active_account_id.as_deref(), Some("default"));
        let ids: Vec<&str> = caps.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "default",
                "opus",
                "sonnet",
                "haiku",
                "opusplan",
                "claude-fable-5-1[1m]"
            ]
        );
        assert!(caps
            .models
            .iter()
            .find(|m| m.id == "haiku")
            .unwrap()
            .efforts
            .is_empty());
        assert_eq!(caps.model_source, "aliases");
        assert!(caps.can_add_account && caps.accepts_typed_model);
        assert_eq!(
            caps.approval_modes
                .iter()
                .map(|m| m.id.as_str())
                .collect::<Vec<_>>(),
            [
                "default",
                "acceptEdits",
                "plan",
                "auto",
                "dontAsk",
                "bypassPermissions"
            ]
        );
        assert_eq!(caps.default_approval_mode_id, "acceptEdits");
        assert!(caps.approval_modes.last().unwrap().danger);
        assert_eq!(caps.status_source, "exact");
        let json = serde_json::to_string(&caps).unwrap();
        assert!(
            !json.contains("example.com") && !json.contains("Example\""),
            "no e-mail or org leaves discovery"
        );
    }

    #[test]
    fn codex_models_come_from_its_catalog_and_a_refused_model_is_off() {
        let models = r#"{"models":[{"slug":"gpt-5.6-terra","display_name":"GPT-5.6-Terra","supported_reasoning_levels":[{"effort":"low"},{"effort":"medium"},{"effort":"high"},{"effort":"xhigh"},{"effort":"max"},{"effort":"ultra"}],"visibility":"list"},{"slug":"gpt-5.6-luna","display_name":"GPT-5.6-Luna","supported_reasoning_levels":[{"effort":"low"},{"effort":"medium"},{"effort":"high"},{"effort":"xhigh"},{"effort":"max"}],"visibility":"list"},{"slug":"gpt-5.5","display_name":"GPT-5.5","supported_reasoning_levels":[{"effort":"low"},{"effort":"medium"},{"effort":"high"},{"effort":"xhigh"}],"visibility":"list"},{"slug":"codex-auto-review","supported_reasoning_levels":[],"visibility":"hide"}]}"#;
        let host = FakeHost::new(&["codex"])
            .out("codex --version", 0, "codex-cli 0.145.0\n")
            .out("codex login status", 0, "Logged in using ChatGPT\n")
            .out("codex debug models --bundled", 0, models);
        let refused = |acc: &str| {
            if acc == "default" {
                vec![Refusal {
                    model: "gpt-5.5".to_string(),
                    at: 5,
                    resolved: None,
                }]
            } else {
                vec![]
            }
        };
        let caps = discover(agent("codex"), &[], None, &refused, &host);
        assert_eq!(caps.model_source, "cli-list");
        let ids: Vec<&str> = caps.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["default", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);
        assert_eq!(
            caps.models[1].efforts,
            ["low", "medium", "high", "xhigh", "max", "ultra"]
        );
        assert_eq!(
            caps.models[0].efforts,
            ["low", "medium", "high", "xhigh"],
            "default: the levels every model takes"
        );
        let off = &caps.models[3];
        assert!(!off.available);
        assert_eq!(
            off.unavailable_reason.as_deref(),
            Some("gpt-5.5 was refused by this account at its last launch")
        );
        assert_eq!(caps.accounts[0].detail, "ChatGPT account");
        assert!(!caps.accepts_typed_model);
        assert!(caps.models[0].available && caps.models[0].unavailable_reason.is_none());

        // The default model refused (Codex's own config named a model the
        // account cannot use): still launchable, but it says so.
        let refused_default = |_: &str| {
            vec![Refusal {
                model: "default".to_string(),
                at: 9,
                resolved: Some("gpt-5.2-codex".to_string()),
            }]
        };
        let caps = discover(agent("codex"), &[], None, &refused_default, &host);
        let d = &caps.models[0];
        assert!(d.available, "the default is never taken away");
        assert_eq!(d.unavailable_code.as_deref(), Some("refused"));
        assert_eq!(
            d.unavailable_reason.as_deref(),
            Some("Codex's default model, gpt-5.2-codex, was refused by this account at its last launch")
        );
    }

    #[test]
    fn a_probe_that_rewrites_the_clis_files_runs_at_most_every_half_hour() {
        let agy = crate::agent_catalog::agent("antigravity").unwrap();
        let claude = crate::agent_catalog::agent("claude").unwrap();
        assert!(probe_rewrites_vendor_files(agy) && !probe_rewrites_vendor_files(claude));
        let min = |m: u64| Duration::from_secs(m * 60);
        assert_eq!(freshness(min(0), false), Freshness::Good);
        assert_eq!(
            freshness(min(1) + Duration::from_secs(1), false),
            Freshness::IfSameVersion
        );
        assert_eq!(freshness(min(3), false), Freshness::Stale);
        assert_eq!(freshness(min(3), true), Freshness::Good);
        assert_eq!(freshness(min(29), true), Freshness::Good);
        assert_eq!(freshness(min(31), true), Freshness::Stale);
    }

    #[test]
    fn agy_lists_models_once_and_its_sign_in_comes_from_the_same_run() {
        let host = FakeHost::new(&["agy"])
            .out("agy --version", 0, "1.0.6\n")
            .out("agy models", 0, "Fetching available models...\ngemini-3.6-flash-low\tGemini 3.6 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n");
        let caps = discover(agent("antigravity"), &[], None, &none, &host);
        assert_eq!(
            host.ran
                .borrow()
                .iter()
                .filter(|c| c.starts_with("agy models"))
                .count(),
            1,
            "one run for accounts and models"
        );
        assert_eq!(
            (
                caps.accounts.len(),
                caps.accounts[0].signed_in,
                caps.accounts[0].detail.as_str()
            ),
            (1, true, "Google account")
        );
        assert!(!caps.can_add_account);
        assert_eq!(
            caps.account_note.as_deref(),
            Some("One account per computer user (Antigravity has no profiles)")
        );
        assert_eq!(
            caps.models
                .iter()
                .map(|m| m.id.as_str())
                .collect::<Vec<_>>(),
            ["default", "gemini-3.6-flash-low", "claude-sonnet-4-6"]
        );
        assert_eq!(caps.models[1].efforts, ["low", "medium", "high", "max"]);

        let out = FakeHost::new(&["agy"]).out(
            "agy models",
            1,
            "Authentication required. Please visit the URL to log in:\nhttps://x\n",
        );
        let caps = discover(agent("antigravity"), &[], None, &none, &out);
        assert_eq!(caps.accounts[0].sign_in_state, "signed-out");
        assert_eq!(
            caps.models.len(),
            1,
            "only default when the list could not be read"
        );
    }

    #[test]
    fn a_missing_cli_runs_nothing_and_an_unprobed_account_is_unknown_not_blocked() {
        let host = FakeHost::new(&[]);
        let caps = discover(agent("claude"), &[], None, &none, &host);
        assert!(!caps.installed);
        assert!(host.ran.borrow().is_empty());
        assert_eq!(caps.accounts[0].sign_in_state, "unknown");
        assert!(caps.accounts[0].signed_in, "unknown never blocks a launch");

        let host = FakeHost::new(&["copilot"]).out("copilot --version", 0, "1.0.89\n");
        let caps = discover(agent("copilot"), &[], None, &none, &host);
        assert_eq!(
            (
                caps.accounts[0].sign_in_state.as_str(),
                caps.model_source.as_str()
            ),
            ("unknown", "free-text")
        );
        assert!(!caps.verified_on_real_install);
    }

    #[test]
    fn the_default_profile_folder_comes_from_hermess_environment() {
        let host = FakeHost::new(&[]);
        let caps = discover(agent("codex"), &[], None, &none, &host);
        assert_eq!(
            caps.default_profile_dir, None,
            "unset: the catalog's folder"
        );
        let mut host = FakeHost::new(&[]);
        host.env
            .insert("CODEX_HOME".into(), "/work-fixture/codex-home".into());
        let caps = discover(agent("codex"), &[], None, &none, &host);
        assert_eq!(
            caps.default_profile_dir.as_deref(),
            Some("/work-fixture/codex-home")
        );
        // Another agent's variable says nothing about Codex's.
        let mut host = FakeHost::new(&[]);
        host.env
            .insert("CLAUDE_CONFIG_DIR".into(), "/work-fixture/c".into());
        let caps = discover(agent("codex"), &[], None, &none, &host);
        assert_eq!(caps.default_profile_dir, None);
    }

    #[test]
    fn a_cli_that_cannot_start_is_not_called_signed_out() {
        let host = FakeHost::new(&["codex"]).out(
            "codex --version",
            127,
            "env: node: No such file or directory\n",
        );
        let caps = discover(agent("codex"), &[], None, &none, &host);
        assert!(caps.installed);
        let a = &caps.accounts[0];
        assert_eq!(a.sign_in_state, "unknown");
        assert!(a.signed_in, "unknown never blocks on a guess");
        assert_eq!(
            a.detail,
            "fails to start: env: node: No such file or directory"
        );
        assert!(
            !host.ran.borrow().iter().any(|c| c.contains("login status")),
            "no sign-in probe after a failed start: {:?}",
            host.ran.borrow()
        );
    }

    #[test]
    fn the_requested_account_is_active_when_it_exists() {
        let host = FakeHost::new(&["codex"])
            .out("codex login status", 0, "Logged in using ChatGPT\n")
            .out(
                "codex login status @CODEX_HOME=/p/.codex-two",
                0,
                "Logged in using ChatGPT\n",
            );
        let stored = vec![StoredAccount {
            agent_id: "codex".into(),
            id: "two".into(),
            label: "Two".into(),
            profile_dir: "/p/.codex-two".into(),
        }];
        assert_eq!(
            discover(agent("codex"), &stored, Some("two"), &none, &host)
                .active_account_id
                .as_deref(),
            Some("two")
        );
        assert_eq!(
            discover(agent("codex"), &stored, Some("gone"), &none, &host)
                .active_account_id
                .as_deref(),
            Some("default")
        );
        assert!(
            host.ran
                .borrow()
                .iter()
                .any(|c| c == "codex debug models --bundled @CODEX_HOME=/p/.codex-two"),
            "the list runs in the active account's profile"
        );
    }

    #[test]
    fn a_probe_overtaken_by_an_account_change_is_not_cached() {
        // A made-up agent id so no other test shares this cache entry.
        let host = FakeHost::new(&["codex"]).out("codex login status", 0, "Logged in\n");
        let mut caps = discover(agent("codex"), &[], None, &none, &host);
        caps.agent_id = "qa-generation-agent".into();
        let started = generation(&caps.agent_id);
        invalidate(&caps.agent_id); // an account was added while the probe ran
        store_cached(&caps, "default", started);
        assert!(
            peek(&caps.agent_id).is_none(),
            "the stale result is dropped"
        );
        store_cached(&caps, "default", generation(&caps.agent_id));
        assert!(
            peek(&caps.agent_id).is_some(),
            "a probe started after it is kept"
        );
    }
}
