//! How a CLI says it refused a launch: the catalog's `error_signatures`
//! (regular expressions from the capability matrix) matched against the
//! terminal output of the launch's first seconds.
//!
//! Terminal output is not text: colours, cursor moves and redraws sit
//! between the words. `output_lines` strips every escape sequence, turns
//! cursor moves and carriage returns into line breaks, and trims the
//! decoration a TUI puts around a line (box drawing, "■", "⎿"), so a
//! `^Not logged in` still finds `  ⎿  Not logged in · Please run /login`.
//!
//! What is not the CLI's own error must never match (a match stops the
//! agent). So the signatures are anchored to the CLI's error shapes, and:
//! - the marks a TUI puts before the person's prompt (`>`, `›`, `❯`) and
//!   before the agent's reply (`●`, `⏺`, `•`) are kept, so an echoed task
//!   or an answer that quotes an error is not a line that starts with it;
//! - a match inside text Hermes itself passed to the CLI (the task, the
//!   context prompt) or the person typed is an echo, not a refusal
//!   (`Signatures::find_excluding`).

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
                c.is_whitespace()
                    || (!c.is_ascii() && !PROMPT_AND_REPLY_MARKS.contains(&c))
                    || matches!(c, '|' | '*' | '-' | '+' | '#')
            })
            .trim_end_matches(|c: char| c.is_whitespace() || is_frame(c))
            .to_string()
        })
        .filter(|l| !l.is_empty())
        .collect()
}

/// The marks a TUI puts before the person's prompt (Claude Code `>`/`❯`,
/// Codex `›`) and before the agent's reply (Claude Code `●`/`⏺`, Codex
/// `•`). A line that starts with one is not the CLI's own error line.
const PROMPT_AND_REPLY_MARKS: &[char] = &['>', '›', '❯', '»', '●', '⏺', '•'];

/// Box drawing and block elements: a TUI's frame, never words.
fn is_frame(c: char) -> bool {
    ('\u{2500}'..='\u{259f}').contains(&c)
}

/// Text as the words it holds: no whitespace, no frame, no control
/// characters. An echo of a task that the TUI wrapped or framed still reads
/// the same.
pub fn squeeze(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_whitespace() && !c.is_control() && !is_frame(*c))
        .collect()
}

/// How much of a line around a match must also be in a passed-in text for
/// the match to count as that text's echo.
const ECHO_CONTEXT: usize = 16;

/// Whether the match `start..end` of `line` is an echo of one of `given`
/// (texts squeezed with `squeeze`): the match with up to `ECHO_CONTEXT`
/// characters of the line on each side is part of one of them.
fn is_echo(line: &str, start: usize, end: usize, given: &[String]) -> bool {
    if given.is_empty() {
        return false;
    }
    let phrase = squeeze(&line[start..end]);
    if phrase.is_empty() || !given.iter().any(|g| g.contains(&phrase)) {
        return false;
    }
    let before: Vec<char> = line[..start].chars().rev().take(ECHO_CONTEXT).collect();
    let mut window: String = before.into_iter().rev().collect();
    window.push_str(&line[start..end]);
    window.extend(line[end..].chars().take(ECHO_CONTEXT));
    let window = squeeze(&window);
    given.iter().any(|g| g.contains(&window))
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
    #[cfg(test)]
    pub fn find(&self, text: &str) -> Option<Rejection> {
        self.find_excluding(text, &[])
    }

    /// `find`, but a match that is an echo of one of `given` (texts Hermes
    /// passed to the CLI or the person typed, squeezed with `squeeze`) does
    /// not count.
    pub fn find_excluding(&self, text: &str, given: &[String]) -> Option<Rejection> {
        if self.rules.is_empty() {
            return None;
        }
        for full in logical_lines(output_lines(text)) {
            for (re, sig) in &self.rules {
                if let Some(caps) = re.captures(&full) {
                    let whole = caps.get(0).expect("a match has group 0");
                    if is_echo(&full, whole.start(), whole.end(), given) {
                        continue;
                    }
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

impl Signatures {
    /// Every line of `text` one of the signatures matches, squeezed (see
    /// `squeeze`): what a resumed conversation's replay showed, so that the
    /// same line drawn again later is not read as a new refusal.
    pub fn matching_lines(&self, text: &str) -> Vec<String> {
        if self.rules.is_empty() {
            return Vec::new();
        }
        logical_lines(output_lines(text))
            .into_iter()
            .filter(|line| self.rules.iter().any(|(re, _)| re.is_match(line)))
            .map(|line| squeeze(&line))
            .filter(|line| !line.is_empty())
            .collect()
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
    fn an_echoed_prompt_or_an_answer_that_quotes_the_words_does_not_match() {
        // The person's prompt as Claude Code and Codex draw it, and answers
        // that quote an error (the agent's reply marks are kept).
        for (agent, line) in [
            ("claude", "> Not logged in · Please run /login shows after SSO"),
            ("claude", "\u{276f} Not logged in · Please run /login"),
            ("claude", "\u{23fa} Not logged in · Please run /login is what the CLI prints"),
            ("claude", "\u{25cf} There's an issue with the selected model (x). It may not exist"),
            ("codex", "\u{203a} ERROR: unexpected status 401 Unauthorized: Missing bearer"),
            ("codex", "\u{2022} ERROR: unexpected status 401 Unauthorized: Missing bearer"),
            ("codex", "prompt: Fix the 401 Unauthorized error on the login page"),
            ("codex", "Fix the 401 Unauthorized error on the login page"),
            ("codex", "The logs say Not logged in"),
            ("codex", "I found `The model `gpt-5.5` does not exist or you do not have access to it` in the log"),
            ("antigravity", "Why does agy print Authentication required?"),
        ] {
            assert!(find(agent, &format!("{line}\n")).is_none(), "{agent}: {line}");
        }
    }

    #[test]
    fn an_echo_of_a_passed_in_text_does_not_match_but_the_cli_still_does() {
        let sigs = for_agent("codex");
        let task =
            "Users see:\nERROR: unexpected status 401 Unauthorized: Missing bearer\nplease fix";
        let given = vec![squeeze(task)];
        let echo = "ERROR: unexpected status 401 Unauthorized: Missing bearer\n";
        assert!(
            sigs.find(echo).is_some(),
            "without the task it is the CLI's line"
        );
        assert!(
            sigs.find_excluding(echo, &given).is_none(),
            "with it, an echo"
        );
        // Wrapped mid-word and framed, still the echo.
        let wrapped =
            "\u{2502} ERROR: unexpected status 401 Unauth\r\norized: Missing bearer \u{2502}\n";
        assert!(sigs.find_excluding(wrapped, &given).is_none());
        // The CLI's own line has other words around the match.
        let real =
            "Reconnecting... 2/5\nERROR: unexpected status 401 Unauthorized: token expired\n";
        assert!(sigs.find_excluding(real, &given).is_some());
        // The one thing that cannot be told apart: the CLI printing the very
        // words of the task around the match. Then it is taken for the echo,
        // and the agent is left running (never the other way round).
        let same =
            "ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication\n";
        assert!(sigs.find_excluding(same, &given).is_none());
        // A given text that does not hold the matched words changes nothing.
        let other = vec![squeeze("Fix the 401 Unauthorized error on the login page")];
        assert!(sigs.find_excluding(echo, &other).is_some());
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
