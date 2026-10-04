pub mod cli;
pub mod cow_clone;
pub mod disk_guard;
pub mod fast_setup;
pub mod hygiene;
pub mod hygiene_app;
pub mod journal;
pub mod recipe;
pub mod safety;
pub mod watcher;
pub mod worktree;

use git2::{
    BranchType, Cred, DiffOptions, FetchOptions, IndexAddOption, PushOptions, RemoteCallbacks,
    Repository, StatusOptions,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use crate::db::Database;
use crate::AppState;

/// Safety cap: if a project reports more than this many changed files,
/// stop collecting and return a truncated list with a warning.
/// This prevents the IDE from becoming unresponsive if .gitignore
/// exclusion fails or a repo has an unusual number of real changes.
const VCS_STATUS_FILE_CAP: usize = 10_000;

/// Validates that a path is inside the Hermes worktrees directory
/// (`hermes-worktrees/`). Returns the canonical path if valid, or an error
/// if the path is outside the expected worktree directory (prevents path
/// traversal attacks).
fn validate_worktree_path(path: &str) -> Result<std::path::PathBuf, String> {
    let p = std::path::Path::new(path);

    // First check the raw path string before canonicalizing
    // (canonicalize follows symlinks, which we want for the final check)
    if !worktree::is_hermes_worktree_path(path) {
        return Err(format!(
            "Refusing to operate on '{}': not inside a hermes-worktrees/ directory",
            path
        ));
    }

    // If the path exists, canonicalize and re-check
    if p.exists() {
        let canonical = p
            .canonicalize()
            .map_err(|e| format!("Failed to resolve path '{}': {}", path, e))?;
        let canonical_str = canonical.to_string_lossy();
        if !worktree::is_hermes_worktree_path(&canonical_str) {
            return Err(format!(
                "Refusing to operate on '{}': canonical path '{}' is not inside a hermes-worktrees/ directory",
                path, canonical_str
            ));
        }
        Ok(canonical)
    } else {
        // Path doesn't exist (e.g., record-only orphan) — just validate the string
        if path.contains("..") {
            return Err(format!("Refusing to operate on '{}': contains '..'", path));
        }
        Ok(p.to_path_buf())
    }
}

/// Resolves the worktree path for a given session+project from the database.
/// Falls back to looking up the project's path directly if no worktree entry exists.
/// Returns an error if the resolved directory no longer exists on disk (e.g. deleted externally).
fn resolve_worktree_path(
    db: &Database,
    session_id: &str,
    project_id: &str,
) -> Result<String, String> {
    // Try to find a worktree entry for this session+project
    if let Some(wt) = db
        .get_worktree_by_session_and_project(session_id, project_id)
        .map_err(|e| format!("Failed to look up worktree: {}", e))?
    {
        // Verify the worktree directory still exists on disk
        if std::path::Path::new(&wt.worktree_path).is_dir() {
            return Ok(wt.worktree_path);
        }

        // Worktree directory is gone — clean up the stale DB record and
        // fall back to the project's root path instead of crashing.
        log::warn!(
            "Worktree path '{}' no longer exists for session '{}' / project '{}' — \
             removing stale DB record and falling back to project root.",
            wt.worktree_path,
            session_id,
            project_id
        );
        if let Err(e) = db.delete_session_worktree(&wt.id) {
            log::warn!(
                "Failed to clean up stale worktree record '{}': {}",
                wt.id,
                e
            );
        }
        // Fall through to project path lookup below
    }
    // Fallback: look up the project's path directly
    if let Some(project) = db
        .get_project(project_id)
        .map_err(|e| format!("Failed to look up project: {}", e))?
    {
        return Ok(project.path);
    }
    Err(format!(
        "No worktree or project found for session={}, project={}",
        session_id, project_id
    ))
}

// ─── Data Models ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitFile {
    pub path: String,
    pub status: String,
    pub area: String,
    pub old_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitProjectStatus {
    pub project_id: String,
    pub project_name: String,
    pub project_path: String,
    pub is_git_repo: bool,
    pub branch: Option<String>,
    pub remote_branch: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFile>,
    pub has_conflicts: bool,
    pub stash_count: u32,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitSessionStatus {
    pub projects: Vec<GitProjectStatus>,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitDiff {
    pub path: String,
    pub diff_text: String,
    pub is_binary: bool,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitOperationResult {
    pub success: bool,
    pub message: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitBranch {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub last_commit_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_hidden: bool,
    pub size: Option<u64>,
    pub git_status: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileContent {
    pub content: String,
    pub file_name: String,
    pub language: String,
    pub is_binary: bool,
    pub size: u64,
    pub mtime: u64,
}

// ─── Helpers ────────────────────────────────────────────────────────

/// Maximum diff size before truncation (2 MB)
const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;

fn make_callbacks<'a>() -> RemoteCallbacks<'a> {
    let mut callbacks = RemoteCallbacks::new();

    // Track which auth methods have been tried (each attempted at most once)
    let tried_ssh_agent = Arc::new(AtomicBool::new(false));
    let tried_ssh_key_file = Arc::new(AtomicBool::new(false));
    let tried_cred_helper = Arc::new(AtomicBool::new(false));
    let tried_env_token = Arc::new(AtomicBool::new(false));

    callbacks.credentials(move |url, username_from_url, allowed_types| {
        let username = username_from_url.unwrap_or("git");

        // 1. SSH agent
        if allowed_types.contains(git2::CredentialType::SSH_KEY)
            && !tried_ssh_agent.swap(true, Ordering::SeqCst)
        {
            if let Ok(cred) = Cred::ssh_key_from_agent(username) {
                return Ok(cred);
            }
        }

        // 2. SSH key files (~/.ssh/id_ed25519, ~/.ssh/id_rsa)
        if allowed_types.contains(git2::CredentialType::SSH_KEY)
            && !tried_ssh_key_file.swap(true, Ordering::SeqCst)
        {
            if let Some(home) = dirs::home_dir() {
                let key_candidates = [
                    home.join(".ssh").join("id_ed25519"),
                    home.join(".ssh").join("id_rsa"),
                ];
                for key_path in &key_candidates {
                    if key_path.exists() {
                        let mut pub_path_buf = key_path.as_os_str().to_owned();
                        pub_path_buf.push(".pub");
                        let pub_path = std::path::PathBuf::from(pub_path_buf);
                        let pub_key = if pub_path.exists() {
                            Some(pub_path.as_path())
                        } else {
                            None
                        };
                        if let Ok(cred) = Cred::ssh_key(username, pub_key, key_path, None) {
                            return Ok(cred);
                        }
                    }
                }
            }
        }

        // 3. Credential helper / GCM (browser OAuth when configured)
        if allowed_types.contains(git2::CredentialType::USER_PASS_PLAINTEXT)
            && !tried_cred_helper.swap(true, Ordering::SeqCst)
        {
            if let Ok(config) = git2::Config::open_default() {
                if let Ok(cred) = Cred::credential_helper(&config, url, username_from_url) {
                    return Ok(cred);
                }
            }
        }

        // 4. GITHUB_TOKEN / GIT_TOKEN env var fallback
        if allowed_types.contains(git2::CredentialType::USER_PASS_PLAINTEXT)
            && !tried_env_token.swap(true, Ordering::SeqCst)
        {
            if let Ok(token) = std::env::var("GITHUB_TOKEN").or_else(|_| std::env::var("GIT_TOKEN"))
            {
                if let Ok(cred) = Cred::userpass_plaintext("x-access-token", &token) {
                    return Ok(cred);
                }
            }
        }

        // 5. All methods exhausted
        Err(git2::Error::from_str(
            "Authentication failed. Options: \
             (a) add SSH key to agent (ssh-add), \
             (b) install Git Credential Manager (https://aka.ms/gcm), \
             (c) run `gh auth setup-git`, \
             (d) set GITHUB_TOKEN env var",
        ))
    });
    callbacks
}

fn status_to_string(status: git2::Status) -> &'static str {
    if status.contains(git2::Status::CONFLICTED) {
        "conflicted"
    } else if status.contains(git2::Status::INDEX_NEW) {
        "added"
    } else if status.contains(git2::Status::INDEX_DELETED)
        || status.contains(git2::Status::WT_DELETED)
    {
        "deleted"
    } else if status.contains(git2::Status::INDEX_RENAMED)
        || status.contains(git2::Status::WT_RENAMED)
    {
        "renamed"
    } else {
        "modified"
    }
}

/// Verify that a joined path does not escape the project root.
fn safe_join(project_path: &str, relative: &str) -> Result<std::path::PathBuf, String> {
    let base =
        std::fs::canonicalize(project_path).map_err(|e| format!("Invalid project path: {}", e))?;
    let joined = base.join(relative);
    // Canonicalize if it exists, otherwise normalize manually
    let resolved = if joined.exists() {
        std::fs::canonicalize(&joined).map_err(|e| format!("Invalid file path: {}", e))?
    } else {
        // For non-existent paths (deleted files), resolve what we can
        // and ensure no ".." components escape
        let mut normalized = base.clone();
        for component in Path::new(relative).components() {
            match component {
                std::path::Component::ParentDir => {
                    normalized.pop();
                }
                std::path::Component::Normal(c) => {
                    normalized.push(c);
                }
                _ => {}
            }
        }
        normalized
    };
    if !resolved.starts_with(&base) {
        return Err("Path traversal rejected: path escapes project root".to_string());
    }
    Ok(resolved)
}

fn get_project_git_status(
    project_id: &str,
    project_name: &str,
    project_path: &str,
) -> GitProjectStatus {
    let path = Path::new(project_path);

    let mut repo = match Repository::open(path) {
        Ok(r) => r,
        Err(_) => {
            return GitProjectStatus {
                project_id: project_id.to_string(),
                project_name: project_name.to_string(),
                project_path: project_path.to_string(),
                is_git_repo: false,
                branch: None,
                remote_branch: None,
                ahead: 0,
                behind: 0,
                files: Vec::new(),
                has_conflicts: false,
                stash_count: 0,
                error: None,
            };
        }
    };

    // 1D: Handle bare repository
    if repo.is_bare() {
        return GitProjectStatus {
            project_id: project_id.to_string(),
            project_name: project_name.to_string(),
            project_path: project_path.to_string(),
            is_git_repo: true,
            branch: None,
            remote_branch: None,
            ahead: 0,
            behind: 0,
            files: Vec::new(),
            has_conflicts: false,
            stash_count: 0,
            error: Some("Bare repository (no working directory)".to_string()),
        };
    }

    // 1C: Handle detached HEAD
    let is_detached = repo.head_detached().unwrap_or(false);

    let branch = if is_detached {
        repo.head()
            .ok()
            .and_then(|h| h.target())
            .map(|oid| format!("{}… (detached)", &oid.to_string()[..8]))
    } else {
        repo.head()
            .ok()
            .and_then(|h| h.shorthand().map(|s| s.to_string()))
    };

    // Get remote tracking branch + ahead/behind (skip when detached)
    let mut remote_branch = None;
    let mut ahead = 0u32;
    let mut behind = 0u32;

    if !is_detached {
        if let Ok(head) = repo.head() {
            if let Some(name) = head.name() {
                if let Ok(branch_ref) =
                    repo.find_branch(head.shorthand().unwrap_or(""), git2::BranchType::Local)
                {
                    if let Ok(upstream) = branch_ref.upstream() {
                        remote_branch = upstream.name().ok().flatten().map(|s| s.to_string());

                        if let (Ok(local_oid), Some(remote_oid)) = (
                            repo.refname_to_id(name),
                            upstream
                                .get()
                                .name()
                                .and_then(|n| repo.refname_to_id(n).ok()),
                        ) {
                            if let Ok((a, b)) = repo.graph_ahead_behind(local_oid, remote_oid) {
                                ahead = a as u32;
                                behind = b as u32;
                            }
                        }
                    }
                }
            }
        }
    }

    // Get file statuses — exclude ignored files (.gitignore) to avoid
    // counting node_modules/, .turbo/, etc. as "changes"
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);

    let mut files = Vec::new();
    let mut has_conflicts = false;
    let mut status_capped = false;

    match repo.statuses(Some(&mut opts)) {
        Ok(statuses) => {
            for entry in statuses.iter() {
                // Circuit breaker: stop collecting if we exceed the cap
                if files.len() >= VCS_STATUS_FILE_CAP {
                    status_capped = true;
                    log::warn!(
                        "VCS status for '{}' exceeded {} files — truncating. \
                         This usually means .gitignore is not filtering correctly.",
                        project_path,
                        VCS_STATUS_FILE_CAP
                    );
                    break;
                }

                let s = entry.status();
                if s.is_empty() {
                    continue;
                }

                let file_path = entry.path().unwrap_or("").to_string();

                if s.contains(git2::Status::CONFLICTED) {
                    has_conflicts = true;
                    files.push(GitFile {
                        path: file_path,
                        status: "conflicted".to_string(),
                        area: "unstaged".to_string(),
                        old_path: None,
                    });
                    continue;
                }

                // 1B: Handle WT_NEW (untracked) FIRST to prevent duplication.
                // A pure untracked file only has WT_NEW set and should appear
                // exactly once in the "untracked" area.
                if s.contains(git2::Status::WT_NEW) {
                    // If also INDEX_NEW, it was staged — show in both areas
                    if s.contains(git2::Status::INDEX_NEW) {
                        files.push(GitFile {
                            path: file_path.clone(),
                            status: "added".to_string(),
                            area: "staged".to_string(),
                            old_path: None,
                        });
                    }
                    // Always show as untracked in its own area
                    files.push(GitFile {
                        path: file_path,
                        status: "untracked".to_string(),
                        area: "untracked".to_string(),
                        old_path: None,
                    });
                    continue;
                }

                // Index (staged) changes
                let index_status = s
                    & (git2::Status::INDEX_NEW
                        | git2::Status::INDEX_MODIFIED
                        | git2::Status::INDEX_DELETED
                        | git2::Status::INDEX_RENAMED);
                if !index_status.is_empty() {
                    files.push(GitFile {
                        path: file_path.clone(),
                        status: status_to_string(index_status).to_string(),
                        area: "staged".to_string(),
                        old_path: entry.head_to_index().and_then(|d| {
                            d.old_file().path().map(|p| p.to_string_lossy().to_string())
                        }),
                    });
                }

                // Working tree (unstaged) changes
                let wt_status = s
                    & (git2::Status::WT_MODIFIED
                        | git2::Status::WT_DELETED
                        | git2::Status::WT_RENAMED);
                if !wt_status.is_empty() {
                    files.push(GitFile {
                        path: file_path.clone(),
                        status: status_to_string(wt_status).to_string(),
                        area: "unstaged".to_string(),
                        old_path: entry.index_to_workdir().and_then(|d| {
                            d.old_file().path().map(|p| p.to_string_lossy().to_string())
                        }),
                    });
                }
            }
        }
        Err(e) => {
            return GitProjectStatus {
                project_id: project_id.to_string(),
                project_name: project_name.to_string(),
                project_path: project_path.to_string(),
                is_git_repo: true,
                branch,
                remote_branch,
                ahead,
                behind,
                files: Vec::new(),
                has_conflicts: false,
                stash_count: 0,
                error: Some(format!("Failed to get status: {}", e)),
            };
        }
    }

    // Count stashes
    let mut stash_count = 0u32;
    let _ = repo.stash_foreach(|_index, _message, _oid| {
        stash_count += 1;
        true
    });

    let error = if status_capped {
        Some(format!(
            "Too many changed files (>{}) — VCS status truncated. \
             Check that .gitignore is set up correctly.",
            VCS_STATUS_FILE_CAP
        ))
    } else {
        None
    };

    GitProjectStatus {
        project_id: project_id.to_string(),
        project_name: project_name.to_string(),
        project_path: project_path.to_string(),
        is_git_repo: true,
        branch,
        remote_branch,
        ahead,
        behind,
        files,
        has_conflicts,
        stash_count,
        error,
    }
}

// ─── Tauri Commands ─────────────────────────────────────────────────

#[tauri::command]
pub async fn git_status(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<GitSessionStatus, String> {
    // Collect project info while holding the DB lock (fast, no I/O).
    // We must release State before .await since it is not Send.
    let project_inputs: Vec<(String, String, String)> = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let session_projects = db.get_session_projects(&session_id)?;
        session_projects
            .iter()
            .map(|r| {
                let path = resolve_worktree_path(&db, &session_id, &r.id)
                    .unwrap_or_else(|_| r.path.clone());
                (r.id.clone(), r.name.clone(), path)
            })
            .collect()
    };

    // Move the expensive filesystem walk (libgit2 status) off the main thread
    // so the UI event loop stays responsive. Apply a timeout so a runaway
    // filesystem scan on a huge repo can't consume CPU forever.
    let task = tokio::task::spawn_blocking(move || {
        let projects: Vec<GitProjectStatus> = project_inputs
            .iter()
            .map(|(id, name, path)| get_project_git_status(id, name, path))
            .filter(|p| p.is_git_repo)
            .collect();

        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        Ok(GitSessionStatus {
            projects,
            timestamp,
        })
    });

    match tokio::time::timeout(std::time::Duration::from_secs(30), task).await {
        Ok(join_result) => join_result.map_err(|e| format!("git_status task panicked: {}", e))?,
        Err(_) => Err("git_status timed out after 30s — the repository may be very large or the filesystem is slow".to_string()),
    }
}

#[tauri::command]
pub fn git_stage(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    paths: Vec<String>,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &project_id)?;
    drop(db);
    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;
    let mut index = repo.index().map_err(|e| e.to_string())?;

    if paths.len() == 1 && paths[0] == "." {
        index
            .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
            .map_err(|e| e.to_string())?;
    } else {
        for path in &paths {
            // 1F: Path traversal guard
            safe_join(&project_path, path)?;

            let file_path = Path::new(project_path.as_str()).join(path);
            if file_path.exists() {
                index
                    .add_path(Path::new(path))
                    .map_err(|e| format!("Failed to stage {}: {}", path, e))?;
            } else {
                index
                    .remove_path(Path::new(path))
                    .map_err(|e| format!("Failed to stage deletion {}: {}", path, e))?;
            }
        }
    }

    index.write().map_err(|e| e.to_string())?;

    Ok(GitOperationResult {
        success: true,
        message: format!("Staged {} file(s)", paths.len()),
        error: None,
    })
}

/// Every path to unstage stays inside the project (`.` means everything).
fn check_unstage_paths(project_path: &str, paths: &[String]) -> Result<(), String> {
    for path in paths {
        if path != "." {
            safe_join(project_path, path)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn git_unstage(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    paths: Vec<String>,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &project_id)?;
    drop(db);

    // `git reset -- <paths>` with literal pathspecs: `pages/[id].tsx` is
    // that file only (libgit2's reset_default treats it as a pattern).
    check_unstage_paths(&project_path, &paths)?;
    safety::unstage_paths(Path::new(&project_path), &paths)?;

    Ok(GitOperationResult {
        success: true,
        message: format!("Unstaged {} file(s)", paths.len()),
        error: None,
    })
}

#[tauri::command]
pub fn git_discard_changes(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    paths: Vec<String>,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &project_id)?;
    drop(db);
    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;

    for path in &paths {
        safe_join(&project_path, path)?;
    }
    // Literal paths: discarding `pages/[id].tsx` never touches pages/i.tsx.
    safety::discard_paths(&repo, &paths)?;

    Ok(GitOperationResult {
        success: true,
        message: format!("Discarded changes in {} file(s)", paths.len()),
        error: None,
    })
}

/// 3C: the author override when both name and email are given, otherwise
/// None (the repository's own identity, which must then exist).
fn commit_author<'a>(
    repo: &Repository,
    author_name: &'a Option<String>,
    author_email: &'a Option<String>,
) -> Result<Option<(&'a str, &'a str)>, String> {
    match (author_name, author_email) {
        (Some(name), Some(email)) if !name.is_empty() && !email.is_empty() => {
            Ok(Some((name.as_str(), email.as_str())))
        }
        _ => {
            repo.signature().map_err(|e| {
                format!(
                    "Git user not configured. Run: git config --global user.name \"...\"; \
                     git config --global user.email \"...\"\nError: {}",
                    e
                )
            })?;
            Ok(None)
        }
    }
}

#[tauri::command]
pub fn git_commit(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    message: String,
    author_name: Option<String>,
    author_email: Option<String>,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &project_id)?;
    drop(db);
    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;
    let author = commit_author(&repo, &author_name, &author_email)?;
    drop(repo);

    // `git commit` itself: the repository's hooks run and its signing
    // settings apply. A hook that refuses comes back as HOOK_REFUSED.
    safety::commit_staged(Path::new(&project_path), &message, author)?;

    Ok(GitOperationResult {
        success: true,
        message: format!("Committed: {}", message),
        error: None,
    })
}

#[tauri::command]
pub fn git_push(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    remote: Option<String>,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &project_id)?;
    drop(db);
    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;
    let remote_name = remote.as_deref().unwrap_or("origin");

    let mut remote_obj = repo
        .find_remote(remote_name)
        .map_err(|e| format!("Remote '{}' not found: {}", remote_name, e))?;

    let head = repo.head().map_err(|e| e.to_string())?;
    let refspec = head
        .name()
        .ok_or_else(|| "HEAD is not a symbolic reference".to_string())?;

    let callbacks = make_callbacks();
    let mut push_opts = PushOptions::new();
    push_opts.remote_callbacks(callbacks);

    remote_obj
        .push(&[refspec], Some(&mut push_opts))
        .map_err(|e| format!("Push failed: {}", e))?;

    Ok(GitOperationResult {
        success: true,
        message: format!("Pushed to {}", remote_name),
        error: None,
    })
}

#[tauri::command]
pub async fn git_pull(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    remote: Option<String>,
) -> Result<GitOperationResult, String> {
    let project_path = {
        let db = state
            .db
            .lock()
            .map_err(|e| format!("DB lock error: {}", e))?;
        resolve_worktree_path(&db, &session_id, &project_id)?
    };

    tokio::task::spawn_blocking(move || {
        let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;

        // Reject pull if repo is already in a merge/rebase state
        let repo_state = repo.state();
        if repo_state != git2::RepositoryState::Clean {
            return Err(format!(
                "Cannot pull: repository is in {:?} state. Complete or abort the current operation first.",
                repo_state
            ));
        }

        let remote_name = remote.as_deref().unwrap_or("origin");

        let mut remote_obj = repo
            .find_remote(remote_name)
            .map_err(|e| format!("Remote '{}' not found: {}", remote_name, e))?;

        // Fetch
        let callbacks = make_callbacks();
        let mut fetch_opts = FetchOptions::new();
        fetch_opts.remote_callbacks(callbacks);

        let head = repo.head().map_err(|e| e.to_string())?;
        let branch_name = head
            .shorthand()
            .ok_or_else(|| "Cannot determine current branch".to_string())?
            .to_string();

        remote_obj
            .fetch(&[&branch_name], Some(&mut fetch_opts), None)
            .map_err(|e| format!("Fetch failed: {}", e))?;

        // Fast-forward merge
        let fetch_head = repo
            .find_reference("FETCH_HEAD")
            .map_err(|e| e.to_string())?;
        let fetch_commit = repo
            .reference_to_annotated_commit(&fetch_head)
            .map_err(|e| e.to_string())?;

        let (merge_analysis, _) = repo
            .merge_analysis(&[&fetch_commit])
            .map_err(|e| e.to_string())?;

        if merge_analysis.is_up_to_date() {
            return Ok(GitOperationResult {
                success: true,
                message: "Already up to date".to_string(),
                error: None,
            });
        }

        let target = fetch_commit.id().to_string();
        let dir = Path::new(&project_path);

        // Both paths go through the git CLI, which refuses rather than
        // overwrite an uncommitted edit the incoming commits also change
        // (a forced libgit2 checkout used to reset such files silently).
        if merge_analysis.is_fast_forward() {
            safety::fast_forward(dir, &target)?;
            return Ok(GitOperationResult {
                success: true,
                message: "Fast-forward pull complete".to_string(),
                error: None,
            });
        }

        // Perform actual merge
        if merge_analysis.is_normal() {
            let msg = format!("Merge branch '{}' of {}", branch_name, remote_name);
            return match safety::merge(dir, &target, &msg)? {
                safety::MergeRun::Conflicts => Ok(GitOperationResult {
                    success: false,
                    message: "Pull complete but merge has conflicts. Resolve them to finish the merge."
                        .to_string(),
                    error: Some("Merge conflicts detected".to_string()),
                }),
                safety::MergeRun::Merged => Ok(GitOperationResult {
                    success: true,
                    message: "Pull with merge complete".to_string(),
                    error: None,
                }),
            };
        }

        Err("Pull failed: unexpected merge analysis result".to_string())
    })
    .await
    .map_err(|e| format!("git_pull task panicked: {}", e))?
}

#[tauri::command]
pub fn git_diff(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    file_path: String,
    staged: bool,
) -> Result<GitDiff, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &project_id)?;
    drop(db);
    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;

    let mut diff_opts = DiffOptions::new();
    diff_opts.pathspec(&file_path);

    let diff = if staged {
        let head_tree = repo.head().and_then(|h| h.peel_to_tree()).ok();
        repo.diff_tree_to_index(
            head_tree.as_ref(),
            Some(&repo.index().map_err(|e| e.to_string())?),
            Some(&mut diff_opts),
        )
        .map_err(|e| e.to_string())?
    } else {
        repo.diff_index_to_workdir(None, Some(&mut diff_opts))
            .map_err(|e| e.to_string())?
    };

    let stats = diff.stats().map_err(|e| e.to_string())?;
    let mut diff_text = String::new();
    let mut is_binary = false;
    let mut truncated = false;

    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        // 1E: Cap diff size
        if truncated {
            return true;
        }
        if diff_text.len() >= MAX_DIFF_BYTES {
            truncated = true;
            return true;
        }

        let origin = line.origin();
        if origin == '+' || origin == '-' || origin == ' ' {
            diff_text.push(origin);
        }
        if let Ok(content) = std::str::from_utf8(line.content()) {
            diff_text.push_str(content);
        } else {
            is_binary = true;
        }
        true
    })
    .map_err(|e| e.to_string())?;

    if truncated {
        diff_text = "[Diff too large to display — use terminal]".to_string();
        is_binary = true;
    }

    Ok(GitDiff {
        path: file_path,
        diff_text,
        is_binary,
        additions: stats.insertions() as u32,
        deletions: stats.deletions() as u32,
    })
}

