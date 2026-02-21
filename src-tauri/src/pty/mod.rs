use lazy_static::lazy_static;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex as StdMutex};
use std::thread;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::AppState;
use crate::db::ExecutionNode;

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
            SessionPhase::Error(_) => "error",
            SessionPhase::Closing => "closing",
            SessionPhase::Destroyed => "destroyed",
        }
    }

    pub fn accepts_input(&self) -> bool {
        matches!(self, SessionPhase::Idle | SessionPhase::Busy | SessionPhase::Initializing | SessionPhase::ShellReady | SessionPhase::LaunchingAgent)
    }
}

// ─── Session Colors ─────────────────────────────────────────────────

const SESSION_COLORS: &[&str] = &[
    "#58a6ff", "#3fb950", "#bc8cff", "#f78166",
    "#39c5cf", "#d29922", "#f47067", "#d2a8ff",
];

fn next_color(index: usize) -> String {
    SESSION_COLORS[index % SESSION_COLORS.len()].to_string()
}

// ─── Data Models ────────────────────────────────────────────────────

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
    pub context_injected: bool,
    pub has_initial_context: bool,
    pub last_nudged_version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionUpdate {
    pub id: String,
    pub label: String,
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

// ─── Provider Adapter System ────────────────────────────────────────

struct LineAnalysis {
    token_update: Option<TokenUpdate>,
    tool_call: Option<ToolCall>,
    action: Option<ActionEvent>,
    phase_hint: Option<PhaseHint>,
    memory_fact: Option<MemoryFact>,
}

struct TokenUpdate {
    provider: String,
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    cost_usd: Option<f64>,
    is_cumulative: bool,
}

#[derive(Debug)]
enum PhaseHint {
    PromptDetected,
    WorkStarted,
}

trait ProviderAdapter: Send + Sync {
    fn detect_agent(&self, line: &str) -> Option<AgentInfo>;
    fn analyze_line(&self, line: &str) -> LineAnalysis;
    fn is_prompt(&self, line: &str) -> bool;
    fn known_actions(&self) -> Vec<ActionTemplate>;
}

// ─── Claude Code Adapter ────────────────────────────────────────────

lazy_static! {
    // OSC 7 — shell reports current working directory: \x1b]7;file://hostname/path\x07
    static ref OSC7_RE: Regex = Regex::new(
        r"\x1b\]7;file://[^/]*(/.+?)(?:\x07|\x1b\\)"
    ).unwrap();
    // Fallback: detect cd commands
    static ref CD_CMD_RE: Regex = Regex::new(
        r"^\$?\s*cd\s+(.+)"
    ).unwrap();
    static ref CLAUDE_TOKEN_RE: Regex = Regex::new(
        r"(?i)(?:input|prompt)[:\s]*([0-9,.]+[kKmM]?)\s*tokens?\s*[|·/,]\s*(?:output|completion)[:\s]*([0-9,.]+[kKmM]?)\s*tokens?"
    ).unwrap();
    // "12.5K in, 3.2K out" or "12.5K↓ 3.2K↑"
    static ref CLAUDE_TOKEN_SHORT_RE: Regex = Regex::new(
        r"([0-9,.]+[kKmM]?)\s*(?:in|input|↓|sent)[,\s]+([0-9,.]+[kKmM]?)\s*(?:out|output|↑|received)"
    ).unwrap();
    // "Total tokens: 15,234" or "tokens: 15K"
    static ref CLAUDE_TOKEN_TOTAL_RE: Regex = Regex::new(
        r"(?i)(?:total\s+)?tokens?[:\s]+([0-9,.]+[kKmM]?)"
    ).unwrap();
    static ref CLAUDE_COST_RE: Regex = Regex::new(
        r"(?i)(?:total\s+)?cost[:\s]+\$([0-9]+\.?[0-9]*)"
    ).unwrap();
    // Broader cost pattern: "$0.0432" anywhere in a short line
    static ref DOLLAR_AMOUNT_RE: Regex = Regex::new(
        r"\$([0-9]+\.[0-9]{2,4})"
    ).unwrap();
    // Claude Code /cost output: "Session cost: $0.04" or "API cost: $0.12"
    static ref SESSION_COST_RE: Regex = Regex::new(
        r"(?i)(?:session|api|total|cumulative)\s+cost[:\s]*\$([0-9]+\.?[0-9]*)"
    ).unwrap();
    static ref TOOL_CALL_RE: Regex = Regex::new(
        r"^[●⏺◉•]\s*(\w+)\((.+?)\)"
    ).unwrap();
    // Claude Code tool use: "● Read(file.txt)" or "⏺ Read 3 files" or "● Write(file.txt)"
    // Also matches "● Update(file)" which Claude Code uses for Edit
    static ref CLAUDE_TOOL_RE: Regex = Regex::new(
        r"^[●⏺◉•✻\*]\s*(Read|Write|Edit|Update|Bash|Glob|Grep|Task|Search|WebFetch|WebSearch|NotebookEdit|TodoRead|TodoWrite)\b"
    ).unwrap();
    // Claude Code also shows "Edit file\n  path/to/file" as a standalone line
    static ref EDIT_FILE_RE: Regex = Regex::new(
        r"^Edit file$"
    ).unwrap();
    static ref SLASH_CMD_RE: Regex = Regex::new(
        r"(?:^|\s)(\/(?:init|build|test|run|review|commit|help|clear|compact|memory|config|cost|doctor|login|logout|bug|terminal-setup|allowed-tools|permissions|vim|add|drop|undo|diff|ls|tokens|model|settings|map|map-refresh|voice|paste|architect|ask|code|chat-mode|lint|web|read-only|reset|quit|git|apply|stats|save|restore|sandbox|tools|shell|edit|yolo)\b)"
    ).unwrap();
    static ref FILE_PATH_RE: Regex = Regex::new(
        r"(?:^|\s)((?:/[\w.@-]+)+\.[\w]+)"
    ).unwrap();
    static ref AIDER_TOKEN_RE: Regex = Regex::new(
        r"(?i)tokens?[:\s]*([0-9.]+k?)\s*sent[,\s]*([0-9.]+k?)\s*(?:received|recv)"
    ).unwrap();
}

struct ClaudeCodeAdapter;

impl ProviderAdapter for ClaudeCodeAdapter {
    fn detect_agent(&self, line: &str) -> Option<AgentInfo> {
        let lower = line.to_lowercase();
        if lower.contains("claude code") || lower.contains("claude-code")
            || (lower.contains("claude") && (lower.contains("v2.") || lower.contains("v1.")))
        {
            let model = extract_model_name(line);
            Some(AgentInfo {
                name: "Claude Code".into(),
                provider: "anthropic".into(),
                model,
                detected_at: now(),
                confidence: 0.95,
            })
        } else {
            None
        }
    }

    fn analyze_line(&self, line: &str) -> LineAnalysis {
        let mut result = empty_analysis();
        let now_str = now();

        // Token detection — try multiple patterns
        if let Some(caps) = CLAUDE_TOKEN_RE.captures(line) {
            let input = parse_token_count(&caps[1]);
            let output = parse_token_count(&caps[2]);
            let cost = CLAUDE_COST_RE.captures(line)
                .or_else(|| SESSION_COST_RE.captures(line))
                .or_else(|| DOLLAR_AMOUNT_RE.captures(line))
                .and_then(|c| c[1].parse().ok());
            result.token_update = Some(TokenUpdate {
                provider: "anthropic".into(),
                model: "unknown".into(),
                input_tokens: input,
                output_tokens: output,
                cost_usd: cost,
                is_cumulative: true,
            });
        } else if let Some(caps) = CLAUDE_TOKEN_SHORT_RE.captures(line) {
            let input = parse_token_count(&caps[1]);
            let output = parse_token_count(&caps[2]);
            let cost = DOLLAR_AMOUNT_RE.captures(line).and_then(|c| c[1].parse().ok());
            result.token_update = Some(TokenUpdate {
                provider: "anthropic".into(),
                model: "unknown".into(),
                input_tokens: input,
                output_tokens: output,
                cost_usd: cost,
                is_cumulative: true,
            });
        } else if let Some(caps) = SESSION_COST_RE.captures(line) {
            if let Ok(cost) = caps[1].parse::<f64>() {
                result.token_update = Some(TokenUpdate {
                    provider: "anthropic".into(),
                    model: "unknown".into(),
                    input_tokens: 0,
                    output_tokens: 0,
                    cost_usd: Some(cost),
                    is_cumulative: true,
                });
            }
        } else if let Some(caps) = CLAUDE_COST_RE.captures(line) {
            if let Ok(cost) = caps[1].parse::<f64>() {
                result.token_update = Some(TokenUpdate {
                    provider: "anthropic".into(),
                    model: "unknown".into(),
                    input_tokens: 0,
                    output_tokens: 0,
                    cost_usd: Some(cost),
                    is_cumulative: true,
                });
            }
        } else if let Some(caps) = CLAUDE_TOKEN_TOTAL_RE.captures(line) {
            // Only "total tokens" without in/out split
            let total = parse_token_count(&caps[1]);
            if total > 0 {
                let cost = DOLLAR_AMOUNT_RE.captures(line).and_then(|c| c[1].parse().ok());
                result.token_update = Some(TokenUpdate {
                    provider: "anthropic".into(),
                    model: "unknown".into(),
                    input_tokens: total / 2,  // rough estimate
                    output_tokens: total / 2,
                    cost_usd: cost,
                    is_cumulative: true,
                });
            }
        }

        // Tool call detection (specific pattern with args)
        if let Some(caps) = TOOL_CALL_RE.captures(line) {
            result.tool_call = Some(ToolCall {
                tool: caps[1].to_string(),
                args: caps[2].to_string(),
                timestamp: now_str.clone(),
            });
            result.phase_hint = Some(PhaseHint::WorkStarted);
        }
        // Broader Claude Code tool use detection (e.g. "● Read 3 files")
        else if let Some(caps) = CLAUDE_TOOL_RE.captures(line) {
            let tool_name = caps[1].to_string();
            let args = line[caps[0].len()..].trim().to_string();
            result.tool_call = Some(ToolCall {
                tool: tool_name,
                args: if args.is_empty() { "(...)".into() } else { args },
                timestamp: now_str.clone(),
            });
            result.phase_hint = Some(PhaseHint::WorkStarted);
        }

        // Slash command detection
        if let Some(caps) = SLASH_CMD_RE.captures(line) {
            let cmd = caps[1].to_string();
            result.action = Some(ActionEvent {
                label: slash_label(&cmd),
                command: cmd,
                provider: "claude-code".into(),
                is_suggestion: false,
                timestamp: now_str.clone(),
            });
        }

        // Memory fact extraction
        let lower = line.to_lowercase();
        if lower.contains("using") && lower.contains("as package manager") {
            if let Some(pm) = extract_between(line, "using ", " as") {
                result.memory_fact = Some(MemoryFact {
                    key: "package_manager".into(),
                    value: pm,
                    source: "agent_output".into(),
                    confidence: 0.8,
                });
            }
        } else if lower.contains("running on port") || lower.contains("listening on port") {
            if let Some(port) = extract_port(line) {
                result.memory_fact = Some(MemoryFact {
                    key: "dev_port".into(),
                    value: port,
                    source: "agent_output".into(),
                    confidence: 0.7,
                });
            }
        } else if lower.contains("test framework") || (lower.contains("using") && lower.contains("for testing")) {
            if let Some(tf) = extract_between(line, "using ", " for") {
                result.memory_fact = Some(MemoryFact {
                    key: "test_framework".into(),
                    value: tf,
                    source: "agent_output".into(),
                    confidence: 0.7,
                });
            }
        }

        // Prompt detection
        if self.is_prompt(line) {
            result.phase_hint = Some(PhaseHint::PromptDetected);
        }

        result
    }

    fn is_prompt(&self, line: &str) -> bool {
        let trimmed = line.trim();
        // Claude Code specific prompts
        if trimmed.ends_with(">") && trimmed.len() < 40 && !trimmed.contains('<') && !trimmed.contains("->") {
            return true;
        }
        is_shell_prompt(trimmed)
    }

    fn known_actions(&self) -> Vec<ActionTemplate> {
        vec![
            ActionTemplate { command: "/init".into(), label: "Init CLAUDE.md".into(), description: "Create project memory file".into(), category: "Setup".into() },
            ActionTemplate { command: "/compact".into(), label: "Compact".into(), description: "Compress context window".into(), category: "Context".into() },
            ActionTemplate { command: "/memory".into(), label: "Memory".into(), description: "View/edit project memory".into(), category: "Context".into() },
            ActionTemplate { command: "/review".into(), label: "Review".into(), description: "Review recent changes".into(), category: "Code".into() },
            ActionTemplate { command: "/cost".into(), label: "Cost".into(), description: "Show token cost breakdown".into(), category: "Info".into() },
            ActionTemplate { command: "/doctor".into(), label: "Doctor".into(), description: "Check installation health".into(), category: "Info".into() },
            ActionTemplate { command: "/help".into(), label: "Help".into(), description: "Show available commands".into(), category: "Info".into() },
            ActionTemplate { command: "/clear".into(), label: "Clear".into(), description: "Clear conversation history".into(), category: "Context".into() },
            ActionTemplate { command: "/config".into(), label: "Config".into(), description: "Open configuration".into(), category: "Setup".into() },
            ActionTemplate { command: "/login".into(), label: "Login".into(), description: "Authenticate with Anthropic".into(), category: "Setup".into() },
            ActionTemplate { command: "/logout".into(), label: "Logout".into(), description: "Sign out of Anthropic".into(), category: "Setup".into() },
            ActionTemplate { command: "/bug".into(), label: "Bug Report".into(), description: "Report a bug".into(), category: "Info".into() },
            ActionTemplate { command: "/terminal-setup".into(), label: "Terminal Setup".into(), description: "Configure terminal integration".into(), category: "Setup".into() },
            ActionTemplate { command: "/allowed-tools".into(), label: "Allowed Tools".into(), description: "Manage tool permissions".into(), category: "Setup".into() },
            ActionTemplate { command: "/permissions".into(), label: "Permissions".into(), description: "View/edit permissions".into(), category: "Setup".into() },
            ActionTemplate { command: "/vim".into(), label: "Vim Mode".into(), description: "Toggle vim keybindings".into(), category: "Setup".into() },
        ]
    }
}

// ─── Aider Adapter ──────────────────────────────────────────────────

struct AiderAdapter;

impl ProviderAdapter for AiderAdapter {
    fn detect_agent(&self, line: &str) -> Option<AgentInfo> {
        let lower = line.to_lowercase();
        if lower.contains("aider") && (lower.contains("v0.") || lower.starts_with("aider")) {
            let provider = if lower.contains("claude") || lower.contains("anthropic") {
                "anthropic"
            } else if lower.contains("gpt") || lower.contains("openai") {
                "openai"
            } else {
                "unknown"
            };
            Some(AgentInfo {
                name: "Aider".into(),
                provider: provider.into(),
                model: extract_model_name(line),
                detected_at: now(),
                confidence: 0.9,
            })
        } else {
            None
        }
    }

    fn analyze_line(&self, line: &str) -> LineAnalysis {
        let mut result = empty_analysis();
        let now_str = now();

        if let Some(caps) = AIDER_TOKEN_RE.captures(line) {
            result.token_update = Some(TokenUpdate {
                provider: "unknown".into(),
                model: "unknown".into(),
                input_tokens: parse_k_count(&caps[1]),
                output_tokens: parse_k_count(&caps[2]),
                cost_usd: None,
                is_cumulative: false,
            });
        }

        // Aider tool-like patterns
        let lower = line.to_lowercase();
        if lower.contains("applied edit to") || lower.contains("wrote to file") {
            result.tool_call = Some(ToolCall { tool: "Edit".into(), args: line.to_string(), timestamp: now_str.clone() });
        }
        if lower.starts_with("running:") || lower.starts_with("$ ") {
            result.tool_call = Some(ToolCall { tool: "Bash".into(), args: line.to_string(), timestamp: now_str.clone() });
        }

        // Aider commands
        if line.starts_with("/") {
            let cmd = line.split_whitespace().next().unwrap_or("").to_string();
            if ["/add", "/drop", "/run", "/test", "/commit", "/diff", "/help", "/clear", "/undo"].contains(&cmd.as_str()) {
                result.action = Some(ActionEvent {
                    label: slash_label(&cmd),
                    command: cmd,
                    provider: "aider".into(),
                    is_suggestion: false,
                    timestamp: now_str,
                });
            }
        }

        if self.is_prompt(line) {
            result.phase_hint = Some(PhaseHint::PromptDetected);
        }

        result
    }

    fn is_prompt(&self, line: &str) -> bool {
        let trimmed = line.trim();
        trimmed.starts_with("aider>") || trimmed.starts_with("> ") || is_shell_prompt(trimmed)
    }

    fn known_actions(&self) -> Vec<ActionTemplate> {
        vec![
            ActionTemplate { command: "/add".into(), label: "Add File".into(), description: "Add file to chat context".into(), category: "Files".into() },
            ActionTemplate { command: "/drop".into(), label: "Drop File".into(), description: "Remove file from chat context".into(), category: "Files".into() },
            ActionTemplate { command: "/run".into(), label: "Run Command".into(), description: "Run a shell command".into(), category: "Code".into() },
            ActionTemplate { command: "/test".into(), label: "Run Tests".into(), description: "Run test suite".into(), category: "Code".into() },
            ActionTemplate { command: "/commit".into(), label: "Commit".into(), description: "Commit pending changes".into(), category: "Git".into() },
            ActionTemplate { command: "/undo".into(), label: "Undo".into(), description: "Undo last AI change".into(), category: "Code".into() },
            ActionTemplate { command: "/diff".into(), label: "Diff".into(), description: "Show pending changes diff".into(), category: "Git".into() },
            ActionTemplate { command: "/clear".into(), label: "Clear".into(), description: "Clear chat history".into(), category: "Context".into() },
            ActionTemplate { command: "/help".into(), label: "Help".into(), description: "Show available commands".into(), category: "Info".into() },
            ActionTemplate { command: "/ls".into(), label: "List Files".into(), description: "List files in chat".into(), category: "Files".into() },
            ActionTemplate { command: "/tokens".into(), label: "Tokens".into(), description: "Show token usage report".into(), category: "Info".into() },
            ActionTemplate { command: "/model".into(), label: "Switch Model".into(), description: "Change AI model".into(), category: "Setup".into() },
            ActionTemplate { command: "/settings".into(), label: "Settings".into(), description: "Show current settings".into(), category: "Setup".into() },
            ActionTemplate { command: "/map".into(), label: "Repo Map".into(), description: "Show repository map".into(), category: "Context".into() },
            ActionTemplate { command: "/map-refresh".into(), label: "Refresh Map".into(), description: "Refresh repository map".into(), category: "Context".into() },
            ActionTemplate { command: "/voice".into(), label: "Voice".into(), description: "Toggle voice input".into(), category: "Setup".into() },
            ActionTemplate { command: "/paste".into(), label: "Paste".into(), description: "Paste from clipboard".into(), category: "Code".into() },
            ActionTemplate { command: "/architect".into(), label: "Architect".into(), description: "Switch to architect mode".into(), category: "Setup".into() },
            ActionTemplate { command: "/ask".into(), label: "Ask".into(), description: "Switch to ask mode".into(), category: "Setup".into() },
            ActionTemplate { command: "/code".into(), label: "Code".into(), description: "Switch to code mode".into(), category: "Setup".into() },
            ActionTemplate { command: "/chat-mode".into(), label: "Chat Mode".into(), description: "Switch chat mode".into(), category: "Setup".into() },
            ActionTemplate { command: "/lint".into(), label: "Lint".into(), description: "Lint edited files".into(), category: "Code".into() },
            ActionTemplate { command: "/web".into(), label: "Web Search".into(), description: "Search the web".into(), category: "Context".into() },
            ActionTemplate { command: "/read-only".into(), label: "Read-Only".into(), description: "Add file as read-only".into(), category: "Files".into() },
            ActionTemplate { command: "/reset".into(), label: "Reset".into(), description: "Reset chat session".into(), category: "Context".into() },
            ActionTemplate { command: "/quit".into(), label: "Quit".into(), description: "Exit aider".into(), category: "Info".into() },
            ActionTemplate { command: "/git".into(), label: "Git".into(), description: "Run git command".into(), category: "Git".into() },
        ]
    }
}

// ─── Copilot CLI Adapter ────────────────────────────────────────────

struct CopilotAdapter;

impl ProviderAdapter for CopilotAdapter {
    fn detect_agent(&self, line: &str) -> Option<AgentInfo> {
        let lower = line.to_lowercase();
        if lower.contains("github copilot") || (lower.contains("copilot") && lower.contains("cli")) {
            Some(AgentInfo { name: "Copilot CLI".into(), provider: "openai".into(), model: None, detected_at: now(), confidence: 0.85 })
        } else { None }
    }
    fn analyze_line(&self, line: &str) -> LineAnalysis {
        let mut result = empty_analysis();
        if self.is_prompt(line) { result.phase_hint = Some(PhaseHint::PromptDetected); }
        result
    }
    fn is_prompt(&self, line: &str) -> bool { is_shell_prompt(line.trim()) }
    fn known_actions(&self) -> Vec<ActionTemplate> {
        vec![
            ActionTemplate { command: "gh copilot suggest".into(), label: "Suggest".into(), description: "Get command suggestions".into(), category: "AI".into() },
            ActionTemplate { command: "gh copilot explain".into(), label: "Explain".into(), description: "Explain a command".into(), category: "AI".into() },
        ]
    }
}

// ─── Codex CLI Adapter ──────────────────────────────────────────────

struct CodexAdapter;

impl ProviderAdapter for CodexAdapter {
    fn detect_agent(&self, line: &str) -> Option<AgentInfo> {
        let lower = line.to_lowercase();
        if lower.contains("codex") && (lower.contains("openai") || lower.contains("cli")) {
            Some(AgentInfo { name: "Codex CLI".into(), provider: "openai".into(), model: None, detected_at: now(), confidence: 0.85 })
        } else { None }
    }
    fn analyze_line(&self, line: &str) -> LineAnalysis {
        let mut result = empty_analysis();
        if self.is_prompt(line) { result.phase_hint = Some(PhaseHint::PromptDetected); }
        result
    }
    fn is_prompt(&self, line: &str) -> bool { let t = line.trim(); t.ends_with("> ") || is_shell_prompt(t) }
    fn known_actions(&self) -> Vec<ActionTemplate> {
        vec![
            ActionTemplate { command: "/diff".into(), label: "Diff".into(), description: "Show pending changes".into(), category: "Code".into() },
            ActionTemplate { command: "/apply".into(), label: "Apply".into(), description: "Apply suggested changes".into(), category: "Code".into() },
            ActionTemplate { command: "/clear".into(), label: "Clear".into(), description: "Clear conversation".into(), category: "Context".into() },
            ActionTemplate { command: "/help".into(), label: "Help".into(), description: "Show available commands".into(), category: "Info".into() },
            ActionTemplate { command: "/quit".into(), label: "Quit".into(), description: "Exit Codex".into(), category: "Info".into() },
            ActionTemplate { command: "codex --full-auto".into(), label: "Full Auto".into(), description: "Run in full-auto mode".into(), category: "Setup".into() },
            ActionTemplate { command: "codex --suggest".into(), label: "Suggest Mode".into(), description: "Run in suggest mode".into(), category: "Setup".into() },
            ActionTemplate { command: "codex --auto-edit".into(), label: "Auto Edit".into(), description: "Run in auto-edit mode".into(), category: "Setup".into() },
            ActionTemplate { command: "codex --model".into(), label: "Set Model".into(), description: "Choose model to use".into(), category: "Setup".into() },
        ]
    }
}

// ─── Gemini Adapter ─────────────────────────────────────────────────

struct GeminiAdapter;

impl ProviderAdapter for GeminiAdapter {
    fn detect_agent(&self, line: &str) -> Option<AgentInfo> {
        let lower = line.to_lowercase();
        if lower.contains("gemini") && (lower.contains("cli") || lower.contains("code")) {
            Some(AgentInfo { name: "Gemini CLI".into(), provider: "google".into(), model: extract_model_name(line), detected_at: now(), confidence: 0.8 })
        } else { None }
    }
    fn analyze_line(&self, line: &str) -> LineAnalysis {
        let mut result = empty_analysis();
        if self.is_prompt(line) { result.phase_hint = Some(PhaseHint::PromptDetected); }
        result
    }
    fn is_prompt(&self, line: &str) -> bool { let t = line.trim(); t.ends_with("> ") || is_shell_prompt(t) }
    fn known_actions(&self) -> Vec<ActionTemplate> {
        vec![
            ActionTemplate { command: "/help".into(), label: "Help".into(), description: "Show available commands".into(), category: "Info".into() },
            ActionTemplate { command: "/clear".into(), label: "Clear".into(), description: "Clear conversation".into(), category: "Context".into() },
            ActionTemplate { command: "/stats".into(), label: "Stats".into(), description: "Show usage statistics".into(), category: "Info".into() },
            ActionTemplate { command: "/save".into(), label: "Save".into(), description: "Save conversation".into(), category: "Context".into() },
            ActionTemplate { command: "/restore".into(), label: "Restore".into(), description: "Restore saved conversation".into(), category: "Context".into() },
            ActionTemplate { command: "/sandbox".into(), label: "Sandbox".into(), description: "Toggle sandbox mode".into(), category: "Setup".into() },
            ActionTemplate { command: "/tools".into(), label: "Tools".into(), description: "List available tools".into(), category: "Info".into() },
            ActionTemplate { command: "/shell".into(), label: "Shell".into(), description: "Run shell command".into(), category: "Code".into() },
            ActionTemplate { command: "/edit".into(), label: "Edit".into(), description: "Edit a file".into(), category: "Code".into() },
            ActionTemplate { command: "/diff".into(), label: "Diff".into(), description: "Show file changes".into(), category: "Code".into() },
            ActionTemplate { command: "/yolo".into(), label: "YOLO Mode".into(), description: "Auto-approve all actions".into(), category: "Setup".into() },
            ActionTemplate { command: "/quit".into(), label: "Quit".into(), description: "Exit Gemini CLI".into(), category: "Info".into() },
        ]
    }
}

// ─── Provider Registry ──────────────────────────────────────────────

struct ProviderRegistry {
    adapters: Vec<Box<dyn ProviderAdapter>>,
}

impl ProviderRegistry {
    fn new() -> Self {
        Self {
            adapters: vec![
                Box::new(ClaudeCodeAdapter),
                Box::new(AiderAdapter),
                Box::new(CopilotAdapter),
                Box::new(CodexAdapter),
                Box::new(GeminiAdapter),
            ],
        }
    }

    fn detect_agent(&self, line: &str) -> Option<(usize, AgentInfo)> {
        let mut best: Option<(usize, AgentInfo)> = None;
        for (i, adapter) in self.adapters.iter().enumerate() {
            if let Some(sig) = adapter.detect_agent(line) {
                if best.as_ref().map_or(true, |(_, b)| sig.confidence > b.confidence) {
                    best = Some((i, sig));
                }
            }
        }
        best
    }
}

// ─── Error Fingerprinting ────────────────────────────────────────────

lazy_static! {
    static ref FP_FILE_PATH_RE: Regex = Regex::new(
        r"(?:/[\w.@-]+)+\.[\w]+"
    ).unwrap();
    static ref FP_NUMBER_RE: Regex = Regex::new(
        r"\b\d+\b"
    ).unwrap();
}

fn error_fingerprint(line: &str) -> String {
    let lower = line.to_lowercase();
    let no_paths = FP_FILE_PATH_RE.replace_all(&lower, "<path>");
    let no_nums = FP_NUMBER_RE.replace_all(&no_paths, "<n>");
    no_nums.split_whitespace().take(8).collect::<Vec<_>>().join(" ")
}

// ─── Node Builder (tracks command→output cycles) ────────────────────

struct NodeBuilder {
    started_at: std::time::Instant,
    timestamp: i64,
    kind: String,
    input: Option<String>,
    output_lines: Vec<String>,
    working_dir: String,
}

impl NodeBuilder {
    fn new(kind: &str, input: Option<String>, working_dir: &str) -> Self {
        Self {
            started_at: std::time::Instant::now(),
            timestamp: chrono::Utc::now().timestamp(),
            kind: kind.to_string(),
            input,
            output_lines: Vec::new(),
            working_dir: working_dir.to_string(),
        }
    }

    fn push_output(&mut self, line: &str) {
        if self.output_lines.len() < 50 {
            self.output_lines.push(line.to_string());
        }
    }

    fn finalize(self, exit_code: Option<i32>) -> CompletedNode {
        let duration_ms = self.started_at.elapsed().as_millis() as i64;
        let summary: String = self.output_lines.join("\n").chars().take(500).collect();
        CompletedNode {
            timestamp: self.timestamp,
            kind: self.kind,
            input: self.input,
            output_summary: if summary.is_empty() { None } else { Some(summary) },
            exit_code,
            working_dir: self.working_dir,
            duration_ms,
        }
    }
}

struct CompletedNode {
    timestamp: i64,
    kind: String,
    input: Option<String>,
    output_summary: Option<String>,
    exit_code: Option<i32>,
    working_dir: String,
    duration_ms: i64,
}

// ─── Error Match Event Payload ──────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ErrorMatchEvent {
    fingerprint: String,
    occurrence_count: i64,
    resolution: Option<String>,
    raw_sample: Option<String>,
}

