//! The rules for a LaunchChoice. Pure; mirrored by
//! `src/agent/capabilities/choice.ts` (same cases in both test suites).
//!
//! - A stored choice is checked against the agent's current capabilities
//!   on every read (`reconcile`): an unavailable model becomes "default"
//!   (which always works: the flag is omitted), an effort the model does not
//!   take moves to the nearest one it does, a removed or signed-out account
//!   is replaced by the active one but the choice is then not launchable (an
//!   account is never swapped without asking), a mode the agent lacks becomes its safety
//!   default. Each change is flagged with a plain reason; a choice that
//!   cannot be repaired is marked not launchable.
//! - `validate` checks a choice before launch (effort above all: Claude
//!   ignores a wrong value and still spends a turn, Codex sends it to the
//!   server, goose/opencode/aider drop it).
//! - `preview` is the "Hermes will run" line.
//! - `combo_key` names a combination (every choice but the per-task branch);
//!   `pick_usual` is the usual combination of a repository.

use super::types::*;

pub const DEFAULT_MODEL: &str = "default";
pub const DEFAULT_ACCOUNT: &str = "default";

/// Every effort word any agent uses, weakest first.
pub const EFFORT_SCALE: &[&str] = &[
    "none", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
];

fn scale_index(e: &str) -> Option<usize> {
    EFFORT_SCALE.iter().position(|x| *x == e)
}

/// The stored effort when allowed, else the nearest allowed one on the scale
/// (the weaker one on a tie); None when the model takes none or none was stored.
pub fn nearest_effort(stored: Option<&str>, allowed: &[String]) -> Option<String> {
    let stored = stored?;
    if allowed.is_empty() {
        return None;
    }
    if allowed.iter().any(|a| a == stored) {
        return Some(stored.to_string());
    }
    let Some(at) = scale_index(stored) else {
        return Some(
            allowed
                .iter()
                .find(|a| *a == "medium")
                .unwrap_or(&allowed[0])
                .clone(),
        );
    };
    let mut best: Option<(usize, usize)> = None; // (distance, index on scale)
    let mut best_value: Option<&String> = None;
    for a in allowed {
        let Some(i) = scale_index(a) else { continue };
        let d = i.abs_diff(at);
        let better = match best {
            None => true,
            Some((bd, bi)) => d < bd || (d == bd && i < bi),
        };
        if better {
            best = Some((d, i));
            best_value = Some(a);
        }
    }
    Some(best_value.unwrap_or(&allowed[0]).clone())
}

/// The model entry for an id. A typed name on an agent that takes one gets
/// the default's efforts.
/// Whether a model or effort would read as a flag of the CLI (it goes right
/// after `--model`/`-m`): never passed.
pub fn looks_like_a_flag(value: &str) -> bool {
    value.trim_start().starts_with('-')
}

pub fn find_model(caps: &AgentCapabilities, model_id: &str) -> Option<ModelOption> {
    if looks_like_a_flag(model_id) {
        return None;
    }
    if let Some(m) = caps.models.iter().find(|m| m.id == model_id) {
        return Some(m.clone());
    }
    if caps.accepts_typed_model && !model_id.trim().is_empty() && model_id != DEFAULT_MODEL {
        let efforts = caps
            .models
            .iter()
            .find(|m| m.id == DEFAULT_MODEL)
            .map(|m| m.efforts.clone())
            .unwrap_or_default();
        return Some(ModelOption {
            id: model_id.to_string(),
            label: model_id.to_string(),
            note: None,
            efforts,
            available: true,
            unavailable_reason: None,
            unavailable_code: None,
        });
    }
    None
}

fn issue(
    field: &str,
    (code, params): (&str, &[(&str, &str)]),
    message: String,
    was: Option<&str>,
    now: Option<&str>,
) -> ChoiceIssue {
    ChoiceIssue {
        field: field.to_string(),
        message,
        was: was.map(str::to_string),
        now: now.map(str::to_string),
        code: code.to_string(),
        params: params
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        also_on: false,
    }
}

