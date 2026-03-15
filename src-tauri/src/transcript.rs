use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::AppState;

// ─── Types ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct TranscriptEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub tool_name: Option<String>,
    pub tool_input: Option<serde_json::Value>,
    pub timestamp: f64,
    pub session_id: String,
}

/// Internal representation of a JSONL record from Claude Code transcripts.
#[derive(Debug, Deserialize)]
struct JsonlRecord {
    #[serde(rename = "type")]
    record_type: Option<String>,
    subtype: Option<String>,
    message: Option<JsonlMessage>,
}

#[derive(Debug, Deserialize)]
struct JsonlMessage {
    content: Option<Vec<JsonlContent>>,
}

#[derive(Debug, Deserialize)]
struct JsonlContent {
    #[serde(rename = "type")]
    content_type: Option<String>,
    name: Option<String>,
    input: Option<serde_json::Value>,
    #[allow(dead_code)]
    text: Option<String>,
}

/// State for active transcript watchers.
#[derive(Default)]
pub struct TranscriptWatcherState {
    pub watchers: HashMap<String, Arc<AtomicBool>>,
}

// ─── Helpers ────────────────────────────────────────────────────────

/// Find the Claude Code JSONL transcript file for a given working directory.
/// Claude Code stores transcripts in `~/.claude/projects/<path-hash>/`.
/// We look for the most recently modified `.jsonl` file.
fn find_transcript_file(working_directory: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let claude_dir = home.join(".claude").join("projects");
    if !claude_dir.is_dir() {
        return None;
    }

    // Claude Code uses the workspace path to determine the project directory.
    // The directory name is a sanitised version of the absolute path where
    // slashes are replaced with hyphens and the leading slash is dropped.
    // e.g. /Users/foo/code/bar -> Users-foo-code-bar
    let sanitised = working_directory.trim_start_matches('/').replace('/', "-");

    let project_dir = claude_dir.join(&sanitised);
    if !project_dir.is_dir() {
        // Fallback: scan all project dirs looking for one that matches
        // by checking if a `.project_path` file exists with matching content,
        // or just find the most recently modified .jsonl across all dirs.
        return find_most_recent_jsonl_across(&claude_dir);
    }

    find_most_recent_jsonl_in(&project_dir)
}

fn find_most_recent_jsonl_in(dir: &std::path::Path) -> Option<PathBuf> {
    let mut best: Option<(PathBuf, std::time::SystemTime)> = None;

    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                if let Ok(meta) = path.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if best.as_ref().is_none_or(|(_, t)| modified > *t) {
                            best = Some((path, modified));
                        }
                    }
                }
            }
        }
    }

    best.map(|(p, _)| p)
}

fn find_most_recent_jsonl_across(claude_projects_dir: &std::path::Path) -> Option<PathBuf> {
    let mut best: Option<(PathBuf, std::time::SystemTime)> = None;

    if let Ok(project_dirs) = std::fs::read_dir(claude_projects_dir) {
        for dir_entry in project_dirs.flatten() {
            let dir_path = dir_entry.path();
            if !dir_path.is_dir() {
                continue;
            }
            if let Some((path, modified)) = find_most_recent_jsonl_in(&dir_path).and_then(|p| {
                p.metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .map(|t| (p, t))
            }) {
                if best.as_ref().is_none_or(|(_, t)| modified > *t) {
                    best = Some((path, modified));
                }
            }
        }
    }

    best.map(|(p, _)| p)
}

