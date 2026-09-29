//! F14: how full each agent's context window is, read from the exact
//! transcript file the agent itself names.
//!
//! An agent started through `hi run` reports its hook events to the
//! session's signal spool; Claude's hook payloads (and those of any agent
//! with the same shape) carry `transcript_path`. This module watches the
//! spool for that path — only on lines with the launch's nonce — and tails
//! the transcript it names, turning each model call's reported input tokens
//! into a [`SessionEvent::Context`] (not F31's `usage` totals) and each compaction into a
//! [`SessionEvent::Compacted`] on the contract channel.
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

use crate::contract::{emit_session_event, SessionEvent};
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
/// gauge until something reports its rollout file.
pub fn parse_transcript_line(line: &str) -> Option<TranscriptRecord> {
    let v: Value = serde_json::from_str(line).ok()?;
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
/// usage goes out, not a replay of every past call and compaction.
pub fn events_for_lines(
    tracker: &mut UsageTracker,
    lines: &[String],
    at: i64,
    source: &str,
    history: bool,
) -> Vec<SessionEvent> {
    let events = lines
        .iter()
        .filter_map(|line| parse_transcript_line(line))
        .filter_map(|record| tracker.feed(record, at, source));
    if history {
        events
            .filter(|e| matches!(e, SessionEvent::Context { .. }))
            .last()
            .into_iter()
            .collect()
    } else {
        events.collect()
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
                for event in events_for_lines(&mut tracker, &lines, now_ms(), source, *history) {
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
        let mut t = UsageTracker::default();
        let seeded = events_for_lines(&mut t, &history, 1, "transcript:claude", true);
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
        let events = events_for_lines(&mut t, &live, 2, "transcript:claude", false);
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], SessionEvent::Compacted { .. }));
        // The same history read as live lines would have sent every change.
        let mut fresh = UsageTracker::default();
        assert_eq!(
            events_for_lines(&mut fresh, &history, 1, "transcript:claude", false).len(),
            4
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
