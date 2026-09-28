//! Hermes 2.0 contracts (docs/adr/004-2.0-contracts.md): the Rust mirror of
//! `src/agent/contract/`.
//!
//! - [`AgentStatus`]: one status vocabulary for every agent, with how sure
//!   Hermes is about it.
//! - [`SessionEvent`]: what a session reports. Rust emits every event on one
//!   Tauri channel, [`SESSION_EVENT_CHANNEL`], as `{ sessionId, event }`; the
//!   frontend folds it into its per-session store.
//! - `signal`: the `hi signal` spool record and its mapping to events.
//! - `turns`: the turn ledger seam (types, ref names, empty commands).
//!
//! The wire format is pinned by `src/agent/contract/fixtures/session-events.json`,
//! which the tests here and the frontend tests both read. Later features may
//! only ADD variants and fields; nothing here is renamed or removed.

pub mod signal;
pub mod turns;

use serde::{Deserialize, Serialize};
use std::num::NonZeroU32;
use tauri::{AppHandle, Emitter};

/// Every status a session can be in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatusKind {
    NeedsApproval,
    NeedsAnswer,
    Gate,
    CheckFailed,
    Error,
    Limited,
    PlanReady,
    DoneUnread,
    Working,
    StartupPrompt,
    Starting,
    Idle,
    Exited,
}

/// How sure Hermes is: `exact` is a nonce-verified hook or protocol event,
/// `signal` a notification any program could print, `guessed` a PTY heuristic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    Exact,
    Signal,
    Guessed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentStatus {
    pub kind: AgentStatusKind,
    pub confidence: Confidence,
    /// One line for people; empty when there is nothing to say.
    #[serde(default)]
    pub detail: String,
}

/// What a session reports. `at` is epoch milliseconds; `source` names where
/// the event came from ("hook:claude", "osc", "pty", "plugin:<id>", "e2e").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionEvent {
    Status {
        at: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        status: AgentStatus,
    },
    TurnStart {
        at: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        n: NonZeroU32,
    },
    TurnEnd {
        at: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        n: NonZeroU32,
    },
    TurnFailed {
        at: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        n: NonZeroU32,
        detail: String,
    },
    TurnInterrupted {
        at: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        n: NonZeroU32,
    },
    Attention {
        at: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        detail: String,
    },
    #[serde(rename_all = "camelCase")]
    Identity {
        at: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        vendor_session_id: Option<String>,
        model: Option<String>,
        permission_mode: Option<String>,
    },
    Exit {
        at: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        code: Option<i32>,
        signal: Option<String>,
    },
}

/// The one Tauri event every SessionEvent travels on.
pub const SESSION_EVENT_CHANNEL: &str = "hermes:session-event";

/// The payload on [`SESSION_EVENT_CHANNEL`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEventEnvelope {
    pub session_id: String,
    pub event: SessionEvent,
}

/// Send one event to the frontend store. Never fails the caller: a closed
/// window has nobody to tell.
pub fn emit_session_event(app: &AppHandle, session_id: &str, event: SessionEvent) {
    let envelope = SessionEventEnvelope {
        session_id: session_id.to_string(),
        event,
    };
    if let Err(e) = app.emit(SESSION_EVENT_CHANNEL, &envelope) {
        log::warn!("[contract] could not emit session event for {session_id}: {e}");
    }
}

/// Test builds only (cargo feature `e2e`): let a real-app scenario push an
/// event through the Rust side of the channel, so the proof covers serde,
/// the Tauri event and the frontend parser together. A malformed event is
/// refused here, before anything is emitted.
#[cfg(feature = "e2e")]
#[tauri::command]
pub fn emit_session_event_for_test(
    app: AppHandle,
    session_id: String,
    event: serde_json::Value,
) -> Result<(), String> {
    if session_id.is_empty() {
        return Err("session id is empty".to_string());
    }
    let event: SessionEvent =
        serde_json::from_value(event).map_err(|e| format!("not a SessionEvent: {e}"))?;
    emit_session_event(&app, &session_id, event);
    Ok(())
}

/// The same command in a normal build: refuses, so the frontend's own event
/// bus can never be driven from outside a test build.
#[cfg(not(feature = "e2e"))]
#[tauri::command]
pub fn emit_session_event_for_test(
    _session_id: String,
    _event: serde_json::Value,
) -> Result<(), String> {
    Err("only available in a test build".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    /// Shared with src/__tests__/contract-events.test.ts.
    const FIXTURE: &str = include_str!("../../../src/agent/contract/fixtures/session-events.json");

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE).expect("fixture is JSON")
    }

    #[test]
    fn every_status_in_the_fixture_round_trips() {
        let statuses = fixture()["statuses"].as_array().unwrap().clone();
        assert_eq!(statuses.len(), 13, "one per AgentStatusKind");
        for raw in statuses {
            let status: AgentStatus = serde_json::from_value(raw.clone()).unwrap();
            assert_eq!(serde_json::to_value(&status).unwrap(), raw);
        }
    }

    #[test]
    fn every_event_in_the_fixture_round_trips_byte_for_byte_as_json() {
        let events = fixture()["events"].as_array().unwrap().clone();
        assert_eq!(events.len(), 10);
        let mut seen = std::collections::BTreeSet::new();
        for raw in events {
            let event: SessionEvent =
                serde_json::from_value(raw.clone()).unwrap_or_else(|e| panic!("{raw}: {e}"));
            assert_eq!(serde_json::to_value(&event).unwrap(), raw);
            seen.insert(raw["type"].as_str().unwrap().to_string());
        }
        assert_eq!(seen.len(), 8, "every variant appears: {seen:?}");
    }

    #[test]
    fn every_rejected_entry_in_the_fixture_is_refused() {
        for raw in fixture()["rejected"].as_array().unwrap() {
            assert!(
                serde_json::from_value::<SessionEvent>(raw.clone()).is_err(),
                "should be refused: {raw}"
            );
        }
    }

    #[test]
    fn unknown_fields_are_tolerated_so_a_newer_producer_is_readable() {
        let raw = json!({ "type": "turn_end", "at": 1, "n": 4, "futureField": true });
        let event: SessionEvent = serde_json::from_value(raw).unwrap();
        assert!(matches!(event, SessionEvent::TurnEnd { n, .. } if n.get() == 4));
    }

    #[test]
    fn the_envelope_uses_camel_case_like_the_frontend_expects() {
        let envelope = SessionEventEnvelope {
            session_id: "s1".into(),
            event: SessionEvent::Attention {
                at: 5,
                source: Some("e2e".into()),
                detail: "hello".into(),
            },
        };
        assert_eq!(
            serde_json::to_value(&envelope).unwrap(),
            json!({ "sessionId": "s1", "event": { "type": "attention", "at": 5, "source": "e2e", "detail": "hello" } })
        );
    }
}
