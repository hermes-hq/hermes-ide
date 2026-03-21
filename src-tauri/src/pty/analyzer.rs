use std::collections::{HashMap, HashSet, VecDeque};

use crate::pty::adapters::*;
use crate::pty::models::*;
use crate::pty::patterns::*;

// ─── Node Builder (tracks command→output cycles) ────────────────────

pub(crate) struct NodeBuilder {
    started_at: std::time::Instant,
    timestamp: i64,
    kind: String,
    input: Option<String>,
    output_lines: Vec<String>,
    working_dir: String,
}

impl NodeBuilder {
    pub fn new(kind: &str, input: Option<String>, working_dir: &str) -> Self {
        Self {
            started_at: std::time::Instant::now(),
            timestamp: chrono::Utc::now().timestamp(),
            kind: kind.to_string(),
            input,
            output_lines: Vec::new(),
            working_dir: working_dir.to_string(),
        }
    }

    pub fn push_output(&mut self, line: &str) {
        if self.output_lines.len() < 50 {
            self.output_lines.push(line.to_string());
        }
    }

    pub fn finalize(self, exit_code: Option<i32>) -> CompletedNode {
        let duration_ms = self.started_at.elapsed().as_millis() as i64;
        let summary: String = self.output_lines.join("\n").chars().take(500).collect();
        CompletedNode {
            timestamp: self.timestamp,
            kind: self.kind,
            input: self.input,
            output_summary: if summary.is_empty() {
                None
            } else {
                Some(summary)
            },
            exit_code,
            working_dir: self.working_dir,
            duration_ms,
        }
    }
}

pub(crate) struct CompletedNode {
    pub timestamp: i64,
    pub kind: String,
    pub input: Option<String>,
    pub output_summary: Option<String>,
    pub exit_code: Option<i32>,
    pub working_dir: String,
    pub duration_ms: i64,
}

// ─── Command Prediction Event Payload ───────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct CommandPredictionEvent {
    pub predictions: Vec<crate::db::CommandPrediction>,
}

// ─── Output Analyzer (uses Provider Registry) ───────────────────────

pub struct OutputAnalyzer {
    registry: ProviderRegistry,
    pub active_provider_idx: Option<usize>,
    stripped_buffer: String,
    line_count: u64,
    pub detected_agent: Option<AgentInfo>,
    pub is_busy: bool,
    pub pending_phase: Option<SessionPhase>,
    // Token ledger
    token_usage: HashMap<String, ProviderTokens>,
    token_history: VecDeque<(u64, u64)>,
    // Tool tracking
    tool_calls: VecDeque<ToolCall>,
    tool_call_summary: HashMap<String, u32>,
    // File tracking
    files_touched: HashSet<String>,
    files_ordered: VecDeque<String>,
    // Actions
    recent_actions: VecDeque<ActionEvent>,
    available_actions: Vec<ActionTemplate>,
    // Memory
    memory_facts: VecDeque<MemoryFact>,
    memory_keys_seen: HashSet<String>,
    // Latency
    last_input_at: Option<std::time::Instant>,
    latency_samples: VecDeque<f64>,
    // CWD tracking
    pub current_cwd: Option<String>,
    pending_cwd: Option<String>,
    // Node builder (execution tracking)
    node_builder: Option<NodeBuilder>,
    completed_nodes: VecDeque<CompletedNode>,
    last_input_line: Option<String>,
    // Command sequence tracking
    pub recent_commands: VecDeque<String>,
    // Input line accumulation buffer
    pub input_line_buffer: String,
    // Idle timeout tracking
    pub last_output_at: Option<std::time::Instant>,
    // Auto-launch / auto-inject tracking
    pub shell_ready: bool,
    pub pending_ai_launch: bool,
    pub pending_context_inject: bool,
    pub context_injected: bool,
    prompt_count_after_agent: u32,
    /// Lines to scan after AI launch for "command not found" errors.
    pub ai_launch_check_remaining: u32,
    /// Provider name when "command not found" is detected after AI launch.
    pub ai_launch_failed: Option<String>,
    /// Provider being launched (set before launch, cleared after check window).
    pub ai_launching_provider: Option<String>,
}

impl Default for OutputAnalyzer {
    fn default() -> Self {
        Self::new()
    }
}

