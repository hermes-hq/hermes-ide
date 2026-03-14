use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use tauri::{AppHandle, Emitter, State};

use crate::pty::SessionUpdate;
use crate::AppState;

// ─── Execution Nodes ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionNode {
    pub id: i64,
    pub session_id: String,
    pub timestamp: i64,
    pub kind: String,
    pub input: Option<String>,
    pub output_summary: Option<String>,
    pub exit_code: Option<i32>,
    pub working_dir: String,
    pub duration_ms: i64,
    pub metadata: Option<String>,
}

// ─── Command Patterns ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandPrediction {
    pub next_command: String,
    pub frequency: i64,
}

// ─── Context Pins ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextPin {
    pub id: i64,
    pub session_id: Option<String>,
    pub project_id: Option<String>,
    pub kind: String,
    pub target: String,
    pub label: Option<String>,
    pub priority: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextSnapshotEntry {
    pub id: i64,
    pub session_id: String,
    pub version: i64,
    pub context_json: String,
    pub created_at: i64,
}

// ─── Cost by Project ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectCostEntry {
    pub working_directory: String,
    pub provider: String,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cost_usd: f64,
    pub session_count: i64,
}

pub struct Database {
    conn: Connection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEntry {
    pub id: i64,
    pub scope: String,
    pub scope_id: String,
    pub category: String,
    pub key: String,
    pub value: String,
    pub source: String,
    pub confidence: f64,
    pub access_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionEntry {
    pub id: i64,
    pub session_id: String,
    pub event_type: String,
    pub content: String,
    pub exit_code: Option<i32>,
    pub working_directory: Option<String>,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionHistoryEntry {
    pub id: String,
    pub label: String,
    pub color: String,
    pub working_directory: String,
    pub shell: String,
    pub created_at: String,
    pub closed_at: Option<String>,
    pub scrollback_preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsageEntry {
    pub provider: String,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub estimated_cost_usd: f64,
    pub recorded_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostDailyEntry {
    pub date: String,
    pub provider: String,
    pub model: String,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cost_usd: f64,
    pub session_count: i64,
}

// ─── Session Worktrees ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionWorktreeRow {
    pub id: String,
    pub session_id: String,
    pub realm_id: String,
    pub worktree_path: String,
    pub branch_name: Option<String>,
    pub is_main_worktree: bool,
    pub created_at: String,
}

impl Database {
    pub fn new(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| format!("Failed to open database: {}", e))?;
        conn.execute_batch("PRAGMA journal_mode=WAL;")
            .map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")
            .map_err(|e| e.to_string())?;

        let db = Self { conn };
        db.run_migrations()?;
        Ok(db)
    }

    fn run_migrations(&self) -> Result<(), String> {
        self.conn.execute_batch("
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
                UNIQUE(session_id, realm_id),
                UNIQUE(worktree_path)
            );
            CREATE INDEX IF NOT EXISTS idx_sw_session ON session_worktrees(session_id);
            CREATE INDEX IF NOT EXISTS idx_sw_realm ON session_worktrees(realm_id);

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
        ").map_err(|e| format!("Migration failed: {}", e))?;

        // Migrate existing projects → realms (one-time, idempotent)
        self.conn.execute_batch("
            INSERT OR IGNORE INTO realms (id, path, name, languages, frameworks, scan_status, created_at, updated_at)
            SELECT id, path, name,
                   COALESCE(detected_languages, '[]'),
                   COALESCE(detected_frameworks, '[]'),
                   'surface',
                   created_at,
                   updated_at
            FROM projects;
        ").map_err(|e| format!("Project→Realm migration failed: {}", e))?;

        // Add description column to sessions (idempotent)
        let _ = self
            .conn
            .execute_batch("ALTER TABLE sessions ADD COLUMN description TEXT NOT NULL DEFAULT '';");

        // Add ssh_info column to sessions (idempotent)
        let _ = self
            .conn
            .execute_batch("ALTER TABLE sessions ADD COLUMN ssh_info TEXT;");

        Ok(())
    }

    // ─── Session Operations ─────────────────────────────────────

    pub fn create_session_v2(&self, s: &SessionUpdate) -> Result<(), String> {
        self.conn.execute(
            "INSERT OR REPLACE INTO sessions (id, label, description, color, group_name, phase, working_directory, shell, workspace_paths, created_at, ssh_info)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![s.id, s.label, s.description, s.color, s.group, s.phase, s.working_directory, s.shell,
                    serde_json::to_string(&s.workspace_paths).unwrap_or_default(), s.created_at,
                    s.ssh_info.as_ref().map(|info| serde_json::to_string(info).unwrap_or_default())],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_session_status(&self, session_id: &str, status: &str) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE sessions SET phase = ?1, closed_at = datetime('now') WHERE id = ?2",
                params![status, session_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn save_session_snapshot(&self, session_id: &str, snapshot: &str) -> Result<(), String> {
        let trimmed = if snapshot.len() > 50000 {
            // Find a char boundary near the 50K mark from the end
            let target = snapshot.len() - 50000;
            let mut start = target;
            // UTF-8 chars are at most 4 bytes; limit iterations to prevent infinite loop on corrupted data
            let max_advance = start + 4;
            while start < snapshot.len() && start < max_advance && !snapshot.is_char_boundary(start)
            {
                start += 1;
            }
            if start >= snapshot.len() || !snapshot.is_char_boundary(start) {
                start = snapshot.len(); // fallback: return empty string rather than hang
            }
            &snapshot[start..]
        } else {
            snapshot
        };
        self.conn
            .execute(
                "UPDATE sessions SET scrollback_snapshot = ?1 WHERE id = ?2",
                params![trimmed, session_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_recent_sessions(&self, limit: i64) -> Result<Vec<SessionHistoryEntry>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT id, label, color, working_directory, shell, created_at, closed_at, substr(scrollback_snapshot, -200)
             FROM sessions WHERE phase = 'destroyed' AND closed_at IS NOT NULL
             ORDER BY closed_at DESC LIMIT ?1"
        ).map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![limit], |row| {
                Ok(SessionHistoryEntry {
                    id: row.get(0)?,
                    label: row.get(1)?,
                    color: row.get(2)?,
                    working_directory: row.get(3)?,
                    shell: row.get(4)?,
                    created_at: row.get(5)?,
                    closed_at: row.get(6)?,
                    scrollback_preview: row.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|e| e.to_string())?);
        }
        Ok(entries)
    }

    pub fn get_session_snapshot(&self, session_id: &str) -> Result<Option<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT scrollback_snapshot FROM sessions WHERE id = ?1")
            .map_err(|e| e.to_string())?;
        let result = stmt.query_row(params![session_id], |row| row.get(0)).ok();
        Ok(result)
    }

    // ─── Token Operations ───────────────────────────────────────

    pub fn record_token_usage(
        &self,
        session_id: &str,
        provider: &str,
        model: &str,
        input_tokens: i64,
        output_tokens: i64,
        cost: f64,
    ) -> Result<(), String> {
        self.conn.execute(
            "INSERT INTO token_usage (session_id, provider, model, input_tokens, output_tokens, estimated_cost_usd)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![session_id, provider, model, input_tokens, output_tokens, cost],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn record_token_snapshot(
        &self,
        session_id: &str,
        provider: &str,
        model: &str,
        input_tokens: i64,
        output_tokens: i64,
        cost: f64,
    ) -> Result<(), String> {
        self.conn.execute(
            "INSERT INTO token_snapshots (session_id, provider, model, input_tokens, output_tokens, cost_usd)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![session_id, provider, model, input_tokens, output_tokens, cost],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_token_usage_today(&self) -> Result<Vec<TokenUsageEntry>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT provider, model, SUM(input_tokens), SUM(output_tokens), SUM(estimated_cost_usd), MAX(recorded_at)
             FROM token_usage WHERE recorded_at >= date('now') GROUP BY provider, model"
        ).map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                Ok(TokenUsageEntry {
                    provider: row.get(0)?,
                    model: row.get(1)?,
                    input_tokens: row.get(2)?,
                    output_tokens: row.get(3)?,
                    estimated_cost_usd: row.get(4)?,
                    recorded_at: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|e| e.to_string())?);
        }
        Ok(entries)
    }

    pub fn get_cost_daily(&self, days: i64) -> Result<Vec<CostDailyEntry>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT date, provider, model, total_input_tokens, total_output_tokens, total_cost_usd, session_count
             FROM cost_daily WHERE date >= date('now', ?1) ORDER BY date DESC"
        ).map_err(|e| e.to_string())?;

        let offset = format!("-{} days", days);
        let rows = stmt
            .query_map(params![offset], |row| {
                Ok(CostDailyEntry {
                    date: row.get(0)?,
                    provider: row.get(1)?,
                    model: row.get(2)?,
                    total_input_tokens: row.get(3)?,
                    total_output_tokens: row.get(4)?,
                    total_cost_usd: row.get(5)?,
                    session_count: row.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|e| e.to_string())?);
        }
        Ok(entries)
    }

    pub fn update_cost_daily_rollup(&self) -> Result<(), String> {
        self.conn.execute_batch("
            INSERT OR REPLACE INTO cost_daily (date, provider, model, total_input_tokens, total_output_tokens, total_cost_usd, session_count)
            SELECT date(recorded_at) as d, provider, model,
                   SUM(input_tokens), SUM(output_tokens), SUM(estimated_cost_usd),
                   COUNT(DISTINCT session_id)
            FROM token_usage
            WHERE recorded_at >= date('now', '-7 days')
            GROUP BY d, provider, model
        ").map_err(|e| e.to_string())?;
        Ok(())
    }

    // ─── Memory Operations ──────────────────────────────────────

    // Tauri command handler — many params needed for DB insert
    #[allow(clippy::too_many_arguments)]
    pub fn save_memory_entry(
        &self,
        scope: &str,
        scope_id: &str,
        key: &str,
        value: &str,
        source: &str,
        category: &str,
        confidence: f64,
    ) -> Result<(), String> {
        self.conn.execute(
            "INSERT INTO memory (scope, scope_id, key, value, source, category, confidence, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))
             ON CONFLICT(scope, scope_id, key) DO UPDATE SET
                value = excluded.value, source = excluded.source, category = excluded.category,
                confidence = excluded.confidence, access_count = access_count + 1,
                updated_at = datetime('now')",
            params![scope, scope_id, key, value, source, category, confidence],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_memory_entry(
        &self,
        scope: &str,
        scope_id: &str,
        key: &str,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "DELETE FROM memory WHERE scope = ?1 AND scope_id = ?2 AND key = ?3",
                params![scope, scope_id, key],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_all_memory_entries(
        &self,
        scope: &str,
        scope_id: &str,
    ) -> Result<Vec<MemoryEntry>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT id, scope, scope_id, category, key, value, source, confidence, access_count, created_at, updated_at
             FROM memory WHERE scope = ?1 AND scope_id = ?2
             AND (expires_at IS NULL OR expires_at > datetime('now'))
             ORDER BY access_count DESC, updated_at DESC"
        ).map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![scope, scope_id], |row| {
                Ok(MemoryEntry {
                    id: row.get(0)?,
                    scope: row.get(1)?,
                    scope_id: row.get(2)?,
                    category: row.get(3)?,
                    key: row.get(4)?,
                    value: row.get(5)?,
                    source: row.get(6)?,
                    confidence: row.get(7)?,
                    access_count: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|e| e.to_string())?);
        }
        Ok(entries)
    }

    // ─── Settings ────────────────────────────────────────────────

    pub fn get_setting(&self, key: &str) -> Result<Option<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT value FROM settings WHERE key = ?1")
            .map_err(|e| e.to_string())?;
        let result = stmt.query_row(params![key], |row| row.get(0)).ok();
        Ok(result)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
                params![key, value],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_all_settings(&self) -> Result<HashMap<String, String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT key, value FROM settings")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        let mut map = HashMap::new();
        for row in rows {
            let (k, v) = row.map_err(|e| e.to_string())?;
            map.insert(k, v);
        }
        Ok(map)
    }

    // ─── Execution Log ──────────────────────────────────────────

    pub fn log_execution_entry(
        &self,
        session_id: &str,
        event_type: &str,
        content: &str,
        exit_code: Option<i32>,
        working_directory: Option<&str>,
    ) -> Result<(), String> {
        self.conn.execute(
            "INSERT INTO execution_log (session_id, event_type, content, exit_code, working_directory)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![session_id, event_type, content, exit_code, working_directory],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_execution_log_entries(
        &self,
        session_id: &str,
        limit: Option<i64>,
    ) -> Result<Vec<ExecutionEntry>, String> {
        let limit = limit.unwrap_or(100);
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, event_type, content, exit_code, working_directory, timestamp
             FROM execution_log WHERE session_id = ?1 ORDER BY timestamp DESC LIMIT ?2"
        ).map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![session_id, limit], |row| {
                Ok(ExecutionEntry {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    event_type: row.get(2)?,
                    content: row.get(3)?,
                    exit_code: row.get(4)?,
                    working_directory: row.get(5)?,
                    timestamp: row.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|e| e.to_string())?);
        }
        Ok(entries)
    }

    // ─── Project Operations ─────────────────────────────────────

    pub fn upsert_project(
        &self,
        id: &str,
        path: &str,
        name: &str,
        languages: &str,
        frameworks: &str,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO projects (id, path, name, detected_languages, detected_frameworks)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(path) DO UPDATE SET
                name = excluded.name, detected_languages = excluded.detected_languages,
                detected_frameworks = excluded.detected_frameworks, updated_at = datetime('now')",
                params![id, path, name, languages, frameworks],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_all_projects(&self) -> Result<Vec<crate::workspace::ProjectInfo>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, name, detected_languages, detected_frameworks, created_at FROM projects ORDER BY updated_at DESC"
        ).map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                let languages_str: String = row.get(3)?;
                let frameworks_str: String = row.get(4)?;
                Ok(crate::workspace::ProjectInfo {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    name: row.get(2)?,
                    languages: serde_json::from_str(&languages_str).unwrap_or_default(),
                    frameworks: serde_json::from_str(&frameworks_str).unwrap_or_default(),
                    created_at: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut projects = Vec::new();
        for row in rows {
            projects.push(row.map_err(|e| e.to_string())?);
        }
        Ok(projects)
    }

    // ─── Execution Nodes ─────────────────────────────────────────

    // DB insert with many columns — keeping flat signature
    #[allow(clippy::too_many_arguments)]
    pub fn insert_execution_node(
        &self,
        session_id: &str,
        timestamp: i64,
        kind: &str,
        input: Option<&str>,
        output_summary: Option<&str>,
        exit_code: Option<i32>,
        working_dir: &str,
        duration_ms: i64,
        metadata: Option<&str>,
    ) -> Result<i64, String> {
        self.conn.execute(
            "INSERT INTO execution_nodes (session_id, timestamp, kind, input, output_summary, exit_code, working_dir, duration_ms, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![session_id, timestamp, kind, input, output_summary, exit_code, working_dir, duration_ms, metadata],
        ).map_err(|e| e.to_string())?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn get_execution_nodes(
        &self,
        session_id: &str,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<ExecutionNode>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, timestamp, kind, input, output_summary, exit_code, working_dir, duration_ms, metadata
             FROM execution_nodes WHERE session_id = ?1 ORDER BY timestamp DESC LIMIT ?2 OFFSET ?3"
        ).map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![session_id, limit, offset], |row| {
                Ok(ExecutionNode {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    timestamp: row.get(2)?,
                    kind: row.get(3)?,
                    input: row.get(4)?,
                    output_summary: row.get(5)?,
                    exit_code: row.get(6)?,
                    working_dir: row.get(7)?,
                    duration_ms: row.get(8)?,
                    metadata: row.get(9)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|e| e.to_string())?);
        }
        Ok(entries)
    }

    pub fn get_execution_node(&self, id: i64) -> Result<Option<ExecutionNode>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, timestamp, kind, input, output_summary, exit_code, working_dir, duration_ms, metadata
             FROM execution_nodes WHERE id = ?1"
        ).map_err(|e| e.to_string())?;

        let result = stmt
            .query_row(params![id], |row| {
                Ok(ExecutionNode {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    timestamp: row.get(2)?,
                    kind: row.get(3)?,
                    input: row.get(4)?,
                    output_summary: row.get(5)?,
                    exit_code: row.get(6)?,
                    working_dir: row.get(7)?,
                    duration_ms: row.get(8)?,
                    metadata: row.get(9)?,
                })
            })
            .ok();
        Ok(result)
    }

    // ─── Command Patterns ────────────────────────────────────────

    pub fn record_command_sequence(
        &self,
        project_id: Option<&str>,
        sequence_json: &str,
        next_command: &str,
    ) -> Result<(), String> {
        let now_ts = chrono::Utc::now().timestamp();
        self.conn.execute(
            "INSERT INTO command_patterns (project_id, sequence, next_command, frequency, last_seen)
             VALUES (?1, ?2, ?3, 1, ?4)
             ON CONFLICT(project_id, sequence, next_command) DO UPDATE SET
                frequency = frequency + 1, last_seen = ?4",
            params![project_id, sequence_json, next_command, now_ts],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn predict_next_command(
        &self,
        project_id: Option<&str>,
        sequence_json: &str,
        limit: i64,
    ) -> Result<Vec<CommandPrediction>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT next_command, frequency FROM command_patterns
             WHERE (project_id = ?1 OR (project_id IS NULL AND ?1 IS NULL)) AND sequence = ?2
             ORDER BY frequency DESC LIMIT ?3",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![project_id, sequence_json, limit], |row| {
                Ok(CommandPrediction {
                    next_command: row.get(0)?,
                    frequency: row.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|e| e.to_string())?);
        }
        Ok(entries)
    }

    // ─── Context Pins ────────────────────────────────────────────

    pub fn add_context_pin(
        &self,
        session_id: Option<&str>,
        project_id: Option<&str>,
        kind: &str,
        target: &str,
        label: Option<&str>,
        priority: Option<i64>,
    ) -> Result<i64, String> {
        self.conn
            .execute(
                "INSERT INTO context_pins (session_id, project_id, kind, target, label, priority)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    session_id,
                    project_id,
                    kind,
                    target,
                    label,
                    priority.unwrap_or(128)
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn remove_context_pin(&self, id: i64) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM context_pins WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_pin_session_id(&self, id: i64) -> Result<Option<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT session_id FROM context_pins WHERE id = ?1")
            .map_err(|e| e.to_string())?;
        let result = stmt.query_row(params![id], |row| row.get(0)).ok();
        Ok(result)
    }

    pub fn get_context_pins(
        &self,
        session_id: Option<&str>,
        project_id: Option<&str>,
    ) -> Result<Vec<ContextPin>, String> {
        // Return pins that match the session OR the project (project-scoped pins are shared)
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, project_id, kind, target, label, priority, created_at
             FROM context_pins
             WHERE (session_id = ?1 OR (session_id IS NULL AND project_id = ?2) OR (session_id IS NULL AND project_id IS NULL))
             ORDER BY priority DESC, created_at DESC"
        ).map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![session_id, project_id], |row| {
                Ok(ContextPin {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    project_id: row.get(2)?,
                    kind: row.get(3)?,
                    target: row.get(4)?,
                    label: row.get(5)?,
                    priority: row.get(6)?,
                    created_at: row.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|e| e.to_string())?);
        }
        Ok(entries)
    }

    /// Get merged memory: project-scoped + global, with project taking precedence
    pub fn get_merged_memory(&self, realm_ids: &[String]) -> Result<Vec<MemoryEntry>, String> {
        // Start with global memory
        let mut entries = self.get_all_memory_entries("global", "global")?;
        let mut seen_keys = std::collections::HashSet::new();
        let mut result = Vec::new();

        // Project-scoped memory takes precedence
        for realm_id in realm_ids {
            let project_entries = self.get_all_memory_entries("project", realm_id)?;
            for entry in project_entries {
                if seen_keys.insert(entry.key.clone()) {
                    result.push(entry);
                }
            }
        }

        // Add global entries that aren't overridden
        for entry in entries.drain(..) {
            if seen_keys.insert(entry.key.clone()) {
                result.push(entry);
            }
        }

        Ok(result)
    }

    /// Clean up session-scoped pins when a session is closed
    pub fn cleanup_session_pins(&self, session_id: &str) -> Result<usize, String> {
        let count = self
            .conn
            .execute(
                "DELETE FROM context_pins WHERE session_id = ?1",
                params![session_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(count)
    }

    /// Fork context pins from one session (and its project) to a new session
    pub fn fork_context_pins(
        &self,
        source_session_id: &str,
        target_session_id: &str,
    ) -> Result<usize, String> {
        // Copy session-scoped pins from source to target session
        let count = self
            .conn
            .execute(
                "INSERT INTO context_pins (session_id, project_id, kind, target, label, priority)
             SELECT ?2, project_id, kind, target, label, priority
             FROM context_pins WHERE session_id = ?1",
                params![source_session_id, target_session_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(count)
    }

    /// Save .hermes/context.json config for a realm
    pub fn save_hermes_config(
        &self,
        realm_id: &str,
        config_json: &str,
        config_hash: &str,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO hermes_project_config (realm_id, config_json, config_hash, loaded_at)
             VALUES (?1, ?2, ?3, datetime('now'))
             ON CONFLICT(realm_id) DO UPDATE SET
                config_json = excluded.config_json,
                config_hash = excluded.config_hash,
                loaded_at = datetime('now')",
                params![realm_id, config_json, config_hash],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Get .hermes/context.json config for a realm
    pub fn get_hermes_config(
        &self,
        realm_id: &str,
    ) -> Result<Option<(String, Option<String>)>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT config_json, config_hash FROM hermes_project_config WHERE realm_id = ?1",
            )
            .map_err(|e| e.to_string())?;
        let result = stmt
            .query_row(params![realm_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .ok();
        Ok(result)
    }

    // ─── Context Snapshots ───────────────────────────────────────

    pub fn save_context_snapshot(
        &self,
        session_id: &str,
        version: i64,
        context_json: &str,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT OR REPLACE INTO context_snapshots (session_id, version, context_json)
             VALUES (?1, ?2, ?3)",
                params![session_id, version, context_json],
            )
            .map_err(|e| e.to_string())?;

        // Keep only last 5 snapshots per session
        self.conn
            .execute(
                "DELETE FROM context_snapshots WHERE session_id = ?1 AND id NOT IN (
                SELECT id FROM context_snapshots WHERE session_id = ?1 ORDER BY version DESC LIMIT 5
            )",
                params![session_id],
            )
            .map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn get_context_snapshots(
        &self,
        session_id: &str,
    ) -> Result<Vec<ContextSnapshotEntry>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, session_id, version, context_json, created_at
             FROM context_snapshots WHERE session_id = ?1 ORDER BY version DESC LIMIT 5",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![session_id], |row| {
                Ok(ContextSnapshotEntry {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    version: row.get(2)?,
                    context_json: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|e| e.to_string())?);
        }
        Ok(entries)
    }

    pub fn get_context_snapshot(
        &self,
        session_id: &str,
        version: i64,
    ) -> Result<Option<ContextSnapshotEntry>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, session_id, version, context_json, created_at
             FROM context_snapshots WHERE session_id = ?1 AND version = ?2",
            )
            .map_err(|e| e.to_string())?;

        let mut rows = stmt
            .query_map(params![session_id, version], |row| {
                Ok(ContextSnapshotEntry {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    version: row.get(2)?,
                    context_json: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;

        match rows.next() {
            Some(row) => Ok(Some(row.map_err(|e| e.to_string())?)),
            None => Ok(None),
        }
    }

    // ─── Session Group ────────────────────────────────────────────

    pub fn update_session_group(
        &self,
        session_id: &str,
        group: Option<&str>,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE sessions SET group_name = ?1 WHERE id = ?2",
                params![group, session_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ─── Session Label ─────────────────────────────────────────

    pub fn update_session_label(&self, session_id: &str, label: &str) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE sessions SET label = ?1 WHERE id = ?2",
                params![label, session_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ─── Session Description ─────────────────────────────────────

    pub fn update_session_description(
        &self,
        session_id: &str,
        description: &str,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE sessions SET description = ?1 WHERE id = ?2",
                params![description, session_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ─── Session Color ───────────────────────────────────────────

    pub fn update_session_color(&self, session_id: &str, color: &str) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE sessions SET color = ?1 WHERE id = ?2",
                params![color, session_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ─── Execution Nodes Count ───────────────────────────────────

    pub fn get_execution_nodes_count(&self, session_id: &str) -> Result<i64, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT COUNT(*) FROM execution_nodes WHERE session_id = ?1")
            .map_err(|e| e.to_string())?;
        stmt.query_row(params![session_id], |row| row.get(0))
            .map_err(|e| e.to_string())
    }

    // ─── Realm Operations ─────────────────────────────────────────

    pub fn insert_realm(
        &self,
        id: &str,
        path: &str,
        name: &str,
        languages: &str,
        frameworks: &str,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO realms (id, path, name, languages, frameworks)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(path) DO UPDATE SET
                name = excluded.name, languages = excluded.languages,
                frameworks = excluded.frameworks, updated_at = datetime('now')",
                params![id, path, name, languages, frameworks],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_all_realms(&self) -> Result<Vec<crate::realm::Realm>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, name, languages, frameworks, architecture, conventions, scan_status, last_scanned_at, created_at, updated_at
             FROM realms ORDER BY updated_at DESC"
        ).map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                let languages_str: String = row.get(3)?;
                let frameworks_str: String = row.get(4)?;
                let architecture_str: Option<String> = row.get(5)?;
                let conventions_str: String = row.get(6)?;
                Ok(crate::realm::Realm {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    name: row.get(2)?,
                    languages: serde_json::from_str(&languages_str).unwrap_or_default(),
                    frameworks: serde_json::from_str(&frameworks_str).unwrap_or_default(),
                    architecture: architecture_str.and_then(|s| serde_json::from_str(&s).ok()),
                    conventions: serde_json::from_str(&conventions_str).unwrap_or_default(),
                    scan_status: row.get(7)?,
                    last_scanned_at: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|e| e.to_string())?);
        }
        Ok(entries)
    }

    pub fn get_realm(&self, id: &str) -> Result<Option<crate::realm::Realm>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, name, languages, frameworks, architecture, conventions, scan_status, last_scanned_at, created_at, updated_at
             FROM realms WHERE id = ?1"
        ).map_err(|e| e.to_string())?;

        let result = stmt
            .query_row(params![id], |row| {
                let languages_str: String = row.get(3)?;
                let frameworks_str: String = row.get(4)?;
                let architecture_str: Option<String> = row.get(5)?;
                let conventions_str: String = row.get(6)?;
                Ok(crate::realm::Realm {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    name: row.get(2)?,
                    languages: serde_json::from_str(&languages_str).unwrap_or_default(),
                    frameworks: serde_json::from_str(&frameworks_str).unwrap_or_default(),
                    architecture: architecture_str.and_then(|s| serde_json::from_str(&s).ok()),
                    conventions: serde_json::from_str(&conventions_str).unwrap_or_default(),
                    scan_status: row.get(7)?,
                    last_scanned_at: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            })
            .ok();
        Ok(result)
    }

    pub fn get_realm_by_path(&self, path: &str) -> Result<Option<crate::realm::Realm>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, name, languages, frameworks, architecture, conventions, scan_status, last_scanned_at, created_at, updated_at
             FROM realms WHERE path = ?1"
        ).map_err(|e| e.to_string())?;

        let result = stmt
            .query_row(params![path], |row| {
                let languages_str: String = row.get(3)?;
                let frameworks_str: String = row.get(4)?;
                let architecture_str: Option<String> = row.get(5)?;
                let conventions_str: String = row.get(6)?;
                Ok(crate::realm::Realm {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    name: row.get(2)?,
                    languages: serde_json::from_str(&languages_str).unwrap_or_default(),
                    frameworks: serde_json::from_str(&frameworks_str).unwrap_or_default(),
                    architecture: architecture_str.and_then(|s| serde_json::from_str(&s).ok()),
                    conventions: serde_json::from_str(&conventions_str).unwrap_or_default(),
                    scan_status: row.get(7)?,
                    last_scanned_at: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            })
            .ok();
        Ok(result)
    }

    pub fn update_realm_scan(
        &self,
        id: &str,
        scan_status: &str,
        architecture: Option<&str>,
        conventions: Option<&str>,
        languages: Option<&str>,
        frameworks: Option<&str>,
    ) -> Result<(), String> {
        self.conn.execute(
            "UPDATE realms SET scan_status = ?1, last_scanned_at = datetime('now'), updated_at = datetime('now') WHERE id = ?2",
            params![scan_status, id],
        ).map_err(|e| e.to_string())?;

        if let Some(arch) = architecture {
            self.conn
                .execute(
                    "UPDATE realms SET architecture = ?1 WHERE id = ?2",
                    params![arch, id],
                )
                .map_err(|e| e.to_string())?;
        }
        if let Some(conv) = conventions {
            self.conn
                .execute(
                    "UPDATE realms SET conventions = ?1 WHERE id = ?2",
                    params![conv, id],
                )
                .map_err(|e| e.to_string())?;
        }
        if let Some(langs) = languages {
            self.conn
                .execute(
                    "UPDATE realms SET languages = ?1 WHERE id = ?2",
                    params![langs, id],
                )
                .map_err(|e| e.to_string())?;
        }
        if let Some(fws) = frameworks {
            self.conn
                .execute(
                    "UPDATE realms SET frameworks = ?1 WHERE id = ?2",
                    params![fws, id],
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn delete_realm(&self, id: &str) -> Result<(), String> {
        self.conn
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        let result = (|| -> Result<(), String> {
            self.conn
                .execute(
                    "DELETE FROM session_realms WHERE realm_id = ?1",
                    params![id],
                )
                .map_err(|e| e.to_string())?;
            self.conn
                .execute(
                    "DELETE FROM realm_conventions WHERE realm_id = ?1",
                    params![id],
                )
                .map_err(|e| e.to_string())?;
            self.conn
                .execute("DELETE FROM realms WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                self.conn
                    .execute_batch("COMMIT")
                    .map_err(|e| e.to_string())?;
                Ok(())
            }
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    pub fn attach_session_realm(
        &self,
        session_id: &str,
        realm_id: &str,
        role: &str,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT OR IGNORE INTO session_realms (session_id, realm_id, role)
             VALUES (?1, ?2, ?3)",
                params![session_id, realm_id, role],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn detach_session_realm(&self, session_id: &str, realm_id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "DELETE FROM session_realms WHERE session_id = ?1 AND realm_id = ?2",
                params![session_id, realm_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_session_realms(&self, session_id: &str) -> Result<Vec<crate::realm::Realm>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT r.id, r.path, r.name, r.languages, r.frameworks, r.architecture, r.conventions, r.scan_status, r.last_scanned_at, r.created_at, r.updated_at
             FROM realms r
             JOIN session_realms sr ON sr.realm_id = r.id
             WHERE sr.session_id = ?1
             ORDER BY sr.attached_at"
        ).map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![session_id], |row| {
                let languages_str: String = row.get(3)?;
                let frameworks_str: String = row.get(4)?;
                let architecture_str: Option<String> = row.get(5)?;
                let conventions_str: String = row.get(6)?;
                Ok(crate::realm::Realm {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    name: row.get(2)?,
                    languages: serde_json::from_str(&languages_str).unwrap_or_default(),
                    frameworks: serde_json::from_str(&frameworks_str).unwrap_or_default(),
                    architecture: architecture_str.and_then(|s| serde_json::from_str(&s).ok()),
                    conventions: serde_json::from_str(&conventions_str).unwrap_or_default(),
                    scan_status: row.get(7)?,
                    last_scanned_at: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|e| e.to_string())?);
        }
        Ok(entries)
    }

    /// Get realm IDs attached to a given session.
    pub fn get_sessions_for_realm_by_session(
        &self,
        session_id: &str,
    ) -> Result<Vec<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT realm_id FROM session_realms WHERE session_id = ?1")
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![session_id], |row| row.get(0))
            .map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|e| e.to_string())?);
        }
        Ok(entries)
    }

    pub fn get_sessions_for_realm(&self, realm_id: &str) -> Result<Vec<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT session_id FROM session_realms WHERE realm_id = ?1")
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![realm_id], |row| row.get(0))
            .map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|e| e.to_string())?);
        }
        Ok(entries)
    }

    pub fn insert_convention(
        &self,
        realm_id: &str,
        rule: &str,
        source: &str,
        confidence: f64,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO realm_conventions (realm_id, rule, source, confidence)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(realm_id, rule) DO UPDATE SET
                source = excluded.source, confidence = excluded.confidence",
                params![realm_id, rule, source, confidence],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_conventions(&self, realm_id: &str) -> Result<Vec<crate::realm::Convention>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT rule, source, confidence FROM realm_conventions WHERE realm_id = ?1 ORDER BY confidence DESC"
        ).map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![realm_id], |row| {
                Ok(crate::realm::Convention {
                    rule: row.get(0)?,
                    source: row.get(1)?,
                    confidence: row.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|e| e.to_string())?);
        }
        Ok(entries)
    }

    // ─── Cost by Project ─────────────────────────────────────────

    pub fn get_cost_by_project(&self, days: i64) -> Result<Vec<ProjectCostEntry>, String> {
        let offset = format!("-{} days", days);
        let mut stmt = self
            .conn
            .prepare(
                "SELECT s.working_directory, t.provider,
                    SUM(t.input_tokens), SUM(t.output_tokens), SUM(t.estimated_cost_usd),
                    COUNT(DISTINCT t.session_id)
             FROM token_usage t
             JOIN sessions s ON s.id = t.session_id
             WHERE t.recorded_at >= datetime('now', ?1)
             GROUP BY s.working_directory, t.provider
             ORDER BY SUM(t.estimated_cost_usd) DESC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![offset], |row| {
                Ok(ProjectCostEntry {
                    working_directory: row.get(0)?,
                    provider: row.get(1)?,
                    total_input_tokens: row.get(2)?,
                    total_output_tokens: row.get(3)?,
                    total_cost_usd: row.get(4)?,
                    session_count: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|e| e.to_string())?);
        }
        Ok(entries)
    }

    // ─── Session Worktree Operations ─────────────────────────────

    pub fn insert_session_worktree(
        &self,
        id: &str,
        session_id: &str,
        realm_id: &str,
        worktree_path: &str,
        branch_name: Option<&str>,
        is_main_worktree: bool,
    ) -> Result<(), String> {
        self.conn.execute(
            "INSERT INTO session_worktrees (id, session_id, realm_id, worktree_path, branch_name, is_main_worktree)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, session_id, realm_id, worktree_path, branch_name, is_main_worktree as i32],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_session_worktrees(
        &self,
        session_id: &str,
    ) -> Result<Vec<SessionWorktreeRow>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, realm_id, worktree_path, branch_name, is_main_worktree, created_at
             FROM session_worktrees WHERE session_id = ?1 ORDER BY created_at"
        ).map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![session_id], |row| {
                let is_main: i32 = row.get(5)?;
                Ok(SessionWorktreeRow {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    realm_id: row.get(2)?,
                    worktree_path: row.get(3)?,
                    branch_name: row.get(4)?,
                    is_main_worktree: is_main != 0,
                    created_at: row.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|e| e.to_string())?);
        }
        Ok(entries)
    }

    pub fn get_worktree_by_session_and_realm(
        &self,
        session_id: &str,
        realm_id: &str,
    ) -> Result<Option<SessionWorktreeRow>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, realm_id, worktree_path, branch_name, is_main_worktree, created_at
             FROM session_worktrees WHERE session_id = ?1 AND realm_id = ?2"
        ).map_err(|e| e.to_string())?;

        let result = stmt
            .query_row(params![session_id, realm_id], |row| {
                let is_main: i32 = row.get(5)?;
                Ok(SessionWorktreeRow {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    realm_id: row.get(2)?,
                    worktree_path: row.get(3)?,
                    branch_name: row.get(4)?,
                    is_main_worktree: is_main != 0,
                    created_at: row.get(6)?,
                })
            })
            .ok();
        Ok(result)
    }

    pub fn get_worktrees_for_realm(
        &self,
        realm_id: &str,
    ) -> Result<Vec<SessionWorktreeRow>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, realm_id, worktree_path, branch_name, is_main_worktree, created_at
             FROM session_worktrees WHERE realm_id = ?1 ORDER BY created_at"
        ).map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![realm_id], |row| {
                let is_main: i32 = row.get(5)?;
                Ok(SessionWorktreeRow {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    realm_id: row.get(2)?,
                    worktree_path: row.get(3)?,
                    branch_name: row.get(4)?,
                    is_main_worktree: is_main != 0,
                    created_at: row.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|e| e.to_string())?);
        }
        Ok(entries)
    }

    pub fn update_worktree_branch(&self, id: &str, branch_name: &str) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE session_worktrees SET branch_name = ?1 WHERE id = ?2",
                params![branch_name, id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_all_session_worktrees(&self) -> Result<Vec<SessionWorktreeRow>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, realm_id, worktree_path, branch_name, is_main_worktree, created_at
             FROM session_worktrees ORDER BY created_at"
        ).map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                let is_main: i32 = row.get(5)?;
                Ok(SessionWorktreeRow {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    realm_id: row.get(2)?,
                    worktree_path: row.get(3)?,
                    branch_name: row.get(4)?,
                    is_main_worktree: is_main != 0,
                    created_at: row.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|e| e.to_string())?);
        }
        Ok(entries)
    }

    /// Check whether a session exists in the sessions table.
    pub fn session_exists(&self, session_id: &str) -> Result<bool, String> {
        let count: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM sessions WHERE id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(count > 0)
    }

    pub fn delete_session_worktree(&self, id: &str) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM session_worktrees WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_worktrees_for_session(&self, session_id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "DELETE FROM session_worktrees WHERE session_id = ?1",
                params![session_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

// ─── Tauri Command Wrappers ─────────────────────────────────────────

#[tauri::command]
pub fn get_recent_sessions(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<SessionHistoryEntry>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_recent_sessions(limit.unwrap_or(20))
}

#[tauri::command]
pub fn get_session_snapshot(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_session_snapshot(&session_id)
}

#[tauri::command]
pub fn get_token_usage_today(state: State<'_, AppState>) -> Result<Vec<TokenUsageEntry>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_token_usage_today()
}

#[tauri::command]
pub fn get_cost_history(
    state: State<'_, AppState>,
    days: Option<i64>,
) -> Result<Vec<CostDailyEntry>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_cost_daily(days.unwrap_or(7))
}

// Tauri command handler — params map to DB columns
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn save_memory(
    state: State<'_, AppState>,
    scope: String,
    scope_id: String,
    key: String,
    value: String,
    source: Option<String>,
    category: Option<String>,
    confidence: Option<f64>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.save_memory_entry(
        &scope,
        &scope_id,
        &key,
        &value,
        &source.unwrap_or_else(|| "user".to_string()),
        &category.unwrap_or_else(|| "general".to_string()),
        confidence.unwrap_or(1.0),
    )
}

#[tauri::command]
pub fn delete_memory(
    state: State<'_, AppState>,
    scope: String,
    scope_id: String,
    key: String,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.delete_memory_entry(&scope, &scope_id, &key)
}

#[tauri::command]
pub fn get_all_memory(
    state: State<'_, AppState>,
    scope: String,
    scope_id: String,
) -> Result<Vec<MemoryEntry>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_all_memory_entries(&scope, &scope_id)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<HashMap<String, String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_all_settings()
}

/// Allowlist of valid setting keys that the frontend may write.
const VALID_SETTING_KEYS: &[&str] = &[
    // Window geometry
    "window_width",
    "window_height",
    "window_x",
    "window_y",
    // Appearance
    "theme",
    "ui_scale",
    "font_size",
    "font_family",
    // Terminal
    "default_shell",
    "default_cwd",
    "scrollback",
    "restore_sessions",
    // Workspace
    "saved_workspace",
    // Behaviour
    "skip_close_confirm",
    "execution_mode",
    "telemetry_enabled",
    // Onboarding / What's New
    "onboarding_completed",
    "last_seen_version",
    "suppress_whats_new",
    // Prompt composer
    "prompt_templates",
    "pinned_templates",
    "custom_roles",
    "custom_styles",
    // Git
    "git_poll_interval",
    "git_author_name",
    "git_author_email",
    "git_auto_stage",
    "git_show_untracked",
    // Autonomous mode
    "auto_command_min_frequency",
    "auto_cancel_delay_ms",
    // Keyboard shortcuts
    "command_palette_shortcut",
    // Plugin updates
    "plugin_update_check",
    "plugin_auto_update",
    "plugin_ignored_updates",
    "plugin_last_update_check",
    // File browser
    "preferred_editor",
    "preferred_ssh_editor",
    // SSH
    "ssh_connection_history",
];

#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    if !VALID_SETTING_KEYS.contains(&key.as_str()) {
        return Err(format!("Unknown setting key: {}", key));
    }
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.set_setting(&key, &value)
}

#[tauri::command]
pub fn log_execution(
    state: State<'_, AppState>,
    session_id: String,
    event_type: String,
    content: String,
    exit_code: Option<i32>,
    working_directory: Option<String>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.log_execution_entry(
        &session_id,
        &event_type,
        &content,
        exit_code,
        working_directory.as_deref(),
    )
}

#[tauri::command]
pub fn get_execution_log(
    state: State<'_, AppState>,
    session_id: String,
    limit: Option<i64>,
) -> Result<Vec<ExecutionEntry>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_execution_log_entries(&session_id, limit)
}

