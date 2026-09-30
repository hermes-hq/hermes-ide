//! F14: how full each agent's context window is, read from the exact
//! transcript file the agent itself names.
//!
//! An agent started through `hi run` reports its hook events to the
//! session's signal spool; Claude's hook payloads (and those of any agent
//! with the same shape) carry `transcript_path`. This module watches the
//! spool for that path — only on lines with the launch's nonce — and tails
//! the transcript it names, turning each model call's reported input tokens
//! into a [`SessionEvent::Context`] and each compaction into a
//! [`SessionEvent::Compacted`] on the contract channel.
//!
//! The same lines give the session's totals (F31): every call's tokens,
//! added up once per call, go out as a [`SessionEvent::Usage`] whose cost is
//! Hermes's estimate at Anthropic's list prices, tagged
//! `confidence: estimated` so every surface says so. A model without a list
//! price gets tokens and no cost ("n/a").
//!
//! Nothing is guessed: no path in the spool, no events. A model whose window
//! Hermes does not know gets a usage event with no limit, and the gauge then
//! shows nothing. Transcript text is never read into an event; only numbers,
//! the model name and the compaction trigger leave this module.

use std::io::{Read, Seek, SeekFrom};
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde_json::Value;
use tauri::AppHandle;

use crate::contract::{emit_session_event, SessionEvent, UsageConfidence, Usd};
use crate::pty::models::{Session, SessionPhase};

/// How often the spool and the transcript are read.
const POLL: Duration = Duration::from_millis(400);
/// A transcript already this large when first seen is read from this far
/// before its end: the latest usage is at the end, and a long conversation's
/// transcript can be hundreds of megabytes.
const TRANSCRIPT_BACKLOG_BYTES: u64 = 4 * 1024 * 1024;
/// A line longer than this is dropped unread (a huge tool result).
const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

/// Every Claude model's window, and the long-context one (the model name in
/// the transcript does not say which of the two a session uses; a session
/// that reports more than the standard window is on the long one).
const CLAUDE_WINDOW: u32 = 200_000;
const CLAUDE_LONG_WINDOW: u32 = 1_000_000;

// ─── Reading appended lines ──────────────────────────────────────────

/// Reads the whole lines appended to a file since the last call. Handles a
/// line split across writes, a file that does not exist yet and a file that
/// was truncated or replaced (it starts again from the top).
pub struct LineTail {
    path: PathBuf,
    offset: u64,
    partial: Vec<u8>,
    /// Drop everything up to the first newline (we started mid-line).
    skip_first: bool,
}

impl LineTail {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            offset: 0,
            partial: Vec::new(),
            skip_first: false,
        }
    }

    /// Start `backlog` bytes before the current end, so a large existing
    /// file is not read from the top.
    pub fn near_end(path: PathBuf, backlog: u64) -> Self {
        let len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let mut tail = Self::new(path);
        if len > backlog {
            tail.offset = len - backlog;
            tail.skip_first = true;
        }
        tail
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn poll(&mut self) -> Vec<String> {
        let mut lines = Vec::new();
        let Ok(mut f) = std::fs::File::open(&self.path) else {
            return lines;
        };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        if len < self.offset {
            // Truncated or replaced: read the new content from the top.
            self.offset = 0;
            self.partial.clear();
            self.skip_first = false;
        }
        if f.seek(SeekFrom::Start(self.offset)).is_err() {
            return lines;
        }
        let mut buf = Vec::new();
        let Ok(read) = f.read_to_end(&mut buf) else {
            return lines;
        };
        self.offset += read as u64;
        self.partial.extend_from_slice(&buf);
        while let Some(pos) = self.partial.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.partial.drain(..=pos).collect();
            if self.skip_first {
                self.skip_first = false;
                continue;
            }
            let text = String::from_utf8_lossy(&line[..line.len() - 1]);
            let text = text.trim();
            if !text.is_empty() {
                lines.push(text.to_string());
            }
        }
        if self.partial.len() > MAX_LINE_BYTES {
            // Not a line we will ever use; keep memory bounded.
            self.partial.clear();
            self.skip_first = true;
        }
        lines
    }
}

// ─── Transcript records ──────────────────────────────────────────────

/// What one transcript line says about the context window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TranscriptRecord {
    /// A model call and the input tokens it was sent with. `window` is set
    /// when the agent states its window itself (Codex).
    Usage {
        used: u32,
        model: Option<String>,
        window: Option<u32>,
    },
    Compacted {
        trigger: Option<String>,
        pre_tokens: Option<u32>,
    },
    /// The model the next calls use (Codex names it per turn, not per call).
    Model(String),
}

fn as_u32(v: Option<&Value>) -> Option<u32> {
    v.and_then(Value::as_u64)
        .map(|n| u32::try_from(n).unwrap_or(u32::MAX))
}

fn non_empty_str(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(80).collect())
}

/// Parse one transcript line. Claude Code (`assistant` records with
/// `message.usage`, `system`/`compact_boundary`) and Codex rollouts
/// (`event_msg`/`token_count`, `turn_context`, `compacted`) are understood;
/// anything else is None. Note: only a hook payload's `transcript_path`
/// (Claude's shape) names a transcript today, so a Codex session gets no
/// gauge until something reports its rollout file. (The watcher parses each
/// line once and reads both this and its [`SpendRecord`] from it; Codex's
/// model chip reads a rollout's last model with this.)
pub fn parse_transcript_line(line: &str) -> Option<TranscriptRecord> {
    let v: Value = serde_json::from_str(line).ok()?;
    transcript_record(&v)
}

