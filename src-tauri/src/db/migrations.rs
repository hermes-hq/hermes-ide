//! Numbered schema migrations for the Hermes database.
//!
//! The schema version lives in SQLite's `PRAGMA user_version`. Every step in
//! [`MIGRATIONS`] moves the database from `version - 1` to `version` inside
//! one transaction, together with the `user_version` bump, so a step either
//! lands completely or not at all.
//!
//! Before any pending step runs on a database that already holds data, a full
//! copy is written with `VACUUM INTO` to `<db dir>/backups/`; the newest
//! [`BACKUPS_TO_KEEP`] copies are kept. A database whose `user_version` is
//! higher than this build knows about was written by a newer Hermes: it is
//! refused before anything is written to it.
//!
//! Adding a migration: append a `Migration` with the next version number.
//! Never edit or reorder a step that has shipped.

use rusqlite::{Connection, OpenFlags};
use std::fmt;
use std::path::{Path, PathBuf};

/// One step of the ladder.
pub struct Migration {
    /// The `user_version` the database has after this step.
    pub version: i64,
    pub name: &'static str,
    pub apply: fn(&Connection) -> rusqlite::Result<()>,
}

/// Every schema step, oldest first. Versions start at 1 and have no gaps.
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "baseline schema (all releases up to 1.4)",
        apply: baseline,
    },
    Migration {
        version: 2,
        name: "drop execution_nodes",
        apply: drop_execution_nodes,
    },
    Migration {
        version: 3,
        name: "create agent_turns (turn ledger)",
        apply: create_agent_turns,
    },
];

/// The schema version this build writes.
#[cfg(test)]
pub const SCHEMA_VERSION: i64 = MIGRATIONS[MIGRATIONS.len() - 1].version;

/// How many pre-migration backups are kept next to the database.
pub const BACKUPS_TO_KEEP: usize = 3;

/// Folder (next to the database file) that holds pre-migration backups.
pub const BACKUP_DIR: &str = "backups";

/// Why the database could not be opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenError {
    /// Written by a newer Hermes. Nothing was changed.
    NewerSchema { found: i64, supported: i64 },
    /// The pre-migration backup could not be written. Nothing was migrated.
    Backup(String),
    /// A migration step failed and was rolled back.
    Migration {
        version: i64,
        name: &'static str,
        error: String,
    },
    /// SQLite could not open or read the file.
    Sqlite(String),
}

impl fmt::Display for OpenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OpenError::NewerSchema { found, supported } => write!(
                f,
                "This data was saved by a newer version of Hermes (data version {found}; this version \
                 understands up to {supported}). Hermes has not opened or changed it. Install the \
                 latest version of Hermes to keep using your sessions and settings."
            ),
            OpenError::Backup(e) => write!(
                f,
                "Hermes needs to update its data, but could not save a backup first, so nothing was \
                 changed: {e}"
            ),
            OpenError::Migration {
                version,
                name,
                error,
            } => write!(
                f,
                "Hermes could not update its data (step {version}: {name}). The update was undone \
                 and your data is unchanged: {error}"
            ),
            OpenError::Sqlite(e) => write!(f, "Hermes could not open its data: {e}"),
        }
    }
}

impl std::error::Error for OpenError {}

/// What [`migrate`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationReport {
    pub from: i64,
    pub to: i64,
    /// The copy written before migrating, if one was needed.
    pub backup: Option<PathBuf>,
}

fn sqlite_err(e: rusqlite::Error) -> OpenError {
    OpenError::Sqlite(e.to_string())
}

pub fn user_version(conn: &Connection) -> Result<i64, OpenError> {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(sqlite_err)
}

/// Refuse a database written by a newer schema. Reads only.
pub fn check_not_newer(conn: &Connection, ladder: &[Migration]) -> Result<i64, OpenError> {
    let found = user_version(conn)?;
    let supported = ladder.last().map(|m| m.version).unwrap_or(0);
    if found > supported {
        return Err(OpenError::NewerSchema { found, supported });
    }
    Ok(found)
}

/// Refuse a database written by a newer schema that a crash left with a WAL
/// next to it, reading it through a read-only connection. A read-write
/// connection, even one that only reads, folds that WAL into the main file
/// when it closes; a read-only one cannot, so the newer data stays exactly as
/// it was.
///
/// Without a WAL there is nothing to fold, and the normal connection's check
/// is used instead: a read-only connection would leave -wal/-shm files behind
/// for a WAL-mode database, where a read-write one removes them on close. If
/// the file cannot be read read-only, the check is also left to the normal
/// connection, which reports the real error.
pub fn check_file_not_newer(path: &Path, ladder: &[Migration]) -> Result<(), OpenError> {
    let mut wal = path.as_os_str().to_owned();
    wal.push("-wal");
    if !path.exists() || !Path::new(&wal).exists() {
        return Ok(());
    }
    let conn = match Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[db] read-only version check skipped: {e}");
            return Ok(());
        }
    };
    match check_not_newer(&conn, ladder) {
        Err(e @ OpenError::NewerSchema { .. }) => Err(e),
        Err(e) => {
            log::warn!("[db] read-only version check skipped: {e}");
            Ok(())
        }
        Ok(_) => Ok(()),
    }
}