// ─── Execution Node Commands ─────────────────────────────────────────

#[tauri::command]
pub fn get_execution_nodes(
    state: State<'_, AppState>,
    session_id: String,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<ExecutionNode>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_execution_nodes(&session_id, limit.unwrap_or(50), offset.unwrap_or(0))
}

#[tauri::command]
pub fn get_execution_node(
    state: State<'_, AppState>,
    id: i64,
) -> Result<Option<ExecutionNode>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_execution_node(id)
}

// ─── Context Pin Commands ────────────────────────────────────────────

// Tauri command handler — params map to DB columns
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn add_context_pin(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: Option<String>,
    project_id: Option<String>,
    kind: String,
    target: String,
    label: Option<String>,
    priority: Option<i64>,
) -> Result<i64, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let id = db.add_context_pin(
        session_id.as_deref(),
        project_id.as_deref(),
        &kind,
        &target,
        label.as_deref(),
        priority,
    )?;
    if let Some(ref sid) = session_id {
        let _ = app.emit(&format!("context-pins-changed-{}", sid), ());
    }
    Ok(id)
}

#[tauri::command]
pub fn remove_context_pin(
    state: State<'_, AppState>,
    app: AppHandle,
    id: i64,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let session_id = db.get_pin_session_id(id)?;
    db.remove_context_pin(id)?;
    if let Some(ref sid) = session_id {
        let _ = app.emit(&format!("context-pins-changed-{}", sid), ());
    }
    Ok(())
}

