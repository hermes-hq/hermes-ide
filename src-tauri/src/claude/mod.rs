pub mod discovery;

#[allow(unused_imports)]
pub use discovery::{
    discover_claude_capabilities, new_discovery_cache, BuiltinCommand, ClaudeCapabilities,
    DiscoveryCacheState, ModelInfo,
};

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use walkdir::WalkDir;

use crate::AppState;

const MAX_WALK_DEPTH: usize = 6;
const DESC_FALLBACK_MAX_CHARS: usize = 80;

// ─── Types ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ClaudeCommand {
    pub command: String,
    pub description: String,
    pub source: String,
    pub body: String,
}

/// Per-session watcher handle. Dropping it stops the OS-level watcher.
pub struct ClaudeCommandsWatcher {
    _watcher: RecommendedWatcher,
    stopped: Arc<AtomicBool>,
}

impl Drop for ClaudeCommandsWatcher {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
    }
}

#[derive(Default)]
pub struct ClaudeCommandsWatcherState {
    pub watchers: HashMap<String, ClaudeCommandsWatcher>,
}

// ─── Helpers ────────────────────────────────────────────────────────

fn session_working_directory(state: &State<'_, AppState>, session_id: &str) -> Result<String, String> {
    let mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
    let pty = mgr
        .sessions
        .get(session_id)
        .ok_or_else(|| "Session not found".to_string())?;
    let session = pty.session.lock().map_err(|e| e.to_string())?;
    Ok(session.working_directory.clone())
}

/// Strip optional YAML frontmatter (`---\n ... \n---\n`) from `raw`.
/// Returns `(description_from_frontmatter, body)`.
fn split_frontmatter(raw: &str) -> (Option<String>, String) {
    let with_lf = raw.replace("\r\n", "\n");
    if !with_lf.starts_with("---\n") {
        return (None, with_lf);
    }
    let after_open = &with_lf[4..];
    let close_idx = match after_open.find("\n---\n") {
        Some(i) => i,
        None => match after_open.strip_suffix("\n---") {
            Some(_) => after_open.len() - 3,
            None => return (None, with_lf),
        },
    };

    let frontmatter = &after_open[..close_idx];
    let body_start = close_idx + "\n---\n".len();
    let body = if body_start <= after_open.len() {
        after_open[body_start.min(after_open.len())..].to_string()
    } else {
        String::new()
    };

    let mut description: Option<String> = None;
    for line in frontmatter.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("description:") {
            let val = rest.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
            if !val.is_empty() {
                description = Some(val);
                break;
            }
        }
    }

    (description, body)
}

fn first_nonempty_line(body: &str) -> String {
    for line in body.lines() {
        let t = line.trim();
        if !t.is_empty() {
            let truncated: String = t.chars().take(DESC_FALLBACK_MAX_CHARS).collect();
            return truncated;
        }
    }
    String::new()
}

fn collect_commands_from(dir: &Path, source_label: &str, out: &mut HashMap<String, ClaudeCommand>) {
    if !dir.is_dir() {
        return;
    }

    for entry in WalkDir::new(dir).max_depth(MAX_WALK_DEPTH).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if !entry.file_type().is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => continue,
        };

        let raw = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let (fm_desc, body) = split_frontmatter(&raw);
        let description = fm_desc.unwrap_or_else(|| first_nonempty_line(&body));

        out.insert(
            stem.clone(),
            ClaudeCommand {
                command: format!("/{}", stem),
                description,
                source: source_label.to_string(),
                body,
            },
        );
    }
}

fn user_commands_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("commands"))
}

fn user_claude_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude"))
}

fn user_settings_path() -> Option<PathBuf> {
    user_claude_dir().map(|d| d.join("settings.json"))
}

fn project_commands_dir(working_directory: &str) -> PathBuf {
    PathBuf::from(working_directory).join(".claude").join("commands")
}

// ─── Tauri Commands ─────────────────────────────────────────────────

/// Merge built-in slash commands into the (project ∪ user) on-disk command
/// map.  Project entries always win, then user, then built-in — so a user
/// override of `/compact` shows their custom file, not the built-in.
fn merge_builtin_commands(
    builtins: Vec<BuiltinCommand>,
    by_name: &mut HashMap<String, ClaudeCommand>,
) {
    for b in builtins {
        // Use the command without the leading "/" as the key, matching the
        // disk-derived entries (which use the .md filename stem).
        let key = b.command.trim_start_matches('/').to_string();
        if key.is_empty() {
            continue;
        }
        // Project / user override built-ins.
        if by_name.contains_key(&key) {
            continue;
        }
        by_name.insert(
            key.clone(),
            ClaudeCommand {
                command: b.command,
                description: b.description,
                source: "builtin".to_string(),
                body: String::new(),
            },
        );
    }
}

