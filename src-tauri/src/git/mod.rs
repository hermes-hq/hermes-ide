pub mod worktree;

use git2::{
    BranchType, Cred, DiffOptions, FetchOptions, IndexAddOption, PushOptions, RemoteCallbacks,
    Repository, StatusOptions,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use crate::db::Database;
use crate::AppState;

/// Resolves the worktree path for a given session+realm from the database.
/// Falls back to looking up the realm's path directly if no worktree entry exists.
fn resolve_worktree_path(
    db: &Database,
    session_id: &str,
    realm_id: &str,
) -> Result<String, String> {
    // Try to find a worktree entry for this session+realm
    if let Some(wt) = db
        .get_worktree_by_session_and_realm(session_id, realm_id)
        .map_err(|e| format!("Failed to look up worktree: {}", e))?
    {
        return Ok(wt.worktree_path);
    }
    // Fallback: look up the realm's path directly
    if let Some(realm) = db
        .get_realm(realm_id)
        .map_err(|e| format!("Failed to look up realm: {}", e))?
    {
        return Ok(realm.path);
    }
    Err(format!(
        "No worktree or realm found for session={}, realm={}",
        session_id, realm_id
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

    // Get file statuses
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);

    let mut files = Vec::new();
    let mut has_conflicts = false;

    match repo.statuses(Some(&mut opts)) {
        Ok(statuses) => {
            for entry in statuses.iter() {
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
        error: None,
    }
}

// ─── Tauri Commands ─────────────────────────────────────────────────

#[tauri::command]
pub fn git_status(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<GitSessionStatus, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let realms = db.get_session_realms(&session_id)?;

    // Resolve worktree paths for each realm
    let projects: Vec<GitProjectStatus> = realms
        .iter()
        .map(|r| {
            let path =
                resolve_worktree_path(&db, &session_id, &r.id).unwrap_or_else(|_| r.path.clone());
            get_project_git_status(&r.id, &r.name, &path)
        })
        .filter(|p| p.is_git_repo)
        .collect();
    drop(db);

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    Ok(GitSessionStatus {
        projects,
        timestamp,
    })
}

#[tauri::command]
pub fn git_stage(
    state: State<'_, AppState>,
    session_id: String,
    realm_id: String,
    paths: Vec<String>,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
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

#[tauri::command]
pub fn git_unstage(
    state: State<'_, AppState>,
    session_id: String,
    realm_id: String,
    paths: Vec<String>,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
    drop(db);
    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;

    let head_tree = repo.head().and_then(|h| h.peel_to_tree()).ok();

    if paths.len() == 1 && paths[0] == "." {
        let all_paths: Vec<String> = vec!["*".to_string()];
        repo.reset_default(head_tree.as_ref().map(|t| t.as_object()), &all_paths)
            .map_err(|e| e.to_string())?;
    } else {
        repo.reset_default(head_tree.as_ref().map(|t| t.as_object()), &paths)
            .map_err(|e| e.to_string())?;
    }

    Ok(GitOperationResult {
        success: true,
        message: format!("Unstaged {} file(s)", paths.len()),
        error: None,
    })
}

#[tauri::command]
pub fn git_commit(
    state: State<'_, AppState>,
    session_id: String,
    realm_id: String,
    message: String,
    author_name: Option<String>,
    author_email: Option<String>,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
    drop(db);
    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;

    // 3C: Use author overrides if provided, otherwise fall back to repo config
    let sig = match (&author_name, &author_email) {
        (Some(name), Some(email)) if !name.is_empty() && !email.is_empty() => {
            git2::Signature::now(name, email).map_err(|e| e.to_string())?
        }
        _ => repo.signature().map_err(|e| {
            format!(
                "Git user not configured. Run: git config --global user.name \"...\"; \
                 git config --global user.email \"...\"\nError: {}",
                e
            )
        })?,
    };

    let mut index = repo.index().map_err(|e| e.to_string())?;
    let tree_oid = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;

    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());

    let parents: Vec<&git2::Commit> = parent.iter().collect();

    repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)
        .map_err(|e| e.to_string())?;

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
    realm_id: String,
    remote: Option<String>,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
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
pub fn git_pull(
    state: State<'_, AppState>,
    session_id: String,
    realm_id: String,
    remote: Option<String>,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
    drop(db);
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

    if merge_analysis.is_fast_forward() {
        let refname = format!("refs/heads/{}", branch_name);
        let mut reference = repo.find_reference(&refname).map_err(|e| e.to_string())?;
        reference
            .set_target(fetch_commit.id(), "fast-forward pull")
            .map_err(|e| e.to_string())?;
        repo.set_head(&refname).map_err(|e| e.to_string())?;
        repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))
            .map_err(|e| e.to_string())?;

        return Ok(GitOperationResult {
            success: true,
            message: "Fast-forward pull complete".to_string(),
            error: None,
        });
    }

    // Perform actual merge
    if merge_analysis.is_normal() {
        let fetch_commit_obj = repo
            .find_commit(fetch_commit.id())
            .map_err(|e| e.to_string())?;

        // Merge the fetched commit
        let mut merge_opts = git2::MergeOptions::new();
        let mut checkout_builder = git2::build::CheckoutBuilder::new();
        checkout_builder.allow_conflicts(true);

        repo.merge(
            &[&fetch_commit],
            Some(&mut merge_opts),
            Some(&mut checkout_builder),
        )
        .map_err(|e| format!("Merge failed: {}", e))?;

        // Check for conflicts
        let index = repo.index().map_err(|e| e.to_string())?;
        if index.has_conflicts() {
            return Ok(GitOperationResult {
                success: false,
                message: "Pull complete but merge has conflicts. Resolve them to finish the merge."
                    .to_string(),
                error: Some("Merge conflicts detected".to_string()),
            });
        }

        // Auto-commit if no conflicts
        let sig = repo.signature().map_err(|e| e.to_string())?;
        let mut index = repo.index().map_err(|e| e.to_string())?;
        let tree_oid = index.write_tree().map_err(|e| e.to_string())?;
        let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;

        let head_commit = repo
            .head()
            .and_then(|h| h.peel_to_commit())
            .map_err(|e| e.to_string())?;

        let msg = format!("Merge branch '{}' of {}", branch_name, remote_name);
        repo.commit(
            Some("HEAD"),
            &sig,
            &sig,
            &msg,
            &tree,
            &[&head_commit, &fetch_commit_obj],
        )
        .map_err(|e| format!("Merge commit failed: {}", e))?;

        repo.cleanup_state().map_err(|e| e.to_string())?;

        return Ok(GitOperationResult {
            success: true,
            message: "Pull with merge complete".to_string(),
            error: None,
        });
    }

    Err("Pull failed: unexpected merge analysis result".to_string())
}

#[tauri::command]
pub fn git_diff(
    state: State<'_, AppState>,
    session_id: String,
    realm_id: String,
    file_path: String,
    staged: bool,
) -> Result<GitDiff, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
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
    realm_id: String,
    file_path: String,
) -> Result<(), String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
    drop(db);
    // 1F: Path traversal guard
    let full_path = safe_join(&project_path, &file_path)?;
    crate::platform::open_file(&full_path.to_string_lossy())
}

