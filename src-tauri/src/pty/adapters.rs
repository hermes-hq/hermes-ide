use crate::pty::models::*;
use crate::pty::patterns::*;

// ─── Analysis Types ─────────────────────────────────────────────────

pub(crate) struct LineAnalysis {
    pub token_update: Option<TokenUpdate>,
    pub tool_call: Option<ToolCall>,
    pub phase_hint: Option<PhaseHint>,
    pub memory_fact: Option<MemoryFact>,
}

pub(crate) struct TokenUpdate {
    pub provider: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: Option<f64>,
    pub is_cumulative: bool,
}

#[derive(Debug)]
pub(crate) enum PhaseHint {
    PromptDetected,
    WorkStarted,
    InputNeeded,
}

// ─── Provider Adapter Trait ─────────────────────────────────────────

pub(crate) trait ProviderAdapter: Send + Sync {
    fn detect_agent(&self, line: &str) -> Option<AgentInfo>;
    fn analyze_line(&self, line: &str) -> LineAnalysis;
    fn is_prompt(&self, line: &str) -> bool;
}

// ─── Utility Functions ──────────────────────────────────────────────

pub(crate) fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub(crate) fn empty_analysis() -> LineAnalysis {
    LineAnalysis {
        token_update: None,
        tool_call: None,
        phase_hint: None,
        memory_fact: None,
    }
}

pub(crate) fn parse_token_count(s: &str) -> u64 {
    let clean = s.replace(',', "");
    if let Some(num) = clean.strip_suffix('K').or_else(|| clean.strip_suffix('k')) {
        (num.parse::<f64>().unwrap_or(0.0) * 1000.0) as u64
    } else if let Some(num) = clean.strip_suffix('M').or_else(|| clean.strip_suffix('m')) {
        (num.parse::<f64>().unwrap_or(0.0) * 1_000_000.0) as u64
    } else if let Some(num) = clean.strip_suffix('B').or_else(|| clean.strip_suffix('b')) {
        (num.parse::<f64>().unwrap_or(0.0) * 1_000_000_000.0) as u64
    } else if let Some(num) = clean.strip_suffix('T').or_else(|| clean.strip_suffix('t')) {
        (num.parse::<f64>().unwrap_or(0.0) * 1_000_000_000_000.0) as u64
    } else {
        clean.parse().unwrap_or(0)
    }
}

pub(crate) fn parse_k_count(s: &str) -> u64 {
    let s = s.to_lowercase();
    if let Some(num) = s.strip_suffix('k') {
        (num.parse::<f64>().unwrap_or(0.0) * 1000.0) as u64
    } else {
        s.parse().unwrap_or(0)
    }
}

pub(crate) fn extract_model_name(line: &str) -> Option<String> {
    let lower = line.to_lowercase();
    // Claude models
    if lower.contains("opus 4") {
        return Some("opus".into());
    }
    if lower.contains("opus") {
        return Some("opus".into());
    }
    if lower.contains("sonnet 4") {
        return Some("sonnet".into());
    }
    if lower.contains("sonnet") {
        return Some("sonnet".into());
    }
    if lower.contains("haiku") {
        return Some("haiku".into());
    }
    // OpenAI / Codex models
    if lower.contains("codex") && lower.contains("gpt-5") {
        return Some("gpt-5-codex".into());
    }
    if lower.contains("gpt-5") {
        return Some("gpt-5".into());
    }
    if lower.contains("gpt-4o") {
        return Some("gpt-4o".into());
    }
    if lower.contains("gpt-4") {
        return Some("gpt-4".into());
    }
    if (lower.contains(" o1") || lower.contains("-o1") || lower.starts_with("o1"))
        && !lower.contains("v0.1")
        && !lower.contains("v0.0")
    {
        return Some("o1".into());
    }
    if lower.contains(" o3") || lower.contains("-o3") || lower.starts_with("o3") {
        return Some("o3".into());
    }
    if lower.contains(" o4") || lower.contains("-o4") || lower.starts_with("o4") {
        return Some("o4".into());
    }
    // Google models
    if lower.contains("gemini-4") && lower.contains("argon") {
        return Some("gemini-4-argon".into());
    }
    if lower.contains("gemini-3") && lower.contains("pro") {
        return Some("gemini-3-pro".into());
    }
    if lower.contains("gemini-3") && lower.contains("flash") {
        return Some("gemini-3-flash".into());
    }
    if lower.contains("gemini") && lower.contains("pro") {
        return Some("gemini-pro".into());
    }
    if lower.contains("gemini") && lower.contains("flash-lite") {
        return Some("gemini-flash-lite".into());
    }
    if lower.contains("gemini") && lower.contains("flash") {
        return Some("gemini-flash".into());
    }
    // Deepseek (used in Aider)
    if lower.contains("deepseek-r1") {
        return Some("deepseek-r1".into());
    }
    if lower.contains("deepseek") {
        return Some("deepseek".into());
    }
    None
}

