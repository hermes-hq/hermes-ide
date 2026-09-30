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

/// A finite, non-negative amount of US dollars, exactly as a vendor reported
/// it (F31). Refused on the wire when negative, infinite or not a number, so
/// it can be compared for equality like the rest of an event.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Usd(f64);

// Every value is finite by construction (see `Usd::new`), so equality is total.
impl Eq for Usd {}

impl Usd {
    pub fn new(value: f64) -> Option<Self> {
        (value.is_finite() && value >= 0.0).then_some(Self(value))
    }

    pub fn get(self) -> f64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for Usd {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = f64::deserialize(deserializer)?;
        Usd::new(value)
            .ok_or_else(|| serde::de::Error::custom("a cost must be a finite, non-negative number"))
    }
}

/// What a session reports. `at` is epoch milliseconds; `source` names where
/// the event came from ("hook:claude", "osc", "pty", "plugin:<id>", "e2e").
/// `tags` (F21, additive) are machine markers found in what the agent
/// reported, such as `hermes-review#3` for a `[hermes-review #3]` line in a
/// submitted prompt; never text for people.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionEvent {
    Status {
        at: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tags: Option<Vec<String>>,
        status: AgentStatus,
    },
    TurnStart {
        at: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tags: Option<Vec<String>>,
        n: NonZeroU32,
    },
    TurnEnd {
        at: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tags: Option<Vec<String>>,
        n: NonZeroU32,
    },
    TurnFailed {
        at: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tags: Option<Vec<String>>,
        n: NonZeroU32,
        detail: String,
    },
    TurnInterrupted {
        at: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tags: Option<Vec<String>>,
        n: NonZeroU32,
    },
    Attention {
        at: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tags: Option<Vec<String>>,
        detail: String,
    },
    #[serde(rename_all = "camelCase")]
    Identity {
        at: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tags: Option<Vec<String>>,
        vendor_session_id: Option<String>,
        model: Option<String>,
        permission_mode: Option<String>,
    },
    Exit {
        at: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tags: Option<Vec<String>>,
        code: Option<i32>,
        signal: Option<String>,
    },
    /// F11 (additive): how many of the agent's sub-agents are running right
    /// now, from the agent's own SubagentStart/SubagentStop hooks.
    Subagents {
        at: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tags: Option<Vec<String>>,
        running: u32,
    },
    /// Usage totals for the session so far, as the agent itself reports
    /// them (F31). A part the agent does not report is `None` ("n/a"); Hermes
    /// never fills one in with an estimate.
    #[serde(rename_all = "camelCase")]
    Usage {
        at: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tags: Option<Vec<String>>,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        cost_usd: Option<Usd>,
    },
    /// N19 (an addition to C0): the agent hit, or left, its vendor's usage
    /// limit. `resetsAt` (epoch ms) is when the vendor says the limit
    /// resets, or null when it did not say; `window` is the vendor's name
    /// for the limit that was hit ("five_hour", "seven_day"...), or null.
    /// A `limited` is sent together with a `status` event of kind
    /// `limited`, so the status stays the one thing every renderer reads.
    #[serde(rename_all = "camelCase")]
    Limit {
        at: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tags: Option<Vec<String>>,
        state: LimitState,
        resets_at: Option<i64>,
        window: Option<String>,
    },
    /// How full the context window is, as the agent reports it (F14): the
    /// input tokens of its last model call. `context_limit` is None when the
    /// model's window is unknown, so nobody shows a percentage for it. Not
    /// F31's `usage` (the session's totals): this is where the window stands.
    #[serde(rename_all = "camelCase")]
    Context {
        at: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tags: Option<Vec<String>>,
        used_tokens: u32,
        context_limit: Option<NonZeroU32>,
        model: Option<String>,
    },
    /// The agent compacted its context (F14).
    #[serde(rename_all = "camelCase")]
    Compacted {
        at: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tags: Option<Vec<String>>,
        trigger: Option<String>,
        pre_tokens: Option<u32>,
    },
    /// CAP (an addition to C0): the agent's CLI refused the launch within
    /// its first seconds (the catalog's `error_signatures` matched its
    /// output). Hermes stopped the launch; `vendor_message` is the CLI's own
    /// line, `suggestion` the action the session offers first.
    #[serde(rename_all = "camelCase")]
    LaunchRejected {
        at: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tags: Option<Vec<String>>,
        reason: RejectReason,
        vendor_message: String,
        suggestion: RejectSuggestion,
    },
}

/// Why a launch was refused ([`SessionEvent::LaunchRejected`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectReason {
    Model,
    Effort,
    SignedOut,
    Other,
}

/// What the session offers first after a refused launch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RejectSuggestion {
    RetryDefault,
    SwitchAccount,
    SignIn,
}

/// Whether a [`SessionEvent::Limit`] starts or ends a limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitState {
    Limited,
    Cleared,
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
        assert_eq!(events.len(), 22);
        let mut seen = std::collections::BTreeSet::new();
        for raw in events {
            let event: SessionEvent =
                serde_json::from_value(raw.clone()).unwrap_or_else(|e| panic!("{raw}: {e}"));
            assert_eq!(serde_json::to_value(&event).unwrap(), raw);
            seen.insert(raw["type"].as_str().unwrap().to_string());
        }
        assert_eq!(seen.len(), 14, "every variant appears: {seen:?}");
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
    fn a_usage_event_keeps_the_vendor_cost_and_refuses_a_bad_one() {
        let raw = json!({ "type": "usage", "at": 9, "inputTokens": 10, "outputTokens": null, "costUsd": 1.25 });
        let event: SessionEvent = serde_json::from_value(raw.clone()).unwrap();
        match &event {
            SessionEvent::Usage {
                input_tokens,
                output_tokens,
                cost_usd,
                ..
            } => {
                assert_eq!(*input_tokens, Some(10));
                assert_eq!(*output_tokens, None);
                assert_eq!(cost_usd.map(Usd::get), Some(1.25));
            }
            other => panic!("not a usage event: {other:?}"),
        }
        assert_eq!(serde_json::to_value(&event).unwrap(), raw);
        // Missing parts are "not reported", never zero.
        let sparse: SessionEvent =
            serde_json::from_value(json!({ "type": "usage", "at": 9 })).unwrap();
        assert!(matches!(
            sparse,
            SessionEvent::Usage {
                input_tokens: None,
                output_tokens: None,
                cost_usd: None,
                ..
            }
        ));
        assert!(Usd::new(f64::NAN).is_none());
        assert!(Usd::new(f64::INFINITY).is_none());
        assert!(Usd::new(-0.5).is_none());
        assert!(Usd::new(0.0).is_some());
    }

    #[test]
    fn the_envelope_uses_camel_case_like_the_frontend_expects() {
        let envelope = SessionEventEnvelope {
            session_id: "s1".into(),
            event: SessionEvent::Attention {
                at: 5,
                source: Some("e2e".into()),
                tags: None,
                detail: "hello".into(),
            },
        };
        assert_eq!(
            serde_json::to_value(&envelope).unwrap(),
            json!({ "sessionId": "s1", "event": { "type": "attention", "at": 5, "source": "e2e", "detail": "hello" } })
        );
    }
}