#[tauri::command]
pub fn git_open_file(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    file_path: String,
) -> Result<(), String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &project_id)?;
    drop(db);
    // 1F: Path traversal guard
    let full_path = safe_join(&project_path, &file_path)?;
    crate::platform::open_file(&full_path.to_string_lossy())
}

#[tauri::command]
pub fn read_file_content(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    file_path: String,
) -> Result<FileContent, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &project_id)?;
    drop(db);

    let full_path = safe_join(&project_path, &file_path)?;
    let metadata = std::fs::metadata(&full_path)
        .map_err(|e| format!("Failed to read file metadata: {}", e))?;
    let size = metadata.len();
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // Cap at 1 MB to avoid loading huge files into the webview
    const MAX_SIZE: u64 = 1_048_576;

    let file_name = full_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let extension = full_path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    let language = match extension.as_str() {
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "py" => "python",
        "rb" => "ruby",
        "go" => "go",
        "java" => "java",
        "c" | "h" => "c",
        "cpp" | "hpp" | "cc" | "cxx" => "cpp",
        "cs" => "csharp",
        "swift" => "swift",
        "kt" | "kts" => "kotlin",
        "html" | "htm" => "html",
        "css" | "scss" | "sass" | "less" => "css",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "xml" | "svg" => "xml",
        "sql" => "sql",
        "sh" | "bash" | "zsh" => "bash",
        "md" | "markdown" => "markdown",
        "dockerfile" => "dockerfile",
        "dart" => "dart",
        "lua" => "lua",
        "r" => "r",
        "php" => "php",
        "ex" | "exs" => "elixir",
        _ => "plaintext",
    }
    .to_string();

    if size > MAX_SIZE {
        return Ok(FileContent {
            content: String::new(),
            file_name,
            language,
            is_binary: false,
            size,
            mtime,
        });
    }

    // Read raw bytes to detect binary
    let bytes = std::fs::read(&full_path).map_err(|e| format!("Failed to read file: {}", e))?;

    // Check first 8KB for null bytes (binary detection)
    let check_len = bytes.len().min(8192);
    let is_binary = bytes[..check_len].contains(&0);

    let content = if is_binary {
        String::new()
    } else {
        String::from_utf8_lossy(&bytes).to_string()
    };

    Ok(FileContent {
        content,
        file_name,
        language,
        is_binary,
        size,
        mtime,
    })
}

#[tauri::command]
pub fn write_file_content(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    file_path: String,
    content: String,
) -> Result<u64, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &project_id)?;
    drop(db);

    let full_path = safe_join(&project_path, &file_path)?;
    std::fs::write(&full_path, content.as_bytes())
        .map_err(|e| format!("Failed to write file: {}", e))?;

    // Return new mtime so the frontend can track it
    let mtime = std::fs::metadata(&full_path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(mtime)
}

#[tauri::command]
pub fn open_file_in_editor(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    file_path: String,
    editor: Option<String>,
) -> Result<(), String> {
    // SSH remote editors: editor string contains args (e.g. "code --remote ssh-remote+user@host")
    // or file_path is a URI (e.g. "ssh://user@host/path") — skip local path resolution.
    if project_id == "__ssh_local__" {
        return match editor {
            Some(ref cmd) if !cmd.is_empty() => {
                // Split "code --remote ssh-remote+user@host" into command + args
                let parts: Vec<&str> = cmd.split_whitespace().collect();
                let (bin, extra_args) = parts
                    .split_first()
                    .ok_or_else(|| "Empty editor command".to_string())?;

                if !crate::platform::command_exists(bin) {
                    return Err(format!("Editor '{}' not found on PATH", bin));
                }

                let mut child = std::process::Command::new(bin)
                    .args(extra_args.iter())
                    .arg(&file_path)
                    .spawn()
                    .map_err(|e| format!("Failed to open remote file in {}: {}", bin, e))?;
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                Ok(())
            }
            _ => Err("No editor specified for SSH remote open".to_string()),
        };
    }

    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &project_id)?;
    drop(db);

    let full_path = safe_join(&project_path, &file_path)?;
    let path_str = full_path.to_string_lossy().to_string();

    match editor {
        Some(ref cmd) if !cmd.is_empty() => {
            // Validate editor command: only allow simple command names (no paths with shell metacharacters)
            if cmd.contains('/') || cmd.contains('\\') {
                return Err(
                    "Editor command must be a simple command name (e.g. 'code', 'subl')"
                        .to_string(),
                );
            }
            // Try the preferred editor; fall back to system default if not found
            if !crate::platform::command_exists(cmd) {
                log::warn!(
                    "Editor '{}' not found on PATH, falling back to system default",
                    cmd
                );
                return crate::platform::open_file(&path_str);
            }
            let mut child = std::process::Command::new(cmd)
                .arg(&path_str)
                .spawn()
                .map_err(|e| format!("Failed to open file in {}: {}", cmd, e))?;
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            Ok(())
        }
        _ => crate::platform::open_file(&path_str),
    }
}

// ─── Branch Management Commands ─────────────────────────────────────

#[tauri::command]
pub async fn git_list_branches(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
) -> Result<Vec<GitBranch>, String> {
    let project_path = {
        let db = state
            .db
            .lock()
            .map_err(|e| format!("DB lock error: {}", e))?;
        resolve_worktree_path(&db, &session_id, &project_id)?
    };

    tokio::task::spawn_blocking(move || {
        let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;
        let mut branches = Vec::new();

        let current_branch = repo
            .head()
            .ok()
            .and_then(|h| h.shorthand().map(|s| s.to_string()));

        let local_branches = repo
            .branches(Some(BranchType::Local))
            .map_err(|e| e.to_string())?;

        for branch_result in local_branches {
            let (branch, _) = branch_result.map_err(|e| e.to_string())?;
            let name = branch
                .name()
                .map_err(|e| e.to_string())?
                .unwrap_or("")
                .to_string();

            let is_current = current_branch.as_deref() == Some(&name);

            let mut ahead = 0u32;
            let mut behind = 0u32;
            let mut upstream_name = None;

            if let Ok(upstream) = branch.upstream() {
                upstream_name = upstream.name().ok().flatten().map(|s| s.to_string());
                if is_current {
                    if let (Some(local_ref), Some(upstream_ref)) =
                        (branch.get().name(), upstream.get().name())
                    {
                        if let (Ok(local_oid), Ok(remote_oid)) = (
                            repo.refname_to_id(local_ref),
                            repo.refname_to_id(upstream_ref),
                        ) {
                            if let Ok((a, b)) = repo.graph_ahead_behind(local_oid, remote_oid) {
                                ahead = a as u32;
                                behind = b as u32;
                            }
                        }
                    }
                }
            }

            let last_commit_summary = branch
                .get()
                .peel_to_commit()
                .ok()
                .map(|c| c.summary().unwrap_or("").to_string());

            branches.push(GitBranch {
                name,
                is_current,
                is_remote: false,
                upstream: upstream_name,
                ahead,
                behind,
                last_commit_summary,
            });
        }

        Ok(branches)
    })
    .await
    .map_err(|e| format!("git_list_branches task panicked: {}", e))?
}

/// List branches for a project without requiring a session.
/// Uses the project's root path directly (not a worktree path).
#[tauri::command]
pub async fn git_list_branches_for_project(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<GitBranch>, String> {
    let project_path = {
        let db = state
            .db
            .lock()
            .map_err(|e| format!("DB lock error: {}", e))?;
        let project = db
            .get_project(&project_id)
            .map_err(|e| format!("Failed to look up project: {}", e))?
            .ok_or_else(|| format!("Project '{}' not found", project_id))?;
        project.path.clone()
    };

    tokio::task::spawn_blocking(move || {
        let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;
        let mut branches = Vec::new();

        let current_branch = repo
            .head()
            .ok()
            .and_then(|h| h.shorthand().map(|s| s.to_string()));

        let local_branches = repo
            .branches(Some(BranchType::Local))
            .map_err(|e| e.to_string())?;

        for branch_result in local_branches {
            let (branch, _) = branch_result.map_err(|e| e.to_string())?;
            let name = branch
                .name()
                .map_err(|e| e.to_string())?
                .unwrap_or("")
                .to_string();

            let is_current = current_branch.as_deref() == Some(&name);

            let mut ahead = 0u32;
            let mut behind = 0u32;
            let mut upstream_name = None;

            if let Ok(upstream) = branch.upstream() {
                upstream_name = upstream.name().ok().flatten().map(|s| s.to_string());
                if is_current {
                    if let (Some(local_ref), Some(upstream_ref)) =
                        (branch.get().name(), upstream.get().name())
                    {
                        if let (Ok(local_oid), Ok(remote_oid)) = (
                            repo.refname_to_id(local_ref),
                            repo.refname_to_id(upstream_ref),
                        ) {
                            if let Ok((a, b)) = repo.graph_ahead_behind(local_oid, remote_oid) {
                                ahead = a as u32;
                                behind = b as u32;
                            }
                        }
                    }
                }
            }

            let last_commit_summary = branch
                .get()
                .peel_to_commit()
                .ok()
                .map(|c| c.summary().unwrap_or("").to_string());

            branches.push(GitBranch {
                name,
                is_current,
                is_remote: false,
                upstream: upstream_name,
                ahead,
                behind,
                last_commit_summary,
            });
        }

        Ok(branches)
    })
    .await
    .map_err(|e| format!("git_list_branches_for_project task panicked: {}", e))?
}

/// Compute ahead/behind counts for all local branches that have an upstream.
/// Designed to be called lazily after the fast `git_list_branches` returns,
/// so the branch dropdown renders instantly and enriches in the background.
#[tauri::command]
pub async fn git_branches_ahead_behind(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
) -> Result<HashMap<String, (u32, u32)>, String> {
    let project_path = {
        let db = state
            .db
            .lock()
            .map_err(|e| format!("DB lock error: {}", e))?;
        resolve_worktree_path(&db, &session_id, &project_id)?
    };

    tokio::task::spawn_blocking(move || {
        let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;
        let mut result = HashMap::new();

        let local_branches = repo
            .branches(Some(BranchType::Local))
            .map_err(|e| e.to_string())?;

        for branch_result in local_branches {
            let (branch, _) = branch_result.map_err(|e| e.to_string())?;
            let name = branch
                .name()
                .map_err(|e| e.to_string())?
                .unwrap_or("")
                .to_string();

            if let Ok(upstream) = branch.upstream() {
                if let (Some(local_ref), Some(upstream_ref)) =
                    (branch.get().name(), upstream.get().name())
                {
                    if let (Ok(local_oid), Ok(remote_oid)) = (
                        repo.refname_to_id(local_ref),
                        repo.refname_to_id(upstream_ref),
                    ) {
                        if let Ok((a, b)) = repo.graph_ahead_behind(local_oid, remote_oid) {
                            result.insert(name, (a as u32, b as u32));
                        }
                    }
                }
            }
        }

        Ok(result)
    })
    .await
    .map_err(|e| format!("git_branches_ahead_behind task panicked: {}", e))?
}

#[tauri::command]
pub fn git_create_branch(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    name: String,
    checkout: bool,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &project_id)?;
    drop(db);
    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;

    let head_commit = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|e| format!("Cannot resolve HEAD: {}", e))?;

    // Not even a case-only variant of an existing branch (see BranchClash).
    if let Some(clash) = worktree::local_branch_clash(&repo, &name) {
        return Err(worktree::branch_clash_error(&name, &clash));
    }
    repo.branch(&name, &head_commit, false)
        .map_err(|e| format!("Failed to create branch '{}': {}", name, e))?;

    if checkout {
        let refname = format!("refs/heads/{}", name);
        repo.set_head(&refname).map_err(|e| e.to_string())?;
        repo.checkout_head(Some(git2::build::CheckoutBuilder::default().safe()))
            .map_err(|e| e.to_string())?;
    }

    Ok(GitOperationResult {
        success: true,
        message: format!(
            "Created branch '{}'{}",
            name,
            if checkout { " and checked out" } else { "" }
        ),
        error: None,
    })
}