/// The vendor of a model as `extract_model_name` names it.
fn model_vendor(model: &str) -> Option<&'static str> {
    if ["opus", "sonnet", "haiku"]
        .iter()
        .any(|m| model.starts_with(m))
    {
        Some("anthropic")
    } else if model.starts_with("gpt-") || ["o1", "o3", "o4"].contains(&model) {
        Some("openai")
    } else if model.starts_with("gemini") {
        Some("google")
    } else {
        None
    }
}

/// Whether an agent of `provider` can be running `model`. Claude Code,
/// Codex and Gemini CLI run their own vendor's models only, so another
/// vendor's model named in their output (an answer about Gemini) is never
/// theirs; multi-vendor agents take any.
pub(crate) fn model_fits_provider(provider: &str, model: &str) -> bool {
    match provider {
        "anthropic" | "openai" | "google" => model_vendor(model).is_none_or(|v| v == provider),
        _ => true,
    }
}

pub(crate) fn estimate_cost(provider: &str, model: &str, input: u64, output: u64) -> f64 {
    let (in_price, out_price) = match (provider, model) {
        ("anthropic", m) if m.contains("opus") => (15.0, 75.0),
        ("anthropic", m) if m.contains("sonnet") => (3.0, 15.0),
        ("anthropic", m) if m.contains("haiku") => (0.25, 1.25),
        ("openai", m) if m.contains("gpt-4o") => (2.5, 10.0),
        ("openai", m) if m.contains("gpt-4") => (30.0, 60.0),
        ("openai", m) if m.contains("o1") => (15.0, 60.0),
        ("google", m) if m.contains("argon") => {
            gemini_4_argon_price(chrono::Utc::now().date_naive())
        }
        ("google", m) if m.contains("pro") => (1.25, 5.0),
        ("google", m) if m.contains("flash") => (0.075, 0.30),
        _ => (3.0, 15.0),
    };
    (input as f64 / 1_000_000.0) * in_price + (output as f64 / 1_000_000.0) * out_price
}

/// Gemini 4 Argon's price per million tokens (input, output): the launch
/// price holds through 2026-11-30, then it doubles.
fn gemini_4_argon_price(today: chrono::NaiveDate) -> (f64, f64) {
    let launch_price_ends = chrono::NaiveDate::from_ymd_opt(2026, 11, 30).expect("a valid date");
    if today <= launch_price_ends {
        (2.0, 10.0)
    } else {
        (4.0, 20.0)
    }
}

pub(crate) fn extract_between(text: &str, start: &str, end: &str) -> Option<String> {
    // Use case-insensitive search on the original text to avoid byte offset
    // mismatch between lowercased and original strings (to_lowercase can change
    // byte lengths for certain Unicode characters like ß → ss).
    let lower = text.to_lowercase();
    let start_lower = start.to_lowercase();
    let end_lower = end.to_lowercase();
    let s = lower.find(&start_lower)?;
    let after = s + start_lower.len();
    let e = lower[after..].find(&end_lower)?;
    // Byte offsets from `lower` may not be valid for `text` if to_lowercase
    // changed byte lengths. Validate boundaries before slicing.
    if after > text.len()
        || after + e > text.len()
        || !text.is_char_boundary(after)
        || !text.is_char_boundary(after + e)
    {
        return None;
    }
    Some(text[after..after + e].trim().to_string())
}

pub(crate) fn extract_port(line: &str) -> Option<String> {
    PORT_RE
        .captures(&line.to_lowercase())
        .map(|c| c[1].to_string())
}

