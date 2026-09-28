//! What each landing did, kept so it can be undone: one JSON file per
//! landing under `<app data>/land/`. The git side of the same promise is the
//! pre-land references (`refs/hermes/<session>/land/<n>/…`).

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LandMode {
    /// Commit on the task branch only.
    Commit,
    /// Commit, push and open a pull request.
    Pr,
    /// Commit and squash-merge into the base branch locally.
    Merge,
    /// Archive only (nothing to commit).
    Archive,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LandRecord {
    /// `<session>-<n>`.
    pub id: String,
    pub n: u32,
    pub session_id: String,
    pub project_id: String,
    pub repo_path: String,
    pub worktree_path: String,
    pub branch: String,
    /// The session's label, reused when an archive is restored.
    #[serde(default)]
    pub label: String,
    pub mode: LandMode,
    pub created_at: i64,
    /// The branch's commit before landing.
    pub branch_before: String,
    /// The branch's commit after committing (same as before when there was
    /// nothing to commit).
    #[serde(default)]
    pub branch_after: Option<String>,
    #[serde(default)]
    pub base: Option<String>,
    #[serde(default)]
    pub base_before: Option<String>,
    /// The squash commit on the base (local merge).
    #[serde(default)]
    pub merged_commit: Option<String>,
    #[serde(default)]
    pub remote: Option<String>,
    /// What the remote branch pointed at before the push (None: it did not exist).
    #[serde(default)]
    pub remote_before: Option<String>,
    /// What Hermes pushed, when it pushed.
    #[serde(default)]
    pub pushed: Option<String>,
    #[serde(default)]
    pub pr_url: Option<String>,
    #[serde(default)]
    pub archived: bool,
    /// Undo steps already done, so a retry only does the rest.
    #[serde(default)]
    pub undone_steps: Vec<String>,
    #[serde(default)]
    pub undone: bool,
}

pub fn dir(app_data: &Path) -> PathBuf {
    app_data.join("land")
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 160
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn path(app_data: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err(format!("Not a landing id: {id:?}"));
    }
    Ok(dir(app_data).join(format!("{id}.json")))
}

pub fn save(app_data: &Path, rec: &LandRecord) -> Result<(), String> {
    let p = path(app_data, &rec.id)?;
    fs::create_dir_all(dir(app_data)).map_err(|e| format!("Could not save the landing: {e}"))?;
    let tmp = p.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(rec).map_err(|e| e.to_string())?;
    fs::write(&tmp, text).map_err(|e| format!("Could not save the landing: {e}"))?;
    fs::rename(&tmp, &p).map_err(|e| format!("Could not save the landing: {e}"))
}

pub fn load(app_data: &Path, id: &str) -> Result<LandRecord, String> {
    let p = path(app_data, id)?;
    let text = fs::read_to_string(&p).map_err(|_| format!("No landing {id}"))?;
    serde_json::from_str(&text).map_err(|e| format!("Landing {id} can't be read: {e}"))
}

/// Every landing of a session, oldest first.
pub fn list_for_session(app_data: &Path, session_id: &str) -> Vec<LandRecord> {
    let Ok(entries) = fs::read_dir(dir(app_data)) else {
        return Vec::new();
    };
    let prefix = format!("{session_id}-");
    let mut out: Vec<LandRecord> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let id = name.strip_suffix(".json")?;
            let n = id.strip_prefix(&prefix)?;
            n.parse::<u32>().ok()?;
            load(app_data, id).ok()
        })
        .filter(|r| r.session_id == session_id)
        .collect();
    out.sort_by_key(|r| r.n);
    out
}

pub fn next_n(app_data: &Path, session_id: &str) -> u32 {
    list_for_session(app_data, session_id)
        .last()
        .map(|r| r.n + 1)
        .unwrap_or(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn rec(n: u32) -> LandRecord {
        LandRecord {
            id: format!("s1-{n}"),
            n,
            session_id: "s1".into(),
            project_id: "p".into(),
            repo_path: "/r".into(),
            worktree_path: "/w".into(),
            branch: "hermes/x".into(),
            label: "Task".into(),
            mode: LandMode::Merge,
            created_at: 1,
            branch_before: "a".into(),
            branch_after: Some("b".into()),
            base: Some("main".into()),
            base_before: Some("c".into()),
            merged_commit: None,
            remote: None,
            remote_before: None,
            pushed: None,
            pr_url: None,
            archived: false,
            undone_steps: vec![],
            undone: false,
        }
    }

    #[test]
    fn records_round_trip_and_number_per_session() {
        let d = TempDir::new().unwrap();
        assert_eq!(next_n(d.path(), "s1"), 1);
        save(d.path(), &rec(1)).unwrap();
        save(d.path(), &rec(2)).unwrap();
        assert_eq!(load(d.path(), "s1-2").unwrap(), rec(2));
        assert_eq!(next_n(d.path(), "s1"), 3);
        assert_eq!(
            next_n(d.path(), "s10"),
            1,
            "another session's files don't count"
        );
        assert_eq!(
            list_for_session(d.path(), "s1")
                .iter()
                .map(|r| r.n)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
    }

    #[test]
    fn ids_cannot_leave_the_folder() {
        let d = TempDir::new().unwrap();
        assert!(load(d.path(), "../etc/passwd").is_err());
        assert!(path(d.path(), "a/b").is_err());
    }
}
