//! N19: usage limits the agents report, turned into session events.
//!
//! A session is `limited` only when the agent itself says so through a
//! nonce-verified hook (so the status is `exact`); Hermes never guesses a
//! limit from terminal text. What the vendors report, per the signals
//! report and the installed Claude Code 2.1.283 (strings in the binary):
//!
//! - `StopFailure` with `error: "rate_limit"` — the turn ended on the limit.
//! - `Notification` with `notification_type` `quota_auto_resume_stale` or
//!   `quota_auto_resume_disabled` — still limited, it will not resume on its
//!   own; `quota_auto_resume_fired` — the limit reset and the agent goes on.
//! - The status line input's `rate_limits` — one entry per window
//!   (`five_hour`, `seven_day`, ...) with `used_percentage` and `resets_at`.
//!   That is the only place the reset time comes from; when the agent does
//!   not report it, the limit has no reset time (null), never a guess.
//!
//! Activity after a limit (a new prompt, a tool call, a turn that ends
//! normally) clears it. Agents that report none of this (every agent but
//! Claude today) are simply never `limited`.
//!
//! [`LimitTracker`] is fed every spool line of a launch by the signal
//! watcher (`pty::launch::watch_signals`) and returns the events to emit.

use serde_json::{Map, Value};

use crate::contract::signal::SignalRecord;
use crate::contract::{AgentStatus, AgentStatusKind, Confidence, LimitState, SessionEvent};

/// One limit window as the agent reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct LimitWindow {
    /// The vendor's name: `five_hour`, `seven_day`, `spend_limit`...
    pub name: String,
    /// Share of the window used, 0–100, when reported.
    pub used_percent: Option<f64>,
    /// When the window resets, epoch milliseconds, when reported.
    pub resets_at_ms: Option<i64>,
}

/// What one spool record says about limits.
#[derive(Debug, Clone, PartialEq)]
pub enum LimitSignal {
    /// The agent stopped on its usage limit.
    Limited,
    /// The agent is working again; the status it is in now.
    Cleared(AgentStatusKind),
    /// The agent process is gone, with its exit status when reported.
    Ended(Option<i32>),
    /// Fresh numbers for the limit windows (the status line).
    Windows(Vec<LimitWindow>),
    /// Nothing about limits.
    Nothing,
}

/// A reset time as a vendor writes it: epoch seconds, epoch milliseconds,
/// or an RFC 3339 / ISO 8601 timestamp.
pub fn parse_reset_time(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => {
            let f = n.as_f64()?;
            if !f.is_finite() || f <= 0.0 {
                return None;
            }
            // Anything past the year 33658 in seconds is milliseconds.
            Some(if f >= 1e12 {
                f as i64
            } else {
                (f * 1000.0) as i64
            })
        }
        Value::String(s) => {
            let s = s.trim();
            if let Ok(n) = s.parse::<f64>() {
                return parse_reset_time(&serde_json::json!(n));
            }
            chrono::DateTime::parse_from_rfc3339(s)
                .ok()
                .map(|d| d.timestamp_millis())
        }
        _ => None,
    }
}

