use rusqlite::{params, Connection};
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

// ─── Error Patterns ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorPattern {
    pub id: i64,
    pub project_id: Option<String>,
    pub fingerprint: String,
    pub raw_sample: Option<String>,
    pub occurrence_count: i64,
    pub last_seen: Option<i64>,
    pub resolution: Option<String>,
    pub resolution_verified: bool,
    pub created_at: i64,
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

// ─── Error Correlations ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorCorrelation {
    pub session_id: String,
    pub session_label: String,
    pub last_seen: i64,
    pub occurrence_count: i64,
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

impl Database {
    pub fn new(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| format!("Failed to open database: {}", e))?;
        conn.execute_batch("PRAGMA journal_mode=WAL;").map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA foreign_keys=ON;").map_err(|e| e.to_string())?;

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
                kind TEXT NOT NULL CHECK(kind IN ('file','memory','text')),
                target TEXT NOT NULL,
                label TEXT,
                priority INTEGER DEFAULT 128,
                created_at INTEGER DEFAULT (strftime('%s','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_pins_session ON context_pins(session_id);

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

        Ok(())
    }

    // ─── Session Operations ─────────────────────────────────────

    pub fn create_session_v2(&self, s: &SessionUpdate) -> Result<(), String> {
        self.conn.execute(
            "INSERT OR REPLACE INTO sessions (id, label, color, group_name, phase, working_directory, shell, workspace_paths, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![s.id, s.label, s.color, s.group, s.phase, s.working_directory, s.shell,
                    serde_json::to_string(&s.workspace_paths).unwrap_or_default(), s.created_at],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_session_status(&self, session_id: &str, status: &str) -> Result<(), String> {
        self.conn.execute(
            "UPDATE sessions SET phase = ?1, closed_at = datetime('now') WHERE id = ?2",
            params![status, session_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn save_session_snapshot(&self, session_id: &str, snapshot: &str) -> Result<(), String> {
        let trimmed = if snapshot.len() > 50000 {
            // Find a char boundary near the 50K mark from the end
            let target = snapshot.len() - 50000;
            let mut start = target;
            while start < snapshot.len() && !snapshot.is_char_boundary(start) {
                start += 1;
            }
            &snapshot[start..]
        } else {
            snapshot
        };
        self.conn.execute(
            "UPDATE sessions SET scrollback_snapshot = ?1 WHERE id = ?2",
            params![trimmed, session_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_recent_sessions(&self, limit: i64) -> Result<Vec<SessionHistoryEntry>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT id, label, color, working_directory, shell, created_at, closed_at, substr(scrollback_snapshot, -200)
             FROM sessions WHERE phase = 'destroyed' AND closed_at IS NOT NULL
             ORDER BY closed_at DESC LIMIT ?1"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map(params![limit], |row| {
            Ok(SessionHistoryEntry {
                id: row.get(0)?, label: row.get(1)?, color: row.get(2)?,
                working_directory: row.get(3)?, shell: row.get(4)?,
                created_at: row.get(5)?, closed_at: row.get(6)?,
                scrollback_preview: row.get(7)?,
            })
        }).map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows { entries.push(row.map_err(|e| e.to_string())?); }
        Ok(entries)
    }

    pub fn get_session_snapshot(&self, session_id: &str) -> Result<Option<String>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT scrollback_snapshot FROM sessions WHERE id = ?1"
        ).map_err(|e| e.to_string())?;
        let result = stmt.query_row(params![session_id], |row| row.get(0)).ok();
        Ok(result)
    }

    // ─── Token Operations ───────────────────────────────────────

    pub fn record_token_usage(
        &self, session_id: &str, provider: &str, model: &str,
        input_tokens: i64, output_tokens: i64, cost: f64,
    ) -> Result<(), String> {
        self.conn.execute(
            "INSERT INTO token_usage (session_id, provider, model, input_tokens, output_tokens, estimated_cost_usd)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![session_id, provider, model, input_tokens, output_tokens, cost],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn record_token_snapshot(
        &self, session_id: &str, provider: &str, model: &str,
        input_tokens: i64, output_tokens: i64, cost: f64,
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

        let rows = stmt.query_map([], |row| {
            Ok(TokenUsageEntry {
                provider: row.get(0)?, model: row.get(1)?,
                input_tokens: row.get(2)?, output_tokens: row.get(3)?,
                estimated_cost_usd: row.get(4)?, recorded_at: row.get(5)?,
            })
        }).map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows { entries.push(row.map_err(|e| e.to_string())?); }
        Ok(entries)
    }

    pub fn get_cost_daily(&self, days: i64) -> Result<Vec<CostDailyEntry>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT date, provider, model, total_input_tokens, total_output_tokens, total_cost_usd, session_count
             FROM cost_daily WHERE date >= date('now', ?1) ORDER BY date DESC"
        ).map_err(|e| e.to_string())?;

        let offset = format!("-{} days", days);
        let rows = stmt.query_map(params![offset], |row| {
            Ok(CostDailyEntry {
                date: row.get(0)?, provider: row.get(1)?, model: row.get(2)?,
                total_input_tokens: row.get(3)?, total_output_tokens: row.get(4)?,
                total_cost_usd: row.get(5)?, session_count: row.get(6)?,
            })
        }).map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows { entries.push(row.map_err(|e| e.to_string())?); }
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

    pub fn save_memory_entry(
        &self, scope: &str, scope_id: &str, key: &str, value: &str,
        source: &str, category: &str, confidence: f64,
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

    pub fn delete_memory_entry(&self, scope: &str, scope_id: &str, key: &str) -> Result<(), String> {
        self.conn.execute(
            "DELETE FROM memory WHERE scope = ?1 AND scope_id = ?2 AND key = ?3",
            params![scope, scope_id, key],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_all_memory_entries(&self, scope: &str, scope_id: &str) -> Result<Vec<MemoryEntry>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT id, scope, scope_id, category, key, value, source, confidence, access_count, created_at, updated_at
             FROM memory WHERE scope = ?1 AND scope_id = ?2
             AND (expires_at IS NULL OR expires_at > datetime('now'))
             ORDER BY access_count DESC, updated_at DESC"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map(params![scope, scope_id], |row| {
            Ok(MemoryEntry {
                id: row.get(0)?, scope: row.get(1)?, scope_id: row.get(2)?,
                category: row.get(3)?, key: row.get(4)?, value: row.get(5)?,
                source: row.get(6)?, confidence: row.get(7)?, access_count: row.get(8)?,
                created_at: row.get(9)?, updated_at: row.get(10)?,
            })
        }).map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows { entries.push(row.map_err(|e| e.to_string())?); }
        Ok(entries)
    }

    // ─── Settings ────────────────────────────────────────────────

    pub fn get_setting(&self, key: &str) -> Result<Option<String>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT value FROM settings WHERE key = ?1"
        ).map_err(|e| e.to_string())?;
        let result = stmt.query_row(params![key], |row| row.get(0)).ok();
        Ok(result)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), String> {
        self.conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
            params![key, value],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_all_settings(&self) -> Result<HashMap<String, String>, String> {
        let mut stmt = self.conn.prepare("SELECT key, value FROM settings").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }).map_err(|e| e.to_string())?;
        let mut map = HashMap::new();
        for row in rows {
            let (k, v) = row.map_err(|e| e.to_string())?;
            map.insert(k, v);
        }
        Ok(map)
    }

