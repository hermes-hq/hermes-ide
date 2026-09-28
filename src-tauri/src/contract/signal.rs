//! `hi signal` spool records (contract C0; mirror of src/agent/contract/signal.ts).
//!
//! The helper appends one JSON line per agent hook event to the session's
//! spool file:
//!
//! ```text
//! {"v":1,"ts":1790000000,"session":"<sid>","agent":"claude","nonce":"<nonce>","event":"PermissionRequest","payload":{...}}
//! ```
//!
//! The nonce is minted by Hermes per launch. A record whose nonce does not
//! match is text any program could have written and never becomes `exact`.
//! [`to_session_event`] is a stub over the status map of the signals
//! report; F11 owns the per-agent event names and the spool watcher.

use super::{AgentStatus, AgentStatusKind, Confidence, SessionEvent};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const SIGNAL_RECORD_VERSION: u32 = 1;
/// `hi signal` caps the payload it writes.
pub const SIGNAL_PAYLOAD_CAP_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignalRecord {
    pub v: u32,
    /// Epoch seconds.
    pub ts: i64,
    /// Hermes session id the hook was configured for.
    pub session: String,
    /// Catalog agent id (claude, codex, gemini, copilot, opencode, goose...).
    pub agent: String,
    pub nonce: String,
    /// The agent's own event name (PermissionRequest, Stop, ...).
    pub event: String,
    #[serde(default)]
    pub payload: Map<String, Value>,
}

/// Parse one spool line. A line of another version, or with an empty
/// required field, is refused.
pub fn parse_signal_line(line: &str) -> Result<SignalRecord, String> {
    let record: SignalRecord = serde_json::from_str(line).map_err(|e| e.to_string())?;
    if record.v != SIGNAL_RECORD_VERSION {
        return Err(format!("unsupported version {}", record.v));
    }
    for (name, value) in [
        ("session", &record.session),
        ("agent", &record.agent),
        ("nonce", &record.nonce),
        ("event", &record.event),
    ] {
        if value.is_empty() {
            return Err(format!("missing {name}"));
        }
    }
    Ok(record)
}

/// Vendor event name -> status. None: not a status by itself.
/// Owned by F11, which moves this table into the providers module when it
/// fills it; nothing outside that module should grow more vendor names.
pub fn status_kind_of(event: &str) -> Option<AgentStatusKind> {
    Some(match event {
        "UserPromptSubmit" | "PostToolUse" | "PreToolUse" => AgentStatusKind::Working,
        "PermissionRequest" => AgentStatusKind::NeedsApproval,
        "AskUserQuestion" | "Question" => AgentStatusKind::NeedsAnswer,
        "ExitPlanMode" => AgentStatusKind::PlanReady,
        "Stop" | "AfterAgent" | "TurnEnd" => AgentStatusKind::DoneUnread,
        "Failure" | "Error" => AgentStatusKind::Error,
        "SessionEnd" => AgentStatusKind::Exited,
        _ => return None,
    })
}

fn detail_of(payload: &Map<String, Value>) -> String {
    for key in ["message", "tool_name", "toolName", "question", "reason"] {
        if let Some(Value::String(s)) = payload.get(key) {
            let t = s.trim();
            if !t.is_empty() {
                return t.chars().take(200).collect();
            }
        }
    }
    String::new()
}

/// Machine markers Hermes put into text the agent now reports back, in the
/// form `[hermes-<name> #<n>]` (for example the `[hermes-review #3]` line a
/// person pastes from the Review Desk, F21). Returned as `hermes-<name>#<n>`,
/// deduplicated, in order of appearance. Never the surrounding text.
pub fn tags_in_text(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find("[hermes-") {
        let after_open = &rest[open + 1..];
        let Some(close) = after_open.find(']') else {
            break;
        };
        let inner = &after_open[..close];
        if let Some((name, n)) = inner.split_once(" #") {
            let name_ok = name.len() > "hermes-".len()
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
            let n_ok = !n.is_empty() && n.len() <= 9 && n.bytes().all(|b| b.is_ascii_digit());
            if name_ok && n_ok {
                let tag = format!("{name}#{n}");
                if !out.contains(&tag) {
                    out.push(tag);
                }
            }
        }
        rest = &after_open[close + 1..];
    }
    out
}

