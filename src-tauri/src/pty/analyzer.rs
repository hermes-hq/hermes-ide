use std::collections::{HashMap, HashSet, VecDeque};

use crate::pty::adapters::*;
use crate::pty::models::*;
use crate::pty::patterns::*;

// ─── Output Analyzer (uses Provider Registry) ───────────────────────

/// The terminal's lines as a person saw them, for the scrollback snapshot a
/// restored session shows (CHAOS-03): output arrives in arbitrary chunks
/// (an echoed keystroke is a chunk of its own), so a line ends only at a
/// newline, and a carriage return, a backspace or a cursor move goes back
/// over what the line already has (a shell redrawing its prompt, a
/// progress bar) instead of starting a new line. A full-screen program's
/// screen (the alternate screen) is not history and is left out.
struct SnapshotLines {
    parser: vte::Parser,
    screen: SnapshotScreen,
}

impl Default for SnapshotLines {
    fn default() -> Self {
        Self {
            parser: vte::Parser::new(),
            screen: SnapshotScreen::default(),
        }
    }
}

#[derive(Debug, Default)]
struct SnapshotScreen {
    done: String,
    line: Vec<char>,
    col: usize,
    alternate: bool,
}

impl SnapshotLines {
    const MAX_BYTES: usize = 16_000;
    const MAX_LINE: usize = 4_000;

    fn feed(&mut self, raw: &[u8]) {
        self.parser.advance(&mut self.screen, raw);
    }

    fn text(&self) -> String {
        let s = &self.screen;
        let current: String = s.line.iter().collect();
        let current = current.trim_end();
        if current.is_empty() {
            s.done.clone()
        } else {
            format!("{}{}\n", s.done, current)
        }
    }

    fn clear(&mut self) {
        let alternate = self.screen.alternate;
        self.screen = SnapshotScreen {
            alternate,
            ..Default::default()
        };
    }
}

impl SnapshotScreen {
    fn put(&mut self, c: char) {
        if self.col < self.line.len() {
            self.line[self.col] = c;
        } else if self.col < SnapshotLines::MAX_LINE {
            while self.line.len() < self.col {
                self.line.push(' ');
            }
            self.line.push(c);
        } else {
            return;
        }
        self.col += 1;
    }

    fn commit(&mut self) {
        let text: String = self.line.iter().collect();
        self.done.push_str(text.trim_end());
        self.done.push('\n');
        self.line.clear();
        self.col = 0;
        if self.done.len() > SnapshotLines::MAX_BYTES {
            let mut drain = self.done.len() - SnapshotLines::MAX_BYTES;
            while drain < self.done.len() && !self.done.is_char_boundary(drain) {
                drain += 1;
            }
            // Whole lines only.
            if let Some(nl) = self.done[drain..].find('\n') {
                drain += nl + 1;
            }
            self.done.drain(..drain);
        }
    }
}

impl vte::Perform for SnapshotScreen {
    fn print(&mut self, c: char) {
        if !self.alternate {
            self.put(c);
        }
    }

    fn execute(&mut self, byte: u8) {
        if self.alternate {
            return;
        }
        match byte {
            b'\n' => self.commit(),
            b'\r' => self.col = 0,
            0x08 => self.col = self.col.saturating_sub(1),
            b'\t' => {
                let next = (self.col / 8 + 1) * 8;
                while self.col < next {
                    self.put(' ');
                }
            }
            _ => {}
        }
    }

    fn csi_dispatch(
        &mut self,
        params: &vte::Params,
        intermediates: &[u8],
        _ignore: bool,
        action: char,
    ) {
        let first = params
            .iter()
            .next()
            .and_then(|p| p.first().copied())
            .unwrap_or(0);
        if intermediates == b"?" {
            // The alternate screen (1049, 1047, 47) on and off.
            if matches!(first, 1049 | 1047 | 47) {
                match action {
                    'h' => self.alternate = true,
                    'l' => self.alternate = false,
                    _ => {}
                }
            }
            return;
        }
        if self.alternate || !intermediates.is_empty() {
            return;
        }
        let n = (first as usize).max(1);
        match action {
            // Erase in line: from the cursor (0), to it (1), all of it (2).
            'K' => match first {
                0 => self.line.truncate(self.col),
                1 => {
                    for c in self.line.iter_mut().take(self.col + 1) {
                        *c = ' ';
                    }
                }
                _ => self.line.clear(),
            },
            'D' => self.col = self.col.saturating_sub(n),
            'C' => self.col = (self.col + n).min(SnapshotLines::MAX_LINE),
            'G' => self.col = n - 1,
            _ => {}
        }
    }
}