impl OutputAnalyzer {
    pub fn new() -> Self {
        Self {
            registry: ProviderRegistry::new(),
            active_provider_idx: None,
            stripped_buffer: String::new(),
            line_count: 0,
            detected_agent: None,
            is_busy: false,
            pending_phase: None,
            token_usage: HashMap::new(),
            token_history: VecDeque::new(),
            tool_calls: VecDeque::new(),
            tool_call_summary: HashMap::new(),
            files_touched: HashSet::new(),
            files_ordered: VecDeque::new(),
            recent_actions: VecDeque::new(),
            available_actions: Vec::new(),
            memory_facts: VecDeque::new(),
            memory_keys_seen: HashSet::new(),
            last_input_at: None,
            latency_samples: VecDeque::new(),
            current_cwd: None,
            pending_cwd: None,
            node_builder: None,
            completed_nodes: VecDeque::new(),
            last_input_line: None,
            recent_commands: VecDeque::new(),
            input_line_buffer: String::new(),
            last_output_at: None,
            shell_ready: false,
            pending_ai_launch: false,
            pending_context_inject: false,
            context_injected: false,
            prompt_count_after_agent: 0,
            ai_launch_check_remaining: 0,
            ai_launch_failed: None,
            ai_launching_provider: None,
        }
    }

    pub fn mark_input_sent(&mut self) {
        self.last_input_at = Some(std::time::Instant::now());
    }

    pub fn mark_input_line(&mut self, line: &str) {
        self.last_input_line = Some(line.to_string());
    }

    pub fn start_node(&mut self, working_dir: &str) {
        let input = self.last_input_line.take();
        let kind = if self.detected_agent.is_some() {
            "ai_interaction"
        } else {
            "command"
        };
        self.node_builder = Some(NodeBuilder::new(kind, input, working_dir));
    }

    pub fn finalize_node(&mut self, exit_code: Option<i32>) {
        if let Some(builder) = self.node_builder.take() {
            let completed = builder.finalize(exit_code);
            self.completed_nodes.push_back(completed);
            if self.completed_nodes.len() > 20 {
                self.completed_nodes.pop_front();
            }
        }
    }

    #[allow(private_interfaces)]
    pub fn drain_completed_nodes(&mut self) -> Vec<CompletedNode> {
        self.completed_nodes.drain(..).collect()
    }