/// The windows of a `rate_limits` object, in name order.
pub fn parse_rate_limits(v: &Value) -> Vec<LimitWindow> {
    let Some(map) = v.as_object() else {
        return Vec::new();
    };
    let mut out: Vec<LimitWindow> = map
        .iter()
        .filter_map(|(name, w)| {
            let w = w.as_object()?;
            let used_percent = w
                .get("used_percentage")
                .or_else(|| w.get("utilization"))
                .and_then(Value::as_f64)
                .filter(|p| p.is_finite());
            let resets_at_ms = w.get("resets_at").and_then(parse_reset_time);
            if used_percent.is_none() && resets_at_ms.is_none() {
                return None;
            }
            Some(LimitWindow {
                name: name.clone(),
                used_percent,
                resets_at_ms,
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// The window the agent is most likely blocked on at `now_ms`: of the
/// windows that are used up, the one that resets last (the agent can go on
/// only once every used-up window has reset); when none says it is used up
/// (the numbers are a turn old), the fullest one. Windows whose reset time
/// has already passed are stale and never chosen.
pub fn blocking_window(windows: &[LimitWindow], now_ms: i64) -> Option<&LimitWindow> {
    let live: Vec<&LimitWindow> = windows
        .iter()
        .filter(|w| w.resets_at_ms.is_some_and(|r| r > now_ms))
        .collect();
    let exhausted = live
        .iter()
        .filter(|w| w.used_percent.is_some_and(|p| p >= 100.0))
        .max_by_key(|w| w.resets_at_ms);
    if let Some(w) = exhausted {
        return Some(w);
    }
    live.into_iter().max_by(|a, b| {
        a.used_percent
            .unwrap_or(0.0)
            .total_cmp(&b.used_percent.unwrap_or(0.0))
    })
}

fn payload_str<'a>(payload: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    payload.get(key).and_then(Value::as_str)
}

/// What a record says about limits. Vendor event names live here and in
/// the agent catalog's `limited` entry only.
pub fn classify(record: &SignalRecord) -> LimitSignal {
    let payload = &record.payload;
    if let Some(rl) = payload.get("rate_limits") {
        return LimitSignal::Windows(parse_rate_limits(rl));
    }
    match record.event.as_str() {
        "StopFailure" => match payload_str(payload, "error") {
            Some("rate_limit") => LimitSignal::Limited,
            _ => LimitSignal::Nothing,
        },
        "Notification" => match payload_str(payload, "notification_type") {
            Some("quota_auto_resume_stale") | Some("quota_auto_resume_disabled") => {
                LimitSignal::Limited
            }
            Some("quota_auto_resume_fired") => LimitSignal::Cleared(AgentStatusKind::Working),
            _ => LimitSignal::Nothing,
        },
        "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PostToolUseFailure" => {
            LimitSignal::Cleared(AgentStatusKind::Working)
        }
        "Stop" => LimitSignal::Cleared(AgentStatusKind::DoneUnread),
        "SessionEnd" => LimitSignal::Ended(None),
        "hermes.exited" => LimitSignal::Ended(
            payload
                .get("exit_code")
                .and_then(Value::as_i64)
                .and_then(|c| i32::try_from(c).ok()),
        ),
        _ => LimitSignal::Nothing,
    }
}

/// Follows one launch's spool and says when the session enters, updates or
/// leaves a limit. Stateful because the reset time and the stop arrive in
/// different records.
#[derive(Debug, Default)]
pub struct LimitTracker {
    windows: Vec<LimitWindow>,
    limited: bool,
    /// What the last `limit` event said (reset, window), to send an update
    /// only when it changes.
    reported: Option<(Option<i64>, Option<String>)>,
}

impl LimitTracker {
    pub fn new() -> Self {
        Self::default()
    }

    #[cfg(test)]
    pub fn is_limited(&self) -> bool {
        self.limited
    }

    fn limit_event(&mut self, at: i64, source: &Option<String>) -> Option<SessionEvent> {
        let chosen = blocking_window(&self.windows, at);
        let report = (
            chosen.and_then(|w| w.resets_at_ms),
            chosen.map(|w| w.name.clone()),
        );
        if self.reported.as_ref() == Some(&report) {
            return None;
        }
        self.reported = Some(report.clone());
        Some(SessionEvent::Limit {
            at,
            source: source.clone(),
            tags: None,
            state: LimitState::Limited,
            resets_at: report.0,
            window: report.1,
        })
    }

    /// The events one spool record leads to (none for a record of another
    /// launch: its nonce is not this launch's).
    pub fn observe(&mut self, record: &SignalRecord, nonce: &str) -> Vec<SessionEvent> {
        if record.nonce != nonce {
            return Vec::new();
        }
        let at = record.ts.saturating_mul(1000);
        let source = Some(format!("hook:{}", record.agent));
        let mut out = Vec::new();
        match classify(record) {
            LimitSignal::Windows(windows) => {
                self.windows = windows;
                if self.limited {
                    out.extend(self.limit_event(at, &source));
                }
            }
            LimitSignal::Limited => {
                let entering = !self.limited;
                self.limited = true;
                out.extend(self.limit_event(at, &source));
                if entering {
                    out.push(SessionEvent::Status {
                        at,
                        source: source.clone(),
                        tags: None,
                        status: AgentStatus {
                            kind: AgentStatusKind::Limited,
                            confidence: Confidence::Exact,
                            detail: String::new(),
                        },
                    });
                }
            }
            LimitSignal::Cleared(kind) => {
                if self.limited {
                    self.limited = false;
                    self.reported = None;
                    out.push(cleared(at, &source));
                    out.push(SessionEvent::Status {
                        at,
                        source,
                        tags: None,
                        status: AgentStatus {
                            kind,
                            confidence: Confidence::Exact,
                            detail: String::new(),
                        },
                    });
                }
            }
            LimitSignal::Ended(code) => {
                // A limited session whose agent is gone is exited, not
                // limited: clear the limit and say the process ended, so
                // no "limited" tag or inbox item outlives the agent.
                if self.limited {
                    self.limited = false;
                    self.reported = None;
                    out.push(cleared(at, &source));
                    out.push(SessionEvent::Exit {
                        at,
                        source,
                        tags: None,
                        code,
                        signal: None,
                    });
                }
            }
            LimitSignal::Nothing => {}
        }
        out
    }
}

fn cleared(at: i64, source: &Option<String>) -> SessionEvent {
    SessionEvent::Limit {
        at,
        source: source.clone(),
        tags: None,
        state: LimitState::Cleared,
        resets_at: None,
        window: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::signal::parse_signal_line;
    use serde_json::json;

    const NONCE: &str = "n-1";
    const T0: i64 = 1_790_000_000; // epoch seconds of the first record

    fn line(ts: i64, event: &str, payload: Value) -> SignalRecord {
        let raw = json!({
            "v": 1, "ts": ts, "session": "s1", "agent": "claude",
            "nonce": NONCE, "event": event, "payload": payload,
        });
        parse_signal_line(&raw.to_string()).unwrap()
    }

    fn status_line(ts: i64, five_used: f64, five_reset_s: i64) -> SignalRecord {
        line(
            ts,
            "StatusLine",
            json!({ "rate_limits": {
                "five_hour": { "used_percentage": five_used, "resets_at": five_reset_s },
                "seven_day": { "used_percentage": 41.0, "resets_at": T0 + 5 * 86_400 },
            }}),
        )
    }

    fn rate_limit_stop(ts: i64) -> SignalRecord {
        line(
            ts,
            "StopFailure",
            json!({ "hook_event_name": "StopFailure", "error": "rate_limit" }),
        )
    }

    #[test]
    fn reset_times_parse_in_every_shape_vendors_use() {
        assert_eq!(
            parse_reset_time(&json!(1_790_000_000)),
            Some(1_790_000_000_000)
        );
        assert_eq!(
            parse_reset_time(&json!(1_790_000_000_123_i64)),
            Some(1_790_000_000_123)
        );
        assert_eq!(
            parse_reset_time(&json!("1790000000")),
            Some(1_790_000_000_000)
        );
        assert_eq!(
            parse_reset_time(&json!("2026-09-28T14:00:00Z")),
            Some(1_790_604_000_000)
        );
        assert_eq!(
            parse_reset_time(&json!("2026-09-28T16:00:00+02:00")),
            Some(1_790_604_000_000)
        );
        assert_eq!(parse_reset_time(&json!("tomorrow")), None);
        assert_eq!(parse_reset_time(&json!(-5)), None);
        assert_eq!(parse_reset_time(&json!(null)), None);
    }

    #[test]
    fn a_rate_limited_stop_after_a_status_line_is_limited_with_the_reset_time() {
        let mut t = LimitTracker::new();
        let reset = T0 + 7_200;
        assert!(
            t.observe(&status_line(T0, 100.0, reset), NONCE).is_empty(),
            "numbers alone are not a limit"
        );
        let events = t.observe(&rate_limit_stop(T0 + 1), NONCE);
        assert_eq!(
            events,
            vec![
                SessionEvent::Limit {
                    at: (T0 + 1) * 1000,
                    source: Some("hook:claude".into()),
                    tags: None,
                    state: LimitState::Limited,
                    resets_at: Some(reset * 1000),
                    window: Some("five_hour".into()),
                },
                SessionEvent::Status {
                    at: (T0 + 1) * 1000,
                    source: Some("hook:claude".into()),
                    tags: None,
                    status: AgentStatus {
                        kind: AgentStatusKind::Limited,
                        confidence: Confidence::Exact,
                        detail: String::new(),
                    },
                },
            ]
        );
        assert!(t.is_limited());
    }

    #[test]
    fn without_any_numbers_the_limit_has_no_reset_time() {
        let mut t = LimitTracker::new();
        let events = t.observe(&rate_limit_stop(T0), NONCE);
        assert!(matches!(
            &events[0],
            SessionEvent::Limit {
                state: LimitState::Limited,
                resets_at: None,
                window: None,
                ..
            }
        ));
        assert!(matches!(
            &events[1],
            SessionEvent::Status { status, .. } if status.kind == AgentStatusKind::Limited
        ));
    }

    #[test]
    fn other_stop_failures_are_not_limits() {
        let mut t = LimitTracker::new();
        for error in [
            "server_error",
            "overloaded",
            "authentication_failed",
            "billing_error",
        ] {
            let rec = line(T0, "StopFailure", json!({ "error": error }));
            assert!(t.observe(&rec, NONCE).is_empty(), "{error}");
        }
        assert!(!t.is_limited());
    }

    #[test]
    fn a_record_of_another_launch_is_ignored() {
        let mut t = LimitTracker::new();
        assert!(t.observe(&rate_limit_stop(T0), "another-nonce").is_empty());
        assert!(!t.is_limited());
    }

    #[test]
    fn a_later_status_line_updates_the_reset_time_once() {
        let mut t = LimitTracker::new();
        t.observe(&rate_limit_stop(T0), NONCE);
        let later = t.observe(&status_line(T0 + 2, 100.0, T0 + 3_600), NONCE);
        assert_eq!(later.len(), 1, "only the limit event, no second status");
        assert!(matches!(
            &later[0],
            SessionEvent::Limit { resets_at: Some(r), .. } if *r == (T0 + 3_600) * 1000
        ));
        // The same numbers again change nothing.
        assert!(t
            .observe(&status_line(T0 + 3, 100.0, T0 + 3_600), NONCE)
            .is_empty());
    }

    #[test]
    fn activity_after_the_limit_clears_it() {
        for (event, payload, kind) in [
            ("UserPromptSubmit", json!({}), AgentStatusKind::Working),
            (
                "Notification",
                json!({ "notification_type": "quota_auto_resume_fired" }),
                AgentStatusKind::Working,
            ),
            ("Stop", json!({}), AgentStatusKind::DoneUnread),
        ] {
            let mut t = LimitTracker::new();
            t.observe(&rate_limit_stop(T0), NONCE);
            let out = t.observe(&line(T0 + 60, event, payload), NONCE);
            assert_eq!(out.len(), 2, "{event}");
            assert!(matches!(
                &out[0],
                SessionEvent::Limit {
                    state: LimitState::Cleared,
                    resets_at: None,
                    ..
                }
            ));
            assert!(
                matches!(&out[1], SessionEvent::Status { status, .. } if status.kind == kind),
                "{event}"
            );
            assert!(!t.is_limited());
            // Activity when not limited says nothing (that is F11's status).
            assert!(t
                .observe(&line(T0 + 61, event, json!({})), NONCE)
                .is_empty());
        }
    }

    #[test]
    fn quota_notifications_that_do_not_resume_keep_the_limit() {
        let mut t = LimitTracker::new();
        let out = t.observe(
            &line(
                T0,
                "Notification",
                json!({ "notification_type": "quota_auto_resume_disabled" }),
            ),
            NONCE,
        );
        assert_eq!(out.len(), 2);
        let again = t.observe(
            &line(
                T0 + 1,
                "Notification",
                json!({ "notification_type": "quota_auto_resume_stale" }),
            ),
            NONCE,
        );
        assert!(again.is_empty(), "already limited, nothing new to say");
        assert!(t.is_limited());
        let other = t.observe(
            &line(
                T0 + 2,
                "Notification",
                json!({ "notification_type": "permission_prompt" }),
            ),
            NONCE,
        );
        assert!(other.is_empty());
    }

    #[test]
    fn the_agent_ending_clears_the_limit_and_reports_the_exit() {
        for (event, payload, code) in [
            ("hermes.exited", json!({ "exit_code": 3 }), Some(3)),
            ("SessionEnd", json!({ "reason": "prompt_input_exit" }), None),
        ] {
            let mut t = LimitTracker::new();
            t.observe(&rate_limit_stop(T0), NONCE);
            let out = t.observe(&line(T0 + 5, event, payload), NONCE);
            assert_eq!(
                out,
                vec![
                    SessionEvent::Limit {
                        at: (T0 + 5) * 1000,
                        source: Some("hook:claude".into()),
                        tags: None,
                        state: LimitState::Cleared,
                        resets_at: None,
                        window: None,
                    },
                    SessionEvent::Exit {
                        at: (T0 + 5) * 1000,
                        source: Some("hook:claude".into()),
                        tags: None,
                        code,
                        signal: None,
                    },
                ],
                "{event}"
            );
            assert!(!t.is_limited());
            // The exit report after SessionEnd adds nothing.
            assert!(t
                .observe(
                    &line(T0 + 6, "hermes.exited", json!({ "exit_code": 0 })),
                    NONCE
                )
                .is_empty());
        }
    }

    #[test]
    fn an_agent_ending_while_not_limited_says_nothing_here() {
        let mut t = LimitTracker::new();
        let out = t.observe(&line(T0, "hermes.exited", json!({ "exit_code": 0 })), NONCE);
        assert!(out.is_empty(), "exit without a limit is F11's status");
    }

    #[test]
    fn the_blocking_window_is_the_used_up_one_that_resets_last() {
        let now = T0 * 1000;
        let w = |name: &str, used: f64, reset_s: i64| LimitWindow {
            name: name.into(),
            used_percent: Some(used),
            resets_at_ms: Some(reset_s * 1000),
        };
        let both = vec![
            w("five_hour", 100.0, T0 + 3_600),
            w("seven_day", 100.0, T0 + 86_400),
        ];
        assert_eq!(blocking_window(&both, now).unwrap().name, "seven_day");
        let one = vec![
            w("five_hour", 100.0, T0 + 3_600),
            w("seven_day", 60.0, T0 + 86_400),
        ];
        assert_eq!(blocking_window(&one, now).unwrap().name, "five_hour");
        // Numbers a turn old (97%): the fullest window.
        let stale = vec![
            w("five_hour", 97.0, T0 + 3_600),
            w("seven_day", 60.0, T0 + 86_400),
        ];
        assert_eq!(blocking_window(&stale, now).unwrap().name, "five_hour");
        // A window whose reset already passed is never the answer.
        let past = vec![w("five_hour", 100.0, T0 - 10)];
        assert_eq!(blocking_window(&past, now), None);
        assert_eq!(blocking_window(&[], now), None);
    }

    #[test]
    fn rate_limits_accept_utilization_and_iso_times_and_skip_junk() {
        let windows = parse_rate_limits(&json!({
            "five_hour": { "utilization": 100, "resets_at": "2026-09-28T14:00:00Z" },
            "junk": "nope",
            "empty": {},
        }));
        assert_eq!(
            windows,
            vec![LimitWindow {
                name: "five_hour".into(),
                used_percent: Some(100.0),
                resets_at_ms: Some(1_790_604_000_000),
            }]
        );
        assert!(parse_rate_limits(&json!(null)).is_empty());
    }
}