/// The field `hi signal` lifts the markers into (the prompt itself never
/// reaches the spool).
const TAGS_FIELD: &str = "hermes_tags";

/// True for a well-formed `hermes-<name>#<n>` tag, as `hi` writes them.
fn is_tag(s: &str) -> bool {
    let Some((name, n)) = s.split_once('#') else {
        return false;
    };
    name.starts_with("hermes-")
        && name.len() > "hermes-".len()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        && !n.is_empty()
        && n.len() <= 9
        && n.bytes().all(|b| b.is_ascii_digit())
}

/// The markers of a payload: the `hermes_tags` list `hi` wrote, plus
/// [`tags_in_text`] over any string value still present. Deduplicated.
pub fn tags_in_payload(payload: &Map<String, Value>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |tag: String| {
        if !out.contains(&tag) {
            out.push(tag);
        }
    };
    if let Some(Value::Array(list)) = payload.get(TAGS_FIELD) {
        for item in list {
            if let Value::String(s) = item {
                if is_tag(s) {
                    push(s.clone());
                }
            }
        }
    }
    for (key, value) in payload {
        if key == TAGS_FIELD {
            continue;
        }
        if let Value::String(s) = value {
            for tag in tags_in_text(s) {
                push(tag);
            }
        }
    }
    out
}

/// The SessionEvent one spool line means, when the line carries this
/// launch's nonce. None for a foreign, malformed or meaningless line.
pub fn session_event_in_line(line: &str, expected_nonce: &str) -> Option<SessionEvent> {
    let record = parse_signal_line(line).ok()?;
    to_session_event(&record, expected_nonce)
}

