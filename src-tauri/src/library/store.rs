//! `library.db`: the local search index of the prompt library.
//!
//! A rebuildable cache, never backed up or exported: it lives in
//! `<app data>/library/` and is deleted and rebuilt from the bundled archive
//! when it is unreadable or has a schema this build does not know. User
//! state (pins, use counts, the profile) lives in `hermes.db`.
//!
//! Rows are stored in static-rank order (`rowid` = position by tier,
//! deprecation, quality, usage, id), so the first N FTS matches in rowid
//! order are the N best by static rank: search takes 300 such candidates
//! and reranks only those, whatever the catalog size (design §12.5).

use super::catalog::{compare_static, parse_ref, Manifest, Row, VerifiedCatalog, Vocab};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// Bumped when the schema below changes; an older file is rebuilt.
pub const STORE_VERSION: i64 = 1;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS entry (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL,
  kind TEXT NOT NULL,
  domain TEXT NOT NULL,
  category TEXT NOT NULL,
  tier INTEGER NOT NULL,
  status TEXT NOT NULL,
  quality INTEGER NOT NULL,
  usage INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  tags TEXT NOT NULL,
  f TEXT NOT NULL,
  row TEXT NOT NULL,
  body TEXT NOT NULL,
  updated TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS alias (alias TEXT PRIMARY KEY, id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync (tier TEXT PRIMARY KEY, list TEXT NOT NULL, rows INTEGER NOT NULL, catalog TEXT NOT NULL, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS object (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS body_cache (
  hash TEXT PRIMARY KEY,
  text BLOB NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  last_used INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS manifest_history (
  catalog TEXT NOT NULL,
  seq INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  manifest BLOB NOT NULL,
  source TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (catalog, seq)
);
CREATE VIRTUAL TABLE IF NOT EXISTS entry_fts USING fts5(
  id, title, tags, description, f,
  content='entry', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2', prefix='2 3', detail=column
);
";

/// Opens (creating when needed) a library database. A file this build cannot
/// read — corrupt, or another schema — is deleted and created again: it is a
/// cache of the catalog, rebuilt from the bundled archive.
pub fn open(path: &Path) -> Result<Connection, String> {
    match open_once(path) {
        Ok(conn) => Ok(conn),
        Err(first) => {
            log::warn!("[library] rebuilding {}: {first}", path.display());
            for suffix in ["", "-wal", "-shm"] {
                let p = format!("{}{}", path.display(), suffix);
                let _ = std::fs::remove_file(p);
            }
            open_once(path)
        }
    }
}

fn open_once(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    configure(&conn)?;
    let ok: String = conn
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if ok != "ok" {
        return Err(format!("quick_check: {ok}"));
    }
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    match version {
        0 => {
            conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
            conn.execute_batch(&format!("PRAGMA user_version = {STORE_VERSION}"))
                .map_err(|e| e.to_string())?;
        }
        STORE_VERSION => {}
        other => return Err(format!("unknown library.db version {other}")),
    }
    Ok(conn)
}

/// An in-memory database with the schema (tests, benches).
#[cfg(test)]
pub fn open_in_memory() -> Result<Connection, String> {
    let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
    conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    Ok(conn)
}

fn configure(conn: &Connection) -> Result<(), String> {
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         PRAGMA temp_store=MEMORY;
         PRAGMA cache_size=-16000;
         PRAGMA mmap_size=268435456;",
    )
    .map_err(|e| e.to_string())
}

// ─── Facet tokens ─────────────────────────────────────────────────────

/// One FTS token per facet value: a prefix letter and the value with
/// everything but letters and digits removed (the tokenizer would split
/// `software-engineering` into two words).
pub fn facet_token(prefix: char, value: &str) -> String {
    let clean: String = value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect();
    format!("{prefix}{clean}")
}

/// The FTS prefix letter of a query key.
pub fn facet_prefix(key: &str) -> Option<char> {
    Some(match key {
        "kind" => 'k',
        "cat" | "category" => 'c',
        "domain" => 'd',
        "sub" => 'b',
        "stage" => 'g',
        "role" => 'r',
        "stack" => 's',
        "subject" => 'j',
        "works" => 'w',
        "in" => 'i',
        "out" => 'o',
        "risk" => 'a',
        "tag" => 'h',
        "tier" => 't',
        "status" => 'x',
        "level" => 'l',
        "lang" => 'n',
        _ => return None,
    })
}

fn facets_of(row: &Row) -> String {
    let mut tokens = vec![
        facet_token('k', &row.kind),
        facet_token('c', &row.cat),
        facet_token('d', &row.dom),
        facet_token('t', &row.tier),
        facet_token('x', &row.status),
    ];
    let lists: [(char, &Vec<String>); 9] = [
        ('g', &row.stage),
        ('r', &row.role),
        ('s', &row.stack),
        ('j', &row.subject),
        ('w', &row.works),
        ('i', &row.inputs),
        ('o', &row.out),
        ('h', &row.tags),
        ('h', &row.aliases),
    ];
    for (p, values) in lists {
        tokens.extend(values.iter().map(|v| facet_token(p, v)));
    }
    for (p, value) in [
        ('b', &row.sub),
        ('a', &row.risk),
        ('l', &row.level),
        ('n', &row.lang),
    ] {
        if let Some(v) = value {
            tokens.push(facet_token(p, v));
        }
    }
    tokens.retain(|t| t.len() > 1);
    tokens.join(" ")
}

// ─── Applying a catalog ───────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApplySummary {
    pub catalog: String,
    pub seq: i64,
    pub rows: usize,
    pub added: Vec<String>,
    pub changed: Vec<(String, String, String)>,
    pub removed: Vec<String>,
    pub revoked: Vec<String>,
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Replaces the stored catalog with `cat` in one write transaction: rows in
/// static order, aliases, the FTS index, the objects (kept for rollback),
/// the bodies (pinned: the curated tier stays offline), and the manifest in
/// the history. Readers keep reading the previous snapshot until it commits.
pub fn apply(
    conn: &mut Connection,
    cat: &VerifiedCatalog,
    source: &str,
) -> Result<ApplySummary, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let before: HashMap<String, String> = {
        let mut stmt = tx
            .prepare("SELECT id, version FROM entry")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        rows.filter_map(Result::ok).collect()
    };
    let first_import = before.is_empty();
    let revoked: HashSet<&str> = cat.manifest.revoked.iter().map(String::as_str).collect();
    let is_revoked = |row: &Row| {
        revoked.contains(row.id.as_str())
            || revoked.contains(format!("{}@{}", row.id, row.v).as_str())
    };

    let mut ordered: Vec<&(Row, String)> = cat.rows.iter().collect();
    ordered.sort_by(|a, b| compare_static(&a.0, &b.0));

    tx.execute_batch("DELETE FROM entry; DELETE FROM alias;")
        .map_err(|e| e.to_string())?;
    let mut summary = ApplySummary {
        catalog: cat.manifest.catalog.clone(),
        seq: cat.manifest.seq,
        rows: cat.rows.len(),
        ..Default::default()
    };
    {
        let mut insert = tx
            .prepare(
                "INSERT INTO entry (rowid, id, version, kind, domain, category, tier, status, quality, usage,
                                    title, description, tags, f, row, body, updated, revoked)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
            )
            .map_err(|e| e.to_string())?;
        let mut alias = tx
            .prepare("INSERT OR IGNORE INTO alias (alias, id) VALUES (?1, ?2)")
            .map_err(|e| e.to_string())?;
        for (i, (row, raw)) in ordered.iter().enumerate() {
            let tags = row
                .tags
                .iter()
                .chain(row.aliases.iter())
                .map(|t| t.replace('-', " "))
                .collect::<Vec<_>>()
                .join(" ");
            let gone = is_revoked(row);
            if gone {
                summary.revoked.push(row.id.clone());
            }
            insert
                .execute(params![
                    (i + 1) as i64,
                    row.id,
                    row.v,
                    row.kind,
                    row.dom,
                    row.cat,
                    super::catalog::tier_order(&row.tier),
                    row.status,
                    row.q,
                    row.u,
                    // A revoked entry keeps its row (lookups say it is gone)
                    // but nothing of it reaches the search index.
                    if gone { "" } else { row.title.as_str() },
                    if gone { "" } else { row.desc.as_str() },
                    if gone { String::new() } else { tags },
                    if gone { String::new() } else { facets_of(row) },
                    raw,
                    row.body,
                    row.updated,
                    gone as i64,
                ])
                .map_err(|e| e.to_string())?;
            for a in &row.aliases {
                alias
                    .execute(params![a, row.id])
                    .map_err(|e| e.to_string())?;
            }
            if !first_import {
                match before.get(&row.id) {
                    None => summary.added.push(row.id.clone()),
                    Some(v) if v != &row.v => {
                        summary
                            .changed
                            .push((row.id.clone(), v.clone(), row.v.clone()))
                    }
                    _ => {}
                }
            }
        }
    }
    if !first_import {
        let now: HashSet<&str> = cat.rows.iter().map(|(r, _)| r.id.as_str()).collect();
        summary.removed = before
            .keys()
            .filter(|id| !now.contains(id.as_str()))
            .cloned()
            .collect();
        summary.removed.sort();
    }
    tx.execute("INSERT INTO entry_fts(entry_fts) VALUES('rebuild')", [])
        .map_err(|e| e.to_string())?;
    // A revoked entry's id is still a column of its row: take it out of the
    // index too (an external-content delete names the indexed values).
    tx.execute(
        "INSERT INTO entry_fts(entry_fts, rowid, id, title, tags, description, f)
         SELECT 'delete', rowid, id, title, tags, description, f FROM entry WHERE revoked = 1",
        [],
    )
    .map_err(|e| e.to_string())?;
    {
        let mut obj = tx
            .prepare("INSERT OR IGNORE INTO object (hash, bytes) VALUES (?1, ?2)")
            .map_err(|e| e.to_string())?;
        for (hex, bytes) in &cat.objects {
            obj.execute(params![hex, bytes])
                .map_err(|e| e.to_string())?;
        }
        let mut body = tx
            .prepare(
                "INSERT INTO body_cache (hash, text, pinned, last_used) VALUES (?1, ?2, 1, ?3)
                 ON CONFLICT(hash) DO UPDATE SET pinned = 1",
            )
            .map_err(|e| e.to_string())?;
        let t = now_secs();
        for (hex, bytes) in &cat.bodies {
            body.execute(params![hex, bytes, t])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.execute("DELETE FROM sync", [])
        .map_err(|e| e.to_string())?;
    for (tier, tier_ref) in &cat.manifest.tiers {
        let rows = cat.rows.iter().filter(|(r, _)| &r.tier == tier).count() as i64;
        tx.execute(
            "INSERT INTO sync (tier, list, rows, catalog, seq) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                tier,
                tier_ref.list,
                rows,
                cat.manifest.catalog,
                cat.manifest.seq
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    let applied_at = now_secs();
    let vocab_json = cat
        .vocab
        .as_ref()
        .map(|v| serde_json::to_string(v).unwrap_or_default())
        .unwrap_or_default();
    let mut new_ids = summary.added.clone();
    new_ids.extend(summary.changed.iter().map(|(id, _, _)| id.clone()));
    let metas: [(&str, String); 8] = [
        ("catalog", cat.manifest.catalog.clone()),
        ("seq", cat.manifest.seq.to_string()),
        ("manifest_sha256", cat.manifest_sha.clone()),
        (
            "manifest",
            String::from_utf8_lossy(&cat.manifest_bytes).to_string(),
        ),
        ("source", source.to_string()),
        ("applied_at", applied_at.to_string()),
        ("vocab", vocab_json),
        (
            "new_ids",
            serde_json::to_string(&new_ids).unwrap_or_default(),
        ),
    ];
    for (k, v) in metas {
        tx.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![k, v],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute(
        "INSERT OR REPLACE INTO manifest_history (catalog, seq, sha256, manifest, source, applied_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            cat.manifest.catalog,
            cat.manifest.seq,
            cat.manifest_sha,
            cat.manifest_bytes,
            source,
            applied_at
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(summary)
}

// ─── Reading ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogInfo {
    pub catalog: String,
    pub seq: i64,
    pub manifest_sha256: String,
    pub source: String,
    pub rows: i64,
    pub applied_at: i64,
}

pub fn meta(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
}

pub fn info(conn: &Connection) -> Option<CatalogInfo> {
    let catalog = meta(conn, "catalog")?;
    let rows: i64 = conn
        .query_row("SELECT count(*) FROM entry WHERE revoked = 0", [], |r| {
            r.get(0)
        })
        .ok()?;
    Some(CatalogInfo {
        catalog,
        seq: meta(conn, "seq")?.parse().ok()?,
        manifest_sha256: meta(conn, "manifest_sha256").unwrap_or_default(),
        source: meta(conn, "source").unwrap_or_default(),
        rows,
        applied_at: meta(conn, "applied_at")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0),
    })
}

pub fn manifest(conn: &Connection) -> Option<Manifest> {
    serde_json::from_str(&meta(conn, "manifest")?).ok()
}

pub fn vocab(conn: &Connection) -> Vocab {
    meta(conn, "vocab")
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default()
}

/// The previous manifest in the history (for rollback), newest first after the current.
pub fn previous_manifest(conn: &Connection) -> Option<(Vec<u8>, String)> {
    let current = info(conn)?;
    conn.query_row(
        "SELECT manifest, source FROM manifest_history
         WHERE NOT (catalog = ?1 AND seq = ?2)
         ORDER BY applied_at DESC, seq DESC LIMIT 1",
        params![current.catalog, current.seq],
        |r| Ok((r.get::<_, Vec<u8>>(0)?, r.get::<_, String>(1)?)),
    )
    .optional()
    .ok()
    .flatten()
}

/// Objects kept from earlier applies (shard lists, shards, the vocab).
pub fn stored_object(conn: &Connection, hex: &str) -> Option<Vec<u8>> {
    conn.query_row("SELECT bytes FROM object WHERE hash = ?1", [hex], |r| {
        r.get(0)
    })
    .optional()
    .ok()
    .flatten()
}

pub fn known_bodies(conn: &Connection) -> HashSet<String> {
    let Ok(mut stmt) = conn.prepare("SELECT hash FROM body_cache") else {
        return HashSet::new();
    };
    stmt.query_map([], |r| r.get::<_, String>(0))
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

/// A stored row: its static rank and parsed metadata.
#[derive(Debug, Clone)]
pub struct StoredRow {
    pub rank: i64,
    pub row: Row,
}

/// Resolves an id or an alias to the stored id.
pub fn resolve_id(conn: &Connection, id: &str) -> Option<String> {
    let direct: Option<String> = conn
        .query_row(
            "SELECT id FROM entry WHERE id = ?1 AND revoked = 0",
            [id],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten();
    direct.or_else(|| {
        conn.query_row(
            "SELECT a.id FROM alias a JOIN entry e ON e.id = a.id WHERE a.alias = ?1 AND e.revoked = 0",
            [id],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten()
    })
}

pub fn row_by_id(conn: &Connection, id: &str) -> Option<StoredRow> {
    let id = resolve_id(conn, id)?;
    conn.query_row("SELECT rowid, row FROM entry WHERE id = ?1", [id], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
    })
    .optional()
    .ok()
    .flatten()
    .and_then(|(rank, raw)| {
        Some(StoredRow {
            rank,
            row: serde_json::from_str(&raw).ok()?,
        })
    })
}

pub fn rows_by_ids(conn: &Connection, ids: &[String]) -> Vec<StoredRow> {
    ids.iter().filter_map(|id| row_by_id(conn, id)).collect()
}

/// The body object (JSON text) of a row, from the cache.
pub fn body(conn: &Connection, body_ref: &str) -> Option<String> {
    let hex = parse_ref(body_ref).ok()?;
    let bytes: Vec<u8> = conn
        .query_row("SELECT text FROM body_cache WHERE hash = ?1", [&hex], |r| {
            r.get(0)
        })
        .optional()
        .ok()
        .flatten()?;
    let _ = conn.execute(
        "UPDATE body_cache SET last_used = ?1 WHERE hash = ?2",
        params![now_secs(), hex],
    );
    String::from_utf8(bytes).ok()
}

pub fn store_body(conn: &Connection, hex: &str, bytes: &[u8]) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO body_cache (hash, text, pinned, last_used) VALUES (?1, ?2, 0, ?3)",
        params![hex, bytes, now_secs()],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Entry counts per domain (browse).
pub fn domain_counts(conn: &Connection) -> Vec<(String, i64)> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT domain, count(*) FROM entry WHERE revoked = 0 GROUP BY domain ORDER BY count(*) DESC, domain",
    ) else {
        return Vec::new();
    };
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

/// Ids added or changed by the last update.
pub fn new_ids(conn: &Connection) -> Vec<String> {
    meta(conn, "new_ids")
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::super::catalog::{self, tests::three};
    use super::*;

    pub fn loaded() -> Connection {
        let f = three();
        let mut src = f.objects.clone();
        let cat = catalog::collect(&f.manifest, &mut src, true, &HashSet::new()).unwrap();
        let mut conn = open_in_memory().unwrap();
        apply(&mut conn, &cat, "bundled").unwrap();
        conn
    }

    #[test]
    fn applies_rows_in_static_order_with_aliases_and_bodies() {
        let conn = loaded();
        let info = info(&conn).unwrap();
        assert_eq!(
            (info.catalog.as_str(), info.seq, info.rows),
            ("2026.0101.0", 1, 3)
        );
        // q and u are 0: the static order is the id order.
        let first = row_by_id(&conn, "find-root-cause").unwrap();
        assert_eq!(first.rank, 1);
        assert_eq!(
            resolve_id(&conn, "debug-root-cause").as_deref(),
            Some("find-root-cause")
        );
        let body = body(&conn, &first.row.body).unwrap();
        assert!(body.contains("root cause"));
        assert_eq!(vocab(&conn).label("stack", "react"), "React");
    }

    #[test]
    fn a_second_apply_reports_what_changed() {
        let mut conn = loaded();
        let f = catalog::tests::fixture(
            "2026.0102.0",
            2,
            &[
                (
                    "write-component-tests",
                    serde_json::json!({"v": "1.1.0"}),
                    "Write better tests.",
                ),
                (
                    "find-root-cause",
                    serde_json::json!({}),
                    "Find the root cause of {{symptom}}.",
                ),
                ("brand-new", serde_json::json!({}), "New."),
            ],
        );
        let mut src = f.objects.clone();
        let cat = catalog::collect(&f.manifest, &mut src, true, &known_bodies(&conn)).unwrap();
        let s = apply(&mut conn, &cat, "update").unwrap();
        assert_eq!(s.added, vec!["brand-new".to_string()]);
        assert_eq!(
            s.changed,
            vec![(
                "write-component-tests".into(),
                "1.0.0".into(),
                "1.1.0".into()
            )]
        );
        assert_eq!(s.removed, vec!["summarize-notes".to_string()]);
        assert_eq!(new_ids(&conn).len(), 2);
        assert!(previous_manifest(&conn).is_some());
    }

    #[test]
    fn revoked_entries_disappear_from_search_and_lookup() {
        let f = three();
        let mut m: serde_json::Value = serde_json::from_slice(&f.manifest).unwrap();
        m["revoked"] = serde_json::json!(["summarize-notes@1.0.0"]);
        let bytes = serde_json::to_vec(&m).unwrap();
        let mut src = f.objects.clone();
        let cat = catalog::collect(&bytes, &mut src, true, &HashSet::new()).unwrap();
        let mut conn = open_in_memory().unwrap();
        let s = apply(&mut conn, &cat, "bundled").unwrap();
        assert_eq!(s.revoked, vec!["summarize-notes".to_string()]);
        assert!(row_by_id(&conn, "summarize-notes").is_none());
        let n: i64 = conn
            .query_row(
                "SELECT count(*) FROM entry_fts WHERE entry_fts MATCH 'summarize'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn rebuilds_a_corrupt_file() {
        let dir = std::env::temp_dir().join(format!("hermes-lib-store-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("library.db");
        std::fs::write(&path, b"this is not a database at all, not even close").unwrap();
        let conn = open(&path).unwrap();
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, STORE_VERSION);
        drop(conn);
        // An unknown version is rebuilt too.
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA user_version = 99").unwrap();
        drop(conn);
        let conn = open(&path).unwrap();
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, STORE_VERSION);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn facet_tokens_are_single_words() {
        assert_eq!(
            facet_token('d', "software-engineering"),
            "dsoftwareengineering"
        );
        assert_eq!(facet_token('w', "claude-code"), "wclaudecode");
        assert_eq!(facet_prefix("cat"), Some('c'));
        assert_eq!(facet_prefix("nope"), None);
    }
}