/// A shell's refusal to `cd` into a folder (zsh, bash, fish, PowerShell,
/// cmd), as opposed to the folder missing.
pub(crate) fn is_cd_refusal(line: &str) -> bool {
    let lower = line.to_lowercase();
    (lower.contains("cd") || lower.contains("set-location"))
        && (lower.contains("permission denied")
            || lower.contains("operation not permitted")
            || lower.contains("is denied"))
}

pub struct OutputAnalyzer {
    registry: ProviderRegistry,
    pub active_provider_idx: Option<usize>,
    stripped_buffer: String,
    /// What the scrollback snapshot saves (see [`SnapshotLines`]).
    snapshot: SnapshotLines,
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
    // Idle timeout tracking
    pub last_output_at: Option<std::time::Instant>,
    // Auto-launch / auto-inject tracking
    pub shell_ready: bool,
    pub pending_ai_launch: bool,
    /// Text the person has on the shell's command line (see `typed_line`).
    pub typed_line: crate::pty::typed_line::TypedLine,
    pub pending_context_inject: bool,
    pub context_injected: bool,
    prompt_count_after_agent: u32,
    /// Lines to scan after AI launch for "command not found" errors.
    pub ai_launch_check_remaining: u32,
    /// Provider name when "command not found" is detected after AI launch.
    pub ai_launch_failed: Option<String>,
    /// Provider being launched (set before launch, cleared after check window).
    pub ai_launching_provider: Option<String>,
    /// Lines to scan after a launch typed behind a `cd` for the shell's
    /// refusal of that `cd`.
    pub launch_cd_check_remaining: u32,
    /// The shell refused the `cd` before the agent's command.
    pub launch_cd_failed: bool,
    /// True when the terminal is currently inside an "alternate screen buffer"
    /// (DEC private modes 1049 / 1047 / 47), i.e. running a full-screen TUI
    /// like vim, less, htop, nano, ssh, or the Claude/Codex CLIs. While this
    /// is true the input path skips the line-buffer machinery so random
    /// keystrokes typed at the TUI don't get recorded as shell commands.
    pub in_alternate_screen: bool,
    /// Streaming escape-sequence parser for OSC reports. Holds a partial
    /// sequence from one read until the rest arrives in the next.
    osc_parser: vte::Parser,
    /// Bytes fed to `osc_parser` since the last byte that can end an OSC
    /// sequence. vte buffers an open OSC without limit, so a stray `ESC ]`
    /// followed by a long run of plain output would otherwise be held in
    /// memory until the next escape.
    osc_open_len: usize,
    /// Terminal notifications (OSC 9/99/777) seen since the last take: the
    /// status fallback for agents without hooks (F11, `osc_signals.rs`).
    pending_notifications: Vec<TerminalNotification>,
    /// A kitty (OSC 99) notification arrives in parts (title, body, done),
    /// possibly across reads; the parts of each id wait here.
    osc99_parts: std::collections::BTreeMap<String, (String, String)>,
}

use super::osc_signals::{sanitize, TerminalNotification};

/// Longest open OSC sequence kept across reads. A real OSC 7 report is at
/// most a PATH_MAX path, percent-encoded (about 12 KiB); anything past this
/// is a stray `ESC ]` and the parser is reset.
const MAX_OPEN_OSC_BYTES: usize = 64 * 1024;

/// Collects, from the OSC sequences the parser sees in one read: the
/// working directory from OSC 7 reports (`ESC ] 7 ; file://host/path BEL`
/// or `... ESC \`; the last report in a read wins) and the terminal
/// notifications of OSC 9 (iTerm2), OSC 99 (kitty, in parts) and OSC 777
/// (`notify;title;body`). Notification text is untrusted: see
/// `osc_signals::sanitize`.
#[derive(Default)]
struct OscCollector {
    last: Option<String>,
    notifications: Vec<TerminalNotification>,
    osc99_parts: std::collections::BTreeMap<String, (String, String)>,
}

impl OscCollector {
    /// One kitty notification part: `i=<id>:d=<0|1>:p=<title|body>` metadata
    /// then the payload. `d=0` means more parts follow; the notification is
    /// complete on the first part without it.
    fn osc99(&mut self, meta: &[u8], payload: &[u8]) {
        let meta = String::from_utf8_lossy(meta).to_string();
        let mut id = "0".to_string();
        let mut more = false;
        let mut part = "body";
        for kv in meta.split(':') {
            match kv.split_once('=') {
                Some(("i", v)) => id = v.to_string(),
                Some(("d", "0")) => more = true,
                Some(("p", "title")) => part = "title",
                Some(("p", "body")) => part = "body",
                _ => {}
            }
        }
        let entry = self.osc99_parts.entry(id.clone()).or_default();
        let text = sanitize(payload);
        if !text.is_empty() {
            let slot = if part == "title" {
                &mut entry.0
            } else {
                &mut entry.1
            };
            if slot.is_empty() {
                *slot = text;
            } else {
                slot.push(' ');
                slot.push_str(&text);
            }
        }
        if !more {
            let (title, body) = self.osc99_parts.remove(&id).unwrap_or_default();
            if !title.is_empty() || !body.is_empty() {
                self.notifications.push(TerminalNotification {
                    osc: 99,
                    title,
                    body,
                });
            }
        }
        if self.osc99_parts.len() > 16 {
            self.osc99_parts.clear();
        }
    }
}

