use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ─── Session Mode ───────────────────────────────────────────────────

/// How a session is run and rendered on the frontend.
///
/// - `Terminal`: the agent's (or shell's) own interface in a PTY/xterm.  The
///   default for every provider, Claude included (ADR 003).
/// - `Agent`: the optional Agent view.  A per-session Node bridge running the
///   Claude Agent SDK (`src-tauri/bridge/`) drives an `<AgentSessionView>`.
///   Claude only, and only when the user asks for it.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionMode {
    #[default]
    Terminal,
    Agent,
}

// ─── Session Phase State Machine ────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SessionPhase {
    Creating,
    Initializing,
    ShellReady,
    LaunchingAgent,
    Idle,
    Busy,
    NeedsInput,
    Error(String),
    Closing,
    Disconnected,
    Destroyed,
}

impl SessionPhase {
    pub fn as_str(&self) -> &str {
        match self {
            SessionPhase::Creating => "creating",
            SessionPhase::Initializing => "initializing",
            SessionPhase::ShellReady => "shell_ready",
            SessionPhase::LaunchingAgent => "launching_agent",
            SessionPhase::Idle => "idle",
            SessionPhase::Busy => "busy",
            SessionPhase::NeedsInput => "needs_input",
            SessionPhase::Error(_) => "error",
            SessionPhase::Closing => "closing",
            SessionPhase::Disconnected => "disconnected",
            SessionPhase::Destroyed => "destroyed",
        }
    }

    pub fn accepts_input(&self) -> bool {
        matches!(
            self,
            SessionPhase::Idle
                | SessionPhase::Busy
                | SessionPhase::NeedsInput
                | SessionPhase::Initializing
                | SessionPhase::ShellReady
                | SessionPhase::LaunchingAgent
        )
    }

    /// Destroyed is terminal: once `close_session` marks a session destroyed,
    /// late PTY output (e.g. from processes that outlived the shell) must not
    /// flip it back to a live phase and re-announce it to the frontend.
    pub fn can_transition_to(&self, new_phase: &SessionPhase) -> bool {
        self != new_phase && *self != SessionPhase::Destroyed
    }
}

