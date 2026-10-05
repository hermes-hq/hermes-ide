//! What the person did with the library, kept in `hermes.db` (backed up
//! with the rest of their data, never sent anywhere): pins, hides and use
//! counts per entry, decayed use per facet value (the "recent usage"
//! signal), the profile they chose, and what was installed into projects.
//! The tables come from migration 7 (`db/migrations.rs`).

use super::catalog::Row;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Settings key holding the profile (JSON).
pub const PROFILE_KEY: &str = "library_profile";
/// Half-life of a use, in seconds (14 days).
pub const HALF_LIFE_SECS: f64 = 14.0 * 86_400.0;

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// The person's choices: "I am a…" roles and interests.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Profile {
    pub roles: Vec<String>,
    pub domains: Vec<String>,
    pub categories: Vec<String>,
    pub subjects: Vec<String>,
    pub stack: Vec<String>,
    pub level: Option<String>,
    /// "on" (default), "paused" (no learning from use) or "off" (show everything).
    pub personalise: Option<String>,
}

impl Profile {
    pub fn personalise_on(&self) -> bool {
        self.personalise.as_deref() != Some("off")
    }
    pub fn learning_on(&self) -> bool {
        matches!(self.personalise.as_deref(), None | Some("on"))
    }
}

pub fn read_profile(conn: &Connection) -> Profile {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        [PROFILE_KEY],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .and_then(|v| serde_json::from_str(&v).ok())
    .unwrap_or_default()
}

pub fn write_profile(conn: &Connection, profile: &Profile) -> Result<(), String> {
    let json = serde_json::to_string(profile).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![PROFILE_KEY, json],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ItemState {
    pub item_id: String,
    pub pinned: bool,
    pub favorite: bool,
    pub hidden: bool,
    pub use_count: i64,
    pub last_used_at: Option<i64>,
}

pub fn item_states(conn: &Connection) -> Vec<ItemState> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT item_id, pinned, favorite, hidden, use_count, last_used_at FROM library_item_state",
    ) else {
        return Vec::new();
    };
    stmt.query_map([], |r| {
        Ok(ItemState {
            item_id: r.get(0)?,
            pinned: r.get::<_, i64>(1)? != 0,
            favorite: r.get::<_, i64>(2)? != 0,
            hidden: r.get::<_, i64>(3)? != 0,
            use_count: r.get(4)?,
            last_used_at: r.get(5)?,
        })
    })
    .map(|rows| rows.filter_map(Result::ok).collect())
    .unwrap_or_default()
}

