//! Tauri commands of the launch contract (see `src/agent/capabilities/api.ts`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use super::choice::{self, DEFAULT_ACCOUNT, DEFAULT_MODEL};
use super::discover::{self, Host, RealHost};
use super::store::{self, StoredAccount};
use super::types::*;
use crate::AppState;

fn now_ms() -> i64 {
    crate::turn_ledger::now_ms()
}

/// The terminal PATH lookup is slow (a login shell); keep it a few minutes.
type HostSlot = StdMutex<Option<(Instant, Arc<RealHost>)>>;

fn host() -> Arc<RealHost> {
    static HOST: OnceLock<HostSlot> = OnceLock::new();
    let cell = HOST.get_or_init(|| StdMutex::new(None));
    let mut guard = cell.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, h)) = guard.as_ref() {
        if at.elapsed() < Duration::from_secs(300) {
            return Arc::clone(h);
        }
    }
    let h = Arc::new(RealHost::new());
    *guard = Some((Instant::now(), Arc::clone(&h)));
    h
}

fn agent(agent_id: &str) -> Result<&'static crate::agent_catalog::Agent, String> {
    crate::agent_catalog::agent(agent_id).ok_or_else(|| format!("Unknown agent \"{agent_id}\""))
}

fn with_db<T>(
    app: &AppHandle,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<AppState>();
    let db = state.db.lock().map_err(|e| e.to_string())?;
    f(&db.conn)
}

/// One agent's capabilities for an account (None: the active one), cached
/// per CLI version and account unless `refresh`.
pub fn capabilities(
    app: &AppHandle,
    agent_id: &str,
    account_id: Option<&str>,
    refresh: bool,
) -> Result<AgentCapabilities, String> {
    let agent = agent(agent_id)?;
    let key = account_id.unwrap_or("");
    let host = host();
    if refresh {
        // Every account of the agent is probed again, not only this one.
        discover::invalidate(agent_id);
    } else {
        let version = || {
            let (bin, args) = agent.detect.as_ref()?.command.split_first()?;
            let path = host.find(bin)?;
            match host.run(&path, args, &[], 16 * 1024, Duration::from_secs(8)) {
                crate::agent_doctor::Probe::Exited { output, .. } => {
                    crate::agent_doctor::parse_version(&output)
                }
                _ => None,
            }
        };
        if let Some(c) = discover::cached(agent, key, version) {
            return Ok(c);
        }
    }
    let stored = with_db(app, |c| store::list_accounts(c, agent_id))?;
    let mut refused: HashMap<String, Vec<(String, i64)>> = HashMap::new();
    for acc in
        std::iter::once(DEFAULT_ACCOUNT.to_string()).chain(stored.iter().map(|a| a.id.clone()))
    {
        let r = with_db(app, |c| store::rejections(c, agent_id, &acc))?;
        refused.insert(acc, r);
    }
    let caps = discover::discover(
        agent,
        &stored,
        account_id,
        &|acc| refused.get(acc).cloned().unwrap_or_default(),
        host.as_ref(),
    );
    discover::store_cached(&caps, key);
    Ok(caps)
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_agent_capabilities(
    app: AppHandle,
    agent_id: String,
    account_id: Option<String>,
    refresh: Option<bool>,
) -> Result<AgentCapabilities, String> {
    blocking(move || {
        capabilities(
            &app,
            &agent_id,
            account_id.as_deref(),
            refresh.unwrap_or(false),
        )
    })
    .await
}

#[tauri::command]
pub async fn list_agent_capabilities(
    app: AppHandle,
    refresh: Option<bool>,
) -> Result<Vec<AgentCapabilities>, String> {
    let refresh = refresh.unwrap_or(false);
    blocking(move || {
        let ids: Vec<&'static str> = crate::agent_catalog::catalog()
            .agents
            .iter()
            .filter(|a| !a.custom)
            .map(|a| a.id.as_str())
            .collect();
        let handles: Vec<_> = ids
            .into_iter()
            .map(|id| {
                let app = app.clone();
                std::thread::spawn(move || capabilities(&app, id, None, refresh))
            })
            .collect();
        let mut out = Vec::new();
        for h in handles {
            if let Ok(Ok(c)) = h.join() {
                out.push(c);
            }
        }
        Ok(out)
    })
    .await
}

fn caps_for_choice(app: &AppHandle, c: &LaunchChoice) -> Result<AgentCapabilities, String> {
    capabilities(app, &c.agent_id, Some(&c.account_id), false)
}

/// A stored choice checked against current capabilities.
pub fn check(app: &AppHandle, c: &LaunchChoice) -> Result<CheckedChoice, String> {
    let caps = caps_for_choice(app, c)?;
    let inner = match &c.also_on {
        Some(inner) => Some(caps_for_choice(app, inner)?),
        None => None,
    };
    Ok(choice::reconcile(c, &caps, inner.as_ref()))
}

#[tauri::command]
pub async fn validate_launch(
    app: AppHandle,
    choice: LaunchChoice,
) -> Result<LaunchValidation, String> {
    blocking(move || {
        let caps = caps_for_choice(&app, &choice)?;
        let v = choice::validate(&choice, &caps);
        if !v.is_ok() {
            return Ok(v);
        }
        if let Some(inner) = &choice.also_on {
            let inner_caps = caps_for_choice(&app, inner)?;
            if let LaunchValidation::Refused { field, message, .. } =
                choice::validate(inner, &inner_caps)
            {
                return Ok(LaunchValidation::refused(
                    &field,
                    format!("Also on: {message}"),
                ));
            }
        }
        Ok(v)
    })
    .await
}

/// The profile variable of an account Hermes added (None: the default profile).
fn profile_env_of(
    app: &AppHandle,
    agent_id: &str,
    account_id: &str,
) -> Result<Option<ProfileEnv>, String> {
    if account_id.is_empty() || account_id == DEFAULT_ACCOUNT {
        return Ok(None);
    }
    let agent = agent(agent_id)?;
    let Some(name) = agent
        .capabilities
        .as_ref()
        .and_then(|c| c.accounts.profile_env.clone())
    else {
        return Err(format!("{} has one account per computer user", agent.name));
    };
    let stored = with_db(app, |c| store::list_accounts(c, agent_id))?;
    let acc = stored
        .into_iter()
        .find(|a| a.id == account_id)
        .ok_or_else(|| format!("{} has no account \"{account_id}\"", agent.name))?;
    Ok(Some(ProfileEnv {
        name,
        value: acc.profile_dir,
    }))
}

#[tauri::command]
pub fn preview_launch(
    app: AppHandle,
    choice: LaunchChoice,
    task: String,
) -> Result<String, String> {
    let agent = agent(&choice.agent_id)?;
    let env = profile_env_of(&app, &choice.agent_id, &choice.account_id).unwrap_or(None);
    let home = dirs::home_dir().map(|h| h.to_string_lossy().to_string());
    Ok(choice::preview(
        agent,
        &choice,
        env.as_ref(),
        &task,
        home.as_deref(),
    ))
}

/// A repository path as history keys it (trailing separators off).
fn repo_key(repo: &str) -> String {
    let trimmed = repo.trim().trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        repo.trim().to_string()
    } else {
        trimmed.to_string()
    }
}

