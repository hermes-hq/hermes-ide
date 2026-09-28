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
//!
//! [`map_signal_record`] is the one table that turns a vendor's own event
//! names (Claude, Codex, Gemini, Copilot, Antigravity, goose, OpenCode) into
//! Hermes events; F11 owns it. The shared fixture
//! `src/agent/contract/fixtures/signal-records.json` pins it on both sides.

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

/// Vendor event name -> status, by the name alone. None: not a status by
/// itself (or one that depends on the payload; see [`map_signal_record`]).
pub fn status_kind_of(event: &str) -> Option<AgentStatusKind> {
    Some(match event {
        "UserPromptSubmit" | "BeforeAgent" | "PostToolUse" | "PostToolUseFailure"
        | "PostToolBatch" | "PermissionDenied" | "PreToolUse" | "session.status" => {
            AgentStatusKind::Working
        }
        "PermissionRequest" | "permission.asked" => AgentStatusKind::NeedsApproval,
        "AskUserQuestion" | "Question" => AgentStatusKind::NeedsAnswer,
        "ExitPlanMode" => AgentStatusKind::PlanReady,
        "Stop"
        | "AfterAgent"
        | "agentStop"
        | "agent-turn-complete"
        | "TurnEnd"
        | "session.idle" => AgentStatusKind::DoneUnread,
        "StopFailure" | "errorOccurred" | "ErrorOccurred" | "Failure" | "Error"
        | "session.error" => AgentStatusKind::Error,
        "SessionEnd" | "hermes.exited" => AgentStatusKind::Exited,
        "hermes.resume_fallback" => AgentStatusKind::Starting,
        "SessionStart" => AgentStatusKind::Idle,
        _ => return None,
    })
}

fn payload_str<'a>(payload: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    match payload.get(key) {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim()),
        _ => None,
    }
}

fn cap(s: &str) -> String {
    s.chars().take(200).collect()
}

fn detail_of(payload: &Map<String, Value>) -> String {
    for key in ["message", "tool_name", "toolName", "question", "reason"] {
        if let Some(s) = payload_str(payload, key) {
            return cap(s);
        }
    }
    String::new()
}

fn error_detail(payload: &Map<String, Value>) -> String {
    for key in ["error", "message", "reason"] {
        if let Some(s) = payload_str(payload, key) {
            return cap(s);
        }
    }
    String::new()
}

/// The agent's own conversation id, whatever the vendor calls it.
pub fn vendor_session_id(payload: &Map<String, Value>) -> Option<String> {
    [
        "session_id",
        "sessionId",
        "thread-id",
        "thread_id",
        "conversationId",
        "vendor_session_id",
    ]
    .iter()
    .find_map(|k| payload_str(payload, k))
    .map(str::to_string)
}

/// +1 for a sub-agent starting, -1 for one stopping, 0 otherwise. The
/// spool watcher keeps the running count and emits `subagents` events.
pub fn subagent_delta(record: &SignalRecord) -> i32 {
    match record.event.as_str() {
        "SubagentStart" | "subagentStart" => 1,
        "SubagentStop" | "subagentStop" => -1,
        _ => 0,
    }
}