    // ─── Execution Log ──────────────────────────────────────────

    pub fn log_execution_entry(
        &self, session_id: &str, event_type: &str, content: &str,
        exit_code: Option<i32>, working_directory: Option<&str>,
    ) -> Result<(), String> {
        self.conn.execute(
            "INSERT INTO execution_log (session_id, event_type, content, exit_code, working_directory)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![session_id, event_type, content, exit_code, working_directory],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_execution_log_entries(&self, session_id: &str, limit: Option<i64>) -> Result<Vec<ExecutionEntry>, String> {
        let limit = limit.unwrap_or(100);
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, event_type, content, exit_code, working_directory, timestamp
             FROM execution_log WHERE session_id = ?1 ORDER BY timestamp DESC LIMIT ?2"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map(params![session_id, limit], |row| {
            Ok(ExecutionEntry {
                id: row.get(0)?, session_id: row.get(1)?, event_type: row.get(2)?,
                content: row.get(3)?, exit_code: row.get(4)?, working_directory: row.get(5)?,
                timestamp: row.get(6)?,
            })
        }).map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows { entries.push(row.map_err(|e| e.to_string())?); }
        Ok(entries)
    }

    // ─── Project Operations ─────────────────────────────────────

    pub fn upsert_project(
        &self, id: &str, path: &str, name: &str, languages: &str, frameworks: &str,
    ) -> Result<(), String> {
        self.conn.execute(
            "INSERT INTO projects (id, path, name, detected_languages, detected_frameworks)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(path) DO UPDATE SET
                name = excluded.name, detected_languages = excluded.detected_languages,
                detected_frameworks = excluded.detected_frameworks, updated_at = datetime('now')",
            params![id, path, name, languages, frameworks],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_all_projects(&self) -> Result<Vec<crate::workspace::ProjectInfo>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, name, detected_languages, detected_frameworks, created_at FROM projects ORDER BY updated_at DESC"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map([], |row| {
            let languages_str: String = row.get(3)?;
            let frameworks_str: String = row.get(4)?;
            Ok(crate::workspace::ProjectInfo {
                id: row.get(0)?, path: row.get(1)?, name: row.get(2)?,
                languages: serde_json::from_str(&languages_str).unwrap_or_default(),
                frameworks: serde_json::from_str(&frameworks_str).unwrap_or_default(),
                created_at: row.get(5)?,
            })
        }).map_err(|e| e.to_string())?;

        let mut projects = Vec::new();
        for row in rows { projects.push(row.map_err(|e| e.to_string())?); }
        Ok(projects)
    }

    // ─── Execution Nodes ─────────────────────────────────────────

    pub fn insert_execution_node(
        &self, session_id: &str, timestamp: i64, kind: &str, input: Option<&str>,
        output_summary: Option<&str>, exit_code: Option<i32>, working_dir: &str,
        duration_ms: i64, metadata: Option<&str>,
    ) -> Result<i64, String> {
        self.conn.execute(
            "INSERT INTO execution_nodes (session_id, timestamp, kind, input, output_summary, exit_code, working_dir, duration_ms, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![session_id, timestamp, kind, input, output_summary, exit_code, working_dir, duration_ms, metadata],
        ).map_err(|e| e.to_string())?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn get_execution_nodes(&self, session_id: &str, limit: i64, offset: i64) -> Result<Vec<ExecutionNode>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, timestamp, kind, input, output_summary, exit_code, working_dir, duration_ms, metadata
             FROM execution_nodes WHERE session_id = ?1 ORDER BY timestamp DESC LIMIT ?2 OFFSET ?3"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map(params![session_id, limit, offset], |row| {
            Ok(ExecutionNode {
                id: row.get(0)?, session_id: row.get(1)?, timestamp: row.get(2)?,
                kind: row.get(3)?, input: row.get(4)?, output_summary: row.get(5)?,
                exit_code: row.get(6)?, working_dir: row.get(7)?, duration_ms: row.get(8)?,
                metadata: row.get(9)?,
            })
        }).map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows { entries.push(row.map_err(|e| e.to_string())?); }
        Ok(entries)
    }

    pub fn get_execution_node(&self, id: i64) -> Result<Option<ExecutionNode>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, timestamp, kind, input, output_summary, exit_code, working_dir, duration_ms, metadata
             FROM execution_nodes WHERE id = ?1"
        ).map_err(|e| e.to_string())?;

        let result = stmt.query_row(params![id], |row| {
            Ok(ExecutionNode {
                id: row.get(0)?, session_id: row.get(1)?, timestamp: row.get(2)?,
                kind: row.get(3)?, input: row.get(4)?, output_summary: row.get(5)?,
                exit_code: row.get(6)?, working_dir: row.get(7)?, duration_ms: row.get(8)?,
                metadata: row.get(9)?,
            })
        }).ok();
        Ok(result)
    }

    // ─── Error Patterns ──────────────────────────────────────────

    pub fn upsert_error_pattern(&self, project_id: Option<&str>, fingerprint: &str, raw_sample: &str) -> Result<ErrorPattern, String> {
        let now_ts = chrono::Utc::now().timestamp();
        self.conn.execute(
            "INSERT INTO error_patterns (project_id, fingerprint, raw_sample, occurrence_count, last_seen)
             VALUES (?1, ?2, ?3, 1, ?4)
             ON CONFLICT(project_id, fingerprint) DO UPDATE SET
                occurrence_count = occurrence_count + 1,
                last_seen = ?4,
                raw_sample = ?3",
            params![project_id, fingerprint, raw_sample, now_ts],
        ).map_err(|e| e.to_string())?;

        self.find_error_pattern(project_id, fingerprint)
            .and_then(|opt| opt.ok_or_else(|| "Failed to fetch upserted pattern".into()))
    }

    pub fn find_error_pattern(&self, project_id: Option<&str>, fingerprint: &str) -> Result<Option<ErrorPattern>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT id, project_id, fingerprint, raw_sample, occurrence_count, last_seen, resolution, resolution_verified, created_at
             FROM error_patterns WHERE (project_id = ?1 OR (project_id IS NULL AND ?1 IS NULL)) AND fingerprint = ?2"
        ).map_err(|e| e.to_string())?;

        let result = stmt.query_row(params![project_id, fingerprint], |row| {
            Ok(ErrorPattern {
                id: row.get(0)?, project_id: row.get(1)?, fingerprint: row.get(2)?,
                raw_sample: row.get(3)?, occurrence_count: row.get(4)?, last_seen: row.get(5)?,
                resolution: row.get(6)?, resolution_verified: row.get::<_, i32>(7)? != 0,
                created_at: row.get(8)?,
            })
        }).ok();
        Ok(result)
    }

    pub fn set_error_resolution(&self, id: i64, resolution: &str) -> Result<(), String> {
        self.conn.execute(
            "UPDATE error_patterns SET resolution = ?1, resolution_verified = 0 WHERE id = ?2",
            params![resolution, id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn verify_error_resolution(&self, id: i64) -> Result<(), String> {
        self.conn.execute(
            "UPDATE error_patterns SET resolution_verified = 1 WHERE id = ?1",
            params![id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    // ─── Command Patterns ────────────────────────────────────────

    pub fn record_command_sequence(&self, project_id: Option<&str>, sequence_json: &str, next_command: &str) -> Result<(), String> {
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

    pub fn predict_next_command(&self, project_id: Option<&str>, sequence_json: &str, limit: i64) -> Result<Vec<CommandPrediction>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT next_command, frequency FROM command_patterns
             WHERE (project_id = ?1 OR (project_id IS NULL AND ?1 IS NULL)) AND sequence = ?2
             ORDER BY frequency DESC LIMIT ?3"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map(params![project_id, sequence_json, limit], |row| {
            Ok(CommandPrediction {
                next_command: row.get(0)?,
                frequency: row.get(1)?,
            })
        }).map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows { entries.push(row.map_err(|e| e.to_string())?); }
        Ok(entries)
    }

    // ─── Context Pins ────────────────────────────────────────────

    pub fn add_context_pin(
        &self, session_id: Option<&str>, project_id: Option<&str>,
        kind: &str, target: &str, label: Option<&str>, priority: Option<i64>,
    ) -> Result<i64, String> {
        self.conn.execute(
            "INSERT INTO context_pins (session_id, project_id, kind, target, label, priority)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![session_id, project_id, kind, target, label, priority.unwrap_or(128)],
        ).map_err(|e| e.to_string())?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn remove_context_pin(&self, id: i64) -> Result<(), String> {
        self.conn.execute(
            "DELETE FROM context_pins WHERE id = ?1",
            params![id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_pin_session_id(&self, id: i64) -> Result<Option<String>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT session_id FROM context_pins WHERE id = ?1"
        ).map_err(|e| e.to_string())?;
        let result = stmt.query_row(params![id], |row| row.get(0))
            .ok();
        Ok(result)
    }

    pub fn get_context_pins(&self, session_id: Option<&str>, project_id: Option<&str>) -> Result<Vec<ContextPin>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, project_id, kind, target, label, priority, created_at
             FROM context_pins WHERE (session_id = ?1 OR session_id IS NULL) AND (project_id = ?2 OR project_id IS NULL)
             ORDER BY priority DESC, created_at DESC"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map(params![session_id, project_id], |row| {
            Ok(ContextPin {
                id: row.get(0)?, session_id: row.get(1)?, project_id: row.get(2)?,
                kind: row.get(3)?, target: row.get(4)?, label: row.get(5)?,
                priority: row.get(6)?, created_at: row.get(7)?,
            })
        }).map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows { entries.push(row.map_err(|e| e.to_string())?); }
        Ok(entries)
    }

    // ─── Context Snapshots ───────────────────────────────────────

    pub fn save_context_snapshot(&self, session_id: &str, version: i64, context_json: &str) -> Result<(), String> {
        self.conn.execute(
            "INSERT OR REPLACE INTO context_snapshots (session_id, version, context_json)
             VALUES (?1, ?2, ?3)",
            params![session_id, version, context_json],
        ).map_err(|e| e.to_string())?;

        // Keep only last 5 snapshots per session
        self.conn.execute(
            "DELETE FROM context_snapshots WHERE session_id = ?1 AND id NOT IN (
                SELECT id FROM context_snapshots WHERE session_id = ?1 ORDER BY version DESC LIMIT 5
            )",
            params![session_id],
        ).map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn get_context_snapshots(&self, session_id: &str) -> Result<Vec<ContextSnapshotEntry>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, version, context_json, created_at
             FROM context_snapshots WHERE session_id = ?1 ORDER BY version DESC LIMIT 5"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map(params![session_id], |row| {
            Ok(ContextSnapshotEntry {
                id: row.get(0)?,
                session_id: row.get(1)?,
                version: row.get(2)?,
                context_json: row.get(3)?,
                created_at: row.get(4)?,
            })
        }).map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows { entries.push(row.map_err(|e| e.to_string())?); }
        Ok(entries)
    }

    pub fn get_context_snapshot(&self, session_id: &str, version: i64) -> Result<Option<ContextSnapshotEntry>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, version, context_json, created_at
             FROM context_snapshots WHERE session_id = ?1 AND version = ?2"
        ).map_err(|e| e.to_string())?;

        let mut rows = stmt.query_map(params![session_id, version], |row| {
            Ok(ContextSnapshotEntry {
                id: row.get(0)?,
                session_id: row.get(1)?,
                version: row.get(2)?,
                context_json: row.get(3)?,
                created_at: row.get(4)?,
            })
        }).map_err(|e| e.to_string())?;

        match rows.next() {
            Some(row) => Ok(Some(row.map_err(|e| e.to_string())?)),
            None => Ok(None),
        }
    }

    // ─── Session Group ────────────────────────────────────────────

    pub fn update_session_group(&self, session_id: &str, group: Option<&str>) -> Result<(), String> {
        self.conn.execute(
            "UPDATE sessions SET group_name = ?1 WHERE id = ?2",
            params![group, session_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    // ─── Execution Nodes Count ───────────────────────────────────

    pub fn get_execution_nodes_count(&self, session_id: &str) -> Result<i64, String> {
        let mut stmt = self.conn.prepare(
            "SELECT COUNT(*) FROM execution_nodes WHERE session_id = ?1"
        ).map_err(|e| e.to_string())?;
        stmt.query_row(params![session_id], |row| row.get(0))
            .map_err(|e| e.to_string())
    }

    // ─── Error Session Tracking ──────────────────────────────────

    pub fn upsert_error_session(&self, error_pattern_id: i64, session_id: &str) -> Result<(), String> {
        let now_ts = chrono::Utc::now().timestamp();
        self.conn.execute(
            "INSERT INTO error_sessions (error_pattern_id, session_id, last_seen, occurrence_count)
             VALUES (?1, ?2, ?3, 1)
             ON CONFLICT(error_pattern_id, session_id) DO UPDATE SET
                occurrence_count = occurrence_count + 1,
                last_seen = ?3",
            params![error_pattern_id, session_id, now_ts],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn find_error_correlations(
        &self, fingerprint: &str, project_id: Option<&str>, exclude_session: &str, limit: i64,
    ) -> Result<Vec<ErrorCorrelation>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT es.session_id, s.label, es.last_seen, es.occurrence_count
             FROM error_sessions es
             JOIN error_patterns ep ON ep.id = es.error_pattern_id
             JOIN sessions s ON s.id = es.session_id
             WHERE ep.fingerprint = ?1
               AND (ep.project_id = ?2 OR (ep.project_id IS NULL AND ?2 IS NULL))
               AND es.session_id != ?3
             ORDER BY es.last_seen DESC
             LIMIT ?4"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map(params![fingerprint, project_id, exclude_session, limit], |row| {
            Ok(ErrorCorrelation {
                session_id: row.get(0)?,
                session_label: row.get(1)?,
                last_seen: row.get(2)?,
                occurrence_count: row.get(3)?,
            })
        }).map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows { entries.push(row.map_err(|e| e.to_string())?); }
        Ok(entries)
    }

    // ─── Error Resolutions ───────────────────────────────────────

    pub fn get_error_resolutions(&self, project_id: Option<&str>, limit: i64) -> Result<Vec<ErrorPattern>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT id, project_id, fingerprint, raw_sample, occurrence_count, last_seen, resolution, resolution_verified, created_at
             FROM error_patterns
             WHERE (project_id = ?1 OR (project_id IS NULL AND ?1 IS NULL))
               AND resolution IS NOT NULL
             ORDER BY last_seen DESC LIMIT ?2"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map(params![project_id, limit], |row| {
            Ok(ErrorPattern {
                id: row.get(0)?, project_id: row.get(1)?, fingerprint: row.get(2)?,
                raw_sample: row.get(3)?, occurrence_count: row.get(4)?, last_seen: row.get(5)?,
                resolution: row.get(6)?, resolution_verified: row.get::<_, i32>(7)? != 0,
                created_at: row.get(8)?,
            })
        }).map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows { entries.push(row.map_err(|e| e.to_string())?); }
        Ok(entries)
    }

    /// Simplified error resolutions for context assembly: (fingerprint, resolution, occurrence_count)
    pub fn get_error_resolutions_for_context(&self, _session_id: &str) -> Result<Vec<(String, String, i64)>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT fingerprint, resolution, occurrence_count
             FROM error_patterns
             WHERE resolution IS NOT NULL
             ORDER BY last_seen DESC LIMIT 10"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        }).map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows { entries.push(row.map_err(|e| e.to_string())?); }
        Ok(entries)
    }

    // ─── Realm Operations ─────────────────────────────────────────

    pub fn insert_realm(
        &self, id: &str, path: &str, name: &str, languages: &str, frameworks: &str,
    ) -> Result<(), String> {
        self.conn.execute(
            "INSERT INTO realms (id, path, name, languages, frameworks)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(path) DO UPDATE SET
                name = excluded.name, languages = excluded.languages,
                frameworks = excluded.frameworks, updated_at = datetime('now')",
            params![id, path, name, languages, frameworks],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_all_realms(&self) -> Result<Vec<crate::realm::Realm>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, name, languages, frameworks, architecture, conventions, scan_status, last_scanned_at, created_at, updated_at
             FROM realms ORDER BY updated_at DESC"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map([], |row| {
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
        }).map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows { entries.push(row.map_err(|e| e.to_string())?); }
        Ok(entries)
    }

    pub fn get_realm(&self, id: &str) -> Result<Option<crate::realm::Realm>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, name, languages, frameworks, architecture, conventions, scan_status, last_scanned_at, created_at, updated_at
             FROM realms WHERE id = ?1"
        ).map_err(|e| e.to_string())?;

        let result = stmt.query_row(params![id], |row| {
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
        }).ok();
        Ok(result)
    }

    pub fn get_realm_by_path(&self, path: &str) -> Result<Option<crate::realm::Realm>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, name, languages, frameworks, architecture, conventions, scan_status, last_scanned_at, created_at, updated_at
             FROM realms WHERE path = ?1"
        ).map_err(|e| e.to_string())?;

        let result = stmt.query_row(params![path], |row| {
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
        }).ok();
        Ok(result)
    }

    pub fn update_realm_scan(
        &self, id: &str, scan_status: &str,
        architecture: Option<&str>, conventions: Option<&str>,
        languages: Option<&str>, frameworks: Option<&str>,
    ) -> Result<(), String> {
        self.conn.execute(
            "UPDATE realms SET scan_status = ?1, last_scanned_at = datetime('now'), updated_at = datetime('now') WHERE id = ?2",
            params![scan_status, id],
        ).map_err(|e| e.to_string())?;

        if let Some(arch) = architecture {
            self.conn.execute(
                "UPDATE realms SET architecture = ?1 WHERE id = ?2",
                params![arch, id],
            ).map_err(|e| e.to_string())?;
        }
        if let Some(conv) = conventions {
            self.conn.execute(
                "UPDATE realms SET conventions = ?1 WHERE id = ?2",
                params![conv, id],
            ).map_err(|e| e.to_string())?;
        }
        if let Some(langs) = languages {
            self.conn.execute(
                "UPDATE realms SET languages = ?1 WHERE id = ?2",
                params![langs, id],
            ).map_err(|e| e.to_string())?;
        }
        if let Some(fws) = frameworks {
            self.conn.execute(
                "UPDATE realms SET frameworks = ?1 WHERE id = ?2",
                params![fws, id],
            ).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn delete_realm(&self, id: &str) -> Result<(), String> {
        self.conn.execute("DELETE FROM session_realms WHERE realm_id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        self.conn.execute("DELETE FROM realm_conventions WHERE realm_id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        self.conn.execute("DELETE FROM realms WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn attach_session_realm(&self, session_id: &str, realm_id: &str, role: &str) -> Result<(), String> {
        self.conn.execute(
            "INSERT OR IGNORE INTO session_realms (session_id, realm_id, role)
             VALUES (?1, ?2, ?3)",
            params![session_id, realm_id, role],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn detach_session_realm(&self, session_id: &str, realm_id: &str) -> Result<(), String> {
        self.conn.execute(
            "DELETE FROM session_realms WHERE session_id = ?1 AND realm_id = ?2",
            params![session_id, realm_id],
        ).map_err(|e| e.to_string())?;
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

        let rows = stmt.query_map(params![session_id], |row| {
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
        }).map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows { entries.push(row.map_err(|e| e.to_string())?); }
        Ok(entries)
    }

    pub fn get_sessions_for_realm(&self, realm_id: &str) -> Result<Vec<String>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT session_id FROM session_realms WHERE realm_id = ?1"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map(params![realm_id], |row| {
            row.get(0)
        }).map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows { entries.push(row.map_err(|e| e.to_string())?); }
        Ok(entries)
    }

    pub fn insert_convention(&self, realm_id: &str, rule: &str, source: &str, confidence: f64) -> Result<(), String> {
        self.conn.execute(
            "INSERT INTO realm_conventions (realm_id, rule, source, confidence)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(realm_id, rule) DO UPDATE SET
                source = excluded.source, confidence = excluded.confidence",
            params![realm_id, rule, source, confidence],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_conventions(&self, realm_id: &str) -> Result<Vec<crate::realm::Convention>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT rule, source, confidence FROM realm_conventions WHERE realm_id = ?1 ORDER BY confidence DESC"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map(params![realm_id], |row| {
            Ok(crate::realm::Convention {
                rule: row.get(0)?,
                source: row.get(1)?,
                confidence: row.get(2)?,
            })
        }).map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows { entries.push(row.map_err(|e| e.to_string())?); }
        Ok(entries)
    }

    // ─── Cost by Project ─────────────────────────────────────────

    pub fn get_cost_by_project(&self, days: i64) -> Result<Vec<ProjectCostEntry>, String> {
        let offset = format!("-{} days", days);
        let mut stmt = self.conn.prepare(
            "SELECT s.working_directory, t.provider,
                    SUM(t.input_tokens), SUM(t.output_tokens), SUM(t.estimated_cost_usd),
                    COUNT(DISTINCT t.session_id)
             FROM token_usage t
             JOIN sessions s ON s.id = t.session_id
             WHERE t.recorded_at >= datetime('now', ?1)
             GROUP BY s.working_directory, t.provider
             ORDER BY SUM(t.estimated_cost_usd) DESC"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map(params![offset], |row| {
            Ok(ProjectCostEntry {
                working_directory: row.get(0)?,
                provider: row.get(1)?,
                total_input_tokens: row.get(2)?,
                total_output_tokens: row.get(3)?,
                total_cost_usd: row.get(4)?,
                session_count: row.get(5)?,
            })
        }).map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        for row in rows { entries.push(row.map_err(|e| e.to_string())?); }
        Ok(entries)
    }
}