#[tauri::command]
pub fn remember_launch_choice(
    app: AppHandle,
    choice: LaunchChoice,
    repo: Option<String>,
) -> Result<RememberResult, String> {
    agent(&choice.agent_id)?;
    let now = now_ms();
    with_db(&app, |c| {
        store::remember(c, &choice, now)?;
        let Some(repo) = repo.as_deref().map(repo_key).filter(|r| !r.is_empty()) else {
            return Ok(RememberResult {
                count: 0,
                suggest_preset: false,
            });
        };
        let count = store::record_launch(c, &repo, &choice, now)?;
        Ok(RememberResult {
            count,
            suggest_preset: store::should_suggest_preset(c, &choice, count)?,
        })
    })
}

#[tauri::command]
pub async fn get_remembered_launch_choice(
    app: AppHandle,
    agent_id: String,
    account_id: Option<String>,
) -> Result<Option<CheckedChoice>, String> {
    blocking(move || {
        let stored = with_db(&app, |c| {
            store::remembered(c, &agent_id, account_id.as_deref())
        })?;
        match stored {
            Some(s) => check(&app, &s).map(Some),
            None => Ok(None),
        }
    })
    .await
}

#[tauri::command]
pub fn dismiss_preset_suggestion(
    app: AppHandle,
    choice: LaunchChoice,
    repo: Option<String>,
) -> Result<(), String> {
    let _ = repo;
    with_db(&app, |c| store::dismiss_preset_prompt(c, &choice, now_ms()))
}