/// Bring the database up to the newest version in `ladder`.
///
/// `db_path` is the file the connection has open; it decides where the
/// backup goes. Pass `None` for an in-memory database (no backup).
pub fn migrate(
    conn: &Connection,
    db_path: Option<&Path>,
    ladder: &[Migration],
) -> Result<MigrationReport, OpenError> {
    let from = check_not_newer(conn, ladder)?;
    let to = ladder.last().map(|m| m.version).unwrap_or(0);
    let mut report = MigrationReport {
        from,
        to: from,
        backup: None,
    };
    if from == to {
        return Ok(report);
    }

    if let Some(path) = db_path {
        if has_user_data(conn)? {
            let backup = write_backup(conn, path, from)?;
            log::info!(
                "[db] backed up schema v{} database to {} before migrating to v{}",
                from,
                backup.display(),
                to
            );
            prune_backups(path, BACKUPS_TO_KEEP);
            report.backup = Some(backup);
        }
    }

    for step in ladder.iter().filter(|m| m.version > from) {
        apply_step(conn, step)?;
        report.to = step.version;
        log::info!("[db] migrated to schema v{} ({})", step.version, step.name);
    }
    Ok(report)
}

fn apply_step(conn: &Connection, step: &Migration) -> Result<(), OpenError> {
    let fail = |e: rusqlite::Error| OpenError::Migration {
        version: step.version,
        name: step.name,
        error: e.to_string(),
    };
    conn.execute_batch("BEGIN IMMEDIATE").map_err(fail)?;
    let result = (step.apply)(conn).and_then(|_| {
        // `user_version` is part of the database header, so it commits or
        // rolls back together with the step.
        conn.execute_batch(&format!("PRAGMA user_version = {}", step.version))
    });
    match result {
        Ok(()) => conn.execute_batch("COMMIT").map_err(fail),
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(fail(e))
        }
    }
}

/// True when the database already has tables (i.e. it is not a brand-new file).
fn has_user_data(conn: &Connection) -> Result<bool, OpenError> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            [],
            |r| r.get(0),
        )
        .map_err(sqlite_err)?;
    Ok(n > 0)
}

/// `<dir of db>/backups/<db stem>-<timestamp>-<nn>-from-v<version>.db`
fn backup_dir(db_path: &Path) -> PathBuf {
    db_path
        .parent()
        .map(|p| p.join(BACKUP_DIR))
        .unwrap_or_else(|| PathBuf::from(BACKUP_DIR))
}

fn backup_prefix(db_path: &Path) -> String {
    let stem = db_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "hermes".to_string());
    format!("{stem}-")
}

fn is_backup_name(name: &str, prefix: &str) -> bool {
    name.starts_with(prefix) && name.ends_with(".db") && name.contains("-from-v")
}

fn write_backup(conn: &Connection, db_path: &Path, from: i64) -> Result<PathBuf, OpenError> {
    let dir = backup_dir(db_path);
    std::fs::create_dir_all(&dir)
        .map_err(|e| OpenError::Backup(format!("{}: {}", dir.display(), e)))?;
    // Names sort lexically in creation order (timestamp, then a counter for
    // backups made within the same millisecond), which pruning relies on.
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S-%3f");
    let prefix = backup_prefix(db_path);
    let mut n = 0;
    let mut target = dir.join(format!("{prefix}{stamp}-{n:02}-from-v{from}.db"));
    while target.exists() {
        n += 1;
        target = dir.join(format!("{prefix}{stamp}-{n:02}-from-v{from}.db"));
    }
    let target_str = target.to_str().ok_or_else(|| {
        OpenError::Backup(format!("backup path is not UTF-8: {}", target.display()))
    })?;
    if let Err(e) = conn.execute("VACUUM INTO ?1", [target_str]) {
        let _ = std::fs::remove_file(&target);
        return Err(OpenError::Backup(e.to_string()));
    }
    Ok(target)
}

/// Delete all but the newest `keep` backups of this database. Only files
/// that follow the backup naming scheme are ever touched.
pub fn prune_backups(db_path: &Path, keep: usize) {
    let dir = backup_dir(db_path);
    let prefix = backup_prefix(db_path);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| is_backup_name(n, &prefix))
        .collect();
    names.sort();
    let excess = names.len().saturating_sub(keep);
    for name in names.into_iter().take(excess) {
        if let Err(e) = std::fs::remove_file(dir.join(&name)) {
            log::warn!("[db] could not remove old backup {}: {}", name, e);
        }
    }
}

/// Backups of `db_path`, oldest first.
#[cfg(test)]
pub fn list_backups(db_path: &Path) -> Vec<PathBuf> {
    let dir = backup_dir(db_path);
    let prefix = backup_prefix(db_path);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| is_backup_name(n, &prefix))
        .collect();
    names.sort();
    names.into_iter().map(|n| dir.join(n)).collect()
}

// ─── Helpers for steps ───────────────────────────────────────────────

fn has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
        [table, column],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    decl: &str,
) -> rusqlite::Result<()> {
    if !has_column(conn, table, column)? {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl};"))?;
    }
    Ok(())
}

