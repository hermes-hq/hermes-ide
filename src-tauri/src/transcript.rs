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

/// Claude Code caps a project folder name at this many characters and adds a
/// hash suffix to longer ones.
const CLAUDE_PROJECT_DIR_MAX_LEN: usize = 200;

/// The folder name Claude Code uses under `~/.claude/projects/` for a working
/// directory: every character that is not an ASCII letter or digit becomes
/// `-` (one per UTF-16 unit, as Claude Code's JavaScript does). The leading
/// `/` is kept, so real names start with `-`:
/// `/work/test/my.app` -> `-work-test-my-app`, `C:\work` -> `C--work`.
pub(crate) fn claude_project_dir_name(working_directory: &str) -> String {
    let mut out = String::with_capacity(working_directory.len());
    for c in working_directory.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else {
            for _ in 0..c.len_utf16() {
                out.push('-');
            }
        }
    }
    out
}

/// Find the Claude Code JSONL transcript file for a given working directory.
/// Claude Code stores transcripts in `~/.claude/projects/<project-folder>/`.
/// We look for the most recently modified `.jsonl` file in that folder only:
/// when no folder belongs to this directory there is no transcript, rather
/// than some other project's.
fn find_transcript_file(working_directory: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    find_transcript_file_in(&home.join(".claude").join("projects"), working_directory)
}