/// The first installed agent in catalog order (Claude first): the catalog
/// default when nothing was launched yet.
fn first_installed(host: &RealHost) -> &'static str {
    crate::agent_catalog::catalog()
        .agents
        .iter()
        .filter(|a| !a.custom && a.channel == "stable" && a.status == "current")
        .find(|a| {
            a.detect
                .as_ref()
                .and_then(|d| d.command.first())
                .is_some_and(|bin| host.find(bin).is_some())
        })
        .map(|a| a.id.as_str())
        .unwrap_or("claude")
}

pub fn usual(app: &AppHandle, repo: Option<&str>) -> Result<UsualLaunchChoice, String> {
    let now = now_ms();
    let repo = repo.map(repo_key).filter(|r| !r.is_empty());
    let from = |rows: Vec<choice::HistoryRow>,
                source: &str|
     -> Result<Option<UsualLaunchChoice>, String> {
        let Some(best) = choice::pick_usual(&rows, now) else {
            return Ok(None);
        };
        let checked = check(app, &best.choice)?;
        Ok(Some(UsualLaunchChoice {
            choice: checked.choice,
            issues: checked.issues,
            launchable: checked.launchable,
            source: source.to_string(),
            count: best.count,
            last_used_at: Some(best.last_used_at),
        }))
    };
    if let Some(repo) = &repo {
        let rows = with_db(app, |c| store::history(c, Some(repo)))?;
        if let Some(u) = from(rows, "repo")? {
            return Ok(u);
        }
    }
    let all = with_db(app, |c| store::history(c, None))?;
    if let Some(u) = from(choice::merge_rows(all), "global")? {
        return Ok(u);
    }
    let agent_id = first_installed(host().as_ref());
    let caps = capabilities(app, agent_id, None, false)?;
    let default = choice::catalog_default(&caps);
    let checked = choice::reconcile(&default, &caps, None);
    Ok(UsualLaunchChoice {
        choice: checked.choice,
        issues: checked.issues,
        launchable: checked.launchable,
        source: "catalog".to_string(),
        count: 0,
        last_used_at: None,
    })
}

#[tauri::command]
pub async fn get_usual_launch_choice(
    app: AppHandle,
    repo: Option<String>,
) -> Result<UsualLaunchChoice, String> {
    blocking(move || usual(&app, repo.as_deref())).await
}

fn checked_preset(app: &AppHandle, p: store::StoredPreset) -> Result<CheckedPreset, String> {
    let checked = check(app, &p.choice)?;
    Ok(CheckedPreset {
        id: p.id,
        name: p.name,
        choice: p.choice,
        issues: checked.issues,
        launchable: checked.launchable,
        effective: checked.choice,
    })
}

#[tauri::command]
pub async fn list_launch_presets(app: AppHandle) -> Result<Vec<CheckedPreset>, String> {
    blocking(move || {
        let presets = with_db(&app, store::list_presets)?;
        presets
            .into_iter()
            .map(|p| checked_preset(&app, p))
            .collect()
    })
    .await
}

#[tauri::command]
pub async fn save_launch_preset(
    app: AppHandle,
    name: String,
    choice: LaunchChoice,
) -> Result<CheckedPreset, String> {
    agent(&choice.agent_id)?;
    blocking(move || {
        let p = with_db(&app, |c| store::save_preset(c, &name, &choice, now_ms()))?;
        checked_preset(&app, p)
    })
    .await
}

#[tauri::command]
pub async fn rename_launch_preset(
    app: AppHandle,
    id: String,
    name: String,
) -> Result<CheckedPreset, String> {
    blocking(move || {
        let p = with_db(&app, |c| store::rename_preset(c, &id, &name, now_ms()))?;
        checked_preset(&app, p)
    })
    .await
}

#[tauri::command]
pub fn delete_launch_preset(app: AppHandle, id: String) -> Result<(), String> {
    with_db(&app, |c| store::delete_preset(c, &id).map(|_| ()))
}

// ─── Accounts ────────────────────────────────────────────────────────

/// "Work account" → "work-account": the account id and the profile folder's suffix.
pub fn slug_of(label: &str) -> String {
    let mut out = String::new();
    for c in label.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out
        .trim_end_matches('-')
        .chars()
        .take(32)
        .collect::<String>();
    if out.is_empty() {
        "account".to_string()
    } else {
        out
    }
}