    pub fn process(&mut self, raw: &[u8]) {
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

        // Strip ANSI escapes once — reused for busy detection, cost/token scanning,
        // and line-by-line analysis below.
        let stripped = strip_ansi_escapes::strip(raw);
        let text = String::from_utf8_lossy(&stripped);

        // Only mark busy when there's meaningful text content (not just
        // control sequences, cursor movements, or terminal keepalives).
        let has_visible = text.chars().any(|c| !c.is_control() && !c.is_whitespace());
        if has_visible {
            if !self.is_busy {
                self.is_busy = true;
                self.pending_phase = Some(SessionPhase::Busy);
            }
            self.last_output_at = Some(std::time::Instant::now());
        }

        // Check for OSC 7 (CWD reporting) in raw data before stripping
        let raw_text = String::from_utf8_lossy(raw);
        if let Some(caps) = OSC7_RE.captures(&raw_text) {
            let path = percent_decode(&caps[1]);
            // On Windows, OSC 7 emits file:///C:/... which captures as /C:/...
            // Strip the leading slash before the drive letter to get a valid path.
            #[cfg(windows)]
            let path = if path.len() >= 3
                && path.starts_with('/')
                && path.as_bytes().get(2) == Some(&b':')
            {
                path[1..].replace('/', "\\")
            } else {
                path
            };
            if self.current_cwd.as_deref() != Some(&path) {
                self.current_cwd = Some(path.clone());
                self.pending_cwd = Some(path);
            }
        }

        // Scan stripped text for cost/token patterns (TUI status bars use cursor
        // positioning, but the text content is still in the raw stream)
        if let Some(idx) = self.active_provider_idx {
            // Check the full chunk for cost patterns (status bars often render in one chunk)
            if let Some(caps) = SESSION_COST_RE
                .captures(&text)
                .or_else(|| CLAUDE_COST_RE.captures(&text))
            {
                if let Ok(cost) = caps[1].parse::<f64>() {
                    if cost > 0.0 {
                        let _ = idx; // used above
                        let key = "anthropic".to_string();
                        let entry = self
                            .token_usage
                            .entry(key)
                            .or_insert_with(|| ProviderTokens {
                                input_tokens: 0,
                                output_tokens: 0,
                                estimated_cost_usd: 0.0,
                                model: "unknown".into(),
                                last_updated: now(),
                                update_count: 0,
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
            if let Some(caps) = CLAUDE_TOKEN_SHORT_RE.captures(&text) {
                let input = parse_token_count(&caps[1]);
                let output = parse_token_count(&caps[2]);
                if input > 0 || output > 0 {
                    let key = "anthropic".to_string();
                    let entry = self
                        .token_usage
                        .entry(key)
                        .or_insert_with(|| ProviderTokens {
                            input_tokens: 0,
                            output_tokens: 0,
                            estimated_cost_usd: 0.0,
                            model: "unknown".into(),
                            last_updated: now(),
                            update_count: 0,
                        });
                    entry.input_tokens = input;
                    entry.output_tokens = output;
                    entry.last_updated = now();
                    entry.update_count += 1;

                    let total_in: u64 = self.token_usage.values().map(|t| t.input_tokens).sum();
                    let total_out: u64 = self.token_usage.values().map(|t| t.output_tokens).sum();
                    self.token_history.push_back((total_in, total_out));
                    if self.token_history.len() > 30 {
                        self.token_history.pop_front();
                    }
                }
            }
        }

        for line in text.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

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
                        || (lower.contains("claude")
                            && (lower.contains("v2.") || lower.contains("v1.")));
                    let is_unknown =
                        agent.model.is_none() || agent.model.as_deref() == Some("unknown");

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
                    self.files_ordered.push_back(path);
                    if self.files_ordered.len() > 50 {
                        if let Some(removed) = self.files_ordered.pop_front() {
                            self.files_touched.remove(&removed);
                        }
                    }
                }
            }

            // Feed output to node builder
            if let Some(ref mut builder) = self.node_builder {
                builder.push_output(trimmed);
            }

            // Check for "command not found" after AI launch attempt
            if self.ai_launch_check_remaining > 0 {
                self.ai_launch_check_remaining -= 1;
                let lower = trimmed.to_lowercase();
                if lower.contains("command not found")
                    || lower.contains("not recognized")
                    || lower.contains("unknown command")
                {
                    if let Some(ref provider) = self.ai_launching_provider {
                        self.ai_launch_failed = Some(provider.clone());
                    }
                    self.ai_launch_check_remaining = 0;
                    self.ai_launching_provider = None;
                }
                if self.ai_launch_check_remaining == 0 {
                    self.ai_launching_provider = None;
                }
            }

            // Keep stripped buffer (last ~16KB, char-boundary safe)
            self.stripped_buffer.push_str(trimmed);
            self.stripped_buffer.push('\n');
            if self.stripped_buffer.len() > 16000 {
                let mut drain = self.stripped_buffer.len() - 16000;
                while drain < self.stripped_buffer.len()
                    && !self.stripped_buffer.is_char_boundary(drain)
                {
                    drain += 1;
                }
                self.stripped_buffer.drain(..drain);
            }
        }
    }

    #[allow(private_interfaces)]
    pub fn apply_analysis(&mut self, analysis: LineAnalysis) {
        if let Some(tu) = analysis.token_update {
            self.apply_token_update(tu);
        }
        if let Some(tc) = analysis.tool_call {
            *self.tool_call_summary.entry(tc.tool.clone()).or_insert(0) += 1;
            self.tool_calls.push_back(tc);
            if self.tool_calls.len() > 100 {
                self.tool_calls.pop_front();
            }
        }
        if let Some(action) = analysis.action {
            self.recent_actions.push_back(action);
            if self.recent_actions.len() > 20 {
                self.recent_actions.pop_front();
            }
        }
        if let Some(fact) = analysis.memory_fact {
            if !self.memory_keys_seen.contains(&fact.key) {
                self.memory_keys_seen.insert(fact.key.clone());
                self.memory_facts.push_back(fact);
                // Cap memory facts to prevent unbounded growth across long sessions
                if self.memory_facts.len() > 200 {
                    if let Some(removed) = self.memory_facts.pop_front() {
                        self.memory_keys_seen.remove(&removed.key);
                    }
                }
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
                PhaseHint::InputNeeded => {
                    // Agent is asking for confirmation or input
                    if self.node_builder.is_some() {
                        self.finalize_node(None);
                    }
                    self.is_busy = false;
                    self.pending_phase = Some(SessionPhase::NeedsInput);
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
        let entry = self
            .token_usage
            .entry(key)
            .or_insert_with(|| ProviderTokens {
                input_tokens: 0,
                output_tokens: 0,
                estimated_cost_usd: 0.0,
                model: tu.model.clone(),
                last_updated: now(),
                update_count: 0,
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
            entry.estimated_cost_usd = estimate_cost(
                &tu.provider,
                &entry.model,
                entry.input_tokens,
                entry.output_tokens,
            );
        }

        entry.update_count += 1;
        entry.last_updated = now();
        entry.model = if tu.model != "unknown" {
            tu.model
        } else {
            entry.model.clone()
        };

        // Record history sample for sparkline
        let total_in: u64 = self.token_usage.values().map(|t| t.input_tokens).sum();
        let total_out: u64 = self.token_usage.values().map(|t| t.output_tokens).sum();
        self.token_history.push_back((total_in, total_out));
        if self.token_history.len() > 30 {
            self.token_history.pop_front();
        }
    }

    pub fn take_pending_phase(&mut self) -> Option<SessionPhase> {
        self.pending_phase.take()
    }

    /// Called by the silence timer when no output has arrived for a while.
    /// If the analyzer still thinks it's busy, determine Idle vs NeedsInput.
    ///
    /// Key insight: instead of trying to detect every "needs input" pattern
    /// (impossible — interactive TUI menus use cursor positioning, not plain text),
    /// we detect the PROMPT (which we already handle well). If no prompt was
    /// detected in the last few lines, we're NOT at a normal prompt → NeedsInput.
    pub fn check_silence(&mut self) {
        if !self.is_busy {
            return;
        }

        // Fallback auto-launch: if the PTY went silent but we never detected a
        // shell prompt (e.g. the user's prompt theme doesn't match any known
        // pattern), treat the silence as "shell is ready" and trigger auto-launch.
        // This guarantees AI sessions always start the agent command, even with
        // exotic prompts.
        if !self.shell_ready && self.detected_agent.is_none() {
            self.shell_ready = true;
            self.pending_ai_launch = true;
            self.is_busy = false;
            self.pending_phase = Some(SessionPhase::ShellReady);
            if self.node_builder.is_some() {
                self.finalize_node(None);
            }
            return;
        }

        // Check if any of the last few lines look like a recognized prompt
        let has_prompt = self.stripped_buffer.lines().rev().take(5).any(|l| {
            let t = l.trim();
            if t.is_empty() {
                return false;
            }
            if let Some(idx) = self.active_provider_idx {
                self.registry.adapters[idx].is_prompt(t)
            } else {
                is_shell_prompt(t)
            }
        });

        if self.node_builder.is_some() {
            self.finalize_node(None);
        }
        self.is_busy = false;

        if has_prompt {
            self.pending_phase = Some(SessionPhase::Idle);
        } else if self.detected_agent.is_some() {
            self.pending_phase = Some(SessionPhase::NeedsInput);
        } else {
            self.pending_phase = Some(SessionPhase::Idle);
        }
    }

    pub fn take_pending_cwd(&mut self) -> Option<String> {
        self.pending_cwd.take()
    }

    pub fn to_metrics(&self) -> SessionMetrics {
        let usage = self.token_usage.clone();

        SessionMetrics {
            output_lines: self.line_count,
            error_count: 0,
            stuck_score: 0.0,
            token_usage: usage,
            tool_calls: self.tool_calls.iter().rev().take(20).cloned().collect(),
            tool_call_summary: self.tool_call_summary.clone(),
            files_touched: self.files_ordered.iter().cloned().collect(),
            recent_errors: vec![],
            recent_actions: self.recent_actions.iter().cloned().collect(),
            available_actions: self.available_actions.clone(),
            memory_facts: self.memory_facts.iter().cloned().collect(),
            latency_p50_ms: percentile(&self.latency_samples, 50.0),
            latency_p95_ms: percentile(&self.latency_samples, 95.0),
            latency_samples: self.latency_samples.iter().copied().collect(),
            token_history: self.token_history.iter().cloned().collect(),
        }
    }

    pub(crate) fn get_stripped_output(&self) -> String {
        self.stripped_buffer.clone()
    }
}

// ─── Utility Functions ──────────────────────────────────────────────

pub(crate) fn percent_decode(s: &str) -> String {
    let mut bytes = Vec::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '%' {
            let hex: String = chars.by_ref().take(2).collect();
            if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                bytes.push(byte);
            } else {
                bytes.push(b'%');
                bytes.extend_from_slice(hex.as_bytes());
            }
        } else if c.is_ascii() {
            bytes.push(c as u8);
        } else {
            let mut buf = [0u8; 4];
            bytes.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
        }
    }
    String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

fn percentile(samples: &VecDeque<f64>, pct: f64) -> Option<f64> {
    if samples.is_empty() {
        return None;
    }
    let mut sorted: Vec<f64> = samples.iter().copied().collect();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let idx = ((pct / 100.0) * (sorted.len() as f64 - 1.0)).round() as usize;
    sorted.get(idx).copied()
}
