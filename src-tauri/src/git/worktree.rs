use git2::{BranchType, Repository};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

// ─── Constants ──────────────────────────────────────────────────────

/// The directory within a repo where Hermes stores linked worktrees
const HERMES_WORKTREE_DIR: &str = ".hermes/worktrees";

// ─── Data Models ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeInfo {
    pub session_id: String,
    pub branch_name: Option<String>,
    pub worktree_path: String,
    pub is_main_worktree: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeCreateResult {
    pub worktree_path: String,
    pub branch_name: String,
    pub is_main_worktree: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchAvailability {
    pub available: bool,
    pub used_by_session: Option<String>,
    pub branch_name: String,
}

// ─── Helpers ────────────────────────────────────────────────────────

/// Sanitize a branch name for use in filesystem paths.
/// Replaces `/` with `-` and removes characters that are problematic in paths.
fn sanitize_branch_name(branch_name: &str) -> String {
    branch_name
        .replace('/', "-")
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect()
}

/// Build a worktree name from session_id and branch_name.
/// Format: `{first_8_of_session_id}_{sanitized_branch}`
fn worktree_name(session_id: &str, branch_name: &str) -> String {
    let prefix: String = session_id.chars().take(8).collect();
    let sanitized = sanitize_branch_name(branch_name);
    format!("{}_{}", prefix, sanitized)
}

// ─── Public API ─────────────────────────────────────────────────────

/// Ensure that `.hermes/` is listed in the repo's `.gitignore` so that
/// worktree directories (and any other Hermes metadata) are never tracked.
///
/// Creates `.gitignore` if it does not already exist.
pub fn ensure_hermes_gitignore(repo_path: &str) -> Result<(), String> {
    let gitignore_path = Path::new(repo_path).join(".gitignore");

    if gitignore_path.exists() {
        let content = fs::read_to_string(&gitignore_path)
            .map_err(|e| format!("Failed to read .gitignore: {}", e))?;

        // Check whether `.hermes/` (or `.hermes`) is already ignored
        let already_ignored = content
            .lines()
            .any(|line| {
                let trimmed = line.trim();
                trimmed == ".hermes/" || trimmed == ".hermes"
            });

        if already_ignored {
            return Ok(());
        }

        // Append the entry, ensuring we start on a new line
        let to_append = if content.ends_with('\n') || content.is_empty() {
            ".hermes/\n".to_string()
        } else {
            "\n.hermes/\n".to_string()
        };

        fs::write(&gitignore_path, format!("{}{}", content, to_append))
            .map_err(|e| format!("Failed to update .gitignore: {}", e))?;
    } else {
        fs::write(&gitignore_path, ".hermes/\n")
            .map_err(|e| format!("Failed to create .gitignore: {}", e))?;
    }

    Ok(())
}

/// Returns the base directory for Hermes worktrees within a repo.
/// Creates the directory tree if it does not already exist.
pub fn worktree_dir(repo_path: &str) -> PathBuf {
    let dir = Path::new(repo_path).join(HERMES_WORKTREE_DIR);
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir
}

/// Compute the filesystem path for a session's worktree.
///
/// Format: `{repo_path}/.hermes/worktrees/{session_prefix}_{branch}/`
pub fn worktree_path_for_session(repo_path: &str, session_id: &str, branch_name: &str) -> PathBuf {
    let base = worktree_dir(repo_path);
    base.join(worktree_name(session_id, branch_name))
}

/// Create a new git worktree for a session.
///
/// If `create_branch` is true, a new branch is created from HEAD before
/// adding the worktree. If false, the branch must already exist.
///
/// Uses `git worktree add` via the CLI because git2-rs does not expose a
/// reliable worktree-creation API.
pub fn create_worktree(
    repo_path: &str,
    session_id: &str,
    branch_name: &str,
    create_branch: bool,
) -> Result<WorktreeCreateResult, String> {
    // Validate that we can open the repository
    let repo = Repository::open(repo_path)
        .map_err(|e| format!("Failed to open repository at '{}': {}", repo_path, e))?;

    // Make sure .hermes/ is git-ignored
    ensure_hermes_gitignore(repo_path)?;

    let wt_path = worktree_path_for_session(repo_path, session_id, branch_name);
    let wt_path_str = wt_path
        .to_str()
        .ok_or_else(|| "Worktree path contains invalid UTF-8".to_string())?;

    // If the worktree directory already exists, return it directly
    if wt_path.exists() {
        return Ok(WorktreeCreateResult {
            worktree_path: wt_path_str.to_string(),
            branch_name: branch_name.to_string(),
            is_main_worktree: false,
        });
    }

    if create_branch {
        // Ensure the branch does not already exist before creating it
        if repo.find_branch(branch_name, BranchType::Local).is_err() {
            let head = repo
                .head()
                .map_err(|e| format!("Failed to get HEAD: {}", e))?;
            let commit = head
                .peel_to_commit()
                .map_err(|e| format!("Failed to resolve HEAD commit: {}", e))?;
            repo.branch(branch_name, &commit, false)
                .map_err(|e| format!("Failed to create branch '{}': {}", branch_name, e))?;
        }
    }

    // Build the `git worktree add` command
    let mut cmd = Command::new("git");
    cmd.current_dir(repo_path);

    if create_branch {
        // Branch already created above — just check it out in the new worktree
        cmd.args(["worktree", "add", wt_path_str, branch_name]);
    } else {
        cmd.args(["worktree", "add", wt_path_str, branch_name]);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run 'git worktree add': {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree add failed: {}", stderr.trim()));
    }

    Ok(WorktreeCreateResult {
        worktree_path: wt_path_str.to_string(),
        branch_name: branch_name.to_string(),
        is_main_worktree: false,
    })
}

/// Remove a worktree for a session.
///
/// Uses `git worktree remove --force` followed by `git worktree prune`.
/// Also cleans up the directory if it still lingers after removal.
pub fn remove_worktree(
    repo_path: &str,
    _session_id: &str,
    worktree_path: &str,
) -> Result<(), String> {
    // Step 1: git worktree remove --force <path>
    let remove_output = Command::new("git")
        .current_dir(repo_path)
        .args(["worktree", "remove", "--force", worktree_path])
        .output()
        .map_err(|e| format!("Failed to run 'git worktree remove': {}", e))?;

    if !remove_output.status.success() {
        let stderr = String::from_utf8_lossy(&remove_output.stderr);
        // Non-fatal: the directory may already be gone; prune will tidy up
        log::warn!("git worktree remove warning: {}", stderr.trim());
    }

    // Step 2: git worktree prune
    let prune_output = Command::new("git")
        .current_dir(repo_path)
        .args(["worktree", "prune"])
        .output()
        .map_err(|e| format!("Failed to run 'git worktree prune': {}", e))?;

    if !prune_output.status.success() {
        let stderr = String::from_utf8_lossy(&prune_output.stderr);
        log::warn!("git worktree prune warning: {}", stderr.trim());
    }

    // Step 3: Clean up the directory if it still exists
    let wt = Path::new(worktree_path);
    if wt.exists() {
        fs::remove_dir_all(wt)
            .map_err(|e| format!("Failed to remove worktree directory '{}': {}", worktree_path, e))?;
    }

    Ok(())
}

/// List the names of all linked worktrees in the repository.
///
/// Uses git2's `Repository::worktrees()` which returns the names of linked
/// worktrees (not the main worktree).
pub fn list_worktrees(repo_path: &str) -> Result<Vec<String>, String> {
    let repo = Repository::open(repo_path)
        .map_err(|e| format!("Failed to open repository at '{}': {}", repo_path, e))?;

    let worktrees = repo
        .worktrees()
        .map_err(|e| format!("Failed to list worktrees: {}", e))?;

    let names: Vec<String> = worktrees
        .iter()
        .filter_map(|name| name.map(|n| n.to_string()))
        .collect();

    Ok(names)
}

/// Check whether a branch is available (not checked out by any worktree).
///
/// If `exclude_worktree_path` is provided, that worktree is ignored during
/// the check (useful when the caller is the worktree that already has the
/// branch checked out and wants to know if anyone *else* does).
pub fn is_branch_available(
    repo_path: &str,
    branch_name: &str,
    exclude_worktree_path: Option<&str>,
) -> Result<bool, String> {
    let repo = Repository::open(repo_path)
        .map_err(|e| format!("Failed to open repository at '{}': {}", repo_path, e))?;

    // Check the main worktree's HEAD
    let main_path = repo
        .workdir()
        .map(|p| p.to_string_lossy().to_string());

    let should_skip_main = match (&main_path, exclude_worktree_path) {
        (Some(main), Some(exclude)) => {
            let main_canon = fs::canonicalize(main).ok();
            let excl_canon = fs::canonicalize(exclude).ok();
            main_canon.is_some() && main_canon == excl_canon
        }
        _ => false,
    };

    if !should_skip_main {
        if let Ok(Some(main_branch)) = get_worktree_branch(repo_path) {
            if main_branch == branch_name {
                return Ok(false);
            }
        }
    }

    // Check each linked worktree
    let worktree_names = repo
        .worktrees()
        .map_err(|e| format!("Failed to list worktrees: {}", e))?;

    for wt_name in worktree_names.iter().flatten() {
        let wt = repo
            .find_worktree(wt_name)
            .map_err(|e| format!("Failed to find worktree '{}': {}", wt_name, e))?;

        let wt_path_buf = wt.path().to_path_buf();
        let wt_path_str = wt_path_buf.to_string_lossy().to_string();

        // Skip the excluded worktree
        if let Some(exclude) = exclude_worktree_path {
            let wt_canon = fs::canonicalize(&wt_path_buf).ok();
            let excl_canon = fs::canonicalize(exclude).ok();
            if wt_canon.is_some() && wt_canon == excl_canon {
                continue;
            }
        }

        // Open the worktree as a Repository and check its HEAD
        if let Ok(Some(branch)) = get_worktree_branch(&wt_path_str) {
            if branch == branch_name {
                return Ok(false);
            }
        }
    }

    Ok(true)
}

/// Get the branch name that is checked out in a worktree (or the main repo).
///
/// Returns `Ok(None)` if HEAD is detached (not pointing at a branch).
pub fn get_worktree_branch(worktree_path: &str) -> Result<Option<String>, String> {
    let repo = Repository::open(worktree_path)
        .map_err(|e| format!("Failed to open repository at '{}': {}", worktree_path, e))?;

    let head = match repo.head() {
        Ok(h) => h,
        Err(e) => {
            // Unborn HEAD (empty repo) or other issue — treat as no branch
            log::debug!("Could not read HEAD at '{}': {}", worktree_path, e);
            return Ok(None);
        }
    };

    if !head.is_branch() {
        return Ok(None);
    }

    // head.shorthand() gives the branch name without `refs/heads/`
    Ok(head.shorthand().map(|s| s.to_string()))
}

/// Prune stale worktree bookkeeping entries and return how many were cleaned.
///
/// A worktree is "stale" when its directory has been deleted but git still
/// has metadata for it. `git worktree prune` removes those entries.
pub fn cleanup_stale_worktrees(repo_path: &str) -> Result<u32, String> {
    // Count worktrees before pruning
    let before = list_worktrees(repo_path)?.len() as u32;

    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["worktree", "prune", "--verbose"])
        .output()
        .map_err(|e| format!("Failed to run 'git worktree prune': {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree prune failed: {}", stderr.trim()));
    }

    // Count worktrees after pruning
    let after = list_worktrees(repo_path)?.len() as u32;

    let pruned = if before > after { before - after } else { 0 };

    Ok(pruned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::TempDir;

    /// Helper: create a fresh git repository with one commit so that HEAD exists.
    fn create_test_repo() -> TempDir {
        let dir = TempDir::new().unwrap();
        Command::new("git")
            .args(["init"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        Command::new("git")
            .args(["config", "user.email", "test@test.com"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        // Disable GPG signing for test commits
        Command::new("git")
            .args(["config", "commit.gpgsign", "false"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        // Create initial commit so HEAD is valid
        std::fs::write(dir.path().join("README.md"), "# Test").unwrap();
        Command::new("git")
            .args(["add", "."])
            .current_dir(dir.path())
            .output()
            .unwrap();
        let output = Command::new("git")
            .args(["commit", "-m", "Initial commit"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git commit failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        dir
    }

    // ── sanitize_branch_name (private helper) ──────────────────────────

    #[test]
    fn test_sanitize_branch_name_replaces_slashes() {
        assert_eq!(sanitize_branch_name("feature/auth"), "feature-auth");
    }

    #[test]
    fn test_sanitize_branch_name_strips_special_chars() {
        assert_eq!(sanitize_branch_name("fix: <bug> #1"), "fixbug1");
    }

    #[test]
    fn test_sanitize_branch_name_preserves_dots_underscores_dashes() {
        assert_eq!(sanitize_branch_name("v1.0_rc-1"), "v1.0_rc-1");
    }

    // ── worktree_name (private helper) ─────────────────────────────────

    #[test]
    fn test_worktree_name_format() {
        let name = worktree_name("abcdefghijklmnop", "main");
        assert_eq!(name, "abcdefgh_main");
    }

    #[test]
    fn test_worktree_name_short_session_id() {
        let name = worktree_name("abc", "main");
        assert_eq!(name, "abc_main");
    }

    // ── worktree_path_for_session ──────────────────────────────────────

    #[test]
    fn test_worktree_path_for_session_structure() {
        let path = worktree_path_for_session("/repo", "abc12345-extra", "feature/auth");
        let path_str = path.to_string_lossy();
        assert!(path_str.contains(".hermes/worktrees"));
        assert!(path_str.contains("abc12345_feature-auth"));
    }

    #[test]
    fn test_worktree_path_for_session_truncates_id() {
        let path = worktree_path_for_session("/repo", "abcdefghijklmnop", "main");
        let dirname = path.file_name().unwrap().to_string_lossy();
        assert!(dirname.starts_with("abcdefgh_"));
    }

    // ── worktree_dir ───────────────────────────────────────────────────

    #[test]
    fn test_worktree_dir_creates_directory() {
        let tmp = TempDir::new().unwrap();
        let repo_path = tmp.path().to_str().unwrap();
        let dir = worktree_dir(repo_path);
        assert!(dir.exists());
        assert!(dir.ends_with(".hermes/worktrees"));
    }

    // ── ensure_hermes_gitignore ────────────────────────────────────────

    #[test]
    fn test_ensure_gitignore_creates_file() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        // Remove .gitignore if it exists
        let gitignore_path = repo_dir.path().join(".gitignore");
        let _ = std::fs::remove_file(&gitignore_path);

        ensure_hermes_gitignore(repo_path).unwrap();

        let content = std::fs::read_to_string(&gitignore_path).unwrap();
        assert!(content.contains(".hermes/"));
    }

    #[test]
    fn test_ensure_gitignore_appends_to_existing() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();
        let gitignore_path = repo_dir.path().join(".gitignore");

        // Write a pre-existing .gitignore without trailing newline
        std::fs::write(&gitignore_path, "node_modules/").unwrap();
        ensure_hermes_gitignore(repo_path).unwrap();

        let content = std::fs::read_to_string(&gitignore_path).unwrap();
        assert!(content.contains("node_modules/"));
        assert!(content.contains(".hermes/"));
        // Should have a newline before .hermes/ since original had no trailing newline
        assert!(content.contains("\n.hermes/"));
    }

    #[test]
    fn test_ensure_gitignore_idempotent() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        ensure_hermes_gitignore(repo_path).unwrap();
        ensure_hermes_gitignore(repo_path).unwrap(); // second call

        let content = std::fs::read_to_string(repo_dir.path().join(".gitignore")).unwrap();
        assert_eq!(content.matches(".hermes/").count(), 1);
    }

    #[test]
    fn test_ensure_gitignore_recognises_variant_without_slash() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();
        let gitignore_path = repo_dir.path().join(".gitignore");

        // Write a gitignore that already has ".hermes" (no trailing slash)
        std::fs::write(&gitignore_path, ".hermes\n").unwrap();
        ensure_hermes_gitignore(repo_path).unwrap();

        let content = std::fs::read_to_string(&gitignore_path).unwrap();
        // Should not add a duplicate
        assert_eq!(content, ".hermes\n");
    }

    // ── create_worktree ────────────────────────────────────────────────

    #[test]
    fn test_create_worktree_new_branch() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        let result = create_worktree(repo_path, "session123", "test-branch", true);
        assert!(result.is_ok(), "create_worktree failed: {:?}", result.err());

        let wt = result.unwrap();
        assert_eq!(wt.branch_name, "test-branch");
        assert!(!wt.is_main_worktree);
        assert!(Path::new(&wt.worktree_path).exists());
    }

    #[test]
    fn test_create_worktree_existing_branch() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        // Create a branch first
        Command::new("git")
            .args(["branch", "existing-branch"])
            .current_dir(repo_dir.path())
            .output()
            .unwrap();

        let result = create_worktree(repo_path, "session456", "existing-branch", false);
        assert!(result.is_ok(), "create_worktree failed: {:?}", result.err());

        let wt = result.unwrap();
        assert_eq!(wt.branch_name, "existing-branch");
    }

    #[test]
    fn test_create_worktree_returns_existing_if_path_exists() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        let wt1 = create_worktree(repo_path, "session1", "my-branch", true).unwrap();
        // Calling again with the same session+branch should return the existing one
        let wt2 = create_worktree(repo_path, "session1", "my-branch", true).unwrap();

        assert_eq!(wt1.worktree_path, wt2.worktree_path);
    }

    #[test]
    fn test_create_worktree_invalid_repo_path() {
        let result = create_worktree("/nonexistent/path", "session1", "branch", true);
        assert!(result.is_err());
    }

    #[test]
    fn test_create_duplicate_branch_different_session() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        // Create first worktree on a branch
        create_worktree(repo_path, "session1", "dup-branch", true).unwrap();

        // Try to create second worktree on same branch with different session — should fail
        // because the branch is already checked out
        let result = create_worktree(repo_path, "session2", "dup-branch", false);
        assert!(result.is_err());
    }

    // ── remove_worktree ────────────────────────────────────────────────

    #[test]
    fn test_remove_worktree() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        let wt = create_worktree(repo_path, "session1", "temp-branch", true).unwrap();
        assert!(Path::new(&wt.worktree_path).exists());

        let result = remove_worktree(repo_path, "session1", &wt.worktree_path);
        assert!(result.is_ok());
        assert!(!Path::new(&wt.worktree_path).exists());
    }

    #[test]
    fn test_remove_worktree_already_gone() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        let wt = create_worktree(repo_path, "session1", "gone-branch", true).unwrap();
        // Manually delete the directory
        std::fs::remove_dir_all(&wt.worktree_path).unwrap();

        // Should still succeed (prune cleans up metadata)
        let result = remove_worktree(repo_path, "session1", &wt.worktree_path);
        assert!(result.is_ok());
    }

    // ── list_worktrees ─────────────────────────────────────────────────

    #[test]
    fn test_list_worktrees_empty() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        let list = list_worktrees(repo_path).unwrap();
        assert!(list.is_empty());
    }

    #[test]
    fn test_list_worktrees_after_create() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        create_worktree(repo_path, "session1", "list-branch-a", true).unwrap();
        create_worktree(repo_path, "session2", "list-branch-b", true).unwrap();

        let list = list_worktrees(repo_path).unwrap();
        assert_eq!(list.len(), 2);
    }

    #[test]
    fn test_list_worktrees_after_remove() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        let wt = create_worktree(repo_path, "session1", "remove-me", true).unwrap();
        assert_eq!(list_worktrees(repo_path).unwrap().len(), 1);

        remove_worktree(repo_path, "session1", &wt.worktree_path).unwrap();
        assert_eq!(list_worktrees(repo_path).unwrap().len(), 0);
    }

    // ── get_worktree_branch ────────────────────────────────────────────

    #[test]
    fn test_get_worktree_branch_main() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        let branch = get_worktree_branch(repo_path).unwrap();
        assert!(branch.is_some());
        let name = branch.unwrap();
        // Could be "main" or "master" depending on git config
        assert!(name == "main" || name == "master", "unexpected branch: {}", name);
    }

    #[test]
    fn test_get_worktree_branch_linked() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        let wt = create_worktree(repo_path, "session1", "linked-branch", true).unwrap();
        let branch = get_worktree_branch(&wt.worktree_path).unwrap();
        assert_eq!(branch, Some("linked-branch".to_string()));
    }

    #[test]
    fn test_get_worktree_branch_invalid_path() {
        let result = get_worktree_branch("/nonexistent/repo");
        assert!(result.is_err());
    }

    // ── is_branch_available ────────────────────────────────────────────

    #[test]
    fn test_branch_available_when_not_checked_out() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        Command::new("git")
            .args(["branch", "free-branch"])
            .current_dir(repo_dir.path())
            .output()
            .unwrap();

        let available = is_branch_available(repo_path, "free-branch", None).unwrap();
        assert!(available);
    }

    #[test]
    fn test_branch_unavailable_when_checked_out_in_main() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        // The current branch (main/master) is checked out in the main worktree
        let branch = get_worktree_branch(repo_path).unwrap().unwrap();
        let available = is_branch_available(repo_path, &branch, None).unwrap();
        assert!(!available);
    }

    #[test]
    fn test_branch_unavailable_when_checked_out_in_linked_worktree() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        create_worktree(repo_path, "session1", "wt-branch", true).unwrap();

        let available = is_branch_available(repo_path, "wt-branch", None).unwrap();
        assert!(!available);
    }

    #[test]
    fn test_branch_available_with_exclude() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        let wt = create_worktree(repo_path, "session1", "my-branch", true).unwrap();

        // Should be unavailable without exclude
        assert!(!is_branch_available(repo_path, "my-branch", None).unwrap());

        // But available when excluding the worktree that has it checked out
        assert!(is_branch_available(repo_path, "my-branch", Some(&wt.worktree_path)).unwrap());
    }

    #[test]
    fn test_branch_available_nonexistent_branch() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        // A branch that doesn't exist shouldn't be checked out anywhere
        let available = is_branch_available(repo_path, "no-such-branch", None).unwrap();
        assert!(available);
    }

    // ── cleanup_stale_worktrees ────────────────────────────────────────

    #[test]
    fn test_cleanup_stale_worktrees_no_stale() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        let pruned = cleanup_stale_worktrees(repo_path).unwrap();
        assert_eq!(pruned, 0);
    }

    #[test]
    fn test_cleanup_stale_worktrees_removes_stale() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        // Create a worktree then manually delete its directory to make it stale
        let wt = create_worktree(repo_path, "session1", "stale-branch", true).unwrap();
        assert_eq!(list_worktrees(repo_path).unwrap().len(), 1);

        std::fs::remove_dir_all(&wt.worktree_path).unwrap();

        let pruned = cleanup_stale_worktrees(repo_path).unwrap();
        assert_eq!(pruned, 1);
        assert_eq!(list_worktrees(repo_path).unwrap().len(), 0);
    }

    // ── WorktreeCreateResult serialization ─────────────────────────────

    #[test]
    fn test_worktree_create_result_serializes() {
        let result = WorktreeCreateResult {
            worktree_path: "/repo/.hermes/worktrees/abc_main".to_string(),
            branch_name: "main".to_string(),
            is_main_worktree: false,
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["branch_name"], "main");
        assert_eq!(json["is_main_worktree"], false);
    }

    #[test]
    fn test_worktree_info_serializes() {
        let info = WorktreeInfo {
            session_id: "sess1".to_string(),
            branch_name: Some("feature".to_string()),
            worktree_path: "/path".to_string(),
            is_main_worktree: true,
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["session_id"], "sess1");
        assert_eq!(json["is_main_worktree"], true);
    }
}