#[tauri::command]
pub fn get_context_pins(
    state: State<'_, AppState>,
    session_id: Option<String>,
    project_id: Option<String>,
) -> Result<Vec<ContextPin>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_context_pins(session_id.as_deref(), project_id.as_deref())
}

// ─── Context Snapshot Commands ────────────────────────────────────────

#[tauri::command]
pub fn save_context_snapshot(
    state: State<'_, AppState>,
    session_id: String,
    version: i64,
    context_json: String,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.save_context_snapshot(&session_id, version, &context_json)
}

#[tauri::command]
pub fn get_context_snapshots(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<ContextSnapshotEntry>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_context_snapshots(&session_id)
}

#[tauri::command]
pub fn get_context_snapshot(
    state: State<'_, AppState>,
    session_id: String,
    version: i64,
) -> Result<Option<ContextSnapshotEntry>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_context_snapshot(&session_id, version)
}

// ─── Execution Nodes Count Command ───────────────────────────────────

#[tauri::command]
pub fn get_execution_nodes_count(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<i64, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_execution_nodes_count(&session_id)
}

// ─── Cost by Project Command ─────────────────────────────────────────

#[tauri::command]
pub fn get_cost_by_project(
    state: State<'_, AppState>,
    days: Option<i64>,
) -> Result<Vec<ProjectCostEntry>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_cost_by_project(days.unwrap_or(7))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    /// Helper: create a fresh in-memory-style database backed by a temp file
    /// so that all tables are set up via `run_migrations`.
    fn test_db() -> Database {
        let tmp = NamedTempFile::new().unwrap();
        Database::new(tmp.path()).expect("Failed to create test database")
    }

    // ── insert + get_session_worktrees ─────────────────────────────────

    #[test]
    fn test_insert_and_get_session_worktrees() {
        let db = test_db();

        db.insert_session_worktree("wt1", "sess1", "realm1", "/path/to/wt", Some("main"), false)
            .unwrap();

        let rows = db.get_session_worktrees("sess1").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "wt1");
        assert_eq!(rows[0].session_id, "sess1");
        assert_eq!(rows[0].realm_id, "realm1");
        assert_eq!(rows[0].worktree_path, "/path/to/wt");
        assert_eq!(rows[0].branch_name, Some("main".to_string()));
        assert!(!rows[0].is_main_worktree);
    }

    #[test]
    fn test_get_session_worktrees_empty() {
        let db = test_db();
        let rows = db.get_session_worktrees("nonexistent").unwrap();
        assert!(rows.is_empty());
    }

    #[test]
    fn test_insert_multiple_worktrees_for_session() {
        let db = test_db();

        db.insert_session_worktree(
            "wt1",
            "sess1",
            "realm1",
            "/path/wt1",
            Some("branch-a"),
            false,
        )
        .unwrap();
        db.insert_session_worktree(
            "wt2",
            "sess1",
            "realm2",
            "/path/wt2",
            Some("branch-b"),
            false,
        )
        .unwrap();

        let rows = db.get_session_worktrees("sess1").unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn test_insert_main_worktree_flag() {
        let db = test_db();

        db.insert_session_worktree("wt-main", "sess1", "realm1", "/repo", None, true)
            .unwrap();

        let rows = db.get_session_worktrees("sess1").unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].is_main_worktree);
        assert!(rows[0].branch_name.is_none());
    }

    // ── get_worktree_by_session_and_realm ──────────────────────────────

    #[test]
    fn test_get_worktree_by_session_and_realm_found() {
        let db = test_db();

        db.insert_session_worktree("wt1", "sess1", "realm1", "/path/wt1", Some("main"), false)
            .unwrap();

        let result = db
            .get_worktree_by_session_and_realm("sess1", "realm1")
            .unwrap();
        assert!(result.is_some());
        assert_eq!(result.unwrap().id, "wt1");
    }

    #[test]
    fn test_get_worktree_by_session_and_realm_not_found() {
        let db = test_db();

        let result = db
            .get_worktree_by_session_and_realm("sess1", "realm1")
            .unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_get_worktree_by_session_and_realm_wrong_session() {
        let db = test_db();

        db.insert_session_worktree("wt1", "sess1", "realm1", "/path/wt1", Some("main"), false)
            .unwrap();

        let result = db
            .get_worktree_by_session_and_realm("sess2", "realm1")
            .unwrap();
        assert!(result.is_none());
    }

    // ── get_worktrees_for_realm ────────────────────────────────────────

    #[test]
    fn test_get_worktrees_for_realm() {
        let db = test_db();

        db.insert_session_worktree(
            "wt1",
            "sess1",
            "realm1",
            "/path/wt1",
            Some("branch-a"),
            false,
        )
        .unwrap();
        db.insert_session_worktree(
            "wt2",
            "sess2",
            "realm1",
            "/path/wt2",
            Some("branch-b"),
            false,
        )
        .unwrap();
        db.insert_session_worktree(
            "wt3",
            "sess3",
            "realm2",
            "/path/wt3",
            Some("branch-c"),
            false,
        )
        .unwrap();

        let rows = db.get_worktrees_for_realm("realm1").unwrap();
        assert_eq!(rows.len(), 2);

        let rows2 = db.get_worktrees_for_realm("realm2").unwrap();
        assert_eq!(rows2.len(), 1);
        assert_eq!(rows2[0].id, "wt3");
    }

    #[test]
    fn test_get_worktrees_for_realm_empty() {
        let db = test_db();
        let rows = db.get_worktrees_for_realm("nonexistent").unwrap();
        assert!(rows.is_empty());
    }

    // ── update_worktree_branch ─────────────────────────────────────────

    #[test]
    fn test_update_worktree_branch() {
        let db = test_db();

        db.insert_session_worktree(
            "wt1",
            "sess1",
            "realm1",
            "/path/wt1",
            Some("old-branch"),
            false,
        )
        .unwrap();

        db.update_worktree_branch("wt1", "new-branch").unwrap();

        let row = db
            .get_worktree_by_session_and_realm("sess1", "realm1")
            .unwrap()
            .unwrap();
        assert_eq!(row.branch_name, Some("new-branch".to_string()));
    }

    #[test]
    fn test_update_worktree_branch_nonexistent_is_noop() {
        let db = test_db();
        // Should not error even if the row doesn't exist
        let result = db.update_worktree_branch("no-such-id", "branch");
        assert!(result.is_ok());
    }

    // ── delete_session_worktree ────────────────────────────────────────

    #[test]
    fn test_delete_session_worktree() {
        let db = test_db();

        db.insert_session_worktree("wt1", "sess1", "realm1", "/path/wt1", Some("main"), false)
            .unwrap();

        db.delete_session_worktree("wt1").unwrap();

        let rows = db.get_session_worktrees("sess1").unwrap();
        assert!(rows.is_empty());
    }

    #[test]
    fn test_delete_session_worktree_nonexistent() {
        let db = test_db();
        // Should succeed even if row doesn't exist
        let result = db.delete_session_worktree("no-such-id");
        assert!(result.is_ok());
    }

    #[test]
    fn test_delete_session_worktree_only_deletes_target() {
        let db = test_db();

        db.insert_session_worktree("wt1", "sess1", "realm1", "/path/wt1", Some("a"), false)
            .unwrap();
        db.insert_session_worktree("wt2", "sess1", "realm2", "/path/wt2", Some("b"), false)
            .unwrap();

        db.delete_session_worktree("wt1").unwrap();

        let rows = db.get_session_worktrees("sess1").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "wt2");
    }

    // ── delete_worktrees_for_session ───────────────────────────────────

    #[test]
    fn test_delete_worktrees_for_session() {
        let db = test_db();

        db.insert_session_worktree("wt1", "sess1", "realm1", "/path/wt1", Some("a"), false)
            .unwrap();
        db.insert_session_worktree("wt2", "sess1", "realm2", "/path/wt2", Some("b"), false)
            .unwrap();
        db.insert_session_worktree("wt3", "sess2", "realm1", "/path/wt3", Some("c"), false)
            .unwrap();

        db.delete_worktrees_for_session("sess1").unwrap();

        // sess1 should be empty
        let rows = db.get_session_worktrees("sess1").unwrap();
        assert!(rows.is_empty());

        // sess2 should be untouched
        let rows2 = db.get_session_worktrees("sess2").unwrap();
        assert_eq!(rows2.len(), 1);
        assert_eq!(rows2[0].id, "wt3");
    }

    #[test]
    fn test_delete_worktrees_for_session_nonexistent() {
        let db = test_db();
        let result = db.delete_worktrees_for_session("no-such-session");
        assert!(result.is_ok());
    }

    // ── Unique constraints ─────────────────────────────────────────────

    #[test]
    fn test_unique_session_realm_constraint() {
        let db = test_db();

        db.insert_session_worktree("wt1", "sess1", "realm1", "/path/wt1", Some("a"), false)
            .unwrap();

        // Inserting with same session_id + realm_id should fail (UNIQUE constraint)
        let result =
            db.insert_session_worktree("wt2", "sess1", "realm1", "/path/wt2", Some("b"), false);
        assert!(result.is_err());
    }

    #[test]
    fn test_unique_worktree_path_constraint() {
        let db = test_db();

        db.insert_session_worktree("wt1", "sess1", "realm1", "/same/path", Some("a"), false)
            .unwrap();

        // Inserting with same worktree_path should fail (UNIQUE constraint)
        let result =
            db.insert_session_worktree("wt2", "sess2", "realm2", "/same/path", Some("b"), false);
        assert!(result.is_err());
    }

    #[test]
    fn test_unique_id_constraint() {
        let db = test_db();

        db.insert_session_worktree("wt1", "sess1", "realm1", "/path1", Some("a"), false)
            .unwrap();

        // Inserting with same id should fail (PRIMARY KEY constraint)
        let result =
            db.insert_session_worktree("wt1", "sess2", "realm2", "/path2", Some("b"), false);
        assert!(result.is_err());
    }
}