#[tauri::command]
pub async fn list_claude_commands(
    state: State<'_, AppState>,
    cache: State<'_, DiscoveryCacheState>,
    session_id: String,
) -> Result<Vec<ClaudeCommand>, String> {
    let working_dir = session_working_directory(&state, &session_id)?;

    let cache_clone = cache.inner().clone();

    // Run discovery (builtins) and on-disk scan in parallel.
    let disk_task = tokio::task::spawn_blocking(move || -> HashMap<String, ClaudeCommand> {
        let mut by_name: HashMap<String, ClaudeCommand> = HashMap::new();
        if let Some(user_dir) = user_commands_dir() {
            collect_commands_from(&user_dir, "user", &mut by_name);
        }
        let proj_dir = project_commands_dir(&working_dir);
        collect_commands_from(&proj_dir, "project", &mut by_name);
        by_name
    });

    let caps_fut = discovery::discover_all(&cache_clone);

    let (disk_result, caps) = tokio::join!(disk_task, caps_fut);
    let mut by_name = disk_result
        .map_err(|e| format!("list_claude_commands disk task panicked: {}", e))?;

    merge_builtin_commands(caps.slash_commands_builtin, &mut by_name);

    let mut commands: Vec<ClaudeCommand> = by_name.into_values().collect();
    commands.sort_by(|a, b| a.command.cmp(&b.command));
    Ok(commands)
}

/// Internal: build the `notify` watcher that emits both
/// `claude-commands-changed` (for command-dir events) and
/// `claude-settings-changed` (for `settings.json` events).  Each event has
/// its own independent 500ms debounce flag so they do not coalesce with one
/// another.
#[tauri::command]
pub async fn start_claude_commands_watcher(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    watchers: State<'_, Mutex<ClaudeCommandsWatcherState>>,
    cache: State<'_, DiscoveryCacheState>,
    session_id: String,
) -> Result<(), String> {
    start_claude_watcher(app_handle, state, watchers, cache, session_id).await
}