/// Where profile folders go: the home folder. Test builds only
/// (`HERMES_E2E=1` and the `e2e` feature): `HERMES_E2E_PROFILE_ROOT`, so a
/// scenario never creates a folder in a real home.
fn profile_root() -> Option<PathBuf> {
    #[cfg(feature = "e2e")]
    if std::env::var("HERMES_E2E").ok().as_deref() == Some("1") {
        if let Some(root) = std::env::var_os("HERMES_E2E_PROFILE_ROOT").filter(|r| !r.is_empty()) {
            return Some(PathBuf::from(root));
        }
    }
    dirs::home_dir()
}

/// The account id and folder for a new account: the label's slug, with a
/// number when that id is taken.
pub fn plan_account(
    template: &str,
    label: &str,
    root: &Path,
    taken: &[String],
) -> (String, PathBuf) {
    let base = slug_of(label);
    let mut id = base.clone();
    let mut n = 2;
    while taken.contains(&id) || id == DEFAULT_ACCOUNT {
        id = format!("{base}-{n}");
        n += 1;
    }
    (id.clone(), root.join(template.replace("{slug}", &id)))
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn add_agent_account(
    app: AppHandle,
    agent_id: String,
    label: String,
) -> Result<AddedAccount, String> {
    blocking(move || {
        let agent = agent(&agent_id)?;
        let label = label
            .trim()
            .chars()
            .filter(|c| !c.is_control())
            .take(40)
            .collect::<String>();
        if label.is_empty() {
            return Err("An account needs a name".to_string());
        }
        let accounts = agent.capabilities.as_ref().map(|c| &c.accounts);
        let (Some(_env), Some(template)) = (
            accounts.and_then(|a| a.profile_env.as_ref()),
            accounts.and_then(|a| a.profile_dir.as_ref()),
        ) else {
            return Err(accounts
                .and_then(|a| a.note.clone())
                .unwrap_or_else(|| format!("{} has one account per computer user", agent.name)));
        };
        let root = profile_root().ok_or("No home folder to put the profile in")?;
        let stored = with_db(&app, |c| store::list_accounts(c, &agent_id))?;
        let taken: Vec<String> = stored.iter().map(|a| a.id.clone()).collect();
        let (id, dir) = plan_account(template, &label, &root, &taken);
        let reused = dir.is_dir();
        if !reused {
            create_private_dir(&dir)
                .map_err(|e| format!("Could not create the profile folder: {e}"))?;
        }
        let row = StoredAccount {
            agent_id: agent_id.clone(),
            id: id.clone(),
            label: label.clone(),
            profile_dir: dir.to_string_lossy().to_string(),
        };
        with_db(&app, |c| store::insert_account(c, &row, now_ms()))?;
        discover::invalidate(&agent_id);
        log::info!(
            "[CAPS] added a {} account ({})",
            agent.name,
            if reused {
                "existing profile folder"
            } else {
                "new profile folder"
            }
        );
        let caps = capabilities(&app, &agent_id, Some(&id), true)?;
        let account = caps
            .accounts
            .into_iter()
            .find(|a| a.id == id)
            .ok_or("The account was added but could not be read back")?;
        let signed_in = account.sign_in_state == "signed-in";
        Ok(AddedAccount {
            account,
            reused,
            signed_in,
        })
    })
    .await
}

#[tauri::command]
pub fn remove_agent_account(
    app: AppHandle,
    agent_id: String,
    account_id: String,
) -> Result<(), String> {
    if account_id == DEFAULT_ACCOUNT {
        return Err("The default profile cannot be removed".to_string());
    }
    with_db(&app, |c| store::remove_account(c, &agent_id, &account_id))?;
    discover::invalidate(&agent_id);
    Ok(())
}

// ─── Launching with a choice ─────────────────────────────────────────

/// create_session's `agentLaunch`, resolved: the account's profile variable
/// looked up, the default model and account left out. Refuses an account
/// Hermes does not know and an effort the agent has no word for.
pub fn session_launch(
    app: &AppHandle,
    provider: &str,
    options: &AgentLaunchOptions,
) -> Result<SessionLaunch, String> {
    let agent = agent(provider)?;
    let model_id = options
        .model_id
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty() && *m != DEFAULT_MODEL)
        .map(str::to_string);
    if model_id
        .as_deref()
        .is_some_and(|m| m.chars().any(|c| c.is_control()))
    {
        return Err("A model name cannot contain control characters".to_string());
    }
    if model_id
        .as_deref()
        .is_some_and(super::choice::looks_like_a_flag)
    {
        return Err("A model name cannot start with \"-\"".to_string());
    }
    // A CLI that falls back to another model without a word when given one
    // it does not know (Antigravity 1.2 in its interactive mode) never gets
    // a model its own list does not have: the launch would run on a model
    // nobody chose. Checked against what discovery already knows; the
    // launcher validated the choice before this.
    let silent = agent
        .capabilities
        .as_ref()
        .is_some_and(|c| c.model.silent_fallback);
    if let (true, Some(model), Some(caps)) = (silent, model_id.as_deref(), discover::peek(provider))
    {
        if caps.model_source == "cli-list" && !caps.models.iter().any(|m| m.id == model) {
            return Err(format!(
                "{} does not offer the model \"{model}\"; pick one from its list",
                agent.name
            ));
        }
    }
    let effort = options
        .effort
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .map(str::to_string);
    if let Some(e) = &effort {
        let known = agent
            .capabilities
            .as_ref()
            .and_then(|c| c.effort.as_ref())
            .is_some_and(|ec| ec.values.contains(e));
        if !known {
            return Err(format!("{} has no effort \"{e}\"", agent.name));
        }
    }
    let account_id = options
        .account_id
        .as_deref()
        .filter(|a| !a.is_empty() && *a != DEFAULT_ACCOUNT)
        .map(str::to_string);
    let profile_env = match &account_id {
        Some(a) => profile_env_of(app, provider, a)?,
        None => None,
    };
    Ok(SessionLaunch {
        model_id,
        effort,
        account_id,
        profile_env,
        login: options.purpose.as_deref() == Some("login"),
        relaunch: false,
        resumed: false,
    })
}