// ─── Settings Export / Import Commands ───────────────────────────────

/// Maximum allowed file size for settings import (1 MB).
const MAX_SETTINGS_FILE_SIZE: u64 = 1_048_576;

/// Validate a settings file path for export or import.
/// - Must have a `.json` extension
/// - For writes (`for_write=true`): parent directory must exist
/// - For reads (`for_write=false`): file must exist and be under 1 MB
fn validate_settings_path(path: &str, for_write: bool) -> Result<std::path::PathBuf, String> {
    let p = std::path::PathBuf::from(path);

    // Must have .json extension
    match p.extension().and_then(|e| e.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("json") => {}
        _ => return Err("Settings file must have a .json extension".to_string()),
    }

    if for_write {
        // Parent directory must exist
        let parent = p
            .parent()
            .ok_or_else(|| "Invalid path: no parent directory".to_string())?;
        if !parent.exists() {
            return Err(format!("Directory does not exist: {}", parent.display()));
        }
    } else {
        // File must exist
        if !p.exists() {
            return Err(format!("File does not exist: {}", p.display()));
        }
        // File size check
        let metadata =
            std::fs::metadata(&p).map_err(|e| format!("Failed to read file metadata: {}", e))?;
        if metadata.len() > MAX_SETTINGS_FILE_SIZE {
            return Err(format!(
                "Settings file is too large ({} bytes, max {} bytes)",
                metadata.len(),
                MAX_SETTINGS_FILE_SIZE
            ));
        }
    }

    Ok(p)
}

