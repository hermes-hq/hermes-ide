//! Terminal notifications as a status fallback (F11).
//!
//! Agents that cannot be given a hook per launch, and agents on a remote
//! host, still print terminal notifications: OSC 9 (iTerm2 style), OSC 99
//! (kitty) and OSC 777 (rxvt/ghostty `notify`). The PTY parser collects
//! them (`analyzer.rs`) and this module turns each one into events.
//!
//! Anything printed to a terminal is untrusted: any program, or any host
//! the user is connected to, can print it. So the text is capped, control
//! characters are stripped, and a notification is never `exact`. The one
//! exception is the in-band marker Claude prints from a Hermes hook over
//! SSH (`notify;hermes-signal;v1:<nonce>:<event>`): when it carries the
//! nonce Hermes minted for that launch it is the hook itself speaking, and
//! it maps exactly like a spool line. A marker with any other nonce is
//! attention, nothing more.

use crate::contract::signal::{map_signal_record, SignalRecord};
use crate::contract::{AgentStatus, AgentStatusKind, Confidence, SessionEvent};

/// Longest notification text Hermes keeps, in characters.
pub const MAX_NOTIFICATION_CHARS: usize = 200;
/// The title of the in-band hook marker.
pub const MARKER_TITLE: &str = "hermes-signal";

/// One notification the terminal printed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalNotification {
    /// The OSC number it came in on: 9, 99 or 777.
    pub osc: u16,
    pub title: String,
    pub body: String,
}

/// Text as Hermes keeps it: valid UTF-8 (lossy), no control characters,
/// runs of blanks collapsed, at most [`MAX_NOTIFICATION_CHARS`].
pub fn sanitize(raw: &[u8]) -> String {
    let text = String::from_utf8_lossy(raw);
    let mut out = String::new();
    let mut blank = false;
    for c in text.chars() {
        if c.is_whitespace() {
            if !blank && !out.is_empty() {
                out.push(' ');
            }
            blank = true;
            continue;
        }
        if c.is_control() || ('\u{80}'..='\u{9f}').contains(&c) || c == '\u{fffd}' {
            continue;
        }
        blank = false;
        out.push(c);
    }
    let trimmed = out.trim_end();
    trimmed.chars().take(MAX_NOTIFICATION_CHARS).collect()
}

/// The status a vendor's notification text means, from the phrases the
/// agents print (Codex: "Approval requested", "Question requested", "Agent
/// turn complete"; Gemini: "needs your attention", "session complete";
/// Claude: "needs your permission", "waiting for your input"). None when
/// the text says nothing Hermes recognises.
pub fn classify(text: &str) -> Option<AgentStatusKind> {
    let t = text.to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| t.contains(n));
    if has(&[
        "approval requested",
        "needs your permission",
        "permission needed",
        "permission required",
        "wants to edit",
        "wants to run",
        "needs your attention",
        "needs your approval",
        "approve",
    ]) {
        return Some(AgentStatusKind::NeedsApproval);
    }
    if has(&[
        "question requested",
        "waiting for your input",
        "needs your input",
        "waiting for input",
        "question",
    ]) {
        return Some(AgentStatusKind::NeedsAnswer);
    }
    if has(&[
        "turn complete",
        "session complete",
        "finished responding",
        "run finished",
        "task complete",
        "task done",
        "is done",
        "completed",
    ]) {
        return Some(AgentStatusKind::DoneUnread);
    }
    if has(&["error", "failed", "failure"]) {
        return Some(AgentStatusKind::Error);
    }
    None
}

/// The nonce and event of an in-band marker body (`v1:<nonce>:<event>`).
fn parse_marker(body: &str) -> Option<(&str, &str)> {
    let rest = body.strip_prefix("v1:")?;
    let (nonce, event) = rest.split_once(':')?;
    if nonce.is_empty()
        || event.is_empty()
        || !event
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
    {
        return None;
    }
    Some((nonce, event))
}

