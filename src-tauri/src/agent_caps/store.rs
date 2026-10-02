//! Storage for the launch contract (tables from migration 5): accounts
//! Hermes added, launch history per repository, presets, the choice
//! remembered per agent and account, and models an account refused.
//!
//! Choices are stored as the JSON of `LaunchChoice` (in `stored_form`: a new
//! worktree's per-task branch left empty) and are never handed back
//! unchecked: the commands run every one through `choice::reconcile`.

use rusqlite::{params, Connection, OptionalExtension};

use super::choice::{combo_key, stored_form, HistoryRow};
use super::types::LaunchChoice;

fn db_err(e: rusqlite::Error) -> String {
    e.to_string()
}

fn to_json(c: &LaunchChoice) -> String {
    serde_json::to_string(&stored_form(c)).unwrap_or_default()
}

fn from_json(s: &str) -> Option<LaunchChoice> {
    serde_json::from_str(s).ok()
}

// ─── Accounts ────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredAccount {
    pub agent_id: String,
    pub id: String,
    pub label: String,
    pub profile_dir: String,
}

pub fn list_accounts(conn: &Connection, agent_id: &str) -> Result<Vec<StoredAccount>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT agent_id, id, label, profile_dir FROM agent_accounts
             WHERE agent_id = ?1 ORDER BY created_at, id",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![agent_id], |r| {
            Ok(StoredAccount {
                agent_id: r.get(0)?,
                id: r.get(1)?,
                label: r.get(2)?,
                profile_dir: r.get(3)?,
            })
        })
        .map_err(db_err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
}

pub fn insert_account(conn: &Connection, a: &StoredAccount, now_ms: i64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO agent_accounts (agent_id, id, label, profile_dir, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![a.agent_id, a.id, a.label, a.profile_dir, now_ms],
    )
    .map(|_| ())
    .map_err(db_err)
}

/// Forget an account Hermes added, with what Hermes learned about it (the
/// models it refused, its remembered launch choice): an account added
/// again later under the same name starts clean.
pub fn remove_account(conn: &Connection, agent_id: &str, id: &str) -> Result<bool, String> {
    let tx = conn.unchecked_transaction().map_err(db_err)?;
    let removed = tx
        .execute(
            "DELETE FROM agent_accounts WHERE agent_id = ?1 AND id = ?2",
            params![agent_id, id],
        )
        .map_err(db_err)?;
    tx.execute(
        "DELETE FROM agent_model_rejections WHERE agent_id = ?1 AND account_id = ?2",
        params![agent_id, id],
    )
    .map_err(db_err)?;
    tx.execute(
        "DELETE FROM launch_memory WHERE agent_id = ?1 AND account_id = ?2",
        params![agent_id, id],
    )
    .map_err(db_err)?;
    tx.commit().map_err(db_err)?;
    Ok(removed > 0)
}

/// The label of an account `label` would duplicate (case and surrounding
/// spaces ignored): an account Hermes added, or the CLI's own profile
/// ("default", "Default profile"). None when the name is free.
pub fn taken_label(accounts: &[StoredAccount], label: &str) -> Option<String> {
    let want = label.trim().to_lowercase();
    if want == "default" || want == "default profile" {
        return Some("Default profile".to_string());
    }
    accounts
        .iter()
        .find(|a| a.label.trim().to_lowercase() == want)
        .map(|a| a.label.clone())
}

// ─── Launch history ──────────────────────────────────────────────────

