use std::fs::{read_to_string, OpenOptions};
use std::io::Write;
use std::path::Path;

const JOURNAL_FILENAME: &str = ".hermes/worktree-journal.log";

/// Log format: ACTION|session_id|realm_id|branch|worktree_path|timestamp
/// When ACTION completes, a COMPLETED line is appended.

pub fn journal_path(repo_path: &str) -> std::path::PathBuf {
    Path::new(repo_path).join(JOURNAL_FILENAME)
}

pub fn log_operation(
    repo_path: &str,
    action: &str,
    session_id: &str,
    realm_id: &str,
    branch: &str,
    worktree_path: &str,
) {
    let path = journal_path(repo_path);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let timestamp = chrono::Utc::now().to_rfc3339();
    let line = format!(
        "{}|{}|{}|{}|{}|{}\n",
        action, session_id, realm_id, branch, worktree_path, timestamp
    );
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = file.write_all(line.as_bytes());
    }
}

pub fn log_completed(repo_path: &str, action: &str, session_id: &str, realm_id: &str) {
    log_operation(
        repo_path,
        &format!("COMPLETED_{}", action),
        session_id,
        realm_id,
        "",
        "",
    );
}

/// Check for incomplete operations on startup
pub fn get_incomplete_operations(repo_path: &str) -> Vec<JournalEntry> {
    let path = journal_path(repo_path);
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
        let parts: Vec<&str> = line.splitn(6, '|').collect();
        if parts.len() < 5 {
            continue;
        }

        let action = parts[0];
        let session_id = parts[1];
        let realm_id = parts[2];
        let key = format!(
            "{}|{}|{}",
            action.replace("COMPLETED_", ""),
            session_id,
            realm_id
        );

        if action.starts_with("COMPLETED_") {
            pending.remove(&key);
        } else {
            pending.insert(
                key,
                JournalEntry {
                    action: action.to_string(),
                    session_id: session_id.to_string(),
                    realm_id: realm_id.to_string(),
                    branch: parts[3].to_string(),
                    worktree_path: parts[4].to_string(),
                    timestamp: parts.get(5).unwrap_or(&"").to_string(),
                },
            );
        }
    }

    pending.into_values().collect()
}

pub fn clear_journal(repo_path: &str) {
    let path = journal_path(repo_path);
    let _ = std::fs::remove_file(&path);
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct JournalEntry {
    pub action: String,
    pub session_id: String,
    pub realm_id: String,
    pub branch: String,
    pub worktree_path: String,
    pub timestamp: String,
}
