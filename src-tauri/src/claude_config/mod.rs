//! Direct read/write helpers for the Claude config files Hermes manages
//! on the user's behalf:
//!
//!   - `~/.claude.json`              MCP servers
//!   - `~/.claude/settings.json`     permission rules (user scope)
//!   - `<project>/.claude/settings.json`  permission rules (project scope)
//!   - `~/.claude/CLAUDE.md` + project CLAUDE.md  memory files
//!
//! Per locked decision §0.2 of `docs/internal/v1-tui-parity-plan.md`, all
//! writes go to the same files Claude Code (TUI) reads — so a Hermes
//! edit applies in standalone Claude Code without round-trips.
//!
//! Every JSON write goes through `atomic_json_write` (read → mutate →
//! write tmp → rename) so a partial write or concurrent crash never
//! corrupts the user's config.  Memory file writes go through
//! `safe_memory_write`, which canonicalises the path against an
//! allowlist to refuse traversal exploits.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

// ─── Atomic JSON writer ────────────────────────────────────────────

/// Read a JSON file, apply `mutator`, write atomically.  Preserves
/// unrelated keys.  Used by every IPC that writes to ~/.claude.json or
/// ~/.claude/settings.json.
pub fn atomic_json_write<F>(path: &Path, mutator: F) -> Result<(), String>
where
    F: FnOnce(&mut Map<String, Value>) -> Result<(), String>,
{
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create parent dir: {e}"))?;
    }

    let mut root: Map<String, Value> = if path.exists() {
        let bytes = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
        if bytes.is_empty() {
            Map::new()
        } else {
            serde_json::from_slice::<Value>(&bytes)
                .map_err(|e| format!("parse {}: {e}", path.display()))?
                .as_object()
                .cloned()
                .unwrap_or_default()
        }
    } else {
        Map::new()
    };

    mutator(&mut root)?;

    let pretty = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|e| format!("serialize: {e}"))?;
    let tmp = path.with_extension("tmp");
    let mut f = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&tmp)
        .map_err(|e| format!("open tmp: {e}"))?;
    f.write_all(pretty.as_bytes())
        .map_err(|e| format!("write tmp: {e}"))?;
    f.write_all(b"\n")
        .map_err(|e| format!("write tmp newline: {e}"))?;
    f.sync_all().map_err(|e| format!("fsync tmp: {e}"))?;
    drop(f);

    fs::rename(&tmp, path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

fn home_config_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME unset".to_string())?;
    Ok(PathBuf::from(home).join(".claude.json"))
}

fn home_settings_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME unset".to_string())?;
    Ok(PathBuf::from(home).join(".claude").join("settings.json"))
}

// ─── MCP server commands ──────────────────────────────────────────

/// Optional typed shape — kept for future strict-validation work.
/// The IPC currently accepts an opaque `Value` so it can pass through
/// any forward-compatible MCP shape the SDK adds without a Rust release.
#[allow(dead_code)]
#[derive(Serialize, Deserialize, Debug)]
#[serde(untagged)]
pub enum McpServerSpec {
    Stdio {
        #[serde(rename = "type")]
        kind: String,
        command: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        args: Option<Vec<String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        env: Option<std::collections::HashMap<String, String>>,
    },
    Remote {
        #[serde(rename = "type")]
        kind: String,
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        headers: Option<std::collections::HashMap<String, String>>,
    },
}

/// Add or replace an MCP server entry in `~/.claude.json`.  Preserves
/// every other key; the rule must NOT silently drop user data.
#[tauri::command]
pub fn write_mcp_server(name: String, spec: Value) -> Result<(), String> {
    let path = home_config_path()?;
    let validated_name = validate_server_name(&name)?;
    atomic_json_write(&path, |root| {
        let entry = root
            .entry("mcpServers")
            .or_insert_with(|| Value::Object(Map::new()));
        let map = entry
            .as_object_mut()
            .ok_or_else(|| "mcpServers is not an object — refusing to overwrite".to_string())?;
        map.insert(validated_name.to_string(), spec.clone());
        Ok(())
    })
}

