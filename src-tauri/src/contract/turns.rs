//! Turn ledger seam (contract C0; mirror of src/agent/contract/turns.ts).
//!
//! F20 fills it: at the end of every agent turn Hermes snapshots the
//! worktree into `refs/hermes/<session>/turn/<n>` and records the turn in
//! the `agent_turns` table (schema step 3, db/migrations.rs). Until then the
//! commands answer with nothing: `list_turns` -> `[]`, `get_turn_diff` -> `null`.

use serde::{Deserialize, Serialize};

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

/// Turns of a session, oldest first. Empty until F20 lands.
#[tauri::command]
pub fn list_turns(session_id: String) -> Result<Vec<Turn>, String> {
    if !is_turn_ref_session_id(&session_id) {
        return Err(format!("not a session id: {session_id:?}"));
    }
    Ok(Vec::new())
}

/// The diff of one turn, or None when there is no such turn (always, until F20).
#[tauri::command]
pub fn get_turn_diff(session_id: String, n: u32) -> Result<Option<TurnDiff>, String> {
    if turn_ref(&session_id, n).is_none() {
        return Err(format!("not a turn: {session_id:?} #{n}"));
    }
    Ok(None)
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
    fn the_commands_answer_with_nothing_but_still_validate_their_input() {
        assert_eq!(list_turns("sess-1".into()).unwrap(), Vec::<Turn>::new());
        assert!(list_turns("no/slash".into()).is_err());
        assert_eq!(get_turn_diff("sess-1".into(), 1).unwrap(), None);
        assert!(get_turn_diff("sess-1".into(), 0).is_err());
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
        };
        assert_eq!(
            serde_json::to_value(&turn).unwrap(),
            serde_json::json!({
                "sessionId": "s1", "n": 2, "ref": "refs/hermes/s1/turn/2",
                "startedAt": 10, "endedAt": null,
                "diffstat": { "files": 0, "insertions": 0, "deletions": 0 }
            })
        );
    }
}
