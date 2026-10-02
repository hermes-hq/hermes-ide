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

use crate::contract::signal::TurnTracker;
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

/// Claude's two window sizes.
const CLAUDE_WINDOW: u32 = 200_000;
const CLAUDE_LONG_WINDOW: u32 = 1_000_000;

/// Claude models and their window, exactly as Claude Code itself states it
/// (`context_window.context_window_size` in its status line input, Claude
/// Code 2.1.286, read for each id below on 2026-10-01). Ids are without the
/// `claude-` prefix, a date suffix and `[1m]`. A model not listed has no
/// gauge: Claude Code answers 200k for any id it does not know, which is a
/// guess, and Hermes does not show guesses. The Claude 5 models run on the
/// long window by default, so a 200k assumption showed them five times too
/// full.
const CLAUDE_WINDOWS: &[(&str, u32)] = &[
    ("opus-5-5", CLAUDE_LONG_WINDOW),
    ("opus-5", CLAUDE_LONG_WINDOW),
    ("opus-4-8", CLAUDE_LONG_WINDOW),
    ("opus-4-7", CLAUDE_LONG_WINDOW),
    ("sonnet-5-5", CLAUDE_LONG_WINDOW),
    ("sonnet-5", CLAUDE_LONG_WINDOW),
    ("fable-5-1", CLAUDE_LONG_WINDOW),
    ("fable-5", CLAUDE_LONG_WINDOW),
    ("mythos-5-1", CLAUDE_LONG_WINDOW),
    ("mythos-5", CLAUDE_LONG_WINDOW),
    ("opus-4-6", CLAUDE_WINDOW),
    ("opus-4-5", CLAUDE_WINDOW),
    ("opus-4", CLAUDE_WINDOW),
    ("sonnet-4-6", CLAUDE_WINDOW),
    ("sonnet-4-5", CLAUDE_WINDOW),
    ("sonnet-4", CLAUDE_WINDOW),
    ("haiku-4-5", CLAUDE_WINDOW),
    ("3-5-haiku", CLAUDE_WINDOW),
];

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
            // What Codex itself counts as in the window (`/status`: "16.2K
            // used / 258K"): the last call's total, its output included.
            let input = as_u32(last.get("input_tokens"))?;
            let used = as_u32(last.get("total_tokens")).unwrap_or_else(|| {
                input.saturating_add(as_u32(last.get("output_tokens")).unwrap_or(0))
            });
            Some(TranscriptRecord::Usage {
                used,
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

/// A Claude model id as the window table names it: lower case, without
/// `claude-`, a `-YYYYMMDD` date or `[1m]`; and whether it asked for the
/// long window (`[1m]`). None for an id that is not Claude's.
fn claude_family(model: &str) -> Option<(String, bool)> {
    let m = model.trim().to_ascii_lowercase();
    let long = m.contains("[1m]");
    let m = m.replace("[1m]", "");
    let rest = m.strip_prefix("claude-")?;
    let rest = match rest.rsplit_once('-') {
        Some((head, date)) if date.len() == 8 && date.bytes().all(|b| b.is_ascii_digit()) => head,
        _ => rest,
    };
    Some((rest.to_string(), long))
}

/// The context window for a model call: the agent's own figure when it
/// gives one, else the window Claude Code states for that Claude model,
/// else unknown (no gauge).
pub fn context_limit(model: Option<&str>, used: u32, reported: Option<u32>) -> Option<NonZeroU32> {
    if let Some(w) = reported {
        return NonZeroU32::new(w);
    }
    let (family, long) = claude_family(model?)?;
    if long {
        return NonZeroU32::new(CLAUDE_LONG_WINDOW);
    }
    let window = CLAUDE_WINDOWS
        .iter()
        .find(|(name, _)| *name == family)
        .map(|(_, w)| *w)?;
    // More than the standard window can only be the long one (a 200k model
    // started with `[1m]`, whose transcript does not say so).
    NonZeroU32::new(if used > window {
        CLAUDE_LONG_WINDOW
    } else {
        window
    })
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
    /// The window the agent's status line stated, and for which model (its
    /// Claude family when it names one).
    stated: Option<(Option<String>, u32)>,
}

impl UsageTracker {
    /// The agent's status line stated its window (Claude Code's
    /// `context_window.context_window_size`): it wins over the table for
    /// that model.
    pub fn state_window(&mut self, model: Option<&str>, size: u32) {
        if size > 0 {
            self.stated = Some((model.and_then(claude_family).map(|(f, _)| f), size));
        }
    }

    fn stated_for(&self, model: Option<&str>) -> Option<u32> {
        let (family, size) = self.stated.as_ref()?;
        match family {
            None => Some(*size),
            Some(f) => (model.and_then(claude_family).map(|(g, _)| g).as_deref()
                == Some(f.as_str()))
            .then_some(*size),
        }
    }

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
                let window = window.or_else(|| self.stated_for(self.model.as_deref()));
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
#[cfg(test)]
pub fn events_for_lines(
    tracker: &mut UsageTracker,
    spend: &mut SpendTracker,
    lines: &[String],
    at: i64,
    source: &str,
    history: bool,
) -> Vec<SessionEvent> {
    let mut interrupts = InterruptWatch::default();
    read_lines(tracker, spend, &mut interrupts, lines, at, source, history).0
}

/// [`events_for_lines`], and how many turns the person interrupted in
/// these lines (see [`InterruptWatch`]; never in `history`).
pub fn read_lines(
    tracker: &mut UsageTracker,
    spend: &mut SpendTracker,
    interrupts: &mut InterruptWatch,
    lines: &[String],
    at: i64,
    source: &str,
    history: bool,
) -> (Vec<SessionEvent>, usize) {
    let mut events: Vec<SessionEvent> = Vec::new();
    let mut interrupted = 0;
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if interrupts.feed(&v) && !history {
            interrupted += 1;
        }
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
    (events, interrupted)
}

// ─── A turn the person interrupted ───────────────────────────────────

/// Claude Code fires no hook when the person rejects a tool call with Esc
/// ("Interrupted · What should Claude do instead?") or interrupts the turn:
/// its transcript records a `user` line with `toolUseResult: "User rejected
/// tool use"` or the text `[Request interrupted by user…]`, then the turn's
/// `system`/`turn_duration` line. This tells that pair apart from the
/// person's rejection followed by more work (the agent goes on in the same
/// turn: an `assistant` line or a new prompt comes in between). Only the
/// line types are read, never the text of the conversation beyond that
/// marker.
#[derive(Debug, Default)]
pub struct InterruptWatch {
    pending: bool,
}

const INTERRUPT_MARK: &str = "[Request interrupted by user";

fn is_interrupt_line(v: &Value) -> bool {
    if v.get("toolUseResult").and_then(Value::as_str) == Some("User rejected tool use") {
        return true;
    }
    let content = v.get("message").and_then(|m| m.get("content"));
    match content {
        Some(Value::String(s)) => s.starts_with(INTERRUPT_MARK),
        Some(Value::Array(parts)) => parts.iter().any(|p| {
            p.get("type").and_then(Value::as_str) == Some("text")
                && p.get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|t| t.starts_with(INTERRUPT_MARK))
        }),
        _ => false,
    }
}

impl InterruptWatch {
    /// One transcript line; true when it closes a turn the person
    /// interrupted.
    pub fn feed(&mut self, v: &Value) -> bool {
        // A sub-agent's lines belong to its own conversation.
        if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            return false;
        }
        match v.get("type").and_then(Value::as_str) {
            Some("user") => {
                if is_interrupt_line(v) {
                    self.pending = true;
                } else if v.get("toolUseResult").is_none()
                    && v.get("isMeta").and_then(Value::as_bool) != Some(true)
                {
                    // A new prompt: the interrupted turn is behind us.
                    self.pending = false;
                }
                false
            }
            // The agent went on after the rejection (feedback was typed).
            Some("assistant") => {
                self.pending = false;
                false
            }
            Some("system") if v.get("subtype").and_then(Value::as_str) == Some("turn_duration") => {
                std::mem::take(&mut self.pending)
            }
            _ => false,
        }
    }
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

/// The window a status line line states (`context_window_size`, kept by
/// `hi signal`), with the model it names: only on lines with the nonce.
pub fn parse_spool_window(line: &str, nonce: &str) -> Option<(Option<String>, u32)> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("nonce").and_then(Value::as_str) != Some(nonce) {
        return None;
    }
    let payload = v.get("payload")?;
    let size = as_u32(payload.get("context_window_size")).filter(|n| *n > 0)?;
    Some((non_empty_str(payload.get("model")), size))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Watch one launch's spool for the transcript it names, and tail that
/// transcript until the agent is gone or the session is. `turns`: the
/// launch's turns (the spool watcher's), ended here when the transcript
/// shows the person interrupted one (an exact `turn_interrupted`).
pub(crate) fn watch(
    app: AppHandle,
    session: Arc<StdMutex<Session>>,
    spool_file: PathBuf,
    nonce: String,
    turns: Arc<StdMutex<TurnTracker>>,
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
        let mut interrupts = InterruptWatch::default();
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
                if let Some((model, size)) = parse_spool_window(&line, &nonce) {
                    tracker.state_window(model.as_deref(), size);
                }
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
                            // A new conversation; the window its status
                            // line stated still holds.
                            let stated = tracker.stated.take();
                            tracker = UsageTracker::default();
                            tracker.stated = stated;
                            interrupts = InterruptWatch::default();
                        }
                    }
                    Some(SpoolNote::Exited) => exited = true,
                    None => {}
                }
            }
            if let Some((tail, source, history)) = transcript.as_mut() {
                let lines = tail.poll();
                let at = now_ms();
                let (events, interrupted) = read_lines(
                    &mut tracker,
                    &mut spend,
                    &mut interrupts,
                    &lines,
                    at,
                    source,
                    *history,
                );
                for event in events {
                    emit_session_event(&app, &session_id, event);
                }
                if interrupted > 0 {
                    let event = turns
                        .lock()
                        .ok()
                        .and_then(|mut t| t.interrupt_running(at, Some(source.clone())));
                    if let Some(event) = event {
                        log::info!("[CONTEXT] {session_id}: the person interrupted the turn");
                        emit_session_event(&app, &session_id, event);
                    }
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
        // Without total_tokens: input plus output.
        let tokens = r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":90000},"last_token_usage":{"input_tokens":54400,"cached_input_tokens":50000,"output_tokens":300},"model_context_window":272000}}}"#;
        assert_eq!(
            parse_transcript_line(tokens),
            Some(TranscriptRecord::Usage {
                used: 54_700,
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
                assert_eq!(used_tokens, 54_700);
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
        let w = |model: &str, used: u32| context_limit(Some(model), used, None).map(|l| l.get());
        // As Claude Code 2.1.286 states them in its status line input.
        assert_eq!(w("claude-haiku-4-5-20251001", 5), Some(200_000));
        assert_eq!(w("claude-sonnet-4-5-20250929", 5), Some(200_000));
        assert_eq!(w("claude-opus-5-5", 5), Some(1_000_000));
        assert_eq!(w("claude-sonnet-5-5", 5), Some(1_000_000));
        assert_eq!(w("claude-fable-5-1", 5), Some(1_000_000));
        assert_eq!(w("claude-opus-4-7", 5), Some(1_000_000));
        assert_eq!(w("claude-opus-5-5-20260801", 5), Some(1_000_000));
        assert_eq!(w("claude-sonnet-4-5[1m]", 5), Some(1_000_000));
        assert_eq!(w("claude-haiku-4-5-20251001[1M]", 5), Some(1_000_000));
        // More than the standard window can only be the long one.
        assert_eq!(w("claude-sonnet-4-5-20250929", 250_000), Some(1_000_000));
        // A model Claude Code does not know (it answers 200k for any id) and
        // anything not Claude: no window, so no gauge, never a guess.
        assert_eq!(w("claude-fake-1", 5), None);
        assert_eq!(w("claude-opus-6", 5), None);
        assert_eq!(w("claude-opus-5-1", 5), None);
        assert_eq!(w("gpt-fake", 5), None);
        assert_eq!(w("not-claude-opus-5-5", 5), None);
        assert_eq!(context_limit(None, 5, None), None);
        assert_eq!(context_limit(Some("x"), 5, Some(0)), None);
    }

    /// A real Claude Code 2.1.286 transcript line (claude-sonnet-5-5), with
    /// its ids, paths and content replaced.
    const REAL_CLAUDE_LINE: &str = r#"{"parentUuid":"00000000-0000-4000-8000-000000000002","isSidechain":false,"userType":"external","entrypoint":"cli","version":"2.1.286","effort":"max","perTurnEffort":"max","sessionId":"00000000-0000-4000-8000-000000000001","type":"assistant","uuid":"00000000-0000-4000-8000-000000000003","timestamp":"2026-09-30T12:00:00.000Z","requestId":"req_redacted","apiBlockIndex":0,"message":{"id":"msg_redacted","type":"message","role":"assistant","model":"claude-sonnet-5-5","content":[{"type":"text","text":"(redacted)"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":4476,"cache_read_input_tokens":134668,"output_tokens":4802,"output_tokens_details":{"thinking_tokens":4070},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":4476,"ephemeral_5m_input_tokens":0},"iterations":[{"input_tokens":2,"output_tokens":4802,"cache_read_input_tokens":134668,"cache_creation_input_tokens":4476,"type":"message"}]}}}"#;

    #[test]
    fn a_real_claude_5_session_is_measured_against_its_1m_window() {
        // The reported case: 139,146 tokens in context. Hermes showed 70 %
        // (against 200k); Claude Code's own window for this model is 1M:
        // 14 %, as its /context says.
        let mut t = UsageTracker::default();
        let rec = parse_transcript_line(REAL_CLAUDE_LINE).unwrap();
        match t.feed(rec, 1, "transcript:claude") {
            Some(SessionEvent::Context {
                used_tokens,
                context_limit,
                model,
                ..
            }) => {
                assert_eq!(used_tokens, 2 + 4_476 + 134_668);
                assert_eq!(context_limit.map(|l| l.get()), Some(1_000_000));
                assert_eq!(model.as_deref(), Some("claude-sonnet-5-5"));
                assert_eq!(
                    (used_tokens as f64 / 1_000_000.0 * 100.0).round() as u32,
                    14
                );
            }
            other => panic!("expected context, got {other:?}"),
        }
    }

    #[test]
    fn a_real_claude_haiku_call_matches_its_status_line() {
        // Claude Code 2.1.286, claude-haiku-4-5, its status line input after
        // the call: current_usage 8 + 229 + 40,913 = 41,150 of 200,000,
        // used_percentage 21 (/context: "41.2k/200k tokens (21%)").
        let line = REAL_CLAUDE_LINE
            .replace("claude-sonnet-5-5", "claude-haiku-4-5-20251001")
            .replace(r#""input_tokens":2,"cache_creation_input_tokens":4476,"cache_read_input_tokens":134668"#, r#""input_tokens":8,"cache_creation_input_tokens":229,"cache_read_input_tokens":40913"#);
        let mut t = UsageTracker::default();
        match t.feed(
            parse_transcript_line(&line).unwrap(),
            1,
            "transcript:claude",
        ) {
            Some(SessionEvent::Context {
                used_tokens,
                context_limit,
                ..
            }) => {
                assert_eq!(used_tokens, 41_150);
                let limit = context_limit.unwrap().get();
                assert_eq!(limit, 200_000);
                assert_eq!(
                    (used_tokens as f64 / limit as f64 * 100.0).round() as u32,
                    21
                );
            }
            other => panic!("expected context, got {other:?}"),
        }
    }

    #[test]
    fn a_real_codex_rollout_counts_what_codex_status_counts() {
        // codex-cli 0.145.0, gpt-5.6-luna: `/status` said "98% left (16.2K
        // used / 258K)" and the footer "94% left" after this token_count.
        let line = r#"{"timestamp":"2026-10-01T11:52:40.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":48338,"cached_input_tokens":40192,"cache_write_input_tokens":0,"output_tokens":164,"reasoning_output_tokens":0,"total_tokens":48502},"last_token_usage":{"input_tokens":16239,"cached_input_tokens":15104,"cache_write_input_tokens":0,"output_tokens":6,"reasoning_output_tokens":0,"total_tokens":16245},"model_context_window":258400},"rate_limits":null}}"#;
        let tc = r#"{"timestamp":"2026-10-01T11:52:38.000Z","type":"turn_context","payload":{"turn_id":"t","cwd":"/fixture","model":"gpt-5.6-luna","effort":"low"}}"#;
        let mut t = UsageTracker::default();
        assert!(t
            .feed(parse_transcript_line(tc).unwrap(), 1, "transcript:codex")
            .is_none());
        match t.feed(parse_transcript_line(line).unwrap(), 2, "transcript:codex") {
            Some(SessionEvent::Context {
                used_tokens,
                context_limit,
                model,
                ..
            }) => {
                assert_eq!(used_tokens, 16_245, "Codex's own \"16.2K used\"");
                assert_eq!(
                    context_limit.map(|l| l.get()),
                    Some(258_400),
                    "Codex's own \"258K\""
                );
                assert_eq!(model.as_deref(), Some("gpt-5.6-luna"));
                // 6 % used, the footer's "94% left".
                assert_eq!((used_tokens as f64 / 258_400.0 * 100.0).round() as u32, 6);
            }
            other => panic!("expected context, got {other:?}"),
        }
    }

    #[test]
    fn a_status_line_window_wins_for_its_model_only() {
        let abs = if cfg!(windows) {
            "C:/fixture/t.jsonl"
        } else {
            "/fixture/t.jsonl"
        };
        let status = json!({"v":1,"ts":1,"session":"s","agent":"claude","nonce":"n1","event":"StatusLine","payload":{"model":"claude-sonnet-4-5[1m]","context_window_size":1000000,"transcript_path":abs}}).to_string();
        assert_eq!(
            parse_spool_window(&status, "n1"),
            Some((Some("claude-sonnet-4-5[1m]".into()), 1_000_000))
        );
        assert_eq!(parse_spool_window(&status, "other"), None);
        let hook = json!({"v":1,"ts":1,"session":"s","agent":"claude","nonce":"n1","event":"SessionStart","payload":{"transcript_path":abs}}).to_string();
        assert_eq!(parse_spool_window(&hook, "n1"), None);
        let mut t = UsageTracker::default();
        t.state_window(Some("claude-sonnet-4-5[1m]"), 1_000_000);
        let call = |model: &str, used| TranscriptRecord::Usage {
            used,
            model: Some(model.into()),
            window: None,
        };
        // The transcript names the model without [1m]: the stated window holds.
        match t.feed(
            call("claude-sonnet-4-5-20250929", 150_000),
            1,
            "transcript:claude",
        ) {
            Some(SessionEvent::Context { context_limit, .. }) => {
                assert_eq!(context_limit.map(|l| l.get()), Some(1_000_000))
            }
            other => panic!("{other:?}"),
        }
        // Another model (a /model switch): its own window from the table.
        match t.feed(
            call("claude-haiku-4-5-20251001", 150_000),
            2,
            "transcript:claude",
        ) {
            Some(SessionEvent::Context { context_limit, .. }) => {
                assert_eq!(context_limit.map(|l| l.get()), Some(200_000))
            }
            other => panic!("{other:?}"),
        }
        // An unknown model gets a gauge only from a stated window.
        let mut u = UsageTracker::default();
        assert!(matches!(
            u.feed(call("claude-next-9", 10), 1, "t"),
            Some(SessionEvent::Context {
                context_limit: None,
                ..
            })
        ));
        u.state_window(Some("claude-next-9"), 400_000);
        assert!(
            matches!(u.feed(call("claude-next-9", 11), 2, "t"), Some(SessionEvent::Context { context_limit: Some(l), .. }) if l.get() == 400_000)
        );
    }

    #[test]
    fn the_tracker_sends_only_changes_and_every_compaction() {
        let mut t = UsageTracker::default();
        let call = |used| TranscriptRecord::Usage {
            used,
            model: Some("claude-haiku-4-5-20251001".into()),
            window: None,
        };
        let first = t.feed(call(83_003), 10, "transcript:claude").unwrap();
        assert_eq!(
            serde_json::to_value(&first).unwrap(),
            json!({"type":"context","at":10,"source":"transcript:claude","usedTokens":83003,"contextLimit":200000,"model":"claude-haiku-4-5-20251001"})
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

    /// The lines Claude Code 2.1.287 wrote around an Esc at a permission
    /// prompt (the real transcript's shapes, text shortened).
    fn rejected_turn() -> Vec<String> {
        vec![
            json!({"type":"user","message":{"role":"user","content":"Use the Bash tool to run curl"}}).to_string(),
            json!({"type":"assistant","message":{"role":"assistant","model":"claude-haiku-4-5-20251001","content":[{"type":"tool_use","name":"Bash","input":{}}],"usage":{"input_tokens":3,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":5}}}).to_string(),
            json!({"type":"user","toolUseResult":"User rejected tool use","message":{"role":"user","content":[{"type":"tool_result","content":"The user doesn't want to proceed with this tool use.","is_error":true}]}}).to_string(),
            json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}).to_string(),
            json!({"type":"system","subtype":"turn_duration","durationMs":2815,"messageCount":36}).to_string(),
        ]
    }

    fn interrupts(lines: &[String], history: bool) -> usize {
        let mut w = InterruptWatch::default();
        let (mut t, mut s) = (UsageTracker::default(), SpendTracker::default());
        read_lines(
            &mut t,
            &mut s,
            &mut w,
            lines,
            1,
            "transcript:claude",
            history,
        )
        .1
    }

    #[test]
    fn an_esc_at_a_permission_prompt_is_an_interrupted_turn() {
        assert_eq!(interrupts(&rejected_turn(), false), 1);
        // The usage of the turn's call is still read from the same lines.
        let mut w = InterruptWatch::default();
        let (mut t, mut s) = (UsageTracker::default(), SpendTracker::default());
        let (events, n) = read_lines(
            &mut t,
            &mut s,
            &mut w,
            &rejected_turn(),
            1,
            "transcript:claude",
            false,
        );
        assert_eq!(n, 1);
        assert!(events
            .iter()
            .any(|e| matches!(e, SessionEvent::Context { .. })));
        // Split across two reads, it is still one.
        let lines = rejected_turn();
        let mut w = InterruptWatch::default();
        let (mut t, mut s) = (UsageTracker::default(), SpendTracker::default());
        let a = read_lines(
            &mut t,
            &mut s,
            &mut w,
            &lines[..4],
            1,
            "transcript:claude",
            false,
        )
        .1;
        let b = read_lines(
            &mut t,
            &mut s,
            &mut w,
            &lines[4..],
            2,
            "transcript:claude",
            false,
        )
        .1;
        assert_eq!((a, b), (0, 1));
    }

    #[test]
    fn a_plain_interrupt_then_the_turn_duration_is_one_too() {
        let lines = vec![
            json!({"type":"user","message":{"role":"user","content":"[Request interrupted by user]"}}).to_string(),
            json!({"type":"system","subtype":"turn_duration","durationMs":900}).to_string(),
        ];
        assert_eq!(interrupts(&lines, false), 1);
    }

    #[test]
    fn a_finished_turn_or_a_rejection_the_agent_works_past_is_not_interrupted() {
        // A normal turn: its duration line ends nothing the hooks did not.
        let normal = vec![
            json!({"type":"user","message":{"role":"user","content":"Reply with ok"}}).to_string(),
            json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}).to_string(),
            json!({"type":"system","subtype":"stop_hook_summary"}).to_string(),
            json!({"type":"system","subtype":"turn_duration","durationMs":1427}).to_string(),
        ];
        assert_eq!(interrupts(&normal, false), 0);
        // Rejected with feedback: the agent goes on in the same turn.
        let mut on = rejected_turn();
        on.truncate(3);
        on.push(json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Understood"}]}}).to_string());
        on.push(json!({"type":"system","subtype":"turn_duration","durationMs":5000}).to_string());
        assert_eq!(interrupts(&on, false), 0);
        // A sub-agent's interrupt is its own conversation's.
        let side: Vec<String> = rejected_turn()
            .into_iter()
            .map(|l| {
                let mut v: Value = serde_json::from_str(&l).unwrap();
                v["isSidechain"] = json!(true);
                v.to_string()
            })
            .collect();
        assert_eq!(interrupts(&side, false), 0);
    }

    #[test]
    fn an_interrupt_already_in_the_file_is_history() {
        assert_eq!(interrupts(&rejected_turn(), true), 0);
    }
}