// ─── Tauri Command Wrappers ─────────────────────────────────────────

#[tauri::command]
pub fn get_recent_sessions(state: State<'_, AppState>, limit: Option<i64>) -> Result<Vec<SessionHistoryEntry>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_recent_sessions(limit.unwrap_or(20))
}

#[tauri::command]
pub fn get_session_snapshot(state: State<'_, AppState>, session_id: String) -> Result<Option<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_session_snapshot(&session_id)
}

#[tauri::command]
pub fn get_token_usage_today(state: State<'_, AppState>) -> Result<Vec<TokenUsageEntry>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_token_usage_today()
}

#[tauri::command]
pub fn get_cost_history(state: State<'_, AppState>, days: Option<i64>) -> Result<Vec<CostDailyEntry>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_cost_daily(days.unwrap_or(7))
}

#[tauri::command]
pub fn save_memory(
    state: State<'_, AppState>,
    scope: String, scope_id: String, key: String, value: String,
    source: Option<String>, category: Option<String>, confidence: Option<f64>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.save_memory_entry(
        &scope, &scope_id, &key, &value,
        &source.unwrap_or_else(|| "user".to_string()),
        &category.unwrap_or_else(|| "general".to_string()),
        confidence.unwrap_or(1.0),
    )
}

#[tauri::command]
pub fn delete_memory(state: State<'_, AppState>, scope: String, scope_id: String, key: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.delete_memory_entry(&scope, &scope_id, &key)
}