// ─── Command Prediction Event Payload ───────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CommandPredictionEvent {
    predictions: Vec<crate::db::CommandPrediction>,
}

// ─── Output Analyzer (uses Provider Registry) ───────────────────────

struct OutputAnalyzer {
    registry: ProviderRegistry,
    active_provider_idx: Option<usize>,
    stripped_buffer: String,
    line_count: u64,
    error_count: u32,
    recent_errors: VecDeque<String>,
    detected_agent: Option<AgentInfo>,
    repeated_error_count: u32,
    last_error_signature: Option<String>,
    is_busy: bool,
    pending_phase: Option<SessionPhase>,
    // Token ledger
    token_usage: HashMap<String, ProviderTokens>,
    token_history: VecDeque<(u64, u64)>,
    // Tool tracking
    tool_calls: VecDeque<ToolCall>,
    tool_call_summary: HashMap<String, u32>,
    // File tracking
    files_touched: HashSet<String>,
    files_ordered: Vec<String>,
    // Actions
    recent_actions: VecDeque<ActionEvent>,
    available_actions: Vec<ActionTemplate>,
    // Memory
    memory_facts: Vec<MemoryFact>,
    memory_keys_seen: HashSet<String>,
    // Latency
    last_input_at: Option<std::time::Instant>,
    latency_samples: VecDeque<f64>,
    // CWD tracking
    current_cwd: Option<String>,
    pending_cwd: Option<String>,
    // Node builder (execution tracking)
    node_builder: Option<NodeBuilder>,
    completed_nodes: VecDeque<CompletedNode>,
    last_input_line: Option<String>,
    // Command sequence tracking
    recent_commands: VecDeque<String>,
    // Error fingerprint tracking
    last_error_fingerprint: Option<String>,
    had_error_in_node: bool,
    // Input line accumulation buffer
    input_line_buffer: String,
    // Auto-resolution tracking
    pending_error_fp: Option<String>,
    pending_error_project: Option<String>,
    // Idle timeout tracking
    last_output_at: Option<std::time::Instant>,
    // Auto-launch / auto-inject tracking
    shell_ready: bool,
    pending_ai_launch: bool,
    pending_context_inject: bool,
    context_injected: bool,
    prompt_count_after_agent: u32,
}