fn find_transcript_file_in(
    claude_projects_dir: &std::path::Path,
    working_directory: &str,
) -> Option<PathBuf> {
    if !claude_projects_dir.is_dir() || working_directory.is_empty() {
        return None;
    }

    // The shell may report a path through a symlink (macOS `/tmp` is
    // `/private/tmp`); Claude Code names the folder after the resolved path.
    let mut candidates = vec![working_directory.to_string()];
    // `dunce` keeps Windows paths in their plain `C:\...` form; the
    // `\\?\C:\...` form std returns would never match Claude Code's folder.
    if let Ok(resolved) = dunce::canonicalize(working_directory) {
        let resolved = resolved.to_string_lossy().to_string();
        if resolved != working_directory {
            candidates.push(resolved);
        }
    }

    for dir in &candidates {
        let name = claude_project_dir_name(dir);
        let exact = claude_projects_dir.join(&name);
        if exact.is_dir() {
            if let Some(found) = find_most_recent_jsonl_in(&exact) {
                return Some(found);
            }
        }
        // Long paths: Claude Code keeps the first 200 characters and appends
        // `-<hash>`. Match on that prefix.
        if name.len() > CLAUDE_PROJECT_DIR_MAX_LEN {
            let prefix = format!("{}-", &name[..CLAUDE_PROJECT_DIR_MAX_LEN]);
            if let Some(found) =
                find_most_recent_jsonl_in_matching(claude_projects_dir, |n| n.starts_with(&prefix))
            {
                return Some(found);
            }
        }
    }
    None
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

fn find_most_recent_jsonl_in_matching(
    claude_projects_dir: &std::path::Path,
    name_matches: impl Fn(&str) -> bool,
) -> Option<PathBuf> {
    let mut best: Option<(PathBuf, std::time::SystemTime)> = None;

    if let Ok(project_dirs) = std::fs::read_dir(claude_projects_dir) {
        for dir_entry in project_dirs.flatten() {
            let dir_path = dir_entry.path();
            if !dir_path.is_dir() || !name_matches(&dir_entry.file_name().to_string_lossy()) {
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
        "system" if record.subtype.as_deref() == Some("turn_duration") => {
            events.push(TranscriptEvent {
                event_type: "turn_end".to_string(),
                tool_name: None,
                tool_input: None,
                timestamp,
                session_id: session_id.to_string(),
            });
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{Duration, SystemTime};

    fn write_jsonl(dir: &std::path::Path, name: &str, age_secs: u64) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, "{}\n").unwrap();
        let mtime = SystemTime::now() - Duration::from_secs(age_secs);
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(mtime)
            .unwrap();
        path
    }

    #[test]
    fn project_dir_name_matches_claude_code_folder_names() {
        assert_eq!(
            claude_project_dir_name("/work/test/code/app"),
            "-work-test-code-app"
        );
        assert_eq!(
            claude_project_dir_name("/work/test/.config/my_app v2"),
            "-work-test--config-my-app-v2"
        );
        assert_eq!(
            claude_project_dir_name(r"C:\work\test\app"),
            "C--work-test-app"
        );
        // Non-ASCII: one dash per UTF-16 unit, like JavaScript's replace().
        assert_eq!(claude_project_dir_name("/tmp/caf\u{e9}"), "-tmp-caf-");
        assert_eq!(claude_project_dir_name("/tmp/\u{1F600}"), "-tmp---");
    }

    #[test]
    fn each_project_gets_its_own_transcript() {
        let root = tempfile::tempdir().unwrap();
        let projects = root.path().join("projects");
        let a = write_jsonl(&projects.join("-work-alpha"), "a.jsonl", 60);
        // Project beta's transcript is the newest file of all.
        let b = write_jsonl(&projects.join("-work-beta"), "b.jsonl", 1);

        assert_eq!(find_transcript_file_in(&projects, "/work/alpha"), Some(a));
        assert_eq!(find_transcript_file_in(&projects, "/work/beta"), Some(b));
    }

    #[test]
    fn newest_transcript_inside_the_project_wins() {
        let root = tempfile::tempdir().unwrap();
        let projects = root.path().join("projects");
        let dir = projects.join("-work-alpha");
        write_jsonl(&dir, "old.jsonl", 300);
        let new = write_jsonl(&dir, "new.jsonl", 5);
        assert_eq!(find_transcript_file_in(&projects, "/work/alpha"), Some(new));
    }

    #[test]
    fn unknown_project_has_no_transcript_instead_of_another_projects() {
        let root = tempfile::tempdir().unwrap();
        let projects = root.path().join("projects");
        write_jsonl(&projects.join("-work-alpha"), "a.jsonl", 1);
        assert_eq!(find_transcript_file_in(&projects, "/work/gamma"), None);
        assert_eq!(find_transcript_file_in(&projects, ""), None);
    }

    #[test]
    fn old_dashless_folder_name_is_not_matched() {
        // The previous lookup dropped the leading slash ("work-alpha"); Claude
        // Code never creates that folder, so it must not be picked up.
        let root = tempfile::tempdir().unwrap();
        let projects = root.path().join("projects");
        write_jsonl(&projects.join("work-alpha"), "stale.jsonl", 1);
        assert_eq!(find_transcript_file_in(&projects, "/work/alpha"), None);
    }

    #[test]
    fn long_paths_match_the_hashed_folder() {
        let root = tempfile::tempdir().unwrap();
        let projects = root.path().join("projects");
        let long_dir = format!("/work/{}", "x".repeat(250));
        let name = claude_project_dir_name(&long_dir);
        let hashed = format!("{}-abc123", &name[..CLAUDE_PROJECT_DIR_MAX_LEN]);
        let t = write_jsonl(&projects.join(hashed), "t.jsonl", 1);
        assert_eq!(find_transcript_file_in(&projects, &long_dir), Some(t));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_working_directory_uses_the_resolved_path() {
        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("real-project");
        fs::create_dir_all(&real).unwrap();
        let link = root.path().join("link-project");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let resolved = fs::canonicalize(&real).unwrap();

        let projects = root.path().join("projects");
        let t = write_jsonl(
            &projects.join(claude_project_dir_name(&resolved.to_string_lossy())),
            "t.jsonl",
            1,
        );
        assert_eq!(
            find_transcript_file_in(&projects, &link.to_string_lossy()),
            Some(t)
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_resolved_directory_matches_claude_folder() {
        // Temp folders are often reported in 8.3 short form
        // (`C:\Users\RUNNER~1\...`); Claude Code names the folder after the
        // long, plain `C:\...` path, never the `\\?\` form.
        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("real-project");
        fs::create_dir_all(&real).unwrap();
        let resolved = dunce::canonicalize(&real).unwrap();
        assert!(!resolved.to_string_lossy().starts_with(r"\\?\"));

        let projects = root.path().join("projects");
        let t = write_jsonl(
            &projects.join(claude_project_dir_name(&resolved.to_string_lossy())),
            "t.jsonl",
            1,
        );
        assert_eq!(
            find_transcript_file_in(&projects, &real.to_string_lossy()),
            Some(t)
        );
    }
}