#[tauri::command]
pub fn get_all_memory(state: State<'_, AppState>, scope: String, scope_id: String) -> Result<Vec<MemoryEntry>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_all_memory_entries(&scope, &scope_id)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<HashMap<String, String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_all_settings()
}

#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.set_setting(&key, &value)
}

#[tauri::command]
pub fn log_execution(
    state: State<'_, AppState>,
    session_id: String, event_type: String, content: String,
    exit_code: Option<i32>, working_directory: Option<String>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.log_execution_entry(&session_id, &event_type, &content, exit_code, working_directory.as_deref())
}

#[tauri::command]
pub fn get_execution_log(state: State<'_, AppState>, session_id: String, limit: Option<i64>) -> Result<Vec<ExecutionEntry>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_execution_log_entries(&session_id, limit)
}

// ─── Execution Node Commands ─────────────────────────────────────────

#[tauri::command]
pub fn get_execution_nodes(state: State<'_, AppState>, session_id: String, limit: Option<i64>, offset: Option<i64>) -> Result<Vec<ExecutionNode>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_execution_nodes(&session_id, limit.unwrap_or(50), offset.unwrap_or(0))
}

#[tauri::command]
pub fn get_execution_node(state: State<'_, AppState>, id: i64) -> Result<Option<ExecutionNode>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_execution_node(id)
}