/// Called from the PTY reader when a launch's output shows a refusal: the
/// `launch_rejected` event, and a refused model is remembered for the
/// account (the launcher then shows it as not available).
pub fn on_rejected(app: &AppHandle, session_id: &str, found: super::watch::Found) {
    use crate::contract::{RejectReason, SessionEvent};
    let r = &found.rejection;
    log::warn!(
        "[CAPS] {session_id}: {} refused the launch ({:?}); Hermes stopped it",
        found.agent,
        r.reason
    );
    if r.reason == RejectReason::Model {
        if let Some(model) = found.launch.model_id.as_deref() {
            let account = found
                .launch
                .account_id
                .as_deref()
                .unwrap_or(DEFAULT_ACCOUNT);
            let _ = with_db(app, |c| {
                store::record_rejection(
                    c,
                    &found.agent,
                    account,
                    model,
                    &r.vendor_message,
                    now_ms(),
                )
            });
            discover::invalidate(&found.agent);
        }
    }
    if r.reason == RejectReason::SignedOut {
        discover::invalidate(&found.agent);
    }
    crate::contract::emit_session_event(
        app,
        session_id,
        SessionEvent::LaunchRejected {
            at: now_ms(),
            source: Some("hermes".to_string()),
            tags: None,
            reason: r.reason,
            vendor_message: r.vendor_message.clone(),
            suggestion: r.suggestion,
        },
    );
}

/// Start a session's agent again with another model, effort or account
/// (the refusal banner's buttons). `modelId` and `effort` are the new values
/// (null: the default model, no effort); the account changes only when
/// given. Only after the previous launch ended.
#[tauri::command]
pub async fn relaunch_agent(
    app: AppHandle,
    session_id: String,
    options: AgentLaunchOptions,
) -> Result<(), String> {
    blocking(move || relaunch(&app, &session_id, &options)).await
}