fn transcript_record(v: &Value) -> Option<TranscriptRecord> {
    match v.get("type")?.as_str()? {
        "assistant" => {
            // A sub-agent's calls run in their own context, not this one.
            if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
                return None;
            }
            let message = v.get("message")?;
            let model = non_empty_str(message.get("model"));
            // Claude Code writes locally made-up messages (API errors) with
            // this model and zero usage: not a model call.
            if model.as_deref() == Some("<synthetic>") {
                return None;
            }
            let usage = message.get("usage")?;
            let input = as_u32(usage.get("input_tokens"))?;
            let used = input
                .saturating_add(as_u32(usage.get("cache_creation_input_tokens")).unwrap_or(0))
                .saturating_add(as_u32(usage.get("cache_read_input_tokens")).unwrap_or(0));
            Some(TranscriptRecord::Usage {
                used,
                model,
                window: None,
            })
        }
        "system" if v.get("subtype").and_then(Value::as_str) == Some("compact_boundary") => {
            let meta = v
                .get("compactMetadata")
                .or_else(|| v.get("compact_metadata"));
            Some(TranscriptRecord::Compacted {
                trigger: non_empty_str(meta.and_then(|m| m.get("trigger"))),
                pre_tokens: as_u32(
                    meta.and_then(|m| m.get("preTokens").or_else(|| m.get("pre_tokens"))),
                ),
            })
        }
        "event_msg" => {
            let payload = v.get("payload")?;
            if payload.get("type").and_then(Value::as_str) != Some("token_count") {
                return None;
            }
            let info = payload.get("info")?;
            let last = info.get("last_token_usage")?;
            Some(TranscriptRecord::Usage {
                used: as_u32(last.get("input_tokens"))?,
                model: None,
                window: as_u32(info.get("model_context_window")).filter(|w| *w > 0),
            })
        }
        "turn_context" => {
            non_empty_str(v.get("payload")?.get("model")).map(TranscriptRecord::Model)
        }
        "compacted" => Some(TranscriptRecord::Compacted {
            trigger: None,
            pre_tokens: None,
        }),
        _ => None,
    }
}

/// The context window for a model call: the agent's own figure when it
/// gives one, else Hermes's table (Claude only), else unknown.
pub fn context_limit(model: Option<&str>, used: u32, reported: Option<u32>) -> Option<NonZeroU32> {
    if let Some(w) = reported {
        return NonZeroU32::new(w);
    }
    let model = model?.to_ascii_lowercase();
    if model.contains("claude") {
        let long = model.contains("[1m]") || used > CLAUDE_WINDOW;
        return NonZeroU32::new(if long {
            CLAUDE_LONG_WINDOW
        } else {
            CLAUDE_WINDOW
        });
    }
    None
}

// ─── Session totals and their estimated cost (F31) ───────────────────

/// What one transcript line adds to the session's totals. Unlike the
/// context gauge, a sub-agent's calls count here: they are paid for too.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpendRecord {
    /// One Claude model call. Claude Code writes a call once per content
    /// block, repeating the same `message.id` and usage: the id folds them.
    Call {
        id: Option<String>,
        model: Option<String>,
        input: u64,
        /// All cache writes, the 1-hour ones included.
        cache_write: u64,
        /// The part of `cache_write` written for an hour (priced higher).
        cache_write_1h: u64,
        cache_read: u64,
        output: u64,
    },
    /// Codex states the conversation's totals itself (`total_token_usage`).
    Totals { input: u64, output: u64 },
}

fn as_u64(v: Option<&Value>) -> u64 {
    v.and_then(Value::as_u64).unwrap_or(0)
}

fn spend_record(v: &Value) -> Option<SpendRecord> {
    match v.get("type")?.as_str()? {
        "assistant" => {
            let message = v.get("message")?;
            let model = non_empty_str(message.get("model"));
            if model.as_deref() == Some("<synthetic>") {
                return None;
            }
            let usage = message.get("usage")?;
            usage.get("input_tokens")?.as_u64()?;
            Some(SpendRecord::Call {
                id: non_empty_str(message.get("id")),
                model,
                input: as_u64(usage.get("input_tokens")),
                cache_write: as_u64(usage.get("cache_creation_input_tokens")),
                cache_write_1h: as_u64(
                    usage
                        .get("cache_creation")
                        .and_then(|c| c.get("ephemeral_1h_input_tokens")),
                ),
                cache_read: as_u64(usage.get("cache_read_input_tokens")),
                output: as_u64(usage.get("output_tokens")),
            })
        }
        "event_msg" => {
            let payload = v.get("payload")?;
            if payload.get("type").and_then(Value::as_str) != Some("token_count") {
                return None;
            }
            let total = payload.get("info")?.get("total_token_usage")?;
            Some(SpendRecord::Totals {
                input: total.get("input_tokens")?.as_u64()?,
                output: as_u64(total.get("output_tokens")),
            })
        }
        _ => None,
    }
}