impl OutputAnalyzer {
    fn new() -> Self {
        Self {
            registry: ProviderRegistry::new(),
            active_provider_idx: None,
            stripped_buffer: String::new(),
            line_count: 0,
            error_count: 0,
            recent_errors: VecDeque::new(),
            detected_agent: None,
            repeated_error_count: 0,
            last_error_signature: None,
            is_busy: false,
            pending_phase: None,
            token_usage: HashMap::new(),
            token_history: VecDeque::new(),
            tool_calls: VecDeque::new(),
            tool_call_summary: HashMap::new(),
            files_touched: HashSet::new(),
            files_ordered: Vec::new(),
            recent_actions: VecDeque::new(),
            available_actions: Vec::new(),
            memory_facts: Vec::new(),
            memory_keys_seen: HashSet::new(),
            last_input_at: None,
            latency_samples: VecDeque::new(),
            current_cwd: None,
            pending_cwd: None,
            node_builder: None,
            completed_nodes: VecDeque::new(),
            last_input_line: None,
            recent_commands: VecDeque::new(),
            last_error_fingerprint: None,
            had_error_in_node: false,
            input_line_buffer: String::new(),
            pending_error_fp: None,
            pending_error_project: None,
            last_output_at: None,
            shell_ready: false,
            pending_ai_launch: false,
            pending_context_inject: false,
            context_injected: false,
            prompt_count_after_agent: 0,
        }
    }

    fn mark_input_sent(&mut self) {
        self.last_input_at = Some(std::time::Instant::now());
    }

