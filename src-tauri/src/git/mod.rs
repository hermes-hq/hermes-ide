use git2::{
    Cred, DiffOptions, FetchOptions, IndexAddOption, PushOptions, RemoteCallbacks,
    Repository, StatusOptions,
};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::State;

use crate::AppState;

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
            if let Ok(home_str) = std::env::var("HOME") {
                let home = std::path::PathBuf::from(home_str);
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
                        if let Ok(cred) =
                            Cred::ssh_key(username, pub_key, key_path, None)
                        {
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
            if let Ok(token) = std::env::var("GITHUB_TOKEN")
                .or_else(|_| std::env::var("GIT_TOKEN"))
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
    } else if status.contains(git2::Status::INDEX_MODIFIED)
        || status.contains(git2::Status::WT_MODIFIED)
    {
        "modified"
    } else {
        "modified"
    }
}

/// Verify that a joined path does not escape the project root.
fn safe_join(project_path: &str, relative: &str) -> Result<std::path::PathBuf, String> {
    let base = std::fs::canonicalize(project_path)
        .map_err(|e| format!("Invalid project path: {}", e))?;
    let joined = base.join(relative);
    // Canonicalize if it exists, otherwise normalize manually
    let resolved = if joined.exists() {
        std::fs::canonicalize(&joined)
            .map_err(|e| format!("Invalid file path: {}", e))?
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

    let repo = match Repository::open(path) {
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
                if let Ok(branch_ref) = repo.find_branch(
                    head.shorthand().unwrap_or(""),
                    git2::BranchType::Local,
                ) {
                    if let Ok(upstream) = branch_ref.upstream() {
                        remote_branch =
                            upstream.name().ok().flatten().map(|s| s.to_string());

                        if let (Ok(local_oid), Some(remote_oid)) = (
                            repo.refname_to_id(name),
                            upstream
                                .get()
                                .name()
                                .and_then(|n| repo.refname_to_id(n).ok()),
                        ) {
                            if let Ok((a, b)) =
                                repo.graph_ahead_behind(local_oid, remote_oid)
                            {
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
    opts.include_untracked(true)
        .recurse_untracked_dirs(true);

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
                            d.old_file()
                                .path()
                                .map(|p| p.to_string_lossy().to_string())
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
                            d.old_file()
                                .path()
                                .map(|p| p.to_string_lossy().to_string())
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
                error: Some(format!("Failed to get status: {}", e)),
            };
        }
    }

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
    drop(db);

    let projects: Vec<GitProjectStatus> = realms
        .iter()
        .map(|r| get_project_git_status(&r.id, &r.name, &r.path))
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
}

#[tauri::command]
pub fn git_stage(project_path: String, paths: Vec<String>) -> Result<GitOperationResult, String> {
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
    project_path: String,
    paths: Vec<String>,
) -> Result<GitOperationResult, String> {
    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;

    let head_tree = repo
        .head()
        .and_then(|h| h.peel_to_tree())
        .ok();

    if paths.len() == 1 && paths[0] == "." {
        let all_paths: Vec<String> = vec!["*".to_string()];
        repo.reset_default(head_tree.as_ref().map(|t| t.as_object()), &all_paths)
            .map_err(|e| e.to_string())?;
    } else {
        repo.reset_default(
            head_tree.as_ref().map(|t| t.as_object()),
            &paths,
        )
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
    project_path: String,
    message: String,
    author_name: Option<String>,
    author_email: Option<String>,
) -> Result<GitOperationResult, String> {
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

    let parent = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok());

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
    project_path: String,
    remote: Option<String>,
) -> Result<GitOperationResult, String> {
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
    project_path: String,
    remote: Option<String>,
) -> Result<GitOperationResult, String> {
    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;
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

    Err("Pull requires a merge. Please resolve in terminal.".to_string())
}

#[tauri::command]
pub fn git_diff(
    project_path: String,
    file_path: String,
    staged: bool,
) -> Result<GitDiff, String> {
    let repo = Repository::open(&project_path).map_err(|e| e.to_string())?;

    let mut diff_opts = DiffOptions::new();
    diff_opts.pathspec(&file_path);

    let diff = if staged {
        let head_tree = repo
            .head()
            .and_then(|h| h.peel_to_tree())
            .ok();
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
pub fn git_open_file(project_path: String, file_path: String) -> Result<(), String> {
    // 1F: Path traversal guard
    let full_path = safe_join(&project_path, &file_path)?;
    std::process::Command::new("open")
        .arg(full_path.to_string_lossy().to_string())
        .spawn()
        .map_err(|e| format!("Failed to open file: {}", e))?;
    Ok(())
}
