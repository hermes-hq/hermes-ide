use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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
}

// ─── Session Colors ─────────────────────────────────────────────────

pub const SESSION_COLORS: &[&str] = &[
    "#58a6ff", "#3fb950", "#bc8cff", "#f78166", "#39c5cf", "#d29922", "#f47067", "#d2a8ff",
];

pub fn next_color(index: usize) -> String {
    SESSION_COLORS[index % SESSION_COLORS.len()].to_string()
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
    pub context_injected: bool,
    pub has_initial_context: bool,
    pub last_nudged_version: i64,
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
    pub context_injected: bool,
    pub has_initial_context: bool,
    pub last_nudged_version: i64,
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
            context_injected: s.context_injected,
            has_initial_context: s.has_initial_context,
            last_nudged_version: s.last_nudged_version,
        }
    }
}

// ─── Terminal Command Intelligence ───────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellEnvironment {
    pub shell_type: String,
    pub plugins_detected: Vec<String>,
    pub has_native_autosuggest: bool,
    pub has_oh_my_zsh: bool,
    pub has_syntax_highlighting: bool,
    pub has_starship: bool,
    pub has_powerlevel10k: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectContextInfo {
    pub has_git: bool,
    pub package_manager: Option<String>,
    pub languages: Vec<String>,
    pub frameworks: Vec<String>,
}