#[tauri::command]
pub async fn git_checkout_branch(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    name: String,
) -> Result<GitOperationResult, String> {
    let (project_path, root_path) = {
        let db = state
            .db
            .lock()
            .map_err(|e| format!("DB lock error: {}", e))?;
        let pp = resolve_worktree_path(&db, &session_id, &project_id)?;
        let rp = db
            .get_project(&project_id)
            .map_err(|e| format!("Failed to look up project: {}", e))?
            .map(|r| r.path)
            .unwrap_or_else(|| pp.clone());
        (pp, rp)
    };

    let app_handle = app.clone();
    let session_id_clone = session_id.clone();

    tokio::task::spawn_blocking(move || {
        if !worktree::is_branch_available(&root_path, &name, Some(&project_path)).unwrap_or(true) {
            return Err(format!(
                "Branch '{}' is already checked out in another worktree. Cannot switch to it.",
                name
            ));
        }

        let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;

        // Check for dirty working tree
        let mut opts = StatusOptions::new();
        opts.include_untracked(false);
        let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
        let has_changes = statuses.iter().any(|e| {
            let s = e.status();
            s.contains(git2::Status::INDEX_NEW)
                || s.contains(git2::Status::INDEX_MODIFIED)
                || s.contains(git2::Status::INDEX_DELETED)
                || s.contains(git2::Status::WT_MODIFIED)
                || s.contains(git2::Status::WT_DELETED)
        });
        if has_changes {
            return Err(
                "Cannot checkout: you have uncommitted changes. Commit or stash them first."
                    .to_string(),
            );
        }

        // Try local branch first
        let refname = format!("refs/heads/{}", name);
        if repo.find_reference(&refname).is_ok() {
            repo.set_head(&refname).map_err(|e| e.to_string())?;
            repo.checkout_head(Some(git2::build::CheckoutBuilder::default().safe()))
                .map_err(|e| e.to_string())?;
            let _ = app_handle.emit(&format!("branch-changed-{}", session_id_clone), &name);
            return Ok(GitOperationResult {
                success: true,
                message: format!("Switched to branch '{}'", name),
                error: None,
            });
        }

        // Try creating a local tracking branch from a remote branch
        let remote_refname = format!("refs/remotes/{}", name);
        if let Ok(remote_ref) = repo.find_reference(&remote_refname) {
            let commit = remote_ref.peel_to_commit().map_err(|e| e.to_string())?;
            let local_name = name.split_once('/').map_or(name.as_str(), |(_, rest)| rest);
            if let Some(clash) = worktree::local_branch_clash(&repo, local_name) {
                return Err(worktree::branch_clash_error(local_name, &clash));
            }

            let mut local_branch = repo
                .branch(local_name, &commit, false)
                .map_err(|e| format!("Failed to create tracking branch: {}", e))?;

            local_branch
                .set_upstream(Some(&name))
                .map_err(|e| format!("Failed to set upstream: {}", e))?;

            let local_refname = format!("refs/heads/{}", local_name);
            repo.set_head(&local_refname).map_err(|e| e.to_string())?;
            repo.checkout_head(Some(git2::build::CheckoutBuilder::default().safe()))
                .map_err(|e| e.to_string())?;

            let _ = app_handle.emit(&format!("branch-changed-{}", session_id_clone), local_name);
            return Ok(GitOperationResult {
                success: true,
                message: format!(
                    "Created and switched to branch '{}' tracking '{}'",
                    local_name, name
                ),
                error: None,
            });
        }

        Err(format!("Branch '{}' not found", name))
    })
    .await
    .map_err(|e| format!("git_checkout_branch task panicked: {}", e))?
}

#[tauri::command]
pub fn git_delete_branch(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    name: String,
    force: bool,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &project_id)?;
    drop(db);
    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;

    // Prevent deleting current branch
    let current = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()));
    if current.as_deref() == Some(&name) {
        return Err("Cannot delete the currently checked out branch".to_string());
    }

    let mut branch = repo
        .find_branch(&name, BranchType::Local)
        .map_err(|e| format!("Branch '{}' not found: {}", name, e))?;

    if force {
        // Force delete: rename away then delete ref directly
        let refname = format!("refs/heads/{}", name);
        let mut reference = repo.find_reference(&refname).map_err(|e| e.to_string())?;
        reference
            .delete()
            .map_err(|e| format!("Failed to force delete '{}': {}", name, e))?;
    } else {
        // Like `git branch -d`: a branch whose commits no other branch has
        // is kept, and the person is asked (BRANCH_UNMERGED).
        if let Some(unmerged) = safety::unmerged_commits(&repo, &name)? {
            return Err(unmerged.error());
        }
        branch.delete().map_err(|e| {
            format!(
                "Could not delete {}: {}",
                name,
                worktree::plain_git2_error(&e)
            )
        })?;
    }

    Ok(GitOperationResult {
        success: true,
        message: format!("Deleted branch '{}'", name),
        error: None,
    })
}

// ─── File Explorer Command ──────────────────────────────────────────

#[tauri::command]
pub async fn list_directory(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    relative_path: Option<String>,
) -> Result<Vec<FileEntry>, String> {
    let project_path = {
        let db = state
            .db
            .lock()
            .map_err(|e| format!("DB lock error: {}", e))?;
        resolve_worktree_path(&db, &session_id, &project_id)?
    };

    let task = tokio::task::spawn_blocking(move || {
        let base = std::fs::canonicalize(&project_path)
            .map_err(|e| format!("Invalid project path: {}", e))?;

        let target_dir = match &relative_path {
            Some(rel) if !rel.is_empty() => safe_join(&project_path, rel)?,
            _ => base.clone(),
        };

        if !target_dir.is_dir() {
            return Err(format!("Not a directory: {}", target_dir.display()));
        }

        // Build git status map — exclude ignored files (.gitignore)
        let mut git_status_map = std::collections::HashMap::new();
        if let Ok(repo) = Repository::open(&project_path) {
            let mut opts = StatusOptions::new();
            opts.include_untracked(true)
                .recurse_untracked_dirs(true)
                .include_ignored(false);
            if let Ok(statuses) = repo.statuses(Some(&mut opts)) {
                for entry in statuses.iter() {
                    if git_status_map.len() >= VCS_STATUS_FILE_CAP {
                        log::warn!(
                            "list_directory status for '{}' exceeded {} entries — truncating.",
                            project_path,
                            VCS_STATUS_FILE_CAP
                        );
                        break;
                    }
                    let s = entry.status();
                    if s.is_empty() {
                        continue;
                    }
                    if let Some(path) = entry.path() {
                        let status_str = if s.contains(git2::Status::CONFLICTED) {
                            "conflicted"
                        } else if s.contains(git2::Status::WT_NEW)
                            || s.contains(git2::Status::INDEX_NEW)
                        {
                            "added"
                        } else if s.contains(git2::Status::WT_DELETED)
                            || s.contains(git2::Status::INDEX_DELETED)
                        {
                            "deleted"
                        } else if s.contains(git2::Status::WT_RENAMED)
                            || s.contains(git2::Status::INDEX_RENAMED)
                        {
                            "renamed"
                        } else if s.contains(git2::Status::WT_MODIFIED)
                            || s.contains(git2::Status::INDEX_MODIFIED)
                        {
                            "modified"
                        } else {
                            "untracked"
                        };
                        git_status_map.insert(path.to_string(), status_str.to_string());
                    }
                }
            }
        }

        let mut entries = Vec::new();
        let dir_entries = std::fs::read_dir(&target_dir)
            .map_err(|e| format!("Failed to read directory: {}", e))?;

        for entry in dir_entries {
            let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
            let file_name = entry.file_name().to_string_lossy().to_string();

            if file_name == ".git" {
                continue;
            }

            let metadata = entry
                .metadata()
                .map_err(|e| format!("Failed to get metadata: {}", e))?;
            let is_dir = metadata.is_dir();
            let is_hidden = file_name.starts_with('.');

            let full_path = entry.path();
            let rel_path = full_path
                .strip_prefix(&base)
                .unwrap_or(&full_path)
                .to_string_lossy()
                .to_string()
                .replace('\\', "/");

            let size = if is_dir { None } else { Some(metadata.len()) };

            let git_status = if is_dir {
                let prefix = if rel_path.ends_with('/') {
                    rel_path.clone()
                } else {
                    format!("{}/", rel_path)
                };
                let has_status = git_status_map.keys().any(|k| k.starts_with(&prefix));
                if has_status {
                    Some("modified".to_string())
                } else {
                    None
                }
            } else {
                git_status_map.get(&rel_path).cloned()
            };

            entries.push(FileEntry {
                name: file_name,
                path: rel_path,
                is_dir,
                is_hidden,
                size,
                git_status,
            });
        }

        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        Ok(entries)
    });

    match tokio::time::timeout(std::time::Duration::from_secs(30), task).await {
        Ok(join_result) => join_result.map_err(|e| format!("list_directory task panicked: {}", e))?,
        Err(_) => Err("list_directory timed out after 30s — the repository may be very large or the filesystem is slow".to_string()),
    }
}

// ─── Stash Data Models ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitStashEntry {
    pub index: usize,
    pub message: String,
    pub timestamp: u64,
    pub branch_name: String,
}

fn parse_stash_branch(message: &str) -> String {
    // Parse "WIP on main: abc1234 ..." or "On main: ..." format
    if let Some(rest) = message
        .strip_prefix("WIP on ")
        .or_else(|| message.strip_prefix("On "))
    {
        if let Some(colon_pos) = rest.find(':') {
            return rest[..colon_pos].to_string();
        }
    }
    "unknown".to_string()
}

// ─── Stash Commands ─────────────────────────────────────────────────

#[tauri::command]
pub fn git_stash_list(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
) -> Result<Vec<GitStashEntry>, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &project_id)?;
    drop(db);
    let mut repo = Repository::open(&project_path).map_err(|e| e.to_string())?;

    // Collect raw data first (can't borrow repo inside stash_foreach closure)
    let mut raw: Vec<(usize, String, git2::Oid)> = Vec::new();
    repo.stash_foreach(|index, message, oid| {
        raw.push((index, message.to_string(), *oid));
        true
    })
    .map_err(|e| e.to_string())?;

    // Now resolve timestamps with separate repo borrows
    let entries: Vec<GitStashEntry> = raw
        .into_iter()
        .map(|(index, msg, oid)| {
            let timestamp = repo
                .find_commit(oid)
                .map(|c| c.time().seconds().max(0) as u64)
                .unwrap_or(0);
            let branch_name = parse_stash_branch(&msg);
            GitStashEntry {
                index,
                message: msg,
                timestamp,
                branch_name,
            }
        })
        .collect();

    Ok(entries)
}

#[tauri::command]
pub fn git_stash_save(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    message: Option<String>,
    include_untracked: Option<bool>,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &project_id)?;
    drop(db);
    let mut repo = Repository::open(&project_path).map_err(|e| e.to_string())?;

    let sig = repo.signature().map_err(|e| e.to_string())?;
    let msg = message.as_deref().unwrap_or("WIP");
    let mut flags = git2::StashFlags::DEFAULT;
    if include_untracked.unwrap_or(true) {
        flags |= git2::StashFlags::INCLUDE_UNTRACKED;
    }

    repo.stash_save(&sig, msg, Some(flags))
        .map_err(|e| format!("Stash failed: {}", e))?;

    Ok(GitOperationResult {
        success: true,
        message: format!("Stashed: {}", msg),
        error: None,
    })
}

#[tauri::command]
pub fn git_stash_apply(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    index: usize,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &project_id)?;
    drop(db);
    let mut repo = Repository::open(&project_path).map_err(|e| e.to_string())?;

    let mut opts = git2::StashApplyOptions::new();
    repo.stash_apply(index, Some(&mut opts))
        .map_err(|e| format!("Stash apply failed: {}", e))?;

    Ok(GitOperationResult {
        success: true,
        message: format!("Applied stash@{{{}}}", index),
        error: None,
    })
}

#[tauri::command]
pub fn git_stash_pop(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    index: usize,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &project_id)?;
    drop(db);
    let mut repo = Repository::open(&project_path).map_err(|e| e.to_string())?;

    let mut opts = git2::StashApplyOptions::new();
    repo.stash_pop(index, Some(&mut opts))
        .map_err(|e| format!("Stash pop failed: {}", e))?;

    Ok(GitOperationResult {
        success: true,
        message: format!("Popped stash@{{{}}}", index),
        error: None,
    })
}

#[tauri::command]
pub fn git_stash_drop(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    index: usize,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &project_id)?;
    drop(db);
    let mut repo = Repository::open(&project_path).map_err(|e| e.to_string())?;

    repo.stash_drop(index)
        .map_err(|e| format!("Stash drop failed: {}", e))?;

    Ok(GitOperationResult {
        success: true,
        message: format!("Dropped stash@{{{}}}", index),
        error: None,
    })
}

#[tauri::command]
pub fn git_stash_clear(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &project_id)?;
    drop(db);
    let mut repo = Repository::open(&project_path).map_err(|e| e.to_string())?;

    // Count stashes first
    let mut count = 0usize;
    repo.stash_foreach(|_, _, _| {
        count += 1;
        true
    })
    .map_err(|e| format!("Failed to enumerate stashes: {}", e))?;

    // Drop from index 0 repeatedly
    for _ in 0..count {
        repo.stash_drop(0)
            .map_err(|e| format!("Stash clear failed: {}", e))?;
    }

    Ok(GitOperationResult {
        success: true,
        message: format!("Cleared {} stash(es)", count),
        error: None,
    })
}