/// The SessionEvent a record means, or None when the nonce does not match
/// or the event carries no meaning for Hermes yet.
pub fn to_session_event(record: &SignalRecord, expected_nonce: &str) -> Option<SessionEvent> {
    if record.nonce != expected_nonce {
        return None;
    }
    let at = record.ts.saturating_mul(1000);
    let source = Some(format!("hook:{}", record.agent));
    let tags = {
        let found = tags_in_payload(&record.payload);
        (!found.is_empty()).then_some(found)
    };
    match status_kind_of(&record.event) {
        Some(AgentStatusKind::Exited) => Some(SessionEvent::Exit {
            at,
            source,
            tags,
            code: None,
            signal: None,
        }),
        Some(kind) => Some(SessionEvent::Status {
            at,
            source,
            tags,
            status: AgentStatus {
                kind,
                confidence: Confidence::Exact,
                detail: detail_of(&record.payload),
            },
        }),
        None if record.event == "Notification" => Some(SessionEvent::Attention {
            at,
            source,
            tags,
            detail: detail_of(&record.payload),
        }),
        None => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINE: &str = r#"{"v":1,"ts":1790000000,"session":"s1","agent":"claude","nonce":"n-abc","event":"PermissionRequest","payload":{"tool_name":"Bash"}}"#;

    #[test]
    fn a_spool_line_parses_and_maps_to_an_exact_status() {
        let record = parse_signal_line(LINE).unwrap();
        assert_eq!(record.agent, "claude");
        let event = to_session_event(&record, "n-abc").unwrap();
        assert_eq!(
            event,
            SessionEvent::Status {
                at: 1_790_000_000_000,
                source: Some("hook:claude".into()),
                tags: None,
                status: AgentStatus {
                    kind: AgentStatusKind::NeedsApproval,
                    confidence: Confidence::Exact,
                    detail: "Bash".into(),
                },
            }
        );
    }

    #[test]
    fn review_tags_in_a_prompt_travel_on_the_event_and_nothing_else_does() {
        assert_eq!(
            tags_in_text("[hermes-review #3] Please read /tmp/review-3.md"),
            vec!["hermes-review#3"]
        );
        assert_eq!(
            tags_in_text("[hermes-review #3] again [hermes-review #3] and [hermes-gate #12]"),
            vec!["hermes-review#3", "hermes-gate#12"]
        );
        assert!(tags_in_text("[hermes-review #]").is_empty());
        assert!(tags_in_text("[hermes-review 3]").is_empty());
        assert!(tags_in_text("[hermes- #3]").is_empty());
        assert!(tags_in_text("[hermes-review #x]").is_empty());
        assert!(tags_in_text("[hermes-review #3").is_empty());
        assert!(tags_in_text("no markers here").is_empty());
        // What `hi` writes: the markers as a list, no prompt text at all.
        let line = r#"{"v":1,"ts":1790000000,"session":"s1","agent":"claude","nonce":"n-abc","event":"UserPromptSubmit","payload":{"hermes_tags":["hermes-review#7","bogus","hermes-review#7"],"cwd":"/repo"}}"#;
        assert!(session_event_in_line(line, "other").is_none());
        assert!(session_event_in_line("garbage", "n-abc").is_none());
        match session_event_in_line(line, "n-abc").unwrap() {
            SessionEvent::Status {
                tags,
                status,
                source,
                ..
            } => {
                assert_eq!(tags, Some(vec!["hermes-review#7".to_string()]));
                assert_eq!(source.as_deref(), Some("hook:claude"));
                assert_eq!(status.kind, AgentStatusKind::Working);
                assert_eq!(status.confidence, Confidence::Exact);
                assert_eq!(status.detail, "");
            }
            other => panic!("unexpected {other:?}"),
        }
        // A string field with a marker in it still counts (another helper
        // may keep text), and the two sources are merged without doubles.
        let mut payload = Map::new();
        payload.insert("hermes_tags".into(), serde_json::json!(["hermes-review#7"]));
        payload.insert(
            "title".into(),
            Value::String("[hermes-review #7] and [hermes-gate #1]".into()),
        );
        assert_eq!(
            tags_in_payload(&payload),
            vec!["hermes-review#7", "hermes-gate#1"]
        );
        // A turn's end comes through the same door, without tags.
        let stop = r#"{"v":1,"ts":1790000001,"session":"s1","agent":"claude","nonce":"n-abc","event":"Stop","payload":{}}"#;
        match session_event_in_line(stop, "n-abc").unwrap() {
            SessionEvent::Status { tags, status, .. } => {
                assert_eq!(tags, None);
                assert_eq!(status.kind, AgentStatusKind::DoneUnread);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn a_wrong_nonce_is_never_exact() {
        let record = parse_signal_line(LINE).unwrap();
        assert_eq!(to_session_event(&record, "another"), None);
    }

    #[test]
    fn malformed_lines_are_refused() {
        assert!(parse_signal_line("not json").is_err());
        assert!(parse_signal_line(
            r#"{"v":2,"ts":1,"session":"s","agent":"a","nonce":"n","event":"Stop"}"#
        )
        .is_err());
        assert!(parse_signal_line(
            r#"{"v":1,"ts":1,"session":"","agent":"a","nonce":"n","event":"Stop"}"#
        )
        .is_err());
        assert!(
            parse_signal_line(r#"{"v":1,"ts":1,"session":"s","agent":"a","nonce":"n"}"#).is_err()
        );
    }

    #[test]
    fn the_status_map_covers_the_report() {
        assert_eq!(status_kind_of("Stop"), Some(AgentStatusKind::DoneUnread));
        assert_eq!(
            status_kind_of("ExitPlanMode"),
            Some(AgentStatusKind::PlanReady)
        );
        assert_eq!(status_kind_of("SessionEnd"), Some(AgentStatusKind::Exited));
        assert_eq!(status_kind_of("Notification"), None);
        assert_eq!(status_kind_of("SomethingNew"), None);
        let mut record = parse_signal_line(LINE).unwrap();
        record.event = "Notification".into();
        record.payload = serde_json::from_str(r#"{"message":"waiting for input"}"#).unwrap();
        assert!(matches!(
            to_session_event(&record, "n-abc"),
            Some(SessionEvent::Attention { detail, .. }) if detail == "waiting for input"
        ));
        record.event = "SomethingNew".into();
        assert_eq!(to_session_event(&record, "n-abc"), None);
    }
}