/// A stored choice checked against current capabilities. `also_on_caps`:
/// the second agent's, when the choice has an "Also on".
pub fn reconcile(
    choice: &LaunchChoice,
    caps: &AgentCapabilities,
    also_on_caps: Option<&AgentCapabilities>,
) -> CheckedChoice {
    let mut out = choice.clone();
    let mut issues = Vec::new();
    let mut launchable = true;
    let name = &caps.agent_name;

    if !caps.installed {
        issues.push(issue(
            "agent",
            ("agentMissing", &[("agent", name)]),
            format!("{name} is not installed"),
            Some(&choice.agent_id),
            None,
        ));
        launchable = false;
    }

    let account = caps.accounts.iter().find(|a| a.id == choice.account_id);
    if account.is_none_or(|a| !a.signed_in) {
        let active = caps
            .accounts
            .iter()
            .find(|a| Some(&a.id) == caps.active_account_id.as_ref() && a.signed_in)
            .or_else(|| caps.accounts.iter().find(|a| a.signed_in));
        let (why, code, who) = match account {
            None => (
                format!(
                    "The account \"{}\" is not set up for {name} any more",
                    choice.account_id
                ),
                "accountGone",
                choice.account_id.as_str(),
            ),
            Some(a) => (
                format!("{} is signed out", a.label),
                "accountSignedOut",
                a.label.as_str(),
            ),
        };
        let (message, code) = match active {
            Some(a) => (format!("{why}; using {}", a.label), format!("{code}Using")),
            None => (why, code.to_string()),
        };
        let using = active.map(|a| a.label.as_str()).unwrap_or("");
        issues.push(issue(
            "account",
            (
                &code,
                &[("account", who), ("agent", name), ("using", using)],
            ),
            message,
            Some(&choice.account_id),
            active.map(|a| a.id.as_str()),
        ));
        // Another account may be offered in its place, but a choice is never
        // launched on an account the person did not pick: client work must
        // not run through a personal subscription because a sign-in expired.
        // The launcher waits for a sign-in or an explicit "use … this time".
        if let Some(a) = active {
            out.account_id = a.id.clone();
        }
        launchable = false;
    }

    let model = match find_model(caps, &choice.model_id) {
        Some(m) if m.available => m,
        other => {
            let code = match &other {
                Some(m) if m.unavailable_code.as_deref() == Some("refused") => "modelRefused",
                Some(m) if m.unavailable_reason.is_some() => "modelUnavailable",
                _ => "modelGone",
            };
            let why = other.and_then(|m| m.unavailable_reason).unwrap_or_else(|| {
                format!("{} is not offered by {name} any more", choice.model_id)
            });
            issues.push(issue(
                "model",
                (
                    code,
                    &[
                        ("model", &choice.model_id),
                        ("agent", name),
                        ("reason", &why),
                    ],
                ),
                format!("{why}; using the default model"),
                Some(&choice.model_id),
                Some(DEFAULT_MODEL),
            ));
            out.model_id = DEFAULT_MODEL.to_string();
            caps.models
                .iter()
                .find(|m| m.id == DEFAULT_MODEL)
                .cloned()
                .unwrap_or(ModelOption {
                    id: DEFAULT_MODEL.to_string(),
                    label: "Default".to_string(),
                    note: None,
                    efforts: Vec::new(),
                    available: true,
                    unavailable_reason: None,
                    unavailable_code: None,
                })
        }
    };

    let effort = nearest_effort(choice.effort.as_deref(), &model.efforts);
    if effort != choice.effort {
        let message = match &effort {
            None => format!(
                "{} has no effort levels; the effort is left to {name}",
                model.label
            ),
            Some(e) => format!(
                "{} does not take effort {}; using {e}",
                model.label,
                choice.effort.as_deref().unwrap_or("")
            ),
        };
        let was = choice.effort.as_deref().unwrap_or("");
        let code = match &effort {
            None => "effortNone",
            Some(_) => "effortChanged",
        };
        issues.push(issue(
            "effort",
            (
                code,
                &[
                    ("model", &model.label),
                    ("agent", name),
                    ("was", was),
                    ("now", effort.as_deref().unwrap_or("")),
                ],
            ),
            message,
            choice.effort.as_deref(),
            effort.as_deref(),
        ));
        out.effort = effort;
    }

    if !caps.approval_modes.is_empty()
        && !caps
            .approval_modes
            .iter()
            .any(|m| m.id == choice.approval_mode_id)
    {
        let fallback = caps
            .approval_modes
            .iter()
            .find(|m| m.id == caps.default_approval_mode_id)
            .unwrap_or(&caps.approval_modes[0]);
        issues.push(issue(
            "approval",
            (
                "approvalGone",
                &[
                    ("agent", name),
                    ("mode", &choice.approval_mode_id),
                    ("using", &fallback.label),
                ],
            ),
            format!(
                "{name} has no \"{}\" mode; using {}",
                choice.approval_mode_id, fallback.label
            ),
            Some(&choice.approval_mode_id),
            Some(&fallback.id),
        ));
        out.approval_mode_id = fallback.id.clone();
    }

    if let (Some(inner), Some(inner_caps)) = (&choice.also_on, also_on_caps) {
        let checked = reconcile(inner, inner_caps, None);
        out.also_on = Some(Box::new(checked.choice));
        for mut i in checked.issues {
            i.message = format!("Also on: {}", i.message);
            i.also_on = true;
            issues.push(i);
        }
        launchable &= checked.launchable;
    }
    CheckedChoice {
        choice: out,
        issues,
        launchable,
    }
}