    fn mark_input_line(&mut self, line: &str) {
        self.last_input_line = Some(line.to_string());
    }

    fn start_node(&mut self, working_dir: &str) {
        let input = self.last_input_line.take();
        let kind = if self.detected_agent.is_some() { "ai_interaction" } else { "command" };
        self.node_builder = Some(NodeBuilder::new(kind, input, working_dir));
        self.had_error_in_node = false;
    }

    fn finalize_node(&mut self, exit_code: Option<i32>) {
        if let Some(builder) = self.node_builder.take() {
            let completed = builder.finalize(exit_code);
            self.completed_nodes.push_back(completed);
            if self.completed_nodes.len() > 20 {
                self.completed_nodes.pop_front();
            }
        }
    }

    fn drain_completed_nodes(&mut self) -> Vec<CompletedNode> {
        self.completed_nodes.drain(..).collect()
    }

    fn process(&mut self, raw: &[u8]) {
        // Latency tracking
        if let Some(sent_at) = self.last_input_at.take() {
            let latency = sent_at.elapsed().as_secs_f64() * 1000.0;
            if latency > 50.0 && latency < 120_000.0 {
                self.latency_samples.push_back(latency);
                if self.latency_samples.len() > 50 {
                    self.latency_samples.pop_front();
                }
            }
        }

        // Mark busy when new output arrives and we're idle — line analysis
        // below will override back to Idle if a prompt is detected in this chunk.
        if !self.is_busy {
            self.is_busy = true;
            self.pending_phase = Some(SessionPhase::Busy);
        }
        self.last_output_at = Some(std::time::Instant::now());

        // Check for OSC 7 (CWD reporting) in raw data before stripping
        let raw_text = String::from_utf8_lossy(raw);
        if let Some(caps) = OSC7_RE.captures(&raw_text) {
            let path = percent_decode(&caps[1]);
            if self.current_cwd.as_deref() != Some(&path) {
                self.current_cwd = Some(path.clone());
                self.pending_cwd = Some(path);
            }
        }

        // Also scan raw text for cost/token patterns (TUI status bars use cursor
        // positioning, but the text content is still in the raw stream)
        if let Some(idx) = self.active_provider_idx {
            let raw_stripped = strip_ansi_escapes::strip(raw);
            let raw_clean = String::from_utf8_lossy(&raw_stripped);
            // Check the full chunk for cost patterns (status bars often render in one chunk)
            if let Some(caps) = SESSION_COST_RE.captures(&raw_clean)
                .or_else(|| CLAUDE_COST_RE.captures(&raw_clean))
            {
                if let Ok(cost) = caps[1].parse::<f64>() {
                    if cost > 0.0 {
                        let _ = idx; // used above
                        let key = "anthropic".to_string();
                        let entry = self.token_usage.entry(key).or_insert_with(|| ProviderTokens {
                            input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0.0,
                            model: "unknown".into(), last_updated: now(), update_count: 0,
                        });
                        if cost > entry.estimated_cost_usd {
                            entry.estimated_cost_usd = cost;
                            entry.last_updated = now();
                            entry.update_count += 1;
                        }
                    }
                }
            }
            // Check for dollar amounts in short context (like "$0.0432" next to token info)
            if let Some(caps) = CLAUDE_TOKEN_SHORT_RE.captures(&raw_clean) {
                let input = parse_token_count(&caps[1]);
                let output = parse_token_count(&caps[2]);
                if input > 0 || output > 0 {
                    let key = "anthropic".to_string();
                    let entry = self.token_usage.entry(key).or_insert_with(|| ProviderTokens {
                        input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0.0,
                        model: "unknown".into(), last_updated: now(), update_count: 0,
                    });
                    entry.input_tokens = input;
                    entry.output_tokens = output;
                    entry.last_updated = now();
                    entry.update_count += 1;

                    let total_in: u64 = self.token_usage.values().map(|t| t.input_tokens).sum();
                    let total_out: u64 = self.token_usage.values().map(|t| t.output_tokens).sum();
                    self.token_history.push_back((total_in, total_out));
                    if self.token_history.len() > 30 { self.token_history.pop_front(); }
                }
            }
        }

        let stripped = strip_ansi_escapes::strip(raw);
        let text = String::from_utf8_lossy(&stripped);

        for line in text.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() { continue; }

            self.line_count += 1;

            // Agent detection (until confirmed)
            if self.detected_agent.is_none() {
                if let Some((idx, agent)) = self.registry.detect_agent(trimmed) {
                    self.active_provider_idx = Some(idx);
                    self.detected_agent = Some(agent);
                    self.available_actions = self.registry.adapters[idx].known_actions();
                }
            }
            // Keep trying to extract model name if we have agent but model is unknown
            // (e.g. Claude Code shows model on a separate line from the version)
            // Also detect model changes (e.g. "/model" command output)
            if let Some(ref mut agent) = self.detected_agent {
                if let Some(model) = extract_model_name(trimmed) {
                    let lower = trimmed.to_lowercase();
                    let is_model_change = lower.contains("set model to")
                        || lower.contains("model:")
                        || lower.contains("switching to");
                    let is_header = lower.contains("claude code")
                        || lower.contains("claude-code")
                        || (lower.contains("claude") && (lower.contains("v2.") || lower.contains("v1.")));
                    let is_unknown = agent.model.is_none()
                        || agent.model.as_deref() == Some("unknown");

                    if is_unknown || is_model_change || is_header {
                        agent.model = Some(model);
                    }
                }
            }

            // Provider-specific analysis
            if let Some(idx) = self.active_provider_idx {
                let analysis = self.registry.adapters[idx].analyze_line(trimmed);
                self.apply_analysis(analysis);
            } else {
                // Fallback: generic analysis
                self.generic_analyze(trimmed);
            }

            // File path detection (universal)
            for caps in FILE_PATH_RE.captures_iter(trimmed) {
                let path = caps[1].to_string();
                if self.files_touched.insert(path.clone()) {
                    self.files_ordered.push(path);
                    if self.files_ordered.len() > 50 {
                        if let Some(removed) = self.files_ordered.first().cloned() {
                            self.files_touched.remove(&removed);
                            self.files_ordered.remove(0);
                        }
                    }
                }
            }

            // Feed output to node builder
            if let Some(ref mut builder) = self.node_builder {
                builder.push_output(trimmed);
            }

            // Error detection (universal)
            if is_error_line(trimmed) {
                self.error_count += 1;
                let sig = error_signature(trimmed);
                if self.last_error_signature.as_deref() == Some(&sig) {
                    self.repeated_error_count += 1;
                } else {
                    self.repeated_error_count = 1;
                    self.last_error_signature = Some(sig);
                }
                let truncated: String = trimmed.chars().take(200).collect();
                self.recent_errors.push_back(truncated);
                if self.recent_errors.len() > 20 {
                    self.recent_errors.pop_front();
                }

                // Error fingerprinting for intelligence
                let fp = error_fingerprint(trimmed);
                self.last_error_fingerprint = Some(fp);
                self.had_error_in_node = true;
            }

            // Keep stripped buffer (last ~16KB, char-boundary safe)
            self.stripped_buffer.push_str(trimmed);
            self.stripped_buffer.push('\n');
            if self.stripped_buffer.len() > 16000 {
                let mut drain = self.stripped_buffer.len() - 16000;
                while drain < self.stripped_buffer.len() && !self.stripped_buffer.is_char_boundary(drain) {
                    drain += 1;
                }
                self.stripped_buffer.drain(..drain);
            }
        }
    }

    fn apply_analysis(&mut self, analysis: LineAnalysis) {
        if let Some(tu) = analysis.token_update {
            self.apply_token_update(tu);
        }
        if let Some(tc) = analysis.tool_call {
            *self.tool_call_summary.entry(tc.tool.clone()).or_insert(0) += 1;
            self.tool_calls.push_back(tc);
            if self.tool_calls.len() > 100 { self.tool_calls.pop_front(); }
        }
        if let Some(action) = analysis.action {
            self.recent_actions.push_back(action);
            if self.recent_actions.len() > 20 { self.recent_actions.pop_front(); }
        }
        if let Some(fact) = analysis.memory_fact {
            if !self.memory_keys_seen.contains(&fact.key) {
                self.memory_keys_seen.insert(fact.key.clone());
                self.memory_facts.push(fact);
            }
        }
        if let Some(hint) = analysis.phase_hint {
            match hint {
                PhaseHint::PromptDetected => {
                    // Going idle — finalize current node if any
                    if self.node_builder.is_some() {
                        self.finalize_node(None);
                    }
                    self.is_busy = false;

                    // Auto-launch / auto-inject logic
                    if !self.shell_ready && self.detected_agent.is_none() {
                        // First shell prompt detected, no agent yet
                        self.shell_ready = true;
                        self.pending_phase = Some(SessionPhase::ShellReady);
                        self.pending_ai_launch = true;
                    } else if self.detected_agent.is_some() && !self.context_injected {
                        self.prompt_count_after_agent += 1;
                        // Skip the very first prompt (agent still rendering/showing suggestions).
                        // Inject on the second prompt when the agent is truly idle.
                        if self.prompt_count_after_agent >= 2 {
                            self.pending_context_inject = true;
                        }
                        self.pending_phase = Some(SessionPhase::Idle);
                    } else {
                        self.pending_phase = Some(SessionPhase::Idle);
                    }
                }
                PhaseHint::WorkStarted => {
                    // Starting work — if we don't have a node yet, start one
                    if self.node_builder.is_none() {
                        let cwd = self.current_cwd.clone().unwrap_or_default();
                        self.start_node(&cwd);
                    }
                    self.is_busy = true;
                    self.pending_phase = Some(SessionPhase::Busy);
                }
            }
        }
    }

    fn generic_analyze(&mut self, line: &str) {
        // Generic tool-like patterns
        let lower = line.to_lowercase();
        if lower.contains("applied edit to") || lower.contains("wrote to file") {
            *self.tool_call_summary.entry("Edit".into()).or_insert(0) += 1;
        }
        if lower.starts_with("running:") || lower.starts_with("$ ") {
            *self.tool_call_summary.entry("Bash".into()).or_insert(0) += 1;
        }

        // Generic prompt detection
        let trimmed = line.trim();
        if is_shell_prompt(trimmed) {
            self.is_busy = false;
            if !self.shell_ready && self.detected_agent.is_none() {
                // First shell prompt detected — trigger auto-launch
                self.shell_ready = true;
                self.pending_ai_launch = true;
                self.pending_phase = Some(SessionPhase::ShellReady);
            } else {
                self.pending_phase = Some(SessionPhase::Idle);
            }
        }
    }

    fn apply_token_update(&mut self, tu: TokenUpdate) {
        let key = tu.provider.clone();
        let entry = self.token_usage.entry(key).or_insert_with(|| ProviderTokens {
            input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0.0,
            model: tu.model.clone(), last_updated: now(), update_count: 0,
        });

        if tu.is_cumulative {
            entry.input_tokens = tu.input_tokens;
            entry.output_tokens = tu.output_tokens;
        } else {
            entry.input_tokens += tu.input_tokens;
            entry.output_tokens += tu.output_tokens;
        }

        if let Some(cost) = tu.cost_usd {
            entry.estimated_cost_usd = cost;
        } else if entry.estimated_cost_usd == 0.0 {
            entry.estimated_cost_usd = estimate_cost(&tu.provider, &entry.model, entry.input_tokens, entry.output_tokens);
        }

        entry.update_count += 1;
        entry.last_updated = now();
        entry.model = if tu.model != "unknown" { tu.model } else { entry.model.clone() };

        // Record history sample for sparkline
        let total_in: u64 = self.token_usage.values().map(|t| t.input_tokens).sum();
        let total_out: u64 = self.token_usage.values().map(|t| t.output_tokens).sum();
        self.token_history.push_back((total_in, total_out));
        if self.token_history.len() > 30 { self.token_history.pop_front(); }
    }

    fn stuck_score(&self) -> f32 {
        let mut score: f32 = 0.0;
        if self.repeated_error_count >= 3 { score += 0.4; }
        if self.repeated_error_count >= 5 { score += 0.3; }
        if self.line_count > 10 {
            let error_rate = self.error_count as f32 / self.line_count as f32;
            if error_rate > 0.3 { score += 0.3; }
        }
        score.min(1.0)
    }

    fn take_pending_phase(&mut self) -> Option<SessionPhase> {
        self.pending_phase.take()
    }

    fn take_pending_cwd(&mut self) -> Option<String> {
        self.pending_cwd.take()
    }

    fn to_metrics(&self) -> SessionMetrics {
        let usage = self.token_usage.clone();

        SessionMetrics {
            output_lines: self.line_count,
            error_count: self.error_count,
            stuck_score: self.stuck_score(),
            token_usage: usage,
            tool_calls: self.tool_calls.iter().rev().take(20).cloned().collect(),
            tool_call_summary: self.tool_call_summary.clone(),
            files_touched: self.files_ordered.clone(),
            recent_errors: self.recent_errors.iter().cloned().collect(),
            recent_actions: self.recent_actions.iter().cloned().collect(),
            available_actions: self.available_actions.clone(),
            memory_facts: self.memory_facts.clone(),
            latency_p50_ms: percentile(&self.latency_samples, 50.0),
            latency_p95_ms: percentile(&self.latency_samples, 95.0),
            latency_samples: self.latency_samples.iter().copied().collect::<Vec<_>>().into_iter().rev().take(50).collect::<Vec<_>>().into_iter().rev().collect(),
            token_history: self.token_history.iter().cloned().collect(),
        }
    }

    fn get_stripped_output(&self) -> String {
        self.stripped_buffer.clone()
    }
}