/// Watch `~/.claude/commands/`, `<cwd>/.claude/commands/`, and
/// `~/.claude/settings.json` for changes for this session.  Idempotent.
///
/// On a commands-dir event, emits `claude-commands-changed` debounced by
/// 500ms.  On a settings.json event, emits `claude-settings-changed` debounced
/// by 500ms and invalidates the discovery cache so the frontend's next
/// capability fetch re-reads the file.
#[tauri::command]
pub async fn start_claude_watcher(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    watchers: State<'_, Mutex<ClaudeCommandsWatcherState>>,
    cache: State<'_, DiscoveryCacheState>,
    session_id: String,
) -> Result<(), String> {
    let working_dir = session_working_directory(&state, &session_id)?;

    {
        let map = watchers.lock().unwrap_or_else(|e| e.into_inner());
        if map.watchers.contains_key(&session_id) {
            return Ok(());
        }
    }

    let stopped = Arc::new(AtomicBool::new(false));
    let stopped_cb = Arc::clone(&stopped);
    // Independent debounce flags for the two event streams.
    let cmd_pending = Arc::new(AtomicBool::new(false));
    let settings_pending = Arc::new(AtomicBool::new(false));

    let app_emit = app_handle.clone();
    let session_for_callback = session_id.clone();
    let cache_handle = cache.inner().clone();

    let settings_path = user_settings_path();

    let mut watcher = match notify::recommended_watcher(
        move |result: Result<notify::Event, notify::Error>| {
            if stopped_cb.load(Ordering::SeqCst) {
                return;
            }
            let event = match result {
                Ok(ev) => ev,
                Err(e) => {
                    log::warn!("[claude-watcher] watch error: {}", e);
                    return;
                }
            };

            // Categorise: did any path in the event hit settings.json?
            let touches_settings = settings_path
                .as_ref()
                .map(|sp| event.paths.iter().any(|p| p == sp))
                .unwrap_or(false);

            // We always assume command dirs may have changed unless the only
            // touched path was settings.json.  This is conservative — false
            // positives just trigger one extra debounced re-list, which is
            // cheap.
            let touches_commands = if touches_settings {
                event.paths.iter().any(|p| {
                    settings_path.as_ref().map(|sp| p != sp).unwrap_or(true)
                })
            } else {
                true
            };

            if touches_commands && !cmd_pending.swap(true, Ordering::SeqCst) {
                let cmd_pending_inner = Arc::clone(&cmd_pending);
                let session_inner = session_for_callback.clone();
                let app_inner = app_emit.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    cmd_pending_inner.store(false, Ordering::SeqCst);
                    let payload = serde_json::json!({ "session_id": session_inner });
                    if let Err(e) = app_inner.emit("claude-commands-changed", &payload) {
                        log::warn!("[claude-watcher] failed to emit commands event: {}", e);
                    }
                });
            }

            if touches_settings && !settings_pending.swap(true, Ordering::SeqCst) {
                let settings_pending_inner = Arc::clone(&settings_pending);
                let session_inner = session_for_callback.clone();
                let app_inner = app_emit.clone();
                let cache_inner = cache_handle.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    settings_pending_inner.store(false, Ordering::SeqCst);
                    // Invalidate the discovery cache so the frontend's next
                    // discoverClaudeCapabilities call re-reads settings.json.
                    discovery::invalidate_cache(&cache_inner).await;
                    let payload = serde_json::json!({ "session_id": session_inner });
                    if let Err(e) = app_inner.emit("claude-settings-changed", &payload) {
                        log::warn!("[claude-watcher] failed to emit settings event: {}", e);
                    }
                });
            }
        },
    ) {
        Ok(w) => w,
        Err(e) => return Err(format!("Failed to create watcher: {}", e)),
    };

    let mut watched_any = false;

    if let Some(user_dir) = user_commands_dir() {
        if user_dir.is_dir() {
            match watcher.watch(&user_dir, RecursiveMode::Recursive) {
                Ok(()) => {
                    watched_any = true;
                    log::info!("[claude-watcher] watching {}", user_dir.display());
                }
                Err(e) => log::warn!(
                    "[claude-watcher] failed to watch {}: {}",
                    user_dir.display(),
                    e
                ),
            }
        }
    }

    let proj_dir = project_commands_dir(&working_dir);
    if proj_dir.is_dir() {
        match watcher.watch(&proj_dir, RecursiveMode::Recursive) {
            Ok(()) => {
                watched_any = true;
                log::info!("[claude-watcher] watching {}", proj_dir.display());
            }
            Err(e) => log::warn!(
                "[claude-watcher] failed to watch {}: {}",
                proj_dir.display(),
                e
            ),
        }
    }

    // Watch ~/.claude/ non-recursively for settings.json changes.  We watch
    // the parent dir (rather than the file directly) so editor "atomic save"
    // sequences (write to temp + rename) are still observed.
    if let Some(claude_dir) = user_claude_dir() {
        if claude_dir.is_dir() {
            match watcher.watch(&claude_dir, RecursiveMode::NonRecursive) {
                Ok(()) => {
                    watched_any = true;
                    log::info!(
                        "[claude-watcher] watching {} (non-recursive, for settings.json)",
                        claude_dir.display()
                    );
                }
                Err(e) => log::warn!(
                    "[claude-watcher] failed to watch {}: {}",
                    claude_dir.display(),
                    e
                ),
            }
        }
    }

    let _ = watched_any;

    let mut map = watchers.lock().unwrap_or_else(|e| e.into_inner());
    map.watchers.insert(
        session_id,
        ClaudeCommandsWatcher {
            _watcher: watcher,
            stopped,
        },
    );

    Ok(())
}

#[tauri::command]
pub async fn stop_claude_commands_watcher(
    watchers: State<'_, Mutex<ClaudeCommandsWatcherState>>,
    session_id: String,
) -> Result<(), String> {
    stop_claude_watcher(watchers, session_id).await
}