// ─── Error Pattern Commands ──────────────────────────────────────────

#[tauri::command]
pub fn find_error_match(state: State<'_, AppState>, project_id: Option<String>, fingerprint: String) -> Result<Option<ErrorPattern>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.find_error_pattern(project_id.as_deref(), &fingerprint)
}

#[tauri::command]
pub fn set_error_resolution(state: State<'_, AppState>, id: i64, resolution: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.set_error_resolution(id, &resolution)
}

// ─── Context Pin Commands ────────────────────────────────────────────

#[tauri::command]
pub fn add_context_pin(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: Option<String>, project_id: Option<String>,
    kind: String, target: String, label: Option<String>, priority: Option<i64>,
) -> Result<i64, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let id = db.add_context_pin(session_id.as_deref(), project_id.as_deref(), &kind, &target, label.as_deref(), priority)?;
    if let Some(ref sid) = session_id {
        let _ = app.emit(&format!("context-pins-changed-{}", sid), ());
    }
    Ok(id)
}

#[tauri::command]
pub fn remove_context_pin(state: State<'_, AppState>, app: AppHandle, id: i64) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let session_id = db.get_pin_session_id(id)?;
    db.remove_context_pin(id)?;
    if let Some(ref sid) = session_id {
        let _ = app.emit(&format!("context-pins-changed-{}", sid), ());
    }
    Ok(())
}

