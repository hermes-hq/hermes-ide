-- Database written by the real Hermes v1.2.5 release (macOS arm64 build),
-- with the synthetic rows from seed.sql. Captured by capture.mjs.
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE sessions (
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
            , description TEXT NOT NULL DEFAULT '', ssh_info TEXT);
INSERT INTO sessions VALUES('fx-session-1','API server','#58a6ff','backend','destroyed','/fixture-home/projects/api','/bin/zsh','["/fixture-home/projects/api"]','2026-01-10T09:00:00Z','2026-01-10T17:00:00Z',replace('test@host api % npm test\nall tests passed','\n',char(10)),'Runs the local API',NULL);
INSERT INTO sessions VALUES('fx-session-2','Web app','#f778ba',NULL,'destroyed','/fixture-home/projects/web','/bin/bash','["/fixture-home/projects/web","/fixture-home/projects/shared"]','2026-01-11T10:30:00Z',NULL,NULL,'',NULL);
INSERT INTO sessions VALUES('fx-session-3','Build box','#3fb950',NULL,'destroyed','/fixture-remote','/bin/bash','[]','2026-01-12T08:15:00Z','2026-01-12T09:00:00Z',NULL,'Remote builds','{"host":"build.example.test","port":22,"user":"test"}');
CREATE TABLE token_usage (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                estimated_cost_usd REAL DEFAULT 0.0,
                recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
INSERT INTO token_usage VALUES(1,'fx-session-1','claude','test-model',1200,340,0.01200000000000000024,'2026-01-10 10:00:00');
CREATE TABLE token_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                cost_usd REAL NOT NULL,
                recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
INSERT INTO token_snapshots VALUES(1,'fx-session-1','claude','test-model',1200,340,0.01200000000000000024,'2026-01-10 10:00:00');
CREATE TABLE cost_daily (
                date TEXT NOT NULL,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                total_input_tokens INTEGER NOT NULL DEFAULT 0,
                total_output_tokens INTEGER NOT NULL DEFAULT 0,
                total_cost_usd REAL NOT NULL DEFAULT 0.0,
                session_count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (date, provider, model)
            );
INSERT INTO cost_daily VALUES('2026-01-10','claude','test-model',1200,340,0.01200000000000000024,1);
CREATE TABLE memory (
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
INSERT INTO memory VALUES(1,'global','global','general','fx-editor','vim','user',1.0,0,'2026-09-27 12:39:59','2026-09-27 12:39:59',NULL);
INSERT INTO memory VALUES(2,'project','fx-realm-api','general','fx-test-command','npm test','auto',1.0,0,'2026-09-27 12:39:59','2026-09-27 12:39:59',NULL);
CREATE TABLE execution_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                content TEXT NOT NULL,
                exit_code INTEGER,
                working_directory TEXT,
                timestamp TEXT NOT NULL DEFAULT (datetime('now'))
            );
INSERT INTO execution_log VALUES(1,'fx-session-1','command','npm test',0,'/fixture-home/projects/api','2026-09-27 12:39:59');
CREATE TABLE settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
INSERT INTO settings VALUES('last_seen_version','1.2.5','2026-09-27 12:39:46');
INSERT INTO settings VALUES('theme','frosted-dark','2026-09-27 12:40:00');
INSERT INTO settings VALUES('font_size','15','2026-09-27 12:39:59');
INSERT INTO settings VALUES('ui_scale','1.1','2026-09-27 12:39:59');
INSERT INTO settings VALUES('default_shell','/bin/zsh','2026-09-27 12:39:59');
INSERT INTO settings VALUES('fx_marker','fixture-settings-row','2026-09-27 12:39:59');
INSERT INTO settings VALUES('saved_workspace','{"layout":{"type":"leaf","sessionId":"fx-session-1"},"sessions":["fx-session-1","fx-session-2"]}','2026-09-27 12:39:59');
CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                detected_languages TEXT,
                detected_frameworks TEXT,
                file_tree_hash TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
INSERT INTO projects VALUES('fx-project-legacy','/fixture-home/projects/legacy','legacy','["rust"]','[]',NULL,'2025-12-01 12:00:00','2025-12-01 12:00:00');
CREATE TABLE execution_nodes (
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
INSERT INTO execution_nodes VALUES(1,'fx-session-1',1768035600000,'command','npm test','all tests passed',0,'/fixture-home/projects/api',4200,NULL);
CREATE TABLE error_patterns (
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
INSERT INTO error_patterns VALUES(1,'fx-realm-api','fx-fp-1','error: cannot find module',2,1768035600,NULL,0,1790512799);
CREATE TABLE command_patterns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id TEXT,
                sequence TEXT NOT NULL,
                next_command TEXT NOT NULL,
                frequency INTEGER DEFAULT 1,
                last_seen INTEGER DEFAULT (strftime('%s','now')),
                UNIQUE(project_id, sequence, next_command)
            );
INSERT INTO command_patterns VALUES(1,'fx-realm-api','git status','git diff',3,1790512799);
CREATE TABLE context_pins (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT,
                project_id TEXT,
                kind TEXT NOT NULL CHECK(kind IN ('file','memory','text','directory')),
                target TEXT NOT NULL,
                label TEXT,
                priority INTEGER DEFAULT 128,
                created_at INTEGER DEFAULT (strftime('%s','now'))
            );
INSERT INTO context_pins VALUES(1,'fx-session-1','fx-realm-api','file','/fixture-home/projects/api/README.md','Readme',128,1790512799);
CREATE TABLE error_sessions (
                error_pattern_id INTEGER NOT NULL,
                session_id TEXT NOT NULL,
                last_seen INTEGER NOT NULL,
                occurrence_count INTEGER DEFAULT 1,
                PRIMARY KEY (error_pattern_id, session_id)
            );
CREATE TABLE realms (
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
INSERT INTO realms VALUES('fx-realm-api','/fixture-home/projects/api','api','["typescript"]','["express"]',NULL,'[]','surface',NULL,'2026-01-10 09:00:00','2026-01-10 09:00:00');
INSERT INTO realms VALUES('fx-realm-web','/fixture-home/projects/web','web','["typescript"]','["react"]',NULL,'[]','deep',NULL,'2026-01-11 10:30:00','2026-01-11 10:30:00');
INSERT INTO realms VALUES('fx-project-legacy','/fixture-home/projects/legacy','legacy','["rust"]','[]',NULL,'[]','surface',NULL,'2025-12-01 12:00:00','2025-12-01 12:00:00');
CREATE TABLE session_realms (
                session_id TEXT NOT NULL,
                realm_id TEXT NOT NULL,
                attached_at TEXT NOT NULL DEFAULT (datetime('now')),
                role TEXT NOT NULL DEFAULT 'primary',
                PRIMARY KEY (session_id, realm_id)
            );
INSERT INTO session_realms VALUES('fx-session-1','fx-realm-api','2026-09-27 12:39:59','primary');
INSERT INTO session_realms VALUES('fx-session-2','fx-realm-web','2026-09-27 12:39:59','primary');
CREATE TABLE realm_conventions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                realm_id TEXT NOT NULL,
                rule TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'detected',
                confidence REAL NOT NULL DEFAULT 0.8,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(realm_id, rule)
            );
INSERT INTO realm_conventions VALUES(1,'fx-realm-api','Use tabs for indentation','detected',0.9000000000000000222,'2026-09-27 12:39:59');
CREATE TABLE context_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                version INTEGER NOT NULL,
                context_json TEXT NOT NULL,
                created_at INTEGER DEFAULT (strftime('%s','now')),
                UNIQUE(session_id, version)
            );
INSERT INTO context_snapshots VALUES(1,'fx-session-1',1,'{"files":["README.md"]}',1790512799);
CREATE TABLE hermes_project_config (
                realm_id TEXT PRIMARY KEY,
                config_json TEXT NOT NULL,
                config_hash TEXT,
                loaded_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
INSERT INTO hermes_project_config VALUES('fx-realm-api','{"name":"api"}','fx-hash','2026-09-27 12:39:59');
CREATE TABLE plugins (
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
INSERT INTO plugins VALUES('fx.plugin.notes','1.2.0','Notes','Keeps notes per project','Test Author',1,'["storage"]','2026-09-27 12:39:59','2026-09-27 12:39:59');
INSERT INTO plugins VALUES('fx.plugin.timer','0.3.1','Timer',NULL,NULL,0,'[]','2026-09-27 12:39:59','2026-09-27 12:39:59');
CREATE TABLE plugin_storage (
                plugin_id TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (plugin_id, key)
            );
INSERT INTO plugin_storage VALUES('fx.plugin.notes','fx-realm-api','"Remember to rotate the test keys"','2026-09-27 12:39:59');
INSERT INTO plugin_storage VALUES('fx.plugin.notes','fx-realm-web','"Ship the login page"','2026-09-27 12:39:59');
CREATE TABLE ssh_saved_hosts (
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
INSERT INTO ssh_saved_hosts VALUES('fx-host-1','Build box','build.example.test',22,'test','/fixture-home/.ssh/id_ed25519',NULL,'[]','2026-09-27 12:39:59','2026-09-27 12:39:59');
INSERT INTO ssh_saved_hosts VALUES('fx-host-2','Staging','staging.example.test',2222,'deploy',NULL,'bastion.example.test','[{"local":8080,"remote":80}]','2026-09-27 12:39:59','2026-09-27 12:39:59');
CREATE TABLE project_usage (
                project_id TEXT PRIMARY KEY,
                session_count INTEGER NOT NULL DEFAULT 0,
                last_opened_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
INSERT INTO project_usage VALUES('fx-realm-api',4,'2026-01-12 08:15:00');
CREATE TABLE IF NOT EXISTS "session_worktrees" (
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
INSERT INTO session_worktrees VALUES('fx-wt-1','fx-session-1','fx-realm-api','/fixture-home/projects/api','main',1,'2026-09-27 12:39:59',NULL);
INSERT INTO session_worktrees VALUES('fx-wt-2','fx-session-2','fx-realm-web','/fixture-home/projects/web','main',1,'2026-09-27 12:39:59',NULL);
DELETE FROM sqlite_sequence;
INSERT INTO sqlite_sequence VALUES('realm_conventions',1);
INSERT INTO sqlite_sequence VALUES('memory',2);
INSERT INTO sqlite_sequence VALUES('token_usage',1);
INSERT INTO sqlite_sequence VALUES('token_snapshots',1);
INSERT INTO sqlite_sequence VALUES('execution_log',1);
INSERT INTO sqlite_sequence VALUES('execution_nodes',1);
INSERT INTO sqlite_sequence VALUES('command_patterns',1);
INSERT INTO sqlite_sequence VALUES('error_patterns',1);
INSERT INTO sqlite_sequence VALUES('context_pins',1);
INSERT INTO sqlite_sequence VALUES('context_snapshots',1);
CREATE INDEX idx_token_session ON token_usage(session_id, provider);
CREATE INDEX idx_token_snap_session ON token_snapshots(session_id);
CREATE INDEX idx_token_snap_date ON token_snapshots(recorded_at);
CREATE INDEX idx_memory_scope ON memory(scope, scope_id);
CREATE INDEX idx_exec_session ON execution_log(session_id, timestamp);
CREATE INDEX idx_projects_path ON projects(path);
CREATE INDEX idx_exec_nodes_session ON execution_nodes(session_id, timestamp);
CREATE UNIQUE INDEX idx_error_fp ON error_patterns(project_id, fingerprint);
CREATE INDEX idx_cmd_patterns ON command_patterns(project_id, sequence);
CREATE INDEX idx_pins_session ON context_pins(session_id);
CREATE INDEX idx_pins_project ON context_pins(project_id);
CREATE INDEX idx_realms_path ON realms(path);
CREATE INDEX idx_session_realms_session ON session_realms(session_id);
CREATE INDEX idx_conventions_realm ON realm_conventions(realm_id);
CREATE INDEX idx_ctx_snap_session ON context_snapshots(session_id);
CREATE INDEX idx_plugin_storage_plugin ON plugin_storage(plugin_id);
CREATE INDEX idx_sessions_closed_phase
                ON sessions(closed_at DESC, phase) WHERE closed_at IS NOT NULL;
CREATE INDEX idx_token_usage_recorded_at
                ON token_usage(recorded_at);
CREATE INDEX idx_session_realms_realm
                ON session_realms(realm_id);
CREATE INDEX idx_cmd_patterns_freq
                ON command_patterns(project_id, sequence, frequency DESC);
CREATE INDEX idx_sw_session ON session_worktrees(session_id);
CREATE INDEX idx_sw_realm ON session_worktrees(realm_id);
CREATE INDEX idx_sw_path ON session_worktrees(worktree_path);
COMMIT;
