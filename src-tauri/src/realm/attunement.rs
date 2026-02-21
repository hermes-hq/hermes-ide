use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::AppState;

/// Default token budget when no project config overrides it
const DEFAULT_TOKEN_BUDGET: usize = 4000;

// ─── .hermes/context.json Schema ─────────────────────────────────────

/// .hermes/context.json schema for project-level defaults
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HermesProjectConfig {
    /// Default files to pin for this project
    #[serde(default)]
    pub pins: Vec<HermesPin>,
    /// Project-level memory facts (key-value)
    #[serde(default)]
    pub memory: Vec<HermesMemory>,
    /// Human-authored conventions that override auto-detected
    #[serde(default)]
    pub conventions: Vec<String>,
    /// Token budget override (default: DEFAULT_TOKEN_BUDGET)
    #[serde(default)]
    pub token_budget: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HermesPin {
    pub kind: String,
    pub target: String,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HermesMemory {
    pub key: String,
    pub value: String,
}

/// Load .hermes/context.json from a project directory
pub fn load_hermes_config(project_path: &str) -> Option<HermesProjectConfig> {
    let config_path = Path::new(project_path).join(".hermes").join("context.json");
    if !config_path.exists() {
        return None;
    }
    match std::fs::read_to_string(&config_path) {
        Ok(content) => serde_json::from_str(&content).ok(),
        Err(_) => None,
    }
}

// ─── File Content for Pins ───────────────────────────────────────────

/// Read file content for a pinned file, respecting a per-file byte limit
fn read_pin_file_content(target: &str, max_bytes: usize) -> Option<String> {
    let path = Path::new(target);
    if !path.exists() || !path.is_file() {
        return None;
    }
    // Skip binary files
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let binary_exts = ["png", "jpg", "jpeg", "gif", "ico", "woff", "woff2", "ttf", "eot",
                        "zip", "tar", "gz", "bz2", "7z", "exe", "dll", "so", "dylib",
                        "pdf", "mp3", "mp4", "wav", "avi", "mov", "sqlite", "db"];
    if binary_exts.contains(&ext.to_lowercase().as_str()) {
        return None;
    }
    match std::fs::read_to_string(path) {
        Ok(content) => {
            if content.len() > max_bytes {
                let mut end = max_bytes;
                while end < content.len() && !content.is_char_boundary(end) {
                    end += 1;
                }
                Some(format!("{}...\n[truncated at {} bytes]", &content[..end.min(content.len())], max_bytes))
            } else {
                Some(content)
            }
        }
        Err(_) => None,
    }
}

// ─── Context Assembly Types ──────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplyContextResult {
    pub version: i64,
    pub content: String,
    pub file_path: String,
    pub nudge_sent: bool,
    pub nudge_error: Option<String>,
    pub estimated_tokens: usize,
    pub token_budget: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RealmContext {
    pub realm_id: String,
    pub realm_name: String,
    pub path: String,
    pub languages: Vec<String>,
    pub frameworks: Vec<String>,
    pub architecture_pattern: Option<String>,
    pub architecture_layers: Vec<String>,
    pub conventions: Vec<String>,
    pub scan_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PinContext {
    pub kind: String,
    pub target: String,
    pub label: Option<String>,
    /// File content (populated for kind="file" when the file is readable)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// Whether this is a project-level pin (shared across sessions)
    #[serde(default)]
    pub is_project_pin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryContext {
    pub key: String,
    pub value: String,
    pub source: String,
    /// Memory scope: "global", "project", or "session"
    #[serde(default = "default_scope")]
    pub scope: String,
}

fn default_scope() -> String { "global".to_string() }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorContext {
    pub fingerprint: String,
    pub resolution: String,
    pub occurrence_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionContext {
    pub realms: Vec<RealmContext>,
    pub pins: Vec<PinContext>,
    pub memory: Vec<MemoryContext>,
    pub error_resolutions: Vec<ErrorContext>,
    pub combined_conventions: Vec<String>,
    pub combined_languages: Vec<String>,
    pub combined_frameworks: Vec<String>,
    pub estimated_tokens: usize,
    pub token_budget: usize,
    pub context_version: i64,
}

/// Assemble a context blob for a session's attached realms.
/// Includes: realm info, pins (with file content), memory (project + global),
/// error resolutions, and .hermes/context.json overrides.
/// Token-aware: estimates tokens per section, trims to budget.
pub fn assemble_context(
    db: &crate::db::Database,
    session_id: &str,
    default_token_budget: usize,
) -> Result<SessionContext, String> {
    let realms = db.get_session_realms(session_id)?;

    let mut realm_contexts = Vec::new();
    let mut all_conventions = Vec::new();
    let mut all_languages = Vec::new();
    let mut all_frameworks = Vec::new();
    let mut estimated_tokens: usize = 0;
    let mut hermes_configs: Vec<HermesProjectConfig> = Vec::new();

    // Determine token budget (may be overridden by .hermes/context.json)
    let mut token_budget = default_token_budget;

    for realm in &realms {
        // Load .hermes/context.json if present
        if let Some(config) = load_hermes_config(&realm.path) {
            if let Some(budget) = config.token_budget {
                token_budget = budget;
            }
            hermes_configs.push(config);
        }

        // Get conventions from the dedicated table (higher fidelity)
        let db_conventions = db.get_conventions(&realm.id)?;
        let mut conv_rules: Vec<String> = if !db_conventions.is_empty() {
            db_conventions.iter().map(|c| c.rule.clone()).collect()
        } else {
            realm.conventions.iter().map(|c| c.rule.clone()).collect()
        };

        // Merge .hermes conventions (human-authored take priority)
        for config in &hermes_configs {
            for conv in &config.conventions {
                if !conv_rules.contains(conv) {
                    conv_rules.insert(0, conv.clone()); // prepend (higher priority)
                }
            }
        }

        let arch_pattern = realm.architecture.as_ref().map(|a| a.pattern.clone());
        let arch_layers = realm.architecture.as_ref()
            .map(|a| a.layers.clone())
            .unwrap_or_default();

        // Collect unique values
        for lang in &realm.languages {
            if !all_languages.contains(lang) {
                all_languages.push(lang.clone());
            }
        }
        for fw in &realm.frameworks {
            if !all_frameworks.contains(fw) {
                all_frameworks.push(fw.clone());
            }
        }
        for conv in &conv_rules {
            if !all_conventions.contains(conv) {
                all_conventions.push(conv.clone());
            }
        }

        // Estimate tokens: ~4 chars per token
        let realm_token_est =
            realm.name.len() / 4
            + realm.path.len() / 4
            + realm.languages.iter().map(|l| l.len() / 4 + 1).sum::<usize>()
            + realm.frameworks.iter().map(|f| f.len() / 4 + 1).sum::<usize>()
            + arch_pattern.as_ref().map(|p| p.len() / 4 + 5).unwrap_or(0)
            + arch_layers.iter().map(|l| l.len() / 4 + 1).sum::<usize>()
            + conv_rules.iter().map(|c| c.len() / 4 + 1).sum::<usize>()
            + 20; // overhead

        estimated_tokens += realm_token_est;

        realm_contexts.push(RealmContext {
            realm_id: realm.id.clone(),
            realm_name: realm.name.clone(),
            path: realm.path.clone(),
            languages: realm.languages.clone(),
            frameworks: realm.frameworks.clone(),
            architecture_pattern: arch_pattern,
            architecture_layers: arch_layers,
            conventions: conv_rules,
            scan_status: realm.scan_status.clone(),
        });
    }

    // Trim if over budget — remove conventions from least-important realms first
    if estimated_tokens > token_budget && realm_contexts.len() > 1 {
        for ctx in realm_contexts.iter_mut().skip(1) {
            let conv_tokens: usize = ctx.conventions.iter().map(|c| c.len() / 4 + 1).sum();
            if estimated_tokens - conv_tokens < token_budget {
                let keep = (ctx.conventions.len() * token_budget) / estimated_tokens;
                ctx.conventions.truncate(keep.max(2));
                break;
            } else {
                estimated_tokens -= conv_tokens;
                ctx.conventions.clear();
            }
        }
    }

    // Fetch context pins — session-scoped + project-scoped (shared across sessions)
    let realm_ids: Vec<String> = realms.iter().map(|r| r.id.clone()).collect();
    let primary_realm_id = realm_ids.first().cloned();

    let mut pins_raw = db.get_context_pins(Some(session_id), primary_realm_id.as_deref()).unwrap_or_default();

    // Add pins from .hermes/context.json (project defaults)
    for config in &hermes_configs {
        for hermes_pin in &config.pins {
            // Avoid duplicates
            if !pins_raw.iter().any(|p| p.target == hermes_pin.target && p.kind == hermes_pin.kind) {
                pins_raw.push(crate::db::ContextPin {
                    id: 0, // synthetic
                    session_id: None,
                    project_id: primary_realm_id.clone(),
                    kind: hermes_pin.kind.clone(),
                    target: hermes_pin.target.clone(),
                    label: hermes_pin.label.clone(),
                    priority: 256, // higher than default
                    created_at: 0,
                });
            }
        }
    }

    // Build pin contexts with file content
    let per_file_budget = 8192; // ~2k tokens per file
    let mut pins: Vec<PinContext> = Vec::new();
    for p in &pins_raw {
        let content = if p.kind == "file" {
            read_pin_file_content(&p.target, per_file_budget)
        } else {
            None
        };
        let content_tokens = content.as_ref().map(|c| c.len() / 4).unwrap_or(0);
        estimated_tokens += p.target.len() / 4 + 5 + content_tokens;

        pins.push(PinContext {
            kind: p.kind.clone(),
            target: p.target.clone(),
            label: p.label.clone(),
            content,
            is_project_pin: p.session_id.is_none(),
        });
    }

    // Fetch merged memory: project-scoped → global (project takes precedence)
    let memory_raw = db.get_merged_memory(&realm_ids).unwrap_or_default();
    let mut memory: Vec<MemoryContext> = memory_raw.iter().map(|m| MemoryContext {
        key: m.key.clone(),
        value: m.value.clone(),
        source: m.source.clone(),
        scope: m.scope.clone(),
    }).collect();

    // Add memory from .hermes/context.json
    let mut seen_memory_keys: std::collections::HashSet<String> = memory.iter().map(|m| m.key.clone()).collect();
    for config in &hermes_configs {
        for hm in &config.memory {
            if seen_memory_keys.insert(hm.key.clone()) {
                memory.push(MemoryContext {
                    key: hm.key.clone(),
                    value: hm.value.clone(),
                    source: "hermes-config".to_string(),
                    scope: "project".to_string(),
                });
            }
        }
    }

    estimated_tokens += memory.iter().map(|m| (m.key.len() + m.value.len()) / 4 + 3).sum::<usize>();

    // Fetch error resolutions
    let errors_raw = db.get_error_resolutions_for_context(session_id).unwrap_or_default();
    let error_resolutions: Vec<ErrorContext> = errors_raw.iter().map(|e| ErrorContext {
        fingerprint: e.0.clone(),
        resolution: e.1.clone(),
        occurrence_count: e.2,
    }).collect();
    estimated_tokens += error_resolutions.iter().map(|e| (e.fingerprint.len() + e.resolution.len()) / 4 + 5).sum::<usize>();

    // Get latest context version
    let snapshots = db.get_context_snapshots(session_id).unwrap_or_default();
    let context_version = snapshots.first().map(|s| s.version).unwrap_or(0);

    Ok(SessionContext {
        realms: realm_contexts,
        pins,
        memory,
        error_resolutions,
        combined_conventions: all_conventions,
        combined_languages: all_languages,
        combined_frameworks: all_frameworks,
        estimated_tokens,
        token_budget,
        context_version,
    })
}

// ─── Context File Functions ──────────────────────────────────────────

/// Compute the deterministic path for a session's context file (no I/O).
pub fn session_context_path(app: &AppHandle, session_id: &str) -> Result<PathBuf, String> {
    let app_dir = app.path().app_data_dir().map_err(|e| format!("Failed to get app data dir: {}", e))?;
    Ok(app_dir.join("context").join(format!("{}.md", session_id)))
}

/// Format a SessionContext as a markdown string for AI agents to read.
fn format_context_markdown(context: &SessionContext, execution_mode: Option<&str>) -> String {
    let mut md = String::new();
    md.push_str(&format!("# Session Context (v{})\n\n", context.context_version));

    // Execution Mode
    if let Some(mode) = execution_mode {
        md.push_str(&format!("- Mode: {}\n", mode));
    }

    // Token budget info
    md.push_str(&format!("- Token budget: ~{} / {} used\n", context.estimated_tokens, context.token_budget));

    // Projects
    if !context.realms.is_empty() {
        md.push_str("\n## Projects\n\n");
        for realm in &context.realms {
            md.push_str(&format!("### {} ({})\n", realm.realm_name, realm.path));
            if !realm.languages.is_empty() {
                md.push_str(&format!("- Languages: {}\n", realm.languages.join(", ")));
            }
            if !realm.frameworks.is_empty() {
                md.push_str(&format!("- Frameworks: {}\n", realm.frameworks.join(", ")));
            }
            if let Some(ref arch) = realm.architecture_pattern {
                md.push_str(&format!("- Architecture: {}\n", arch));
            }
            if !realm.conventions.is_empty() {
                md.push_str(&format!("- Conventions: {}\n", realm.conventions.join("; ")));
            }
            md.push('\n');
        }
    }

    // Pinned Context (with file content)
    if !context.pins.is_empty() {
        md.push_str("## Pinned Context\n\n");
        for pin in &context.pins {
            let label = pin.label.as_deref().unwrap_or(&pin.target);
            let scope_tag = if pin.is_project_pin { " (project)" } else { "" };
            md.push_str(&format!("- [{}] {}{}\n", pin.kind, label, scope_tag));
            if let Some(ref content) = pin.content {
                md.push_str(&format!("\n```\n{}\n```\n\n", content));
            }
        }
        md.push('\n');
    }

    // Memory
    if !context.memory.is_empty() {
        md.push_str("## Memory\n\n");
        for m in &context.memory {
            md.push_str(&format!("- {} = {}\n", m.key, m.value));
        }
        md.push('\n');
    }

    // Error Resolutions
    if !context.error_resolutions.is_empty() {
        md.push_str("## Known Error Resolutions\n\n");
        for er in &context.error_resolutions {
            md.push_str(&format!("- \"{}\" -> {} (seen {}x)\n", er.fingerprint, er.resolution, er.occurrence_count));
        }
        md.push('\n');
    }

    // Summary
    if !context.combined_languages.is_empty() || !context.combined_frameworks.is_empty() {
        md.push_str("## Summary\n");
        if !context.combined_languages.is_empty() {
            md.push_str(&format!("- All Languages: {}\n", context.combined_languages.join(", ")));
        }
        if !context.combined_frameworks.is_empty() {
            md.push_str(&format!("- All Frameworks: {}\n", context.combined_frameworks.join(", ")));
        }
    }

    md
}

/// Assemble context and write it atomically to disk.
pub fn write_session_context_file(
    app: &AppHandle,
    db: &crate::db::Database,
    session_id: &str,
) -> Result<PathBuf, String> {
    let context = assemble_context(db, session_id, DEFAULT_TOKEN_BUDGET)?;
    let path = session_context_path(app, session_id)?;

    let has_content = !context.realms.is_empty()
        || !context.pins.is_empty()
        || !context.memory.is_empty()
        || !context.error_resolutions.is_empty();

    if !has_content {
        let _ = std::fs::remove_file(&path);
        return Ok(path);
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create context dir: {}", e))?;
    }

    let markdown = format_context_markdown(&context, None);

    let tmp_path = path.with_extension("md.tmp");
    std::fs::write(&tmp_path, markdown.as_bytes())
        .map_err(|e| format!("Failed to write context tmp file: {}", e))?;
    std::fs::rename(&tmp_path, &path)
        .map_err(|e| format!("Failed to rename context file: {}", e))?;

    Ok(path)
}

/// Delete the context file for a session (used on session close).
pub fn delete_session_context_file(app: &AppHandle, session_id: &str) {
    if let Ok(path) = session_context_path(app, session_id) {
        let _ = std::fs::remove_file(&path);
    }
}

// ─── IPC Commands ────────────────────────────────────────────────────

#[tauri::command]
pub fn assemble_session_context(
    state: State<'_, AppState>,
    session_id: String,
    token_budget: Option<usize>,
) -> Result<SessionContext, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    assemble_context(&db, &session_id, token_budget.unwrap_or(DEFAULT_TOKEN_BUDGET))
}

#[tauri::command]
pub fn apply_context(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: String,
    execution_mode: Option<String>,
) -> Result<ApplyContextResult, String> {
    // 1. Assemble context from DB
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut context = assemble_context(&db, &session_id, DEFAULT_TOKEN_BUDGET)?;

    // 2. Increment version: max existing + 1
    let snapshots = db.get_context_snapshots(&session_id).unwrap_or_default();
    let new_version = snapshots.first().map(|s| s.version).unwrap_or(0) + 1;
    context.context_version = new_version;

    // 3. Format markdown with execution mode
    let markdown = format_context_markdown(&context, execution_mode.as_deref());
    let estimated_tokens = context.estimated_tokens;
    let budget = context.token_budget;

    // 4. Write file atomically
    let path = session_context_path(&app, &session_id)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create context dir: {}", e))?;
    }
    let tmp_path = path.with_extension("md.tmp");
    std::fs::write(&tmp_path, markdown.as_bytes())
        .map_err(|e| format!("Failed to write context tmp file: {}", e))?;
    std::fs::rename(&tmp_path, &path)
        .map_err(|e| format!("Failed to rename context file: {}", e))?;

    // 5. Save snapshot to DB
    let context_json = serde_json::to_string(&context).unwrap_or_default();
    db.save_context_snapshot(&session_id, new_version, &context_json)?;

    let file_path = path.to_string_lossy().to_string();

    // 6. Drop DB lock before accessing PTY manager
    drop(db);

    // 7. Send versioned nudge to PTY via PtyManager public method
    let mgr = state.pty_manager.lock().map_err(|e| e.to_string())?;
    let (nudge_sent, nudge_error) = mgr.send_versioned_nudge(&session_id, new_version, &file_path);

    Ok(ApplyContextResult {
        version: new_version,
        content: markdown,
        file_path,
        nudge_sent,
        nudge_error,
        estimated_tokens,
        token_budget: budget,
    })
}

/// Fork context from one session to another (called during session creation)
#[tauri::command]
pub fn fork_session_context(
    state: State<'_, AppState>,
    source_session_id: String,
    target_session_id: String,
) -> Result<usize, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.fork_context_pins(&source_session_id, &target_session_id)
}

/// Load and apply .hermes/context.json for a realm, creating project-scoped
/// pins and memory entries in the database.
#[tauri::command]
pub fn load_hermes_project_config(
    state: State<'_, AppState>,
    realm_id: String,
    realm_path: String,
) -> Result<Option<HermesProjectConfig>, String> {
    let config = match load_hermes_config(&realm_path) {
        Some(c) => c,
        None => return Ok(None),
    };

    let config_json = serde_json::to_string(&config).unwrap_or_default();
    let config_hash = format!("{:x}", md5_simple(&config_json));

    let db = state.db.lock().map_err(|e| e.to_string())?;

    // Check if config has changed since last load
    if let Ok(Some((_, Some(existing_hash)))) = db.get_hermes_config(&realm_id) {
        if existing_hash == config_hash {
            return Ok(Some(config));
        }
    }

    // Apply pins as project-scoped
    for pin in &config.pins {
        let _ = db.add_context_pin(
            None, // session_id = null → project-scoped
            Some(&realm_id),
            &pin.kind,
            &pin.target,
            pin.label.as_deref(),
            Some(256), // higher priority for project defaults
        );
    }

    // Apply memory as project-scoped
    for mem in &config.memory {
        let _ = db.save_memory_entry(
            "project", &realm_id,
            &mem.key, &mem.value,
            "hermes-config", "config", 1.0,
        );
    }

    // Save config hash
    let _ = db.save_hermes_config(&realm_id, &config_json, &config_hash);

    Ok(Some(config))
}

/// Simple hash function for config change detection
fn md5_simple(input: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input.bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}