// ─── Utility Functions ──────────────────────────────────────────────

fn now() -> String { chrono::Utc::now().to_rfc3339() }

fn empty_analysis() -> LineAnalysis {
    LineAnalysis {
        token_update: None, tool_call: None,
        action: None, phase_hint: None, memory_fact: None,
    }
}

fn parse_token_count(s: &str) -> u64 {
    let clean = s.replace(',', "");
    if let Some(num) = clean.strip_suffix('K').or_else(|| clean.strip_suffix('k')) {
        (num.parse::<f64>().unwrap_or(0.0) * 1000.0) as u64
    } else if let Some(num) = clean.strip_suffix('M').or_else(|| clean.strip_suffix('m')) {
        (num.parse::<f64>().unwrap_or(0.0) * 1_000_000.0) as u64
    } else {
        clean.parse().unwrap_or(0)
    }
}

fn parse_k_count(s: &str) -> u64 {
    let s = s.to_lowercase();
    if let Some(num) = s.strip_suffix('k') {
        (num.parse::<f64>().unwrap_or(0.0) * 1000.0) as u64
    } else {
        s.parse().unwrap_or(0)
    }
}

fn extract_model_name(line: &str) -> Option<String> {
    let lower = line.to_lowercase();
    // Claude models
    if lower.contains("opus 4") { return Some("opus".into()); }
    if lower.contains("opus") { return Some("opus".into()); }
    if lower.contains("sonnet 4") { return Some("sonnet".into()); }
    if lower.contains("sonnet") { return Some("sonnet".into()); }
    if lower.contains("haiku") { return Some("haiku".into()); }
    // OpenAI models
    if lower.contains("gpt-4o") { return Some("gpt-4o".into()); }
    if lower.contains("gpt-4") { return Some("gpt-4".into()); }
    if lower.contains("o1") && !lower.contains("v0.1") && !lower.contains("v0.0") { return Some("o1".into()); }
    if lower.contains("o3") { return Some("o3".into()); }
    // Google models
    if lower.contains("gemini") && lower.contains("pro") { return Some("gemini-pro".into()); }
    if lower.contains("gemini") && lower.contains("flash") { return Some("gemini-flash".into()); }
    None
}

fn estimate_cost(provider: &str, model: &str, input: u64, output: u64) -> f64 {
    let (in_price, out_price) = match (provider, model) {
        ("anthropic", m) if m.contains("opus") => (15.0, 75.0),
        ("anthropic", m) if m.contains("sonnet") => (3.0, 15.0),
        ("anthropic", m) if m.contains("haiku") => (0.25, 1.25),
        ("openai", m) if m.contains("gpt-4o") => (2.5, 10.0),
        ("openai", m) if m.contains("gpt-4") => (30.0, 60.0),
        ("openai", m) if m.contains("o1") => (15.0, 60.0),
        ("google", m) if m.contains("pro") => (1.25, 5.0),
        ("google", m) if m.contains("flash") => (0.075, 0.30),
        _ => (3.0, 15.0),
    };
    (input as f64 / 1_000_000.0) * in_price + (output as f64 / 1_000_000.0) * out_price
}

fn slash_label(cmd: &str) -> String {
    match cmd {
        // Claude Code
        "/init" => "Initialize project", "/build" => "Build", "/test" => "Run tests",
        "/run" => "Run command", "/review" => "Code review", "/commit" => "Commit",
        "/compact" => "Compact context", "/memory" => "Manage memory",
        "/clear" => "Clear", "/config" => "Config", "/help" => "Help",
        "/cost" => "Show cost", "/doctor" => "Doctor", "/bug" => "Bug report",
        "/login" => "Login", "/logout" => "Logout",
        "/terminal-setup" => "Terminal setup", "/allowed-tools" => "Allowed tools",
        "/permissions" => "Permissions", "/vim" => "Vim mode",
        // Aider
        "/add" => "Add file", "/drop" => "Drop file", "/undo" => "Undo",
        "/diff" => "Show diff", "/ls" => "List files", "/tokens" => "Tokens",
        "/model" => "Switch model", "/settings" => "Settings",
        "/map" => "Repo map", "/map-refresh" => "Refresh map",
        "/voice" => "Voice", "/paste" => "Paste", "/architect" => "Architect mode",
        "/ask" => "Ask mode", "/code" => "Code mode", "/chat-mode" => "Chat mode",
        "/lint" => "Lint", "/web" => "Web search", "/read-only" => "Read-only",
        "/reset" => "Reset", "/quit" => "Quit", "/git" => "Git command",
        // Codex
        "/apply" => "Apply changes",
        // Gemini
        "/stats" => "Stats", "/save" => "Save", "/restore" => "Restore",
        "/sandbox" => "Sandbox", "/tools" => "Tools", "/shell" => "Shell",
        "/edit" => "Edit file", "/yolo" => "YOLO mode",
        _ => cmd,
    }.into()
}

fn extract_between(text: &str, start: &str, end: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let s = lower.find(&start.to_lowercase())?;
    let after = s + start.len();
    let e = lower[after..].find(&end.to_lowercase())?;
    Some(text[after..after + e].trim().to_string())
}

lazy_static! {
    static ref PORT_RE: Regex = Regex::new(r"port\s*(\d{2,5})").unwrap();
}

fn extract_port(line: &str) -> Option<String> {
    PORT_RE.captures(&line.to_lowercase()).map(|c| c[1].to_string())
}

fn percent_decode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '%' {
            let hex: String = chars.by_ref().take(2).collect();
            if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                result.push(byte as char);
            } else {
                result.push('%');
                result.push_str(&hex);
            }
        } else {
            result.push(c);
        }
    }
    result
}

/// Detects common shell prompts across zsh, bash, fish, starship, oh-my-zsh, etc.
fn is_shell_prompt(trimmed: &str) -> bool {
    if trimmed.is_empty() || trimmed.len() > 120 {
        return false;
    }

    // Standard prompt endings: $ % > #
    let standard_endings = ["$ ", "% ", "# ", "> "];
    for ending in standard_endings {
        if trimmed.ends_with(ending) && trimmed.len() < 80 {
            return true;
        }
    }
    // Bare prompt chars
    if trimmed == "$" || trimmed == "%" || trimmed == "#" || trimmed == ">" {
        return true;
    }

    // Prompts ending with $ or % with path context
    if trimmed.len() < 80 && (trimmed.ends_with('$') || trimmed.ends_with('%') || trimmed.ends_with('#')) {
        if trimmed.contains('@') || trimmed.contains(':') || trimmed.contains('~') || trimmed.contains('/') {
            return true;
        }
    }

    // Custom prompt characters used by starship, oh-my-zsh, powerlevel10k, etc.
    // These are common prompt indicator characters:
    // → ❯ ➜ ▶ ╰─ λ ➤ ⟩ ⟫ ›
    let custom_prompt_chars = [
        '→', '❯', '➜', '▶', 'λ', '➤', '⟩', '⟫', '›',
    ];

    // Check if line starts with or contains a prompt char near the end
    let last_chars: String = trimmed.chars().rev().take(5).collect();
    for ch in &custom_prompt_chars {
        if last_chars.contains(*ch) {
            return true;
        }
    }

    // Lines like "╰─➜" or "╰─❯" (oh-my-zsh / powerlevel10k two-line prompts)
    if trimmed.contains("╰") || trimmed.contains("└") {
        for ch in &custom_prompt_chars {
            if trimmed.contains(*ch) {
                return true;
            }
        }
    }

    // Fish-style prompt: "user@host ~>"
    if trimmed.ends_with("~>") || trimmed.ends_with("~> ") {
        return true;
    }

    false
}

fn is_error_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.starts_with("error")
        || lower.contains("error:")
        || lower.contains("error[")
        || lower.contains(" failed")
        || lower.contains("exception")
        || lower.contains("traceback")
        || lower.contains("panic!")
        || lower.contains("fatal:")
        || (lower.contains("command not found") && !lower.contains("if"))
        || lower.contains("permission denied")
        || lower.contains("no such file")
        || lower.contains("segmentation fault")
}

fn error_signature(line: &str) -> String {
    let lower = line.to_lowercase();
    let sig: String = lower.chars().filter(|c| c.is_alphabetic() || c.is_whitespace()).collect();
    sig.split_whitespace().take(8).collect::<Vec<_>>().join(" ")
}

fn percentile(samples: &VecDeque<f64>, pct: f64) -> Option<f64> {
    if samples.is_empty() { return None; }
    let mut sorted: Vec<f64> = samples.iter().copied().collect();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let idx = ((pct / 100.0) * (sorted.len() as f64 - 1.0)).round() as usize;
    sorted.get(idx).copied()
}

