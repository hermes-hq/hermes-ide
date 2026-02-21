use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplyContextResult {
    pub version: i64,
    pub content: String,
    pub file_path: String,
    pub nudge_sent: bool,
    pub nudge_error: Option<String>,
    pub estimated_tokens: usize,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryContext {
    pub key: String,
    pub value: String,
    pub source: String,
}

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
    pub context_version: i64,
}

/// Assemble a context blob for a session's attached realms.
/// Now includes pins, memory facts, and error resolutions.
/// Token-aware: estimates tokens per section, trims to budget.
pub fn assemble_context(
    db: &crate::db::Database,
    session_id: &str,
    token_budget: usize,
) -> Result<SessionContext, String> {
    let realms = db.get_session_realms(session_id)?;

    let mut realm_contexts = Vec::new();
    let mut all_conventions = Vec::new();
    let mut all_languages = Vec::new();
    let mut all_frameworks = Vec::new();
    let mut estimated_tokens: usize = 0;

    for realm in &realms {
        // Get conventions from the dedicated table (higher fidelity)
        let db_conventions = db.get_conventions(&realm.id)?;
        let conv_rules: Vec<String> = if !db_conventions.is_empty() {
            db_conventions.iter().map(|c| c.rule.clone()).collect()
        } else {
            realm.conventions.iter().map(|c| c.rule.clone()).collect()
        };

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
        // Keep first realm (primary) intact, trim secondary realms' conventions
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

    // Fetch context pins for this session
    let pins_raw = db.get_context_pins(Some(session_id), None).unwrap_or_default();
    let pins: Vec<PinContext> = pins_raw.iter().map(|p| PinContext {
        kind: p.kind.clone(),
        target: p.target.clone(),
        label: p.label.clone(),
    }).collect();
    estimated_tokens += pins.iter().map(|p| p.target.len() / 4 + 5).sum::<usize>();

    // Fetch persisted memory
    let memory_raw = db.get_all_memory_entries("global", "global").unwrap_or_default();
    let memory: Vec<MemoryContext> = memory_raw.iter().map(|m| MemoryContext {
        key: m.key.clone(),
        value: m.value.clone(),
        source: m.source.clone(),
    }).collect();
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

    // Projects
    if !context.realms.is_empty() {
        md.push_str("## Projects\n\n");
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

    // Pinned Context
    if !context.pins.is_empty() {
        md.push_str("## Pinned Context\n\n");
        for pin in &context.pins {
            let label = pin.label.as_deref().unwrap_or(&pin.target);
            md.push_str(&format!("- [{}] {}\n", pin.kind, label));
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
/// If the session has no realms attached and no pins/memory, deletes the context file.
/// Returns the path to the context file.
pub fn write_session_context_file(
    app: &AppHandle,
    db: &crate::db::Database,
    session_id: &str,
) -> Result<PathBuf, String> {
    let context = assemble_context(db, session_id, 4000)?;
    let path = session_context_path(app, session_id)?;

    let has_content = !context.realms.is_empty()
        || !context.pins.is_empty()
        || !context.memory.is_empty()
        || !context.error_resolutions.is_empty();

    if !has_content {
        // Nothing to write — remove the file if it exists
        let _ = std::fs::remove_file(&path);
        return Ok(path);
    }

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create context dir: {}", e))?;
    }

    let markdown = format_context_markdown(&context, None);

    // Atomic write: write to .tmp then rename
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
    assemble_context(&db, &session_id, token_budget.unwrap_or(4000))
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
    let mut context = assemble_context(&db, &session_id, 4000)?;

    // 2. Increment version: max existing + 1
    let snapshots = db.get_context_snapshots(&session_id).unwrap_or_default();
    let new_version = snapshots.first().map(|s| s.version).unwrap_or(0) + 1;
    context.context_version = new_version;

    // 3. Format markdown with execution mode
    let markdown = format_context_markdown(&context, execution_mode.as_deref());
    let estimated_tokens = context.estimated_tokens;

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
    })
}
