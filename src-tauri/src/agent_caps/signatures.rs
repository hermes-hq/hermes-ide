//! How a CLI says it refused a launch: the catalog's `error_signatures`
//! (regular expressions from the capability matrix) matched against the
//! terminal output of the launch's first seconds.
//!
//! Terminal output is not text: colours, cursor moves and redraws sit
//! between the words. `output_lines` strips every escape sequence, turns
//! cursor moves and carriage returns into line breaks, and trims the
//! decoration a TUI puts before a line (box drawing, bullets, "■", "⎿"), so
//! a `^Not logged in` still finds `  ⎿  Not logged in · Please run /login`.

use std::sync::OnceLock;

use crate::agent_catalog::ErrorSignature;
use crate::contract::{RejectReason, RejectSuggestion};

/// Longest vendor message kept (the line that matched, trimmed).
pub const MAX_VENDOR_MESSAGE: usize = 600;

/// A refused launch, as the CLI said it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejection {
    pub reason: RejectReason,
    pub suggestion: RejectSuggestion,
    /// The CLI's line, verbatim (escape sequences removed).
    pub vendor_message: String,
    /// What the pattern's first group caught (the model, the effort), if any.
    pub captured: Option<String>,
}

pub fn reason_of(s: &str) -> RejectReason {
    match s {
        "model" => RejectReason::Model,
        "effort" => RejectReason::Effort,
        "signed_out" => RejectReason::SignedOut,
        _ => RejectReason::Other,
    }
}

pub fn suggestion_of(s: &str) -> RejectSuggestion {
    match s {
        "switch-account" => RejectSuggestion::SwitchAccount,
        "sign-in" => RejectSuggestion::SignIn,
        _ => RejectSuggestion::RetryDefault,
    }
}

/// Terminal output as plain lines: escape sequences removed, a cursor move
/// or a carriage return starts a new line, leading decoration trimmed.
pub fn output_lines(text: &str) -> Vec<String> {
    let mut plain = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => match chars.next() {
                Some('[') => {
                    let mut last = '\0';
                    for n in chars.by_ref() {
                        if ('\x40'..='\x7e').contains(&n) {
                            last = n;
                            break;
                        }
                    }
                    // Cursor position / movement / erase: a new visual line.
                    if matches!(last, 'H' | 'f' | 'A' | 'B' | 'E' | 'F' | 'G' | 'd' | 'J') {
                        plain.push('\n');
                    } else if last == 'C' {
                        plain.push(' ');
                    }
                }
                Some(']') | Some('P') | Some('_') | Some('^') => {
                    while let Some(n) = chars.next() {
                        if n == '\x07' {
                            break;
                        }
                        if n == '\x1b' {
                            chars.next();
                            break;
                        }
                    }
                }
                Some('(') | Some(')') | Some('*') | Some('+') => {
                    chars.next();
                }
                _ => {}
            },
            '\r' | '\n' => plain.push('\n'),
            '\t' => plain.push(' '),
            c if c.is_control() => {}
            c => plain.push(c),
        }
    }
    plain
        .split('\n')
        .map(|l| {
            l.trim_start_matches(|c: char| {
                c.is_whitespace() || !c.is_ascii() || matches!(c, '>' | '|' | '*' | '-' | '+' | '#')
            })
            .trim_end()
            .to_string()
        })
        .filter(|l| !l.is_empty())
        .collect()
}

/// Compiled signatures of one agent (compiled once per agent).
pub struct Signatures {
    rules: Vec<(regex::Regex, ErrorSignature)>,
}

impl Signatures {
    pub fn compile(sigs: &[ErrorSignature]) -> Self {
        let rules = sigs
            .iter()
            .filter_map(|s| {
                // `^` is the start of a (trimmed) line.
                match regex::Regex::new(&format!("(?m){}", s.pattern)) {
                    Ok(re) => Some((re, s.clone())),
                    Err(e) => {
                        log::warn!("[CAPS] catalog error signature does not compile: {e}");
                        None
                    }
                }
            })
            .collect();
        Signatures { rules }
    }

    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    /// The first line (in output order) that one of the signatures matches;
    /// for a line, signatures are tried in catalog order.
    pub fn find(&self, text: &str) -> Option<Rejection> {
        if self.rules.is_empty() {
            return None;
        }
        for full in logical_lines(output_lines(text)) {
            for (re, sig) in &self.rules {
                if let Some(caps) = re.captures(&full) {
                    let mut message: String = full.chars().take(MAX_VENDOR_MESSAGE).collect();
                    if message.len() < full.len() {
                        message.push('…');
                    }
                    return Some(Rejection {
                        reason: reason_of(&sig.reason),
                        suggestion: suggestion_of(&sig.suggestion),
                        vendor_message: message,
                        captured: caps.get(1).map(|m| m.as_str().to_string()),
                    });
                }
            }
        }
        None
    }
}