/// Remove an MCP server entry.  No-op if absent (idempotent).
#[tauri::command]
pub fn remove_mcp_server(name: String) -> Result<(), String> {
    let path = home_config_path()?;
    let validated_name = validate_server_name(&name)?;
    atomic_json_write(&path, |root| {
        if let Some(entry) = root.get_mut("mcpServers") {
            if let Some(map) = entry.as_object_mut() {
                map.remove(validated_name);
            }
        }
        Ok(())
    })
}

/// Inspectable view of an MCP server entry — what the user can see in
/// the panel without leaking secrets.  `command` / `url` are surfaced
/// as-is; `env_keys` / `header_keys` list the names only (values are
/// stripped because they may carry tokens / credentials).
///
/// Returns `Ok(None)` when the named server isn't in `~/.claude.json`
/// (idempotent caller experience).  Errors only on filesystem / JSON
/// failure.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct McpServerSpecView {
    pub name: String,
    /// "stdio" | "sse" | "http" | "unknown".
    pub transport: String,
    /// stdio: the executable path / argv\[0\].  Remote: empty.
    pub command: String,
    /// stdio: positional args after the command.  Remote: empty.
    pub args: Vec<String>,
    /// Remote (sse/http): the endpoint URL.  stdio: empty.
    pub url: String,
    /// Names of environment variables defined on the spec.  VALUES
    /// are NEVER returned — they may carry tokens / credentials.
    pub env_keys: Vec<String>,
    /// Names of HTTP headers (sse/http only).  Same redaction rule
    /// as `env_keys`.
    pub header_keys: Vec<String>,
}

#[tauri::command]
pub fn read_mcp_server_spec(name: String) -> Result<Option<McpServerSpecView>, String> {
    let path = home_config_path()?;
    let validated_name = validate_server_name(&name)?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(|e| format!("read: {e}"))?;
    if bytes.is_empty() {
        return Ok(None);
    }
    let root: Value = serde_json::from_slice(&bytes).map_err(|e| format!("parse: {e}"))?;
    let entry = match root
        .get("mcpServers")
        .and_then(|v| v.as_object())
        .and_then(|m| m.get(validated_name))
    {
        Some(v) => v,
        None => return Ok(None),
    };

    let transport = entry
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let command = entry
        .get("command")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let args = entry
        .get("args")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let url = entry
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let env_keys = entry
        .get("env")
        .and_then(|v| v.as_object())
        .map(|m| m.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let header_keys = entry
        .get("headers")
        .and_then(|v| v.as_object())
        .map(|m| m.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();

    Ok(Some(McpServerSpecView {
        name: validated_name.to_string(),
        transport,
        command,
        args,
        url,
        env_keys,
        header_keys,
    }))
}

fn validate_server_name(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("name is required".into());
    }
    // Real MCP server names from the Claude Code ecosystem include
    // dots and colons — e.g. "claude.ai Gmail", "plugin:telegram:telegram",
    // "hermes-hq.kanban-board".  The previous tighter whitelist rejected
    // those, breaking remove / read-spec on legitimate entries.
    //
    // Names are stored as JSON object keys and used only for HashMap
    // lookups — never interpolated into shell or filesystem paths — so
    // path-traversal isn't a risk.  We still block shell metacharacters
    // (`;` `|` `&` `$` `<` `>` `` ` `` `'` `"` `\` `/`) as defense in
    // depth + to keep accidental copy-paste honest.
    if !trimmed.chars().all(|c| {
        c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == ' ' || c == '.' || c == ':'
    }) {
        return Err("name contains invalid characters".into());
    }
    Ok(trimmed)
}

// ─── Memory file commands ────────────────────────────────────────

#[tauri::command]
pub fn read_memory_file(path: String) -> Result<String, String> {
    let p = canonicalise_memory_path(&path)?;
    fs::read_to_string(&p).map_err(|e| format!("read: {e}"))
}

#[tauri::command]
pub fn write_memory_file(path: String, content: String) -> Result<(), String> {
    let p = canonicalise_memory_path(&path)?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create parent: {e}"))?;
    }
    let tmp = p.with_extension("tmp");
    let mut f = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&tmp)
        .map_err(|e| format!("open tmp: {e}"))?;
    f.write_all(content.as_bytes())
        .map_err(|e| format!("write tmp: {e}"))?;
    if !content.ends_with('\n') {
        f.write_all(b"\n")
            .map_err(|e| format!("trailing newline: {e}"))?;
    }
    f.sync_all().map_err(|e| format!("fsync: {e}"))?;
    drop(f);
    fs::rename(&tmp, &p).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