// ─── Log / History Data Models ──────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitLogEntry {
    pub hash: String,
    pub short_hash: String,
    pub author_name: String,
    pub author_email: String,
    pub timestamp: u64,
    pub message: String,
    pub summary: String,
    pub parent_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitLogResult {
    pub entries: Vec<GitLogEntry>,
    pub has_more: bool,
    pub total_traversed: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitCommitFile {
    pub path: String,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub old_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitCommitDetail {
    pub hash: String,
    pub short_hash: String,
    pub author_name: String,
    pub author_email: String,
    pub timestamp: u64,
    pub message: String,
    pub parent_count: usize,
    pub files: Vec<GitCommitFile>,
    pub total_additions: u32,
    pub total_deletions: u32,
}

// ─── Log / History Commands ─────────────────────────────────────────

#[tauri::command]
pub async fn git_log(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<GitLogResult, String> {
    let project_path = {
        let db = state
            .db
            .lock()
            .map_err(|e| format!("DB lock error: {}", e))?;
        resolve_worktree_path(&db, &session_id, &project_id)?
    };

    tokio::task::spawn_blocking(move || {
        let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;
        let limit = limit.unwrap_or(50);
        let offset = offset.unwrap_or(0);

        let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
        revwalk
            .push_head()
            .map_err(|_| "No commits in repository".to_string())?;
        revwalk
            .set_sorting(git2::Sort::TIME | git2::Sort::TOPOLOGICAL)
            .map_err(|e| e.to_string())?;

        let mut entries = Vec::new();
        let mut total_traversed = 0usize;
        let mut has_more = false;

        for oid_result in revwalk {
            let oid = oid_result.map_err(|e| e.to_string())?;
            total_traversed += 1;

            if total_traversed <= offset {
                continue;
            }

            if entries.len() >= limit {
                has_more = true;
                break;
            }

            let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
            let hash = oid.to_string();
            let short_hash = hash[..8.min(hash.len())].to_string();

            entries.push(GitLogEntry {
                hash,
                short_hash,
                author_name: commit.author().name().unwrap_or("").to_string(),
                author_email: commit.author().email().unwrap_or("").to_string(),
                timestamp: commit.time().seconds().max(0) as u64,
                message: commit.message().unwrap_or("").to_string(),
                summary: commit.summary().unwrap_or("").to_string(),
                parent_count: commit.parent_count(),
            });
        }

        Ok(GitLogResult {
            entries,
            has_more,
            total_traversed,
        })
    })
    .await
    .map_err(|e| format!("git_log task panicked: {}", e))?
}

#[tauri::command]
pub fn git_commit_detail(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    commit_hash: String,
) -> Result<GitCommitDetail, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &project_id)?;
    drop(db);
    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;
    let oid =
        git2::Oid::from_str(&commit_hash).map_err(|e| format!("Invalid commit hash: {}", e))?;
    let commit = repo
        .find_commit(oid)
        .map_err(|e| format!("Commit not found: {}", e))?;

    let tree = commit.tree().map_err(|e| e.to_string())?;

    // Diff against first parent (or empty tree for root commits)
    let parent_tree = if commit.parent_count() > 0 {
        Some(
            commit
                .parent(0)
                .map_err(|e| e.to_string())?
                .tree()
                .map_err(|e| e.to_string())?,
        )
    } else {
        None
    };

    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
        .map_err(|e| e.to_string())?;

    let mut files = Vec::new();
    let mut total_additions = 0u32;
    let mut total_deletions = 0u32;

    for (idx, delta) in diff.deltas().enumerate() {
        let status_str = match delta.status() {
            git2::Delta::Added => "added",
            git2::Delta::Deleted => "deleted",
            git2::Delta::Modified => "modified",
            git2::Delta::Renamed => "renamed",
            git2::Delta::Copied => "copied",
            _ => "modified",
        };

        let path = delta
            .new_file()
            .path()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let old_path = if delta.status() == git2::Delta::Renamed {
            delta
                .old_file()
                .path()
                .map(|p| p.to_string_lossy().to_string())
        } else {
            None
        };

        // Get per-file stats
        let mut additions = 0u32;
        let mut deletions = 0u32;
        if let Ok(Some(patch)) = git2::Patch::from_diff(&diff, idx) {
            let (_, adds, dels) = patch.line_stats().unwrap_or((0, 0, 0));
            additions = adds as u32;
            deletions = dels as u32;
        }
        total_additions += additions;
        total_deletions += deletions;

        files.push(GitCommitFile {
            path,
            status: status_str.to_string(),
            additions,
            deletions,
            old_path,
        });
    }

    let hash = oid.to_string();
    let short_hash = hash[..8.min(hash.len())].to_string();
    let author_name = commit.author().name().unwrap_or("").to_string();
    let author_email = commit.author().email().unwrap_or("").to_string();
    let timestamp = commit.time().seconds().max(0) as u64;
    let message = commit.message().unwrap_or("").to_string();
    let parent_count = commit.parent_count();

    Ok(GitCommitDetail {
        hash,
        short_hash,
        author_name,
        author_email,
        timestamp,
        message,
        parent_count,
        files,
        total_additions,
        total_deletions,
    })
}

// ─── Merge Conflict Data Models ─────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MergeStatus {
    pub in_merge: bool,
    pub conflicted_files: Vec<String>,
    pub resolved_files: Vec<String>,
    pub total_conflicts: u32,
    pub merge_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictContent {
    pub path: String,
    pub base: Option<String>,
    pub ours: String,
    pub theirs: String,
    pub working_tree: String,
    pub is_binary: bool,
}

// ─── Merge Conflict Commands ────────────────────────────────────────

#[tauri::command]
pub fn git_merge_status(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
) -> Result<MergeStatus, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &project_id)?;
    drop(db);
    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;

    let in_merge = repo.state() == git2::RepositoryState::Merge;

    if !in_merge {
        return Ok(MergeStatus {
            in_merge: false,
            conflicted_files: Vec::new(),
            resolved_files: Vec::new(),
            total_conflicts: 0,
            merge_message: None,
        });
    }

    let index = repo.index().map_err(|e| e.to_string())?;
    let mut conflicted_files = Vec::new();

    // Collect conflicted paths from index
    for conflict in index.conflicts().map_err(|e| e.to_string())? {
        let conflict = conflict.map_err(|e| e.to_string())?;
        let path = conflict
            .our
            .as_ref()
            .or(conflict.their.as_ref())
            .or(conflict.ancestor.as_ref())
            .and_then(|entry| std::str::from_utf8(&entry.path).ok())
            .unwrap_or("")
            .to_string();
        if !path.is_empty() {
            conflicted_files.push(path);
        }
    }

    // Determine which files were involved in the merge by diffing HEAD vs MERGE_HEAD
    let mut merge_involved_paths = std::collections::HashSet::new();
    if let Ok(merge_head_ref) = repo.find_reference("MERGE_HEAD") {
        if let Some(merge_head_oid) = merge_head_ref.target() {
            if let Ok(merge_commit) = repo.find_commit(merge_head_oid) {
                if let Ok(merge_tree) = merge_commit.tree() {
                    if let Ok(head_ref) = repo.head() {
                        if let Ok(head_commit) = head_ref.peel_to_commit() {
                            if let Ok(head_tree) = head_commit.tree() {
                                if let Ok(diff) = repo.diff_tree_to_tree(
                                    Some(&head_tree),
                                    Some(&merge_tree),
                                    None,
                                ) {
                                    for delta in diff.deltas() {
                                        if let Some(p) = delta.new_file().path() {
                                            merge_involved_paths
                                                .insert(p.to_string_lossy().to_string());
                                        }
                                        if let Some(p) = delta.old_file().path() {
                                            merge_involved_paths
                                                .insert(p.to_string_lossy().to_string());
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Resolved = files that were staged (INDEX_MODIFIED/INDEX_NEW), part of the merge,
    // and no longer in the conflicted list
    let mut resolved_files = Vec::new();
    let mut status_opts = StatusOptions::new();
    status_opts.include_untracked(false);
    if let Ok(statuses) = repo.statuses(Some(&mut status_opts)) {
        for entry in statuses.iter() {
            let s = entry.status();
            if s.contains(git2::Status::INDEX_MODIFIED) || s.contains(git2::Status::INDEX_NEW) {
                if let Some(path) = entry.path() {
                    let path_str = path.to_string();
                    if !conflicted_files.contains(&path_str)
                        && merge_involved_paths.contains(&path_str)
                    {
                        resolved_files.push(path_str);
                    }
                }
            }
        }
    }

    let total_conflicts = (conflicted_files.len() + resolved_files.len()) as u32;

    let merge_message = repo.message().ok();

    Ok(MergeStatus {
        in_merge,
        conflicted_files,
        resolved_files,
        total_conflicts,
        merge_message,
    })
}

#[tauri::command]
pub fn git_get_conflict_content(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    file_path: String,
) -> Result<ConflictContent, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &project_id)?;
    drop(db);
    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;
    let index = repo.index().map_err(|e| e.to_string())?;

    // Find the conflict entry for this path
    let mut found = None;
    for conflict in index.conflicts().map_err(|e| e.to_string())? {
        let conflict = conflict.map_err(|e| e.to_string())?;
        let path = conflict
            .our
            .as_ref()
            .or(conflict.their.as_ref())
            .or(conflict.ancestor.as_ref())
            .and_then(|entry| std::str::from_utf8(&entry.path).ok())
            .unwrap_or("")
            .to_string();
        if path == file_path {
            found = Some(conflict);
            break;
        }
    }

    let conflict = found.ok_or_else(|| format!("No conflict found for '{}'", file_path))?;

    let read_blob = |entry: &Option<git2::IndexEntry>| -> Result<Option<String>, String> {
        match entry {
            Some(e) => {
                let blob = repo.find_blob(e.id).map_err(|err| err.to_string())?;
                if blob.is_binary() {
                    return Ok(None);
                }
                Ok(Some(
                    std::str::from_utf8(blob.content())
                        .map_err(|e| e.to_string())?
                        .to_string(),
                ))
            }
            None => Ok(None),
        }
    };

    let is_binary_entry = |entry: &Option<git2::IndexEntry>| -> bool {
        match entry {
            Some(e) => repo.find_blob(e.id).map(|b| b.is_binary()).unwrap_or(false),
            None => false,
        }
    };

    let is_binary = is_binary_entry(&conflict.our) || is_binary_entry(&conflict.their);

    let base = read_blob(&conflict.ancestor).unwrap_or(None);
    let ours = read_blob(&conflict.our).unwrap_or(None).unwrap_or_default();
    let theirs = read_blob(&conflict.their)
        .unwrap_or(None)
        .unwrap_or_default();

    // Read working tree file (with conflict markers)
    let full_path = safe_join(&project_path, &file_path)?;
    let working_tree = std::fs::read_to_string(&full_path).unwrap_or_else(|_| String::new());

    Ok(ConflictContent {
        path: file_path,
        base,
        ours,
        theirs,
        working_tree,
        is_binary,
    })
}

#[tauri::command]
pub fn git_resolve_conflict(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    file_path: String,
    strategy: String,
    manual_content: Option<String>,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &project_id)?;
    drop(db);
    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;
    let full_path = safe_join(&project_path, &file_path)?;

    match strategy.as_str() {
        "ours" | "theirs" => {
            let index = repo.index().map_err(|e| e.to_string())?;
            let is_ours = strategy == "ours";

            // Single conflict lookup for both strategies
            let mut target_content = None;
            for conflict in index.conflicts().map_err(|e| e.to_string())? {
                let conflict = conflict.map_err(|e| e.to_string())?;
                let entry = if is_ours {
                    &conflict.our
                } else {
                    &conflict.their
                };
                if let Some(ref e) = entry {
                    let path = std::str::from_utf8(&e.path).map_err(|err| err.to_string())?;
                    if path == file_path {
                        let blob = repo.find_blob(e.id).map_err(|err| err.to_string())?;
                        target_content = Some(blob.content().to_vec());
                        break;
                    }
                }
            }
            let content = target_content.ok_or_else(|| {
                format!("Could not find '{}' version for '{}'", strategy, file_path)
            })?;
            std::fs::write(&full_path, &content)
                .map_err(|e| format!("Failed to write file: {}", e))?;
        }
        "manual" => {
            if let Some(content) = manual_content {
                std::fs::write(&full_path, content.as_bytes())
                    .map_err(|e| format!("Failed to write file: {}", e))?;
            }
            // If no manual_content, accept working tree as-is
        }
        _ => return Err(format!("Unknown strategy: {}", strategy)),
    }

    // Mark as resolved by adding to index (single index read for resolve step)
    let mut index = repo.index().map_err(|e| e.to_string())?;
    index
        .add_path(Path::new(&file_path))
        .map_err(|e| format!("Failed to mark as resolved: {}", e))?;
    index.write().map_err(|e| e.to_string())?;

    Ok(GitOperationResult {
        success: true,
        message: format!("Resolved '{}' using {}", file_path, strategy),
        error: None,
    })
}

#[tauri::command]
pub fn git_abort_merge(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &project_id)?;
    drop(db);
    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;

    if repo.state() != git2::RepositoryState::Merge {
        return Err("No merge in progress".to_string());
    }
    drop(repo);

    // `git merge --abort`, not a hard reset: the files the merge changed go
    // back, every other uncommitted edit stays. git's refusal is shown.
    safety::abort_merge(Path::new(&project_path))?;

    Ok(GitOperationResult {
        success: true,
        message: "Merge aborted".to_string(),
        error: None,
    })
}

#[tauri::command]
pub fn git_continue_merge(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    message: Option<String>,
    author_name: Option<String>,
    author_email: Option<String>,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &project_id)?;
    drop(db);
    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;

    if repo.state() != git2::RepositoryState::Merge {
        return Err("No merge in progress".to_string());
    }

    let mut index = repo.index().map_err(|e| e.to_string())?;
    if index.has_conflicts() {
        return Err("Cannot complete merge: unresolved conflicts remain".to_string());
    }

    let sig = match (&author_name, &author_email) {
        (Some(name), Some(email)) if !name.is_empty() && !email.is_empty() => {
            git2::Signature::now(name, email).map_err(|e| e.to_string())?
        }
        _ => repo.signature().map_err(|e| e.to_string())?,
    };

    let merge_msg = message
        .or_else(|| repo.message().ok())
        .unwrap_or_else(|| "Merge commit".to_string());

    let tree_oid = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;

    let head_commit = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|e| format!("Cannot resolve HEAD: {}", e))?;

    // Read MERGE_HEAD
    let merge_head_ref = repo
        .find_reference("MERGE_HEAD")
        .map_err(|e| format!("Cannot find MERGE_HEAD: {}", e))?;
    let merge_head_oid = merge_head_ref
        .target()
        .ok_or_else(|| "MERGE_HEAD is not a direct reference".to_string())?;
    let merge_commit = repo
        .find_commit(merge_head_oid)
        .map_err(|e| format!("Cannot find merge commit: {}", e))?;

    repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        &merge_msg,
        &tree,
        &[&head_commit, &merge_commit],
    )
    .map_err(|e| format!("Merge commit failed: {}", e))?;

    repo.cleanup_state()
        .map_err(|e| format!("Cleanup failed: {}", e))?;

    Ok(GitOperationResult {
        success: true,
        message: "Merge completed".to_string(),
        error: None,
    })
}

// ─── Project Search Data Models ─────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchMatch {
    pub line_number: u32,
    pub line_content: String,
    pub match_start: u32,
    pub match_end: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchFileResult {
    pub path: String,
    pub matches: Vec<SearchMatch>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResponse {
    pub results: Vec<SearchFileResult>,
    pub total_matches: u32,
    pub truncated: bool,
}

// ─── Project Search Command ─────────────────────────────────────────

#[tauri::command]
pub fn search_project(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    query: String,
    is_regex: bool,
    case_sensitive: bool,
    max_results: Option<u32>,
) -> Result<SearchResponse, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &project_id)?;
    drop(db);
    let cap = max_results.unwrap_or(500) as usize;

    if query.is_empty() {
        return Ok(SearchResponse {
            results: Vec::new(),
            total_matches: 0,
            truncated: false,
        });
    }

    // Build regex from query
    let pattern = if is_regex {
        if case_sensitive {
            query.clone()
        } else {
            format!("(?i){}", query)
        }
    } else {
        let escaped = regex::escape(&query);
        if case_sensitive {
            escaped
        } else {
            format!("(?i){}", escaped)
        }
    };
    let re = regex::Regex::new(&pattern).map_err(|e| format!("Invalid regex: {}", e))?;

    let mut results: Vec<SearchFileResult> = Vec::new();
    let mut total_matches: usize = 0;
    let mut truncated = false;

    let walker = ignore::WalkBuilder::new(&project_path)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .build();

    const MAX_FILE_SIZE: u64 = 1_048_576; // 1MB

    for entry in walker {
        if truncated {
            break;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();

        // Skip directories
        if path.is_dir() {
            continue;
        }

        // Skip files > 1MB
        if let Ok(meta) = path.metadata() {
            if meta.len() > MAX_FILE_SIZE {
                continue;
            }
        }

        // Read file, skip binary/non-UTF-8
        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let mut file_matches: Vec<SearchMatch> = Vec::new();
        for (line_idx, line) in content.lines().enumerate() {
            for mat in re.find_iter(line) {
                // Convert byte offsets to char offsets so JS String.slice() works correctly
                // for non-ASCII content (UTF-8 byte positions ≠ UTF-16 code unit positions).
                let char_start = line[..mat.start()].chars().count() as u32;
                let char_end = line[..mat.end()].chars().count() as u32;
                file_matches.push(SearchMatch {
                    line_number: (line_idx + 1) as u32,
                    line_content: line.to_string(),
                    match_start: char_start,
                    match_end: char_end,
                });
                total_matches += 1;
                if total_matches >= cap {
                    truncated = true;
                    break;
                }
            }
            if truncated {
                break;
            }
        }

        if !file_matches.is_empty() {
            // Compute relative path
            let rel = path
                .strip_prefix(&project_path)
                .unwrap_or(path)
                .to_string_lossy()
                .to_string();
            results.push(SearchFileResult {
                path: rel,
                matches: file_matches,
            });
        }
    }

    Ok(SearchResponse {
        results,
        total_matches: total_matches as u32,
        truncated,
    })
}

// ─── Worktree IPC Commands ──────────────────────────────────────────

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command: one argument per IPC field
pub fn git_create_worktree(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    branch_name: String,
    create_branch: bool,
    from_remote: Option<String>,
    // Set by the frontend while the "diskGuard" feature flag is on.
    enforce_disk_guard: Option<bool>,
    base_branch: Option<String>,
) -> Result<worktree::WorktreeCreateResult, String> {
    // Get the app data directory for storing worktrees outside the project
    let app_data_dir = crate::instance::app_data_dir(&app)?;

    // 1. Get project path from DB
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project = db
        .get_project(&project_id)
        .map_err(|e| format!("Failed to look up project: {}", e))?
        .ok_or_else(|| format!("Project '{}' not found", project_id))?;
    let root_path = project.path.clone();
    drop(db);

    // Disk guard: below 10 GB free, create nothing (no folder, branch,
    // journal entry or record) and raise an inbox item. Reusing a worktree
    // that already exists (this session's, or the branch checked out
    // elsewhere) needs no space, so that is never refused.
    if enforce_disk_guard.unwrap_or(false) {
        let reuses = worktree::would_reuse_existing_worktree(
            &app_data_dir,
            &root_path,
            &session_id,
            &branch_name,
            from_remote.as_deref(),
        );
        if !reuses {
            if let Err(low) = disk_guard::check_room_for_worktree(&app_data_dir) {
                log::warn!("[disk-guard] refused a worktree: {}", low.message());
                let _ = app.emit(disk_guard::INBOX_ITEM_EVENT, low.inbox_item(&project.name));
                return Err(low.message());
            }
        }
    }

    // Journal: log the CREATE operation before performing it
    let intended_path =
        worktree::worktree_path_for_session(&app_data_dir, &root_path, &session_id, &branch_name);
    let _ = journal::log_operation(
        &app_data_dir,
        &root_path,
        "CREATE",
        &session_id,
        &project_id,
        &branch_name,
        &intended_path.to_string_lossy(),
    );

    let cut_from = cut_from_branch(
        &root_path,
        create_branch,
        from_remote.as_deref(),
        base_branch.as_deref(),
    );

    // 2. Create the worktree. A branch that is checked out elsewhere comes
    //    back as a BRANCH_IN_USE error, enriched with who holds it.
    let result = worktree::create_worktree_from(
        &app_data_dir,
        &root_path,
        &session_id,
        &branch_name,
        create_branch,
        from_remote.as_deref(),
        base_branch.as_deref(),
    )
    .map_err(|e| describe_branch_in_use(&state.db, &root_path, e))?;

    // 3. Insert into session_worktrees table — if this fails, roll back the worktree
    let id = uuid::Uuid::new_v4().to_string();
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    if let Err(db_err) = db.insert_session_worktree(
        &id,
        &session_id,
        &project_id,
        &result.worktree_path,
        Some(&result.branch_name),
        result.is_main_worktree,
    ) {
        // Rollback: remove the worktree we just created
        log::warn!("DB insert failed for worktree, rolling back: {}", db_err);
        if !result.is_main_worktree {
            let _ = worktree::remove_worktree(&root_path, &session_id, &result.worktree_path);
        }
        return Err(format!("Failed to record worktree: {}", db_err));
    }
    if let Some(base) = base_to_record(cut_from.as_deref(), &result.branch_name) {
        if let Err(e) = worktree::record_base_branch(&root_path, &result.branch_name, base) {
            log::warn!("Could not keep the base branch in the repository config: {e}");
        }
        if let Err(e) = db.set_worktree_base_branch(&id, base) {
            log::warn!(
                "Could not record the base branch of {}: {}",
                result.branch_name,
                e
            );
        }
    }
    drop(db);

    // Journal: mark CREATE as completed after successful creation + DB insert
    let _ = journal::log_completed(
        &app_data_dir,
        &root_path,
        "CREATE",
        &session_id,
        &project_id,
    );

    // 4. Emit event for frontend
    let _ = app.emit(&format!("worktree-created-{}", project_id), &result);

    // 5. Return result
    Ok(result)
}

/// The branch a new branch is cut from: the launcher's base, else what
/// the project folder has checked out right now. Land lands into it.
/// None when no branch is made here (an existing or remote branch).
fn cut_from_branch(
    root_path: &str,
    create_branch: bool,
    from_remote: Option<&str>,
    base_branch: Option<&str>,
) -> Option<String> {
    if !(create_branch && from_remote.is_none()) {
        return None;
    }
    base_branch.map(str::to_string).or_else(|| {
        Repository::open(root_path).ok().and_then(|r| {
            r.head()
                .ok()
                .filter(|h| h.is_branch())
                .and_then(|h| h.shorthand().map(str::to_string))
        })
    })
}

/// The base branch worth recording for `branch`: never the branch itself.
fn base_to_record<'a>(cut_from: Option<&'a str>, branch: &str) -> Option<&'a str> {
    cut_from.filter(|b| *b != branch)
}

/// Add who holds the branch to a `BRANCH_IN_USE:` error: the session whose
/// worktree has it (if Hermes made that worktree) and whether it is the
/// project folder itself. Any other error passes through unchanged.
fn describe_branch_in_use(db: &std::sync::Mutex<Database>, root_path: &str, err: String) -> String {
    let Some((branch, path)) = worktree::parse_branch_in_use_error(&err) else {
        return err;
    };
    let session_id = db.lock().ok().and_then(|db| {
        db.get_all_session_worktrees()
            .ok()?
            .into_iter()
            .find(|row| worktree::same_dir(&row.worktree_path, &path))
            .map(|row| row.session_id)
    });
    // A checkout in this Hermes' own worktree folder that no session uses
    // is a leftover of ours (a launch that failed half-way), not "a
    // checkout outside Hermes".
    let leftover = session_id.is_none()
        && !worktree::same_dir(&path, root_path)
        && worktree::is_instance_worktree_path(&path);
    format!(
        "{}{}",
        worktree::BRANCH_IN_USE_PREFIX,
        serde_json::json!({
            "branch": branch,
            "path": path,
            "sessionId": session_id,
            "projectFolder": worktree::same_dir(&path, root_path),
            "leftover": leftover,
        })
    )
}

/// Link a session to the checkout that already has `branch_name` checked
/// out. Only called after the user explicitly chose "reuse" in the
/// branch-in-use dialog; creating a worktree never does this on its own.
#[tauri::command]
pub fn git_attach_worktree(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    branch_name: String,
) -> Result<worktree::WorktreeCreateResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project = db
        .get_project(&project_id)
        .map_err(|e| format!("Failed to look up project: {}", e))?
        .ok_or_else(|| format!("Project '{}' not found", project_id))?;
    let mut result = worktree::attach_existing_worktree(&project.path, &branch_name)?;
    // Record the checkout exactly as its owner did, so every later
    // comparison (ref-count on close, sharing checks) sees one checkout.
    if let Some(existing) = known_spelling_of_checkout(&db, &project.path, &result.worktree_path)? {
        result.worktree_path = existing;
    }
    let id = uuid::Uuid::new_v4().to_string();
    db.insert_session_worktree(
        &id,
        &session_id,
        &project_id,
        &result.worktree_path,
        Some(&result.branch_name),
        result.is_main_worktree,
    )
    .map_err(|e| format!("Failed to record worktree: {}", e))?;
    drop(db);
    let _ = app.emit(&format!("worktree-created-{}", project_id), &result);
    Ok(result)
}

/// The spelling Hermes already uses for the checkout at `path`: the path an
/// existing session row recorded for it, or the project folder's own path.
/// `None` when Hermes has never recorded that directory.
fn known_spelling_of_checkout(
    db: &Database,
    project_path: &str,
    path: &str,
) -> Result<Option<String>, String> {
    let rows = db
        .get_all_session_worktrees()
        .map_err(|e| format!("Failed to list worktrees: {}", e))?;
    if let Some(row) = rows
        .into_iter()
        .find(|row| worktree::same_dir(&row.worktree_path, path))
    {
        return Ok(Some(row.worktree_path));
    }
    Ok(worktree::same_dir(project_path, path).then(|| project_path.to_string()))
}

