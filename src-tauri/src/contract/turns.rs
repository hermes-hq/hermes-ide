//! Turn ledger seam (contract C0; mirror of src/agent/contract/turns.ts).
//!
//! F20 fills it (src/turn_ledger): at the end of every agent turn Hermes
//! snapshots the worktree into `refs/hermes/<session>/turn/<n>` and records
//! the turn in the `agent_turns` table (schema step 3, db/migrations.rs).
//! `list_turns` and `get_turn_diff` read that ledger; a session without
//! turns still answers `[]` / `null`.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diffstat {
    pub files: u32,
    pub insertions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub session_id: String,
    /// 1-based turn number within the session.
    pub n: u32,
    /// The hidden git reference holding the snapshot, see [`turn_ref`].
    #[serde(rename = "ref")]
    pub git_ref: String,
    /// Epoch milliseconds.
    pub started_at: i64,
    /// Epoch milliseconds; None while the turn is running.
    pub ended_at: Option<i64>,
    pub diffstat: Diffstat,
    /// F20 (additive): the snapshot ran past its budget, so this turn has a
    /// diffstat summary but no snapshot (`ref` is empty) and cannot be
    /// diffed or restored.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub degraded: bool,
    /// Done-When result at the end of this turn (F27, additive): None when
    /// no check ran. F20 fills it from the frontend's Done-When store
    /// (`checksForTurn` in `src/doneWhen/store.ts`), the one place that
    /// knows which turn a Stop-hook report belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checks: Option<TurnChecks>,
}

/// What the Done-When checks said about a turn (F27): "tests ✓" or the
/// commands that failed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnChecks {
    /// `passed`, `failed` or `error` (a done_when file could not be read).
    pub state: String,
    /// The commands that failed, in order; empty when they all passed.
    pub failed: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnDiff {
    pub turn: Turn,
    /// Unified diff of what the turn changed; empty for a no-change turn.
    pub patch: String,
}

pub const TURN_REF_PREFIX: &str = "refs/hermes/";

/// A session id must be safe inside a git ref name.
pub fn is_turn_ref_session_id(session_id: &str) -> bool {
    let mut chars = session_id.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    session_id.len() <= 128 && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// `refs/hermes/<session>/turn/<n>`; None for an id git would refuse or n = 0.
pub fn turn_ref(session_id: &str, n: u32) -> Option<String> {
    if !is_turn_ref_session_id(session_id) || n == 0 {
        return None;
    }
    Some(format!("{TURN_REF_PREFIX}{session_id}/turn/{n}"))
}

/// The inverse of [`turn_ref`]; None for any other ref.
pub fn parse_turn_ref(git_ref: &str) -> Option<(String, u32)> {
    let rest = git_ref.strip_prefix(TURN_REF_PREFIX)?;
    let (session, n) = rest.split_once("/turn/")?;
    if !is_turn_ref_session_id(session) || n.starts_with('0') {
        return None;
    }
    let n: u32 = n.parse().ok()?;
    (n > 0).then(|| (session.to_string(), n))
}

/// Turns of a session, oldest first; `[]` for a session without any.
#[tauri::command]
pub fn list_turns(app: AppHandle, session_id: String) -> Result<Vec<Turn>, String> {
    if !is_turn_ref_session_id(&session_id) {
        return Err(format!("not a session id: {session_id:?}"));
    }
    crate::turn_ledger::list_turns_for(&app, &session_id)
}

/// The diff of one turn, or None when there is no such turn.
#[tauri::command]
pub fn get_turn_diff(
    app: AppHandle,
    session_id: String,
    n: u32,
) -> Result<Option<TurnDiff>, String> {
    if turn_ref(&session_id, n).is_none() {
        return Err(format!("not a turn: {session_id:?} #{n}"));
    }
    crate::turn_ledger::turn_diff_for(&app, &session_id, n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refs_are_named_per_session_and_turn() {
        assert_eq!(
            turn_ref("sess-1", 3).as_deref(),
            Some("refs/hermes/sess-1/turn/3")
        );
        assert_eq!(turn_ref("sess-1", 0), None);
        assert_eq!(turn_ref("", 1), None);
        assert_eq!(turn_ref("has space", 1), None);
        assert_eq!(turn_ref("../escape", 1), None);
    }

    #[test]
    fn parse_is_the_inverse_of_turn_ref() {
        assert_eq!(
            parse_turn_ref("refs/hermes/sess-1/turn/3"),
            Some(("sess-1".to_string(), 3))
        );
        assert_eq!(parse_turn_ref("refs/heads/main"), None);
        assert_eq!(parse_turn_ref("refs/hermes/sess-1/turn/0"), None);
        assert_eq!(parse_turn_ref("refs/hermes/sess-1/turn/01"), None);
        assert_eq!(parse_turn_ref("refs/hermes/sess-1/turn/x"), None);
    }

    #[test]
    fn a_turn_serialises_with_the_frontend_field_names() {
        let turn = Turn {
            session_id: "s1".into(),
            n: 2,
            git_ref: turn_ref("s1", 2).unwrap(),
            started_at: 10,
            ended_at: None,
            diffstat: Diffstat::default(),
            degraded: false,
            checks: None,
        };
        assert_eq!(
            serde_json::to_value(&turn).unwrap(),
            serde_json::json!({
                "sessionId": "s1", "n": 2, "ref": "refs/hermes/s1/turn/2",
                "startedAt": 10, "endedAt": null,
                "diffstat": { "files": 0, "insertions": 0, "deletions": 0 }
            })
        );
        let degraded = Turn {
            degraded: true,
            git_ref: String::new(),
            ..turn
        };
        assert_eq!(serde_json::to_value(&degraded).unwrap()["degraded"], true);
        let back: Turn = serde_json::from_value(serde_json::json!({
            "sessionId": "s1", "n": 2, "ref": "refs/hermes/s1/turn/2",
            "startedAt": 10, "endedAt": null,
            "diffstat": { "files": 0, "insertions": 0, "deletions": 0 }
        }))
        .unwrap();
        assert!(
            !back.degraded,
            "an older row without the field reads as a full snapshot"
        );
    }

    #[test]
    fn a_turns_checks_are_an_optional_additive_field() {
        let with = Turn {
            session_id: "s1".into(),
            n: 1,
            git_ref: turn_ref("s1", 1).unwrap(),
            started_at: 1,
            ended_at: Some(2),
            diffstat: Diffstat::default(),
            degraded: false,
            checks: Some(TurnChecks {
                state: "failed".into(),
                failed: vec!["npm test".into()],
            }),
        };
        let v = serde_json::to_value(&with).unwrap();
        assert_eq!(
            v["checks"],
            serde_json::json!({ "state": "failed", "failed": ["npm test"] })
        );
        // A reader from before F27 (no `checks`) still reads it, and an old
        // row without it reads as None.
        let mut old = v.clone();
        old.as_object_mut().unwrap().remove("checks");
        let back: Turn = serde_json::from_value(old).unwrap();
        assert_eq!(back.checks, None);
    }
}