/// Checks a choice before launch; the first problem wins.
pub fn validate(choice: &LaunchChoice, caps: &AgentCapabilities) -> LaunchValidation {
    let name = &caps.agent_name;
    match caps.accounts.iter().find(|a| a.id == choice.account_id) {
        None => {
            return LaunchValidation::refused(
                "account",
                format!("{name} has no account \"{}\"", choice.account_id),
            )
        }
        Some(a) if !a.signed_in => {
            return LaunchValidation::refused(
                "account",
                format!(
                    "{} is signed out of {name}. Sign in first, or pick another account.",
                    a.label
                ),
            )
        }
        _ => {}
    }
    if !caps.approval_modes.is_empty()
        && !caps
            .approval_modes
            .iter()
            .any(|m| m.id == choice.approval_mode_id)
    {
        return LaunchValidation::refused(
            "approval",
            format!("{name} has no \"{}\" mode", choice.approval_mode_id),
        );
    }
    let Some(model) = find_model(caps, &choice.model_id) else {
        return LaunchValidation::refused(
            "model",
            format!("{name} does not offer the model \"{}\"", choice.model_id),
        );
    };
    if !model.available {
        return LaunchValidation::refused(
            "model",
            model
                .unavailable_reason
                .unwrap_or_else(|| format!("{} is not available", model.label)),
        );
    }
    if let Some(effort) = &choice.effort {
        if model.efforts.is_empty() {
            return LaunchValidation::refused(
                "effort",
                format!("{} has no effort levels", model.label),
            );
        }
        if !model.efforts.contains(effort) {
            return LaunchValidation::refused(
                "effort",
                format!(
                    "{} does not take effort \"{effort}\" (it takes {})",
                    model.label,
                    model.efforts.join(", ")
                ),
            );
        }
    }
    LaunchValidation::ok()
}

/// Quote one word for the preview line the way a POSIX shell would need it:
/// single quotes, which keep `$`, `` ` `` and `\` as they are (a `'` inside
/// is written `'\''`).
fn shell_word(w: &str) -> String {
    if !w.is_empty()
        && w.chars()
            .all(|c| c.is_ascii_alphanumeric() || "@%+=:,./_-".contains(c))
    {
        return w.to_string();
    }
    format!("'{}'", w.replace('\'', "'\\''"))
}

/// The task as the preview shows it: its first line, and how many more
/// there are ("'Fix the login…' (+2 lines)"); the launch passes all of it.
fn task_word(task: &str) -> String {
    let mut lines = task.lines().map(str::trim).filter(|l| !l.is_empty());
    let first = lines.next().unwrap_or("");
    match lines.count() {
        0 => shell_word(first),
        1 => format!("{} (+1 line)", shell_word(&format!("{first}…"))),
        n => format!("{} (+{n} lines)", shell_word(&format!("{first}…"))),
    }
}

/// Fill `{name}` in an argument template.
pub fn fill(template: &[String], name: &str, value: &str) -> Vec<String> {
    let key = format!("{{{name}}}");
    template.iter().map(|a| a.replace(&key, value)).collect()
}

/// The model and effort arguments (and environment) a choice adds to the
/// agent's command line. The default model adds nothing.
pub fn model_effort_args(
    agent: &crate::agent_catalog::Agent,
    model_id: Option<&str>,
    effort: Option<&str>,
) -> (Vec<String>, Vec<(String, String)>) {
    let mut args = Vec::new();
    let mut env = Vec::new();
    let Some(caps) = agent.capabilities.as_ref() else {
        return (args, env);
    };
    // A value that reads as a flag (a stored or preset "--dangerously-...")
    // is never put after the model or effort flag.
    if let (Some(model), Some(flag)) = (
        model_id.filter(|m| !m.is_empty() && *m != DEFAULT_MODEL && !looks_like_a_flag(m)),
        caps.model.flag.as_ref(),
    ) {
        args.extend(fill(flag, "model", model));
    }
    if let (Some(effort), Some(ec)) = (
        effort.filter(|e| !e.is_empty() && !looks_like_a_flag(e)),
        caps.effort.as_ref(),
    ) {
        if let Some(flag) = &ec.flag {
            args.extend(fill(flag, "effort", effort));
        } else if let Some(name) = &ec.env {
            env.push((name.clone(), effort.to_string()));
        }
    }
    (args, env)
}