impl vte::Perform for OscCollector {
    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        if params.len() < 2 {
            return;
        }
        match params[0] {
            b"7" => {
                // The parser splits on ';', which is legal inside a path.
                let uri = params[1..].join(&b';');
                if let Some(path) = osc7_path(&String::from_utf8_lossy(&uri)) {
                    self.last = Some(path);
                }
            }
            b"9" => {
                // ConEmu's `9;<n>;...` commands (Windows Terminal and
                // PowerShell prompts use them) are not notifications (XP-06):
                // `9;9;<path>` reports the working folder, `9;4` is a
                // progress bar, and the others set titles, run macros or
                // mark prompts.
                if let Some(code) = conemu_code(params[1]) {
                    if code == 9 && params.len() >= 3 {
                        let path = String::from_utf8_lossy(&params[2..].join(&b';')).to_string();
                        let path = path.trim().trim_matches('"').trim();
                        if !path.is_empty() {
                            self.last = Some(path.to_string());
                        }
                    }
                    return;
                }
                let body = sanitize(&params[1..].join(&b';'));
                if !body.is_empty() {
                    self.notifications.push(TerminalNotification {
                        osc: 9,
                        title: String::new(),
                        body,
                    });
                }
            }
            b"99" => {
                let payload = if params.len() > 2 {
                    params[2..].join(&b';')
                } else {
                    Vec::new()
                };
                self.osc99(params[1], &payload);
            }
            b"777" if params[1] == b"notify" => {
                let title = params.get(2).map(|t| sanitize(t)).unwrap_or_default();
                let body = if params.len() > 3 {
                    sanitize(&params[3..].join(&b';'))
                } else {
                    String::new()
                };
                if !title.is_empty() || !body.is_empty() {
                    self.notifications.push(TerminalNotification {
                        osc: 777,
                        title,
                        body,
                    });
                }
            }
            _ => {}
        }
        if self.notifications.len() > 32 {
            // A program spraying notifications: keep the latest.
            self.notifications.drain(..self.notifications.len() - 32);
        }
    }
}

/// The ConEmu command number of an OSC 9 sequence (`9;<1..12>;...`), or
/// None for a plain `9;<text>` notification.
fn conemu_code(first: &[u8]) -> Option<u8> {
    let text = std::str::from_utf8(first).ok()?;
    let n: u8 = text.parse().ok()?;
    (1..=12).contains(&n).then_some(n)
}