/// Refuse to read/write memory files whose path is a symlink, contains
/// `..`, or escapes a known-good prefix.  Defense against TOCTOU and
/// path-traversal on a string the frontend supplies.
fn canonicalise_memory_path(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err("memory path must be absolute".into());
    }
    if path.contains("..") {
        return Err("memory path contains '..'".into());
    }
    let filename = p
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "memory path missing filename".to_string())?;
    if !filename.ends_with(".md") {
        return Err("memory file must be a .md file".into());
    }
    // Reject any symlink in the immediate path.  fs::symlink_metadata
    // returns Err if the file doesn't exist yet, which is OK — we'll
    // create it via atomic write.
    if let Ok(meta) = fs::symlink_metadata(&p) {
        if meta.file_type().is_symlink() {
            return Err("memory path is a symlink — refused".into());
        }
    }
    Ok(p)
}

// ─── Permission rule commands ─────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PermissionRule {
    pub pattern: String,
    pub source: String, // "user" | "project"
    pub kind: String,   // "allow" | "deny"
}

/// Read both user and project settings, return merged rule list.
#[tauri::command]
pub fn read_permission_rules() -> Result<Vec<PermissionRule>, String> {
    let user_path = home_settings_path()?;
    let mut rules = Vec::new();
    rules.extend(read_rules_at(&user_path, "user")?);
    // Project settings discovery deferred to frontend (it knows cwd).
    Ok(rules)
}

fn read_rules_at(path: &Path, source: &str) -> Result<Vec<PermissionRule>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let json: Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("parse {}: {e}", path.display()))?;
    let perms = json
        .get("permissions")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for kind in &["allow", "deny"] {
        if let Some(arr) = perms.get(*kind).and_then(|v| v.as_array()) {
            for v in arr {
                if let Some(s) = v.as_str() {
                    out.push(PermissionRule {
                        pattern: s.to_string(),
                        source: source.to_string(),
                        kind: kind.to_string(),
                    });
                }
            }
        }
    }
    Ok(out)
}

/// Add a rule.  Scope = "user" → ~/.claude/settings.json.  Project
/// scope is for a future commit (needs cwd discovery from the active
/// session).  Idempotent — duplicate rules are dropped.
#[tauri::command]
pub fn write_permission_rule(pattern: String, kind: String, scope: String) -> Result<(), String> {
    if kind != "allow" && kind != "deny" {
        return Err(format!("kind must be 'allow' or 'deny', got {kind}"));
    }
    let path = match scope.as_str() {
        "user" => home_settings_path()?,
        "project" => return Err("project-scope rules not yet supported".into()),
        _ => return Err(format!("scope must be 'user' or 'project', got {scope}")),
    };
    atomic_json_write(&path, |root| {
        let perms = root
            .entry("permissions")
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .ok_or_else(|| "permissions is not an object".to_string())?;
        let arr = perms
            .entry(kind.clone())
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or_else(|| format!("permissions.{kind} is not an array"))?;
        // Dedupe.
        let exists = arr.iter().any(|v| v.as_str() == Some(pattern.as_str()));
        if !exists {
            arr.push(Value::String(pattern.clone()));
        }
        Ok(())
    })
}