#[tauri::command]
pub fn get_context_pins(state: State<'_, AppState>, session_id: Option<String>, project_id: Option<String>) -> Result<Vec<ContextPin>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_context_pins(session_id.as_deref(), project_id.as_deref())
}

// ─── Context Snapshot Commands ────────────────────────────────────────

#[tauri::command]
pub fn save_context_snapshot(
    state: State<'_, AppState>,
    session_id: String, version: i64, context_json: String,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.save_context_snapshot(&session_id, version, &context_json)
}

#[tauri::command]
pub fn get_context_snapshots(state: State<'_, AppState>, session_id: String) -> Result<Vec<ContextSnapshotEntry>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_context_snapshots(&session_id)
}

#[tauri::command]
pub fn get_context_snapshot(state: State<'_, AppState>, session_id: String, version: i64) -> Result<Option<ContextSnapshotEntry>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_context_snapshot(&session_id, version)
}

// ─── Execution Nodes Count Command ───────────────────────────────────

#[tauri::command]
pub fn get_execution_nodes_count(state: State<'_, AppState>, session_id: String) -> Result<i64, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_execution_nodes_count(&session_id)
}

// ─── Error Correlation Commands ──────────────────────────────────────

#[tauri::command]
pub fn find_error_correlations(
    state: State<'_, AppState>,
    fingerprint: String, project_id: Option<String>, exclude_session: String, limit: Option<i64>,
) -> Result<Vec<ErrorCorrelation>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.find_error_correlations(&fingerprint, project_id.as_deref(), &exclude_session, limit.unwrap_or(5))
}

// ─── Error Resolutions Command ──────────────────────────────────────

#[tauri::command]
pub fn get_error_resolutions(state: State<'_, AppState>, project_id: Option<String>, limit: Option<i64>) -> Result<Vec<ErrorPattern>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_error_resolutions(project_id.as_deref(), limit.unwrap_or(10))
}

// ─── Cost by Project Command ─────────────────────────────────────────

#[tauri::command]
pub fn get_cost_by_project(state: State<'_, AppState>, days: Option<i64>) -> Result<Vec<ProjectCostEntry>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_cost_by_project(days.unwrap_or(7))
}

// ─── Settings Export / Import Commands ───────────────────────────────

#[tauri::command]
pub fn export_settings(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let settings = db.get_all_settings()?;
    let json = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write file: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn import_settings(state: State<'_, AppState>, path: String) -> Result<HashMap<String, String>, String> {
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    let imported: HashMap<String, String> = serde_json::from_str(&content)
        .map_err(|e| format!("Invalid settings JSON: {}", e))?;
    let db = state.db.lock().map_err(|e| e.to_string())?;
    for (key, value) in &imported {
        db.set_setting(key, value)?;
    }
    db.get_all_settings()
}