/// Whether another session also works in the checkout this session row
/// points at. Closing (or committing from) such a session must leave that
/// checkout and its changes alone: they belong to the other session too.
fn checkout_is_shared(db: &Database, wt: &crate::db::SessionWorktreeRow) -> bool {
    // On a lookup error assume shared: skipping a delete is recoverable,
    // deleting someone else's work is not.
    db.count_sessions_for_worktree_path(&wt.worktree_path)
        .map(|n| n > 1)
        .unwrap_or(true)
}

/// A session's worktree link, plus whether another session shares that
/// checkout (`sharedWithOtherSessions`) and whether the session owns it
/// alone (`ownedBySession`: a worktree Hermes made for it, shared with no
/// one). The close dialog only asks about changes in a checkout the session
/// owns alone; the project folder and a checkout made outside Hermes are
/// never asked about, never cleaned up.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionWorktreeInfo {
    #[serde(flatten)]
    pub row: crate::db::SessionWorktreeRow,
    pub shared_with_other_sessions: bool,
    pub owned_by_session: bool,
    /// Ports and cloned dependencies (fast worktrees), once prepared.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup: Option<fast_setup::WorktreeSetup>,
}

impl SessionWorktreeInfo {
    fn describe(db: &Database, row: crate::db::SessionWorktreeRow) -> Self {
        let shared = !row.is_main_worktree && checkout_is_shared(db, &row);
        let owned = worktree::is_owned_checkout(row.is_main_worktree, &row.worktree_path);
        SessionWorktreeInfo {
            shared_with_other_sessions: shared,
            owned_by_session: owned && !shared,
            setup: db
                .get_worktree_setup(&row.session_id, &row.project_id)
                .ok()
                .and_then(|(base, report)| {
                    fast_setup::WorktreeSetup::from_record(base, report.as_deref())
                }),
            row,
        }
    }
}

/// Drop a session's link to a worktree without touching the disk. Undoes a
/// `git_attach_worktree` when session creation is cancelled: the checkout
/// belongs to someone else, so it must never be removed.
#[tauri::command]
pub fn git_detach_worktree(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
) -> Result<(), String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    if let Some(row) = db
        .get_worktree_by_session_and_project(&session_id, &project_id)
        .map_err(|e| format!("Failed to look up worktree: {}", e))?
    {
        db.delete_session_worktree(&row.id)?;
    }
    Ok(())
}

/// Commit a session worktree's uncommitted changes, for the close dialog:
/// `target = "session"` commits on the session's branch, `"archive"` saves
/// them on a new `hermes-archive/<branch>` branch and leaves the session
/// branch alone. Never touches the stash. Refuses sessions that work
/// directly in the project folder (closing those deletes nothing).
#[tauri::command]
pub fn git_commit_worktree(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    message: String,
    target: worktree::CommitTarget,
    // The branch the close dialog named: the commit lands there or nowhere.
    expected_branch: Option<String>,
) -> Result<worktree::CommitOutcome, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let wt = db
        .get_worktree_by_session_and_project(&session_id, &project_id)
        .map_err(|e| format!("Failed to look up worktree: {}", e))?
        .ok_or_else(|| "This session has no worktree of its own".to_string())?;
    let shared = checkout_is_shared(&db, &wt);
    drop(db);
    if wt.is_main_worktree {
        return Err("This session works in the project folder; nothing to commit on close".into());
    }
    if !worktree::is_owned_checkout(false, &wt.worktree_path) {
        return Err(format!(
            "This session works in a checkout Hermes did not create ({}); its changes stay there",
            wt.worktree_path
        ));
    }
    if shared {
        return Err(
            "Another session works in this checkout; its changes are left for that session".into(),
        );
    }
    worktree::commit_worktree_changes_on(
        &wt.worktree_path,
        &message,
        target,
        &|p| is_dirty_close_noise_file(p),
        expected_branch.as_deref(),
    )
}

/// A worktree this Hermes made for `project_id` that no session uses any
/// more: what the close flow saves from after it stopped the session (the
/// session's link went first, so the close left the folder). Returns the
/// project folder.
fn unused_instance_worktree(
    db: &std::sync::Mutex<Database>,
    project_id: &str,
    worktree_path: &str,
) -> Result<String, String> {
    let db = db.lock().map_err(|e| format!("DB lock error: {}", e))?;
    let project = db
        .get_project(project_id)
        .map_err(|e| format!("Failed to look up project: {}", e))?
        .ok_or_else(|| format!("Project '{}' not found", project_id))?;
    let used = db
        .get_all_session_worktrees()
        .map_err(|e| format!("Failed to list worktrees: {}", e))?
        .into_iter()
        .any(|row| worktree::same_dir(&row.worktree_path, worktree_path));
    drop(db);
    if used {
        return Err("A session still works in that checkout".into());
    }
    if !worktree::is_instance_worktree_path(worktree_path) {
        return Err("That checkout was not made by this Hermes".into());
    }
    let same_repo = Repository::open(worktree_path)
        .ok()
        .zip(Repository::open(&project.path).ok())
        .map(|(w, p)| {
            std::fs::canonicalize(w.commondir()).ok() == std::fs::canonicalize(p.commondir()).ok()
        })
        .unwrap_or(false);
    if !same_repo {
        return Err("That checkout does not belong to this project".into());
    }
    Ok(project.path)
}

/// Close flow, after the session was stopped: commit the uncommitted work
/// of its (now unlinked) worktree on `expected_branch` ("session") or on a
/// new hermes-archive/ branch ("archive"). Nothing to commit is not an
/// error here: the outcome is then None.
#[tauri::command]
pub fn git_commit_kept_worktree(
    state: State<'_, AppState>,
    project_id: String,
    worktree_path: String,
    message: String,
    target: worktree::CommitTarget,
    expected_branch: Option<String>,
) -> Result<Option<worktree::CommitOutcome>, String> {
    commit_kept_worktree(
        &state.db,
        &project_id,
        &worktree_path,
        &message,
        target,
        expected_branch.as_deref(),
    )
}

fn commit_kept_worktree(
    db: &std::sync::Mutex<Database>,
    project_id: &str,
    worktree_path: &str,
    message: &str,
    target: worktree::CommitTarget,
    expected_branch: Option<&str>,
) -> Result<Option<worktree::CommitOutcome>, String> {
    unused_instance_worktree(db, project_id, worktree_path)?;
    match worktree::commit_worktree_changes_on(
        worktree_path,
        message,
        target,
        &|p| is_dirty_close_noise_file(p),
        expected_branch,
    ) {
        Ok(out) => Ok(Some(out)),
        Err(e) if e == "There are no changes to commit" => Ok(None),
        Err(e) => Err(e),
    }
}

/// Close flow, after the session was stopped: keep a detached HEAD's
/// commits (and, with `message`, the uncommitted changes too) on a new
/// `hermes-archive/<branch>-detached` branch. Returns the branch.
#[tauri::command]
pub fn git_save_kept_detached_head(
    state: State<'_, AppState>,
    project_id: String,
    worktree_path: String,
    recorded_branch: Option<String>,
    message: Option<String>,
) -> Result<String, String> {
    save_kept_detached_head(
        &state.db,
        &project_id,
        &worktree_path,
        recorded_branch.as_deref(),
        message.as_deref(),
    )
}

fn save_kept_detached_head(
    db: &std::sync::Mutex<Database>,
    project_id: &str,
    worktree_path: &str,
    recorded_branch: Option<&str>,
    message: Option<&str>,
) -> Result<String, String> {
    unused_instance_worktree(db, project_id, worktree_path)?;
    let name = safety::save_detached_head(Path::new(worktree_path), recorded_branch)?;
    if let Some(message) = message {
        match worktree::commit_worktree_changes_on(
            worktree_path,
            message,
            worktree::CommitTarget::Session,
            &|p| is_dirty_close_noise_file(p),
            Some(&name),
        ) {
            Ok(_) => {}
            Err(e) if e == "There are no changes to commit" => {}
            Err(e) => return Err(e),
        }
    }
    Ok(name)
}

/// Close dialog: "Keep the worktree". The session's link to its worktree
/// goes, so closing the session leaves the folder (and its branch) on disk.
/// Returns the folder that is kept.
#[tauri::command]
pub fn git_keep_worktree(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
) -> Result<String, String> {
    keep_worktree(&state.db, &session_id, &project_id)
}

fn keep_worktree(
    db: &std::sync::Mutex<Database>,
    session_id: &str,
    project_id: &str,
) -> Result<String, String> {
    let db = db.lock().map_err(|e| format!("DB lock error: {}", e))?;
    let Some(row) = db
        .get_worktree_by_session_and_project(session_id, project_id)
        .map_err(|e| format!("Failed to look up worktree: {}", e))?
    else {
        return Err("This session has no worktree of its own".into());
    };
    db.delete_session_worktree(&row.id)?;
    log::info!(
        "[worktree] kept {} on close of session {}",
        row.worktree_path,
        session_id
    );
    Ok(row.worktree_path)
}

/// Branch In Use → "Remove it and retry": remove a worktree this Hermes made
/// that no session uses any more (a launch that failed half-way, or a crash
/// before its record was written). Refuses anything else.
#[tauri::command]
pub fn git_remove_leftover_worktree(
    state: State<'_, AppState>,
    project_id: String,
    worktree_path: String,
    // The session the folder belonged to (names the refs that keep any
    // submodule commits); None for a leftover of a failed launch.
    session_id: Option<String>,
    // The uncommitted work was just archived on a hermes-archive/ branch:
    // what is still uncommitted in the folder is that saved copy.
    archived: Option<bool>,
) -> Result<(), String> {
    remove_leftover_worktree(
        &state.db,
        &project_id,
        &worktree_path,
        session_id.as_deref(),
        archived,
    )
}

fn remove_leftover_worktree(
    db: &std::sync::Mutex<Database>,
    project_id: &str,
    worktree_path: &str,
    session_id: Option<&str>,
    archived: Option<bool>,
) -> Result<(), String> {
    let project_path = unused_instance_worktree(db, project_id, worktree_path)
        .map_err(|e| format!("{e}; it was not removed"))?;
    // Work in it is never thrown away from here.
    if let Ok(repo) = Repository::open(worktree_path) {
        let mut opts = StatusOptions::new();
        opts.include_untracked(true).include_ignored(false);
        let dirty = !archived.unwrap_or(false)
            && repo
                .statuses(Some(&mut opts))
                .map(|s| {
                    s.iter().any(|e| {
                        !e.status().is_empty() && !is_dirty_close_noise_file(e.path().unwrap_or(""))
                    })
                })
                .unwrap_or(true);
        let lost = safety::head_state(Path::new(worktree_path))
            .map(|h| h.lost_commits > 0)
            .unwrap_or(false);
        if dirty || lost {
            return Err(format!(
                "The leftover worktree at {worktree_path} has work in it that is on no branch; it was kept. Open it in a terminal to keep or remove that work."
            ));
        }
    }
    worktree::remove_worktree(
        &project_path,
        session_id.unwrap_or("leftover"),
        worktree_path,
    )?;
    let _ = worktree::cleanup_stale_worktrees(&project_path);
    Ok(())
}

#[tauri::command]
pub fn git_remove_worktree(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
) -> Result<GitOperationResult, String> {
    // 1. Look up worktree from DB
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let wt = db
        .get_worktree_by_session_and_project(&session_id, &project_id)
        .map_err(|e| format!("Failed to look up worktree: {}", e))?
        .ok_or_else(|| {
            format!(
                "No worktree found for session={}, project={}",
                session_id, project_id
            )
        })?;
    let project = db
        .get_project(&project_id)
        .map_err(|e| format!("Failed to look up project: {}", e))?
        .ok_or_else(|| format!("Project '{}' not found", project_id))?;
    let wt_id = wt.id.clone();
    let wt_path = wt.worktree_path.clone();
    let wt_branch = wt.branch_name.clone();
    let root_path = project.path.clone();
    let is_main = wt.is_main_worktree;
    let shared = checkout_is_shared(&db, &wt);

    // SAFETY: never remove the main worktree (it IS the project root)
    if is_main {
        return Err(
            "Cannot remove the main worktree — it is the project root directory".to_string(),
        );
    }

    // SAFETY: a checkout another session also works in stays on disk; only
    // this session's link to it goes.
    if shared {
        db.delete_session_worktree(&wt_id)?;
        return Ok(GitOperationResult {
            success: true,
            message: "Unlinked from a checkout another session still uses".to_string(),
            error: None,
        });
    }
    // SAFETY: a worktree made outside Hermes (reused on purpose) is not ours
    // to delete either; `remove_worktree` would refuse it anyway.
    if !worktree::is_owned_checkout(false, &wt_path) {
        db.delete_session_worktree(&wt_id)?;
        return Ok(GitOperationResult {
            success: true,
            message: format!(
                "Unlinked from the checkout at {} (not made by Hermes)",
                wt_path
            ),
            error: None,
        });
    }
    drop(db);

    // Get the app data directory for journal storage
    let app_data_dir = crate::instance::app_data_dir(&app)?;

    // Journal: log the REMOVE operation before performing it
    let _ = journal::log_operation(
        &app_data_dir,
        &root_path,
        "REMOVE",
        &session_id,
        &project_id,
        "",
        &wt_path,
    );

    // 2. Try to remove the worktree from the filesystem
    let remove_result = worktree::remove_worktree(&root_path, &session_id, &wt_path);

    // 3. Only delete DB record if git removal succeeded (or directory no longer exists)
    let dir_gone = !std::path::Path::new(&wt_path).is_dir();
    if remove_result.is_ok() || dir_gone {
        let db = state
            .db
            .lock()
            .map_err(|e| format!("DB lock error: {}", e))?;
        db.delete_session_worktree(&wt_id)?;
        drop(db);
    } else {
        // Git removal failed and directory still exists — keep DB record for retry
        log::warn!(
            "Git worktree removal failed, keeping DB record for retry: {:?}",
            remove_result.err()
        );
        return Err(
            "Failed to remove worktree from disk; DB record preserved for retry".to_string(),
        );
    }

    // Journal: mark REMOVE as completed after successful removal + DB delete
    let _ = journal::log_completed(
        &app_data_dir,
        &root_path,
        "REMOVE",
        &session_id,
        &project_id,
    );

    // 4. Emit event for frontend
    let _ = app.emit(&format!("worktree-removed-{}", project_id), ());

    // 5. Return result
    let friendly_msg = match &wt_branch {
        Some(branch) => format!("Branch worktree removed for '{}'", branch),
        None => "Branch worktree removed".to_string(),
    };
    Ok(GitOperationResult {
        success: true,
        message: friendly_msg,
        error: None,
    })
}

#[tauri::command]
pub fn git_list_worktrees(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<worktree::WorktreeInfo>, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let worktrees = db.get_worktrees_for_project(&project_id)?;

    let infos: Vec<worktree::WorktreeInfo> = worktrees
        .into_iter()
        .map(|wt| worktree::WorktreeInfo {
            session_id: wt.session_id,
            branch_name: wt.branch_name,
            worktree_path: wt.worktree_path,
            is_main_worktree: wt.is_main_worktree,
        })
        .collect();

    Ok(infos)
}

#[tauri::command]
pub fn git_check_branch_available(
    state: State<'_, AppState>,
    project_id: String,
    branch_name: String,
) -> Result<worktree::BranchAvailability, String> {
    // 1. Get project path
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project = db
        .get_project(&project_id)
        .map_err(|e| format!("Failed to look up project: {}", e))?
        .ok_or_else(|| format!("Project '{}' not found", project_id))?;
    let root_path = project.path.clone();

    // Check if any session worktree is using this branch
    let worktrees = db.get_worktrees_for_project(&project_id)?;
    let used_by = worktrees
        .iter()
        .find(|wt| wt.branch_name.as_deref() == Some(branch_name.as_str()));
    drop(db);

    if let Some(wt) = used_by {
        return Ok(worktree::BranchAvailability {
            available: false,
            used_by_session: Some(wt.session_id.clone()),
            branch_name,
        });
    }

    // 2. Also check via git if the branch is checked out in any worktree
    let available = worktree::is_branch_available(&root_path, &branch_name, None)?;

    Ok(worktree::BranchAvailability {
        available,
        used_by_session: None,
        branch_name,
    })
}

#[tauri::command]
pub fn git_session_worktree_info(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
) -> Result<Option<SessionWorktreeInfo>, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let row = db
        .get_worktree_by_session_and_project(&session_id, &project_id)
        .map_err(|e| format!("Failed to look up worktree: {}", e))?;
    Ok(row.map(|row| SessionWorktreeInfo::describe(&db, row)))
}

#[tauri::command]
pub fn git_list_branches_for_projects(
    state: State<'_, AppState>,
    project_ids: Vec<String>,
) -> Result<HashMap<String, Vec<GitBranch>>, String> {
    // Collect project paths while holding the DB lock, then drop it before git I/O
    let project_paths: Vec<(String, Option<String>)> = {
        let db = state
            .db
            .lock()
            .map_err(|e| format!("DB lock error: {}", e))?;
        project_ids
            .iter()
            .map(|id| {
                let path = db.get_project(id).ok().flatten().map(|r| r.path);
                (id.clone(), path)
            })
            .collect()
    };

    let mut result: HashMap<String, Vec<GitBranch>> = HashMap::new();

    for (project_id, project_path) in &project_paths {
        let project_path = match project_path {
            Some(p) => p,
            None => {
                result.insert(project_id.clone(), Vec::new());
                continue;
            }
        };

        let repo = match Repository::open(project_path) {
            Ok(r) => r,
            Err(_) => {
                result.insert(project_id.clone(), Vec::new());
                continue;
            }
        };

        let mut branches = Vec::new();

        let current_branch = repo
            .head()
            .ok()
            .and_then(|h| h.shorthand().map(|s| s.to_string()));

        if let Ok(local_branches) = repo.branches(Some(BranchType::Local)) {
            for branch_result in local_branches {
                let (branch, _) = match branch_result {
                    Ok(b) => b,
                    Err(_) => continue,
                };
                let name = branch.name().ok().flatten().unwrap_or("").to_string();

                let is_current = current_branch.as_deref() == Some(&name);

                let mut ahead = 0u32;
                let mut behind = 0u32;
                let mut upstream_name = None;

                if let Ok(upstream) = branch.upstream() {
                    upstream_name = upstream.name().ok().flatten().map(|s| s.to_string());
                    if let (Some(local_ref), Some(upstream_ref)) =
                        (branch.get().name(), upstream.get().name())
                    {
                        if let (Ok(local_oid), Ok(remote_oid)) = (
                            repo.refname_to_id(local_ref),
                            repo.refname_to_id(upstream_ref),
                        ) {
                            if let Ok((a, b)) = repo.graph_ahead_behind(local_oid, remote_oid) {
                                ahead = a as u32;
                                behind = b as u32;
                            }
                        }
                    }
                }

                let last_commit_summary = branch
                    .get()
                    .peel_to_commit()
                    .ok()
                    .map(|c| c.summary().unwrap_or("").to_string());

                branches.push(GitBranch {
                    name,
                    is_current,
                    is_remote: false,
                    upstream: upstream_name,
                    ahead,
                    behind,
                    last_commit_summary,
                });
            }
        }

        result.insert(project_id.clone(), branches);
    }

    Ok(result)
}