/// True when `table` has a UNIQUE index on exactly the given column.
fn has_unique_index_on(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare("SELECT name FROM pragma_index_list(?1) WHERE \"unique\" = 1")?;
    let names: Vec<String> = stmt
        .query_map([table], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    for name in names {
        let mut cols = conn.prepare("SELECT name FROM pragma_index_info(?1)")?;
        let cols: Vec<Option<String>> = cols
            .query_map([&name], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        if cols.len() == 1 && cols[0].as_deref() == Some(column) {
            return Ok(true);
        }
    }
    Ok(false)
}

// ─── Step 1: baseline ────────────────────────────────────────────────

/// Brings any database written by Hermes up to and including 1.4 — or a
/// brand-new file — to the 1.4 schema. Those releases had no schema version;
/// they re-ran idempotent `CREATE ... IF NOT EXISTS` / `ALTER` statements on
/// every start, so this step has to accept every shape they left behind.
fn baseline(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '#58a6ff',
            group_name TEXT,
            phase TEXT NOT NULL DEFAULT 'destroyed',
            working_directory TEXT NOT NULL,
            shell TEXT NOT NULL,
            workspace_paths TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            closed_at TEXT,
            scrollback_snapshot TEXT
        );

        CREATE TABLE IF NOT EXISTS token_usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            estimated_cost_usd REAL DEFAULT 0.0,
            recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_token_session ON token_usage(session_id, provider);

        CREATE TABLE IF NOT EXISTS token_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            cost_usd REAL NOT NULL,
            recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_token_snap_session ON token_snapshots(session_id);
        CREATE INDEX IF NOT EXISTS idx_token_snap_date ON token_snapshots(recorded_at);

        CREATE TABLE IF NOT EXISTS cost_daily (
            date TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            total_input_tokens INTEGER NOT NULL DEFAULT 0,
            total_output_tokens INTEGER NOT NULL DEFAULT 0,
            total_cost_usd REAL NOT NULL DEFAULT 0.0,
            session_count INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (date, provider, model)
        );

        CREATE TABLE IF NOT EXISTS memory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope TEXT NOT NULL CHECK(scope IN ('session', 'project', 'global')),
            scope_id TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'general',
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'auto',
            confidence REAL NOT NULL DEFAULT 1.0,
            access_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            expires_at TEXT,
            UNIQUE(scope, scope_id, key)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory(scope, scope_id);

        CREATE TABLE IF NOT EXISTS execution_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            content TEXT NOT NULL,
            exit_code INTEGER,
            working_directory TEXT,
            timestamp TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_exec_session ON execution_log(session_id, timestamp);

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            detected_languages TEXT,
            detected_frameworks TEXT,
            file_tree_hash TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path);

        CREATE TABLE IF NOT EXISTS execution_nodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            kind TEXT NOT NULL DEFAULT 'command',
            input TEXT,
            output_summary TEXT,
            exit_code INTEGER,
            working_dir TEXT NOT NULL,
            duration_ms INTEGER DEFAULT 0,
            metadata TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_exec_nodes_session ON execution_nodes(session_id, timestamp);

        CREATE TABLE IF NOT EXISTS error_patterns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT,
            fingerprint TEXT NOT NULL,
            raw_sample TEXT,
            occurrence_count INTEGER DEFAULT 1,
            last_seen INTEGER,
            resolution TEXT,
            resolution_verified INTEGER DEFAULT 0,
            created_at INTEGER DEFAULT (strftime('%s','now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_error_fp ON error_patterns(project_id, fingerprint);

        CREATE TABLE IF NOT EXISTS command_patterns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT,
            sequence TEXT NOT NULL,
            next_command TEXT NOT NULL,
            frequency INTEGER DEFAULT 1,
            last_seen INTEGER DEFAULT (strftime('%s','now')),
            UNIQUE(project_id, sequence, next_command)
        );
        CREATE INDEX IF NOT EXISTS idx_cmd_patterns ON command_patterns(project_id, sequence);

        CREATE TABLE IF NOT EXISTS context_pins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            project_id TEXT,
            kind TEXT NOT NULL CHECK(kind IN ('file','memory','text','directory')),
            target TEXT NOT NULL,
            label TEXT,
            priority INTEGER DEFAULT 128,
            created_at INTEGER DEFAULT (strftime('%s','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_pins_session ON context_pins(session_id);
        CREATE INDEX IF NOT EXISTS idx_pins_project ON context_pins(project_id);

        CREATE TABLE IF NOT EXISTS error_sessions (
            error_pattern_id INTEGER NOT NULL,
            session_id TEXT NOT NULL,
            last_seen INTEGER NOT NULL,
            occurrence_count INTEGER DEFAULT 1,
            PRIMARY KEY (error_pattern_id, session_id)
        );

        CREATE TABLE IF NOT EXISTS realms (
            id TEXT PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            languages TEXT NOT NULL DEFAULT '[]',
            frameworks TEXT NOT NULL DEFAULT '[]',
            architecture TEXT,
            conventions TEXT NOT NULL DEFAULT '[]',
            scan_status TEXT NOT NULL DEFAULT 'pending',
            last_scanned_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_realms_path ON realms(path);

        CREATE TABLE IF NOT EXISTS session_realms (
            session_id TEXT NOT NULL,
            realm_id TEXT NOT NULL,
            attached_at TEXT NOT NULL DEFAULT (datetime('now')),
            role TEXT NOT NULL DEFAULT 'primary',
            PRIMARY KEY (session_id, realm_id)
        );
        CREATE INDEX IF NOT EXISTS idx_session_realms_session ON session_realms(session_id);

        CREATE TABLE IF NOT EXISTS realm_conventions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            realm_id TEXT NOT NULL,
            rule TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'detected',
            confidence REAL NOT NULL DEFAULT 0.8,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(realm_id, rule)
        );
        CREATE INDEX IF NOT EXISTS idx_conventions_realm ON realm_conventions(realm_id);

        CREATE TABLE IF NOT EXISTS context_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            context_json TEXT NOT NULL,
            created_at INTEGER DEFAULT (strftime('%s','now')),
            UNIQUE(session_id, version)
        );
        CREATE INDEX IF NOT EXISTS idx_ctx_snap_session ON context_snapshots(session_id);

        CREATE TABLE IF NOT EXISTS hermes_project_config (
            realm_id TEXT PRIMARY KEY,
            config_json TEXT NOT NULL,
            config_hash TEXT,
            loaded_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS session_worktrees (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            realm_id TEXT NOT NULL,
            worktree_path TEXT NOT NULL,
            branch_name TEXT,
            is_main_worktree INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(session_id, realm_id)
        );
        CREATE INDEX IF NOT EXISTS idx_sw_session ON session_worktrees(session_id);
        CREATE INDEX IF NOT EXISTS idx_sw_realm ON session_worktrees(realm_id);
        CREATE INDEX IF NOT EXISTS idx_sw_path ON session_worktrees(worktree_path);

        CREATE TABLE IF NOT EXISTS plugins (
            id TEXT PRIMARY KEY,
            version TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            author TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            permissions_granted TEXT NOT NULL DEFAULT '[]',
            installed_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS plugin_storage (
            plugin_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (plugin_id, key)
        );
        CREATE INDEX IF NOT EXISTS idx_plugin_storage_plugin ON plugin_storage(plugin_id);
        ",
    )?;

    // Early releases kept projects in `projects`; copy any that are not yet
    // realms (a no-op for databases where the old app already did this).
    conn.execute_batch(
        "
        INSERT OR IGNORE INTO realms (id, path, name, languages, frameworks, scan_status, created_at, updated_at)
        SELECT id, path, name,
               COALESCE(detected_languages, '[]'),
               COALESCE(detected_frameworks, '[]'),
               'surface',
               created_at,
               updated_at
        FROM projects;
        ",
    )?;

    add_column_if_missing(conn, "sessions", "description", "TEXT NOT NULL DEFAULT ''")?;
    add_column_if_missing(conn, "sessions", "ssh_info", "TEXT")?;

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS ssh_saved_hosts (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL DEFAULT 22,
            user TEXT NOT NULL,
            identity_file TEXT,
            jump_host TEXT,
            port_forwards TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        ",
    )?;

    add_column_if_missing(conn, "session_worktrees", "last_activity_at", "TEXT")?;

    // 0.5.13 - 0.5.18 made worktree_path UNIQUE, which stops several sessions
    // from sharing a worktree. SQLite cannot drop a constraint, so rebuild the
    // table without it. (Pre-ladder builds looked for the index by its
    // generated name, which also matched the (session_id, realm_id) index and
    // rebuilt the table on every start; this checks the indexed column.)
    if has_unique_index_on(conn, "session_worktrees", "worktree_path")? {
        conn.execute_batch(
            "
            CREATE TABLE session_worktrees_new (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                realm_id TEXT NOT NULL,
                worktree_path TEXT NOT NULL,
                branch_name TEXT,
                is_main_worktree INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                last_activity_at TEXT,
                UNIQUE(session_id, realm_id)
            );
            INSERT INTO session_worktrees_new (id, session_id, realm_id, worktree_path, branch_name, is_main_worktree, created_at, last_activity_at)
                SELECT id, session_id, realm_id, worktree_path, branch_name, is_main_worktree, created_at, last_activity_at
                FROM session_worktrees;
            DROP TABLE session_worktrees;
            ALTER TABLE session_worktrees_new RENAME TO session_worktrees;
            CREATE INDEX IF NOT EXISTS idx_sw_session ON session_worktrees(session_id);
            CREATE INDEX IF NOT EXISTS idx_sw_realm ON session_worktrees(realm_id);
            CREATE INDEX IF NOT EXISTS idx_sw_path ON session_worktrees(worktree_path);
            ",
        )?;
    }

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS project_usage (
            project_id TEXT PRIMARY KEY,
            session_count INTEGER NOT NULL DEFAULT 0,
            last_opened_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- Performance indexes (DB-08 .. DB-11).
        CREATE INDEX IF NOT EXISTS idx_sessions_closed_phase
            ON sessions(closed_at DESC, phase) WHERE closed_at IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_token_usage_recorded_at
            ON token_usage(recorded_at);
        CREATE INDEX IF NOT EXISTS idx_session_realms_realm
            ON session_realms(realm_id);
        CREATE INDEX IF NOT EXISTS idx_cmd_patterns_freq
            ON command_patterns(project_id, sequence, frequency DESC);
        ",
    )?;

    Ok(())
}

// ─── Step 2: drop execution_nodes ────────────────────────────────────

/// Releases up to 1.4 logged every shell command and its output to
/// `execution_nodes`, and nothing ever read it back. Hermes 2.0 no longer
/// writes it; the rows go with the table (the pre-migration backup keeps
/// them).
fn drop_execution_nodes(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        DROP INDEX IF EXISTS idx_exec_nodes_session;
        DROP TABLE IF EXISTS execution_nodes;
        ",
    )
}

// ─── Step 3: agent_turns ─────────────────────────────────────────────

/// The turn ledger (contract C0, filled by F20): one row per agent turn,
/// pointing at the hidden git ref `refs/hermes/<session>/turn/<n>` that
/// holds the worktree snapshot. Additive: nothing existing changes.
/// Timestamps are epoch milliseconds, like the frontend's `Turn`.
fn create_agent_turns(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS agent_turns (
            session_id TEXT NOT NULL,
            n INTEGER NOT NULL,
            git_ref TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            files INTEGER NOT NULL DEFAULT 0,
            insertions INTEGER NOT NULL DEFAULT 0,
            deletions INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (session_id, n)
        );
        CREATE INDEX IF NOT EXISTS idx_agent_turns_session
            ON agent_turns(session_id, started_at);
        ",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use std::collections::BTreeMap;
    use tempfile::TempDir;

    /// Databases written by real releases (see tests/fixtures/db/capture.mjs).
    const FIXTURES: &[(&str, &str)] = &[
        (
            "0.6.16",
            include_str!("../../tests/fixtures/db/v0.6.16.sql"),
        ),
        ("1.1.3", include_str!("../../tests/fixtures/db/v1.1.3.sql")),
        ("1.2.5", include_str!("../../tests/fixtures/db/v1.2.5.sql")),
        ("1.3.2", include_str!("../../tests/fixtures/db/v1.3.2.sql")),
        ("1.4.0", include_str!("../../tests/fixtures/db/v1.4.0.sql")),
    ];

    const DB_FILE: &str = "hermes_idea_v3.db";

    fn load_fixture(dir: &Path, dump: &str) -> PathBuf {
        let path = dir.join(DB_FILE);
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(dump).unwrap();
        path
    }

    fn tables(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' \
                 AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .unwrap();
        let names = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<Vec<String>, _>>()
            .unwrap();
        names
    }

    fn row_counts(path: &Path) -> BTreeMap<String, i64> {
        let conn = Connection::open(path).unwrap();
        tables(&conn)
            .into_iter()
            .map(|t| {
                let n: i64 = conn
                    .query_row(&format!("SELECT COUNT(*) FROM \"{t}\""), [], |r| r.get(0))
                    .unwrap();
                (t, n)
            })
            .collect()
    }

    type Schema = (BTreeMap<String, Vec<String>>, Vec<String>);

    /// Tables with their columns, and index names: what "same schema" means.
    fn schema_of(path: &Path) -> Schema {
        let conn = Connection::open(path).unwrap();
        let mut cols = BTreeMap::new();
        for t in tables(&conn) {
            let mut stmt = conn
                .prepare(
                    "SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info(?1)",
                )
                .unwrap();
            let mut c: Vec<String> = stmt
                .query_map([&t], |r| {
                    Ok(format!(
                        "{} {} nn={} d={:?} pk={}",
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, i64>(4)?
                    ))
                })
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            c.sort();
            cols.insert(t, c);
        }
        let mut stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'index' \
                 AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name",
            )
            .unwrap();
        let idx = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<Vec<String>, _>>()
            .unwrap();
        (cols, idx)
    }

    fn version_of(path: &Path) -> i64 {
        let conn = Connection::open(path).unwrap();
        user_version(&conn).unwrap()
    }

    fn setting(path: &Path, key: &str) -> Option<String> {
        let conn = Connection::open(path).unwrap();
        conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
            r.get(0)
        })
        .ok()
    }

    fn fresh_schema() -> Schema {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(DB_FILE);
        drop(Database::open(&path).unwrap());
        schema_of(&path)
    }

    #[test]
    fn ladder_is_numbered_from_one_without_gaps() {
        for (i, m) in MIGRATIONS.iter().enumerate() {
            assert_eq!(m.version, i as i64 + 1, "step {} ({})", i, m.name);
        }
        assert_eq!(SCHEMA_VERSION, MIGRATIONS.len() as i64);
    }

    #[test]
    fn new_database_gets_the_current_version_and_no_backup() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(DB_FILE);
        drop(Database::open(&path).unwrap());
        assert_eq!(version_of(&path), SCHEMA_VERSION);
        assert!(!dir.path().join(BACKUP_DIR).exists());
        // Opening again changes nothing.
        drop(Database::open(&path).unwrap());
        assert!(!dir.path().join(BACKUP_DIR).exists());
    }

    #[test]
    fn every_shipped_release_database_migrates_keeping_every_row() {
        let fresh = fresh_schema();
        for (release, dump) in FIXTURES {
            let dir = TempDir::new().unwrap();
            let path = load_fixture(dir.path(), dump);
            assert_eq!(
                version_of(&path),
                0,
                "{release}: fixtures predate the ladder"
            );
            let before = row_counts(&path);
            for t in [
                "sessions",
                "settings",
                "realms",
                "ssh_saved_hosts",
                "plugins",
            ] {
                assert!(before[t] > 0, "{release}: fixture has no {t} rows");
            }

            let db = Database::open(&path).unwrap_or_else(|e| panic!("{release}: {e}"));
            let integrity: String = db
                .conn
                .query_row("PRAGMA integrity_check", [], |r| r.get(0))
                .unwrap();
            assert_eq!(integrity, "ok", "{release}");
            let fk_problems: i64 = db
                .conn
                .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(fk_problems, 0, "{release}");
            drop(db);

            assert_eq!(version_of(&path), SCHEMA_VERSION, "{release}");
            let after = row_counts(&path);
            for (table, n) in &before {
                if table == "execution_nodes" {
                    continue;
                }
                assert_eq!(after.get(table), Some(n), "{release}: rows in {table}");
            }
            assert!(
                !after.contains_key("execution_nodes"),
                "{release}: execution_nodes is dropped"
            );
            // Step 3 adds agent_turns (empty); nothing else comes or goes.
            assert_eq!(after.get("agent_turns"), Some(&0), "{release}: agent_turns");
            assert_eq!(
                after.len(),
                before.len() - usize::from(before.contains_key("execution_nodes")) + 1,
                "{release}: no other table added or removed: {after:?}"
            );
            assert_eq!(
                schema_of(&path),
                fresh,
                "{release}: schema did not converge"
            );

            // Values survive, not just counts.
            assert_eq!(
                setting(&path, "fx_marker").as_deref(),
                Some("fixture-settings-row"),
                "{release}"
            );
            let conn = Connection::open(&path).unwrap();
            let (port, jump): (i64, String) = conn
                .query_row(
                    "SELECT port, jump_host FROM ssh_saved_hosts WHERE id = 'fx-host-2'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!((port, jump.as_str()), (2222, "bastion.example.test"));
            let timer_enabled: i64 = conn
                .query_row(
                    "SELECT enabled FROM plugins WHERE id = 'fx.plugin.timer'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(timer_enabled, 0, "{release}: plugin state");
            drop(conn);

            // One backup, holding the data exactly as the old release left it.
            let backups = list_backups(&path);
            assert_eq!(backups.len(), 1, "{release}: {backups:?}");
            assert!(backups[0]
                .file_name()
                .unwrap()
                .to_string_lossy()
                .ends_with("-from-v0.db"));
            assert_eq!(version_of(&backups[0]), 0);
            assert_eq!(row_counts(&backups[0]), before, "{release}: backup rows");

            // Opening the migrated database again is a no-op.
            drop(Database::open(&path).unwrap());
            assert_eq!(list_backups(&path).len(), 1, "{release}: no new backup");
            assert_eq!(row_counts(&path), after, "{release}: second open");
        }
    }

    #[test]
    fn database_from_a_newer_version_is_refused_and_left_untouched() {
        let dir = TempDir::new().unwrap();
        let path = load_fixture(dir.path(), FIXTURES[4].1);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(&format!("PRAGMA user_version = {};", SCHEMA_VERSION + 5))
                .unwrap();
        }
        let bytes_before = std::fs::read(&path).unwrap();

        let err = match Database::open(&path) {
            Err(e) => e,
            Ok(_) => panic!("a newer database must not open"),
        };
        assert_eq!(
            err,
            OpenError::NewerSchema {
                found: SCHEMA_VERSION + 5,
                supported: SCHEMA_VERSION
            }
        );
        assert!(err.to_string().contains("newer version of Hermes"));
        assert_eq!(std::fs::read(&path).unwrap(), bytes_before, "file changed");
        assert!(!dir.path().join(BACKUP_DIR).exists(), "no backup either");
        assert!(
            !dir.path().join(format!("{DB_FILE}-wal")).exists(),
            "not even switched to WAL"
        );
    }

    #[test]
    fn newer_wal_mode_database_closed_cleanly_gets_no_wal_or_shm_files() {
        let dir = TempDir::new().unwrap();
        let path = load_fixture(dir.path(), FIXTURES[4].1);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(&format!(
                "PRAGMA journal_mode=WAL; PRAGMA user_version = {};",
                SCHEMA_VERSION + 5
            ))
            .unwrap();
        }
        let bytes_before = std::fs::read(&path).unwrap();
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);

        assert!(matches!(
            Database::open(&path),
            Err(OpenError::NewerSchema { .. })
        ));
        assert_eq!(std::fs::read(&path).unwrap(), bytes_before, "file changed");
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            vec![DB_FILE.to_string()],
            "only the database is there"
        );
    }

    #[test]
    fn newer_database_left_mid_write_by_a_crash_is_refused_and_left_untouched() {
        // A newer Hermes wrote rows that are still only in the WAL when it
        // stopped. Refusing it must not fold that WAL into the main file.
        let dir = TempDir::new().unwrap();
        let live = load_fixture(dir.path(), FIXTURES[4].1);
        let writer = Connection::open(&live).unwrap();
        writer
            .execute_batch(&format!(
                "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
                 PRAGMA user_version = {};
                 INSERT INTO settings (key, value) VALUES ('only_in_wal', 'yes');",
                SCHEMA_VERSION + 5
            ))
            .unwrap();
        let crashed = TempDir::new().unwrap();
        let path = crashed.path().join(DB_FILE);
        let wal = crashed.path().join(format!("{DB_FILE}-wal"));
        std::fs::copy(&live, &path).unwrap();
        std::fs::copy(dir.path().join(format!("{DB_FILE}-wal")), &wal).unwrap();
        drop(writer);
        let names = || -> Vec<String> {
            let mut n: Vec<String> = std::fs::read_dir(crashed.path())
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                // SQLite's shared-memory index holds no data; any reader
                // rebuilds it from the WAL.
                .filter(|n| !n.ends_with("-shm"))
                .collect();
            n.sort();
            n
        };
        let files_before = names();
        let (db_before, wal_before) = (std::fs::read(&path).unwrap(), std::fs::read(&wal).unwrap());

        let err = match Database::open(&path) {
            Err(e) => e,
            Ok(_) => panic!("a newer database must not open"),
        };
        assert_eq!(
            err,
            OpenError::NewerSchema {
                found: SCHEMA_VERSION + 5,
                supported: SCHEMA_VERSION
            }
        );
        assert_eq!(
            std::fs::read(&path).unwrap(),
            db_before,
            "main file changed"
        );
        assert_eq!(std::fs::read(&wal).unwrap(), wal_before, "WAL changed");
        assert_eq!(names(), files_before, "no data file added or removed");
        // The newer version still finds its rows.
        assert_eq!(setting(&path, "only_in_wal").as_deref(), Some("yes"));
    }

    fn create_marker(conn: &Connection) -> rusqlite::Result<()> {
        conn.execute_batch("CREATE TABLE IF NOT EXISTS marker (id INTEGER PRIMARY KEY);")
    }

    fn create_then_fail(conn: &Connection) -> rusqlite::Result<()> {
        conn.execute_batch(
            "CREATE TABLE half_done (id INTEGER);
             INSERT INTO settings (key, value) VALUES ('half', 'done');",
        )?;
        conn.execute_batch("INSERT INTO no_such_table VALUES (1);")
    }

    fn noop(_: &Connection) -> rusqlite::Result<()> {
        Ok(())
    }

    /// The shipped ladder plus `extra` as the next step.
    fn ladder_plus(extra: Migration) -> Vec<Migration> {
        let mut ladder: Vec<Migration> = MIGRATIONS
            .iter()
            .map(|m| Migration {
                version: m.version,
                name: m.name,
                apply: m.apply,
            })
            .collect();
        ladder.push(extra);
        ladder
    }

    #[test]
    fn a_failing_step_is_rolled_back_completely() {
        let dir = TempDir::new().unwrap();
        let path = load_fixture(dir.path(), FIXTURES[4].1);
        let conn = Connection::open(&path).unwrap();
        migrate(&conn, Some(&path), MIGRATIONS).unwrap();
        let before = row_counts(&path);

        let ladder = ladder_plus(Migration {
            version: SCHEMA_VERSION + 1,
            name: "breaks halfway",
            apply: create_then_fail,
        });
        let err = migrate(&conn, Some(&path), &ladder).unwrap_err();
        match &err {
            OpenError::Migration { version, name, .. } => {
                assert_eq!((*version, *name), (SCHEMA_VERSION + 1, "breaks halfway"))
            }
            other => panic!("unexpected error: {other:?}"),
        }
        assert!(err.to_string().contains("your data is unchanged"));
        assert_eq!(user_version(&conn).unwrap(), SCHEMA_VERSION);
        assert_eq!(row_counts(&path), before);
        assert_eq!(setting(&path, "half"), None);
    }

    #[test]
    fn steps_run_in_order_and_each_is_recorded() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(DB_FILE);
        let conn = Connection::open(&path).unwrap();
        let ladder = [
            Migration {
                version: 1,
                name: "baseline",
                apply: baseline,
            },
            Migration {
                version: 2,
                name: "marker",
                apply: create_marker,
            },
        ];
        let report = migrate(&conn, Some(&path), &ladder).unwrap();
        assert_eq!((report.from, report.to), (0, 2));
        assert_eq!(report.backup, None, "an empty file needs no backup");
        assert!(tables(&conn).contains(&"marker".to_string()));

        // The next start has nothing to do.
        let again = migrate(&conn, Some(&path), &ladder).unwrap();
        assert_eq!((again.from, again.to, again.backup), (2, 2, None));
    }

    #[test]
    fn only_the_newest_three_backups_are_kept() {
        let dir = TempDir::new().unwrap();
        let path = load_fixture(dir.path(), FIXTURES[0].1);
        let unrelated = dir.path().join(BACKUP_DIR).join("keep-me.db");
        std::fs::create_dir_all(unrelated.parent().unwrap()).unwrap();
        std::fs::write(&unrelated, b"not a backup").unwrap();

        let conn = Connection::open(&path).unwrap();
        let steps: Vec<Migration> = (1..=5)
            .map(|v| Migration {
                version: v,
                name: "step",
                apply: if v == 1 { baseline } else { noop },
            })
            .collect();
        // Five upgrades, one version at a time.
        for last in 1..=5 {
            let report = migrate(&conn, Some(&path), &steps[..last]).unwrap();
            assert!(report.backup.is_some(), "upgrade to v{last} made a backup");
        }
        let names: Vec<String> = list_backups(&path)
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), BACKUPS_TO_KEEP, "{names:?}");
        for (name, from) in names.iter().zip([2, 3, 4]) {
            assert!(name.ends_with(&format!("-from-v{from}.db")), "{names:?}");
        }
        assert!(unrelated.exists(), "pruning touched a file it does not own");
    }

    #[test]
    fn if_the_backup_cannot_be_written_nothing_is_migrated() {
        let dir = TempDir::new().unwrap();
        let path = load_fixture(dir.path(), FIXTURES[0].1);
        // A file where the backup folder should be.
        std::fs::write(dir.path().join(BACKUP_DIR), b"").unwrap();
        let before = schema_of(&path);

        let err = match Database::open(&path) {
            Err(e) => e,
            Ok(_) => panic!("must not migrate without a backup"),
        };
        assert!(matches!(err, OpenError::Backup(_)), "{err:?}");
        assert_eq!(version_of(&path), 0);
        assert_eq!(schema_of(&path), before);
    }

    #[test]
    fn rows_left_in_the_wal_by_a_crash_are_kept() {
        let dir = TempDir::new().unwrap();
        let live = load_fixture(dir.path(), FIXTURES[4].1);
        let writer = Connection::open(&live).unwrap();
        writer
            .execute_batch(
                "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
                 INSERT INTO settings (key, value) VALUES ('only_in_wal', 'yes');",
            )
            .unwrap();
        // Copy the files while the writer is still open: what a crash leaves.
        let crashed = TempDir::new().unwrap();
        let path = crashed.path().join(DB_FILE);
        std::fs::copy(&live, &path).unwrap();
        std::fs::copy(
            dir.path().join(format!("{DB_FILE}-wal")),
            crashed.path().join(format!("{DB_FILE}-wal")),
        )
        .unwrap();
        drop(writer);

        drop(Database::open(&path).unwrap());
        assert_eq!(setting(&path, "only_in_wal").as_deref(), Some("yes"));
        let backup = &list_backups(&path)[0];
        assert_eq!(setting(backup, "only_in_wal").as_deref(), Some("yes"));
    }

    #[test]
    fn a_1_4_database_loses_only_execution_nodes_and_the_backup_keeps_them() {
        let dir = TempDir::new().unwrap();
        let path = load_fixture(dir.path(), FIXTURES[4].1);
        let before = row_counts(&path);
        assert!(before["execution_nodes"] > 0, "fixture has command history");

        drop(Database::open(&path).unwrap());

        let after = row_counts(&path);
        let mut expected = before.clone();
        expected.remove("execution_nodes");
        expected.insert("agent_turns".to_string(), 0); // added, empty, by step 3
        assert_eq!(after, expected, "every other table and row is kept");
        let conn = Connection::open(&path).unwrap();
        let leftovers: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name IN \
                 ('execution_nodes', 'idx_exec_nodes_session')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(leftovers, 0, "table and index are gone");
        drop(conn);

        let backups = list_backups(&path);
        assert_eq!(backups.len(), 1);
        assert_eq!(row_counts(&backups[0]), before, "the backup has the rows");
    }

    #[test]
    fn a_database_already_at_v1_drops_execution_nodes_with_a_backup_first() {
        // A 2.0 pre-release (schema v1) that has already been migrated once.
        let dir = TempDir::new().unwrap();
        let path = load_fixture(dir.path(), FIXTURES[4].1);
        let conn = Connection::open(&path).unwrap();
        migrate(&conn, None, &MIGRATIONS[..1]).unwrap();
        assert_eq!(user_version(&conn).unwrap(), 1);
        let before = row_counts(&path);

        let report = migrate(&conn, Some(&path), MIGRATIONS).unwrap();
        assert_eq!((report.from, report.to), (1, SCHEMA_VERSION));
        let backup = report.backup.expect("a backup before dropping data");
        assert!(backup.to_string_lossy().ends_with("-from-v1.db"));
        assert_eq!(row_counts(&backup), before);
        assert!(!row_counts(&path).contains_key("execution_nodes"));
    }

    #[test]
    fn a_new_database_has_no_execution_nodes_table() {
        assert!(!fresh_schema().0.contains_key("execution_nodes"));
    }

    #[test]
    fn step_3_adds_agent_turns_to_new_and_migrated_databases_and_touches_nothing_else() {
        let fresh = fresh_schema();
        let turns = fresh.0.get("agent_turns").expect("agent_turns table");
        for col in [
            "session_id",
            "n",
            "git_ref",
            "started_at",
            "ended_at",
            "files",
            "insertions",
            "deletions",
        ] {
            assert!(
                turns.iter().any(|c| c.starts_with(&format!("{col} "))),
                "{col} in {turns:?}"
            );
        }
        assert!(fresh.1.contains(&"idx_agent_turns_session".to_string()));

        // A 1.4.0 database migrated through steps 1 and 2 only, then to 3.
        let dir = TempDir::new().unwrap();
        let path = load_fixture(dir.path(), FIXTURES[4].1);
        let conn = Connection::open(&path).unwrap();
        migrate(&conn, None, &MIGRATIONS[..2]).unwrap();
        let before = schema_of(&path);
        let rows_before = row_counts(&path);
        assert!(!before.0.contains_key("agent_turns"));

        let report = migrate(&conn, Some(&path), MIGRATIONS).unwrap();
        assert_eq!((report.from, report.to), (2, 3));
        let after = schema_of(&path);
        let mut expected_tables = before.0.clone();
        expected_tables.insert("agent_turns".to_string(), turns.clone());
        assert_eq!(after.0, expected_tables, "only agent_turns was added");
        let mut expected_indexes = before.1.clone();
        expected_indexes.push("idx_agent_turns_session".to_string());
        expected_indexes.sort();
        assert_eq!(after.1, expected_indexes, "only its index was added");
        let mut rows_after = row_counts(&path);
        assert_eq!(rows_after.remove("agent_turns"), Some(0));
        assert_eq!(rows_after, rows_before, "every existing row is kept");
    }

    #[test]
    fn unique_worktree_path_from_0_5_is_dropped_keeping_rows() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(DB_FILE);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE session_worktrees (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    realm_id TEXT NOT NULL,
                    worktree_path TEXT NOT NULL UNIQUE,
                    branch_name TEXT,
                    is_main_worktree INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    UNIQUE(session_id, realm_id)
                 );
                 INSERT INTO session_worktrees (id, session_id, realm_id, worktree_path)
                    VALUES ('w1', 's1', 'r1', '/fixture-home/wt'),
                           ('w2', 's2', 'r1', '/fixture-home/wt2');",
            )
            .unwrap();
            assert!(has_unique_index_on(&conn, "session_worktrees", "worktree_path").unwrap());
        }
        let db = Database::open(&path).unwrap();
        assert!(!has_unique_index_on(&db.conn, "session_worktrees", "worktree_path").unwrap());
        assert!(has_column(&db.conn, "session_worktrees", "last_activity_at").unwrap());
        db.conn
            .execute(
                "INSERT INTO session_worktrees (id, session_id, realm_id, worktree_path) \
                 VALUES ('w3', 's3', 'r1', '/fixture-home/wt')",
                [],
            )
            .expect("sessions can share a worktree now");
        drop(db);
        assert_eq!(row_counts(&path)["session_worktrees"], 3);
    }
}
