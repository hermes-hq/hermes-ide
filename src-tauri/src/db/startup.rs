//! What the window shows when Hermes cannot open its database.
//!
//! Setup records the problem here instead of failing, so the user gets a
//! readable explanation (and a Quit button) rather than a window that never
//! appears. While a problem is recorded nothing else is initialised, so
//! nothing can write to the database or the files next to it.

use serde::Serialize;
use std::path::Path;
use tauri::State;

use super::migrations::OpenError;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartupProblem {
    /// "newer-data" | "backup-failed" | "migration-failed" | "open-failed"
    pub kind: &'static str,
    pub title: &'static str,
    pub message: String,
    /// The database file Hermes tried to open.
    pub data_path: String,
    /// Values the window fills into its translated text. `title` and
    /// `message` above are the English wording, used when no translation
    /// applies.
    pub found: Option<i64>,
    pub supported: Option<i64>,
    /// "<number>: <name>" of the update step that failed.
    pub step: Option<String>,
    /// The underlying error, shown as is (it comes from the OS or SQLite).
    pub detail: Option<String>,
}

impl StartupProblem {
    pub fn from_open_error(err: &OpenError, db_path: &Path) -> Self {
        let (kind, title) = match err {
            OpenError::NewerSchema { .. } => {
                ("newer-data", "Your data is from a newer version of Hermes")
            }
            OpenError::Backup(_) => ("backup-failed", "Hermes could not back up your data"),
            OpenError::Migration { .. } => {
                ("migration-failed", "Hermes could not update your data")
            }
            OpenError::Sqlite(_) => ("open-failed", "Hermes could not open your data"),
        };
        let (found, supported, step, detail) = match err {
            OpenError::NewerSchema { found, supported } => {
                (Some(*found), Some(*supported), None, None)
            }
            OpenError::Backup(e) | OpenError::Sqlite(e) => (None, None, None, Some(e.clone())),
            OpenError::Migration {
                version,
                name,
                error,
            } => (
                None,
                None,
                Some(format!("{version}: {name}")),
                Some(error.clone()),
            ),
        };
        Self {
            kind,
            title,
            message: err.to_string(),
            data_path: db_path.display().to_string(),
            found,
            supported,
            step,
            detail,
        }
    }
}

/// Managed in every run; `None` when the database opened normally.
pub struct StartupProblemState(pub Option<StartupProblem>);

impl super::Database {
    /// Fold the write-ahead log into the database file and empty it, so
    /// after a clean quit the `.db` file alone holds everything (CHAOS-14:
    /// it used to stay in the `-wal` until the next start, and a copy or
    /// backup of the `.db` alone looked empty). The next start opens it
    /// as it is.
    pub fn checkpoint_wal(&self) -> Result<(), String> {
        self.conn
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn get_startup_problem(state: State<'_, StartupProblemState>) -> Option<StartupProblem> {
    state.0.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_checkpoint_leaves_everything_in_the_database_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.db");
        let db = super::super::Database::new(&path).unwrap();
        db.set_setting("theme", "frosted-dark").unwrap();
        db.checkpoint_wal().unwrap();
        let wal = dir.path().join("data.db-wal");
        let wal_len = std::fs::metadata(&wal).map(|m| m.len()).unwrap_or(0);
        assert_eq!(wal_len, 0, "the log is empty");
        // The .db file alone has the setting.
        let copy = dir.path().join("copy.db");
        std::fs::copy(&path, &copy).unwrap();
        let conn = rusqlite::Connection::open(&copy).unwrap();
        let theme: String = conn
            .query_row("SELECT value FROM settings WHERE key = 'theme'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(theme, "frosted-dark");
    }

    #[test]
    fn newer_schema_problem_names_both_versions_and_promises_no_change() {
        let p = StartupProblem::from_open_error(
            &OpenError::NewerSchema {
                found: 7,
                supported: 1,
            },
            Path::new("/data/hermes_idea_v3.db"),
        );
        assert_eq!(p.kind, "newer-data");
        assert!(p.title.contains("newer version"));
        assert!(p.message.contains("data version 7"));
        assert!(p.message.contains("up to 1"));
        assert!(p.message.contains("has not opened or changed it"));
        assert_eq!(p.data_path, "/data/hermes_idea_v3.db");
        assert_eq!((p.found, p.supported), (Some(7), Some(1)));
        assert_eq!((p.step, p.detail), (None, None));
    }

    #[test]
    fn failed_step_and_error_are_passed_separately_for_translation() {
        let p = StartupProblem::from_open_error(
            &OpenError::Migration {
                version: 2,
                name: "add_widgets",
                error: "disk I/O error".into(),
            },
            Path::new("x.db"),
        );
        assert_eq!(p.step.as_deref(), Some("2: add_widgets"));
        assert_eq!(p.detail.as_deref(), Some("disk I/O error"));
        assert_eq!((p.found, p.supported), (None, None));

        let p = StartupProblem::from_open_error(
            &OpenError::Backup("disk full".into()),
            Path::new("x.db"),
        );
        assert_eq!(p.detail.as_deref(), Some("disk full"));
        assert_eq!(p.step, None);
    }

    #[test]
    fn each_open_error_maps_to_its_own_kind() {
        let path = Path::new("x.db");
        let kinds: Vec<&str> = [
            OpenError::Backup("disk full".into()),
            OpenError::Migration {
                version: 2,
                name: "step",
                error: "boom".into(),
            },
            OpenError::Sqlite("not a database".into()),
        ]
        .iter()
        .map(|e| StartupProblem::from_open_error(e, path).kind)
        .collect();
        assert_eq!(
            kinds,
            vec!["backup-failed", "migration-failed", "open-failed"]
        );
    }

    #[test]
    fn serializes_with_camel_case_fields_for_the_frontend() {
        let p = StartupProblem::from_open_error(&OpenError::Sqlite("x".into()), Path::new("a.db"));
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["kind"], "open-failed");
        assert_eq!(json["dataPath"], "a.db");
        assert!(json["message"].as_str().unwrap().contains("could not open"));
        assert_eq!(json["detail"], "x");
        assert!(json["found"].is_null());
    }
}