#[tauri::command]
pub fn read_file_content(
    state: State<'_, AppState>,
    session_id: String,
    realm_id: String,
    file_path: String,
) -> Result<FileContent, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
    drop(db);

    let full_path = safe_join(&project_path, &file_path)?;
    let metadata = std::fs::metadata(&full_path)
        .map_err(|e| format!("Failed to read file metadata: {}", e))?;
    let size = metadata.len();

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
    })
}

#[tauri::command]
pub fn open_file_in_editor(
    state: State<'_, AppState>,
    session_id: String,
    realm_id: String,
    file_path: String,
    editor: Option<String>,
) -> Result<(), String> {
    // SSH remote editors: editor string contains args (e.g. "code --remote ssh-remote+user@host")
    // or file_path is a URI (e.g. "ssh://user@host/path") — skip local path resolution.
    if realm_id == "__ssh_local__" {
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
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
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
pub fn git_list_branches(
    state: State<'_, AppState>,
    session_id: String,
    realm_id: String,
) -> Result<Vec<GitBranch>, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
    drop(db);
    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;
    let mut branches = Vec::new();

    // Get current branch name
    let current_branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()));

    // Local branches
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

        // Only compute expensive ahead/behind graph walk for the current branch
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

        // Last commit summary
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

    // Remote branches
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

/// List branches for a realm without requiring a session.
/// Uses the realm's root path directly (not a worktree path).
#[tauri::command]
pub fn git_list_branches_for_realm(
    state: State<'_, AppState>,
    realm_id: String,
) -> Result<Vec<GitBranch>, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let realm = db
        .get_realm(&realm_id)
        .map_err(|e| format!("Failed to look up realm: {}", e))?
        .ok_or_else(|| format!("Realm '{}' not found", realm_id))?;
    let project_path = realm.path.clone();
    drop(db);

    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;
    let mut branches = Vec::new();

    let current_branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()));

    // Local branches
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

        // Only compute expensive ahead/behind graph walk for the current branch
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

    // Remote branches
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