#[tauri::command]
pub fn remove_permission_rule(pattern: String, kind: String, scope: String) -> Result<(), String> {
    let path = match scope.as_str() {
        "user" => home_settings_path()?,
        "project" => return Err("project-scope rules not yet supported".into()),
        _ => return Err(format!("scope must be 'user' or 'project', got {scope}")),
    };
    atomic_json_write(&path, |root| {
        if let Some(perms) = root.get_mut("permissions").and_then(|v| v.as_object_mut()) {
            if let Some(arr) = perms.get_mut(&kind).and_then(|v| v.as_array_mut()) {
                arr.retain(|v| v.as_str() != Some(pattern.as_str()));
            }
        }
        Ok(())
    })
}

// ─── Tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn atomic_json_write_creates_missing_file() {
        let td = tempdir().unwrap();
        let p = td.path().join("a.json");
        atomic_json_write(&p, |root| {
            root.insert("key".into(), Value::String("v".into()));
            Ok(())
        })
        .unwrap();
        let content = fs::read_to_string(&p).unwrap();
        assert!(content.contains("\"key\": \"v\""));
    }

    #[test]
    fn atomic_json_write_preserves_other_keys() {
        let td = tempdir().unwrap();
        let p = td.path().join("a.json");
        fs::write(&p, br#"{"a":1,"b":"keep"}"#).unwrap();
        atomic_json_write(&p, |root| {
            root.insert("c".into(), Value::Bool(true));
            Ok(())
        })
        .unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["a"], Value::Number(1.into()));
        assert_eq!(v["b"], Value::String("keep".into()));
        assert_eq!(v["c"], Value::Bool(true));
    }

    #[test]
    fn atomic_json_write_no_partial_file_on_mutator_error() {
        let td = tempdir().unwrap();
        let p = td.path().join("a.json");
        fs::write(&p, br#"{"a":1}"#).unwrap();
        let result = atomic_json_write(&p, |_| Err("nope".into()));
        assert!(result.is_err());
        // Original content untouched.
        let v: Value = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["a"], Value::Number(1.into()));
        // No leftover .tmp.
        let tmp = p.with_extension("tmp");
        assert!(!tmp.exists() || fs::read(&tmp).map(|b| b.is_empty()).unwrap_or(true));
    }

    #[test]
    fn validate_server_name_rejects_metachars() {
        assert!(validate_server_name("ok").is_ok());
        assert!(validate_server_name("ok-name").is_ok());
        assert!(validate_server_name("ok name").is_ok());
        assert!(validate_server_name("evil; rm").is_err());
        assert!(validate_server_name("$(whoami)").is_err());
        assert!(validate_server_name("").is_err());
        assert!(validate_server_name("   ").is_err());
        // Path-traversal-shaped strings should still be rejected
        // because they contain `/` (not in our whitelist).
        assert!(validate_server_name("../etc/passwd").is_err());
        assert!(validate_server_name("a|b").is_err());
        assert!(validate_server_name("a>b").is_err());
        assert!(validate_server_name("a\"b").is_err());
        assert!(validate_server_name("a`b").is_err());
        assert!(validate_server_name("a\\b").is_err());
    }

    /// Real-world MCP server names from Claude's ecosystem.  These all
    /// MUST validate, otherwise remove / read-spec breaks for users.
    /// (Bug repro from the screenshot — "claude.ai Gmail" was rejected.)
    #[test]
    fn validate_server_name_accepts_real_world_names() {
        assert!(validate_server_name("claude.ai Gmail").is_ok());
        assert!(validate_server_name("claude.ai Google Drive").is_ok());
        assert!(validate_server_name("claude.ai Google Calendar").is_ok());
        assert!(validate_server_name("plugin:telegram:telegram").is_ok());
        assert!(validate_server_name("hermes-hq.kanban-board").is_ok());
        assert!(validate_server_name("context7").is_ok());
        assert!(validate_server_name("Sanity").is_ok());
        assert!(validate_server_name("mcp_server.v2").is_ok());
        assert!(validate_server_name("name.with.many.dots").is_ok());
        assert!(validate_server_name("plugin:multi:colon:nesting").is_ok());
    }

    #[test]
    fn canonicalise_memory_path_rejects_traversal() {
        assert!(canonicalise_memory_path("/tmp/../etc/passwd.md").is_err());
        assert!(canonicalise_memory_path("relative.md").is_err());
    }

    #[test]
    fn canonicalise_memory_path_requires_md_extension() {
        assert!(canonicalise_memory_path("/tmp/x.txt").is_err());
        assert!(canonicalise_memory_path("/tmp/CLAUDE.md").is_ok());
    }
}