/// A TUI wraps a long message at the terminal's width: a line that stops
/// mid-sentence and a next line that goes on in lower case are one line
/// (at most four rows joined), so a pattern that spans the wrap still
/// matches and the message is read whole.
fn logical_lines(rows: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut joined = 0;
    for row in rows {
        match out.last_mut() {
            Some(last)
                if joined < 3
                    && !ends_sentence(last)
                    && row.starts_with(|c: char| c.is_lowercase()) =>
            {
                last.push(' ');
                last.push_str(&row);
                joined += 1;
            }
            _ => {
                out.push(row);
                joined = 0;
            }
        }
    }
    out
}

/// Whether a line ends like a finished sentence or record (so the next line
/// is not its continuation).
fn ends_sentence(line: &str) -> bool {
    line.trim_end()
        .ends_with(['.', '!', '?', ')', ']', '}', '"', '…', ':'])
}

/// The compiled signatures of a catalog agent (empty for one without any).
pub fn for_agent(agent_id: &str) -> &'static Signatures {
    use std::collections::HashMap;
    use std::sync::Mutex;
    static CACHE: OnceLock<Mutex<HashMap<String, &'static Signatures>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = cache.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(s) = map.get(agent_id) {
        return s;
    }
    let sigs = crate::agent_catalog::agent(agent_id)
        .and_then(|a| a.capabilities.as_ref())
        .map(|c| c.error_signatures.as_slice())
        .unwrap_or(&[]);
    let leaked: &'static Signatures = Box::leak(Box::new(Signatures::compile(sigs)));
    map.insert(agent_id.to_string(), leaked);
    leaked
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find(agent: &str, text: &str) -> Option<Rejection> {
        for_agent(agent).find(text)
    }

    // ─── The verbatim outputs of the capability matrix ───────────────

    #[test]
    fn claude_invalid_model_signed_out_and_bad_effort() {
        let invalid = "\"not-a-model\" isn't described by this version's model catalog; update Claude Code, or map it with behavesAs…\n[claude-code:unrecognized_model] {\"model\":\"not-a-model\",\"query_source\":\"sdk\"}\nThere's an issue with the selected model (not-a-model). It may not exist or you may not have access to it. Run --model to pick a different model.\n";
        let r = find("claude", invalid).unwrap();
        assert_eq!(r.reason, RejectReason::Model);
        assert_eq!(r.suggestion, RejectSuggestion::RetryDefault);
        assert_eq!(r.captured.as_deref(), Some("not-a-model"));
        assert_eq!(r.vendor_message, "There's an issue with the selected model (not-a-model). It may not exist or you may not have access to it. Run --model to pick a different model.");

        let out = find("claude", "Not logged in · Please run /login\n").unwrap();
        assert_eq!(
            (out.reason, out.suggestion),
            (RejectReason::SignedOut, RejectSuggestion::SignIn)
        );

        let effort = find("claude", "Warning: Unknown --effort value 'bogus' — ignoring it and using the default effort. Valid values: low, medium, high, xhigh, max.\n").unwrap();
        assert_eq!(effort.reason, RejectReason::Effort);
        assert_eq!(effort.captured.as_deref(), Some("bogus"));
    }

    #[test]
    fn codex_rejections_including_the_reconnect_loop() {
        let a = "ERROR: {\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'not-a-model' model is not supported when using Codex with a ChatGPT account.\"}}";
        assert_eq!(find("codex", a).unwrap().reason, RejectReason::Model);
        let b = "{\"type\":\"error\",\"message\":\"stream error: unexpected status 404 Not Found: The model `gpt-5.5` does not exist or you do not have access to it. Please check your model name.\"}";
        let r = find("codex", b).unwrap();
        assert_eq!(
            (r.reason, r.captured.as_deref()),
            (RejectReason::Model, Some("gpt-5.5"))
        );
        let c = "Reconnecting... 2/5\r\nReconnecting... 3/5\r\nERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header\n";
        assert_eq!(find("codex", c).unwrap().reason, RejectReason::SignedOut);
        assert_eq!(
            find("codex", "Not logged in\n").unwrap().reason,
            RejectReason::SignedOut
        );
        let d = "\"[ReasoningEffortParam] [reasoning.effort] [invalid_enum_value] Invalid value: 'bogus'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'.\"";
        assert_eq!(find("codex", d).unwrap().reason, RejectReason::Effort);
    }

    #[test]
    fn antigravity_rejections() {
        let a = "error: invalid model selection (--model \"not-a-model\" --effort \"\"): model not-a-model is not recognized as a known model or custom model in settings\nAvailable models:\n  Gemini 3.6 Flash (High)\n";
        let r = find("antigravity", a).unwrap();
        assert_eq!(
            (r.reason, r.captured.as_deref()),
            (RejectReason::Model, Some("not-a-model"))
        );
        let d = "error: invalid model selection (--model \"\" --effort \"bogus\"): invalid --effort \"bogus\" (valid: low, medium, high, max)";
        let r = find("antigravity", d).unwrap();
        assert_eq!(
            (r.reason, r.captured.as_deref()),
            (RejectReason::Effort, Some("bogus"))
        );
        let c = "Authentication required. Please visit the URL to log in:\nhttps://accounts.example.com/o/oauth2/auth?client_id=x\n";
        assert_eq!(
            find("antigravity", c).unwrap().reason,
            RejectReason::SignedOut
        );
    }

    #[test]
    fn gemini_ineligible_account_and_no_auth() {
        let r = find("gemini", "Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals.").unwrap();
        assert_eq!(
            (r.reason, r.suggestion),
            (RejectReason::Other, RejectSuggestion::SwitchAccount)
        );
        let r = find("gemini", "Please set an Auth method in your ~/.gemini/settings.json or specify one of the following environment variables before running: GEMINI_API_KEY").unwrap();
        assert_eq!(r.reason, RejectReason::SignedOut);
    }

    #[test]
    fn found_through_colours_cursor_moves_and_tui_decoration() {
        let drawn = "\x1b[?1049h\x1b[2J\x1b[1;1H\x1b[38;5;246m  ⎿  \x1b[0m\x1b[31mNot logged in\x1b[0m · Please run /login\x1b[K\x1b[3;1H> ";
        assert_eq!(
            find("claude", drawn).unwrap().vendor_message,
            "Not logged in · Please run /login"
        );
        let boxed = "■ The model `gpt-5.5` does not exist or you do not have access to it.";
        assert!(find("codex", boxed).is_some());
        let osc = "\x1b]0;codex\x07\x1b[1G\x1b[2KERROR: unexpected status 401 Unauthorized: Missing bearer";
        assert!(find("codex", osc).is_some());
    }

    #[test]
    fn a_normal_start_and_code_that_mentions_the_words_do_not_match() {
        let start = "\x1b[1;1H╭──────────────╮\r\n│ ✻ Welcome to Claude Code 2.1.284 │\r\n  Opus 5.5 · Max plan\r\n> Reply with ok\r\n● ok\r\n";
        assert!(find("claude", start).is_none());
        assert!(find("claude", "  if (!user) console.log('Not logged in')\n").is_none());
        assert!(find(
            "codex",
            "Logged in using ChatGPT\n>_ OpenAI Codex (v0.145.0)\nmodel: gpt-5.6-luna medium\n"
        )
        .is_none());
        assert!(find(
            "antigravity",
            "error: invalid model selection (--model \"\" --effort \"high\"): something else"
        )
        .is_none());
        assert!(find("custom", "Not logged in").is_none());
    }

    #[test]
    fn a_message_the_tui_wrapped_is_read_whole() {
        let wrapped = "There's an issue with the selected model (not-a-model). It may not exist or you may not have\r\naccess to it. Run --model to pick a different model.\r\n> \r\n";
        assert_eq!(
            find("claude", wrapped).unwrap().vendor_message,
            "There's an issue with the selected model (not-a-model). It may not exist or you may not have access to it. Run --model to pick a different model."
        );
        // A finished line, or one followed by something else, is not joined.
        let done = "Not logged in · Please run /login.\r\nsomething else\r\n";
        assert_eq!(
            find("claude", done).unwrap().vendor_message,
            "Not logged in · Please run /login."
        );
        let status = "Not logged in · Please run /login\r\n? for shortcuts\r\nOpus 5.5 · Max\r\n";
        assert_eq!(
            find("claude", status).unwrap().vendor_message,
            "Not logged in · Please run /login"
        );
        // Codex 0.145's TUI, as seen on a real run: the pattern spans the wrap.
        let codex = "\u{25a0} {\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'gpt-5.2-codex' model\r\nis not supported when using Codex with a ChatGPT account.\"}}\r\n";
        let r = find("codex", codex).unwrap();
        assert_eq!(r.reason, RejectReason::Model);
        assert!(r.vendor_message.ends_with(
            "The 'gpt-5.2-codex' model is not supported when using Codex with a ChatGPT account.\"}}"
        ));
    }

    #[test]
    fn a_very_long_line_is_capped() {
        let line = format!(
            "There's an issue with the selected model (x). {}",
            "y".repeat(2000)
        );
        let r = find("claude", &line).unwrap();
        assert!(r.vendor_message.chars().count() <= MAX_VENDOR_MESSAGE + 1);
        assert!(r.vendor_message.ends_with('…'));
    }

    #[test]
    fn every_catalog_signature_compiles() {
        for a in &crate::agent_catalog::catalog().agents {
            if let Some(c) = &a.capabilities {
                for s in &c.error_signatures {
                    assert!(
                        regex::Regex::new(&s.pattern).is_ok(),
                        "{}: {}",
                        a.id,
                        s.pattern
                    );
                }
            }
        }
    }
}