/// Count one launch of `choice` in `repo`; returns how many launches of
/// this combination the repository has now.
pub fn record_launch(
    conn: &Connection,
    repo: &str,
    choice: &LaunchChoice,
    now_ms: i64,
) -> Result<i64, String> {
    let key = combo_key(choice);
    let uses: Vec<i64> = conn
        .query_row(
            "SELECT recent_uses FROM launch_history WHERE repo = ?1 AND combo_key = ?2",
            params![repo, key],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();
    let uses = serde_json::to_string(&crate::agent_caps::choice::add_use(uses, now_ms))
        .unwrap_or_else(|_| "[]".to_string());
    conn.execute(
        "INSERT INTO launch_history (repo, combo_key, choice_json, count, first_used_at, last_used_at, recent_uses)
         VALUES (?1, ?2, ?3, 1, ?4, ?4, ?5)
         ON CONFLICT(repo, combo_key) DO UPDATE SET
            count = count + 1, last_used_at = excluded.last_used_at, choice_json = excluded.choice_json,
            recent_uses = excluded.recent_uses",
        params![repo, key, to_json(choice), now_ms, uses],
    )
    .map_err(db_err)?;
    conn.query_row(
        "SELECT count FROM launch_history WHERE repo = ?1 AND combo_key = ?2",
        params![repo, key],
        |r| r.get(0),
    )
    .map_err(db_err)
}

/// A repository's history (None: every repository's rows).
pub fn history(conn: &Connection, repo: Option<&str>) -> Result<Vec<HistoryRow>, String> {
    type Raw = (String, String, i64, i64, String);
    let read = |r: &rusqlite::Row<'_>| -> rusqlite::Result<Raw> {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
    };
    const COLUMNS: &str =
        "SELECT combo_key, choice_json, count, last_used_at, recent_uses FROM launch_history";
    let raw: Vec<Raw> = match repo {
        Some(repo) => {
            let mut stmt = conn
                .prepare(&format!("{COLUMNS} WHERE repo = ?1"))
                .map_err(db_err)?;
            let rows = stmt.query_map(params![repo], read).map_err(db_err)?;
            rows.collect::<Result<_, _>>().map_err(db_err)?
        }
        None => {
            let mut stmt = conn.prepare(COLUMNS).map_err(db_err)?;
            let rows = stmt.query_map([], read).map_err(db_err)?;
            rows.collect::<Result<_, _>>().map_err(db_err)?
        }
    };
    // A row a newer build wrote in a shape this one cannot read is skipped.
    Ok(raw
        .into_iter()
        .filter_map(|(combo_key, json, count, last_used_at, uses)| {
            Some(HistoryRow {
                combo_key,
                choice: from_json(&json)?,
                count,
                last_used_at,
                uses: serde_json::from_str(&uses).unwrap_or_default(),
            })
        })
        .collect())
}

pub fn dismiss_preset_prompt(
    conn: &Connection,
    choice: &LaunchChoice,
    now_ms: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO launch_preset_prompts_dismissed (combo_key, dismissed_at) VALUES (?1, ?2)",
        params![combo_key(choice), now_ms],
    )
    .map(|_| ())
    .map_err(db_err)
}

pub fn preset_prompt_dismissed(conn: &Connection, choice: &LaunchChoice) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM launch_preset_prompts_dismissed WHERE combo_key = ?1",
        params![combo_key(choice)],
        |_| Ok(()),
    )
    .optional()
    .map(|r| r.is_some())
    .map_err(db_err)
}

/// "Save as preset?" after this many identical launches.
pub const SUGGEST_PRESET_AFTER: i64 = 3;

/// Whether to offer "Save as preset?" for a combination launched `count` times.
pub fn should_suggest_preset(
    conn: &Connection,
    choice: &LaunchChoice,
    count: i64,
) -> Result<bool, String> {
    if count < SUGGEST_PRESET_AFTER {
        return Ok(false);
    }
    let key = combo_key(choice);
    let is_preset = list_presets(conn)?
        .iter()
        .any(|p| combo_key(&p.choice) == key);
    Ok(!is_preset && !preset_prompt_dismissed(conn, choice)?)
}

// ─── Presets ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredPreset {
    pub id: String,
    pub name: String,
    pub choice: LaunchChoice,
}

pub fn list_presets(conn: &Connection) -> Result<Vec<StoredPreset>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, choice_json FROM launch_presets ORDER BY position, created_at")
        .map_err(db_err)?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(db_err)?;
    let mut out = Vec::new();
    for row in rows {
        let (id, name, json) = row.map_err(db_err)?;
        if let Some(choice) = from_json(&json) {
            out.push(StoredPreset { id, name, choice });
        }
    }
    Ok(out)
}

fn clean_name(name: &str) -> Result<String, String> {
    let name: String = name
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .to_string();
    if name.is_empty() {
        return Err("A preset needs a name".to_string());
    }
    Ok(name.chars().take(60).collect())
}

/// A name another preset already has (letter case ignored): presets are
/// picked by name, so two never share one.
fn refuse_taken_name(conn: &Connection, name: &str, except_id: Option<&str>) -> Result<(), String> {
    let want = name.to_lowercase();
    match list_presets(conn)?
        .into_iter()
        .find(|p| Some(p.id.as_str()) != except_id && p.name.trim().to_lowercase() == want)
    {
        Some(p) => Err(format!("You already have a preset called \"{}\"", p.name)),
        None => Ok(()),
    }
}