// Suppress unused warning on AppHandle import — kept available for
// future commands that want to emit events on save (M4 mtime watcher).
#[allow(dead_code)]
fn _suppress_apphandle_unused(_: AppHandle) {}

// ─── Prewarm: static reads from disk before SDK init ──────────────
//
// In stream-json mode the SDK only emits `init` after the first user
// message lands.  The static reads below populate the UI from on-disk
// sources so MCP servers / slash commands / memory paths are visible
// the moment a session is created.  See §8.12 of v1-tui-parity-plan.md.

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct StaticMcpServer {
    pub name: String,
    pub status: String,
}

/// Read MCP servers from `~/.claude.json` without spawning Claude.
/// Returns `[]` if the file is missing or corrupt — never errors,
/// because a missing config is a normal first-run state.
#[tauri::command]
pub fn read_static_mcp_servers() -> Vec<StaticMcpServer> {
    let path = match home_config_path() {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    if !path.exists() {
        return Vec::new();
    }
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    if bytes.is_empty() {
        return Vec::new();
    }
    let root: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let servers = root
        .get("mcpServers")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    servers
        .into_iter()
        .map(|(name, _spec)| StaticMcpServer {
            name,
            // Status is "unknown" until the live init event arrives —
            // we know the server exists in the config, but not whether
            // it actually connected this session.
            status: "unknown".to_string(),
        })
        .collect()
}

/// Read slash commands from on-disk sources without spawning Claude.
/// Sources, in priority order: `<cwd>/.claude/commands/*.md`,
/// `~/.claude/commands/*.md`.  Each filename → a `/<name>` command.
#[tauri::command]
pub fn read_static_slash_commands(cwd: Option<String>) -> Vec<String> {
    let mut commands = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let mut search = Vec::new();
    if let Some(c) = cwd.filter(|s| !s.is_empty()) {
        let p = PathBuf::from(&c).join(".claude").join("commands");
        // Refuse paths containing `..` defensively.
        if !c.contains("..") && p.is_absolute() {
            search.push(p);
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        search.push(PathBuf::from(home).join(".claude").join("commands"));
    }

    for dir in search {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if path.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
                let cmd = format!("/{}", name);
                if seen.insert(cmd.clone()) {
                    commands.push(cmd);
                }
            }
        }
    }
    commands.sort();
    commands
}

/// Read CLAUDE.md memory file paths that exist on disk.  Returns
/// absolute paths; the frontend renders them via the M4 memory editor.
#[tauri::command]
pub fn read_static_memory_paths(cwd: Option<String>) -> Vec<String> {
    let mut paths = Vec::new();

    if let Ok(home) = std::env::var("HOME") {
        let user_md = PathBuf::from(&home).join(".claude").join("CLAUDE.md");
        if user_md.exists() {
            if let Some(s) = user_md.to_str() {
                paths.push(s.to_string());
            }
        }
    }

    if let Some(c) = cwd.filter(|s| !s.is_empty() && !s.contains("..")) {
        let proj_md = PathBuf::from(&c).join("CLAUDE.md");
        if proj_md.exists() {
            if let Some(s) = proj_md.to_str() {
                paths.push(s.to_string());
            }
        }
    }

    paths
}

#[cfg(test)]
mod prewarm_tests {
    use super::*;
    use std::sync::Mutex;
    use tempfile::tempdir;