/// Fetch all remote branches for a project and return the list of remote branches.
///
/// Runs `git fetch --all --prune` with a timeout, then lists remote branches
/// using git2, skipping `origin/HEAD` refs.
#[tauri::command]
pub fn git_fetch_remote_branches(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<GitBranch>, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project = db
        .get_project(&project_id)
        .map_err(|e| format!("Failed to look up project: {}", e))?
        .ok_or_else(|| format!("Project '{}' not found", project_id))?;
    let project_path = project.path.clone();
    drop(db);

    // Run `git fetch --all --prune` with a 5-second timeout.
    // If the fetch takes too long (slow network, auth prompt, etc.) we kill it
    // and fall back to listing whatever remote refs are cached locally.
    match crate::git::cli::git_command()
        .current_dir(&project_path)
        .args(["fetch", "--all", "--prune"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(mut child) => {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        if !status.success() {
                            log::warn!("git fetch exited with non-zero status");
                        }
                        break;
                    }
                    Ok(None) => {
                        if std::time::Instant::now() >= deadline {
                            log::warn!("git fetch timed out after 5s — killing");
                            let _ = child.kill();
                            let _ = child.wait();
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                    Err(e) => {
                        log::warn!("git fetch wait error: {}", e);
                        break;
                    }
                }
            }
        }
        Err(e) => {
            log::warn!("Failed to spawn 'git fetch': {} — using cached refs", e);
        }
    }

    // List remote branches using git2
    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;
    let mut branches = Vec::new();

    let remote_branches = repo
        .branches(Some(BranchType::Remote))
        .map_err(|e| e.to_string())?;

    for branch_result in remote_branches {
        let (branch, _) = branch_result.map_err(|e| e.to_string())?;
        let name = branch
            .name()
            .map_err(|e| e.to_string())?
            .unwrap_or("")
            .to_string();

        // Skip HEAD pointer references like origin/HEAD
        if name.ends_with("/HEAD") {
            continue;
        }

        let last_commit_summary = branch
            .get()
            .peel_to_commit()
            .ok()
            .map(|c| c.summary().unwrap_or("").to_string());

        branches.push(GitBranch {
            name,
            is_current: false,
            is_remote: true,
            upstream: None,
            ahead: 0,
            behind: 0,
            last_commit_summary,
        });
    }

    Ok(branches)
}

#[tauri::command]
pub fn git_is_git_repo(state: State<'_, AppState>, project_id: String) -> Result<bool, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project = db
        .get_project(&project_id)
        .map_err(|e| format!("Failed to look up project: {}", e))?
        .ok_or_else(|| format!("Project '{}' not found", project_id))?;
    drop(db);

    Ok(Repository::open(&project.path).is_ok())
}

// ─── Worktree Dirty Detection & Stash ───────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
pub struct WorktreeChanges {
    pub has_changes: bool,
    pub files: Vec<WorktreeChangedFile>,
    /// The branch HEAD is really on, a detached HEAD's commits that no
    /// branch has, an operation in progress, and submodules with changes
    /// inside: what the close dialog must know besides the files.
    pub head: Option<safety::HeadState>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct WorktreeChangedFile {
    pub path: String,
    pub status: String,
}

fn map_status_flags(s: git2::Status) -> &'static str {
    if s.intersects(git2::Status::WT_TYPECHANGE | git2::Status::INDEX_TYPECHANGE) {
        "typechange"
    } else if s.intersects(git2::Status::WT_RENAMED | git2::Status::INDEX_RENAMED) {
        "renamed"
    } else if s.intersects(git2::Status::WT_DELETED | git2::Status::INDEX_DELETED) {
        "deleted"
    } else if s.intersects(git2::Status::WT_NEW | git2::Status::INDEX_NEW) {
        "added"
    } else {
        "modified"
    }
}

#[tauri::command]
pub fn git_worktree_has_changes(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
) -> Result<WorktreeChanges, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &project_id)?;
    drop(db);
    worktree_changes_at(&project_path)
}

/// What `git_worktree_has_changes` reports for the checkout at `project_path`.
fn worktree_changes_at(project_path: &str) -> Result<WorktreeChanges, String> {
    let repo = Repository::open(project_path).map_err(|e| e.to_string())?;

    // Exclude ignored files (.gitignore) to avoid counting node_modules/ etc.
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);

    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| format!("Failed to get statuses: {}", e))?;

    let mut files = Vec::new();
    for entry in statuses.iter() {
        if files.len() >= VCS_STATUS_FILE_CAP {
            log::warn!(
                "Worktree status for '{}' exceeded {} files — truncating.",
                project_path,
                VCS_STATUS_FILE_CAP
            );
            break;
        }
        let s = entry.status();
        if s.is_empty() {
            continue;
        }
        let file_path = entry.path().unwrap_or("").to_string();
        if is_dirty_close_noise_file(&file_path) {
            // Auto-generated files some CLIs (Aider, etc.) drop into
            // the worktree without the user's intent.  Skipping them
            // from the dirty-close dialog because they're never what
            // the user means to keep when they close a session.
            continue;
        }
        files.push(WorktreeChangedFile {
            path: file_path,
            status: map_status_flags(s).to_string(),
        });
    }

    let head = safety::head_state(Path::new(project_path)).ok();
    // A submodule whose only change is inside it (edits not committed in
    // the submodule) cannot be committed from here: it is listed on its
    // own (head.dirtySubmodules), not as a file to commit — unless its
    // recorded commit changed too.
    if let Some(h) = &head {
        if !h.dirty_submodules.is_empty() {
            let moved: HashSet<String> = repo
                .submodules()
                .map(|subs| {
                    subs.iter()
                        .filter_map(|sm| {
                            let st = repo
                                .submodule_status(sm.name()?, git2::SubmoduleIgnore::None)
                                .ok()?;
                            st.intersects(
                                git2::SubmoduleStatus::WD_MODIFIED
                                    | git2::SubmoduleStatus::INDEX_MODIFIED,
                            )
                            .then(|| sm.path().to_string_lossy().replace('\\', "/"))
                        })
                        .collect()
                })
                .unwrap_or_default();
            files.retain(|f| !h.dirty_submodules.contains(&f.path) || moved.contains(&f.path));
        }
    }

    Ok(WorktreeChanges {
        has_changes: !files.is_empty(),
        files,
        head,
    })
}

/// Returns true when a file is auto-generated noise unrelated to user
/// intent — typically dropped into the worktree by some AI CLI tool
/// (Aider, etc.).  These get filtered from the dirty-close dialog so
/// the user isn't asked about files they never created.
pub(crate) fn is_dirty_close_noise_file(path: &str) -> bool {
    let basename = path.rsplit('/').next().unwrap_or(path);
    matches!(
        basename,
        ".aider.chat.history.md"
            | ".aider.input.history"
            | ".aider.tags.cache.v3"
            | ".aider.llm.history"
            | ".DS_Store"
            | "Thumbs.db"
    )
}

#[tauri::command]
pub fn git_stash_worktree(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    message: Option<String>,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &project_id)?;
    drop(db);

    let mut repo = Repository::open(&project_path).map_err(|e| e.to_string())?;
    let sig = repo.signature().map_err(|e| e.to_string())?;
    let msg = message.as_deref().unwrap_or("WIP");
    let flags = git2::StashFlags::DEFAULT | git2::StashFlags::INCLUDE_UNTRACKED;

    repo.stash_save(&sig, msg, Some(flags))
        .map_err(|e| format!("Stash failed: {}", e))?;

    Ok(GitOperationResult {
        success: true,
        message: format!("Stashed: {}", msg),
        error: None,
    })
}

// ─── Worktree Overview & Cleanup ─────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
pub struct WorktreeOverviewEntry {
    pub worktree_path: String,
    pub branch_name: Option<String>,
    pub session_id: String,
    pub session_label: String,
    pub project_id: String,
    pub project_name: String,
    pub root_path: String,
    pub is_main_worktree: bool,
    pub created_at: String,
    pub last_activity_at: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OrphanWorktree {
    pub worktree_path: String,
    pub branch_name: Option<String>,
    pub kind: String, // "directory_only" or "record_only"
    pub root_path: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CleanupResult {
    pub path: String,
    pub success: bool,
    pub error: Option<String>,
}

#[tauri::command]
pub fn git_list_all_worktrees(
    state: State<'_, AppState>,
) -> Result<Vec<WorktreeOverviewEntry>, String> {
    // 1. Collect all DB data while holding the lock
    let (all_worktrees, project_map) = {
        let db = state
            .db
            .lock()
            .map_err(|e| format!("DB lock error: {}", e))?;

        let worktrees = db.get_all_session_worktrees()?;

        // Collect unique project IDs and look up project info
        let project_ids: HashSet<String> =
            worktrees.iter().map(|wt| wt.project_id.clone()).collect();
        let mut projects: HashMap<String, crate::project::Project> = HashMap::new();
        for project_id in &project_ids {
            if let Ok(Some(project)) = db.get_project(project_id) {
                projects.insert(project_id.clone(), project);
            }
        }

        (worktrees, projects)
    };
    // DB lock is dropped here

    // 2. Get session labels from pty_manager for live sessions
    let session_labels: HashMap<String, String> = {
        let mgr = state
            .pty_manager
            .lock()
            .map_err(|e| format!("PTY manager lock error: {}", e))?;
        mgr.sessions
            .iter()
            .filter_map(|(id, ps)| {
                ps.session
                    .lock()
                    .ok()
                    .map(|s| (id.clone(), s.label.clone()))
            })
            .collect()
    };
    // pty_manager lock is dropped here

    // 3. Build overview entries
    let entries: Vec<WorktreeOverviewEntry> = all_worktrees
        .into_iter()
        .map(|wt| {
            let label_prefix_len = 8.min(wt.session_id.len());
            let session_label = session_labels
                .get(&wt.session_id)
                .cloned()
                .unwrap_or_else(|| format!("Session {}", &wt.session_id[..label_prefix_len]));

            let (project_name, root_path) = project_map
                .get(&wt.project_id)
                .map(|r| (r.name.clone(), r.path.clone()))
                .unwrap_or_else(|| ("Unknown".to_string(), String::new()));

            WorktreeOverviewEntry {
                worktree_path: wt.worktree_path,
                branch_name: wt.branch_name,
                session_id: wt.session_id,
                session_label,
                project_id: wt.project_id,
                project_name,
                root_path,
                is_main_worktree: wt.is_main_worktree,
                created_at: wt.created_at,
                last_activity_at: None,
            }
        })
        .collect();

    Ok(entries)
}

#[tauri::command]
pub fn git_detect_orphan_worktrees(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<OrphanWorktree>, String> {
    let app_data_dir = crate::instance::app_data_dir(&app)?;

    // 1. Collect all DB data while holding the lock
    let (all_records, projects) = {
        let db = state
            .db
            .lock()
            .map_err(|e| format!("DB lock error: {}", e))?;

        let records = db.get_all_session_worktrees().unwrap_or_default();
        let projects = db.get_all_projects().unwrap_or_default();
        (records, projects)
    };
    // DB lock is dropped here

    let record_paths: HashSet<String> = all_records
        .iter()
        .map(|r| {
            r.worktree_path
                .trim_end_matches('/')
                .trim_end_matches('\\')
                .to_string()
        })
        .collect();

    let mut orphans = Vec::new();

    // 2. Check for "record_only" — DB record exists but directory doesn't
    for record in &all_records {
        if !record.is_main_worktree && !std::path::Path::new(&record.worktree_path).is_dir() {
            orphans.push(OrphanWorktree {
                worktree_path: record.worktree_path.clone(),
                branch_name: record.branch_name.clone(),
                kind: "record_only".to_string(),
                root_path: None,
                session_id: Some(record.session_id.clone()),
            });
        }
    }

    // 3. Check for "directory_only" — directory exists but no DB record
    //    Scan each project's worktree hash directory in the app data dir
    for project in &projects {
        let wt_dir = worktree::worktree_dir(&app_data_dir, &project.path);
        if wt_dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&wt_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    // Skip non-directories and the repo_path.txt marker file
                    if !path.is_dir() {
                        continue;
                    }
                    let path_str = path
                        .to_string_lossy()
                        .trim_end_matches('/')
                        .trim_end_matches('\\')
                        .to_string();
                    if !record_paths.contains(&path_str) {
                        // Extract branch name from directory name: {session_prefix}_{branch}
                        let dir_name = path.file_name().unwrap_or_default().to_string_lossy();
                        let branch = dir_name.split_once('_').map(|x| x.1.to_string());
                        orphans.push(OrphanWorktree {
                            worktree_path: path_str,
                            branch_name: branch,
                            kind: "directory_only".to_string(),
                            root_path: Some(project.path.clone()),
                            session_id: None,
                        });
                    }
                }
            }
        }
    }

    Ok(orphans)
}

#[tauri::command]
pub fn git_worktree_disk_usage(worktree_path: String) -> Result<u64, String> {
    // Validate the path is inside a .hermes/worktrees/ directory
    let validated = validate_worktree_path(&worktree_path)?;

    fn dir_size(path: &std::path::Path) -> u64 {
        let mut size = 0;
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    size += dir_size(&path);
                } else if let Ok(meta) = entry.metadata() {
                    size += meta.len();
                }
            }
        }
        size
    }

    if !validated.is_dir() {
        return Err(format!("Directory does not exist: {}", worktree_path));
    }
    Ok(dir_size(&validated))
}

#[tauri::command]
pub fn git_cleanup_orphan_worktrees(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<Vec<CleanupResult>, String> {
    let mut results = Vec::new();

    for path in &paths {
        // Validate the path is inside a .hermes/worktrees/ directory
        let validated = match validate_worktree_path(path) {
            Ok(v) => v,
            Err(e) => {
                results.push(CleanupResult {
                    path: path.clone(),
                    success: false,
                    error: Some(e),
                });
                continue;
            }
        };

        if validated.is_dir() {
            // Try to remove the directory
            match std::fs::remove_dir_all(&validated) {
                Ok(()) => {
                    // Also try to clean up any git worktree metadata.
                    // The repo hash dir contains repo_path.txt to find the repo root.
                    if let Some(hash_dir) = validated.parent() {
                        if let Some(repo_path) = worktree::read_repo_path(hash_dir) {
                            let _ = crate::git::cli::git_command()
                                .arg("-C")
                                .arg(repo_path.trim())
                                .arg("worktree")
                                .arg("prune")
                                .output();
                        }
                    }
                    results.push(CleanupResult {
                        path: path.clone(),
                        success: true,
                        error: None,
                    });
                }
                Err(e) => {
                    results.push(CleanupResult {
                        path: path.clone(),
                        success: false,
                        error: Some(e.to_string()),
                    });
                }
            }
        } else {
            // Directory doesn't exist — clean up DB record if it exists
            let db = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
            let all = db.get_all_session_worktrees().unwrap_or_default();
            for record in &all {
                if record.worktree_path == *path {
                    let _ = db.delete_session_worktree(&record.id);
                }
            }
            drop(db);
            results.push(CleanupResult {
                path: path.clone(),
                success: true,
                error: None,
            });
        }
    }

    Ok(results)
}

// ─── Disk guard & worktree hygiene (feature flag "diskGuard") ───────

#[derive(Debug, Clone, serde::Serialize)]
pub struct DiskStatus {
    /// Free space on the disk holding the worktrees; None if unreadable.
    pub free_bytes: Option<u64>,
    /// Under this, new worktrees are refused.
    pub required_bytes: u64,
    pub below_threshold: bool,
}

#[tauri::command]
pub async fn git_disk_status(app: AppHandle) -> Result<DiskStatus, String> {
    let base = worktree::worktrees_base_dir(&crate::instance::app_data_dir(&app)?);
    let free = tokio::task::spawn_blocking(move || disk_guard::free_space_bytes(&base))
        .await
        .map_err(|e| e.to_string())?
        .ok();
    Ok(DiskStatus {
        free_bytes: free,
        required_bytes: disk_guard::MIN_FREE_BYTES_FOR_WORKTREE,
        below_threshold: free.is_some_and(|f| disk_guard::check_room(f).is_err()),
    })
}

/// A linked worktree folder of this app, or an error. Never the repo root.
fn checked_worktree_folder<R: tauri::Runtime>(
    app: &AppHandle<R>,
    worktree_path: &str,
) -> Result<std::path::PathBuf, String> {
    let base = worktree::worktrees_base_dir(&crate::instance::app_data_dir(app)?);
    let path = std::path::PathBuf::from(worktree_path);
    if disk_guard::is_worktree_folder(&base, &path) {
        Ok(path)
    } else {
        Err(format!(
            "Refusing to operate on '{}': not a Hermes worktree folder",
            worktree_path
        ))
    }
}

#[tauri::command]
pub async fn git_worktree_usage(
    app: AppHandle,
    worktree_path: String,
) -> Result<disk_guard::WorktreeUsage, String> {
    let path = checked_worktree_folder(&app, &worktree_path)?;
    let mut usage = tokio::task::spawn_blocking(move || disk_guard::worktree_usage(&path))
        .await
        .map_err(|e| e.to_string())?;
    usage.path = worktree_path;
    Ok(usage)
}

/// Remove the build output (node_modules, target, dist — only folders git
/// ignores and tracks nothing in) of one worktree. Land and Archive call this
/// once they exist; the Worktrees view calls it on request.
#[tauri::command]
pub async fn git_reclaim_build_output(
    app: AppHandle,
    worktree_path: String,
) -> Result<disk_guard::ReclaimResult, String> {
    let path = checked_worktree_folder(&app, &worktree_path)?;
    let mut result = tokio::task::spawn_blocking(move || disk_guard::reclaim_build_output(&path))
        .await
        .map_err(|e| e.to_string())?;
    result.path = worktree_path;
    log::info!(
        "[disk-guard] removed build output of '{}': {} folders, {} bytes",
        result.path,
        result.removed.len(),
        result.freed_bytes
    );
    Ok(result)
}

/// Worktree paths the database says a session owns.
fn owned_worktree_paths(
    state: &State<'_, AppState>,
) -> Result<HashSet<std::path::PathBuf>, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    Ok(db
        .get_all_session_worktrees()?
        .into_iter()
        .map(|r| std::path::PathBuf::from(r.worktree_path))
        .collect())
}