// ─── PTY Session & Manager ──────────────────────────────────────────

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<StdMutex<Box<dyn Write + Send>>>,
    session: Arc<StdMutex<Session>>,
    analyzer: Arc<StdMutex<OutputAnalyzer>>,
}

fn ai_launch_command(provider: &str) -> &str {
    match provider {
        "claude" => "claude",
        "aider" => "aider",
        "codex" => "codex",
        "gemini" => "gemini",
        "copilot" => "gh copilot",
        _ => provider,
    }
}

pub struct PtyManager {
    sessions: HashMap<String, PtySession>,
    session_counter: usize,
}

impl PtyManager {
    pub fn new() -> Self {
        Self { sessions: HashMap::new(), session_counter: 0 }
    }

    /// Send a lightweight context nudge to a session's PTY if an AI agent is detected.
    /// Returns true if the nudge was sent.
    pub fn nudge_context(&mut self, session_id: &str) -> bool {
        let pty = match self.sessions.get_mut(session_id) {
            Some(p) => p,
            None => return false,
        };

        let has_agent = pty.session.lock().ok()
            .map(|s| s.detected_agent.is_some())
            .unwrap_or(false);

        if !has_agent {
            return false;
        }

        let msg = "Read the file at $HERMES_CONTEXT for project context about the attached workspaces.\r";
        if let Ok(mut w) = pty.writer.lock() {
            let ok = w.write_all(msg.as_bytes()).is_ok() && w.flush().is_ok();
            ok
        } else {
            false
        }
    }

    /// Send a versioned context nudge to a session's PTY.
    /// Deduplicates by tracking last_nudged_version on the Session.
    /// Returns (nudge_sent, error_message).
    pub fn send_versioned_nudge(
        &self,
        session_id: &str,
        version: i64,
        file_path: &str,
    ) -> (bool, Option<String>) {
        let pty = match self.sessions.get(session_id) {
            Some(p) => p,
            None => return (false, Some("Session not found in PTY manager".to_string())),
        };

        let mut session_guard = match pty.session.lock() {
            Ok(g) => g,
            Err(e) => return (false, Some(format!("Session lock failed: {}", e))),
        };

        // Only nudge if an AI agent has been detected — otherwise we'd send
        // a message to a raw shell which would try to execute it as a command.
        if session_guard.detected_agent.is_none() {
            return (false, Some("No AI agent detected in session".to_string()));
        }

        // Dedup: skip if already nudged for this version
        if session_guard.last_nudged_version >= version {
            return (true, None);
        }

        // Determine provider-specific nudge message
        let provider_name = session_guard.detected_agent.as_ref()
            .map(|a| a.name.clone())
            .unwrap_or_default();

        let nudge_msg = match provider_name.to_lowercase().as_str() {
            "aider" => format!("/read {}\r", file_path),
            "claude" | "claude-code" | "anthropic" => format!(
                "Read the file at {} — it contains updated project context (v{}).\r",
                file_path, version
            ),
            "copilot" | "github-copilot" => format!(
                "@workspace Context updated to v{}. The context file is at {}.\r",
                version, file_path
            ),
            _ => format!(
                "Context updated to v{}. Read the file at $HERMES_CONTEXT for project context.\r",
                version
            ),
        };

        match pty.writer.lock() {
            Ok(mut w) => {
                use std::io::Write;
                match w.write_all(nudge_msg.as_bytes()) {
                    Ok(_) => {
                        let _ = w.flush();
                        session_guard.last_nudged_version = version;
                        (true, None)
                    }
                    Err(e) => (false, Some(format!("Write failed: {}", e))),
                }
            }
            Err(e) => (false, Some(format!("Writer lock failed: {}", e))),
        }
    }
}

fn detect_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
}

fn get_working_directory() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
}

// ─── Tauri Commands ─────────────────────────────────────────────────