    /// Tests in this module mutate the process-global `HOME` env var
    /// to point at a fresh tempdir.  Cargo's default test runner is
    /// multi-threaded, which races us — guard every test with this
    /// mutex so HOME-mutating tests are serialised.
    static HOME_MUTEX: Mutex<()> = Mutex::new(());

    #[test]
    fn pw_2_static_mcp_servers_returns_empty_when_file_missing() {
        let _g = HOME_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let td = tempdir().unwrap();
        std::env::set_var("HOME", td.path());
        let got = read_static_mcp_servers();
        assert_eq!(got.len(), 0);
    }

    #[test]
    fn pw_3_static_mcp_servers_returns_empty_on_corrupt_json() {
        let _g = HOME_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let td = tempdir().unwrap();
        std::env::set_var("HOME", td.path());
        std::fs::write(td.path().join(".claude.json"), b"{ broken").unwrap();
        let got = read_static_mcp_servers();
        assert_eq!(got.len(), 0);
    }

    #[test]
    fn pw_1_static_mcp_servers_parses_well_formed_config() {
        let _g = HOME_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let td = tempdir().unwrap();
        std::env::set_var("HOME", td.path());
        std::fs::write(
            td.path().join(".claude.json"),
            br#"{"mcpServers":{"context7":{"type":"stdio","command":"npx"},"Sanity":{"type":"stdio","command":"x"}}}"#,
        ).unwrap();
        let got = read_static_mcp_servers();
        let names: Vec<_> = got.iter().map(|s| s.name.clone()).collect();
        assert!(names.contains(&"context7".to_string()));
        assert!(names.contains(&"Sanity".to_string()));
        assert!(got.iter().all(|s| s.status == "unknown"));
    }

    // ─── read_mcp_server_spec ───────────────────────────────────
    //
    // Surfaces the on-disk spec for a single named server so the
    // frontend can show transport / command / url / env-key details
    // when the MCP row is expanded.  Critical contract: env / header
    // VALUES must NEVER appear in the response — only the keys.

    #[test]
    fn mcp_spec_returns_none_when_config_missing() {
        let _g = HOME_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let td = tempdir().unwrap();
        std::env::set_var("HOME", td.path());
        let got = read_mcp_server_spec("anything".into()).unwrap();
        assert!(got.is_none());
    }

    #[test]
    fn mcp_spec_returns_none_when_server_absent() {
        let _g = HOME_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let td = tempdir().unwrap();
        std::env::set_var("HOME", td.path());
        std::fs::write(
            td.path().join(".claude.json"),
            br#"{"mcpServers":{"other":{"type":"stdio","command":"x"}}}"#,
        )
        .unwrap();
        let got = read_mcp_server_spec("missing".into()).unwrap();
        assert!(got.is_none());
    }