/// Every worktree folder under this app's `hermes-worktrees/` that no
/// session owns, for every repo — including repos Hermes no longer lists.
#[tauri::command]
pub async fn git_list_orphan_folders(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<disk_guard::OrphanFolder>, String> {
    let base = worktree::worktrees_base_dir(&crate::instance::app_data_dir(&app)?);
    let known = owned_worktree_paths(&state)?;
    tokio::task::spawn_blocking(move || disk_guard::scan_orphan_folders(&base, &known))
        .await
        .map_err(|e| e.to_string())
}

/// Remove the given orphaned worktree folders (see `git_list_orphan_folders`).
/// A path that is not an orphan when this runs is left alone.
#[tauri::command]
pub async fn git_sweep_orphan_folders(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<Vec<disk_guard::SweepResult>, String> {
    let base = worktree::worktrees_base_dir(&crate::instance::app_data_dir(&app)?);
    let known = owned_worktree_paths(&state)?;
    let results = tokio::task::spawn_blocking(move || {
        disk_guard::sweep_orphan_folders(&base, &known, &paths)
    })
    .await
    .map_err(|e| e.to_string())?;
    log::info!(
        "[disk-guard] orphan sweep: {} removed, {} bytes freed",
        results.iter().filter(|r| r.removed).count(),
        results.iter().map(|r| r.freed_bytes).sum::<u64>()
    );
    Ok(results)
}

// ─── Fast worktrees (N17) ───────────────────────────────────────────

/// What preparing this session's worktree recorded, if it was prepared.
fn recorded_setup(
    state: &State<'_, AppState>,
    session_id: &str,
    project_id: &str,
) -> Result<Option<fast_setup::WorktreeSetup>, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let (base, report) = db.get_worktree_setup(session_id, project_id)?;
    Ok(fast_setup::WorktreeSetup::from_record(
        base,
        report.as_deref(),
    ))
}

/// Get a session's new worktree ready to run, before its terminal starts:
/// clone its dependencies and build caches copy-on-write from a checkout
/// with the same lockfile, and give it its own block of ports (its terminal
/// gets them as PORT / HERMES_PORT_BASE / HERMES_PORT_COUNT). Called by the
/// frontend right after the worktree is made, while the "diskGuard" feature
/// flag is on. Preparing twice returns what the first call recorded.
#[tauri::command]
pub async fn git_prepare_worktree(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
) -> Result<fast_setup::WorktreeSetup, String> {
    if let Some(done) = recorded_setup(&state, &session_id, &project_id)? {
        return Ok(done);
    }
    let (row, root_path) = {
        let db = state
            .db
            .lock()
            .map_err(|e| format!("DB lock error: {}", e))?;
        let row = db
            .get_worktree_by_session_and_project(&session_id, &project_id)?
            .ok_or_else(|| format!("No worktree for session '{}'", session_id))?;
        let project = db
            .get_project(&project_id)
            .map_err(|e| format!("Failed to look up project: {}", e))?
            .ok_or_else(|| format!("Project '{}' not found", project_id))?;
        (row, project.path)
    };

    // Ports: the first free block no other worktree recorded, looked for
    // while the dependencies are cloned. The unique index settles a race
    // with another prepare; the loser looks again.
    let pick_ports = |skip: HashSet<u16>| {
        let taken = state
            .db
            .lock()
            .map_err(|e| format!("DB lock error: {}", e))
            .and_then(|db| db.taken_port_bases());
        async move {
            let mut taken = taken?;
            taken.extend(skip);
            tokio::task::spawn_blocking(move || {
                fast_setup::pick_port_block(&taken, &fast_setup::port_is_free)
            })
            .await
            .map_err(|e| e.to_string())
        }
    };

    // Dependencies: only into a worktree folder Hermes made. The project
    // folder is the source, never a target.
    let started = std::time::Instant::now();
    let clone_dependencies = async {
        if row.is_main_worktree {
            return Ok(Vec::new());
        }
        match checked_worktree_folder(&app, &row.worktree_path) {
            Ok(wt) => tokio::task::spawn_blocking(move || {
                fast_setup::prepare_dependencies(Path::new(&root_path), &wt)
            })
            .await
            .map_err(|e| e.to_string()),
            Err(e) => {
                log::info!("[fast-worktrees] dependencies left alone: {}", e);
                Ok(Vec::new())
            }
        }
    };
    let (dependencies, first_ports) = tokio::join!(clone_dependencies, pick_ports(HashSet::new()));
    let dependencies = dependencies?;
    let millis = started.elapsed().as_millis() as u64;

    let mut skip: HashSet<u16> = HashSet::new();
    let mut next_ports = Some(first_ports);
    for _attempt in 0..5 {
        let ports = match next_ports.take() {
            Some(first) => first?,
            None => pick_ports(skip.clone()).await?,
        };
        let setup = fast_setup::WorktreeSetup {
            ports,
            dependencies: dependencies.clone(),
            millis,
        };
        let report = serde_json::to_string(&setup).map_err(|e| e.to_string())?;
        let saved = state
            .db
            .lock()
            .map_err(|e| format!("DB lock error: {}", e))?
            .set_worktree_setup(&session_id, &project_id, ports.map(|p| p.base), &report);
        match saved {
            Ok(()) => {
                log::info!(
                    "[fast-worktrees] session {} prepared in {} ms: ports {:?}, {}",
                    session_id,
                    millis,
                    ports.map(|p| p.base),
                    setup
                        .dependencies
                        .iter()
                        .map(|d| format!("{} {:?}", d.folder, d.status))
                        .collect::<Vec<_>>()
                        .join(", ")
                );
                return Ok(setup);
            }
            Err(e) if e.contains("UNIQUE") => {
                if let Some(p) = ports {
                    skip.insert(p.base);
                }
            }
            Err(e) => return Err(e),
        }
    }
    Err("Could not record a port block for this worktree".into())
}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    /// Helper: create a fresh database backed by a temp file.
    fn test_db() -> Database {
        let tmp = NamedTempFile::new().unwrap();
        Database::new(tmp.path()).expect("Failed to create test database")
    }

    #[test]
    fn dirty_close_noise_filter_skips_aider_artifacts() {
        // The user complained that closing a session would surface
        // .aider.chat.history.md as uncommitted even on projects
        // they never used aider on.  These auto-generated files are
        // never user intent; skip them from the dirty-close dialog.
        assert!(is_dirty_close_noise_file(".aider.chat.history.md"));
        assert!(is_dirty_close_noise_file("subdir/.aider.chat.history.md"));
        assert!(is_dirty_close_noise_file(".aider.input.history"));
        assert!(is_dirty_close_noise_file(".aider.tags.cache.v3"));
        assert!(is_dirty_close_noise_file(".aider.llm.history"));
    }

    #[test]
    fn dirty_close_noise_filter_skips_os_clutter() {
        assert!(is_dirty_close_noise_file(".DS_Store"));
        assert!(is_dirty_close_noise_file("path/to/.DS_Store"));
        assert!(is_dirty_close_noise_file("Thumbs.db"));
    }

    #[test]
    fn dirty_close_noise_filter_does_not_skip_real_files() {
        assert!(!is_dirty_close_noise_file("src/main.rs"));
        assert!(!is_dirty_close_noise_file("README.md"));
        // A file that *contains* the noise name as a substring but
        // isn't the actual noise file must still surface.
        assert!(!is_dirty_close_noise_file(
            "notes.aider.chat.history.md.bak"
        ));
        assert!(!is_dirty_close_noise_file(
            ".aider.chat.history.md.user-notes"
        ));
    }

    #[test]
    fn test_resolve_worktree_path_with_existing_worktree_dir() {
        let db = test_db();
        let tmp_dir = tempfile::tempdir().unwrap();
        let wt_path = tmp_dir.path().to_str().unwrap();

        // Register a project
        db.insert_project("proj1", "/some/repo", "Test Project", "[]", "[]")
            .unwrap();
        // Insert a worktree pointing to a real (existing) directory
        db.insert_session_worktree("wt1", "sess1", "proj1", wt_path, Some("feat"), false)
            .unwrap();

        let result = resolve_worktree_path(&db, "sess1", "proj1");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), wt_path);
    }

    #[test]
    fn test_resolve_worktree_path_missing_dir_falls_back_to_project() {
        let db = test_db();

        // Register a project
        db.insert_project("proj1", "/some/repo", "Test Project", "[]", "[]")
            .unwrap();
        // Insert a worktree pointing to a directory that does not exist
        db.insert_session_worktree(
            "wt1",
            "sess1",
            "proj1",
            "/nonexistent/hermes-worktrees/abc/wt",
            Some("feat"),
            false,
        )
        .unwrap();

        // Should gracefully fall back to the project path instead of erroring
        let result = resolve_worktree_path(&db, "sess1", "proj1");
        assert!(
            result.is_ok(),
            "Expected fallback to project path, got error: {:?}",
            result.err()
        );
        assert_eq!(result.unwrap(), "/some/repo");

        // The stale worktree DB record should have been cleaned up
        let wt = db
            .get_worktree_by_session_and_project("sess1", "proj1")
            .unwrap();
        assert!(
            wt.is_none(),
            "Stale worktree record should have been deleted"
        );
    }

    #[test]
    fn test_resolve_worktree_path_falls_back_to_project() {
        let db = test_db();

        // Register a project but don't insert any worktree
        db.insert_project("proj1", "/some/repo", "Test Project", "[]", "[]")
            .unwrap();

        let result = resolve_worktree_path(&db, "sess1", "proj1");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "/some/repo");
    }

    #[test]
    fn test_resolve_worktree_path_no_project_no_worktree() {
        let db = test_db();

        let result = resolve_worktree_path(&db, "sess1", "proj1");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("No worktree or project found"));
    }

    // ── BUG 1 Tests: .gitignore exclusion ─────────────────────────────

    /// Helper: create a fresh git repository with one commit.
    fn create_test_repo() -> tempfile::TempDir {
        let dir = tempfile::TempDir::new().unwrap();
        std::process::Command::new("git")
            .args(["init"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        std::process::Command::new("git")
            .args(["config", "user.email", "test@test.com"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        std::process::Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        std::process::Command::new("git")
            .args(["config", "commit.gpgsign", "false"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        std::fs::write(dir.path().join("README.md"), "# Test").unwrap();
        std::process::Command::new("git")
            .args(["add", "."])
            .current_dir(dir.path())
            .output()
            .unwrap();
        std::process::Command::new("git")
            .args(["commit", "-m", "Initial commit"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        dir
    }

    #[test]
    fn test_git_status_excludes_gitignored_files() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        // Create a .gitignore that ignores node_modules/
        std::fs::write(repo_dir.path().join(".gitignore"), "node_modules/\n").unwrap();
        std::process::Command::new("git")
            .args(["add", ".gitignore"])
            .current_dir(repo_dir.path())
            .output()
            .unwrap();
        std::process::Command::new("git")
            .args(["commit", "-m", "Add gitignore"])
            .current_dir(repo_dir.path())
            .output()
            .unwrap();

        // Create node_modules/ with many files (these should be ignored)
        let nm_dir = repo_dir.path().join("node_modules").join("some-package");
        std::fs::create_dir_all(&nm_dir).unwrap();
        for i in 0..100 {
            std::fs::write(nm_dir.join(format!("file_{}.js", i)), "// ignored").unwrap();
        }

        // Create one real untracked file
        std::fs::write(repo_dir.path().join("new_file.ts"), "export {}").unwrap();

        let status = get_project_git_status("proj1", "Test", repo_path);
        assert!(status.is_git_repo);
        // Should only see new_file.ts, NOT any node_modules files
        let untracked: Vec<&GitFile> = status
            .files
            .iter()
            .filter(|f| f.area == "untracked")
            .collect();
        assert_eq!(
            untracked.len(),
            1,
            "Expected 1 untracked file, got {}: {:?}",
            untracked.len(),
            untracked.iter().map(|f| &f.path).collect::<Vec<_>>()
        );
        assert_eq!(untracked[0].path, "new_file.ts");
        assert!(status.error.is_none());
    }

    #[test]
    fn test_git_status_excludes_nested_gitignored_dirs() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        // Create .gitignore with multiple patterns
        std::fs::write(
            repo_dir.path().join(".gitignore"),
            "node_modules/\n.turbo/\ndist/\n",
        )
        .unwrap();
        std::process::Command::new("git")
            .args(["add", ".gitignore"])
            .current_dir(repo_dir.path())
            .output()
            .unwrap();
        std::process::Command::new("git")
            .args(["commit", "-m", "Add gitignore"])
            .current_dir(repo_dir.path())
            .output()
            .unwrap();

        // Create ignored directories with files
        for dir_name in &["node_modules", ".turbo", "dist"] {
            let dir = repo_dir.path().join(dir_name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("content.js"), "// ignored").unwrap();
        }

        let status = get_project_git_status("proj1", "Test", repo_path);
        assert!(
            status.files.is_empty(),
            "Expected 0 files (all gitignored), got {}: {:?}",
            status.files.len(),
            status.files.iter().map(|f| &f.path).collect::<Vec<_>>()
        );
    }

    // ── BUG 4 Tests: circuit breaker ──────────────────────────────────

    // Compile-time assertions: fail the build (not a test run) if the cap
    // ever leaves the sane range. Keeps the check but satisfies clippy's
    // `assertions_on_constants` lint.
    const _: () = assert!(
        VCS_STATUS_FILE_CAP >= 1000,
        "Cap should be at least 1000 to avoid false triggers"
    );
    const _: () = assert!(
        VCS_STATUS_FILE_CAP <= 50_000,
        "Cap should be at most 50k to prevent UI freeze"
    );

    #[test]
    fn test_git_status_normal_project_no_cap_error() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        // Create a few untracked files — well below the cap
        for i in 0..5 {
            std::fs::write(repo_dir.path().join(format!("file_{}.txt", i)), "content").unwrap();
        }

        let status = get_project_git_status("proj1", "Test", repo_path);
        assert!(
            status.error.is_none(),
            "Normal project should not trigger cap error, got: {:?}",
            status.error
        );
        assert_eq!(status.files.len(), 5);
    }

    // ── BUG 2 Tests: graceful worktree path handling ──────────────────

    #[test]
    fn test_resolve_worktree_path_missing_dir_cleans_up_db_record() {
        let db = test_db();

        db.insert_project("proj1", "/some/repo", "Test Project", "[]", "[]")
            .unwrap();
        db.insert_session_worktree(
            "wt1",
            "sess1",
            "proj1",
            "/nonexistent/hermes-worktrees/abc/wt",
            Some("feat"),
            false,
        )
        .unwrap();

        // Before resolve: worktree record exists
        let before = db
            .get_worktree_by_session_and_project("sess1", "proj1")
            .unwrap();
        assert!(
            before.is_some(),
            "Worktree record should exist before resolve"
        );

        // Resolve should fall back to project path
        let result = resolve_worktree_path(&db, "sess1", "proj1");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "/some/repo");

        // After resolve: worktree record should be cleaned up
        let after = db
            .get_worktree_by_session_and_project("sess1", "proj1")
            .unwrap();
        assert!(
            after.is_none(),
            "Stale worktree record should have been deleted"
        );
    }

    #[test]
    fn test_resolve_worktree_path_missing_dir_without_project_returns_error() {
        let db = test_db();

        // Insert worktree pointing to nonexistent dir, but NO project
        // This can happen if the project was deleted from DB but worktree record remained
        db.insert_session_worktree(
            "wt1",
            "sess1",
            "proj_gone",
            "/nonexistent/hermes-worktrees/abc/wt",
            Some("feat"),
            false,
        )
        .unwrap();

        let result = resolve_worktree_path(&db, "sess1", "proj_gone");
        assert!(
            result.is_err(),
            "Should error when both worktree path and project are missing"
        );
    }

    #[test]
    fn test_git_status_with_missing_worktree_returns_degraded_status() {
        // get_project_git_status should not crash even if the path doesn't exist —
        // it should return is_git_repo=false gracefully
        let status = get_project_git_status("proj1", "Test", "/nonexistent/path");
        assert!(!status.is_git_repo);
        assert!(status.files.is_empty());
    }

    #[test]
    fn test_resolve_worktree_valid_dir_returns_worktree_path() {
        let db = test_db();
        let tmp_dir = tempfile::tempdir().unwrap();
        let wt_path = tmp_dir.path().to_str().unwrap();

        db.insert_project("proj1", "/some/repo", "Test Project", "[]", "[]")
            .unwrap();
        db.insert_session_worktree("wt1", "sess1", "proj1", wt_path, Some("feat"), false)
            .unwrap();

        // When worktree path exists, it should return the worktree path (not project path)
        let result = resolve_worktree_path(&db, "sess1", "proj1");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), wt_path);

        // DB record should still be intact
        let wt = db
            .get_worktree_by_session_and_project("sess1", "proj1")
            .unwrap();
        assert!(wt.is_some(), "Valid worktree record should NOT be deleted");
    }

    // ── Reusing another session's checkout (F09) ───────────────────────

    /// A second session that reuses the first session's worktree must be
    /// counted as sharing it, however git spells the path, so closing the
    /// second session never deletes the first one's checkout. Uses a
    /// symlinked app-data folder so git's resolved spelling differs from
    /// the one Hermes stores on every Unix, like /var vs /private/var on macOS.
    #[cfg(unix)]
    #[test]
    fn reusing_another_sessions_worktree_keeps_it_on_close() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();
        let real = tempfile::TempDir::new().unwrap();
        let holder = tempfile::TempDir::new().unwrap();
        let app_data = holder.path().join("app-data");
        std::os::unix::fs::symlink(real.path(), &app_data).unwrap();

        let a =
            worktree::create_worktree(&app_data, repo_path, "sess-a", "hermes/task-a", true, None)
                .unwrap();
        let db = test_db();
        db.insert_session_worktree(
            "row-a",
            "sess-a",
            "proj",
            &a.worktree_path,
            Some("hermes/task-a"),
            false,
        )
        .unwrap();

        let raw = worktree::attach_existing_worktree(repo_path, "hermes/task-a").unwrap();
        assert_ne!(
            raw.worktree_path, a.worktree_path,
            "git spells the checkout differently"
        );
        assert!(!raw.is_main_worktree);

        // Attach records the owner's spelling.
        let stored = known_spelling_of_checkout(&db, repo_path, &raw.worktree_path).unwrap();
        assert_eq!(stored.as_deref(), Some(a.worktree_path.as_str()));

        // Even a row written with git's spelling is the same checkout.
        db.insert_session_worktree(
            "row-e",
            "sess-e",
            "proj",
            &raw.worktree_path,
            Some("hermes/task-a"),
            false,
        )
        .unwrap();
        assert_eq!(
            db.count_sessions_for_worktree_path(&a.worktree_path)
                .unwrap(),
            2
        );
        let row_e = db
            .get_worktree_by_session_and_project("sess-e", "proj")
            .unwrap()
            .unwrap();
        assert!(checkout_is_shared(&db, &row_e));

        // Closing the reusing session leaves A's checkout and row alone.
        let needs_disk = crate::pty::commands::drain_session_db_state(&db, "sess-e");
        assert!(
            needs_disk.is_empty(),
            "must not remove a checkout another session uses"
        );
        assert!(std::path::Path::new(&a.worktree_path).is_dir());
        assert_eq!(db.get_session_worktrees("sess-a").unwrap().len(), 1);
        assert!(db.get_session_worktrees("sess-e").unwrap().is_empty());

        // With E gone, A owns it alone again: closing A removes it.
        let row_a = db
            .get_worktree_by_session_and_project("sess-a", "proj")
            .unwrap()
            .unwrap();
        assert!(!checkout_is_shared(&db, &row_a));
        assert_eq!(
            crate::pty::commands::drain_session_db_state(&db, "sess-a").len(),
            1
        );
    }

    #[test]
    fn known_spelling_of_checkout_falls_back_to_project_folder() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();
        let db = test_db();
        let with_slash = format!("{}/", repo_path);
        assert_eq!(
            known_spelling_of_checkout(&db, repo_path, &with_slash)
                .unwrap()
                .as_deref(),
            Some(repo_path)
        );
        let other = tempfile::TempDir::new().unwrap();
        assert_eq!(
            known_spelling_of_checkout(&db, repo_path, other.path().to_str().unwrap()).unwrap(),
            None
        );
    }

    #[test]
    fn session_worktree_info_reports_sharing_in_camel_case() {
        let db = test_db();
        db.insert_session_worktree("r1", "s1", "p", "/tmp/hermes-test/wt", Some("b"), false)
            .unwrap();
        let row = db
            .get_worktree_by_session_and_project("s1", "p")
            .unwrap()
            .unwrap();
        let alone = SessionWorktreeInfo::describe(&db, row.clone());
        let json = serde_json::to_value(&alone).unwrap();
        assert_eq!(json["sharedWithOtherSessions"], false);
        assert_eq!(json["worktreePath"], "/tmp/hermes-test/wt");
        assert_eq!(json["isMainWorktree"], false);
        // Not under hermes-worktrees/: a checkout Hermes did not make.
        assert_eq!(json["ownedBySession"], false);

        // Same folder, spelled with a trailing separator.
        db.insert_session_worktree("r2", "s2", "p", "/tmp/hermes-test/wt/", Some("b"), false)
            .unwrap();
        assert!(checkout_is_shared(&db, &row));
    }

    #[test]
    fn session_owns_only_its_own_unshared_hermes_worktree() {
        let db = test_db();
        let own = "/data/hermes-worktrees/abc/s1_hermes-task";
        db.insert_session_worktree("r1", "s1", "p", own, Some("hermes/task"), false)
            .unwrap();
        db.insert_session_worktree("r2", "s2", "p", "/work/repo", Some("main"), true)
            .unwrap();
        db.insert_session_worktree(
            "r3",
            "s3",
            "p",
            "/work/repo-external",
            Some("external"),
            false,
        )
        .unwrap();
        let info = |s: &str| {
            SessionWorktreeInfo::describe(
                &db,
                db.get_worktree_by_session_and_project(s, "p")
                    .unwrap()
                    .unwrap(),
            )
        };
        assert!(info("s1").owned_by_session, "its own hermes worktree");
        assert!(!info("s2").owned_by_session, "the project folder");
        let external = info("s3");
        assert!(
            !external.owned_by_session && !external.shared_with_other_sessions,
            "a worktree made outside Hermes: not shared, not ours"
        );

        // Once another session reuses s1's worktree it is shared, so not owned alone.
        db.insert_session_worktree("r4", "s4", "p", own, Some("hermes/task"), false)
            .unwrap();
        let shared = info("s1");
        assert!(shared.shared_with_other_sessions && !shared.owned_by_session);
    }

    #[test]
    fn worktree_setup_is_recorded_per_link_and_frees_its_ports_with_it() {
        let db = test_db();
        db.insert_session_worktree("r1", "s1", "p", "/tmp/hermes-test/wt1", Some("a"), false)
            .unwrap();
        db.insert_session_worktree("r2", "s2", "p", "/tmp/hermes-test/wt2", Some("b"), false)
            .unwrap();
        assert_eq!(db.get_worktree_setup("s1", "p").unwrap(), (None, None));

        let setup = fast_setup::WorktreeSetup {
            ports: Some(fast_setup::PortBlock {
                base: 21_000,
                count: 10,
            }),
            dependencies: Vec::new(),
            millis: 3,
        };
        let json = serde_json::to_string(&setup).unwrap();
        db.set_worktree_setup("s1", "p", Some(21_000), &json)
            .unwrap();
        let (base, report) = db.get_worktree_setup("s1", "p").unwrap();
        assert_eq!(
            fast_setup::WorktreeSetup::from_record(base, report.as_deref()),
            Some(setup)
        );
        assert!(
            db.set_worktree_setup("s2", "p", Some(21_000), &json)
                .is_err(),
            "a block is never recorded twice"
        );
        assert!(db
            .set_worktree_setup("nobody", "p", Some(21_010), &json)
            .is_err());
        assert_eq!(
            db.taken_port_bases().unwrap(),
            [21_000].into_iter().collect()
        );

        // Closing the session drops its link, and with it the block.
        db.delete_worktrees_for_session("s1").unwrap();
        assert!(db.taken_port_bases().unwrap().is_empty());
        db.set_worktree_setup("s2", "p", Some(21_000), &json)
            .unwrap();
    }

    // ── Pure pieces of the git commands ────────────────────────────────

    /// git in `dir` with a test identity, asserting success; trimmed stdout.
    fn git_ok(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args([
                "-c",
                "user.email=test@example.com",
                "-c",
                "user.name=Test",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "init.defaultBranch=main",
                "-c",
                "protocol.file.allow=always",
                "-c",
                "core.autocrlf=false",
            ])
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn unstaging_refuses_a_path_outside_the_project_but_takes_everything() {
        let repo = create_test_repo();
        let root = repo.path().to_str().unwrap();
        assert!(check_unstage_paths(root, &[".".into()]).is_ok());
        assert!(check_unstage_paths(root, &["README.md".into()]).is_ok());
        assert!(check_unstage_paths(root, &["../outside.txt".into()]).is_err());
        assert!(check_unstage_paths(root, &[".".into(), "../../etc/passwd".into()]).is_err());
    }

    #[test]
    fn the_author_override_needs_both_a_name_and_an_email() {
        let dir = create_test_repo();
        let repo = Repository::open(dir.path()).unwrap();
        let s = |v: &str| Some(v.to_string());
        let (ann, mail, empty) = (s("Ann"), s("ann@example.com"), s(""));
        assert_eq!(
            commit_author(&repo, &ann, &mail).unwrap(),
            Some(("Ann", "ann@example.com"))
        );
        assert_eq!(commit_author(&repo, &empty, &mail).unwrap(), None);
        assert_eq!(commit_author(&repo, &ann, &empty).unwrap(), None);
        assert_eq!(commit_author(&repo, &None, &mail).unwrap(), None);
        assert_eq!(commit_author(&repo, &None, &None).unwrap(), None);
    }

    #[test]
    fn without_an_override_a_repository_with_no_identity_is_refused() {
        let dir = create_test_repo();
        git_ok(dir.path(), &["config", "user.name", ""]);
        git_ok(dir.path(), &["config", "user.email", ""]);
        let repo = Repository::open(dir.path()).unwrap();
        let err = commit_author(&repo, &None, &None).unwrap_err();
        assert!(err.starts_with("Git user not configured"), "{err}");
        let (ann, mail) = (Some("Ann".to_string()), Some("ann@example.com".to_string()));
        assert_eq!(
            commit_author(&repo, &ann, &mail).unwrap(),
            Some(("Ann", "ann@example.com"))
        );
    }

    #[test]
    fn a_new_branch_is_cut_from_the_base_else_the_checked_out_branch() {
        let dir = create_test_repo();
        let root = dir.path().to_str().unwrap();
        let current = git_ok(dir.path(), &["branch", "--show-current"]);
        assert_eq!(
            cut_from_branch(root, true, None, Some("develop")).as_deref(),
            Some("develop")
        );
        assert_eq!(cut_from_branch(root, true, None, None), Some(current));
        // No branch is made: nothing is cut.
        assert_eq!(cut_from_branch(root, false, None, Some("develop")), None);
        assert_eq!(cut_from_branch(root, false, None, None), None);
        assert_eq!(
            cut_from_branch(root, true, Some("origin/x"), Some("develop")),
            None
        );
        git_ok(dir.path(), &["checkout", "-q", "--detach"]);
        assert_eq!(cut_from_branch(root, true, None, None), None);
    }

    #[test]
    fn a_branch_is_never_recorded_as_its_own_base() {
        assert_eq!(base_to_record(Some("main"), "main"), None);
        assert_eq!(base_to_record(Some("main"), "hermes/x"), Some("main"));
        assert_eq!(base_to_record(None, "hermes/x"), None);
    }

    #[test]
    fn a_branch_in_use_error_says_who_holds_it() {
        let db = test_db();
        let root = tempfile::tempdir().unwrap();
        let root = root.path().to_str().unwrap().to_string();
        db.insert_project("p1", &root, "P", "[]", "[]").unwrap();
        let held = "/nowhere/hermes-worktrees/abc/held";
        db.insert_session_worktree("w1", "s1", "p1", held, Some("feat"), false)
            .unwrap();
        let db = std::sync::Mutex::new(db);
        let read = |err: String| -> serde_json::Value {
            let json = err
                .strip_prefix(worktree::BRANCH_IN_USE_PREFIX)
                .unwrap_or_else(|| panic!("{err}"));
            serde_json::from_str(json).unwrap()
        };

        assert_eq!(
            describe_branch_in_use(&db, &root, "git failed".into()),
            "git failed"
        );

        let v = read(describe_branch_in_use(
            &db,
            &root,
            worktree::branch_in_use_error("feat", held),
        ));
        assert_eq!(v["branch"], "feat");
        assert_eq!(v["path"], held);
        assert_eq!(v["sessionId"], "s1");
        assert_eq!(v["projectFolder"], false);
        assert_eq!(v["leftover"], false);

        // Ours, and no session uses it: a leftover.
        let v = read(describe_branch_in_use(
            &db,
            &root,
            worktree::branch_in_use_error("old", "/nowhere/hermes-worktrees/abc/left"),
        ));
        assert_eq!(v["sessionId"], serde_json::Value::Null);
        assert_eq!(v["leftover"], true);

        // The project folder itself, or a checkout outside Hermes: not ours.
        let v = read(describe_branch_in_use(
            &db,
            &root,
            worktree::branch_in_use_error("main", &root),
        ));
        assert_eq!(v["projectFolder"], true);
        assert_eq!(v["leftover"], false);
        let v = read(describe_branch_in_use(
            &db,
            &root,
            worktree::branch_in_use_error("main", "/elsewhere/checkout"),
        ));
        assert_eq!(v["projectFolder"], false);
        assert_eq!(v["leftover"], false);
    }

    /// A project repository (`p1` in the returned database) and a linked
    /// worktree of it on branch `task` inside a `hermes-worktrees` folder.
    fn project_with_leftover() -> (
        tempfile::TempDir,
        std::sync::Mutex<Database>,
        String,
        String,
    ) {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        git_ok(&root, &["init", "-q", "-b", "main"]);
        git_ok(&root, &["config", "user.email", "test@example.com"]);
        git_ok(&root, &["config", "user.name", "Test"]);
        git_ok(&root, &["config", "commit.gpgsign", "false"]);
        std::fs::write(root.join("README.md"), "# readme\n").unwrap();
        git_ok(&root, &["add", "."]);
        git_ok(&root, &["commit", "-q", "-m", "init"]);
        let wt = t.path().join("hermes-worktrees").join("abc").join("wt");
        std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
        git_ok(
            &root,
            &["worktree", "add", "-q", "-b", "task", wt.to_str().unwrap()],
        );
        let db = test_db();
        let root_s = root.to_str().unwrap().to_string();
        db.insert_project("p1", &root_s, "P", "[]", "[]").unwrap();
        (
            t,
            std::sync::Mutex::new(db),
            root_s,
            wt.to_str().unwrap().to_string(),
        )
    }

    #[test]
    fn only_an_unused_worktree_of_ours_of_this_project_counts_as_kept() {
        let (t, db, root, wt) = project_with_leftover();
        assert_eq!(unused_instance_worktree(&db, "p1", &wt).unwrap(), root);
        assert!(unused_instance_worktree(&db, "nope", &wt).is_err());

        // A checkout outside Hermes' worktrees folder.
        let outside = t.path().join("plain").join("wt");
        std::fs::create_dir_all(outside.parent().unwrap()).unwrap();
        git_ok(
            Path::new(&root),
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "other",
                outside.to_str().unwrap(),
            ],
        );
        assert_eq!(
            unused_instance_worktree(&db, "p1", outside.to_str().unwrap()).unwrap_err(),
            "That checkout was not made by this Hermes"
        );

        // Ours, but a worktree of another repository.
        let stranger = t.path().join("stranger");
        std::fs::create_dir_all(&stranger).unwrap();
        git_ok(&stranger, &["init", "-q", "-b", "main"]);
        std::fs::write(stranger.join("x.txt"), "x\n").unwrap();
        git_ok(&stranger, &["add", "."]);
        git_ok(&stranger, &["commit", "-q", "-m", "x"]);
        let foreign = t
            .path()
            .join("hermes-worktrees")
            .join("abc")
            .join("foreign");
        git_ok(
            &stranger,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "f",
                foreign.to_str().unwrap(),
            ],
        );
        assert_eq!(
            unused_instance_worktree(&db, "p1", foreign.to_str().unwrap()).unwrap_err(),
            "That checkout does not belong to this project"
        );

        // A session still works in it.
        db.lock()
            .unwrap()
            .insert_session_worktree("w1", "s1", "p1", &wt, Some("task"), false)
            .unwrap();
        assert_eq!(
            unused_instance_worktree(&db, "p1", &wt).unwrap_err(),
            "A session still works in that checkout"
        );
    }

    #[test]
    fn a_kept_worktree_commits_its_work_and_nothing_to_commit_is_no_outcome() {
        let (_t, db, _root, wt) = project_with_leftover();
        let commit = |expected: Option<&str>| {
            commit_kept_worktree(
                &db,
                "p1",
                &wt,
                "Keep work",
                worktree::CommitTarget::Session,
                expected,
            )
        };
        assert!(commit(Some("task")).unwrap().is_none());
        std::fs::write(Path::new(&wt).join("work.txt"), "work\n").unwrap();
        // Switched to another branch: refused, not "nothing to commit".
        assert!(commit(Some("elsewhere"))
            .unwrap_err()
            .contains("nothing was committed"));
        let out = commit(Some("task")).unwrap().expect("a commit");
        assert_eq!(out.branch, "task");
        assert_eq!(out.files, 1);
        assert_eq!(
            git_ok(Path::new(&wt), &["log", "-1", "--format=%s"]),
            "Keep work"
        );
    }

    #[test]
    fn a_kept_detached_head_is_saved_on_an_archive_branch() {
        let (_t, db, _root, wt) = project_with_leftover();
        let w = Path::new(&wt);
        git_ok(w, &["checkout", "-q", "--detach"]);
        std::fs::write(w.join("fix.txt"), "fix\n").unwrap();
        git_ok(w, &["add", "."]);
        git_ok(w, &["commit", "-q", "-m", "fix"]);
        // Nothing uncommitted: the message has nothing to commit.
        let name =
            save_kept_detached_head(&db, "p1", &wt, Some("hermes/bisect"), Some("Keep")).unwrap();
        assert_eq!(name, "hermes-archive/bisect-detached");
        assert_eq!(git_ok(w, &["branch", "--show-current"]), name);
        assert_eq!(git_ok(w, &["log", "-1", "--format=%s"]), "fix");
    }

    #[cfg(unix)]
    #[test]
    fn a_kept_detached_head_whose_commit_a_hook_refuses_says_so() {
        use std::os::unix::fs::PermissionsExt;
        let (_t, db, root, wt) = project_with_leftover();
        let w = Path::new(&wt);
        git_ok(w, &["checkout", "-q", "--detach"]);
        std::fs::write(w.join("dirty.txt"), "dirty\n").unwrap();
        let hook = Path::new(&root).join(".git/hooks/pre-commit");
        std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
        std::fs::write(&hook, "#!/bin/sh\necho 'no' >&2\nexit 1\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        let err =
            save_kept_detached_head(&db, "p1", &wt, Some("hermes/x"), Some("Keep")).unwrap_err();
        assert!(err.starts_with(safety::HOOK_REFUSED_PREFIX), "{err}");
    }

    #[test]
    fn keeping_a_worktree_drops_only_the_sessions_link() {
        let (_t, db, _root, wt) = project_with_leftover();
        assert!(keep_worktree(&db, "s1", "p1").is_err());
        db.lock()
            .unwrap()
            .insert_session_worktree("w1", "s1", "p1", &wt, Some("task"), false)
            .unwrap();
        assert_eq!(keep_worktree(&db, "s1", "p1").unwrap(), wt);
        assert!(db
            .lock()
            .unwrap()
            .get_all_session_worktrees()
            .unwrap()
            .is_empty());
        assert!(Path::new(&wt).exists());
    }

    #[test]
    fn a_clean_leftover_is_removed_and_one_with_work_is_kept() {
        // Clean: removed.
        let (_t, db, _root, wt) = project_with_leftover();
        remove_leftover_worktree(&db, "p1", &wt, None, None).unwrap();
        assert!(!Path::new(&wt).exists());

        // Only clutter a tool dropped there: still removed.
        let (_t, db, _root, wt) = project_with_leftover();
        std::fs::write(Path::new(&wt).join(".DS_Store"), "x").unwrap();
        remove_leftover_worktree(&db, "p1", &wt, None, None).unwrap();
        assert!(!Path::new(&wt).exists());

        // Uncommitted work: kept.
        let (_t, db, _root, wt) = project_with_leftover();
        std::fs::write(Path::new(&wt).join("work.txt"), "work\n").unwrap();
        let err = remove_leftover_worktree(&db, "p1", &wt, None, None).unwrap_err();
        assert!(err.contains("has work in it"), "{err}");
        assert!(Path::new(&wt).join("work.txt").exists());
        // ...unless that work was just archived.
        remove_leftover_worktree(&db, "p1", &wt, Some("s1"), Some(true)).unwrap();
        assert!(!Path::new(&wt).exists());

        // Commits on no branch: kept.
        let (_t, db, _root, wt) = project_with_leftover();
        let w = Path::new(&wt);
        git_ok(w, &["checkout", "-q", "--detach"]);
        std::fs::write(w.join("fix.txt"), "fix\n").unwrap();
        git_ok(w, &["add", "."]);
        git_ok(w, &["commit", "-q", "-m", "fix"]);
        let err = remove_leftover_worktree(&db, "p1", &wt, None, None).unwrap_err();
        assert!(err.contains("on no branch"), "{err}");
        assert!(w.exists());

        // Not ours to remove.
        let (_t, db, _root, wt) = project_with_leftover();
        db.lock()
            .unwrap()
            .insert_session_worktree("w1", "s1", "p1", &wt, Some("task"), false)
            .unwrap();
        assert!(remove_leftover_worktree(&db, "p1", &wt, None, None)
            .unwrap_err()
            .ends_with("; it was not removed"));
        assert!(Path::new(&wt).exists());
    }

    /// A superproject with a submodule `vendor/lib` (committed).
    fn superproject() -> (tempfile::TempDir, std::path::PathBuf) {
        let t = tempfile::tempdir().unwrap();
        let lib = t.path().join("lib");
        std::fs::create_dir_all(&lib).unwrap();
        git_ok(&lib, &["init", "-q", "-b", "main"]);
        std::fs::write(lib.join("lib.txt"), "v1\n").unwrap();
        git_ok(&lib, &["add", "."]);
        git_ok(&lib, &["commit", "-q", "-m", "lib"]);
        let sup = t.path().join("sup");
        std::fs::create_dir_all(&sup).unwrap();
        git_ok(&sup, &["init", "-q", "-b", "main"]);
        std::fs::write(sup.join("README.md"), "sup\n").unwrap();
        git_ok(&sup, &["add", "."]);
        git_ok(&sup, &["commit", "-q", "-m", "init"]);
        git_ok(
            &sup,
            &[
                "submodule",
                "add",
                "-q",
                lib.to_str().unwrap(),
                "vendor/lib",
            ],
        );
        git_ok(&sup, &["commit", "-q", "-m", "vendor"]);
        (t, sup)
    }

    #[test]
    fn edits_only_inside_a_submodule_are_not_a_file_to_commit() {
        let (_t, sup) = superproject();
        std::fs::write(sup.join("vendor/lib/lib.txt"), "dirty\n").unwrap();
        std::fs::write(sup.join("README.md"), "edited\n").unwrap();
        let ch = worktree_changes_at(sup.to_str().unwrap()).unwrap();
        let files: Vec<&str> = ch.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(files, vec!["README.md"]);
        assert!(ch.has_changes);
        assert_eq!(
            ch.head.unwrap().dirty_submodules,
            vec!["vendor/lib".to_string()]
        );
    }

    #[test]
    fn a_submodule_whose_recorded_commit_moved_is_a_file_to_commit() {
        let (_t, sup) = superproject();
        let sub = sup.join("vendor/lib");
        std::fs::write(sub.join("lib.txt"), "v2\n").unwrap();
        git_ok(&sub, &["commit", "-q", "-am", "v2"]);
        std::fs::write(sub.join("lib.txt"), "dirty\n").unwrap();
        let ch = worktree_changes_at(sup.to_str().unwrap()).unwrap();
        let files: Vec<&str> = ch.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(files, vec!["vendor/lib"]);
        assert_eq!(
            ch.head.unwrap().dirty_submodules,
            vec!["vendor/lib".to_string()]
        );
    }

    #[test]
    fn a_clean_checkout_has_no_changes() {
        let (_t, sup) = superproject();
        let ch = worktree_changes_at(sup.to_str().unwrap()).unwrap();
        assert!(ch.files.is_empty());
        assert!(!ch.has_changes);
    }
}