/// Compute ahead/behind counts for all local branches that have an upstream.
/// Designed to be called lazily after the fast `git_list_branches` returns,
/// so the branch dropdown renders instantly and enriches in the background.
#[tauri::command]
pub fn git_branches_ahead_behind(
    state: State<'_, AppState>,
    session_id: String,
    realm_id: String,
) -> Result<HashMap<String, (u32, u32)>, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
    drop(db);
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
}

#[tauri::command]
pub fn git_create_branch(
    state: State<'_, AppState>,
    session_id: String,
    realm_id: String,
    name: String,
    checkout: bool,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
    drop(db);
    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;

    let head_commit = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|e| format!("Cannot resolve HEAD: {}", e))?;

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
pub fn git_checkout_branch(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    realm_id: String,
    name: String,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
    drop(db);

    // Validate that the branch isn't in use by another worktree
    let realm_path = {
        let db = state
            .db
            .lock()
            .map_err(|e| format!("DB lock error: {}", e))?;
        db.get_realm(&realm_id)
            .map_err(|e| format!("Failed to look up realm: {}", e))?
            .map(|r| r.path)
            .unwrap_or_else(|| project_path.clone())
    };
    if !worktree::is_branch_available(&realm_path, &name, Some(&project_path)).unwrap_or(true) {
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
        let _ = app.emit(&format!("branch-changed-{}", session_id), &name);
        return Ok(GitOperationResult {
            success: true,
            message: format!("Switched to branch '{}'", name),
            error: None,
        });
    }

    // Try creating a local tracking branch from a remote branch
    // e.g. name = "origin/feature" → local branch "feature" tracking "origin/feature"
    let remote_refname = format!("refs/remotes/{}", name);
    if let Ok(remote_ref) = repo.find_reference(&remote_refname) {
        let commit = remote_ref.peel_to_commit().map_err(|e| e.to_string())?;
        // Extract local name (strip "origin/" prefix)
        let local_name = name.split_once('/').map_or(name.as_str(), |(_, rest)| rest);

        let mut local_branch = repo
            .branch(local_name, &commit, false)
            .map_err(|e| format!("Failed to create tracking branch: {}", e))?;

        // Set upstream
        local_branch
            .set_upstream(Some(&name))
            .map_err(|e| format!("Failed to set upstream: {}", e))?;

        let local_refname = format!("refs/heads/{}", local_name);
        repo.set_head(&local_refname).map_err(|e| e.to_string())?;
        repo.checkout_head(Some(git2::build::CheckoutBuilder::default().safe()))
            .map_err(|e| e.to_string())?;

        let _ = app.emit(&format!("branch-changed-{}", session_id), local_name);
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
}

#[tauri::command]
pub fn git_delete_branch(
    state: State<'_, AppState>,
    session_id: String,
    realm_id: String,
    name: String,
    force: bool,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
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
        branch.delete().map_err(|e| {
            format!(
                "Failed to delete '{}': {}. Use force delete if unmerged.",
                name, e
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
pub fn list_directory(
    state: State<'_, AppState>,
    session_id: String,
    realm_id: String,
    relative_path: Option<String>,
) -> Result<Vec<FileEntry>, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
    drop(db);
    let base =
        std::fs::canonicalize(&project_path).map_err(|e| format!("Invalid project path: {}", e))?;

    let target_dir = match &relative_path {
        Some(rel) if !rel.is_empty() => safe_join(&project_path, rel)?,
        _ => base.clone(),
    };

    if !target_dir.is_dir() {
        return Err(format!("Not a directory: {}", target_dir.display()));
    }

    // Build git status map
    let mut git_status_map = std::collections::HashMap::new();
    if let Ok(repo) = Repository::open(&project_path) {
        let mut opts = StatusOptions::new();
        opts.include_untracked(true).recurse_untracked_dirs(true);
        if let Ok(statuses) = repo.statuses(Some(&mut opts)) {
            for entry in statuses.iter() {
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
    let dir_entries =
        std::fs::read_dir(&target_dir).map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in dir_entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let file_name = entry.file_name().to_string_lossy().to_string();

        // Skip .git directory
        if file_name == ".git" {
            continue;
        }

        let metadata = entry
            .metadata()
            .map_err(|e| format!("Failed to get metadata: {}", e))?;
        let is_dir = metadata.is_dir();
        let is_hidden = file_name.starts_with('.');

        // Compute relative path from project root
        let full_path = entry.path();
        let rel_path = full_path
            .strip_prefix(&base)
            .unwrap_or(&full_path)
            .to_string_lossy()
            .to_string()
            .replace('\\', "/");

        let size = if is_dir { None } else { Some(metadata.len()) };

        // Look up git status — for files check exact path, for dirs check if any child has status
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

    // Sort: directories first, then alphabetical (case-insensitive)
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
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
    realm_id: String,
) -> Result<Vec<GitStashEntry>, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
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
    realm_id: String,
    message: Option<String>,
    include_untracked: Option<bool>,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
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
    realm_id: String,
    index: usize,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
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
    realm_id: String,
    index: usize,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
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
    realm_id: String,
    index: usize,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
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
    realm_id: String,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
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
pub fn git_log(
    state: State<'_, AppState>,
    session_id: String,
    realm_id: String,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<GitLogResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
    drop(db);
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
}

#[tauri::command]
pub fn git_commit_detail(
    state: State<'_, AppState>,
    session_id: String,
    realm_id: String,
    commit_hash: String,
) -> Result<GitCommitDetail, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
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
    realm_id: String,
) -> Result<MergeStatus, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
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
    realm_id: String,
    file_path: String,
) -> Result<ConflictContent, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
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
    realm_id: String,
    file_path: String,
    strategy: String,
    manual_content: Option<String>,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
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
    realm_id: String,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
    drop(db);
    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;

    if repo.state() != git2::RepositoryState::Merge {
        return Err("No merge in progress".to_string());
    }

    // Reset to HEAD
    let head = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|e| format!("Cannot resolve HEAD: {}", e))?;
    repo.reset(head.as_object(), git2::ResetType::Hard, None)
        .map_err(|e| format!("Reset failed: {}", e))?;

    repo.cleanup_state()
        .map_err(|e| format!("Cleanup failed: {}", e))?;

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
    realm_id: String,
    message: Option<String>,
    author_name: Option<String>,
    author_email: Option<String>,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
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
    realm_id: String,
    query: String,
    is_regex: bool,
    case_sensitive: bool,
    max_results: Option<u32>,
) -> Result<SearchResponse, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
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
pub fn git_create_worktree(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    realm_id: String,
    branch_name: String,
    create_branch: bool,
) -> Result<worktree::WorktreeCreateResult, String> {
    // 1. Get realm path from DB
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let realm = db
        .get_realm(&realm_id)
        .map_err(|e| format!("Failed to look up realm: {}", e))?
        .ok_or_else(|| format!("Realm '{}' not found", realm_id))?;
    let realm_path = realm.path.clone();
    drop(db);

    // 2. Create the worktree
    let result = worktree::create_worktree(&realm_path, &session_id, &branch_name, create_branch)?;

    // 3. Insert into session_worktrees table — if this fails, roll back the worktree
    let id = uuid::Uuid::new_v4().to_string();
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    if let Err(db_err) = db.insert_session_worktree(
        &id,
        &session_id,
        &realm_id,
        &result.worktree_path,
        Some(&result.branch_name),
        result.is_main_worktree,
    ) {
        // Rollback: remove the worktree we just created
        log::warn!("DB insert failed for worktree, rolling back: {}", db_err);
        if !result.is_main_worktree {
            let _ = worktree::remove_worktree(&realm_path, &session_id, &result.worktree_path);
        }
        return Err(format!("Failed to record worktree: {}", db_err));
    }
    drop(db);

    // 4. Emit event for frontend
    let _ = app.emit(&format!("worktree-created-{}", realm_id), &result);

    // 5. Return result
    Ok(result)
}

#[tauri::command]
pub fn git_remove_worktree(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    realm_id: String,
) -> Result<GitOperationResult, String> {
    // 1. Look up worktree from DB
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let wt = db
        .get_worktree_by_session_and_realm(&session_id, &realm_id)
        .map_err(|e| format!("Failed to look up worktree: {}", e))?
        .ok_or_else(|| {
            format!(
                "No worktree found for session={}, realm={}",
                session_id, realm_id
            )
        })?;
    let realm = db
        .get_realm(&realm_id)
        .map_err(|e| format!("Failed to look up realm: {}", e))?
        .ok_or_else(|| format!("Realm '{}' not found", realm_id))?;
    let wt_id = wt.id.clone();
    let wt_path = wt.worktree_path.clone();
    let realm_path = realm.path.clone();
    drop(db);

    // 2. Try to remove the worktree from the filesystem
    let remove_result = worktree::remove_worktree(&realm_path, &session_id, &wt_path);

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

    // 4. Emit event for frontend
    let _ = app.emit(&format!("worktree-removed-{}", realm_id), ());

    // 5. Return result
    Ok(GitOperationResult {
        success: true,
        message: format!("Removed worktree at '{}'", wt_path),
        error: None,
    })
}

#[tauri::command]
pub fn git_list_worktrees(
    state: State<'_, AppState>,
    realm_id: String,
) -> Result<Vec<worktree::WorktreeInfo>, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let worktrees = db.get_worktrees_for_realm(&realm_id)?;

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
    realm_id: String,
    branch_name: String,
) -> Result<worktree::BranchAvailability, String> {
    // 1. Get realm path
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let realm = db
        .get_realm(&realm_id)
        .map_err(|e| format!("Failed to look up realm: {}", e))?
        .ok_or_else(|| format!("Realm '{}' not found", realm_id))?;
    let realm_path = realm.path.clone();

    // Check if any session worktree is using this branch
    let worktrees = db.get_worktrees_for_realm(&realm_id)?;
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
    let available = worktree::is_branch_available(&realm_path, &branch_name, None)?;

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
    realm_id: String,
) -> Result<Option<crate::db::SessionWorktreeRow>, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    db.get_worktree_by_session_and_realm(&session_id, &realm_id)
        .map_err(|e| format!("Failed to look up worktree: {}", e))
}

#[tauri::command]
pub fn git_list_branches_for_realms(
    state: State<'_, AppState>,
    realm_ids: Vec<String>,
) -> Result<HashMap<String, Vec<GitBranch>>, String> {
    // Collect realm paths while holding the DB lock, then drop it before git I/O
    let realm_paths: Vec<(String, Option<String>)> = {
        let db = state
            .db
            .lock()
            .map_err(|e| format!("DB lock error: {}", e))?;
        realm_ids
            .iter()
            .map(|id| {
                let path = db.get_realm(id).ok().flatten().map(|r| r.path);
                (id.clone(), path)
            })
            .collect()
    };

    let mut result: HashMap<String, Vec<GitBranch>> = HashMap::new();

    for (realm_id, realm_path) in &realm_paths {
        let realm_path = match realm_path {
            Some(p) => p,
            None => {
                result.insert(realm_id.clone(), Vec::new());
                continue;
            }
        };

        let repo = match Repository::open(realm_path) {
            Ok(r) => r,
            Err(_) => {
                result.insert(realm_id.clone(), Vec::new());
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

        result.insert(realm_id.clone(), branches);
    }

    Ok(result)
}

#[tauri::command]
pub fn git_is_git_repo(state: State<'_, AppState>, realm_id: String) -> Result<bool, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let realm = db
        .get_realm(&realm_id)
        .map_err(|e| format!("Failed to look up realm: {}", e))?
        .ok_or_else(|| format!("Realm '{}' not found", realm_id))?;
    drop(db);

    Ok(Repository::open(&realm.path).is_ok())
}

// ─── Worktree Dirty Detection & Stash ───────────────────────────────

#[derive(Clone, serde::Serialize)]
pub struct WorktreeChanges {
    pub has_changes: bool,
    pub files: Vec<WorktreeChangedFile>,
}

#[derive(Clone, serde::Serialize)]
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
    } else if s.intersects(git2::Status::WT_MODIFIED | git2::Status::INDEX_MODIFIED) {
        "modified"
    } else {
        "modified"
    }
}

#[tauri::command]
pub fn git_worktree_has_changes(
    state: State<'_, AppState>,
    session_id: String,
    realm_id: String,
) -> Result<WorktreeChanges, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
    drop(db);

    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;

    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);

    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| format!("Failed to get statuses: {}", e))?;

    let mut files = Vec::new();
    for entry in statuses.iter() {
        let s = entry.status();
        if s.is_empty() {
            continue;
        }
        let file_path = entry.path().unwrap_or("").to_string();
        files.push(WorktreeChangedFile {
            path: file_path,
            status: map_status_flags(s).to_string(),
        });
    }

    Ok(WorktreeChanges {
        has_changes: !files.is_empty(),
        files,
    })
}

#[tauri::command]
pub fn git_stash_worktree(
    state: State<'_, AppState>,
    session_id: String,
    realm_id: String,
    message: Option<String>,
) -> Result<GitOperationResult, String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let project_path = resolve_worktree_path(&db, &session_id, &realm_id)?;
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