#[tauri::command]
pub fn create_session(
    app: AppHandle,
    state: State<'_, AppState>,
    label: Option<String>,
    working_directory: Option<String>,
    color: Option<String>,
    workspace_paths: Option<Vec<String>>,
    ai_provider: Option<String>,
    realm_ids: Option<Vec<String>>,
) -> Result<SessionUpdate, String> {
    let session_id = Uuid::new_v4().to_string();
    let shell = detect_shell();
    let cwd = working_directory.unwrap_or_else(get_working_directory);

    let mut mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    mgr.session_counter += 1;
    let counter = mgr.session_counter;

    let session_label = label.unwrap_or_else(|| format!("Session {}", counter));
    let session_color = color.unwrap_or_else(|| next_color(counter - 1));
    let now_str = now();

    let session = Session {
        id: session_id.clone(),
        label: session_label,
        color: session_color,
        group: None,
        phase: SessionPhase::Creating,
        working_directory: cwd.clone(),
        shell: shell.clone(),
        created_at: now_str.clone(),
        last_activity_at: now_str,
        workspace_paths: workspace_paths.unwrap_or_default(),
        detected_agent: None,
        metrics: SessionMetrics {
            output_lines: 0, error_count: 0, stuck_score: 0.0,
            token_usage: HashMap::new(), tool_calls: Vec::new(),
            tool_call_summary: HashMap::new(), files_touched: Vec::new(),
            recent_errors: Vec::new(), recent_actions: Vec::new(),
            available_actions: Vec::new(), memory_facts: Vec::new(),
            latency_p50_ms: None, latency_p95_ms: None, latency_samples: Vec::new(), token_history: Vec::new(),
        },
        ai_provider: ai_provider.clone(),
        context_injected: false,
        has_initial_context: realm_ids.as_ref().map_or(false, |ids| !ids.is_empty()),
        last_nudged_version: 0,
    };

    let update = SessionUpdate::from(&session);
    let _ = app.emit("session-updated", &update);

    let session_arc = Arc::new(StdMutex::new(session));

    // Spawn PTY
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let mut cmd = CommandBuilder::new("env");
    cmd.arg("-u"); cmd.arg("CLAUDECODE");
    cmd.arg("-u"); cmd.arg("CLAUDE_CODE");
    cmd.arg(&shell);
    cmd.arg("-l");
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "HERMES-IDE");

    // Set context file env vars so AI agents can read project info from disk
    if let Ok(context_path) = crate::realm::attunement::session_context_path(&app, &session_id) {
        cmd.env("HERMES_CONTEXT", context_path.to_string_lossy().as_ref());
    }
    cmd.env("HERMES_SESSION_ID", &session_id);

    let _child = pair.slave.spawn_command(cmd).map_err(|e| format!("Failed to spawn shell: {}", e))?;

    let writer = Arc::new(StdMutex::new(
        pair.master.take_writer().map_err(|e| format!("Failed to get PTY writer: {}", e))?
    ));
    let writer_for_reader = Arc::clone(&writer);

    // Transition to Initializing
    {
        let mut s = session_arc.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
        s.phase = SessionPhase::Initializing;
        let update = SessionUpdate::from(&*s);
        let _ = app.emit("session-updated", &update);
    }

    let analyzer = Arc::new(StdMutex::new(OutputAnalyzer::new()));
    let analyzer_clone = Arc::clone(&analyzer);
    let session_clone = Arc::clone(&session_arc);

    let mut reader = pair.master.try_clone_reader().map_err(|e| format!("Failed to clone reader: {}", e))?;
    let event_session_id = session_id.clone();
    let app_clone = app.clone();

    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut chunk_count: u64 = 0;

        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    if let Ok(mut s) = session_clone.lock() {
                        s.phase = SessionPhase::Destroyed;
                        let update = SessionUpdate::from(&*s);
                        let _ = app_clone.emit("session-updated", &update);
                    }
                    let _ = app_clone.emit(&format!("pty-exit-{}", event_session_id), ());
                    break;
                }
                Ok(n) => {
                    let data = &buf[..n];
                    chunk_count += 1;

                    if let Ok(mut a) = analyzer_clone.lock() {
                        a.process(data);

                        // Check for CWD change
                        if let Some(new_cwd) = a.take_pending_cwd() {
                            if let Ok(mut s) = session_clone.lock() {
                                s.working_directory = new_cwd.clone();
                            }
                            let _ = app_clone.emit(&format!("cwd-changed-{}", event_session_id), &new_cwd);
                        }

                        // Drain completed nodes → insert into DB + emit events
                        let completed = a.drain_completed_nodes();

                        if !completed.is_empty() {
                            if let Ok(db) = app_clone.state::<AppState>().db.lock() {
                                for node in &completed {
                                    let node_id = db.insert_execution_node(
                                        &event_session_id, node.timestamp, &node.kind,
                                        node.input.as_deref(), node.output_summary.as_deref(),
                                        node.exit_code, &node.working_dir, node.duration_ms, None,
                                    ).ok();

                                    // Emit execution-node event
                                    if let Some(id) = node_id {
                                        let exec_node = ExecutionNode {
                                            id, session_id: event_session_id.clone(),
                                            timestamp: node.timestamp, kind: node.kind.clone(),
                                            input: node.input.clone(), output_summary: node.output_summary.clone(),
                                            exit_code: node.exit_code, working_dir: node.working_dir.clone(),
                                            duration_ms: node.duration_ms, metadata: None,
                                        };
                                        let _ = app_clone.emit(&format!("execution-node-{}", event_session_id), &exec_node);
                                    }

                                    let project_id: Option<String> = Some(node.working_dir.clone());

                                    // Auto-resolution: if we had a pending error and this node succeeded (no error),
                                    // record the input command as the resolution
                                    if let (Some(ref pending_fp), Some(ref pending_proj)) = (&a.pending_error_fp, &a.pending_error_project) {
                                        if !a.had_error_in_node {
                                            if let Some(ref input) = node.input {
                                                let resolution = input.trim().to_string();
                                                if !resolution.is_empty() {
                                                    if let Ok(Some(pattern)) = db.find_error_pattern(Some(pending_proj.as_str()), pending_fp) {
                                                        db.set_error_resolution(pattern.id, &resolution).ok();
                                                    }
                                                }
                                            }
                                            a.pending_error_fp = None;
                                            a.pending_error_project = None;
                                        }
                                    }

                                    // Error fingerprinting — upsert and emit match
                                    if a.had_error_in_node {
                                        if let Some(ref fp) = a.last_error_fingerprint {
                                            if let Ok(pattern) = db.upsert_error_pattern(project_id.as_deref(), fp, &node.output_summary.clone().unwrap_or_default()) {
                                                // Track which sessions hit this error (F6)
                                                db.upsert_error_session(pattern.id, &event_session_id).ok();
                                                let evt = ErrorMatchEvent {
                                                    fingerprint: pattern.fingerprint.clone(),
                                                    occurrence_count: pattern.occurrence_count,
                                                    resolution: pattern.resolution.clone(),
                                                    raw_sample: pattern.raw_sample.clone(),
                                                };
                                                let _ = app_clone.emit(&format!("error-matched-{}", event_session_id), &evt);
                                            }
                                            // Track this error so next successful command can be recorded as resolution
                                            a.pending_error_fp = Some(fp.clone());
                                            a.pending_error_project = project_id.clone();
                                        }
                                    }
                                    // Reset per-node error flag (it's set during process())
                                    a.had_error_in_node = false;

                                    // Command sequence tracking — push FIRST then record
                                    if node.kind == "command" {
                                        if let Some(ref input) = node.input {
                                            let normalized = input.trim().trim_start_matches('$').trim().to_string();
                                            if !normalized.is_empty() {
                                                // Push to recent_commands first
                                                a.recent_commands.push_back(normalized.clone());
                                                if a.recent_commands.len() > 5 {
                                                    a.recent_commands.pop_front();
                                                }

                                                // Now record sequences using the updated list
                                                let cmds: Vec<String> = a.recent_commands.iter().cloned().collect();
                                                if cmds.len() >= 2 {
                                                    let prev: Vec<&str> = cmds[..cmds.len()-1].iter().rev().take(2).map(|s| s.as_str()).collect::<Vec<_>>().into_iter().rev().collect();
                                                    let seq_json = serde_json::to_string(&prev).unwrap_or_default();
                                                    db.record_command_sequence(project_id.as_deref(), &seq_json, &normalized).ok();
                                                }
                                                if cmds.len() >= 3 {
                                                    let prev: Vec<&str> = cmds[..cmds.len()-1].iter().rev().take(3).map(|s| s.as_str()).collect::<Vec<_>>().into_iter().rev().collect();
                                                    let seq_json = serde_json::to_string(&prev).unwrap_or_default();
                                                    db.record_command_sequence(project_id.as_deref(), &seq_json, &normalized).ok();
                                                }

                                                // Query predictions and emit
                                                let seq: Vec<&str> = cmds.iter().rev().take(2).collect::<Vec<_>>().into_iter().rev().map(|s| s.as_str()).collect();
                                                let seq_json = serde_json::to_string(&seq).unwrap_or_default();
                                                if let Ok(predictions) = db.predict_next_command(project_id.as_deref(), &seq_json, 3) {
                                                    if !predictions.is_empty() {
                                                        let evt = CommandPredictionEvent { predictions };
                                                        let _ = app_clone.emit(&format!("command-prediction-{}", event_session_id), &evt);
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        if let Some(new_phase) = a.take_pending_phase() {
                            if let Ok(mut s) = session_clone.lock() {
                                if s.phase != new_phase {
                                    s.phase = new_phase.clone();
                                    s.last_activity_at = now();
                                    s.detected_agent = a.detected_agent.clone();
                                    s.metrics = a.to_metrics();
                                    let update = SessionUpdate::from(&*s);
                                    let _ = app_clone.emit("session-updated", &update);
                                }
                            }
                        }

                        // Auto-launch AI agent when shell is ready
                        if a.pending_ai_launch {
                            a.pending_ai_launch = false;
                            let launch_info = session_clone.lock().ok()
                                .map(|s| (s.ai_provider.clone(), s.has_initial_context));
                            if let Some((Some(ref provider), has_context)) = launch_info {
                                // For Claude/Gemini: pass context instruction as CLI argument
                                // so it's processed immediately without PTY injection timing issues
                                let supports_cli_prompt = provider == "claude" || provider == "gemini";
                                let cmd = if has_context && supports_cli_prompt {
                                    format!("{} \"Read the file at $HERMES_CONTEXT for project context about the attached workspaces.\"", ai_launch_command(provider))
                                } else {
                                    ai_launch_command(provider).to_string()
                                };
                                if let Ok(mut w) = writer_for_reader.lock() {
                                    let _ = w.write_all(format!("{}\r", cmd).as_bytes());
                                    let _ = w.flush();
                                }
                                // Mark context as injected if it was baked into the launch command
                                if has_context && supports_cli_prompt {
                                    a.context_injected = true;
                                    if let Ok(mut s) = session_clone.lock() {
                                        s.context_injected = true;
                                        s.phase = SessionPhase::LaunchingAgent;
                                        let update = SessionUpdate::from(&*s);
                                        let _ = app_clone.emit("session-updated", &update);
                                    }
                                } else {
                                    if let Ok(mut s) = session_clone.lock() {
                                        s.phase = SessionPhase::LaunchingAgent;
                                        let update = SessionUpdate::from(&*s);
                                        let _ = app_clone.emit("session-updated", &update);
                                    }
                                }
                            }
                        }

                        // Auto-inject context when agent prompt is first detected
                        // (fallback for non-Claude agents that can't take CLI args)
                        if a.pending_context_inject && !a.context_injected {
                            a.pending_context_inject = false;
                            a.context_injected = true;
                            if let Ok(mut w) = writer_for_reader.lock() {
                                let msg = "Read the file at $HERMES_CONTEXT for project context about the attached workspaces.\r";
                                let _ = w.write_all(msg.as_bytes());
                                let _ = w.flush();
                            }
                            if let Ok(mut s) = session_clone.lock() {
                                s.context_injected = true;
                            }
                        }

                        if chunk_count % 30 == 0 || a.stuck_score() > 0.5 {
                            if let Ok(mut s) = session_clone.lock() {
                                s.detected_agent = a.detected_agent.clone();
                                s.metrics = a.to_metrics();
                                s.last_activity_at = now();
                                let update = SessionUpdate::from(&*s);
                                let _ = app_clone.emit("session-updated", &update);
                            }
                        }
                    }

                    use base64::Engine;
                    let encoded = base64::engine::general_purpose::STANDARD.encode(data);
                    let _ = app_clone.emit(&format!("pty-output-{}", event_session_id), encoded);
                }
                Err(_) => {
                    if let Ok(mut s) = session_clone.lock() {
                        s.phase = SessionPhase::Destroyed;
                        let update = SessionUpdate::from(&*s);
                        let _ = app_clone.emit("session-updated", &update);
                    }
                    let _ = app_clone.emit(&format!("pty-exit-{}", event_session_id), ());
                    break;
                }
            }
        }
    });

    let result = {
        let s = session_arc.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
        SessionUpdate::from(&*s)
    };

    let pty_session = PtySession { master: pair.master, writer, session: session_arc, analyzer };
    mgr.sessions.insert(session_id.clone(), pty_session);

    // Save to DB
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        db.create_session_v2(&result).ok();

        // Attach realms if provided
        if let Some(ref ids) = realm_ids {
            for realm_id in ids {
                db.attach_session_realm(&session_id, realm_id, "primary").ok();
            }
            // Write context file so AI agents can read project info
            if !ids.is_empty() {
                crate::realm::attunement::write_session_context_file(&app, &db, &session_id).ok();
            }
        }
    }

    Ok(result)
}

#[tauri::command]
pub fn write_to_session(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let mut mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    let session = mgr.sessions.get_mut(&session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;

    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(&data).unwrap_or_else(|_| data.into_bytes());

    if let Ok(mut a) = session.analyzer.lock() {
        a.mark_input_sent();

        let text = String::from_utf8_lossy(&bytes);
        let is_enter = text.contains('\r') || text.contains('\n');

        // Accumulate printable chars into the line buffer
        for ch in text.chars() {
            if ch == '\r' || ch == '\n' {
                // Enter pressed — commit the accumulated line
                continue;
            } else if ch == '\x7f' || ch == '\x08' {
                // Backspace — pop last char
                a.input_line_buffer.pop();
            } else if ch == '\x03' {
                // Ctrl+C — clear buffer
                a.input_line_buffer.clear();
            } else if !ch.is_control() {
                a.input_line_buffer.push(ch);
            }
        }

        if is_enter && !a.input_line_buffer.is_empty() {
            let line = a.input_line_buffer.drain(..).collect::<String>();
            a.mark_input_line(&line);
            let cwd = a.current_cwd.clone().unwrap_or_default();
            a.start_node(&cwd);
        } else if is_enter {
            // Enter with empty buffer — still mark activity
            a.input_line_buffer.clear();
        }
    }

    {
        let mut w = session.writer.lock().map_err(|e| format!("Writer lock failed: {}", e))?;
        w.write_all(&bytes).map_err(|e| format!("Write failed: {}", e))?;
        w.flush().map_err(|e| format!("Flush failed: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn nudge_realm_context(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<bool, String> {
    // Check if there are realms attached
    let has_context = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let realms = db.get_session_realms(&session_id)?;
        !realms.is_empty()
    };

    if !has_context {
        return Ok(false);
    }

    let mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    let pty = match mgr.sessions.get(&session_id) {
        Some(p) => p,
        None => return Ok(false),
    };

    // Only nudge if an AI agent has been detected in this session
    let has_agent = pty.session.lock()
        .map_err(|e| format!("Session lock failed: {}", e))?
        .detected_agent.is_some();

    if !has_agent {
        return Ok(false);
    }

    // Send a minimal one-liner telling the agent to read the context file
    let msg = "Read the file at $HERMES_CONTEXT for project context about the attached workspaces.\r";
    let mut w = pty.writer.lock().map_err(|e| format!("Writer lock failed: {}", e))?;
    w.write_all(msg.as_bytes()).map_err(|e| format!("Write failed: {}", e))?;
    w.flush().map_err(|e| format!("Flush failed: {}", e))?;

    Ok(true)
}

#[tauri::command]
pub fn resize_session(state: State<'_, AppState>, session_id: String, rows: u16, cols: u16) -> Result<(), String> {
    let mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    let session = mgr.sessions.get(&session_id).ok_or_else(|| format!("Session {} not found", session_id))?;
    session.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| format!("Resize failed: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn close_session(app: AppHandle, state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let mut mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;

    if let Some(pty_session) = mgr.sessions.remove(&session_id) {
        // Save snapshot and persist token data
        if let Ok(analyzer) = pty_session.analyzer.lock() {
            let snapshot = analyzer.get_stripped_output();
            let metrics = analyzer.to_metrics();
            if let Ok(db) = state.db.lock() {
                db.save_session_snapshot(&session_id, &snapshot).ok();
                db.update_session_status(&session_id, "destroyed").ok();
                // Persist final token state
                for (provider, tokens) in &metrics.token_usage {
                    db.record_token_usage(
                        &session_id, provider, &tokens.model,
                        tokens.input_tokens as i64, tokens.output_tokens as i64,
                        tokens.estimated_cost_usd,
                    ).ok();
                }
                // Persist memory facts
                for fact in &metrics.memory_facts {
                    db.save_memory_entry(
                        "project", &"global", &fact.key, &fact.value,
                        &fact.source, "auto", fact.confidence as f64,
                    ).ok();
                }
            }
        }

        if let Ok(mut s) = pty_session.session.lock() {
            s.phase = SessionPhase::Destroyed;
            let update = SessionUpdate::from(&*s);
            let _ = app.emit("session-updated", &update);
        }
        let _ = app.emit("session-removed", &session_id);

        // Clean up context file
        crate::realm::attunement::delete_session_context_file(&app, &session_id);

        // Clean up session-scoped pins (project-scoped pins survive)
        if let Ok(db) = state.db.lock() {
            let _ = db.cleanup_session_pins(&session_id);
        }
    }

    Ok(())
}

#[tauri::command]
pub fn get_sessions(state: State<'_, AppState>) -> Result<Vec<SessionUpdate>, String> {
    let mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    Ok(mgr.sessions.values().filter_map(|ps| {
        ps.session.lock().ok().map(|s| SessionUpdate::from(&*s))
    }).collect())
}

#[tauri::command]
pub fn get_session_detail(state: State<'_, AppState>, session_id: String) -> Result<SessionUpdate, String> {
    let mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    let session = mgr.sessions.get(&session_id).ok_or_else(|| format!("Session {} not found", session_id))?;
    let s = session.session.lock().map_err(|e| e.to_string())?;
    Ok(SessionUpdate::from(&*s))
}

#[tauri::command]
pub fn update_session_label(app: AppHandle, state: State<'_, AppState>, session_id: String, label: String) -> Result<(), String> {
    let mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    let session = mgr.sessions.get(&session_id).ok_or_else(|| format!("Session {} not found", session_id))?;
    let mut s = session.session.lock().map_err(|e| e.to_string())?;
    s.label = label;
    let update = SessionUpdate::from(&*s);
    let _ = app.emit("session-updated", &update);
    Ok(())
}

#[tauri::command]
pub fn update_session_color(app: AppHandle, state: State<'_, AppState>, session_id: String, color: String) -> Result<(), String> {
    let mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    let session = mgr.sessions.get(&session_id).ok_or_else(|| format!("Session {} not found", session_id))?;
    let mut s = session.session.lock().map_err(|e| e.to_string())?;
    s.color = color;
    let update = SessionUpdate::from(&*s);
    let _ = app.emit("session-updated", &update);
    Ok(())
}

#[tauri::command]
pub fn add_workspace_path(app: AppHandle, state: State<'_, AppState>, session_id: String, path: String) -> Result<(), String> {
    let mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    let session = mgr.sessions.get(&session_id).ok_or_else(|| format!("Session {} not found", session_id))?;
    let mut s = session.session.lock().map_err(|e| e.to_string())?;
    if !s.workspace_paths.contains(&path) {
        s.workspace_paths.push(path);
    }
    let update = SessionUpdate::from(&*s);
    let _ = app.emit("session-updated", &update);
    Ok(())
}

#[tauri::command]
pub fn update_session_group(
    app: AppHandle, state: State<'_, AppState>,
    session_id: String, group: Option<String>,
) -> Result<(), String> {
    let mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    let pty_session = mgr.sessions.get(&session_id).ok_or_else(|| format!("Session {} not found", session_id))?;
    {
        let mut s = pty_session.session.lock().map_err(|e| e.to_string())?;
        s.group = group.clone();
        let update = SessionUpdate::from(&*s);
        let _ = app.emit("session-updated", &update);
    }
    // Persist
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.update_session_group(&session_id, group.as_deref())?;
    Ok(())
}

#[tauri::command]
pub fn get_session_output(state: State<'_, AppState>, session_id: String) -> Result<String, String> {
    let mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    let session = mgr.sessions.get(&session_id).ok_or_else(|| format!("Session {} not found", session_id))?;
    let analyzer = session.analyzer.lock().map_err(|e| e.to_string())?;
    Ok(analyzer.get_stripped_output())
}

#[tauri::command]
pub fn get_session_metadata(state: State<'_, AppState>, session_id: String) -> Result<SessionMetrics, String> {
    let mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    let session = mgr.sessions.get(&session_id).ok_or_else(|| format!("Session {} not found", session_id))?;
    let analyzer = session.analyzer.lock().map_err(|e| e.to_string())?;
    Ok(analyzer.to_metrics())
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

#[tauri::command]
pub fn detect_shell_environment(state: State<'_, AppState>, session_id: String) -> Result<ShellEnvironment, String> {
    let mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    let session = mgr.sessions.get(&session_id).ok_or_else(|| format!("Session {} not found", session_id))?;
    let s = session.session.lock().map_err(|e| e.to_string())?;

    let shell = &s.shell;
    let shell_type = if shell.contains("zsh") {
        "zsh"
    } else if shell.contains("bash") {
        "bash"
    } else if shell.contains("fish") {
        "fish"
    } else {
        "unknown"
    };

    let home = std::env::var("HOME").unwrap_or_default();
    let mut plugins = Vec::new();
    let mut has_oh_my_zsh = false;
    let mut has_autosuggest = false;
    let mut has_syntax_highlighting = false;
    let mut has_starship = false;
    let mut has_powerlevel10k = false;

    // Check for Oh My Zsh
    if std::path::Path::new(&format!("{}/.oh-my-zsh", home)).exists() {
        has_oh_my_zsh = true;
        plugins.push("oh-my-zsh".to_string());
    }

    // Check for starship (check config file and common install locations)
    let starship_in_path = std::process::Command::new("which")
        .arg("starship")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if starship_in_path || std::path::Path::new(&format!("{}/.config/starship.toml", home)).exists() {
        has_starship = true;
        plugins.push("starship".to_string());
    }

    // Read .zshrc for plugin detection
    if shell_type == "zsh" {
        if let Ok(zshrc) = std::fs::read_to_string(format!("{}/.zshrc", home)) {
            if zshrc.contains("zsh-autosuggestions") {
                has_autosuggest = true;
                plugins.push("zsh-autosuggestions".to_string());
            }
            if zshrc.contains("zsh-syntax-highlighting") || zshrc.contains("fast-syntax-highlighting") {
                has_syntax_highlighting = true;
                plugins.push("zsh-syntax-highlighting".to_string());
            }
            if zshrc.contains("powerlevel10k") || zshrc.contains("p10k") {
                has_powerlevel10k = true;
                plugins.push("powerlevel10k".to_string());
            }
        }
    }

    // Fish has built-in autosuggestions
    if shell_type == "fish" {
        has_autosuggest = true;
    }

    Ok(ShellEnvironment {
        shell_type: shell_type.to_string(),
        plugins_detected: plugins,
        has_native_autosuggest: has_autosuggest,
        has_oh_my_zsh,
        has_syntax_highlighting,
        has_starship,
        has_powerlevel10k,
    })
}

#[tauri::command]
pub fn read_shell_history(shell: String, limit: usize) -> Result<Vec<String>, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;

    let history_path = if shell.contains("zsh") || shell == "zsh" {
        format!("{}/.zsh_history", home)
    } else if shell.contains("bash") || shell == "bash" {
        format!("{}/.bash_history", home)
    } else if shell.contains("fish") || shell == "fish" {
        format!("{}/.local/share/fish/fish_history", home)
    } else {
        // Try zsh first, then bash
        let zsh_path = format!("{}/.zsh_history", home);
        if std::path::Path::new(&zsh_path).exists() {
            zsh_path
        } else {
            format!("{}/.bash_history", home)
        }
    };

    let content = std::fs::read_to_string(&history_path)
        .map_err(|e| format!("Cannot read history file {}: {}", history_path, e))?;

    let is_fish = shell.contains("fish") || shell == "fish";
    let is_zsh = shell.contains("zsh") || shell == "zsh";
    let mut commands = Vec::new();

    if is_fish {
        // Fish history format: "- cmd: <command>"
        for line in content.lines() {
            let trimmed = line.trim();
            if let Some(cmd) = trimmed.strip_prefix("- cmd: ") {
                let cmd = cmd.trim();
                if !cmd.is_empty() {
                    commands.push(cmd.to_string());
                }
            }
        }
    } else if is_zsh {
        // Zsh history can have format: ": timestamp:0;command"
        for line in content.lines() {
            let cmd = if line.starts_with(": ") {
                // Extended history format
                if let Some(idx) = line.find(';') {
                    &line[idx + 1..]
                } else {
                    line
                }
            } else {
                line
            };
            let cmd = cmd.trim();
            if !cmd.is_empty() {
                commands.push(cmd.to_string());
            }
        }
    } else {
        // Bash: one command per line
        for line in content.lines() {
            let cmd = line.trim();
            if !cmd.is_empty() && !cmd.starts_with('#') {
                commands.push(cmd.to_string());
            }
        }
    }

    // Return the last `limit` entries (most recent)
    let start = if commands.len() > limit { commands.len() - limit } else { 0 };
    Ok(commands[start..].to_vec())
}

#[tauri::command]
pub fn get_session_commands(state: State<'_, AppState>, session_id: String, limit: usize) -> Result<Vec<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let entries = db.get_execution_log_entries(&session_id, Some(limit as i64))?;
    Ok(entries.into_iter()
        .filter(|e| e.event_type == "command")
        .map(|e| e.content)
        .collect())
}

#[tauri::command]
pub fn get_project_context(path: String) -> Result<ProjectContextInfo, String> {
    let dir = std::path::Path::new(&path);
    if !dir.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    let has_git = dir.join(".git").exists();

    // Detect package manager
    let package_manager = if dir.join("bun.lockb").exists() || dir.join("bun.lock").exists() {
        Some("bun".to_string())
    } else if dir.join("pnpm-lock.yaml").exists() {
        Some("pnpm".to_string())
    } else if dir.join("yarn.lock").exists() {
        Some("yarn".to_string())
    } else if dir.join("package-lock.json").exists() {
        Some("npm".to_string())
    } else if dir.join("package.json").exists() {
        Some("npm".to_string())
    } else {
        None
    };

    // Detect languages
    let mut languages = Vec::new();
    if dir.join("Cargo.toml").exists() { languages.push("rust".to_string()); }
    if dir.join("tsconfig.json").exists() { languages.push("typescript".to_string()); }
    if dir.join("package.json").exists() && !languages.contains(&"typescript".to_string()) {
        languages.push("javascript".to_string());
    }
    if dir.join("go.mod").exists() { languages.push("go".to_string()); }
    if dir.join("requirements.txt").exists() || dir.join("pyproject.toml").exists() || dir.join("setup.py").exists() {
        languages.push("python".to_string());
    }
    if dir.join("Gemfile").exists() { languages.push("ruby".to_string()); }
    if dir.join("pubspec.yaml").exists() { languages.push("dart".to_string()); }

    // Detect frameworks
    let mut frameworks = Vec::new();
    if dir.join("next.config.js").exists() || dir.join("next.config.ts").exists() || dir.join("next.config.mjs").exists() {
        frameworks.push("next".to_string());
    }
    if dir.join("vite.config.ts").exists() || dir.join("vite.config.js").exists() {
        frameworks.push("vite".to_string());
    }
    if dir.join("remix.config.js").exists() || dir.join("remix.config.ts").exists() {
        frameworks.push("remix".to_string());
    }
    if dir.join("astro.config.mjs").exists() || dir.join("astro.config.ts").exists() {
        frameworks.push("astro".to_string());
    }
    if dir.join("nuxt.config.ts").exists() || dir.join("nuxt.config.js").exists() {
        frameworks.push("nuxt".to_string());
    }
    if dir.join("tauri.conf.json").exists() || dir.join("src-tauri").exists() {
        frameworks.push("tauri".to_string());
    }
    if dir.join("Dockerfile").exists() || dir.join("docker-compose.yml").exists() || dir.join("docker-compose.yaml").exists() {
        frameworks.push("docker".to_string());
    }
    if dir.join("Makefile").exists() { frameworks.push("make".to_string()); }
    if dir.join("pubspec.yaml").exists() { frameworks.push("flutter".to_string()); }
    if dir.join(".terraform").exists() || dir.join("main.tf").exists() {
        frameworks.push("terraform".to_string());
    }

    Ok(ProjectContextInfo {
        has_git,
        package_manager,
        languages,
        frameworks,
    })
}