/// The events one notification means for a session whose agent is `agent`
/// (the catalog id, or "terminal" for a plain shell) and whose current
/// launch nonce is `nonce` (None when no hooks were configured).
pub fn notification_events(
    n: &TerminalNotification,
    agent: &str,
    nonce: Option<&str>,
    at: i64,
) -> Vec<SessionEvent> {
    if n.osc == 777 && n.title == MARKER_TITLE {
        if let (Some((marker_nonce, event)), Some(expected)) = (parse_marker(&n.body), nonce) {
            if marker_nonce == expected {
                let record = SignalRecord {
                    v: 1,
                    ts: at / 1000,
                    session: String::new(),
                    agent: agent.to_string(),
                    nonce: expected.to_string(),
                    event: event.to_string(),
                    payload: Default::default(),
                };
                let mut events = map_signal_record(
                    &record,
                    expected,
                    Confidence::Exact,
                    &format!("hook:{agent}:osc"),
                );
                // The record's timestamp is whole seconds; keep the real one.
                for e in &mut events {
                    match e {
                        SessionEvent::Status { at: t, .. }
                        | SessionEvent::Identity { at: t, .. }
                        | SessionEvent::Attention { at: t, .. }
                        | SessionEvent::Exit { at: t, .. }
                        | SessionEvent::Subagents { at: t, .. }
                        | SessionEvent::TurnStart { at: t, .. }
                        | SessionEvent::TurnEnd { at: t, .. }
                        | SessionEvent::TurnFailed { at: t, .. }
                        | SessionEvent::TurnInterrupted { at: t, .. } => *t = at,
                    }
                }
                return events;
            }
        }
        // A marker without this launch's nonce: something printed it, and
        // that is all Hermes knows.
        return vec![SessionEvent::Attention {
            at,
            source: Some("osc".to_string()),
            detail: format!("{} (unverified)", n.body),
        }];
    }
    let text = if n.title.is_empty() {
        n.body.clone()
    } else if n.body.is_empty() {
        n.title.clone()
    } else {
        format!("{}: {}", n.title, n.body)
    };
    let text: String = text.chars().take(MAX_NOTIFICATION_CHARS).collect();
    let mut events = vec![SessionEvent::Attention {
        at,
        source: Some("osc".to_string()),
        detail: text.clone(),
    }];
    if let Some(kind) = classify(&text) {
        events.push(SessionEvent::Status {
            at,
            source: Some("osc".to_string()),
            status: AgentStatus {
                kind,
                confidence: Confidence::Signal,
                detail: text,
            },
        });
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(osc: u16, title: &str, body: &str) -> TerminalNotification {
        TerminalNotification {
            osc,
            title: title.into(),
            body: body.into(),
        }
    }

    #[test]
    fn text_is_capped_and_stripped_of_control_characters() {
        let raw = b"Approval\x1b[31m requested:\x07 rm\t-rf   node_modules\r\n";
        assert_eq!(sanitize(raw), "Approval[31m requested: rm -rf node_modules");
        let long = "x".repeat(5000);
        assert_eq!(
            sanitize(long.as_bytes()).chars().count(),
            MAX_NOTIFICATION_CHARS
        );
        assert_eq!(sanitize(b"\xff\xfe bad utf8 \xc3\x28"), "bad utf8 (");
        assert_eq!(sanitize(b"   "), "");
    }

    #[test]
    fn vendor_phrases_become_signal_statuses_never_exact() {
        let cases = [
            (
                "Approval requested: rm -rf node_modules",
                AgentStatusKind::NeedsApproval,
            ),
            (
                "Codex wants to edit src/main.rs",
                AgentStatusKind::NeedsApproval,
            ),
            (
                "Gemini CLI needs your attention | Tool | run_shell_command",
                AgentStatusKind::NeedsApproval,
            ),
            ("Question requested", AgentStatusKind::NeedsAnswer),
            (
                "Claude is waiting for your input",
                AgentStatusKind::NeedsAnswer,
            ),
            ("Agent turn complete", AgentStatusKind::DoneUnread),
            (
                "Gemini CLI session complete | Run finished | done",
                AgentStatusKind::DoneUnread,
            ),
            ("Build failed", AgentStatusKind::Error),
        ];
        for (text, kind) in cases {
            let events = notification_events(&n(9, "", text), "codex", Some("n1"), 5);
            assert_eq!(events.len(), 2, "{text}");
            assert!(
                matches!(&events[0], SessionEvent::Attention { detail, source, .. } if detail == text && source.as_deref() == Some("osc"))
            );
            match &events[1] {
                SessionEvent::Status { status, source, at } => {
                    assert_eq!(status.kind, kind, "{text}");
                    assert_eq!(status.confidence, Confidence::Signal);
                    assert_eq!(status.detail, text);
                    assert_eq!(source.as_deref(), Some("osc"));
                    assert_eq!(*at, 5);
                }
                other => panic!("{text}: {other:?}"),
            }
        }
        assert_eq!(classify("hello there"), None);
        let events = notification_events(&n(777, "fake-agent", "hello there"), "custom", None, 1);
        assert_eq!(events.len(), 1, "unknown text is attention only");
        assert!(
            matches!(&events[0], SessionEvent::Attention { detail, .. } if detail == "fake-agent: hello there")
        );
    }

    #[test]
    fn the_in_band_marker_is_exact_only_with_this_launches_nonce() {
        let good = n(777, MARKER_TITLE, "v1:n0nce:PermissionRequest");
        let events = notification_events(&good, "claude", Some("n0nce"), 7_000);
        assert_eq!(events.len(), 1);
        assert!(
            matches!(&events[0], SessionEvent::Status { at: 7_000, source, status }
            if source.as_deref() == Some("hook:claude:osc")
            && status.kind == AgentStatusKind::NeedsApproval
            && status.confidence == Confidence::Exact)
        );
        let stop = n(777, MARKER_TITLE, "v1:n0nce:Stop");
        assert!(
            matches!(&notification_events(&stop, "claude", Some("n0nce"), 1)[0],
            SessionEvent::Status { status, .. } if status.kind == AgentStatusKind::DoneUnread)
        );

        for (marker, nonce) in [
            (
                n(777, MARKER_TITLE, "v1:other:PermissionRequest"),
                Some("n0nce"),
            ),
            (n(777, MARKER_TITLE, "v1:n0nce:PermissionRequest"), None),
            (n(777, MARKER_TITLE, "garbage"), Some("n0nce")),
            (n(777, MARKER_TITLE, "v1:n0nce:Bad Event;x"), Some("n0nce")),
        ] {
            let events = notification_events(&marker, "claude", nonce, 1);
            assert_eq!(events.len(), 1, "{marker:?}");
            assert!(
                matches!(&events[0], SessionEvent::Attention { source, detail, .. } if source.as_deref() == Some("osc") && detail.ends_with("(unverified)")),
                "{marker:?}: {events:?}"
            );
        }
        // The same words on OSC 9 are a vendor notification, not a marker.
        let osc9 = n(9, "", "hermes-signal;v1:n0nce:PermissionRequest");
        assert!(notification_events(&osc9, "claude", Some("n0nce"), 1)
            .iter()
            .all(|e| !matches!(e, SessionEvent::Status { status, .. } if status.confidence == Confidence::Exact)));
    }
}