/// Path from an OSC 7 `file://host/path` URI, percent-decoded.
pub(crate) fn osc7_path(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("file://")?;
    let path = &rest[rest.find('/')?..];
    Some(percent_decode(path))
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
            snapshot: SnapshotLines::default(),
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
            last_output_at: None,
            shell_ready: false,
            pending_ai_launch: false,
            typed_line: Default::default(),
            pending_context_inject: false,
            context_injected: false,
            prompt_count_after_agent: 0,
            ai_launch_check_remaining: 0,
            ai_launch_failed: None,
            ai_launching_provider: None,
            launch_cd_check_remaining: 0,
            launch_cd_failed: false,
            in_alternate_screen: false,
            osc_parser: vte::Parser::new(),
            osc_open_len: 0,
            pending_notifications: Vec::new(),
            osc99_parts: std::collections::BTreeMap::new(),
        }
    }

    pub fn mark_input_sent(&mut self) {
        self.last_input_at = Some(std::time::Instant::now());
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

        // Track alternate-screen-buffer state on the raw byte stream before
        // ANSI escapes are stripped. Used by the input path to suppress
        // line-buffer recording while a TUI owns the screen.
        Self::update_alt_screen_state(&mut self.in_alternate_screen, raw);
        self.snapshot.feed(raw);

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

        // OSC 7 (CWD reporting). The parser keeps its state between reads, so
        // a report split across two PTY reads is still seen once complete.
        let mut cwd_reports = OscCollector {
            last: None,
            notifications: Vec::new(),
            osc99_parts: std::mem::take(&mut self.osc99_parts),
        };
        self.osc_parser.advance(&mut cwd_reports, raw);
        self.osc99_parts = std::mem::take(&mut cwd_reports.osc99_parts);
        self.pending_notifications
            .append(&mut cwd_reports.notifications);
        // BEL, CAN, SUB and ESC all end an open OSC sequence.
        self.osc_open_len = match raw
            .iter()
            .rposition(|b| matches!(b, 0x07 | 0x18 | 0x1a | 0x1b))
        {
            Some(i) => raw.len() - i - 1,
            None => self.osc_open_len.saturating_add(raw.len()),
        };
        if self.osc_open_len > MAX_OPEN_OSC_BYTES {
            self.osc_parser = vte::Parser::new();
            self.osc_open_len = 0;
        }
        if let Some(path) = cwd_reports.last {
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

            if self.launch_cd_check_remaining > 0 {
                self.launch_cd_check_remaining -= 1;
                if is_cd_refusal(trimmed) {
                    self.launch_cd_failed = true;
                    self.launch_cd_check_remaining = 0;
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
                    self.is_busy = true;
                    self.pending_phase = Some(SessionPhase::Busy);
                }
                PhaseHint::InputNeeded => {
                    // Agent is asking for confirmation or input
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

        self.is_busy = false;

        if has_prompt {
            self.pending_phase = Some(SessionPhase::Idle);
        } else if self.detected_agent.is_some() {
            self.pending_phase = Some(SessionPhase::NeedsInput);
        } else {
            self.pending_phase = Some(SessionPhase::Idle);
        }
    }

    /// Terminal notifications seen since the last call, oldest first.
    pub fn take_pending_notifications(&mut self) -> Vec<TerminalNotification> {
        std::mem::take(&mut self.pending_notifications)
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

    /// The terminal's recent lines, for the scrollback snapshot.
    pub(crate) fn get_stripped_output(&self) -> String {
        self.snapshot.text()
    }

    pub(crate) fn clear_stripped_output(&mut self) {
        self.snapshot.clear();
        self.stripped_buffer.clear();
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

impl OutputAnalyzer {
    /// Scan `raw` for DEC private-mode set/reset sequences that toggle the
    /// alternate screen buffer and update `state` to reflect the most-recent
    /// transition observed. Handles all three variants in common use:
    ///   - `\x1b[?1049h` / `\x1b[?1049l` (xterm-style, modern default)
    ///   - `\x1b[?1047h` / `\x1b[?1047l`
    ///   - `\x1b[?47h`   / `\x1b[?47l`   (older terminals)
    ///
    /// Only the latest transition in a chunk matters — if a TUI exits and a
    /// new one starts inside the same PTY read, we should land on "in TUI".
    fn update_alt_screen_state(state: &mut bool, raw: &[u8]) {
        const PATTERNS: &[(&[u8], bool)] = &[
            (b"\x1b[?1049h", true),
            (b"\x1b[?1049l", false),
            (b"\x1b[?1047h", true),
            (b"\x1b[?1047l", false),
            (b"\x1b[?47h", true),
            (b"\x1b[?47l", false),
        ];
        let mut latest: Option<(usize, bool)> = None;
        for (needle, enter) in PATTERNS {
            if needle.is_empty() || raw.len() < needle.len() {
                continue;
            }
            let mut start = 0usize;
            while let Some(rel) = raw[start..]
                .windows(needle.len())
                .position(|w| w == *needle)
            {
                let abs = start + rel;
                match latest {
                    Some((cur, _)) if cur >= abs => {}
                    _ => latest = Some((abs, *enter)),
                }
                start = abs + needle.len();
            }
        }
        if let Some((_, enter)) = latest {
            *state = enter;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_snapshot_keeps_a_typed_command_on_one_line() {
        // CHAOS-03: each echoed keystroke arrives as a read of its own.
        let mut a = OutputAnalyzer::new();
        a.process(b"\x1b[1mtest@demo\x1b[0m % ");
        for c in "echo restore-me-please".bytes() {
            a.process(&[c]);
        }
        a.process(b"\r\nrestore-me-");
        a.process(b"please\r\n");
        let out = a.get_stripped_output();
        assert_eq!(
            out,
            "test@demo % echo restore-me-please\nrestore-me-please\n"
        );
    }

    #[test]
    fn the_snapshot_applies_carriage_returns_and_backspaces() {
        let mut a = OutputAnalyzer::new();
        // A typo fixed with backspace, then a progress line redrawn in place.
        a.process(b"$ lss\x08 \x08 -la\r\n");
        a.process(b"10%\r50%\r100%\r\n");
        // A full-screen program's screen is left out.
        a.process(b"\x1b[?1049h");
        a.process(b"vim screen\r\n");
        a.process(b"\x1b[?1049l");
        a.process(b"done");
        assert_eq!(a.get_stripped_output(), "$ ls -la\n100%\ndone\n");
    }

    #[test]
    fn clearing_the_snapshot_output_forgets_earlier_lines_only() {
        let mut a = OutputAnalyzer::new();
        a.process(b"secret line\r\n");
        assert!(a.get_stripped_output().contains("secret line"));
        a.clear_stripped_output();
        assert!(a.get_stripped_output().is_empty());
        a.process(b"after the delete\r\n");
        let out = a.get_stripped_output();
        assert!(out.contains("after the delete") && !out.contains("secret line"));
    }

    /// What the scrollback snapshot shows after these reads.
    fn snapshot_of(reads: &[&[u8]]) -> String {
        let mut s = SnapshotLines::default();
        for r in reads {
            s.feed(r);
        }
        s.text()
    }

    #[test]
    fn the_snapshot_moves_the_cursor_like_the_terminal_does() {
        // Cursor back (D), forward past the end (C pads with spaces) and to
        // a column (G, 1-based), then a character written over.
        assert_eq!(snapshot_of(&[b"abc\x1b[2Dx"]), "axc\n");
        assert_eq!(snapshot_of(&[b"ab\x1b[3Cc"]), "ab   c\n");
        assert_eq!(snapshot_of(&[b"ab\x1b[Cc"]), "ab c\n", "no count is 1");
        assert_eq!(snapshot_of(&[b"abcdef\x1b[3Gx"]), "abxdef\n");
        assert_eq!(snapshot_of(&[b"abc\x1b[Gx"]), "xbc\n", "no column is 1");
        // Back past the start stops at the start.
        assert_eq!(snapshot_of(&[b"ab\x1b[9Dx"]), "xb\n");
    }

    #[test]
    fn the_snapshot_erases_in_line_from_to_or_all_of_the_cursor() {
        assert_eq!(snapshot_of(&[b"abcdef\x1b[3D\x1b[K"]), "abc\n");
        assert_eq!(snapshot_of(&[b"abcdef\x1b[3D\x1b[0K"]), "abc\n");
        assert_eq!(snapshot_of(&[b"abcdef\x1b[3D\x1b[1K"]), "    ef\n");
        assert_eq!(snapshot_of(&[b"abcdef\x1b[3D\x1b[2Kx"]), "   x\n");
    }

    #[test]
    fn the_snapshot_ignores_line_edits_inside_a_full_screen_program_or_with_a_marker() {
        // An erase on the alternate screen does not reach the line below it.
        assert_eq!(
            snapshot_of(&[b"keep me", b"\x1b[?1049h\x1b[2K\x1b[5D", b"\x1b[?1049l"]),
            "keep me\n"
        );
        // A private-marker sequence (`CSI > ... K`) is not an erase.
        assert_eq!(snapshot_of(&[b"keep me\x1b[>2K"]), "keep me\n");
    }

    #[test]
    fn the_snapshot_expands_tabs_to_the_next_multiple_of_eight() {
        assert_eq!(snapshot_of(&[b"a\tb"]), "a       b\n");
        assert_eq!(snapshot_of(&[b"\tb"]), "        b\n");
        assert_eq!(snapshot_of(&[b"12345678\tx"]), "12345678        x\n");
        assert_eq!(snapshot_of(&[b"1234567\tx"]), "1234567 x\n");
        assert_eq!(snapshot_of(&[b"123456789\tx"]), "123456789       x\n");
    }

    #[test]
    fn a_snapshot_line_stops_growing_at_its_limit() {
        let long = vec![b'a'; SnapshotLines::MAX_LINE + 10];
        let text = snapshot_of(&[&long]);
        assert_eq!(text.trim_end().len(), SnapshotLines::MAX_LINE);
        // Overwriting inside the limit still works once the line is full.
        let mut s = SnapshotLines::default();
        s.feed(&long);
        s.feed(b"\rZ");
        assert!(s.text().starts_with("Za"));
        assert_eq!(s.text().trim_end().len(), SnapshotLines::MAX_LINE);
    }

    #[test]
    fn clearing_the_snapshot_inside_a_full_screen_program_keeps_it_out() {
        let mut s = SnapshotLines::default();
        s.feed(b"before\r\n\x1b[?1049h");
        s.clear();
        s.feed(b"full screen\r\n\x1b[?1049lafter\r\n");
        assert_eq!(s.text(), "after\n");
    }

    #[test]
    fn the_snapshot_keeps_its_byte_limit_by_dropping_whole_old_lines() {
        // 100-byte lines (99 + newline): exactly at the limit nothing goes.
        let line = |i: usize| format!("{:099}\n", i);
        let mut s = SnapshotLines::default();
        let count = SnapshotLines::MAX_BYTES / 100;
        for i in 0..count {
            s.feed(line(i).as_bytes());
        }
        assert_eq!(s.text().len(), SnapshotLines::MAX_BYTES);
        assert!(s.text().starts_with(&line(0)));
        // One more line: the cut lands on the start of line 1, and the
        // line the cut is in is dropped whole with everything before it.
        s.feed(line(count).as_bytes());
        let text = s.text();
        assert_eq!(text.len(), SnapshotLines::MAX_BYTES - 100);
        assert!(text.starts_with(&line(2)), "{}", &text[..120]);
        assert!(text.ends_with(&line(count)));
        // Many more lines: never over the limit, newest line kept.
        for i in count + 1..count * 3 {
            s.feed(line(i).as_bytes());
            assert!(s.text().len() <= SnapshotLines::MAX_BYTES);
        }
        assert!(s.text().ends_with(&line(count * 3 - 1)));
        assert!(s.text().len() > SnapshotLines::MAX_BYTES - 200);
    }

    #[test]
    fn the_snapshot_cuts_old_lines_on_a_character_boundary() {
        // A first line of two-byte characters: the cut lands inside one.
        let mut s = SnapshotLines::default();
        let first = format!("{}\n", "é".repeat(3000));
        s.feed(first.as_bytes());
        let line = |i: usize| format!("{:099}\n", i);
        for i in 0..100 {
            s.feed(line(i).as_bytes());
        }
        let text = s.text();
        assert!(text.starts_with(&line(0)), "{}", &text[..40]);
        assert_eq!(text.len(), 100 * 100);
    }

    #[test]
    fn alt_screen_enter_sets_state() {
        let mut s = false;
        OutputAnalyzer::update_alt_screen_state(&mut s, b"\x1b[?1049h");
        assert!(s, "1049h should enter alt screen");
    }

    #[test]
    fn alt_screen_exit_clears_state() {
        let mut s = true;
        OutputAnalyzer::update_alt_screen_state(&mut s, b"some output\x1b[?1049l\r\n");
        assert!(!s, "1049l should leave alt screen");
    }

    #[test]
    fn alt_screen_older_1047_variants_supported() {
        let mut s = false;
        OutputAnalyzer::update_alt_screen_state(&mut s, b"\x1b[?1047h");
        assert!(s);
        OutputAnalyzer::update_alt_screen_state(&mut s, b"\x1b[?1047l");
        assert!(!s);
    }

    #[test]
    fn alt_screen_oldest_47_variants_supported() {
        let mut s = false;
        OutputAnalyzer::update_alt_screen_state(&mut s, b"\x1b[?47h");
        assert!(s);
        OutputAnalyzer::update_alt_screen_state(&mut s, b"\x1b[?47l");
        assert!(!s);
    }

    #[test]
    fn alt_screen_latest_transition_in_chunk_wins() {
        // Enter, exit, re-enter — final state should be "in alt screen".
        let mut s = false;
        let chunk = b"\x1b[?1049h...content...\x1b[?1049l...gap...\x1b[?1049h";
        OutputAnalyzer::update_alt_screen_state(&mut s, chunk);
        assert!(s, "last transition (re-enter) should win");
    }

    #[test]
    fn alt_screen_state_persists_when_chunk_has_no_transitions() {
        let mut s = true;
        OutputAnalyzer::update_alt_screen_state(&mut s, b"plain output, no escapes");
        assert!(s, "unchanged when no toggle present");

        let mut s2 = false;
        OutputAnalyzer::update_alt_screen_state(&mut s2, b"plain output, no escapes");
        assert!(!s2, "unchanged when no toggle present");
    }

    #[test]
    fn alt_screen_process_integration() {
        // End-to-end through process(): receive TUI enter, then receive
        // some content, then receive exit. The flag tracks each transition.
        let mut a = OutputAnalyzer::new();
        assert!(!a.in_alternate_screen);

        a.process(b"\x1b[?1049h\x1b[2J");
        assert!(a.in_alternate_screen, "should be in alt screen after enter");

        a.process(b"some TUI content with cursor moves \x1b[5;10H more text");
        assert!(a.in_alternate_screen, "still in alt screen during TUI");

        a.process(b"\x1b[?1049l");
        assert!(!a.in_alternate_screen, "should have left alt screen");
    }

    #[test]
    fn alt_screen_unrelated_dec_modes_do_not_toggle() {
        // 1049/1047/47 are the alt-screen modes; other DEC private modes
        // (e.g. ?25h hide-cursor, ?2004h bracketed-paste) must NOT affect us.
        let mut s = false;
        OutputAnalyzer::update_alt_screen_state(&mut s, b"\x1b[?25h\x1b[?2004h");
        assert!(!s, "unrelated DEC modes should not enter alt screen");

        let mut s2 = true;
        OutputAnalyzer::update_alt_screen_state(&mut s2, b"\x1b[?25l\x1b[?2004l");
        assert!(s2, "unrelated DEC modes should not leave alt screen");
    }

    // ── OSC 9 / 99 / 777 (terminal notifications, F11) ──────────────

    #[test]
    fn notifications_on_osc_9_99_and_777_are_collected_and_progress_is_not() {
        let mut a = OutputAnalyzer::new();
        a.process(b"\x1b]9;Approval requested: rm -rf node_modules\x07");
        a.process(b"\x1b]9;4;3;\x07\x1b]9;4;0;\x07"); // progress: ignored
        a.process(b"\x1b]99;i=h1:d=0:p=title;fake-agent\x1b\\\x1b]99;i=h1:p=body;Needs your permission\x1b\\\x1b]99;i=h1:d=1:a=focus;\x1b\\");
        a.process(b"\x1b]777;notify;fake-agent;Needs your permission; now\x1b\\");
        let got = a.take_pending_notifications();
        assert_eq!(
            got,
            vec![
                TerminalNotification {
                    osc: 9,
                    title: "".into(),
                    body: "Approval requested: rm -rf node_modules".into()
                },
                TerminalNotification {
                    osc: 99,
                    title: "fake-agent".into(),
                    body: "Needs your permission".into()
                },
                TerminalNotification {
                    osc: 777,
                    title: "fake-agent".into(),
                    body: "Needs your permission; now".into()
                },
            ]
        );
        assert!(a.take_pending_notifications().is_empty(), "taken once");
        // Other OSCs (title, cwd) are not notifications.
        a.process(b"\x1b]2;my title\x07\x1b]7;file://h/x\x07\x1b]777;other;x\x07");
        assert!(a.take_pending_notifications().is_empty());
    }

    #[test]
    fn a_notification_split_across_reads_and_a_kitty_part_split_across_reads_still_arrive() {
        let mut a = OutputAnalyzer::new();
        a.process(b"\x1b]9;Question re");
        assert!(a.take_pending_notifications().is_empty());
        a.process(b"quested\x07");
        assert_eq!(a.take_pending_notifications()[0].body, "Question requested");
        a.process(b"\x1b]99;i=k:d=0:p=title;codex\x1b\\");
        assert!(
            a.take_pending_notifications().is_empty(),
            "more parts to come"
        );
        a.process(b"\x1b]99;i=k:p=body;Agent turn complete\x1b\\");
        let got = a.take_pending_notifications();
        assert_eq!(got.len(), 1);
        assert_eq!(
            (got[0].title.as_str(), got[0].body.as_str()),
            ("codex", "Agent turn complete")
        );
    }

    #[test]
    fn notification_text_is_untrusted_capped_and_stripped() {
        let mut a = OutputAnalyzer::new();
        let mut big = b"\x1b]9;".to_vec();
        big.extend(std::iter::repeat_n(b'A', 5000));
        big.extend(b"\x1b[31mred\x1b\\");
        a.process(&big);
        let got = a.take_pending_notifications();
        assert_eq!(got.len(), 1);
        assert_eq!(
            got[0].body.chars().count(),
            super::super::osc_signals::MAX_NOTIFICATION_CHARS
        );
        assert!(!got[0].body.contains('\x1b'));
        // A program spraying notifications does not grow memory without bound.
        let mut spray = Vec::new();
        for i in 0..500 {
            spray.extend(format!("\x1b]9;n{i}\x07").into_bytes());
        }
        a.process(&spray);
        let got = a.take_pending_notifications();
        assert!(got.len() <= 32, "{}", got.len());
        assert_eq!(got.last().unwrap().body, "n499");
    }

    // ── OSC 7 (working directory reports) ──────────────────────────

    #[cfg(unix)]
    #[test]
    fn osc7_in_one_read_updates_cwd() {
        let mut a = OutputAnalyzer::new();
        a.process(b"\x1b]7;file://host/work/test/project\x07prompt$ ");
        assert_eq!(a.current_cwd.as_deref(), Some("/work/test/project"));
        assert_eq!(a.take_pending_cwd().as_deref(), Some("/work/test/project"));
        assert_eq!(a.take_pending_cwd(), None, "reported once");
    }

    #[cfg(unix)]
    #[test]
    fn osc7_split_across_reads_still_updates_cwd() {
        let mut a = OutputAnalyzer::new();
        a.process(b"output\r\n\x1b]7;file://host/work/te");
        assert_eq!(a.take_pending_cwd(), None, "incomplete report is not used");
        a.process(b"st/split%20dir\x1b\\prompt$ ");
        assert_eq!(
            a.take_pending_cwd().as_deref(),
            Some("/work/test/split dir")
        );
    }

    #[cfg(unix)]
    #[test]
    fn osc7_split_at_every_byte_still_updates_cwd() {
        let report = b"\x1b]7;file://host/tmp/one-byte-at-a-time\x07";
        let mut a = OutputAnalyzer::new();
        for b in report.iter() {
            a.process(std::slice::from_ref(b));
        }
        assert_eq!(
            a.take_pending_cwd().as_deref(),
            Some("/tmp/one-byte-at-a-time")
        );
    }

    #[cfg(unix)]
    #[test]
    fn osc7_last_report_in_a_read_wins_and_semicolons_survive() {
        let mut a = OutputAnalyzer::new();
        a.process(b"\x1b]7;file://h/first\x07\x1b]7;file:///second;part\x07");
        assert_eq!(a.take_pending_cwd().as_deref(), Some("/second;part"));
    }

    #[cfg(unix)]
    #[test]
    fn osc7_root_directory_is_reported() {
        let mut a = OutputAnalyzer::new();
        a.process(b"\x1b]7;file://host/tmp\x07");
        a.take_pending_cwd();
        a.process(b"\x1b]7;file://host/\x07");
        assert_eq!(a.take_pending_cwd().as_deref(), Some("/"));
    }

    #[cfg(unix)]
    #[test]
    fn osc7_long_percent_encoded_path_is_not_truncated() {
        // A deep path near PATH_MAX, with every byte except '/' percent-
        // encoded (as for non-ASCII names), is far longer than 1 KiB. vte
        // caps OSC data at 1 KiB only with its `no_std` feature, which must
        // stay off (`default-features = false` in Cargo.toml).
        let path = format!("/work/{}", "d".repeat(3000));
        let encoded: String = path
            .bytes()
            .map(|b| match b {
                b'/' => "/".to_string(),
                _ => format!("%{:02X}", b),
            })
            .collect();
        let report = format!("\x1b]7;file://host{}\x07", encoded);
        assert!(report.len() > 9000);
        let mut a = OutputAnalyzer::new();
        a.process(report.as_bytes());
        assert_eq!(a.take_pending_cwd().as_deref(), Some(path.as_str()));
    }

    #[cfg(unix)]
    #[test]
    fn stray_osc_start_does_not_hold_unbounded_output() {
        // `printf '\e]'; cat bigfile`: an OSC is opened and never closed.
        let mut a = OutputAnalyzer::new();
        a.process(b"\x1b]");
        let chunk = vec![b'a'; 4096];
        for _ in 0..256 {
            a.process(&chunk);
            assert!(a.osc_open_len <= MAX_OPEN_OSC_BYTES);
        }
        // The analyzer still reads later reports, including split ones.
        a.process(b"\x1b]7;file://host/work/te");
        a.process(b"st/after-stray\x07");
        assert_eq!(
            a.take_pending_cwd().as_deref(),
            Some("/work/test/after-stray")
        );
    }

    #[cfg(unix)]
    #[test]
    fn long_report_split_across_reads_survives_the_open_osc_limit() {
        let path = format!("/work/{}", "d".repeat(4000));
        let encoded: String = path
            .bytes()
            .map(|b| match b {
                b'/' => "/".to_string(),
                _ => format!("%{:02X}", b),
            })
            .collect();
        let report = format!("\x1b]7;file://host{}\x07", encoded);
        let mut a = OutputAnalyzer::new();
        for part in report.as_bytes().chunks(1000) {
            a.process(part);
        }
        assert_eq!(a.take_pending_cwd().as_deref(), Some(path.as_str()));
    }

    #[test]
    fn conemu_cwd_reports_set_the_folder_and_are_never_notifications() {
        // XP-06: PowerShell prompts (Windows Terminal's shell integration)
        // print `OSC 9;9;"<path>"`; it used to read as "asked you".
        let mut a = OutputAnalyzer::new();
        a.process(b"\x1b]9;9;\"C:\\Work\\demo\"\x07PS> ");
        assert_eq!(a.current_cwd.as_deref(), Some(r"C:\Work\demo"));
        a.process(b"\x1b]9;9;/srv/demo\x1b\\");
        assert_eq!(a.current_cwd.as_deref(), Some("/srv/demo"));
        // Other ConEmu commands (prompt marks, titles, progress) say nothing.
        a.process(b"\x1b]9;12\x07\x1b]9;3;title\x07\x1b]9;4;1;50\x07\x1b]9;2;hi\x07");
        assert!(a.take_pending_notifications().is_empty());
        // ...and they never move the folder: only `9;9` reports one.
        assert_eq!(a.current_cwd.as_deref(), Some("/srv/demo"));
        // A plain OSC 9 notification is still one.
        a.process(b"\x1b]9;Build finished\x07");
        let got = a.take_pending_notifications();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].body, "Build finished");
    }

    #[test]
    fn other_osc_sequences_do_not_change_cwd() {
        let mut a = OutputAnalyzer::new();
        a.process(b"\x1b]0;window title /not/a/dir\x07\x1b]8;;file:///x\x07link\x1b]8;;\x07");
        assert_eq!(a.take_pending_cwd(), None);
        assert_eq!(a.current_cwd, None);
    }

    #[test]
    fn osc7_path_parsing() {
        assert_eq!(osc7_path("file://host/a/b").as_deref(), Some("/a/b"));
        assert_eq!(osc7_path("file:///a%2Fb").as_deref(), Some("/a/b"));
        assert_eq!(osc7_path("http://host/a"), None);
        assert_eq!(osc7_path("file://host"), None);
    }
}
