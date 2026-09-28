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

/// The SessionEvent a record means, or None when the nonce does not match
/// or the event carries no meaning for Hermes yet.
pub fn to_session_event(record: &SignalRecord, expected_nonce: &str) -> Option<SessionEvent> {
    if record.nonce != expected_nonce {
        return None;
    }
    let at = record.ts.saturating_mul(1000);
    let source = Some(format!("hook:{}", record.agent));
    match status_kind_of(&record.event) {
        Some(AgentStatusKind::Exited) => Some(SessionEvent::Exit {
            at,
            source,
            code: None,
            signal: None,
        }),
        Some(kind) => Some(SessionEvent::Status {
            at,
            source,
            status: AgentStatus {
                kind,
                confidence: Confidence::Exact,
                detail: detail_of(&record.payload),
            },
        }),
        None if record.event == "Notification" => Some(SessionEvent::Attention {
            at,
            source,
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
                status: AgentStatus {
                    kind: AgentStatusKind::NeedsApproval,
                    confidence: Confidence::Exact,
                    detail: "Bash".into(),
                },
            }
        );
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