/// Detects common shell prompts across zsh, bash, fish, starship, oh-my-zsh, etc.
pub(crate) fn is_shell_prompt(trimmed: &str) -> bool {
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
    if trimmed.len() < 80
        && (trimmed.ends_with('$') || trimmed.ends_with('%') || trimmed.ends_with('#'))
        && (trimmed.contains('@')
            || trimmed.contains(':')
            || trimmed.contains('~')
            || trimmed.contains('/'))
    {
        return true;
    }

    // Custom prompt characters used by starship, oh-my-zsh, powerlevel10k, etc.
    // These are common prompt indicator characters:
    // → ❯ ➜ ▶ ╰─ λ ➤ ⟩ ⟫ ›
    let custom_prompt_chars = ['→', '❯', '➜', '▶', 'λ', '➤', '⟩', '⟫', '›'];

    // Check if line contains a prompt char near the end OR near the start.
    // Many themes (oh-my-zsh robbyrussell, powerlevel10k) put the indicator
    // at the beginning of the line (e.g. "➜  dirname git:(branch)"), while
    // others (starship, pure) put it at the end (e.g. "dirname ❯").
    let last_chars: String = trimmed.chars().rev().take(5).collect();
    let first_chars: String = trimmed.chars().take(3).collect();
    for ch in &custom_prompt_chars {
        if last_chars.contains(*ch) || first_chars.contains(*ch) {
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

/// Detects whether a line is an interactive confirmation/permission prompt
/// that requires user input (Y/n, allow/deny, etc.).
pub(crate) fn is_input_needed_line(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }
    let lower = trimmed.to_lowercase();

    // ── Interactive menu indicators (strongest signal) ──────────────
    // Numbered option lists: "› 1. Yes", "  2. No", "  3. Allow..."
    // Selection cursors: "›", "❯" at start of a short option line
    if (trimmed.starts_with("› ") || trimmed.starts_with("❯ ")) && trimmed.len() < 100 {
        return true;
    }
    // "Esc to cancel" / "Tab to amend" — interactive UI footer
    if lower.contains("esc to cancel") || lower.contains("tab to amend") {
        return true;
    }

    // ── Common patterns: (Y/n), (y/N), (y/n), [Y/n], [y/N], Yes/No ──
    if lower.contains("(y/n)")
        || lower.contains("(y/n)")
        || lower.contains("[y/n]")
        || lower.contains("[y/n]")
        || lower.contains("(yes/no)")
        || lower.contains("[yes/no]")
    {
        return true;
    }

    // ── Claude Code permission prompts: "? Allow ..." ──────────────
    // Skip help hints like "? for shortcuts"
    if trimmed.starts_with("? ") && trimmed.len() > 3 {
        let rest = &trimmed[2..];
        let first_word = rest.split_whitespace().next().unwrap_or("");
        let first_lower = first_word.to_lowercase();
        if first_lower == "allow"
            || first_lower == "deny"
            || first_lower == "approve"
            || first_lower == "do"
            || first_lower == "are"
            || first_lower == "should"
            || first_lower == "would"
            || first_lower == "can"
            || first_lower == "may"
            || rest.ends_with('?')
            || rest.contains("(y/n)")
            || rest.contains("(Y/n)")
            || rest.contains("[y/N]")
        {
            return true;
        }
    }

    // ── Questions ending with "?" starting with question words ──────
    if trimmed.ends_with('?') && trimmed.len() > 5 && trimmed.len() < 120 {
        let first_word = lower.split_whitespace().next().unwrap_or("");
        if first_word == "do"
            || first_word == "are"
            || first_word == "should"
            || first_word == "would"
            || first_word == "can"
            || first_word == "may"
            || first_word == "will"
            || first_word == "is"
            || first_word == "shall"
        {
            return true;
        }
    }

    // ── Generic "allow" / "deny" / "approve" with question indicators ──
    let has_action_word = lower
        .split(|c: char| !c.is_alphabetic())
        .any(|w| w == "allow" || w == "deny" || w == "approve");
    if has_action_word
        && (trimmed.ends_with('?')
            || lower.contains("(y")
            || lower.contains("[y")
            || lower.contains("(n")
            || lower.contains("[n"))
        && trimmed.len() < 120
    {
        return true;
    }

    false
}

// ─── Claude Code Adapter ────────────────────────────────────────────

pub(crate) struct ClaudeCodeAdapter;

impl ProviderAdapter for ClaudeCodeAdapter {
    fn detect_agent(&self, line: &str) -> Option<AgentInfo> {
        let lower = line.to_lowercase();
        if lower.contains("claude code")
            || lower.contains("claude-code")
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

        // Token detection — try specific patterns only (no generic dollar-amount fallback
        // to avoid false positives from code output like "$500.00")
        // Skip long lines (>200 chars) — likely code output, not status bar
        if line.len() <= 200 {
            if let Some(caps) = CLAUDE_TOKEN_RE.captures(line) {
                let input = parse_token_count(&caps[1]);
                let output = parse_token_count(&caps[2]);
                // Only trust explicit cost patterns — never DOLLAR_AMOUNT_RE
                let cost = SESSION_COST_RE
                    .captures(line)
                    .or_else(|| CLAUDE_COST_RE.captures(line))
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
                // Only trust explicit cost patterns on the same line
                let cost = SESSION_COST_RE
                    .captures(line)
                    .or_else(|| CLAUDE_COST_RE.captures(line))
                    .and_then(|c| c[1].parse().ok());
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
            }
            // Removed CLAUDE_TOKEN_TOTAL_RE — too greedy, matches "token: 1234" in any context
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
                args: if args.is_empty() {
                    "(...)".into()
                } else {
                    args
                },
                timestamp: now_str.clone(),
            });
            result.phase_hint = Some(PhaseHint::WorkStarted);
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
        } else if lower.contains("test framework")
            || (lower.contains("using") && lower.contains("for testing"))
        {
            if let Some(tf) = extract_between(line, "using ", " for") {
                result.memory_fact = Some(MemoryFact {
                    key: "test_framework".into(),
                    value: tf,
                    source: "agent_output".into(),
                    confidence: 0.7,
                });
            }
        }

        // Input-needed detection (must come before prompt detection to take priority)
        if is_input_needed_line(line) {
            result.phase_hint = Some(PhaseHint::InputNeeded);
        }
        // Prompt detection
        else if self.is_prompt(line) {
            result.phase_hint = Some(PhaseHint::PromptDetected);
        }

        result
    }

    fn is_prompt(&self, line: &str) -> bool {
        let trimmed = line.trim();
        // Claude Code specific prompts: match lines like "claude>" or "project >" but
        // reject HTML tags, arrows (->), comparison operators, and general code output.
        if trimmed.ends_with(">")
            && trimmed.len() < 40
            && !trimmed.contains('<')
            && !trimmed.contains("->")
            && !trimmed.contains("=>")
            && !trimmed.contains(">>")
        {
            // Must look prompt-like: either a bare ">" or have a word-like prefix
            // (not just a number like "0>" or punctuation)
            let prefix = trimmed[..trimmed.len() - 1].trim();
            if prefix.is_empty()
                || prefix.chars().all(|c| {
                    c.is_alphanumeric()
                        || c == '_'
                        || c == ' '
                        || c == '-'
                        || c == ':'
                        || c == '/'
                        || c == '~'
                })
            {
                return true;
            }
        }
        is_shell_prompt(trimmed)
    }
}