/// US dollars per million tokens: input, output, cache write (5-minute
/// and 1-hour), cache read.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub cache_write: f64,
    pub cache_write_1h: f64,
    pub cache_read: f64,
}

const fn price(input: f64, output: f64, cache_read: f64) -> Price {
    Price {
        input,
        output,
        cache_write: input * 1.25,
        cache_write_1h: input * 2.0,
        cache_read,
    }
}

/// Anthropic's list prices for the Claude models (first-party API, as
/// published in 2026-09). Only used for an ESTIMATE that every surface
/// marks as such; a model not in this table gets no cost at all ("n/a").
pub fn claude_price(model: &str) -> Option<Price> {
    let m = model.to_ascii_lowercase();
    if !m.contains("claude") {
        return None;
    }
    let has = |s: &str| m.contains(s);
    Some(if has("fable-5-1") || has("mythos-5-1") {
        price(10.0, 50.0, 0.25)
    } else if has("fable") || has("mythos") {
        price(10.0, 50.0, 1.0)
    } else if has("opus-5-5") {
        price(4.0, 20.0, 0.20)
    } else if has("opus-5")
        || has("opus-4-5")
        || has("opus-4-6")
        || has("opus-4-7")
        || has("opus-4-8")
    {
        price(5.0, 25.0, 0.50)
    } else if has("opus") {
        // Opus 4, 4.1 and the Claude 3 Opus.
        price(15.0, 75.0, 1.50)
    } else if has("sonnet-5") {
        price(2.0, 10.0, 0.20)
    } else if has("sonnet") {
        price(3.0, 15.0, 0.30)
    } else if has("haiku-4") {
        price(1.0, 5.0, 0.10)
    } else if has("3-5-haiku") || has("haiku-3-5") {
        price(0.80, 4.0, 0.08)
    } else if has("haiku") {
        price(0.25, 1.25, 0.03)
    } else {
        return None;
    })
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct CallTokens {
    input: u64,
    cache_write: u64,
    cache_write_1h: u64,
    cache_read: u64,
    output: u64,
}

/// The session's token totals from its transcripts, and their cost at list
/// prices. Kept across transcripts of one launch (a `/clear` starts a new
/// file; the money spent before it is still spent), folded by message id so
/// a line read twice never counts twice.
#[derive(Default)]
pub struct SpendTracker {
    calls: std::collections::HashMap<String, (CallTokens, Option<String>)>,
    /// Calls without an id, each counted once as read.
    anonymous: Vec<(CallTokens, Option<String>)>,
    codex: Option<(u64, u64)>,
    last: Option<(u64, u64, Option<u64>)>,
}

impl SpendTracker {
    pub fn feed(&mut self, record: SpendRecord) {
        match record {
            SpendRecord::Call {
                id,
                model,
                input,
                cache_write,
                cache_write_1h,
                cache_read,
                output,
            } => {
                let tokens = CallTokens {
                    input,
                    cache_write,
                    cache_write_1h,
                    cache_read,
                    output,
                };
                match id {
                    // The latest line of a call has its final output count.
                    Some(id) => {
                        self.calls.insert(id, (tokens, model));
                    }
                    None => self.anonymous.push((tokens, model)),
                }
            }
            SpendRecord::Totals { input, output } => self.codex = Some((input, output)),
        }
    }

    /// (input tokens including cache reads and writes, output tokens, cost)
    /// — the cost is None when a call's model has no list price.
    pub fn totals(&self) -> Option<(u64, u64, Option<f64>)> {
        if let Some((input, output)) = self.codex {
            if self.calls.is_empty() && self.anonymous.is_empty() {
                return Some((input, output, None));
            }
        }
        let calls = self.calls.values().chain(self.anonymous.iter());
        let mut input = 0u64;
        let mut output = 0u64;
        let mut cost = Some(0.0f64);
        let mut any = false;
        for (t, model) in calls {
            any = true;
            input = input
                .saturating_add(t.input)
                .saturating_add(t.cache_write)
                .saturating_add(t.cache_read);
            output = output.saturating_add(t.output);
            cost = match (cost, model.as_deref().and_then(claude_price)) {
                (Some(sum), Some(p)) => {
                    let write_1h = t.cache_write_1h.min(t.cache_write);
                    Some(
                        sum + (t.input as f64 * p.input
                            + t.output as f64 * p.output
                            + (t.cache_write - write_1h) as f64 * p.cache_write
                            + write_1h as f64 * p.cache_write_1h
                            + t.cache_read as f64 * p.cache_read)
                            / 1_000_000.0,
                    )
                }
                _ => None,
            };
        }
        any.then_some((input, output, cost))
    }

    /// A `usage` event (confidence `estimated`) when the totals changed
    /// since the last one sent.
    pub fn event(&mut self, at: i64, source: &str) -> Option<SessionEvent> {
        let (input, output, cost) = self.totals()?;
        // Compared in micro-dollars: a float that moved by rounding only is no news.
        let now = (
            input,
            output,
            cost.map(|c| (c * 1_000_000.0).round() as u64),
        );
        if self.last == Some(now) {
            return None;
        }
        self.last = Some(now);
        Some(SessionEvent::Usage {
            at,
            source: Some(source.to_string()),
            tags: None,
            input_tokens: Some(input),
            output_tokens: Some(output),
            cost_usd: cost.and_then(Usd::new),
            confidence: Some(UsageConfidence::Estimated),
        })
    }
}

/// Turns transcript records into session events: one usage event per model
/// call whose numbers differ from the last one sent, one event per
/// compaction.
#[derive(Default)]
pub struct UsageTracker {
    model: Option<String>,
    last: Option<(u32, Option<NonZeroU32>, Option<String>)>,
}

impl UsageTracker {
    pub fn feed(
        &mut self,
        record: TranscriptRecord,
        at: i64,
        source: &str,
    ) -> Option<SessionEvent> {
        match record {
            TranscriptRecord::Model(m) => {
                self.model = Some(m);
                None
            }
            TranscriptRecord::Usage {
                used,
                model,
                window,
            } => {
                if model.is_some() {
                    self.model = model;
                }
                let limit = context_limit(self.model.as_deref(), used, window);
                let now = (used, limit, self.model.clone());
                if self.last.as_ref() == Some(&now) {
                    return None;
                }
                self.last = Some(now);
                Some(SessionEvent::Context {
                    at,
                    source: Some(source.to_string()),
                    tags: None,
                    used_tokens: used,
                    context_limit: limit,
                    model: self.model.clone(),
                })
            }
            TranscriptRecord::Compacted {
                trigger,
                pre_tokens,
            } => {
                // The next call's usage is news even if it repeats an old one.
                self.last = None;
                Some(SessionEvent::Compacted {
                    at,
                    source: Some(source.to_string()),
                    tags: None,
                    trigger,
                    pre_tokens,
                })
            }
        }
    }
}

/// The events for a batch of transcript lines. Lines that were already in
/// the file when Hermes started reading it (`history`, e.g. a resumed
/// conversation) only set where the gauge stands: of those, just the latest
/// usage goes out, not a replay of every past call and compaction. The
/// session's totals (F31) go out once per batch, after its other events,
/// when they changed.
pub fn events_for_lines(
    tracker: &mut UsageTracker,
    spend: &mut SpendTracker,
    lines: &[String],
    at: i64,
    source: &str,
    history: bool,
) -> Vec<SessionEvent> {
    let mut events: Vec<SessionEvent> = Vec::new();
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(record) = spend_record(&v) {
            spend.feed(record);
        }
        if let Some(event) = transcript_record(&v).and_then(|r| tracker.feed(r, at, source)) {
            events.push(event);
        }
    }
    if history {
        events.retain(|e| matches!(e, SessionEvent::Context { .. }));
        let last = events.pop();
        events = last.into_iter().collect();
    }
    events.extend(spend.event(at, source));
    events
}