// ─── Data Models ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellInfo {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub name: String,
    pub provider: String,
    pub model: Option<String>,
    pub detected_at: String,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub tool: String,
    pub args: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderTokens {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub estimated_cost_usd: f64,
    pub model: String,
    pub last_updated: String,
    pub update_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionEvent {
    pub command: String,
    pub label: String,
    pub provider: String,
    pub is_suggestion: bool,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionTemplate {
    pub command: String,
    pub label: String,
    pub description: String,
    pub category: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryFact {
    pub key: String,
    pub value: String,
    pub source: String,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMetrics {
    pub output_lines: u64,
    pub error_count: u32,
    pub stuck_score: f32,
    pub token_usage: HashMap<String, ProviderTokens>,
    pub tool_calls: Vec<ToolCall>,
    pub tool_call_summary: HashMap<String, u32>,
    pub files_touched: Vec<String>,
    pub recent_errors: Vec<String>,
    pub recent_actions: Vec<ActionEvent>,
    pub available_actions: Vec<ActionTemplate>,
    pub memory_facts: Vec<MemoryFact>,
    pub latency_p50_ms: Option<f64>,
    pub latency_p95_ms: Option<f64>,
    pub latency_samples: Vec<f64>,
    pub token_history: Vec<(u64, u64)>, // (input, output) samples for sparkline
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortForward {
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConnectionInfo {
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub tmux_session: Option<String>,
    #[serde(default)]
    pub identity_file: Option<String>,
    /// Optional ProxyJump host (`ssh -J`), e.g. `bastion.example.com`.
    #[serde(default)]
    pub jump_host: Option<String>,
    #[serde(default)]
    pub port_forwards: Vec<PortForward>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxSessionEntry {
    pub name: String,
    pub windows: u32,
    pub attached: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmuxWindowEntry {
    pub index: u32,
    pub name: String,
    pub active: bool,
}

/// Where an agent launched through the `hi` helper stands at startup.
///
/// `launching` from the moment the launch line is typed; `started` once the
/// agent's own start signal arrived (exact); `waiting_at_startup_prompt` when
/// no start signal came within a few seconds (a guess — vendor folder-trust
/// dialogs hold every hook back until answered); `ended` after the agent's
/// end signal. The inbox reads this field; the session list shows the guess.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentStartupState {
    Launching,
    Started,
    WaitingAtStartupPrompt,
    Ended,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentStartup {
    pub state: AgentStartupState,
    /// When the state was entered (RFC 3339).
    pub since: String,
    /// `exact` when a signal from the agent set it, `guessed` for a timeout.
    pub confidence: String,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub label: String,
    pub description: String,
    pub color: String,
    pub group: Option<String>,
    pub phase: SessionPhase,
    pub working_directory: String,
    pub shell: String,
    pub created_at: String,
    pub last_activity_at: String,
    pub workspace_paths: Vec<String>,
    pub detected_agent: Option<AgentInfo>,
    pub metrics: SessionMetrics,
    pub ai_provider: Option<String>,
    pub auto_approve: bool,
    pub permission_mode: String,
    /// Command prepended to the AI-agent launch string (e.g. `caffeinate -i`,
    /// `wsl`, `nice -n 10`). Trimmed and ignored when empty. Ignored for SSH
    /// sessions (would run on the wrong machine).
    #[serde(default)]
    pub custom_prefix: String,
    pub custom_suffix: String,
    /// Custom agent only: the name the user gave it, shown for the session.
    #[serde(default)]
    pub agent_name: String,
    /// Custom agent only: the command that starts it (same trust as a
    /// command typed at the prompt; line breaks are stripped at launch).
    #[serde(default)]
    pub agent_command: String,
    pub channels: Vec<String>,
    pub context_injected: bool,
    pub has_initial_context: bool,
    pub last_nudged_version: i64,
    pub ssh_info: Option<SshConnectionInfo>,
    /// Frontend runtime mode.  `terminal` spawns a PTY; `agent` drives the
    /// Claude subprocess via `crate::agent::spawn_agent_session`.  Defaults
    /// to `terminal` for backward compat with on-disk session rows that
    /// predate the field.
    #[serde(default)]
    pub mode: SessionMode,
    /// The agent's own conversation id (Claude/Gemini session id, Codex
    /// thread id): pre-assigned at launch where the vendor allows it,
    /// otherwise recorded from the agent's first signal. Restoring a session
    /// resumes this conversation.
    #[serde(default)]
    pub vendor_session_id: Option<String>,
    /// Startup state of an agent launched through the `hi` helper.
    #[serde(default)]
    pub agent_startup: Option<AgentStartup>,
    /// The terminal lives in the session host (feature flag `sessionHost`)
    /// and survives this app: quit, update, crash.
    #[serde(default)]
    pub hosted: bool,
    /// Start the agent through the bundled `hi` helper (feature flag
    /// `launchHelper`) instead of typing the vendor command into the shell.
    #[serde(skip)]
    pub launch_helper: bool,
    /// The per-launch secret the agent's signals must carry (F11). Set when
    /// the launch configured the agent's hooks; an in-band terminal marker
    /// (`OSC 777 ... hermes-signal;v1:<nonce>:<Event>`) is only exact when
    /// it carries this nonce.
    #[serde(skip)]
    pub signal_nonce: Option<String>,
    /// The task typed into the task launcher (F15): the agent's first prompt
    /// on its first start. Never saved; a restored session resumes instead.
    #[serde(skip)]
    pub task_prompt: Option<String>,
    /// Deferred nudge: stored when context is applied while the agent is busy.
    /// Delivered when the session phase transitions to NeedsInput.
    #[serde(skip)]
    pub pending_nudge: Option<PendingNudge>,
}

/// A context nudge that couldn't be delivered immediately (agent was busy).
#[derive(Debug, Clone)]
pub struct PendingNudge {
    pub version: i64,
    pub file_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionUpdate {
    pub id: String,
    pub label: String,
    pub description: String,
    pub color: String,
    pub group: Option<String>,
    pub phase: String,
    pub working_directory: String,
    pub shell: String,
    pub created_at: String,
    pub last_activity_at: String,
    pub workspace_paths: Vec<String>,
    pub detected_agent: Option<AgentInfo>,
    pub metrics: SessionMetrics,
    pub ai_provider: Option<String>,
    pub auto_approve: bool,
    pub permission_mode: String,
    #[serde(default)]
    pub custom_prefix: String,
    pub custom_suffix: String,
    #[serde(default)]
    pub agent_name: String,
    #[serde(default)]
    pub agent_command: String,
    pub channels: Vec<String>,
    pub context_injected: bool,
    pub has_initial_context: bool,
    pub last_nudged_version: i64,
    pub ssh_info: Option<SshConnectionInfo>,
    #[serde(default)]
    pub mode: SessionMode,
    #[serde(default)]
    pub vendor_session_id: Option<String>,
    #[serde(default)]
    pub agent_startup: Option<AgentStartup>,
    /// The terminal lives in the session host (N20).
    #[serde(default)]
    pub hosted: bool,
    /// This `create_session` reattached to a program the host kept running
    /// (its output was replayed), rather than starting a new one.
    #[serde(default)]
    pub reattached: bool,
}

impl From<&Session> for SessionUpdate {
    fn from(s: &Session) -> Self {
        SessionUpdate {
            id: s.id.clone(),
            label: s.label.clone(),
            description: s.description.clone(),
            color: s.color.clone(),
            group: s.group.clone(),
            phase: s.phase.as_str().to_string(),
            working_directory: s.working_directory.clone(),
            shell: s.shell.clone(),
            created_at: s.created_at.clone(),
            last_activity_at: s.last_activity_at.clone(),
            workspace_paths: s.workspace_paths.clone(),
            detected_agent: s.detected_agent.clone(),
            metrics: s.metrics.clone(),
            ai_provider: s.ai_provider.clone(),
            auto_approve: s.auto_approve,
            permission_mode: s.permission_mode.clone(),
            custom_prefix: s.custom_prefix.clone(),
            custom_suffix: s.custom_suffix.clone(),
            agent_name: s.agent_name.clone(),
            agent_command: s.agent_command.clone(),
            channels: s.channels.clone(),
            context_injected: s.context_injected,
            has_initial_context: s.has_initial_context,
            last_nudged_version: s.last_nudged_version,
            ssh_info: s.ssh_info.clone(),
            mode: s.mode,
            vendor_session_id: s.vendor_session_id.clone(),
            agent_startup: s.agent_startup.clone(),
            hosted: s.hosted,
            reattached: false,
        }
    }
}

// ─── Remote Git Info ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteGitInfo {
    pub branch: Option<String>,
    pub change_count: i32,
}

// ─── Terminal Command Intelligence ───────────────────────────────────

/// Serialized camelCase to match the frontend `ShellEnvironment` type.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellEnvironment {
    pub shell_type: String,
    pub plugins_detected: Vec<String>,
    pub has_native_autosuggest: bool,
    pub has_oh_my_zsh: bool,
    pub has_syntax_highlighting: bool,
    pub has_starship: bool,
    pub has_powerlevel10k: bool,
    pub shell_integration_active: bool,
    /// Whether Hermes inline suggestions were on when the session was spawned.
    pub hermes_suggestions: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectContextInfo {
    pub has_git: bool,
    pub package_manager: Option<String>,
    pub languages: Vec<String>,
    pub frameworks: Vec<String>,
}