/// The "Hermes will run" line: the profile environment, the prefix, the
/// agent's command, its approval flags, model and effort, the task, the
/// channels and the extra arguments, in the order the launch uses (Hermes's
/// own per-launch hook file and conversation id are left out: they are
/// Hermes's, not the person's).
pub fn preview(
    agent: &crate::agent_catalog::Agent,
    choice: &LaunchChoice,
    profile_env: Option<&ProfileEnv>,
    task: &str,
    home: Option<&str>,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    let (model_args, effort_env) =
        model_effort_args(agent, Some(&choice.model_id), choice.effort.as_deref());
    if let Some(p) = profile_env {
        // The home folder reads as ~ (it is the person's own path).
        let value = match home
            .filter(|h| !h.is_empty())
            .and_then(|h| p.value.strip_prefix(h))
        {
            Some(rest) if rest.starts_with(['/', '\\']) => format!("~{}", shell_word(rest)),
            _ => shell_word(&p.value),
        };
        parts.push(format!("{}={value}", p.name));
    }
    for (k, v) in &effort_env {
        parts.push(format!("{k}={}", shell_word(v)));
    }
    let prefix = choice.prefix.replace(['\n', '\r'], " ");
    if !prefix.trim().is_empty() {
        parts.push(prefix.trim().to_string());
    }
    parts.extend(agent.terminal.argv.iter().map(|a| shell_word(a)));
    if let Some(flags) = agent
        .terminal
        .permission_flags
        .get(&choice.approval_mode_id)
    {
        parts.extend(flags.iter().map(|a| shell_word(a)));
    }
    parts.extend(model_args.iter().map(|a| shell_word(a)));
    let task = task.trim();
    if !task.is_empty() && agent.terminal.initial_prompt.is_some() {
        parts.push(task_word(task));
    }
    if agent.id == "claude" {
        for c in &choice.channels {
            parts.push("--channels".to_string());
            parts.push(shell_word(c));
        }
    }
    let extra = choice.extra_args.replace(['\n', '\r'], " ");
    if !extra.trim().is_empty() {
        parts.push(extra.trim().to_string());
    }
    parts.join(" ")
}

/// The identity of a combination: every choice but the per-task branch name
/// (and the channel order). Mirrors `comboKey` in choice.ts.
pub fn combo_key(choice: &LaunchChoice) -> String {
    let where_ = match &choice.where_ {
        LaunchWhere::NewWorktree { base_branch, .. } => format!("new-worktree:{base_branch}"),
        LaunchWhere::ExistingBranch { branch } => format!("existing-branch:{branch}"),
        LaunchWhere::CurrentCheckout => "current-checkout".to_string(),
    };
    let mut channels = choice.channels.clone();
    channels.sort();
    serde_json::json!([
        choice.agent_id,
        choice.account_id,
        choice.approval_mode_id,
        choice.model_id,
        choice.effort.clone().unwrap_or_default(),
        choice.extra_args.trim(),
        choice.prefix.trim(),
        channels,
        where_,
        choice.track_as_feature,
        choice.also_on.as_ref().map(|c| combo_key(c)),
    ])
    .to_string()
}

/// A choice as it is kept for next time: a new worktree's branch is per
/// task, so it is stored empty ("derive it from the task").
pub fn stored_form(choice: &LaunchChoice) -> LaunchChoice {
    let mut c = choice.clone();
    if let LaunchWhere::NewWorktree { branch, .. } = &mut c.where_ {
        branch.clear();
    }
    if let Some(inner) = c.also_on.take() {
        c.also_on = Some(Box::new(stored_form(&inner)));
    }
    c
}

/// One row of launch history: a combination, how often and when.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryRow {
    pub combo_key: String,
    pub choice: LaunchChoice,
    /// Launches ever.
    pub count: i64,
    pub last_used_at: i64,
    /// When it was launched within RECENT_MS of its last launch (epoch ms,
    /// oldest first).
    pub uses: Vec<i64>,
}

impl HistoryRow {
    /// Launches within RECENT_MS of `now_ms`.
    pub fn recent_count(&self, now_ms: i64) -> usize {
        self.uses
            .iter()
            .filter(|t| now_ms - **t <= RECENT_MS)
            .count()
    }
}

/// How far back "recent" reaches for the usual combination.
pub const RECENT_MS: i64 = 60 * 24 * 60 * 60 * 1000;
/// Most launch times kept per combination.
pub const MAX_USES: usize = 500;

/// The combination launched most often in the last RECENT_MS (tie: the most
/// recent). When nothing is recent: the most launched ever (tie: the most
/// recent).
pub fn pick_usual(rows: &[HistoryRow], now_ms: i64) -> Option<&HistoryRow> {
    let recent = rows
        .iter()
        .filter(|r| r.recent_count(now_ms) > 0)
        .max_by_key(|r| (r.recent_count(now_ms), r.last_used_at));
    recent.or_else(|| rows.iter().max_by_key(|r| (r.count, r.last_used_at)))
}

/// A row's launch times with one more: only the ones within RECENT_MS of
/// it, at most MAX_USES.
pub fn add_use(mut uses: Vec<i64>, now_ms: i64) -> Vec<i64> {
    uses.push(now_ms);
    uses.retain(|t| now_ms - *t <= RECENT_MS);
    uses.sort_unstable();
    if uses.len() > MAX_USES {
        uses.drain(..uses.len() - MAX_USES);
    }
    uses
}