/// The status a `Notification` means, from its `notification_type`. None:
/// attention only (an idle reminder, an auth notice, something unknown).
fn notification_status(payload: &Map<String, Value>) -> Option<AgentStatusKind> {
    match payload_str(payload, "notification_type")? {
        "permission_prompt" | "ToolPermission" => Some(AgentStatusKind::NeedsApproval),
        "elicitation_dialog" | "elicitation_url_dialog" | "agent_needs_input" => {
            Some(AgentStatusKind::NeedsAnswer)
        }
        "agent_completed" => Some(AgentStatusKind::DoneUnread),
        _ => None,
    }
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
/// launch's nonce (see [`to_session_event`]). None for a foreign, malformed
/// or meaningless line.
pub fn session_event_in_line(line: &str, expected_nonce: &str) -> Option<SessionEvent> {
    let record = parse_signal_line(line).ok()?;
    to_session_event(&record, expected_nonce)
}

/// Put the payload's markers (F21) on an event; nothing when there are none.
fn with_tags(mut event: SessionEvent, found: Vec<String>) -> SessionEvent {
    if found.is_empty() {
        return event;
    }
    match &mut event {
        SessionEvent::Status { tags, .. }
        | SessionEvent::TurnStart { tags, .. }
        | SessionEvent::TurnEnd { tags, .. }
        | SessionEvent::TurnFailed { tags, .. }
        | SessionEvent::TurnInterrupted { tags, .. }
        | SessionEvent::Attention { tags, .. }
        | SessionEvent::Identity { tags, .. }
        | SessionEvent::Exit { tags, .. }
        | SessionEvent::Subagents { tags, .. } => *tags = Some(found),
    }
    event
}

/// Every event a nonce-verified record means: an `identity` when the record
/// names the vendor's conversation, then the status, attention or exit it
/// stands for. Empty when the nonce does not match (untrusted text) or the
/// event carries no meaning for Hermes (a sub-agent event: see
/// [`subagent_delta`]).
///
/// `confidence` is the agent's (the catalog's `signals.confidence`): `exact`
/// for a vendor whose hooks fire only when the state is real, `signal` for
/// one whose notification can fire for an already-approved tool (Copilot).
/// `source` names where the record came from ("hook:claude"; the in-band
/// terminal marker uses "hook:claude:osc"). The status, attention or exit
/// carries the payload's `tags` (F21) when it has any.
pub fn map_signal_record(
    record: &SignalRecord,
    expected_nonce: &str,
    confidence: Confidence,
    source: &str,
) -> Vec<SessionEvent> {
    if record.nonce != expected_nonce {
        return Vec::new();
    }
    let at = record.ts.saturating_mul(1000);
    let source = Some(source.to_string());
    let payload = &record.payload;
    let status = |kind: AgentStatusKind, detail: String| SessionEvent::Status {
        at,
        source: source.clone(),
        tags: None,
        status: AgentStatus {
            kind,
            confidence,
            detail,
        },
    };
    let mut out = Vec::new();
    if matches!(
        record.event.as_str(),
        "SessionStart" | "hermes.resume_fallback" | "agent-turn-complete"
    ) {
        let id = vendor_session_id(payload);
        let mode = payload_str(payload, "permission_mode").map(str::to_string);
        if id.is_some() || mode.is_some() {
            out.push(SessionEvent::Identity {
                at,
                source: source.clone(),
                tags: None,
                vendor_session_id: id,
                model: None,
                permission_mode: mode,
            });
        }
    }
    let primary = match record.event.as_str() {
        "PreToolUse" => match payload_str(payload, "tool_name") {
            Some("AskUserQuestion") => status(AgentStatusKind::NeedsAnswer, detail_of(payload)),
            Some("ExitPlanMode") => status(AgentStatusKind::PlanReady, String::new()),
            _ => status(AgentStatusKind::Working, String::new()),
        },
        "Notification" => match notification_status(payload) {
            Some(kind) => status(kind, detail_of(payload)),
            None => SessionEvent::Attention {
                at,
                source: source.clone(),
                tags: None,
                detail: detail_of(payload),
            },
        },
        // Antigravity's Stop fires after every execution: only `fullyIdle`
        // means the turn is over, and `error` means it failed.
        "Stop" if payload.get("fullyIdle").is_some() || payload.get("error").is_some() => {
            if payload_str(payload, "error").is_some() {
                status(AgentStatusKind::Error, error_detail(payload))
            } else if payload.get("fullyIdle") == Some(&Value::Bool(false)) {
                status(AgentStatusKind::Working, String::new())
            } else {
                status(AgentStatusKind::DoneUnread, String::new())
            }
        }
        "hermes.exited" => SessionEvent::Exit {
            at,
            source: source.clone(),
            tags: None,
            code: payload
                .get("exit_code")
                .and_then(Value::as_i64)
                .and_then(|c| i32::try_from(c).ok()),
            signal: None,
        },
        other => match status_kind_of(other) {
            Some(AgentStatusKind::Exited) => SessionEvent::Exit {
                at,
                source: source.clone(),
                tags: None,
                code: None,
                signal: None,
            },
            Some(AgentStatusKind::Error) => status(AgentStatusKind::Error, error_detail(payload)),
            Some(kind @ AgentStatusKind::NeedsApproval) => status(kind, detail_of(payload)),
            Some(kind @ AgentStatusKind::NeedsAnswer) => status(kind, detail_of(payload)),
            Some(kind) => status(kind, String::new()),
            None => return out,
        },
    };
    // F21: machine markers in what the agent reported ride on the event
    // they came with (never on the identity).
    out.push(with_tags(primary, tags_in_payload(payload)));
    out
}

/// The one SessionEvent a record means (its status, attention or exit;
/// never the identity), with `exact` confidence, or None when the nonce
/// does not match or the event carries no meaning for Hermes.
pub fn to_session_event(record: &SignalRecord, expected_nonce: &str) -> Option<SessionEvent> {
    map_signal_record(
        record,
        expected_nonce,
        Confidence::Exact,
        &format!("hook:{}", record.agent),
    )
    .into_iter()
    .find(|e| !matches!(e, SessionEvent::Identity { .. }))
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
        assert!(map_signal_record(&record, "another", Confidence::Exact, "hook:claude").is_empty());
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

    #[test]
    fn subagent_events_only_move_the_counter() {
        let mut record = parse_signal_line(LINE).unwrap();
        record.event = "SubagentStart".into();
        assert_eq!(subagent_delta(&record), 1);
        assert!(map_signal_record(&record, "n-abc", Confidence::Exact, "hook:claude").is_empty());
        record.event = "SubagentStop".into();
        assert_eq!(subagent_delta(&record), -1);
        record.event = "Stop".into();
        assert_eq!(subagent_delta(&record), 0);
    }

    /// Shared with src/__tests__/contract-signal.test.ts: every case maps to
    /// exactly the listed events on both sides.
    const FIXTURE: &str = include_str!("../../../src/agent/contract/fixtures/signal-records.json");

    #[test]
    fn the_shared_fixture_maps_the_same_on_both_sides() {
        let cases: Vec<Value> = serde_json::from_str::<Value>(FIXTURE).unwrap()["cases"]
            .as_array()
            .unwrap()
            .clone();
        assert!(cases.len() >= 20, "the fixture covers every agent");
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let record: SignalRecord = serde_json::from_value(case["record"].clone())
                .unwrap_or_else(|e| panic!("{name}: {e}"));
            let confidence: Confidence =
                serde_json::from_value(case["confidence"].clone()).unwrap();
            let nonce = case["nonce"].as_str().unwrap();
            let source = format!("hook:{}", record.agent);
            let got = map_signal_record(&record, nonce, confidence, &source);
            let got_json: Vec<Value> = got
                .iter()
                .map(|e| serde_json::to_value(e).unwrap())
                .collect();
            assert_eq!(
                got_json,
                case["events"].as_array().unwrap().clone(),
                "case {name}"
            );
            assert_eq!(
                subagent_delta(&record),
                case["subagentDelta"].as_i64().unwrap_or(0) as i32,
                "case {name} subagent delta"
            );
        }
    }
}