#[tauri::command]
pub async fn stop_claude_watcher(
    watchers: State<'_, Mutex<ClaudeCommandsWatcherState>>,
    session_id: String,
) -> Result<(), String> {
    let mut map = watchers.lock().unwrap_or_else(|e| e.into_inner());
    map.watchers.remove(&session_id);
    Ok(())
}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn frontmatter_with_description() {
        let raw = "---\ndescription: Refactor a function\n---\nBody starts here\n";
        let (desc, body) = split_frontmatter(raw);
        assert_eq!(desc.as_deref(), Some("Refactor a function"));
        assert_eq!(body, "Body starts here\n");
    }

    #[test]
    fn frontmatter_with_quoted_description() {
        let raw = "---\ndescription: \"Quoted desc\"\nother: x\n---\nBody\n";
        let (desc, body) = split_frontmatter(raw);
        assert_eq!(desc.as_deref(), Some("Quoted desc"));
        assert_eq!(body, "Body\n");
    }

    #[test]
    fn no_frontmatter_returns_full_body() {
        let raw = "Just a body\nwith multiple lines\n";
        let (desc, body) = split_frontmatter(raw);
        assert!(desc.is_none());
        assert_eq!(body, raw);
    }

    #[test]
    fn first_line_fallback_truncates() {
        let long = "x".repeat(200);
        let body = format!("\n\n{}\n", long);
        let first = first_nonempty_line(&body);
        assert_eq!(first.chars().count(), DESC_FALLBACK_MAX_CHARS);
    }

    #[test]
    fn collect_md_files_become_commands() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            tmp.path().join("refactor.md"),
            "---\ndescription: Refactor selected code\n---\nDo the refactor\n",
        )
        .unwrap();
        fs::write(tmp.path().join("plain.md"), "First line of plain\nrest\n").unwrap();
        fs::write(tmp.path().join("ignored.txt"), "not a command").unwrap();

        let mut out: HashMap<String, ClaudeCommand> = HashMap::new();
        collect_commands_from(tmp.path(), "user", &mut out);

        assert_eq!(out.len(), 2);
        let refactor = out.get("refactor").unwrap();
        assert_eq!(refactor.command, "/refactor");
        assert_eq!(refactor.description, "Refactor selected code");
        assert_eq!(refactor.source, "user");
        assert!(refactor.body.contains("Do the refactor"));

        let plain = out.get("plain").unwrap();
        assert_eq!(plain.description, "First line of plain");
    }

    #[test]
    fn project_overrides_user_for_same_name() {
        let user = TempDir::new().unwrap();
        let proj = TempDir::new().unwrap();
        fs::write(user.path().join("refactor.md"), "---\ndescription: USER\n---\nU\n").unwrap();
        fs::write(proj.path().join("refactor.md"), "---\ndescription: PROJECT\n---\nP\n").unwrap();

        let mut out: HashMap<String, ClaudeCommand> = HashMap::new();
        collect_commands_from(user.path(), "user", &mut out);
        collect_commands_from(proj.path(), "project", &mut out);

        let r = out.get("refactor").unwrap();
        assert_eq!(r.source, "project");
        assert_eq!(r.description, "PROJECT");
    }

    #[test]
    fn builtins_added_when_no_disk_override() {
        let mut out: HashMap<String, ClaudeCommand> = HashMap::new();
        let builtins = vec![
            BuiltinCommand {
                command: "/compact".to_string(),
                description: "Compact transcript".to_string(),
            },
            BuiltinCommand {
                command: "/help".to_string(),
                description: "Show help".to_string(),
            },
        ];
        merge_builtin_commands(builtins, &mut out);
        assert_eq!(out.len(), 2);
        assert_eq!(out.get("compact").unwrap().source, "builtin");
        assert_eq!(out.get("help").unwrap().description, "Show help");
    }

    #[test]
    fn user_overrides_builtin_for_same_name() {
        let user_dir = TempDir::new().unwrap();
        fs::write(
            user_dir.path().join("compact.md"),
            "---\ndescription: My custom compact\n---\nbody\n",
        )
        .unwrap();

        let mut out: HashMap<String, ClaudeCommand> = HashMap::new();
        collect_commands_from(user_dir.path(), "user", &mut out);
        merge_builtin_commands(
            vec![BuiltinCommand {
                command: "/compact".to_string(),
                description: "Built-in compact".to_string(),
            }],
            &mut out,
        );

        let entry = out.get("compact").unwrap();
        assert_eq!(entry.source, "user");
        assert_eq!(entry.description, "My custom compact");
    }

    #[test]
    fn project_overrides_builtin() {
        let proj_dir = TempDir::new().unwrap();
        fs::write(proj_dir.path().join("help.md"), "Project help body\n").unwrap();

        let mut out: HashMap<String, ClaudeCommand> = HashMap::new();
        collect_commands_from(proj_dir.path(), "project", &mut out);
        merge_builtin_commands(
            vec![BuiltinCommand {
                command: "/help".to_string(),
                description: "Built-in".to_string(),
            }],
            &mut out,
        );

        assert_eq!(out.get("help").unwrap().source, "project");
    }
}