/// Rows of several repositories summed per combination (the global usual).
pub fn merge_rows(rows: Vec<HistoryRow>) -> Vec<HistoryRow> {
    let mut out: Vec<HistoryRow> = Vec::new();
    for r in rows {
        match out.iter_mut().find(|o| o.combo_key == r.combo_key) {
            Some(o) => {
                o.count += r.count;
                o.uses.extend(r.uses);
                o.uses.sort_unstable();
                if r.last_used_at > o.last_used_at {
                    o.last_used_at = r.last_used_at;
                    o.choice = r.choice;
                }
            }
            None => out.push(r),
        }
    }
    out
}

/// The catalog's starting point when nothing was launched yet: the first
/// installed agent (Claude first), its active account, its safety default,
/// the default model, no effort, a new worktree.
pub fn catalog_default(caps: &AgentCapabilities) -> LaunchChoice {
    LaunchChoice {
        agent_id: caps.agent_id.clone(),
        account_id: caps
            .active_account_id
            .clone()
            .unwrap_or_else(|| DEFAULT_ACCOUNT.to_string()),
        approval_mode_id: caps.default_approval_mode_id.clone(),
        model_id: DEFAULT_MODEL.to_string(),
        effort: None,
        extra_args: String::new(),
        prefix: String::new(),
        channels: Vec::new(),
        where_: LaunchWhere::NewWorktree {
            base_branch: String::new(),
            branch: String::new(),
        },
        track_as_feature: false,
        also_on: None,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    const CL: &[&str] = &["low", "medium", "high", "xhigh", "max"];

    fn v(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    fn model(id: &str, label: &str, efforts: &[&str]) -> ModelOption {
        ModelOption {
            id: id.into(),
            label: label.into(),
            note: None,
            efforts: v(efforts),
            available: true,
            unavailable_reason: None,
            unavailable_code: None,
        }
    }

    pub(crate) fn claude_caps() -> AgentCapabilities {
        let mut gone = model("gone", "Gone", CL);
        gone.available = false;
        gone.unavailable_reason = Some("gone is not available on this account".into());
        AgentCapabilities {
            agent_id: "claude".into(),
            cli_version: Some("2.1.284".into()),
            installed: true,
            verified_on_real_install: true,
            accounts: vec![
                AgentAccount {
                    id: "default".into(),
                    label: "Default profile".into(),
                    detail: "Max plan".into(),
                    profile_env: None,
                    signed_in: true,
                    sign_in_state: "signed-in".into(),
                },
                AgentAccount {
                    id: "work".into(),
                    label: "Work".into(),
                    detail: "not signed in".into(),
                    profile_env: Some(ProfileEnv {
                        name: "CLAUDE_CONFIG_DIR".into(),
                        value: "~/.claude-work".into(),
                    }),
                    signed_in: false,
                    sign_in_state: "signed-out".into(),
                },
            ],
            active_account_id: Some("default".into()),
            can_add_account: true,
            models: vec![
                model("default", "Default", CL),
                model("opus", "Opus", CL),
                model("haiku", "Haiku", &[]),
                model(
                    "claude-opus-4-6",
                    "Opus 4.6",
                    &["low", "medium", "high", "max"],
                ),
                gone,
            ],
            model_source: "aliases".into(),
            approval_modes: vec![
                ApprovalModeOption {
                    id: "default".into(),
                    label: "Ask".into(),
                    flag: vec![],
                    note: String::new(),
                    danger: false,
                },
                ApprovalModeOption {
                    id: "acceptEdits".into(),
                    label: "Accept edits".into(),
                    flag: v(&["--permission-mode", "acceptEdits"]),
                    note: String::new(),
                    danger: false,
                },
            ],
            status_source: "exact".into(),
            agent_name: "Claude Code".into(),
            effort_values: v(CL),
            effort_validated_by: "none".into(),
            accepts_typed_model: true,
            account_note: None,
            default_approval_mode_id: "acceptEdits".into(),
            checked_at: 0,
            default_profile_dir: None,
        }
    }

    pub(crate) fn choice() -> LaunchChoice {
        LaunchChoice {
            agent_id: "claude".into(),
            account_id: "default".into(),
            approval_mode_id: "acceptEdits".into(),
            model_id: "opus".into(),
            effort: Some("high".into()),
            extra_args: String::new(),
            prefix: String::new(),
            channels: vec![],
            where_: LaunchWhere::NewWorktree {
                base_branch: "main".into(),
                branch: "hermes/fix-login".into(),
            },
            track_as_feature: false,
            also_on: None,
        }
    }

    #[test]
    fn nearest_effort_matches_the_typescript_rules() {
        assert_eq!(
            nearest_effort(Some("high"), &v(CL)).as_deref(),
            Some("high")
        );
        assert_eq!(nearest_effort(Some("high"), &[]), None);
        assert_eq!(nearest_effort(None, &v(CL)), None);
        assert_eq!(
            nearest_effort(Some("xhigh"), &v(&["low", "medium", "high", "max"])).as_deref(),
            Some("high")
        );
        assert_eq!(
            nearest_effort(Some("ultra"), &v(CL)).as_deref(),
            Some("max")
        );
        assert_eq!(
            nearest_effort(Some("minimal"), &v(&["low", "high"])).as_deref(),
            Some("low")
        );
        assert_eq!(
            nearest_effort(Some("medium"), &v(&["low", "high"])).as_deref(),
            Some("low")
        );
        assert_eq!(
            nearest_effort(Some("bogus"), &v(CL)).as_deref(),
            Some("medium")
        );
        assert_eq!(
            nearest_effort(Some("bogus"), &v(&["low", "high"])).as_deref(),
            Some("low")
        );
    }

    #[test]
    fn a_model_that_reads_as_a_flag_is_never_passed() {
        let mut c = choice();
        c.model_id = "--dangerously-skip-permissions".into();
        // Claude takes typed models, but not this one.
        assert!(find_model(&claude_caps(), &c.model_id).is_none());
        assert!(matches!(
            validate(&c, &claude_caps()),
            LaunchValidation::Refused { .. }
        ));
        let r = reconcile(&c, &claude_caps(), None);
        assert_eq!(r.choice.model_id, "default");
        let claude = crate::agent_catalog::agent("claude").unwrap();
        let (args, _) = model_effort_args(claude, Some(" -x"), Some("--max"));
        assert!(args.is_empty(), "{args:?}");
        let (args, _) = model_effort_args(claude, Some("opus"), Some("high"));
        assert_eq!(args, ["--model", "opus", "--effort", "high"]);
    }

    #[test]
    fn each_issue_carries_a_code_and_its_words_for_the_ui() {
        let p = |i: &ChoiceIssue, k: &str| i.params.get(k).cloned().unwrap_or_default();
        let mut c = choice();
        c.account_id = "work".into();
        c.model_id = "claude-opus-4-6".into();
        c.effort = Some("xhigh".into());
        c.approval_mode_id = "yolo".into();
        let r = reconcile(&c, &claude_caps(), None);
        let codes: Vec<&str> = r.issues.iter().map(|i| i.code.as_str()).collect();
        assert_eq!(
            codes,
            ["accountSignedOutUsing", "effortChanged", "approvalGone"]
        );
        assert_eq!(
            (p(&r.issues[0], "account"), p(&r.issues[0], "using")),
            ("Work".into(), "Default profile".into())
        );
        assert_eq!(
            (
                p(&r.issues[1], "model"),
                p(&r.issues[1], "was"),
                p(&r.issues[1], "now")
            ),
            ("Opus 4.6".into(), "xhigh".into(), "high".into())
        );
        assert_eq!(p(&r.issues[2], "mode"), "yolo");

        let mut caps = claude_caps();
        let opus = caps.models.iter_mut().find(|m| m.id == "opus").unwrap();
        opus.available = false;
        opus.unavailable_reason =
            Some("opus was refused by this account at its last launch".into());
        opus.unavailable_code = Some("refused".into());
        let r = reconcile(&choice(), &caps, None);
        assert_eq!(
            (r.issues[0].code.as_str(), p(&r.issues[0], "model")),
            ("modelRefused", "opus".into())
        );
        let mut c = choice();
        c.model_id = "gone".into();
        assert_eq!(
            reconcile(&c, &claude_caps(), None).issues[0].code,
            "modelUnavailable"
        );
        let mut c = choice();
        c.also_on = Some(Box::new(choice()));
        c.also_on.as_mut().unwrap().account_id = "nobody".into();
        let r = reconcile(&c, &claude_caps(), Some(&claude_caps()));
        assert!(r.issues[0].also_on && r.issues[0].code == "accountGoneUsing");
    }

    #[test]
    fn a_valid_choice_comes_back_unchanged() {
        let r = reconcile(&choice(), &claude_caps(), None);
        assert!(r.issues.is_empty() && r.launchable);
        assert_eq!(r.choice, choice());
    }

    #[test]
    fn unavailable_parts_are_replaced_and_flagged() {
        let mut c = choice();
        c.model_id = "gone".into();
        let r = reconcile(&c, &claude_caps(), None);
        assert_eq!(r.choice.model_id, "default");
        assert_eq!(
            r.issues[0].message,
            "gone is not available on this account; using the default model"
        );

        let mut c = choice();
        c.model_id = "claude-opus-4-6".into();
        c.effort = Some("xhigh".into());
        let r = reconcile(&c, &claude_caps(), None);
        assert_eq!(r.choice.effort.as_deref(), Some("high"));
        assert_eq!(
            r.issues[0].message,
            "Opus 4.6 does not take effort xhigh; using high"
        );

        let mut c = choice();
        c.model_id = "haiku".into();
        let r = reconcile(&c, &claude_caps(), None);
        assert_eq!(r.choice.effort, None);
        assert_eq!(
            r.issues[0].message,
            "Haiku has no effort levels; the effort is left to Claude Code"
        );

        let mut c = choice();
        c.account_id = "work".into();
        let r = reconcile(&c, &claude_caps(), None);
        assert_eq!(r.choice.account_id, "default");
        assert_eq!(
            r.issues[0].message,
            "Work is signed out; using Default profile"
        );
        // Offered, never taken on its own: not launchable as it is.
        assert!(!r.launchable);

        let mut c = choice();
        c.approval_mode_id = "plan".into();
        let r = reconcile(&c, &claude_caps(), None);
        assert_eq!(r.choice.approval_mode_id, "acceptEdits");
    }

    #[test]
    fn a_choice_that_cannot_be_repaired_is_not_launchable() {
        let mut caps = claude_caps();
        caps.installed = false;
        assert!(!reconcile(&choice(), &caps, None).launchable);
        let mut caps = claude_caps();
        for a in &mut caps.accounts {
            a.signed_in = false;
        }
        let r = reconcile(&choice(), &caps, None);
        assert!(!r.launchable);
        assert_eq!(r.issues[0].now, None);
    }

    #[test]
    fn validate_refuses_each_field_with_a_plain_message() {
        let caps = claude_caps();
        assert!(validate(&choice(), &caps).is_ok());
        let mut c = choice();
        c.effort = Some("ultra".into());
        assert_eq!(
            validate(&c, &caps),
            LaunchValidation::refused(
                "effort",
                "Opus does not take effort \"ultra\" (it takes low, medium, high, xhigh, max)"
            )
        );
        let mut c = choice();
        c.model_id = "haiku".into();
        assert_eq!(
            validate(&c, &caps),
            LaunchValidation::refused("effort", "Haiku has no effort levels")
        );
        c.effort = None;
        assert!(validate(&c, &caps).is_ok());
        let mut c = choice();
        c.model_id = "gone".into();
        assert_eq!(
            validate(&c, &caps),
            LaunchValidation::refused("model", "gone is not available on this account")
        );
        let mut c = choice();
        c.account_id = "work".into();
        assert!(
            matches!(validate(&c, &caps), LaunchValidation::Refused { field, .. } if field == "account")
        );
        let mut c = choice();
        c.approval_mode_id = "yolo".into();
        assert!(
            matches!(validate(&c, &caps), LaunchValidation::Refused { field, .. } if field == "approval")
        );
        let mut strict = caps.clone();
        strict.accepts_typed_model = false;
        let mut c = choice();
        c.model_id = "made-up".into();
        assert!(
            matches!(validate(&c, &strict), LaunchValidation::Refused { field, .. } if field == "model")
        );
        assert!(
            validate(&c, &caps).is_ok(),
            "a typed model is fine where the CLI takes one"
        );
    }

    #[test]
    fn the_preview_is_the_line_hermes_runs() {
        let claude = crate::agent_catalog::agent("claude").unwrap();
        let mut c = choice();
        c.prefix = "caffeinate -i".into();
        c.channels = vec!["plugin:your-plugin".into()];
        let env = ProfileEnv {
            name: "CLAUDE_CONFIG_DIR".into(),
            value: "/home-fixture/.claude-work".into(),
        };
        assert_eq!(
            preview(claude, &c, Some(&env), "Fix the flaky login test on CI\nmore detail", Some("/home-fixture")),
            "CLAUDE_CONFIG_DIR=~/.claude-work caffeinate -i claude --permission-mode acceptEdits --model opus --effort high 'Fix the flaky login test on CI…' (+1 line) --channels plugin:your-plugin"
        );
        // One line: as it is, quoted the way a shell takes it ($ and ` kept, ' escaped).
        assert_eq!(
            preview(claude, &c, None, "Don't touch $HOME", None),
            "caffeinate -i claude --permission-mode acceptEdits --model opus --effort high 'Don'\\''t touch $HOME' --channels plugin:your-plugin"
        );
        assert!(preview(claude, &c, None, "a\n\nb\nc", None).contains("'a…' (+2 lines)"));
        let codex = crate::agent_catalog::agent("codex").unwrap();
        let mut c = choice();
        c.agent_id = "codex".into();
        c.approval_mode_id = "auto".into();
        c.model_id = "gpt-5.6-luna".into();
        c.effort = Some("medium".into());
        assert_eq!(
            preview(codex, &c, None, "Add ru locale", None),
            "codex --sandbox workspace-write --ask-for-approval on-request -m gpt-5.6-luna -c 'model_reasoning_effort=\"medium\"' 'Add ru locale'"
        );
        let mut c = choice();
        c.model_id = "default".into();
        c.effort = None;
        c.approval_mode_id = "default".into();
        assert_eq!(preview(claude, &c, None, "", None), "claude");
        let goose = crate::agent_catalog::agent("goose").unwrap();
        let mut c = choice();
        c.agent_id = "goose".into();
        c.approval_mode_id = "default".into();
        c.model_id = "gpt-5.5".into();
        c.effort = Some("low".into());
        assert_eq!(
            preview(goose, &c, None, "x", None),
            "GOOSE_THINKING_EFFORT=low goose session --model gpt-5.5"
        );
    }

    #[test]
    fn the_combo_key_ignores_the_branch_name_and_channel_order_only() {
        let mut a = choice();
        a.channels = vec!["b".into(), "a".into()];
        let mut b = a.clone();
        b.channels = vec!["a".into(), "b".into()];
        b.where_ = LaunchWhere::NewWorktree {
            base_branch: "main".into(),
            branch: "hermes/other".into(),
        };
        assert_eq!(combo_key(&a), combo_key(&b));
        let mut c = a.clone();
        c.effort = Some("max".into());
        assert_ne!(combo_key(&a), combo_key(&c));
        let mut d = a.clone();
        d.where_ = LaunchWhere::NewWorktree {
            base_branch: "dev".into(),
            branch: String::new(),
        };
        assert_ne!(combo_key(&a), combo_key(&d));
        assert_eq!(
            stored_form(&b).where_,
            LaunchWhere::NewWorktree {
                base_branch: "main".into(),
                branch: String::new()
            }
        );
    }

    fn row(key: &str, count: i64, last: i64) -> HistoryRow {
        let mut c = choice();
        c.model_id = key.into();
        HistoryRow {
            combo_key: key.into(),
            choice: c,
            count,
            last_used_at: last,
            uses: vec![last; count as usize],
        }
    }

    #[test]
    fn frequent_long_ago_does_not_beat_frequent_lately() {
        let now = 1_800_000_000_000;
        let day = 24 * 60 * 60 * 1000;
        // Used 100 times long ago and once yesterday...
        let mut veteran = row("veteran", 101, now - day);
        veteran.uses = vec![now - day];
        // ...against five times this month.
        let mut lately = row("lately", 5, now - 3 * day);
        lately.uses = (0..5).map(|i| now - (3 + i) * day).collect();
        let rows = [veteran, lately];
        assert_eq!(pick_usual(&rows, now).unwrap().combo_key, "lately");
        // Launch times older than RECENT_MS fall out; at most MAX_USES stay.
        let uses = add_use(vec![now - RECENT_MS - 1, now - day], now);
        assert_eq!(uses, [now - day, now]);
        let many = (0..MAX_USES as i64 + 10).fold(Vec::new(), |u, i| add_use(u, now + i));
        assert_eq!(many.len(), MAX_USES);
        assert_eq!(*many.last().unwrap(), now + MAX_USES as i64 + 9);
    }

    #[test]
    fn the_usual_combination_is_the_most_frequent_recent_one() {
        let now = 1_800_000_000_000;
        let day = 24 * 60 * 60 * 1000;
        let rows = vec![
            row("a", 3, now - day),
            row("b", 5, now - 2 * day),
            row("c", 1, now),
        ];
        assert_eq!(pick_usual(&rows, now).unwrap().combo_key, "b");
    }

    #[test]
    fn a_tie_goes_to_the_most_recent() {
        let now = 1_800_000_000_000;
        let rows = vec![
            row("a", 4, now - 5000),
            row("b", 4, now - 10),
            row("c", 4, now - 7000),
        ];
        assert_eq!(pick_usual(&rows, now).unwrap().combo_key, "b");
    }

    #[test]
    fn old_launches_count_only_when_nothing_is_recent() {
        let now = 1_800_000_000_000;
        let old = now - RECENT_MS - 1;
        let rows = vec![row("old-favourite", 50, old), row("new", 1, now - 1000)];
        assert_eq!(pick_usual(&rows, now).unwrap().combo_key, "new");
        let only_old = vec![row("x", 2, old - 5), row("y", 7, old)];
        assert_eq!(pick_usual(&only_old, now).unwrap().combo_key, "y");
        assert!(pick_usual(&[], now).is_none());
    }

    #[test]
    fn the_global_usual_sums_repositories() {
        let merged = merge_rows(vec![row("a", 2, 10), row("b", 3, 20), row("a", 2, 30)]);
        let a = merged.iter().find(|r| r.combo_key == "a").unwrap();
        assert_eq!((a.count, a.last_used_at), (4, 30));
        assert_eq!(pick_usual(&merged, 40).unwrap().combo_key, "a");
    }
}