// ─── Aider Adapter ──────────────────────────────────────────────────

pub(crate) struct AiderAdapter;

impl ProviderAdapter for AiderAdapter {
    fn detect_agent(&self, line: &str) -> Option<AgentInfo> {
        let lower = line.to_lowercase();
        // "Aider v0.86.0" or "aider" at start of line
        if let Some(_caps) = AIDER_VERSION_RE.captures(line) {
            let provider = if lower.contains("claude") || lower.contains("anthropic") {
                "anthropic"
            } else if lower.contains("gpt") || lower.contains("openai") {
                "openai"
            } else if lower.contains("deepseek") {
                "deepseek"
            } else if lower.contains("gemini") {
                "google"
            } else {
                "unknown"
            };
            return Some(AgentInfo {
                name: "Aider".into(),
                provider: provider.into(),
                model: extract_model_name(line),
                detected_at: now(),
                confidence: 0.95,
            });
        }
        if lower.contains("aider")
            && (lower.contains("v0.") || lower.contains("v1.") || lower.starts_with("aider"))
        {
            let provider = if lower.contains("claude") || lower.contains("anthropic") {
                "anthropic"
            } else if lower.contains("gpt") || lower.contains("openai") {
                "openai"
            } else if lower.contains("deepseek") {
                "deepseek"
            } else if lower.contains("gemini") {
                "google"
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

        // Token tracking — full pattern: "Tokens: 22k sent, 21k cache write, 2.4k received."
        if let Some(caps) = AIDER_FULL_TOKEN_RE.captures(line) {
            let sent = parse_k_count(&caps[1]);
            let received = parse_k_count(&caps[4]);
            // Cost on same line or next: "Cost: $0.12 message, $0.67 session."
            let cost = AIDER_COST_RE
                .captures(line)
                .and_then(|c| c[2].parse::<f64>().ok());
            result.token_update = Some(TokenUpdate {
                provider: "unknown".into(),
                model: "unknown".into(),
                input_tokens: sent,
                output_tokens: received,
                cost_usd: cost,
                is_cumulative: cost.is_some(), // session cost is cumulative
            });
        }
        // Fallback: simpler token pattern
        else if let Some(caps) = AIDER_TOKEN_RE.captures(line) {
            let cost = AIDER_COST_RE
                .captures(line)
                .and_then(|c| c[2].parse::<f64>().ok());
            result.token_update = Some(TokenUpdate {
                provider: "unknown".into(),
                model: "unknown".into(),
                input_tokens: parse_k_count(&caps[1]),
                output_tokens: parse_k_count(&caps[2]),
                cost_usd: cost,
                is_cumulative: cost.is_some(),
            });
        }
        // Cost-only line: "Cost: $0.12 message, $0.67 session."
        else if let Some(caps) = AIDER_COST_RE.captures(line) {
            if let Ok(session_cost) = caps[2].parse::<f64>() {
                result.token_update = Some(TokenUpdate {
                    provider: "unknown".into(),
                    model: "unknown".into(),
                    input_tokens: 0,
                    output_tokens: 0,
                    cost_usd: Some(session_cost),
                    is_cumulative: true,
                });
            }
        }

        // Model detection from startup banner
        if let Some(caps) = AIDER_MODEL_RE.captures(line) {
            let model_name = caps[1].trim().to_string();
            if result.token_update.is_none() {
                // Store model info — detected from "Main model:" or "Model:" line
                if let Some(model) = extract_model_name(&model_name) {
                    result.memory_fact = Some(MemoryFact {
                        key: "model".into(),
                        value: model,
                        source: "agent_output".into(),
                        confidence: 0.9,
                    });
                }
            }
        }

        // File edit detection: "Applied edit to src/main.py"
        if let Some(caps) = AIDER_EDIT_RE.captures(line) {
            result.tool_call = Some(ToolCall {
                tool: "Edit".into(),
                args: caps[1].to_string(),
                timestamp: now_str.clone(),
            });
            result.phase_hint = Some(PhaseHint::WorkStarted);
        }
        // Git commit detection: "Commit 414c394 feat: something"
        else if let Some(caps) = AIDER_COMMIT_RE.captures(line) {
            result.tool_call = Some(ToolCall {
                tool: "Git Commit".into(),
                args: format!("{} {}", &caps[1], &caps[2]),
                timestamp: now_str.clone(),
            });
        }
        // File creation: "Creating empty file app.py"
        else if line.starts_with("Creating empty file ") {
            let file = line.trim_start_matches("Creating empty file ").trim();
            result.tool_call = Some(ToolCall {
                tool: "Create".into(),
                args: file.to_string(),
                timestamp: now_str.clone(),
            });
            result.phase_hint = Some(PhaseHint::WorkStarted);
        }
        // Shell command: "Running: cmd" or "$ cmd"
        else {
            let lower = line.to_lowercase();
            if lower.starts_with("running:") || (line.starts_with("$ ") && line.len() > 2) {
                let cmd = if lower.starts_with("running:") {
                    line[8..].trim()
                } else {
                    &line[2..]
                };
                result.tool_call = Some(ToolCall {
                    tool: "Bash".into(),
                    args: cmd.to_string(),
                    timestamp: now_str.clone(),
                });
                result.phase_hint = Some(PhaseHint::WorkStarted);
            }
        }

        // Added/removed file from chat (use byte offsets to avoid case-sensitivity issues)
        let lower = line.to_lowercase();
        if lower.starts_with("added ") && lower.contains(" to the chat") {
            let file = line["added ".len()..]
                .split(" to the chat")
                .next()
                .unwrap_or("")
                .trim();
            if !file.is_empty() {
                result.tool_call = Some(ToolCall {
                    tool: "Add File".into(),
                    args: file.to_string(),
                    timestamp: now_str.clone(),
                });
            }
        } else if lower.starts_with("removed ") && lower.contains(" from the chat") {
            let file = line["removed ".len()..]
                .split(" from the chat")
                .next()
                .unwrap_or("")
                .trim();
            if !file.is_empty() {
                result.tool_call = Some(ToolCall {
                    tool: "Drop File".into(),
                    args: file.to_string(),
                    timestamp: now_str.clone(),
                });
            }
        }

        // Input-needed detection (before prompt detection)
        if is_input_needed_line(line) {
            result.phase_hint = Some(PhaseHint::InputNeeded);
        }
        // Prompt detection
        else if self.is_prompt(line) {
            result.phase_hint = Some(PhaseHint::PromptDetected);
        }

        result
    }

    fn is_prompt(&self, line: &str) -> bool {
        let trimmed = line.trim();
        // Aider prompts: "> ", "ask> ", "architect> ", "diff> ", "diff multi> ", etc.
        if AIDER_PROMPT_RE.is_match(trimmed) {
            return true;
        }
        is_shell_prompt(trimmed)
    }
}

// ─── Copilot CLI Adapter ────────────────────────────────────────────

pub(crate) struct CopilotAdapter;

impl ProviderAdapter for CopilotAdapter {
    fn detect_agent(&self, line: &str) -> Option<AgentInfo> {
        let lower = line.to_lowercase();
        // "GitHub Copilot", "gh copilot", "copilot cli", or copilot coding agent
        if lower.contains("github copilot") || lower.contains("gh copilot") {
            Some(AgentInfo {
                name: "Copilot CLI".into(),
                provider: "github".into(),
                model: None,
                detected_at: now(),
                confidence: 0.9,
            })
        } else if lower.contains("copilot")
            && (lower.contains("cli") || lower.contains("agent") || lower.contains("coding"))
        {
            Some(AgentInfo {
                name: "Copilot CLI".into(),
                provider: "github".into(),
                model: None,
                detected_at: now(),
                confidence: 0.8,
            })
        } else {
            None
        }
    }

    fn analyze_line(&self, line: &str) -> LineAnalysis {
        let mut result = empty_analysis();

        // Input-needed: selection prompts or confirmation prompts
        if (line.starts_with("? ") && line.len() < 100) || is_input_needed_line(line) {
            result.phase_hint = Some(PhaseHint::InputNeeded);
        }
        // Regular prompt detection
        else if self.is_prompt(line) {
            result.phase_hint = Some(PhaseHint::PromptDetected);
        }

        result
    }

    fn is_prompt(&self, line: &str) -> bool {
        let t = line.trim();
        // Copilot interactive prompts start with "?" or "> "
        if t.starts_with("? ") || t.starts_with("> ") {
            return true;
        }
        is_shell_prompt(t)
    }
}

// ─── Codex CLI Adapter ──────────────────────────────────────────────

pub(crate) struct CodexAdapter;

impl ProviderAdapter for CodexAdapter {
    fn detect_agent(&self, line: &str) -> Option<AgentInfo> {
        // ">_ OpenAI Codex (v0.98.0)" or "OpenAI Codex v0.98.0"
        if let Some(_caps) = CODEX_VERSION_RE.captures(line) {
            return Some(AgentInfo {
                name: "Codex CLI".into(),
                provider: "openai".into(),
                model: extract_model_name(line),
                detected_at: now(),
                confidence: 0.95,
            });
        }
        let lower = line.to_lowercase();
        if lower.contains("codex") && (lower.contains("openai") || lower.contains("cli")) {
            Some(AgentInfo {
                name: "Codex CLI".into(),
                provider: "openai".into(),
                model: extract_model_name(line),
                detected_at: now(),
                confidence: 0.85,
            })
        } else {
            None
        }
    }

    fn analyze_line(&self, line: &str) -> LineAnalysis {
        let mut result = empty_analysis();
        let now_str = now();

        // Token tracking: "Token usage:  1.9K total  (1K input + 900 output)"
        if let Some(caps) = CODEX_TOKEN_RE.captures(line) {
            let input = parse_token_count(&caps[2]);
            let output = parse_token_count(&caps[3]);
            result.token_update = Some(TokenUpdate {
                provider: "openai".into(),
                model: "unknown".into(),
                input_tokens: input,
                output_tokens: output,
                cost_usd: None, // Codex CLI doesn't report costs
                is_cumulative: true,
            });
        }

        // Shell command: "• Running echo hello" or "• Ran echo hello"
        if let Some(caps) = CODEX_TOOL_RUN_RE.captures(line) {
            let cmd = caps[1].to_string();
            let is_running = line.contains("Running");
            result.tool_call = Some(ToolCall {
                tool: "Bash".into(),
                args: cmd,
                timestamp: now_str.clone(),
            });
            if is_running {
                result.phase_hint = Some(PhaseHint::WorkStarted);
            }
        }
        // File operations: "• Edited example.txt (+1 -1)" etc.
        else if let Some(caps) = CODEX_FILE_OP_RE.captures(line) {
            let op = &caps[1];
            let file = caps[2].to_string();
            let tool = match op {
                "Added" => "Create",
                "Edited" => "Edit",
                "Deleted" => "Delete",
                _ => "File",
            };
            result.tool_call = Some(ToolCall {
                tool: tool.into(),
                args: file,
                timestamp: now_str.clone(),
            });
            result.phase_hint = Some(PhaseHint::WorkStarted);
        }
        // Exploring: "• Exploring" or "• Explored"
        else if CODEX_EXPLORE_RE.is_match(line) {
            result.tool_call = Some(ToolCall {
                tool: "Explore".into(),
                args: "(files)".into(),
                timestamp: now_str.clone(),
            });
        }
        // MCP tool calls: "• Calling server.tool(...)" or "• Called server.tool(...)"
        else if let Some(caps) = CODEX_MCP_RE.captures(line) {
            result.tool_call = Some(ToolCall {
                tool: caps[1].to_string(),
                args: caps[2].to_string(),
                timestamp: now_str.clone(),
            });
            if line.contains("Calling") {
                result.phase_hint = Some(PhaseHint::WorkStarted);
            }
        }

        // Model detection from /status or exec mode: "Model: gpt-5.1-codex-max" or "model: gpt-5.3-codex"
        if let Some(caps) = CODEX_MODEL_RE.captures(line) {
            let model_name = caps[1].trim().to_string();
            if result.memory_fact.is_none() {
                if let Some(model) = extract_model_name(&model_name) {
                    result.memory_fact = Some(MemoryFact {
                        key: "model".into(),
                        value: model,
                        source: "agent_output".into(),
                        confidence: 0.9,
                    });
                }
            }
        }

        // Input-needed detection (before prompt detection)
        if is_input_needed_line(line) {
            result.phase_hint = Some(PhaseHint::InputNeeded);
        }
        // Prompt detection
        else if self.is_prompt(line) {
            result.phase_hint = Some(PhaseHint::PromptDetected);
        }

        result
    }

    fn is_prompt(&self, line: &str) -> bool {
        let t = line.trim();
        // Codex TUI prompt: "> " with placeholder text or bare
        if t == ">" || t == "> " {
            return true;
        }
        // "Ask Codex to do anything" is the placeholder
        if t.contains("Ask Codex to do anything") {
            return true;
        }
        is_shell_prompt(t)
    }
}

// ─── Gemini Adapter ─────────────────────────────────────────────────

pub(crate) struct GeminiAdapter;

impl ProviderAdapter for GeminiAdapter {
    fn detect_agent(&self, line: &str) -> Option<AgentInfo> {
        let lower = line.to_lowercase();
        // Detect ASCII art banner with "GEMINI" block letters or "gemini cli" text
        if (lower.contains("gemini") && (lower.contains("cli") || lower.contains("code")))
            || lower.contains("g e m i n i")
            || (lower.contains("███") && lower.contains("gemini"))
        {
            Some(AgentInfo {
                name: "Gemini CLI".into(),
                provider: "google".into(),
                model: extract_model_name(line),
                detected_at: now(),
                confidence: 0.85,
            })
        } else {
            None
        }
    }

    fn analyze_line(&self, line: &str) -> LineAnalysis {
        let mut result = empty_analysis();
        let now_str = now();

        // Token tracking from /stats model usage table rows:
        // "gemini-2.5-pro  10  500  500  2,000"
        if let Some(caps) = GEMINI_STATS_ROW_RE.captures(line) {
            let model = caps[1].to_string();
            let input = parse_token_count(&caps[3].replace(',', ""));
            let cached = parse_token_count(&caps[4].replace(',', ""));
            let output = parse_token_count(&caps[5].replace(',', ""));
            result.token_update = Some(TokenUpdate {
                provider: "google".into(),
                model,
                input_tokens: input + cached,
                output_tokens: output,
                cost_usd: None, // Gemini CLI doesn't report costs
                is_cumulative: true,
            });
        }

        // Tool call detection: "✓ ReadFile /path" "? Shell git status" "x Edit file"
        if let Some(caps) = GEMINI_TOOL_RE.captures(line) {
            let tool_name = caps[1].to_string();
            let args = line[caps[0].len()..].trim().to_string();
            result.tool_call = Some(ToolCall {
                tool: tool_name,
                args: if args.is_empty() {
                    "(...)".into()
                } else {
                    args
                },
                timestamp: now_str.clone(),
            });
            result.phase_hint = Some(PhaseHint::WorkStarted);
        }

        // Memory fact extraction (same patterns as Claude — shared output)
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
        }

        // Input-needed detection (before prompt detection)
        if is_input_needed_line(line) {
            result.phase_hint = Some(PhaseHint::InputNeeded);
        }
        // Prompt detection
        else if self.is_prompt(line) {
            result.phase_hint = Some(PhaseHint::PromptDetected);
        }

        result
    }

    fn is_prompt(&self, line: &str) -> bool {
        let t = line.trim();
        // Gemini CLI prompts: single char ">", "!", "*" with or without trailing space
        // Normal: ">" / "> ", Shell: "!" / "! ", YOLO: "*" / "* "
        if t.len() <= 3 && (t == ">" || t == "!" || t == "*" || t == "> " || t == "! " || t == "* ")
        {
            return true;
        }
        is_shell_prompt(t)
    }
}

// ─── Kiro CLI Adapter ───────────────────────────────────────────────

pub(crate) struct KiroAdapter;

impl ProviderAdapter for KiroAdapter {
    fn detect_agent(&self, line: &str) -> Option<AgentInfo> {
        let lower = line.to_lowercase();
        // "kiro-cli" or "Kiro CLI" in output (startup banner, help text, etc.)
        if lower.contains("kiro-cli") || lower.contains("kiro cli") {
            return Some(AgentInfo {
                name: "Kiro CLI".into(),
                provider: "kiro".into(),
                model: extract_model_name(line),
                detected_at: now(),
                confidence: 0.95,
            });
        }
        // Broader match: "kiro" with contextual keywords
        if lower.contains("kiro")
            && (lower.contains("agent")
                || lower.contains("chat")
                || lower.contains("spec")
                || lower.contains("version"))
        {
            return Some(AgentInfo {
                name: "Kiro CLI".into(),
                provider: "kiro".into(),
                model: extract_model_name(line),
                detected_at: now(),
                confidence: 0.8,
            });
        }
        None
    }