#[tauri::command]
pub fn export_settings(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let validated = validate_settings_path(&path, true)?;
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let settings = db.get_all_settings()?;
    let json = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    std::fs::write(&validated, json).map_err(|e| format!("Failed to write file: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn import_settings(
    state: State<'_, AppState>,
    path: String,
) -> Result<HashMap<String, String>, String> {
    let validated = validate_settings_path(&path, false)?;
    let content =
        std::fs::read_to_string(&validated).map_err(|e| format!("Failed to read file: {}", e))?;
    let imported: HashMap<String, String> =
        serde_json::from_str(&content).map_err(|e| format!("Invalid settings JSON: {}", e))?;
    let db = state.db.lock().map_err(|e| e.to_string())?;
    for (key, value) in &imported {
        if !VALID_SETTING_KEYS.contains(&key.as_str()) {
            continue; // Skip unknown keys silently during import
        }
        db.set_setting(key, value)?;
    }
    db.get_all_settings()
}

#[tauri::command]
pub fn get_plugin_setting(
    key: String,
    plugin_id: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.conn
        .query_row(
            "SELECT value FROM plugin_storage WHERE plugin_id = ?1 AND key = ?2",
            params![plugin_id, key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_plugin_setting(
    key: String,
    value: String,
    plugin_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.conn
        .execute(
            "INSERT INTO plugin_storage (plugin_id, key, value, updated_at) VALUES (?1, ?2, ?3, datetime('now'))
             ON CONFLICT(plugin_id, key) DO UPDATE SET value = ?3, updated_at = datetime('now')",
            params![plugin_id, key, value],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_plugin_setting(
    key: String,
    plugin_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.conn
        .execute(
            "DELETE FROM plugin_storage WHERE plugin_id = ?1 AND key = ?2",
            params![plugin_id, key],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_plugin_enabled(
    plugin_id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let enabled_int: i32 = if enabled { 1 } else { 0 };
    // Upsert into plugins table — insert if not exists, update enabled if exists
    db.conn
        .execute(
            "INSERT INTO plugins (id, version, name, enabled) VALUES (?1, '', '', ?2)
             ON CONFLICT(id) DO UPDATE SET enabled = ?2, updated_at = datetime('now')",
            params![plugin_id, enabled_int],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Remove all database records for a plugin (plugins table + plugin_storage).
/// Called during uninstall to prevent orphaned data.
#[tauri::command]
pub fn cleanup_plugin_data(plugin_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.conn
        .execute(
            "DELETE FROM plugin_storage WHERE plugin_id = ?1",
            params![plugin_id],
        )
        .map_err(|e| e.to_string())?;
    db.conn
        .execute("DELETE FROM plugins WHERE id = ?1", params![plugin_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_plugin_settings_batch(
    plugin_id: String,
    state: State<'_, AppState>,
) -> Result<std::collections::HashMap<String, String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .conn
        .prepare(
            "SELECT key, value FROM plugin_storage WHERE plugin_id = ?1 AND key LIKE '__setting:%'",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![plugin_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut map = std::collections::HashMap::new();
    for (k, v) in rows.flatten() {
        map.insert(k.trim_start_matches("__setting:").to_string(), v);
    }
    Ok(map)
}

#[tauri::command]
pub fn get_disabled_plugin_ids(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = db
        .conn
        .prepare("SELECT id FROM plugins WHERE enabled = 0")
        .map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(ids)
}
