use std::fs::{read_to_string, OpenOptions};
use std::io::Write;
use std::path::Path;

use super::worktree;

const JOURNAL_FILENAME: &str = "worktree-journal.log";

/// Build the path to the journal file for a given repo.
/// Stored in `{base_dir}/{repo_hash}/worktree-journal.log`.
pub fn journal_path(
    app_data_dir: &Path,
    repo_path: &str,
    custom_base: Option<&Path>,
) -> std::path::PathBuf {
    let dir = worktree::worktree_dir(app_data_dir, repo_path, custom_base);
    dir.join(JOURNAL_FILENAME)
}

/// Log format: ACTION\tsession_id\tproject_id\tbranch\tworktree_path\ttimestamp
/// When ACTION completes, a COMPLETED line is appended.
pub fn log_operation(
    app_data_dir: &Path,
    repo_path: &str,
    action: &str,
    session_id: &str,
    project_id: &str,
    branch: &str,
    worktree_path: &str,
    custom_base: Option<&Path>,
) -> Result<(), String> {
    let path = journal_path(app_data_dir, repo_path, custom_base);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            let msg = format!("Failed to create journal directory {:?}: {}", parent, e);
            eprintln!("[journal] {}", msg);
            msg
        })?;
    }
    let timestamp = chrono::Utc::now().to_rfc3339();
    let line = format!(
        "{}\t{}\t{}\t{}\t{}\t{}\n",
        action, session_id, project_id, branch, worktree_path, timestamp
    );
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| {
            let msg = format!("Failed to open journal file {:?}: {}", path, e);
            eprintln!("[journal] {}", msg);
            msg
        })?;
    file.write_all(line.as_bytes()).map_err(|e| {
        let msg = format!("Failed to write journal entry: {}", e);
        eprintln!("[journal] {}", msg);
        msg
    })?;
    Ok(())
}

pub fn log_completed(
    app_data_dir: &Path,
    repo_path: &str,
    action: &str,
    session_id: &str,
    project_id: &str,
    custom_base: Option<&Path>,
) -> Result<(), String> {
    log_operation(
        app_data_dir,
        repo_path,
        &format!("COMPLETED_{}", action),
        session_id,
        project_id,
        "",
        "",
        custom_base,
    )
}

/// Check for incomplete operations on startup
pub fn get_incomplete_operations(
    app_data_dir: &Path,
    repo_path: &str,
    custom_base: Option<&Path>,
) -> Vec<JournalEntry> {
    let path = journal_path(app_data_dir, repo_path, custom_base);
    if !path.exists() {
        return Vec::new();
    }

    let content = match read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let mut pending: std::collections::HashMap<String, JournalEntry> =
        std::collections::HashMap::new();

    for line in content.lines() {
        let parts: Vec<&str> = line.splitn(6, '\t').collect();
        if parts.len() < 5 {
            continue;
        }

        let action = parts[0];
        let session_id = parts[1];
        let project_id = parts[2];
        let key = format!(
            "{}|{}|{}",
            action.replace("COMPLETED_", ""),
            session_id,
            project_id
        );

        if action.starts_with("COMPLETED_") {
            pending.remove(&key);
        } else {
            pending.insert(
                key,
                JournalEntry {
                    action: action.to_string(),
                    session_id: session_id.to_string(),
                    project_id: project_id.to_string(),
                    branch: parts[3].to_string(),
                    worktree_path: parts[4].to_string(),
                    timestamp: parts.get(5).unwrap_or(&"").to_string(),
                },
            );
        }
    }

    pending.into_values().collect()
}

pub fn clear_journal(app_data_dir: &Path, repo_path: &str, custom_base: Option<&Path>) {
    let path = journal_path(app_data_dir, repo_path, custom_base);
    let _ = std::fs::remove_file(&path);
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct JournalEntry {
    pub action: String,
    pub session_id: String,
    pub project_id: String,
    pub branch: String,
    pub worktree_path: String,
    pub timestamp: String,
}