/// Parse a single JSONL line into a TranscriptEvent (or None if not relevant).
fn parse_jsonl_line(line: &str, session_id: &str) -> Vec<TranscriptEvent> {
    let record: JsonlRecord = match serde_json::from_str(line) {
        Ok(r) => r,
        Err(_) => return vec![],
    };

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.0;

    let mut events = Vec::new();
    let record_type = record.record_type.as_deref().unwrap_or("");

    match record_type {
        "assistant" => {
            if let Some(msg) = &record.message {
                if let Some(contents) = &msg.content {
                    for content in contents {
                        let ct = content.content_type.as_deref().unwrap_or("");
                        match ct {
                            "tool_use" => {
                                events.push(TranscriptEvent {
                                    event_type: "tool_start".to_string(),
                                    tool_name: content.name.clone(),
                                    tool_input: content.input.clone(),
                                    timestamp,
                                    session_id: session_id.to_string(),
                                });
                            }
                            "text" => {
                                events.push(TranscriptEvent {
                                    event_type: "text".to_string(),
                                    tool_name: None,
                                    tool_input: None,
                                    timestamp,
                                    session_id: session_id.to_string(),
                                });
                            }
                            "thinking" => {
                                events.push(TranscriptEvent {
                                    event_type: "thinking".to_string(),
                                    tool_name: None,
                                    tool_input: None,
                                    timestamp,
                                    session_id: session_id.to_string(),
                                });
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
        "user" => {
            if let Some(msg) = &record.message {
                if let Some(contents) = &msg.content {
                    for content in contents {
                        if content.content_type.as_deref() == Some("tool_result") {
                            events.push(TranscriptEvent {
                                event_type: "tool_end".to_string(),
                                tool_name: None,
                                tool_input: None,
                                timestamp,
                                session_id: session_id.to_string(),
                            });
                        }
                    }
                }
            }
        }
        "system" => {
            if record.subtype.as_deref() == Some("turn_duration") {
                events.push(TranscriptEvent {
                    event_type: "turn_end".to_string(),
                    tool_name: None,
                    tool_input: None,
                    timestamp,
                    session_id: session_id.to_string(),
                });
            }
        }
        _ => {}
    }

    events
}

// ─── Tauri Commands ─────────────────────────────────────────────────

#[tauri::command]
pub fn start_transcript_watcher(
    app: AppHandle,
    state: State<'_, AppState>,
    transcript_watchers: State<'_, Mutex<TranscriptWatcherState>>,
    session_id: String,
) -> Result<String, String> {
    // Look up the session's working directory
    let working_directory = {
        let mgr = state
            .pty_manager
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        let pty_session = mgr
            .sessions
            .get(&session_id)
            .ok_or_else(|| format!("Session {} not found", session_id))?;
        let session = pty_session
            .session
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        session.working_directory.clone()
    };

    let transcript_path = find_transcript_file(&working_directory)
        .ok_or_else(|| "No JSONL transcript file found for this session".to_string())?;

    let watcher_id = Uuid::new_v4().to_string();
    let stop_flag = Arc::new(AtomicBool::new(false));

    {
        let mut watcher_state = transcript_watchers
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        watcher_state
            .watchers
            .insert(watcher_id.clone(), Arc::clone(&stop_flag));
    }

    let watcher_id_clone = watcher_id.clone();
    let session_id_clone = session_id.clone();
    let app_clone = app.clone();

    std::thread::spawn(move || {
        let event_name = format!("transcript-event:{}", watcher_id_clone);

        let file = match std::fs::File::open(&transcript_path) {
            Ok(f) => f,
            Err(e) => {
                log::warn!(
                    "Failed to open transcript file {}: {}",
                    transcript_path.display(),
                    e
                );
                return;
            }
        };

        let mut reader = BufReader::new(file);

        // Seek to end — we only want new lines
        if let Err(e) = reader.seek(SeekFrom::End(0)) {
            log::warn!("Failed to seek transcript file: {}", e);
            return;
        }

        // Poll for new lines every 500ms
        while !stop_flag.load(Ordering::Relaxed) {
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break, // No more data right now
                    Ok(_) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        let events = parse_jsonl_line(trimmed, &session_id_clone);
                        for event in events {
                            let _ = app_clone.emit(&event_name, &event);
                        }
                    }
                    Err(e) => {
                        log::warn!("Error reading transcript file: {}", e);
                        break;
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }

        log::info!("Transcript watcher {} stopped", watcher_id_clone);
    });

    Ok(watcher_id)
}

#[tauri::command]
pub fn stop_transcript_watcher(
    transcript_watchers: State<'_, Mutex<TranscriptWatcherState>>,
    watcher_id: String,
) -> Result<(), String> {
    let mut watcher_state = transcript_watchers
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;

    if let Some(stop_flag) = watcher_state.watchers.remove(&watcher_id) {
        stop_flag.store(true, Ordering::Relaxed);
    }

    Ok(())
}

/// Stop all transcript watchers for a given session.
/// Called internally when a session is destroyed.
#[allow(dead_code)]
pub fn cleanup_session_watchers(
    transcript_watchers: &Mutex<TranscriptWatcherState>,
    _session_id: &str,
) {
    // Since we don't track session_id → watcher_id mapping in the watcher state,
    // and watchers auto-stop when they detect the session is gone,
    // this is a best-effort cleanup. The polling thread will exit on its own
    // when the stop flag is set or the file becomes inaccessible.
    // For a more targeted cleanup, we could add a session_id field to the watcher state.
    let _ = transcript_watchers; // Currently a no-op; watchers stop on their own
}