/// Sets pinned / favorite / hidden (each only when given).
pub fn set_flags(
    conn: &Connection,
    id: &str,
    pinned: Option<bool>,
    favorite: Option<bool>,
    hidden: Option<bool>,
) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO library_item_state (item_id) VALUES (?1)",
        [id],
    )
    .map_err(|e| e.to_string())?;
    for (col, value) in [
        ("pinned", pinned),
        ("favorite", favorite),
        ("hidden", hidden),
    ] {
        if let Some(v) = value {
            conn.execute(
                &format!("UPDATE library_item_state SET {col} = ?1 WHERE item_id = ?2"),
                params![v as i64, id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Records one use of an entry: its count, and (when learning is on) one
/// decayed point for each of its category, domain, kind, stack and subject
/// values.
pub fn record_use(conn: &Connection, row: &Row, learn: bool, now: i64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO library_item_state (item_id, use_count, last_used_at) VALUES (?1, 1, ?2)
         ON CONFLICT(item_id) DO UPDATE SET use_count = use_count + 1, last_used_at = ?2",
        params![row.id, now],
    )
    .map_err(|e| e.to_string())?;
    if !learn {
        return Ok(());
    }
    let mut points: Vec<(&str, &str)> = vec![
        ("category", &row.cat),
        ("domain", &row.dom),
        ("kind", &row.kind),
    ];
    points.extend(row.stack.iter().map(|v| ("stack", v.as_str())));
    points.extend(row.subject.iter().map(|v| ("subject", v.as_str())));
    for (facet, value) in points {
        if value.is_empty() {
            continue;
        }
        let old: Option<(f64, i64)> = conn
            .query_row(
                "SELECT score, updated_at FROM library_affinity WHERE facet = ?1 AND value = ?2",
                params![facet, value],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let score = old.map(|(s, t)| decayed(s, t, now)).unwrap_or(0.0) + 1.0;
        conn.execute(
            "INSERT INTO library_affinity (facet, value, score, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(facet, value) DO UPDATE SET score = ?3, updated_at = ?4",
            params![facet, value, score, now],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn decayed(score: f64, at: i64, now: i64) -> f64 {
    let age = (now - at).max(0) as f64;
    score * 0.5f64.powf(age / HALF_LIFE_SECS)
}

/// Decayed use per (facet, value), dropping what has faded below 0.1.
pub fn affinity(conn: &Connection, now: i64) -> Vec<(String, String, f64)> {
    let Ok(mut stmt) = conn.prepare("SELECT facet, value, score, updated_at FROM library_affinity")
    else {
        return Vec::new();
    };
    stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, f64>(2)?,
            r.get::<_, i64>(3)?,
        ))
    })
    .map(|rows| {
        rows.filter_map(Result::ok)
            .map(|(f, v, s, t)| (f, v, decayed(s, t, now)))
            .filter(|(_, _, s)| *s >= 0.1)
            .collect()
    })
    .unwrap_or_default()
}

/// "Reset personalisation": forgets usage and the profile; pins and hides stay.
pub fn reset(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "DELETE FROM library_affinity;
         UPDATE library_item_state SET use_count = 0, last_used_at = NULL;",
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM settings WHERE key = ?1", [PROFILE_KEY])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Pins, hides and recent uses as ranking signals.
pub struct UseSignals {
    pub pinned: HashSet<String>,
    pub hidden: HashSet<String>,
    pub used: HashMap<String, i64>,
    /// Pinned first, then most recently used.
    pub continue_ids: Vec<String>,
}

pub fn use_signals(conn: &Connection) -> UseSignals {
    let mut states = item_states(conn);
    let pinned: HashSet<String> = states
        .iter()
        .filter(|s| s.pinned)
        .map(|s| s.item_id.clone())
        .collect();
    let hidden: HashSet<String> = states
        .iter()
        .filter(|s| s.hidden)
        .map(|s| s.item_id.clone())
        .collect();
    let used: HashMap<String, i64> = states
        .iter()
        .filter(|s| s.use_count > 0)
        .map(|s| (s.item_id.clone(), s.use_count))
        .collect();
    states.sort_by(|a, b| {
        b.pinned.cmp(&a.pinned).then(
            b.last_used_at
                .unwrap_or(0)
                .cmp(&a.last_used_at.unwrap_or(0)),
        )
    });
    let continue_ids = states
        .into_iter()
        .filter(|s| !s.hidden && (s.pinned || s.use_count > 0))
        .map(|s| s.item_id)
        .collect();
    UseSignals {
        pinned,
        hidden,
        used,
        continue_ids,
    }
}

// ─── Installs (a mirror of each project's .hodios.lock for the UI) ────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstallRecord {
    pub project_path: String,
    pub item_id: String,
    pub agent_id: String,
    pub version: String,
    pub path: String,
    pub hash: String,
    pub installed_at: i64,
}

pub fn record_install(conn: &Connection, rec: &InstallRecord) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO library_installs (project_path, item_id, agent_id, version, path, hash, installed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![rec.project_path, rec.item_id, rec.agent_id, rec.version, rec.path, rec.hash, rec.installed_at],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub fn remove_install(
    conn: &Connection,
    project: &str,
    item_id: &str,
    agent_id: &str,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM library_installs WHERE project_path = ?1 AND item_id = ?2 AND agent_id = ?3",
        params![project, item_id, agent_id],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub fn installs(conn: &Connection, project: Option<&str>) -> Vec<InstallRecord> {
    let sql = "SELECT project_path, item_id, agent_id, version, path, hash, installed_at FROM library_installs
               WHERE ?1 IS NULL OR project_path = ?1 ORDER BY project_path, item_id, path";
    let Ok(mut stmt) = conn.prepare(sql) else {
        return Vec::new();
    };
    stmt.query_map([project], |r| {
        Ok(InstallRecord {
            project_path: r.get(0)?,
            item_id: r.get(1)?,
            agent_id: r.get(2)?,
            version: r.get(3)?,
            path: r.get(4)?,
            hash: r.get(5)?,
            installed_at: r.get(6)?,
        })
    })
    .map(|rows| rows.filter_map(Result::ok).collect())
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .unwrap();
        crate::db::migrations::create_library_tables(&c).unwrap();
        c
    }

    fn row(id: &str) -> Row {
        Row {
            id: id.into(),
            cat: "testing".into(),
            dom: "software-engineering".into(),
            kind: "prompt".into(),
            stack: vec!["react".into()],
            ..Default::default()
        }
    }

    #[test]
    fn records_uses_and_decays_them() {
        let c = conn();
        let t0 = 1_000_000;
        record_use(&c, &row("a"), true, t0).unwrap();
        record_use(&c, &row("a"), true, t0).unwrap();
        let aff = affinity(&c, t0);
        let testing = aff
            .iter()
            .find(|(f, v, _)| f == "category" && v == "testing")
            .unwrap();
        assert!((testing.2 - 2.0).abs() < 1e-9);
        let later = affinity(&c, t0 + 14 * 86_400);
        let testing = later
            .iter()
            .find(|(f, v, _)| f == "category" && v == "testing")
            .unwrap();
        assert!((testing.2 - 1.0).abs() < 1e-9);
        let s = use_signals(&c);
        assert_eq!(s.used["a"], 2);
        assert_eq!(s.continue_ids, vec!["a".to_string()]);
    }

    #[test]
    fn paused_learning_still_counts_the_item() {
        let c = conn();
        record_use(&c, &row("a"), false, 10).unwrap();
        assert!(affinity(&c, 10).is_empty());
        assert_eq!(use_signals(&c).used["a"], 1);
    }

    #[test]
    fn pins_hides_and_resets() {
        let c = conn();
        set_flags(&c, "p", Some(true), None, None).unwrap();
        set_flags(&c, "h", None, None, Some(true)).unwrap();
        record_use(&c, &row("u"), true, 5).unwrap();
        let s = use_signals(&c);
        assert!(s.pinned.contains("p") && s.hidden.contains("h"));
        assert_eq!(s.continue_ids[0], "p");
        write_profile(
            &c,
            &Profile {
                roles: vec!["frontend-engineer".into()],
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            read_profile(&c).roles,
            vec!["frontend-engineer".to_string()]
        );
        reset(&c).unwrap();
        assert!(affinity(&c, 5).is_empty());
        assert_eq!(read_profile(&c), Profile::default());
        assert!(use_signals(&c).pinned.contains("p"));
    }

    #[test]
    fn keeps_installs_per_project() {
        let c = conn();
        let rec = InstallRecord {
            project_path: "/p".into(),
            item_id: "x".into(),
            agent_id: "codex".into(),
            version: "1.0.0".into(),
            path: ".agents/skills/x/SKILL.md".into(),
            hash: "sha256:00".into(),
            installed_at: 1,
        };
        record_install(&c, &rec).unwrap();
        assert_eq!(installs(&c, Some("/p")), vec![rec.clone()]);
        assert!(installs(&c, Some("/q")).is_empty());
        remove_install(&c, "/p", "x", "codex").unwrap();
        assert!(installs(&c, None).is_empty());
    }
}