pub fn save_preset(
    conn: &Connection,
    name: &str,
    choice: &LaunchChoice,
    now_ms: i64,
) -> Result<StoredPreset, String> {
    let name = clean_name(name)?;
    refuse_taken_name(conn, &name, None)?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let position: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM launch_presets",
            [],
            |r| r.get(0),
        )
        .map_err(db_err)?;
    conn.execute(
        "INSERT INTO launch_presets (id, name, choice_json, combo_key, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![id, name, to_json(choice), combo_key(choice), position, now_ms],
    )
    .map_err(db_err)?;
    Ok(StoredPreset {
        id,
        name,
        choice: stored_form(choice),
    })
}

pub fn rename_preset(
    conn: &Connection,
    id: &str,
    name: &str,
    now_ms: i64,
) -> Result<StoredPreset, String> {
    let name = clean_name(name)?;
    refuse_taken_name(conn, &name, Some(id))?;
    let n = conn
        .execute(
            "UPDATE launch_presets SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, name, now_ms],
        )
        .map_err(db_err)?;
    if n == 0 {
        return Err("That preset no longer exists".to_string());
    }
    list_presets(conn)?
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "That preset no longer exists".to_string())
}

pub fn delete_preset(conn: &Connection, id: &str) -> Result<bool, String> {
    conn.execute("DELETE FROM launch_presets WHERE id = ?1", params![id])
        .map(|n| n > 0)
        .map_err(db_err)
}

// ─── Remembered choice per agent + account ───────────────────────────

pub fn remember(conn: &Connection, choice: &LaunchChoice, now_ms: i64) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO launch_memory (agent_id, account_id, choice_json, updated_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![choice.agent_id, choice.account_id, to_json(choice), now_ms],
    )
    .map(|_| ())
    .map_err(db_err)
}

pub fn remembered(
    conn: &Connection,
    agent_id: &str,
    account_id: Option<&str>,
) -> Result<Option<LaunchChoice>, String> {
    let json: Option<String> = match account_id {
        Some(acc) => conn
            .query_row(
                "SELECT choice_json FROM launch_memory WHERE agent_id = ?1 AND account_id = ?2",
                params![agent_id, acc],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?,
        None => conn
            .query_row(
                "SELECT choice_json FROM launch_memory WHERE agent_id = ?1 ORDER BY updated_at DESC LIMIT 1",
                params![agent_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?,
    };
    Ok(json.and_then(|j| from_json(&j)))
}

// ─── Models an account refused ───────────────────────────────────────

pub fn record_rejection(
    conn: &Connection,
    agent_id: &str,
    account_id: &str,
    model_id: &str,
    message: &str,
    now_ms: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO agent_model_rejections (agent_id, account_id, model_id, message, at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![agent_id, account_id, model_id, message, now_ms],
    )
    .map(|_| ())
    .map_err(db_err)
}

/// (model id, epoch ms, the CLI's words) the account refused.
pub fn rejections(
    conn: &Connection,
    agent_id: &str,
    account_id: &str,
) -> Result<Vec<(String, i64, String)>, String> {
    let mut stmt = conn
        .prepare("SELECT model_id, at, message FROM agent_model_rejections WHERE agent_id = ?1 AND account_id = ?2")
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![agent_id, account_id], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            ))
        })
        .map_err(db_err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
}

/// A model worked after all (a launch with it took a turn): forget the
/// refusal. Whether there was one to forget.
pub fn clear_rejection(
    conn: &Connection,
    agent_id: &str,
    account_id: &str,
    model_id: &str,
) -> Result<bool, String> {
    conn.execute(
        "DELETE FROM agent_model_rejections WHERE agent_id = ?1 AND account_id = ?2 AND model_id = ?3",
        params![agent_id, account_id, model_id],
    )
    .map(|n| n > 0)
    .map_err(db_err)
}

