-- Synthetic data written into a database created by a real old release
-- before it is captured as a fixture (see capture.mjs). Every id starts with
-- "fx-" and every path lives under /fixture-home, so nothing here belongs to a
-- real person or machine. Fits the schema of every release from 0.6.16 on.

INSERT OR REPLACE INTO settings (key, value) VALUES
  ('theme', 'dark'),
  ('font_size', '15'),
  ('ui_scale', '1.1'),
  ('default_shell', '/bin/zsh'),
  ('fx_marker', 'fixture-settings-row'),
  ('saved_workspace', '{"layout":{"type":"leaf","sessionId":"fx-session-1"},"sessions":["fx-session-1","fx-session-2"]}');

INSERT INTO sessions (id, label, description, color, group_name, phase, working_directory, shell, workspace_paths, created_at, closed_at, scrollback_snapshot, ssh_info) VALUES
  ('fx-session-1', 'API server', 'Runs the local API', '#58a6ff', 'backend', 'destroyed', '/fixture-home/projects/api', '/bin/zsh', '["/fixture-home/projects/api"]', '2026-01-10T09:00:00Z', '2026-01-10T17:00:00Z', 'test@host api % npm test
all tests passed', NULL),
  ('fx-session-2', 'Web app', '', '#f778ba', NULL, 'destroyed', '/fixture-home/projects/web', '/bin/bash', '["/fixture-home/projects/web","/fixture-home/projects/shared"]', '2026-01-11T10:30:00Z', NULL, NULL, NULL),
  ('fx-session-3', 'Build box', 'Remote builds', '#3fb950', NULL, 'destroyed', '/fixture-remote', '/bin/bash', '[]', '2026-01-12T08:15:00Z', '2026-01-12T09:00:00Z', NULL, '{"host":"build.example.test","port":22,"user":"test"}');

INSERT INTO projects (id, path, name, detected_languages, detected_frameworks, created_at, updated_at) VALUES
  ('fx-project-legacy', '/fixture-home/projects/legacy', 'legacy', '["rust"]', '[]', '2025-12-01 12:00:00', '2025-12-01 12:00:00');

INSERT INTO realms (id, path, name, languages, frameworks, architecture, conventions, scan_status, created_at, updated_at) VALUES
  ('fx-realm-api', '/fixture-home/projects/api', 'api', '["typescript"]', '["express"]', NULL, '[]', 'surface', '2026-01-10 09:00:00', '2026-01-10 09:00:00'),
  ('fx-realm-web', '/fixture-home/projects/web', 'web', '["typescript"]', '["react"]', NULL, '[]', 'deep', '2026-01-11 10:30:00', '2026-01-11 10:30:00');

INSERT INTO session_realms (session_id, realm_id, role) VALUES
  ('fx-session-1', 'fx-realm-api', 'primary'),
  ('fx-session-2', 'fx-realm-web', 'primary');

INSERT INTO realm_conventions (realm_id, rule, source, confidence) VALUES
  ('fx-realm-api', 'Use tabs for indentation', 'detected', 0.9);

INSERT INTO session_worktrees (id, session_id, realm_id, worktree_path, branch_name, is_main_worktree) VALUES
  ('fx-wt-1', 'fx-session-1', 'fx-realm-api', '/fixture-home/projects/api', 'main', 1),
  ('fx-wt-2', 'fx-session-2', 'fx-realm-web', '/fixture-home/projects/web', 'main', 1);

INSERT INTO ssh_saved_hosts (id, label, host, port, user, identity_file, jump_host, port_forwards) VALUES
  ('fx-host-1', 'Build box', 'build.example.test', 22, 'test', '/fixture-home/.ssh/id_ed25519', NULL, '[]'),
  ('fx-host-2', 'Staging', 'staging.example.test', 2222, 'deploy', NULL, 'bastion.example.test', '[{"local":8080,"remote":80}]');

INSERT INTO plugins (id, version, name, description, author, enabled, permissions_granted) VALUES
  ('fx.plugin.notes', '1.2.0', 'Notes', 'Keeps notes per project', 'Test Author', 1, '["storage"]'),
  ('fx.plugin.timer', '0.3.1', 'Timer', NULL, NULL, 0, '[]');

INSERT INTO plugin_storage (plugin_id, key, value) VALUES
  ('fx.plugin.notes', 'fx-realm-api', '"Remember to rotate the test keys"'),
  ('fx.plugin.notes', 'fx-realm-web', '"Ship the login page"');

INSERT INTO memory (scope, scope_id, category, key, value, source) VALUES
  ('global', 'global', 'general', 'fx-editor', 'vim', 'user'),
  ('project', 'fx-realm-api', 'general', 'fx-test-command', 'npm test', 'auto');

INSERT INTO token_usage (session_id, provider, model, input_tokens, output_tokens, estimated_cost_usd, recorded_at) VALUES
  ('fx-session-1', 'claude', 'test-model', 1200, 340, 0.012, '2026-01-10 10:00:00');

INSERT INTO token_snapshots (session_id, provider, model, input_tokens, output_tokens, cost_usd, recorded_at) VALUES
  ('fx-session-1', 'claude', 'test-model', 1200, 340, 0.012, '2026-01-10 10:00:00');

INSERT INTO cost_daily (date, provider, model, total_input_tokens, total_output_tokens, total_cost_usd, session_count) VALUES
  ('2026-01-10', 'claude', 'test-model', 1200, 340, 0.012, 1);

INSERT INTO execution_log (session_id, event_type, content, exit_code, working_directory) VALUES
  ('fx-session-1', 'command', 'npm test', 0, '/fixture-home/projects/api');

INSERT INTO execution_nodes (session_id, timestamp, kind, input, output_summary, exit_code, working_dir, duration_ms) VALUES
  ('fx-session-1', 1768035600000, 'command', 'npm test', 'all tests passed', 0, '/fixture-home/projects/api', 4200);

INSERT INTO command_patterns (project_id, sequence, next_command, frequency) VALUES
  ('fx-realm-api', 'git status', 'git diff', 3);

INSERT INTO error_patterns (project_id, fingerprint, raw_sample, occurrence_count, last_seen) VALUES
  ('fx-realm-api', 'fx-fp-1', 'error: cannot find module', 2, 1768035600);

INSERT INTO context_pins (session_id, project_id, kind, target, label) VALUES
  ('fx-session-1', 'fx-realm-api', 'file', '/fixture-home/projects/api/README.md', 'Readme');

INSERT INTO context_snapshots (session_id, version, context_json) VALUES
  ('fx-session-1', 1, '{"files":["README.md"]}');

INSERT INTO hermes_project_config (realm_id, config_json, config_hash) VALUES
  ('fx-realm-api', '{"name":"api"}', 'fx-hash');

INSERT INTO project_usage (project_id, session_count, last_opened_at) VALUES
  ('fx-realm-api', 4, '2026-01-12 08:15:00');