    fn analyze_line(&self, line: &str) -> LineAnalysis {
        let mut result = empty_analysis();
        let now_str = now();

        // Tool call detection: "✓ read /path" or "? shell git status"
        if let Some(caps) = KIRO_TOOL_RE.captures(line) {
            let tool = caps[1].to_string();
            let args = line[caps.get(1).unwrap().end()..].trim().to_string();
            result.tool_call = Some(ToolCall {
                tool: tool.clone(),
                args,
                timestamp: now_str.clone(),
            });
            result.phase_hint = Some(PhaseHint::WorkStarted);
        }

        // Input-needed detection
        if is_input_needed_line(line) {
            result.phase_hint = Some(PhaseHint::InputNeeded);
        } else if self.is_prompt(line) {
            result.phase_hint = Some(PhaseHint::PromptDetected);
        }

        result
    }

    fn is_prompt(&self, line: &str) -> bool {
        let t = line.trim();
        // Kiro prompt is "> " at the start of a line
        if t == ">" || (t.starts_with("> ") && t.len() < 5) {
            return true;
        }
        is_shell_prompt(t)
    }
}

// ─── Provider Registry ──────────────────────────────────────────────

pub(crate) struct ProviderRegistry {
    pub adapters: Vec<Box<dyn ProviderAdapter>>,
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self {
            adapters: vec![
                Box::new(ClaudeCodeAdapter),
                Box::new(AiderAdapter),
                Box::new(CopilotAdapter),
                Box::new(CodexAdapter),
                Box::new(GeminiAdapter),
                Box::new(KiroAdapter),
            ],
        }
    }