/// "Check again": forget every refusal of an agent's accounts (each model
/// is offered again; a launch it still refuses is stopped and remembered
/// again). How many were forgotten.
pub fn clear_rejections(conn: &Connection, agent_id: &str) -> Result<usize, String> {
    conn.execute(
        "DELETE FROM agent_model_rejections WHERE agent_id = ?1",
        params![agent_id],
    )
    .map_err(db_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_caps::choice::{pick_usual, tests::choice};
    use crate::agent_caps::types::LaunchWhere;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::migrate(&conn, None, crate::db::migrations::MIGRATIONS).unwrap();
        conn
    }

    #[test]
    fn launches_count_per_repository_and_combination() {
        let conn = db();
        let a = choice();
        let mut b = choice();
        b.model_id = "sonnet".into();
        assert_eq!(record_launch(&conn, "/repo/one", &a, 1).unwrap(), 1);
        assert_eq!(record_launch(&conn, "/repo/one", &a, 2).unwrap(), 2);
        // Another task on its own branch is the same combination.
        let mut a2 = a.clone();
        a2.where_ = LaunchWhere::NewWorktree {
            base_branch: "main".into(),
            branch: "hermes/another".into(),
        };
        assert_eq!(record_launch(&conn, "/repo/one", &a2, 3).unwrap(), 3);
        assert_eq!(record_launch(&conn, "/repo/one", &b, 4).unwrap(), 1);
        assert_eq!(record_launch(&conn, "/repo/two", &b, 5).unwrap(), 1);
        let one = history(&conn, Some("/repo/one")).unwrap();
        assert_eq!(one.len(), 2);
        let usual = pick_usual(&one, 10).unwrap();
        assert_eq!(
            (
                usual.choice.model_id.as_str(),
                usual.count,
                usual.last_used_at
            ),
            ("opus", 3, 3)
        );
        assert_eq!(usual.uses, [1, 2, 3], "each launch's time is kept");
        // The branch is stored empty: the launcher derives it from the next task.
        assert_eq!(
            usual.choice.where_,
            LaunchWhere::NewWorktree {
                base_branch: "main".into(),
                branch: String::new()
            }
        );
        assert_eq!(history(&conn, None).unwrap().len(), 3);
    }

    #[test]
    fn save_as_preset_is_offered_after_three_identical_launches_once_dismissed_never() {
        let conn = db();
        let c = choice();
        for n in 1..=2 {
            let count = record_launch(&conn, "/r", &c, n).unwrap();
            assert!(!should_suggest_preset(&conn, &c, count).unwrap());
        }
        let count = record_launch(&conn, "/r", &c, 3).unwrap();
        assert!(should_suggest_preset(&conn, &c, count).unwrap());
        dismiss_preset_prompt(&conn, &c, 4).unwrap();
        let count = record_launch(&conn, "/r", &c, 5).unwrap();
        assert!(!should_suggest_preset(&conn, &c, count).unwrap());
        // A combination that is a preset already is never offered.
        let mut d = choice();
        d.effort = Some("max".into());
        save_preset(&conn, "Deep", &d, 6).unwrap();
        assert!(!should_suggest_preset(&conn, &d, 9).unwrap());
    }

    #[test]
    fn presets_save_rename_delete_in_order() {
        let conn = db();
        let a = save_preset(&conn, "  Claude deep  ", &choice(), 1).unwrap();
        assert_eq!(a.name, "Claude deep");
        let mut c2 = choice();
        c2.agent_id = "codex".into();
        let b = save_preset(&conn, "Codex quick", &c2, 2).unwrap();
        assert_eq!(
            list_presets(&conn)
                .unwrap()
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>(),
            ["Claude deep", "Codex quick"]
        );
        assert_eq!(
            rename_preset(&conn, &b.id, "Codex fast", 3).unwrap().name,
            "Codex fast"
        );
        assert!(rename_preset(&conn, &b.id, "   ", 3).is_err());
        assert!(rename_preset(&conn, "nope", "x", 3).is_err());
        assert!(save_preset(&conn, "\n", &choice(), 4).is_err());
        assert!(delete_preset(&conn, &a.id).unwrap());
        assert!(!delete_preset(&conn, &a.id).unwrap());
        assert_eq!(list_presets(&conn).unwrap().len(), 1);
    }

    #[test]
    fn two_presets_never_share_a_name_whatever_its_letter_case() {
        let conn = db();
        let a = save_preset(&conn, "Plan first", &choice(), 1).unwrap();
        let b = save_preset(&conn, "Quick fix", &choice(), 2).unwrap();
        assert_eq!(
            save_preset(&conn, " PLAN FIRST ", &choice(), 3).unwrap_err(),
            "You already have a preset called \"Plan first\""
        );
        assert_eq!(
            rename_preset(&conn, &b.id, "plan first", 4).unwrap_err(),
            "You already have a preset called \"Plan first\""
        );
        // Its own name, in another case, is fine.
        assert_eq!(
            rename_preset(&conn, &a.id, "PLAN FIRST", 5).unwrap().name,
            "PLAN FIRST"
        );
        assert_eq!(list_presets(&conn).unwrap().len(), 2);
    }

    #[test]
    fn accounts_memory_and_rejections_round_trip() {
        let conn = db();
        let acc = StoredAccount {
            agent_id: "claude".into(),
            id: "work".into(),
            label: "Work".into(),
            profile_dir: "~/.claude-work".into(),
        };
        insert_account(&conn, &acc, 1).unwrap();
        assert!(insert_account(&conn, &acc, 2).is_err(), "one id per agent");
        assert_eq!(list_accounts(&conn, "claude").unwrap(), vec![acc.clone()]);
        assert!(list_accounts(&conn, "codex").unwrap().is_empty());
        assert!(remove_account(&conn, "claude", "work").unwrap());

        let mut c = choice();
        c.account_id = "work".into();
        remember(&conn, &c, 1).unwrap();
        assert_eq!(
            remembered(&conn, "claude", Some("work"))
                .unwrap()
                .unwrap()
                .model_id,
            "opus"
        );
        assert!(remembered(&conn, "claude", Some("default"))
            .unwrap()
            .is_none());
        assert_eq!(
            remembered(&conn, "claude", None)
                .unwrap()
                .unwrap()
                .account_id,
            "work"
        );

        record_rejection(&conn, "codex", "default", "gpt-5.5", "404", 7).unwrap();
        assert_eq!(
            rejections(&conn, "codex", "default").unwrap(),
            vec![("gpt-5.5".to_string(), 7, "404".to_string())]
        );
        assert!(clear_rejection(&conn, "codex", "default", "gpt-5.5").unwrap());
        assert!(rejections(&conn, "codex", "default").unwrap().is_empty());
        assert!(
            !clear_rejection(&conn, "codex", "default", "gpt-5.5").unwrap(),
            "nothing left to forget"
        );
    }

    #[test]
    fn check_again_forgets_one_agents_refusals_only() {
        let conn = db();
        record_rejection(&conn, "codex", "default", "a", "x", 1).unwrap();
        record_rejection(&conn, "codex", "work", "b", "x", 1).unwrap();
        record_rejection(&conn, "claude", "default", "opus", "x", 1).unwrap();
        assert_eq!(clear_rejections(&conn, "codex").unwrap(), 2);
        assert!(rejections(&conn, "codex", "work").unwrap().is_empty());
        assert_eq!(rejections(&conn, "claude", "default").unwrap().len(), 1);
    }

    #[test]
    fn removing_an_account_forgets_its_refusals_and_remembered_choice() {
        let conn = db();
        let acc = StoredAccount {
            agent_id: "codex".into(),
            id: "personal".into(),
            label: "Personal".into(),
            profile_dir: "/p/.codex-personal".into(),
        };
        insert_account(&conn, &acc, 1).unwrap();
        record_rejection(&conn, "codex", "personal", "gpt-x", "404", 2).unwrap();
        record_rejection(&conn, "codex", "default", "gpt-x", "404", 2).unwrap();
        let mut c = choice();
        c.agent_id = "codex".into();
        c.account_id = "personal".into();
        remember(&conn, &c, 3).unwrap();
        assert!(remove_account(&conn, "codex", "personal").unwrap());
        assert!(rejections(&conn, "codex", "personal").unwrap().is_empty());
        assert!(remembered(&conn, "codex", Some("personal"))
            .unwrap()
            .is_none());
        assert_eq!(
            rejections(&conn, "codex", "default").unwrap().len(),
            1,
            "the default profile keeps what it learned"
        );
        assert!(!remove_account(&conn, "codex", "personal").unwrap());
    }

    #[test]
    fn an_account_name_is_taken_whatever_its_case() {
        let stored = vec![StoredAccount {
            agent_id: "claude".into(),
            id: "work".into(),
            label: "Work".into(),
            profile_dir: "/p/.claude-work".into(),
        }];
        assert_eq!(taken_label(&stored, "work").as_deref(), Some("Work"));
        assert_eq!(taken_label(&stored, "  WORK ").as_deref(), Some("Work"));
        assert_eq!(
            taken_label(&stored, "Default").as_deref(),
            Some("Default profile")
        );
        assert_eq!(
            taken_label(&stored, "default profile").as_deref(),
            Some("Default profile")
        );
        assert_eq!(taken_label(&stored, "Personal"), None);
        assert_eq!(taken_label(&stored, "Work 2"), None);
    }
}