// ─── The spool: where the transcript is ──────────────────────────────

/// What a spool line tells this module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpoolNote {
    Transcript { path: PathBuf, agent: String },
    Exited,
}

/// A transcript path is only taken from a line carrying this launch's nonce,
/// and only when it is an absolute path to a `.jsonl` file.
pub fn parse_spool_note(line: &str, nonce: &str) -> Option<SpoolNote> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("nonce").and_then(Value::as_str) != Some(nonce) {
        return None;
    }
    if v.get("event").and_then(Value::as_str) == Some("hermes.exited") {
        return Some(SpoolNote::Exited);
    }
    let raw = v.get("payload")?.get("transcript_path")?.as_str()?.trim();
    let path = PathBuf::from(raw);
    let is_jsonl = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("jsonl"));
    if !path.is_absolute() || !is_jsonl {
        return None;
    }
    let agent = v
        .get("agent")
        .and_then(Value::as_str)
        .filter(|a| !a.is_empty() && a.len() <= 40)
        .unwrap_or("agent")
        .to_string();
    Some(SpoolNote::Transcript { path, agent })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Watch one launch's spool for the transcript it names, and tail that
/// transcript until the agent is gone or the session is.
pub(crate) fn watch(
    app: AppHandle,
    session: Arc<StdMutex<Session>>,
    spool_file: PathBuf,
    nonce: String,
) {
    let session_id = match session.lock() {
        Ok(s) => s.id.clone(),
        Err(_) => return,
    };
    std::thread::spawn(move || {
        let mut spool = LineTail::new(spool_file);
        // The transcript's tail, the event source, and whether the next read
        // is the history already in the file.
        let mut transcript: Option<(LineTail, String, bool)> = None;
        let mut tracker = UsageTracker::default();
        let mut spend = SpendTracker::default();
        loop {
            std::thread::sleep(POLL);
            let gone = match session.lock() {
                Ok(s) => matches!(
                    s.phase,
                    SessionPhase::Destroyed | SessionPhase::Disconnected
                ),
                Err(_) => true,
            };
            let mut exited = false;
            for line in spool.poll() {
                match parse_spool_note(&line, &nonce) {
                    Some(SpoolNote::Transcript { path, agent }) => {
                        let same = transcript
                            .as_ref()
                            .is_some_and(|(t, _, _)| t.path() == path);
                        if !same {
                            log::info!(
                                "[CONTEXT] {session_id}: reading usage from the agent's transcript"
                            );
                            transcript = Some((
                                LineTail::near_end(path, TRANSCRIPT_BACKLOG_BYTES),
                                format!("transcript:{agent}"),
                                true,
                            ));
                            tracker = UsageTracker::default();
                        }
                    }
                    Some(SpoolNote::Exited) => exited = true,
                    None => {}
                }
            }
            if let Some((tail, source, history)) = transcript.as_mut() {
                let lines = tail.poll();
                for event in
                    events_for_lines(&mut tracker, &mut spend, &lines, now_ms(), source, *history)
                {
                    emit_session_event(&app, &session_id, event);
                }
                *history = false;
            }
            if gone || exited {
                break;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn claude_assistant(input: u64, create: u64, read: u64, model: &str) -> String {
        json!({
            "type": "assistant",
            "isSidechain": false,
            "sessionId": "s-1",
            "message": {
                "id": "msg_1", "role": "assistant", "model": model,
                "content": [{"type": "text", "text": "secret words"}],
                "usage": {
                    "input_tokens": input,
                    "cache_creation_input_tokens": create,
                    "cache_read_input_tokens": read,
                    "output_tokens": 999
                }
            }
        })
        .to_string()
    }

    #[test]
    fn a_claude_call_counts_input_plus_both_cache_figures_not_output() {
        let rec = parse_transcript_line(&claude_assistant(3, 12_000, 71_000, "claude-fake-1"));
        assert_eq!(
            rec,
            Some(TranscriptRecord::Usage {
                used: 83_003,
                model: Some("claude-fake-1".into()),
                window: None
            })
        );
    }

    #[test]
    fn sidechain_synthetic_and_unrelated_lines_are_not_usage() {
        let mut side: Value = serde_json::from_str(&claude_assistant(1, 2, 3, "claude-x")).unwrap();
        side["isSidechain"] = json!(true);
        assert_eq!(parse_transcript_line(&side.to_string()), None);
        assert_eq!(
            parse_transcript_line(&claude_assistant(0, 0, 0, "<synthetic>")),
            None
        );
        assert_eq!(
            parse_transcript_line(r#"{"type":"user","message":{"content":"hi"}}"#),
            None
        );
        assert_eq!(parse_transcript_line("not json"), None);
        assert_eq!(
            parse_transcript_line(r#"{"type":"assistant","message":{"model":"claude-x"}}"#),
            None
        );
    }

    #[test]
    fn compact_boundaries_in_both_spellings() {
        let transcript = r#"{"type":"system","subtype":"compact_boundary","content":"Conversation compacted","compactMetadata":{"trigger":"auto","preTokens":155000}}"#;
        assert_eq!(
            parse_transcript_line(transcript),
            Some(TranscriptRecord::Compacted {
                trigger: Some("auto".into()),
                pre_tokens: Some(155_000)
            })
        );
        let stream = r#"{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"manual","pre_tokens":9}}"#;
        assert_eq!(
            parse_transcript_line(stream),
            Some(TranscriptRecord::Compacted {
                trigger: Some("manual".into()),
                pre_tokens: Some(9)
            })
        );
        assert_eq!(
            parse_transcript_line(r#"{"type":"system","subtype":"init"}"#),
            None
        );
    }

    #[test]
    fn codex_rollouts_report_their_own_window() {
        let tc = r#"{"type":"turn_context","payload":{"model":"fake-codex-model","cwd":"/work"}}"#;
        assert_eq!(
            parse_transcript_line(tc),
            Some(TranscriptRecord::Model("fake-codex-model".into()))
        );
        let tokens = r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":90000},"last_token_usage":{"input_tokens":54400,"cached_input_tokens":50000,"output_tokens":300},"model_context_window":272000}}}"#;
        assert_eq!(
            parse_transcript_line(tokens),
            Some(TranscriptRecord::Usage {
                used: 54_400,
                model: None,
                window: Some(272_000)
            })
        );
        // Before the first call Codex writes a token_count with no info.
        assert_eq!(
            parse_transcript_line(
                r#"{"type":"event_msg","payload":{"type":"token_count","info":null}}"#
            ),
            None
        );
        let mut tracker = UsageTracker::default();
        assert!(tracker
            .feed(parse_transcript_line(tc).unwrap(), 1, "transcript:codex")
            .is_none());
        match tracker.feed(
            parse_transcript_line(tokens).unwrap(),
            2,
            "transcript:codex",
        ) {
            Some(SessionEvent::Context {
                used_tokens,
                context_limit,
                model,
                ..
            }) => {
                assert_eq!(used_tokens, 54_400);
                assert_eq!(context_limit.map(|l| l.get()), Some(272_000));
                assert_eq!(model.as_deref(), Some("fake-codex-model"));
            }
            other => panic!("expected usage, got {other:?}"),
        }
    }

    #[test]
    fn the_window_comes_from_the_agent_else_the_claude_table_else_nowhere() {
        assert_eq!(
            context_limit(Some("anything"), 5, Some(128_000)).map(|l| l.get()),
            Some(128_000)
        );
        assert_eq!(
            context_limit(Some("claude-fake-1"), 5, None).map(|l| l.get()),
            Some(200_000)
        );
        assert_eq!(
            context_limit(Some("claude-fake-1[1m]"), 5, None).map(|l| l.get()),
            Some(1_000_000)
        );
        // More than the standard window can only be the long one.
        assert_eq!(
            context_limit(Some("claude-fake-1"), 250_000, None).map(|l| l.get()),
            Some(1_000_000)
        );
        assert_eq!(context_limit(Some("gpt-fake"), 5, None), None);
        assert_eq!(context_limit(None, 5, None), None);
        assert_eq!(context_limit(Some("x"), 5, Some(0)), None);
    }

    #[test]
    fn the_tracker_sends_only_changes_and_every_compaction() {
        let mut t = UsageTracker::default();
        let call = |used| TranscriptRecord::Usage {
            used,
            model: Some("claude-fake-1".into()),
            window: None,
        };
        let first = t.feed(call(83_003), 10, "transcript:claude").unwrap();
        assert_eq!(
            serde_json::to_value(&first).unwrap(),
            json!({"type":"context","at":10,"source":"transcript:claude","usedTokens":83003,"contextLimit":200000,"model":"claude-fake-1"})
        );
        assert!(
            t.feed(call(83_003), 11, "transcript:claude").is_none(),
            "same numbers: no event"
        );
        assert!(t.feed(call(90_000), 12, "transcript:claude").is_some());
        let compact = TranscriptRecord::Compacted {
            trigger: Some("auto".into()),
            pre_tokens: Some(90_000),
        };
        assert!(matches!(
            t.feed(compact, 13, "transcript:claude"),
            Some(SessionEvent::Compacted { .. })
        ));
        assert!(
            t.feed(call(90_000), 14, "transcript:claude").is_some(),
            "after a compaction the next call is news"
        );
    }

    #[test]
    fn a_transcript_found_with_history_sends_only_where_the_gauge_stands() {
        let compact = json!({"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":"auto","preTokens":150000}}).to_string();
        let history = vec![
            claude_assistant(3, 1_000, 9_000, "claude-fake-1"),
            compact.clone(),
            claude_assistant(3, 2_000, 40_000, "claude-fake-1"),
            claude_assistant(3, 2_000, 50_000, "claude-fake-1"),
            "not json".to_string(),
        ];
        let not_totals = |events: Vec<SessionEvent>| -> Vec<SessionEvent> {
            events
                .into_iter()
                .filter(|e| !matches!(e, SessionEvent::Usage { .. }))
                .collect()
        };
        let mut t = UsageTracker::default();
        let mut spend = SpendTracker::default();
        let seeded = not_totals(events_for_lines(
            &mut t,
            &mut spend,
            &history,
            1,
            "transcript:claude",
            true,
        ));
        assert_eq!(seeded.len(), 1, "one event, not a replay: {seeded:?}");
        assert!(matches!(
            seeded[0],
            SessionEvent::Context {
                used_tokens: 52_003,
                ..
            }
        ));
        // What is written after that is news, every call and compaction.
        let live = vec![compact, claude_assistant(3, 1_000, 20_000, "claude-fake-1")];
        let events = not_totals(events_for_lines(
            &mut t,
            &mut spend,
            &live,
            2,
            "transcript:claude",
            false,
        ));
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], SessionEvent::Compacted { .. }));
        // The same history read as live lines would have sent every change.
        let mut fresh = UsageTracker::default();
        assert_eq!(
            not_totals(events_for_lines(
                &mut fresh,
                &mut SpendTracker::default(),
                &history,
                1,
                "transcript:claude",
                false
            ))
            .len(),
            4
        );
    }

    fn call(id: &str, model: &str, input: u64, write: u64, read: u64, output: u64) -> String {
        json!({
            "type": "assistant",
            "isSidechain": false,
            "message": {
                "id": id, "role": "assistant", "model": model,
                "content": [{"type": "text", "text": "words that never leave"}],
                "usage": {
                    "input_tokens": input,
                    "cache_creation_input_tokens": write,
                    "cache_read_input_tokens": read,
                    "output_tokens": output
                }
            }
        })
        .to_string()
    }

    /// A usage event's input, output, cost and confidence.
    type Totals = (
        Option<u64>,
        Option<u64>,
        Option<f64>,
        Option<UsageConfidence>,
    );

    fn usage_of(events: &[SessionEvent]) -> Option<Totals> {
        events.iter().rev().find_map(|e| match e {
            SessionEvent::Usage {
                input_tokens,
                output_tokens,
                cost_usd,
                confidence,
                ..
            } => Some((
                *input_tokens,
                *output_tokens,
                cost_usd.map(Usd::get),
                *confidence,
            )),
            _ => None,
        })
    }

    #[test]
    fn list_prices_cover_every_claude_family_and_nothing_else() {
        let p = |m: &str| claude_price(m).map(|p| (p.input, p.output, p.cache_read));
        assert_eq!(p("claude-sonnet-4-6"), Some((3.0, 15.0, 0.30)));
        assert_eq!(p("claude-sonnet-4-5-20250929"), Some((3.0, 15.0, 0.30)));
        assert_eq!(p("claude-sonnet-5"), Some((2.0, 10.0, 0.20)));
        assert_eq!(p("claude-opus-4-8"), Some((5.0, 25.0, 0.50)));
        assert_eq!(p("claude-opus-4-5-20251101"), Some((5.0, 25.0, 0.50)));
        assert_eq!(p("claude-opus-5"), Some((5.0, 25.0, 0.50)));
        assert_eq!(p("claude-opus-5-5"), Some((4.0, 20.0, 0.20)));
        assert_eq!(p("claude-opus-4-1-20250805"), Some((15.0, 75.0, 1.50)));
        assert_eq!(p("claude-opus-4-20250514"), Some((15.0, 75.0, 1.50)));
        assert_eq!(p("claude-haiku-4-5"), Some((1.0, 5.0, 0.10)));
        assert_eq!(p("claude-3-5-haiku-20241022"), Some((0.80, 4.0, 0.08)));
        assert_eq!(p("claude-3-haiku-20240307"), Some((0.25, 1.25, 0.03)));
        assert_eq!(p("claude-fable-5-1"), Some((10.0, 50.0, 0.25)));
        assert_eq!(p("claude-fable-5"), Some((10.0, 50.0, 1.0)));
        assert_eq!(p("CLAUDE-SONNET-4-6[1m]"), Some((3.0, 15.0, 0.30)));
        // A cache write costs 1.25x the input price, 2x when kept for an hour.
        assert_eq!(claude_price("claude-sonnet-4-6").unwrap().cache_write, 3.75);
        assert_eq!(
            claude_price("claude-sonnet-4-6").unwrap().cache_write_1h,
            6.0
        );
        assert_eq!(
            p("claude-fake-1"),
            None,
            "an unknown Claude model has no price"
        );
        assert_eq!(p("gpt-5-codex"), None);
        assert_eq!(p("sonnet"), None, "not a Claude model id");
    }

    #[test]
    fn totals_add_every_call_once_and_price_them_as_an_estimate() {
        let mut t = UsageTracker::default();
        let mut spend = SpendTracker::default();
        // Nothing read yet: no totals event at all (the rows say "n/a").
        assert!(usage_of(&events_for_lines(
            &mut t,
            &mut spend,
            &[],
            1,
            "transcript:claude",
            false
        ))
        .is_none());
        // Call A: two content blocks, the same id and usage, the second with
        // the final output count; a sub-agent's call B counts (it is paid).
        let mut sub: Value =
            serde_json::from_str(&call("msg_b", "claude-sonnet-4-6", 100, 0, 0, 1_000)).unwrap();
        sub["isSidechain"] = json!(true);
        let lines = vec![
            call("msg_a", "claude-sonnet-4-6", 1_000, 10_000, 100_000, 10),
            call("msg_a", "claude-sonnet-4-6", 1_000, 10_000, 100_000, 2_000),
            sub.to_string(),
            call("msg_s", "<synthetic>", 0, 0, 0, 0),
        ];
        let events = events_for_lines(&mut t, &mut spend, &lines, 5, "transcript:claude", false);
        let (input, output, cost, confidence) = usage_of(&events).expect("a totals event");
        assert_eq!(input, Some(1_000 + 10_000 + 100_000 + 100));
        assert_eq!(output, Some(2_000 + 1_000));
        // 1,000 x $3 + 10,000 x $3.75 + 100,000 x $0.30 + 2,000 x $15, then
        // 100 x $3 + 1,000 x $15, per million.
        let expected = (1_000.0 * 3.0
            + 10_000.0 * 3.75
            + 100_000.0 * 0.30
            + 2_000.0 * 15.0
            + 100.0 * 3.0
            + 1_000.0 * 15.0)
            / 1e6;
        assert!(
            (cost.unwrap() - expected).abs() < 1e-9,
            "{cost:?} vs {expected}"
        );
        assert_eq!(confidence, Some(UsageConfidence::Estimated));
        assert!(
            matches!(events.last(), Some(SessionEvent::Usage { .. })),
            "totals come last"
        );
        let wire = serde_json::to_value(events.last().unwrap()).unwrap();
        assert_eq!(wire["confidence"], json!("estimated"));
        assert_eq!(wire["source"], json!("transcript:claude"));
        // The same lines again (a re-read): no news, nothing double-counted.
        assert!(usage_of(&events_for_lines(
            &mut t,
            &mut spend,
            &lines,
            6,
            "transcript:claude",
            false
        ))
        .is_none());
        assert_eq!(spend.totals().unwrap().1, 3_000);
    }

    #[test]
    fn a_one_hour_cache_write_costs_twice_the_input_price() {
        let mut spend = SpendTracker::default();
        let mut t = UsageTracker::default();
        // 1M tokens written to the cache, 600k of them for an hour, on a
        // model at $1/M input: 400k x $1.25 + 600k x $2.00 = $1.70.
        let line = json!({
            "type": "assistant",
            "message": {
                "id": "m1", "role": "assistant", "model": "claude-haiku-4-5",
                "usage": {
                    "input_tokens": 0,
                    "cache_creation_input_tokens": 1_000_000,
                    "cache_creation": {
                        "ephemeral_5m_input_tokens": 400_000,
                        "ephemeral_1h_input_tokens": 600_000
                    },
                    "cache_read_input_tokens": 0,
                    "output_tokens": 0
                }
            }
        })
        .to_string();
        let e = events_for_lines(&mut t, &mut spend, &[line], 1, "transcript:claude", false);
        let (input, _, cost, _) = usage_of(&e).unwrap();
        assert_eq!(input, Some(1_000_000));
        assert!((cost.unwrap() - 1.70).abs() < 1e-9, "{cost:?}");
    }

    #[test]
    fn totals_outlive_a_new_transcript_and_a_model_without_a_price_is_na() {
        let mut spend = SpendTracker::default();
        let mut t = UsageTracker::default();
        events_for_lines(
            &mut t,
            &mut spend,
            &[call("m1", "claude-haiku-4-5", 1_000_000, 0, 0, 0)],
            1,
            "transcript:claude",
            false,
        );
        // /clear: a new transcript; the tracker for the gauge starts over,
        // the totals keep what was spent.
        let mut t2 = UsageTracker::default();
        let e = events_for_lines(
            &mut t2,
            &mut spend,
            &[call("m2", "claude-haiku-4-5", 1_000_000, 0, 0, 0)],
            2,
            "transcript:claude",
            true,
        );
        let (input, _, cost, _) = usage_of(&e).unwrap();
        assert_eq!(input, Some(2_000_000));
        assert!((cost.unwrap() - 2.0).abs() < 1e-9);
        // One call on a model Hermes has no price for: the tokens are still
        // known, the cost is not ("n/a"), never a guess.
        let e = events_for_lines(
            &mut t2,
            &mut spend,
            &[call("m3", "claude-fake-1", 5, 0, 0, 5)],
            3,
            "transcript:claude",
            false,
        );
        assert_eq!(
            usage_of(&e),
            Some((
                Some(2_000_005),
                Some(5),
                None,
                Some(UsageConfidence::Estimated)
            ))
        );
    }

    #[test]
    fn codex_totals_are_its_own_and_carry_no_price() {
        let mut spend = SpendTracker::default();
        let mut t = UsageTracker::default();
        let tokens = r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":90000,"cached_input_tokens":50000,"output_tokens":1200},"last_token_usage":{"input_tokens":54400},"model_context_window":272000}}}"#;
        let e = events_for_lines(
            &mut t,
            &mut spend,
            &[tokens.to_string()],
            1,
            "transcript:codex",
            false,
        );
        assert_eq!(
            usage_of(&e),
            Some((
                Some(90_000),
                Some(1_200),
                None,
                Some(UsageConfidence::Estimated)
            ))
        );
    }

    #[test]
    fn spool_notes_need_the_nonce_and_an_absolute_jsonl_path() {
        let abs = if cfg!(windows) {
            "C:/fixture/t.jsonl"
        } else {
            "/fixture/t.jsonl"
        };
        let line = |nonce: &str, path: &str| {
            json!({"v":1,"ts":1,"session":"s","agent":"claude","nonce":nonce,"event":"SessionStart","payload":{"transcript_path":path}}).to_string()
        };
        assert_eq!(
            parse_spool_note(&line("n1", abs), "n1"),
            Some(SpoolNote::Transcript {
                path: PathBuf::from(abs),
                agent: "claude".into()
            })
        );
        assert_eq!(parse_spool_note(&line("other", abs), "n1"), None);
        assert_eq!(
            parse_spool_note(&line("n1", "relative/t.jsonl"), "n1"),
            None
        );
        let not_jsonl = if cfg!(windows) {
            "C:/fixture/t.txt"
        } else {
            "/fixture/t.txt"
        };
        assert_eq!(parse_spool_note(&line("n1", not_jsonl), "n1"), None);
        let exited = json!({"v":1,"ts":1,"session":"s","agent":"hi","nonce":"n1","event":"hermes.exited","payload":{"exit_code":0}}).to_string();
        assert_eq!(parse_spool_note(&exited, "n1"), Some(SpoolNote::Exited));
        assert_eq!(parse_spool_note("garbage", "n1"), None);
    }

    #[test]
    fn the_tail_reads_whole_lines_across_writes_and_restarts_after_truncation() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("hermes-ctx-tail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("t.jsonl");
        let _ = std::fs::remove_file(&file);
        let mut tail = LineTail::new(file.clone());
        assert!(tail.poll().is_empty(), "a missing file reads as nothing");
        let mut f = std::fs::File::create(&file).unwrap();
        write!(f, "one\ntw").unwrap();
        f.flush().unwrap();
        assert_eq!(tail.poll(), vec!["one".to_string()]);
        write!(f, "o\n\nthree\n").unwrap();
        f.flush().unwrap();
        assert_eq!(tail.poll(), vec!["two".to_string(), "three".to_string()]);
        drop(f);
        std::fs::write(&file, "new\n").unwrap();
        assert_eq!(tail.poll(), vec!["new".to_string()]);

        // A large file is read from near its end, starting at a whole line.
        let big = dir.join("big.jsonl");
        let mut content = String::new();
        for i in 0..1000 {
            content.push_str(&format!("line-{i:04}\n"));
        }
        std::fs::write(&big, &content).unwrap();
        let mut near = LineTail::near_end(big, 25);
        let got = near.poll();
        assert_eq!(got, vec!["line-0998".to_string(), "line-0999".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
