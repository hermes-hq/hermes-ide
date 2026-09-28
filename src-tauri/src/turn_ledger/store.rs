//! The `agent_turns` rows of the turn ledger (schema step 3, contract C0).

use crate::contract::turns::{Diffstat, Turn};
use crate::db::Database;
use rusqlite::params;
use std::path::PathBuf;

pub fn insert_turn(db: &Database, turn: &Turn) -> Result<(), String> {
    db.conn
        .execute(
            "INSERT OR REPLACE INTO agent_turns
                (session_id, n, git_ref, started_at, ended_at, files, insertions, deletions)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                turn.session_id,
                turn.n,
                turn.git_ref,
                turn.started_at,
                turn.ended_at,
                turn.diffstat.files,
                turn.diffstat.insertions,
                turn.diffstat.deletions,
            ],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// The turns of a session, oldest first.
pub fn list_turns(db: &Database, session_id: &str) -> Result<Vec<Turn>, String> {
    let mut stmt = db
        .conn
        .prepare(
            "SELECT session_id, n, git_ref, started_at, ended_at, files, insertions, deletions
             FROM agent_turns WHERE session_id = ?1 ORDER BY n ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![session_id], |r| {
            let git_ref: String = r.get(2)?;
            Ok(Turn {
                session_id: r.get(0)?,
                n: r.get(1)?,
                degraded: git_ref.is_empty(),
                git_ref,
                started_at: r.get(3)?,
                ended_at: r.get(4)?,
                diffstat: Diffstat {
                    files: r.get(5)?,
                    insertions: r.get(6)?,
                    deletions: r.get(7)?,
                },
                // Not stored: Done-When results live with the checks (F27);
                // list_turns_for puts them on.
                checks: None,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn get_turn(db: &Database, session_id: &str, n: u32) -> Result<Option<Turn>, String> {
    Ok(list_turns(db, session_id)?.into_iter().find(|t| t.n == n))
}

/// The highest turn number recorded for a session (0 when none).
pub fn max_n(db: &Database, session_id: &str) -> Result<u32, String> {
    db.conn
        .query_row(
            "SELECT COALESCE(MAX(n), 0) FROM agent_turns WHERE session_id = ?1",
            params![session_id],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n.max(0) as u32)
        .map_err(|e| e.to_string())
}

pub fn delete_turns(db: &Database, session_id: &str) -> Result<usize, String> {
    db.conn
        .execute(
            "DELETE FROM agent_turns WHERE session_id = ?1",
            params![session_id],
        )
        .map_err(|e| e.to_string())
}

/// A closed session whose turn refs are due for collection, with every
/// folder the refs might be reachable from (the session's working
/// directory, its worktree, the project folder its worktree belonged to).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpiredSession {
    pub session_id: String,
    pub candidates: Vec<PathBuf>,
}

/// Sessions with turns that were closed at or before `cutoff` (a SQLite
/// `datetime()` string in UTC, the format `sessions.closed_at` is written in).
pub fn expired_sessions(db: &Database, cutoff: &str) -> Result<Vec<ExpiredSession>, String> {
    let mut stmt = db
        .conn
        .prepare(
            "SELECT DISTINCT t.session_id, s.working_directory
             FROM agent_turns t
             JOIN sessions s ON s.id = t.session_id
             WHERE s.closed_at IS NOT NULL AND s.closed_at <= ?1
             ORDER BY t.session_id",
        )
        .map_err(|e| e.to_string())?;
    let base: Vec<(String, String)> = stmt
        .query_map(params![cutoff], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for (session_id, cwd) in base {
        let mut candidates = vec![PathBuf::from(cwd)];
        let mut wt = db
            .conn
            .prepare(
                "SELECT w.worktree_path, p.path
                 FROM session_worktrees w LEFT JOIN projects p ON p.id = w.realm_id
                 WHERE w.session_id = ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = wt
            .query_map(params![&session_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for row in rows.flatten() {
            candidates.push(PathBuf::from(row.0));
            if let Some(p) = row.1 {
                candidates.push(PathBuf::from(p));
            }
        }
        candidates.dedup();
        out.push(ExpiredSession {
            session_id,
            candidates,
        });
    }
    Ok(out)
}

#[cfg(test)]
pub(crate) mod testing {
    use super::*;

    pub fn open_db() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("test.db")).unwrap();
        (dir, db)
    }

    /// A minimal session row; `closed_at` as SQLite datetime text or None.
    pub fn insert_session(db: &Database, id: &str, cwd: &str, closed_at: Option<&str>) {
        db.conn
            .execute(
                "INSERT INTO sessions (id, label, phase, working_directory, shell, created_at, closed_at)
                 VALUES (?1, ?1, 'destroyed', ?2, 'sh', datetime('now'), ?3)",
                params![id, cwd, closed_at],
            )
            .unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;

    fn turn(sid: &str, n: u32, git_ref: &str) -> Turn {
        Turn {
            session_id: sid.into(),
            n,
            git_ref: git_ref.into(),
            started_at: 100 * n as i64,
            ended_at: Some(100 * n as i64 + 50),
            diffstat: Diffstat {
                files: n,
                insertions: 2 * n,
                deletions: 0,
            },
            degraded: git_ref.is_empty(),
            checks: None,
        }
    }

    #[test]
    fn turns_round_trip_oldest_first_and_a_blank_ref_reads_back_as_degraded() {
        let (_d, db) = open_db();
        insert_turn(&db, &turn("s1", 2, "refs/hermes/s1/turn/2")).unwrap();
        insert_turn(&db, &turn("s1", 1, "refs/hermes/s1/turn/1")).unwrap();
        insert_turn(&db, &turn("s1", 3, "")).unwrap();
        insert_turn(&db, &turn("s2", 1, "refs/hermes/s2/turn/1")).unwrap();
        let listed = list_turns(&db, "s1").unwrap();
        assert_eq!(
            listed.iter().map(|t| t.n).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert_eq!(listed[0], turn("s1", 1, "refs/hermes/s1/turn/1"));
        assert!(listed[2].degraded);
        assert_eq!(max_n(&db, "s1").unwrap(), 3);
        assert_eq!(max_n(&db, "nobody").unwrap(), 0);
        assert_eq!(get_turn(&db, "s1", 2).unwrap().map(|t| t.n), Some(2));
        assert_eq!(get_turn(&db, "s1", 9).unwrap(), None);
        assert_eq!(delete_turns(&db, "s1").unwrap(), 3);
        assert!(list_turns(&db, "s1").unwrap().is_empty());
        assert_eq!(list_turns(&db, "s2").unwrap().len(), 1);
    }

    #[test]
    fn expired_sessions_are_the_closed_ones_past_the_cutoff_with_their_folders() {
        let (_d, db) = open_db();
        insert_session(&db, "old", "/srv/old", Some("2026-01-01 00:00:00"));
        insert_session(&db, "fresh", "/srv/fresh", Some("2026-09-20 00:00:00"));
        insert_session(&db, "open", "/srv/open", None);
        insert_session(
            &db,
            "old-no-turns",
            "/srv/none",
            Some("2026-01-01 00:00:00"),
        );
        for sid in ["old", "fresh", "open"] {
            insert_turn(&db, &turn(sid, 1, &format!("refs/hermes/{sid}/turn/1"))).unwrap();
        }
        db.conn
            .execute(
                "INSERT INTO projects (id, path, name) VALUES ('p1', '/srv/project', 'project')",
                [],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO session_worktrees (id, session_id, realm_id, worktree_path)
                 VALUES ('w1', 'old', 'p1', '/srv/worktrees/old')",
                [],
            )
            .unwrap();
        let expired = expired_sessions(&db, "2026-09-14 00:00:00").unwrap();
        assert_eq!(
            expired,
            vec![ExpiredSession {
                session_id: "old".into(),
                candidates: vec![
                    PathBuf::from("/srv/old"),
                    PathBuf::from("/srv/worktrees/old"),
                    PathBuf::from("/srv/project"),
                ],
            }]
        );
    }
}