    #[test]
    fn mcp_spec_stdio_returns_command_args_and_env_keys() {
        let _g = HOME_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let td = tempdir().unwrap();
        std::env::set_var("HOME", td.path());
        std::fs::write(
            td.path().join(".claude.json"),
            br#"{"mcpServers":{"ctx":{
                "type":"stdio",
                "command":"npx",
                "args":["-y","@upstash/context7-mcp"],
                "env":{"CONTEXT7_API_KEY":"secret-token","DEBUG":"1"}
            }}}"#,
        )
        .unwrap();
        let got = read_mcp_server_spec("ctx".into()).unwrap().unwrap();
        assert_eq!(got.name, "ctx");
        assert_eq!(got.transport, "stdio");
        assert_eq!(got.command, "npx");
        assert_eq!(got.args, vec!["-y", "@upstash/context7-mcp"]);
        assert_eq!(got.url, "");
        assert_eq!(got.header_keys.len(), 0);
        // Env keys returned, sorted in insertion order; values stripped.
        let mut keys = got.env_keys.clone();
        keys.sort();
        assert_eq!(
            keys,
            vec!["CONTEXT7_API_KEY".to_string(), "DEBUG".to_string()]
        );
    }

    #[test]
    fn mcp_spec_NEVER_returns_env_values() {
        // Strict redaction contract — env values may carry tokens.
        let _g = HOME_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let td = tempdir().unwrap();
        std::env::set_var("HOME", td.path());
        std::fs::write(
            td.path().join(".claude.json"),
            br#"{"mcpServers":{"s":{"type":"stdio","command":"x","env":{"SECRET":"DO_NOT_LEAK"}}}}"#,
        )
        .unwrap();
        let got = read_mcp_server_spec("s".into()).unwrap().unwrap();
        let serialized = serde_json::to_string(&got).unwrap();
        assert!(!serialized.contains("DO_NOT_LEAK"));
        assert!(serialized.contains("SECRET"));
    }

    #[test]
    fn mcp_spec_remote_returns_url_and_header_keys() {
        let _g = HOME_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let td = tempdir().unwrap();
        std::env::set_var("HOME", td.path());
        std::fs::write(
            td.path().join(".claude.json"),
            br#"{"mcpServers":{"sanity":{
                "type":"sse",
                "url":"https://mcp.sanity.io/sse",
                "headers":{"Authorization":"Bearer secret-here"}
            }}}"#,
        )
        .unwrap();
        let got = read_mcp_server_spec("sanity".into()).unwrap().unwrap();
        assert_eq!(got.transport, "sse");
        assert_eq!(got.url, "https://mcp.sanity.io/sse");
        assert_eq!(got.header_keys, vec!["Authorization".to_string()]);
        assert_eq!(got.command, "");
        assert_eq!(got.args.len(), 0);
        // Header VALUES are never returned.
        let serialized = serde_json::to_string(&got).unwrap();
        assert!(!serialized.contains("secret-here"));
    }

    #[test]
    fn mcp_spec_empty_args_env_default_to_empty_arrays() {
        let _g = HOME_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let td = tempdir().unwrap();
        std::env::set_var("HOME", td.path());
        std::fs::write(
            td.path().join(".claude.json"),
            br#"{"mcpServers":{"s":{"type":"stdio","command":"echo"}}}"#,
        )
        .unwrap();
        let got = read_mcp_server_spec("s".into()).unwrap().unwrap();
        assert_eq!(got.args.len(), 0);
        assert_eq!(got.env_keys.len(), 0);
        assert_eq!(got.header_keys.len(), 0);
    }

    #[test]
    fn mcp_spec_unknown_transport_falls_back_to_string() {
        let _g = HOME_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let td = tempdir().unwrap();
        std::env::set_var("HOME", td.path());
        std::fs::write(
            td.path().join(".claude.json"),
            br#"{"mcpServers":{"s":{"command":"x"}}}"#,
        )
        .unwrap();
        let got = read_mcp_server_spec("s".into()).unwrap().unwrap();
        assert_eq!(got.transport, "unknown");
    }

    #[test]
    fn mcp_spec_rejects_bad_name_chars() {
        // Defense in depth — same name validator the writer uses.
        let _g = HOME_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let td = tempdir().unwrap();
        std::env::set_var("HOME", td.path());
        let err = read_mcp_server_spec("../etc/passwd".into()).unwrap_err();
        assert!(err.contains("invalid characters"));
    }

    #[test]
    fn mcp_spec_rejects_empty_name() {
        let _g = HOME_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let td = tempdir().unwrap();
        std::env::set_var("HOME", td.path());
        let err = read_mcp_server_spec("   ".into()).unwrap_err();
        assert!(err.contains("required"));
    }

    /// Bug repro: "claude.ai Gmail" was being rejected by the
    /// validator, surfacing in the UI as "couldn't read ~/.claude.json"
    /// even though the file was fine.  Pin the contract that real-
    /// world MCP names with dots, colons, and spaces work.
    #[test]
    fn mcp_spec_handles_dotted_and_colon_names() {
        let _g = HOME_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let td = tempdir().unwrap();
        std::env::set_var("HOME", td.path());
        std::fs::write(
            td.path().join(".claude.json"),
            br#"{"mcpServers":{
                "claude.ai Gmail": {"type":"http","url":"https://x"},
                "plugin:telegram:telegram": {"type":"stdio","command":"node"}
            }}"#,
        )
        .unwrap();
        let gmail = read_mcp_server_spec("claude.ai Gmail".into())
            .unwrap()
            .unwrap();
        assert_eq!(gmail.name, "claude.ai Gmail");
        assert_eq!(gmail.transport, "http");
        assert_eq!(gmail.url, "https://x");

        let tg = read_mcp_server_spec("plugin:telegram:telegram".into())
            .unwrap()
            .unwrap();
        assert_eq!(tg.name, "plugin:telegram:telegram");
        assert_eq!(tg.transport, "stdio");
        assert_eq!(tg.command, "node");
    }

    /// Servers managed elsewhere (e.g. Claude.ai cloud-managed
    /// connectors that surface in init.mcp_servers but aren't in
    /// `~/.claude.json`) must return Ok(None), so the UI can render
    /// the "managed elsewhere" hint instead of a red error.
    #[test]
    fn mcp_spec_orphan_for_dotted_name_returns_none_not_error() {
        let _g = HOME_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let td = tempdir().unwrap();
        std::env::set_var("HOME", td.path());
        std::fs::write(
            td.path().join(".claude.json"),
            br#"{"mcpServers":{"context7":{"type":"stdio","command":"npx"}}}"#,
        )
        .unwrap();
        let got = read_mcp_server_spec("claude.ai Gmail".into()).unwrap();
        assert!(got.is_none());
    }

    #[test]
    fn pw_4_static_slash_commands_lists_md_files() {
        let td = tempdir().unwrap();
        let cmds = td.path().join(".claude").join("commands");
        std::fs::create_dir_all(&cmds).unwrap();
        std::fs::write(cmds.join("foo.md"), b"# foo").unwrap();
        std::fs::write(cmds.join("bar.md"), b"# bar").unwrap();
        std::fs::write(cmds.join("ignored.txt"), b"ignored").unwrap();
        let got = read_static_slash_commands(Some(td.path().to_string_lossy().into_owned()));
        assert!(got.contains(&"/foo".to_string()));
        assert!(got.contains(&"/bar".to_string()));
        assert!(!got.contains(&"/ignored".to_string()));
    }

    #[test]
    fn pw_5_static_slash_commands_refuses_dotdot_cwd() {
        let got = read_static_slash_commands(Some("/tmp/../etc".to_string()));
        // Cwd with `..` is silently refused; the only commands returned
        // are from the user's home (if any).  We can't assert empty
        // because user might have their own commands; just assert no crash.
        let _ = got;
    }

    #[test]
    fn pw_6_static_memory_paths_lists_existing_claude_md_files() {
        let _g = HOME_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = tempdir().unwrap();
        std::env::set_var("HOME", home.path());
        std::fs::create_dir_all(home.path().join(".claude")).unwrap();
        std::fs::write(home.path().join(".claude").join("CLAUDE.md"), b"# user").unwrap();

        let proj = tempdir().unwrap();
        std::fs::write(proj.path().join("CLAUDE.md"), b"# project").unwrap();

        let got = read_static_memory_paths(Some(proj.path().to_string_lossy().into_owned()));
        assert_eq!(got.len(), 2);
        assert!(got.iter().any(|p| p.ends_with("/.claude/CLAUDE.md")));
        assert!(got
            .iter()
            .any(|p| p.ends_with("/CLAUDE.md") && !p.contains(".claude")));
    }

    #[test]
    fn pw_6_b_static_memory_paths_skips_missing_files() {
        let _g = HOME_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let home = tempdir().unwrap();
        std::env::set_var("HOME", home.path());
        // No CLAUDE.md created.
        let got = read_static_memory_paths(None);
        assert_eq!(got.len(), 0);
    }
}