fn relaunch(app: &AppHandle, session_id: &str, options: &AgentLaunchOptions) -> Result<(), String> {
    let (session, writer) = {
        let state = app.state::<AppState>();
        let mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
        let ps = mgr
            .sessions
            .get(session_id)
            .ok_or("That session is closed")?;
        (Arc::clone(&ps.session), Arc::clone(&ps.writer))
    };
    let provider = session
        .lock()
        .map_err(|e| e.to_string())?
        .ai_provider
        .clone()
        .ok_or("This session has no agent")?;
    // The previous launch must be over (hi reports the stopped agent's exit
    // a moment after the refusal).
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let ended = session
            .lock()
            .map_err(|e| e.to_string())?
            .agent_startup
            .as_ref()
            .map(|a| a.state)
            == Some(crate::pty::AgentStartupState::Ended);
        if ended {
            break;
        }
        if Instant::now() >= deadline {
            return Err("The agent is still running in this session".to_string());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let mut launch = session
        .lock()
        .map_err(|e| e.to_string())?
        .agent_launch
        .clone();
    let wanted = AgentLaunchOptions {
        model_id: options.model_id.clone(),
        effort: options.effort.clone(),
        account_id: options.account_id.clone().or(launch.account_id.clone()),
        purpose: Some("agent".to_string()),
    };
    let resolved = session_launch(app, &provider, &wanted)?;
    launch.model_id = resolved.model_id;
    launch.effort = resolved.effort;
    launch.account_id = resolved.account_id;
    launch.profile_env = resolved.profile_env;
    launch.login = false;
    launch.relaunch = true;

    // Outside the session lock, as a first launch does: the hook trust may
    // ask the agent's app server.
    let hook_trust = {
        let s = session.lock().map_err(|e| e.to_string())?;
        let wants = s.launch_helper && s.ssh_info.is_none();
        let cwd = s.working_directory.clone();
        drop(s);
        if wants {
            crate::pty::launch::hook_trust_for(app, &provider, &cwd)
        } else {
            None
        }
    };
    let prepared = {
        let mut s = session.lock().map_err(|e| e.to_string())?;
        // A refused fresh launch never started a conversation: start fresh.
        // A refused resume resumes the same conversation again (if the
        // vendor no longer knows it, `hi`'s resume fallback starts fresh).
        if !launch.resumed || e2e_relaunch_fresh() {
            s.vendor_session_id = None;
        }
        s.agent_launch = launch;
        match crate::pty::launch::prepare_helper_launch(app, &mut s, hook_trust.as_deref()) {
            crate::pty::launch::HelperLaunch::Prepared(p) => {
                s.phase = crate::pty::SessionPhase::LaunchingAgent;
                let _ = app.emit("session-updated", crate::pty::SessionUpdate::from(&*s));
                p
            }
            crate::pty::launch::HelperLaunch::Refused(message) => return Err(message),
            crate::pty::launch::HelperLaunch::TypeCommand => {
                return Err(
                    "This session cannot start its agent through the launch helper".to_string(),
                )
            }
        }
    };
    {
        use std::io::Write;
        let mut w = writer.lock().map_err(|e| e.to_string())?;
        w.write_all(format!("{}\r", prepared.line).as_bytes())
            .map_err(|e| e.to_string())?;
        w.flush().map_err(|e| e.to_string())?;
    }
    log::info!("[CAPS] {session_id}: relaunched {provider} after a refused launch");
    crate::pty::launch::watch_signals(app.clone(), session, prepared.watch);
    Ok(())
}

/// e2e builds only: `HERMES_E2E_RELAUNCH_FRESH=1` starts every relaunch
/// fresh (as before refused resumes were resumed again): the negative
/// control of the CAP-refusal-safety scenario.
fn e2e_relaunch_fresh() -> bool {
    #[cfg(feature = "e2e")]
    if std::env::var("HERMES_E2E").ok().as_deref() == Some("1") {
        return std::env::var("HERMES_E2E_RELAUNCH_FRESH").ok().as_deref() == Some("1");
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_ids_are_slugs_and_never_collide() {
        assert_eq!(slug_of("Work"), "work");
        assert_eq!(slug_of("  Client A / Team  "), "client-a-team");
        assert_eq!(slug_of("!!!"), "account");
        assert_eq!(slug_of("Ünïcode"), "n-code");
        let root = Path::new("/r");
        assert_eq!(
            plan_account(".claude-{slug}", "Work", root, &[]),
            ("work".to_string(), PathBuf::from("/r/.claude-work"))
        );
        assert_eq!(
            plan_account(".claude-{slug}", "Work", root, &["work".to_string()]).0,
            "work-2"
        );
        assert_eq!(
            plan_account(".codex-{slug}", "default", root, &[]).0,
            "default-2"
        );
    }

    #[test]
    fn history_keys_ignore_trailing_separators() {
        assert_eq!(repo_key("/src/app/"), "/src/app");
        assert_eq!(repo_key("C:\\src\\app\\"), "C:\\src\\app");
        assert_eq!(repo_key("/"), "/");
    }
}