    pub fn detect_agent(&self, line: &str) -> Option<(usize, AgentInfo)> {
        let mut best: Option<(usize, AgentInfo)> = None;
        for (i, adapter) in self.adapters.iter().enumerate() {
            if let Some(sig) = adapter.detect_agent(line) {
                if best
                    .as_ref()
                    .is_none_or(|(_, b)| sig.confidence > b.confidence)
                {
                    best = Some((i, sig));
                }
            }
        }
        best
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gemini_4_argon_is_named_and_priced_at_its_own_rate() {
        assert_eq!(
            extract_model_name("Model: gemini-4-argon").as_deref(),
            Some("gemini-4-argon")
        );
        let day = |m, d| chrono::NaiveDate::from_ymd_opt(2026, m, d).unwrap();
        assert_eq!(gemini_4_argon_price(day(10, 13)), (2.0, 10.0));
        assert_eq!(gemini_4_argon_price(day(11, 30)), (2.0, 10.0));
        assert_eq!(gemini_4_argon_price(day(12, 1)), (4.0, 20.0));
        // Not the catch-all $3 / $15.
        let cost = estimate_cost("google", "gemini-4-argon", 1_000_000, 1_000_000);
        assert!(cost == 12.0 || cost == 24.0, "Argon priced at {cost}");
    }

    #[test]
    fn a_gemini_cli_stats_row_for_argon_is_a_google_token_update() {
        let a = GeminiAdapter.analyze_line("gemini-4-argon  3  1,200  0  800");
        let tu = a.token_update.expect("a token update");
        assert_eq!(
            (tu.provider.as_str(), tu.model.as_str()),
            ("google", "gemini-4-argon")
        );
        assert_eq!((tu.input_tokens, tu.output_tokens), (1_200, 800));
    }
}
