//! Keeps sessions the user closed out of the saved workspace.
//!
//! The frontend writes the `saved_workspace` setting (sessions, layout,
//! notes) on a 10 s timer and when a window closes; the next launch restores
//! it. A session closed shortly before quitting was still in it, and quitting
//! through the app menu or `AppHandle::exit` never asked the frontend to save
//! again, so the closed session came back.
//!
//! The backend therefore remembers which sessions were closed in this run
//! and removes them from the saved workspace:
//!   - when the session is closed (`close_session`),
//!   - whenever the frontend writes the setting (an older snapshot still in
//!     flight cannot bring a closed session back),
//!   - once more when the app exits.

use std::collections::HashSet;
use std::sync::Mutex;

use serde_json::Value;

use crate::db::Database;

/// The setting that holds the saved workspace JSON.
pub const SETTING_KEY: &str = "saved_workspace";

/// Session ids closed since the app started.
#[derive(Default)]
pub struct ClosedSessions(Mutex<HashSet<String>>);

impl ClosedSessions {
    pub fn mark_closed(&self, id: &str) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.to_string());
    }

    /// A session created again under the same id is live again.
    pub fn mark_created(&self, id: &str) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    }

    pub fn snapshot(&self) -> HashSet<String> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

/// Remove the `closed` sessions from a saved workspace JSON.
///
/// Returns `None` when nothing changes (no closed session in it, or it is
/// not a workspace this code understands — then it is left alone), and
/// `Some("")` when no session is left, which is how the frontend writes an
/// empty workspace.
pub fn prune(saved: &str, closed: &HashSet<String>) -> Option<String> {
    if saved.is_empty() || closed.is_empty() {
        return None;
    }
    let mut ws: Value = serde_json::from_str(saved).ok()?;
    let obj = ws.as_object_mut()?;
    let sessions = obj.get_mut("sessions")?.as_array_mut()?;
    let before = sessions.len();
    sessions.retain(|s| {
        s.get("id")
            .and_then(Value::as_str)
            .is_none_or(|id| !closed.contains(id))
    });
    if sessions.len() == before {
        return None;
    }
    if sessions.is_empty() {
        // Dropping the layout and notes with the last session is not new
        // data loss: the frontend already writes "" when no session is live.
        return Some(String::new());
    }
    if let Some(notes) = obj.get_mut("notes").and_then(Value::as_object_mut) {
        notes.retain(|id, _| !closed.contains(id));
    }
    let active_closed = obj
        .get("active_session_id")
        .and_then(Value::as_str)
        .is_some_and(|id| closed.contains(id));
    if active_closed {
        obj.insert("active_session_id".into(), Value::Null);
    }
    // Panes of a removed session are dropped by the restore, which skips
    // every pane whose session it did not restore.
    serde_json::to_string(&ws).ok()
}

/// What to store when the frontend writes the saved workspace.
pub fn filter_incoming(value: String, closed: &HashSet<String>) -> String {
    prune(&value, closed).unwrap_or(value)
}

/// Rewrite the stored saved workspace without the `closed` sessions.
/// Returns whether it changed.
pub fn prune_stored(db: &Database, closed: &HashSet<String>) -> Result<bool, String> {
    let Some(saved) = db.get_setting(SETTING_KEY)? else {
        return Ok(false);
    };
    match prune(&saved, closed) {
        Some(pruned) => {
            db.set_setting(SETTING_KEY, &pruned)?;
            Ok(true)
        }
        None => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::NamedTempFile;

    fn ids(list: &[&str]) -> HashSet<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn workspace() -> Value {
        json!({
            "version": 2,
            "sessions": [
                { "id": "keep", "label": "Keep me", "working_directory": "/work/project" },
                { "id": "gone", "label": "Close me", "working_directory": "/work/project" }
            ],
            "layout": {
                "type": "split", "id": "s1", "direction": "horizontal", "ratio": 0.5,
                "children": [
                    { "type": "pane", "id": "p1", "sessionId": "keep" },
                    { "type": "pane", "id": "p2", "sessionId": "gone" }
                ]
            },
            "focused_pane_id": "p2",
            "active_session_id": "gone",
            "workbench": { "open": true },
            "notes": { "keep": "kept note", "gone": "dropped note" }
        })
    }

    fn session_ids(json: &str) -> Vec<String> {
        let v: Value = serde_json::from_str(json).unwrap();
        v["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["id"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn removes_a_closed_session_and_keeps_everything_else() {
        let out = prune(&workspace().to_string(), &ids(&["gone"])).expect("changed");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(session_ids(&out), vec!["keep"]);
        assert_eq!(v["sessions"][0]["label"], "Keep me");
        assert_eq!(v["notes"], json!({ "keep": "kept note" }));
        assert_eq!(v["active_session_id"], Value::Null);
        assert_eq!(v["version"], 2);
        assert_eq!(v["workbench"], json!({ "open": true }));
        assert_eq!(v["layout"], workspace()["layout"]);
    }

    #[test]
    fn keeps_the_active_session_when_it_was_not_closed() {
        let mut ws = workspace();
        ws["active_session_id"] = json!("keep");
        let out = prune(&ws.to_string(), &ids(&["gone"])).expect("changed");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["active_session_id"], "keep");
    }

    #[test]
    fn empties_the_workspace_when_every_session_was_closed() {
        let out = prune(&workspace().to_string(), &ids(&["gone", "keep"]));
        assert_eq!(out.as_deref(), Some(""));
    }

    #[test]
    fn leaves_it_alone_when_no_closed_session_is_in_it() {
        assert_eq!(prune(&workspace().to_string(), &ids(&["other"])), None);
        assert_eq!(prune(&workspace().to_string(), &ids(&[])), None);
    }

    #[test]
    fn leaves_empty_or_unknown_content_alone() {
        let closed = ids(&["gone"]);
        assert_eq!(prune("", &closed), None);
        assert_eq!(prune("not json", &closed), None);
        assert_eq!(prune("[]", &closed), None);
        assert_eq!(prune(r#"{"sessions":"x"}"#, &closed), None);
    }

    #[test]
    fn filter_incoming_drops_closed_sessions_from_a_late_write() {
        let late = workspace().to_string();
        assert_eq!(
            session_ids(&filter_incoming(late.clone(), &ids(&["gone"]))),
            vec!["keep"]
        );
        assert_eq!(filter_incoming(late.clone(), &ids(&[])), late);
    }

    #[test]
    fn closed_sessions_forget_an_id_created_again() {
        let closed = ClosedSessions::default();
        closed.mark_closed("a");
        closed.mark_closed("b");
        closed.mark_created("a");
        assert_eq!(closed.snapshot(), ids(&["b"]));
    }

    #[test]
    fn prune_stored_rewrites_the_setting() {
        let tmp = NamedTempFile::new().unwrap();
        let db = Database::new(tmp.path()).unwrap();
        assert!(
            !prune_stored(&db, &ids(&["gone"])).unwrap(),
            "nothing stored yet"
        );

        db.set_setting(SETTING_KEY, &workspace().to_string())
            .unwrap();
        assert!(prune_stored(&db, &ids(&["gone"])).unwrap());
        let stored = db.get_setting(SETTING_KEY).unwrap().unwrap();
        assert_eq!(session_ids(&stored), vec!["keep"]);

        assert!(
            !prune_stored(&db, &ids(&["gone"])).unwrap(),
            "already pruned"
        );
        assert!(prune_stored(&db, &ids(&["keep"])).unwrap());
        assert_eq!(db.get_setting(SETTING_KEY).unwrap().as_deref(), Some(""));
    }
}
