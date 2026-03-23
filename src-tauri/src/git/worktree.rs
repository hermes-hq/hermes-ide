use git2::{BranchType, Repository};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

// ─── Constants ──────────────────────────────────────────────────────

/// The directory name used inside the app data directory to store worktrees.
/// This marker is also used by the frontend to detect worktree paths.
pub const HERMES_WORKTREE_MARKER: &str = "hermes-worktrees";

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
    /// True when the worktree was reused from another session (branch already checked out).
    /// The frontend should warn the user about shared file changes.
    #[serde(default)]
    pub is_shared: bool,
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

/// Deterministic FNV-1a hash for mapping repo paths to stable directory names.
fn fnv1a_hash(input: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// Compute a deterministic hash for a repo path, used as directory name.
/// Canonicalizes the path first so that different string representations
/// of the same directory produce the same hash.
pub fn repo_path_hash(repo_path: &str) -> String {
    let canonical = fs::canonicalize(repo_path).unwrap_or_else(|_| PathBuf::from(repo_path));
    let hash = fnv1a_hash(canonical.to_string_lossy().as_bytes());
    format!("{:016x}", hash)
}

// ─── Public API ─────────────────────────────────────────────────────

/// Returns the top-level directory for all Hermes worktrees.
/// Path: `{app_data_dir}/hermes-worktrees/`
pub fn worktrees_base_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(HERMES_WORKTREE_MARKER)
}

/// Returns the base directory for Hermes worktrees for a specific repo.
/// Creates the directory tree if it does not already exist.
/// Also writes a `repo_path.txt` file so we can map back to the repo.
///
/// Path: `{app_data_dir}/hermes-worktrees/{repo_hash}/`
pub fn worktree_dir(app_data_dir: &Path, repo_path: &str) -> PathBuf {
    let hash = repo_path_hash(repo_path);
    let dir = worktrees_base_dir(app_data_dir).join(&hash);
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    // Write repo_path.txt so cleanup can find the original repo
    let marker = dir.join("repo_path.txt");
    if !marker.exists() {
        let canonical = fs::canonicalize(repo_path).unwrap_or_else(|_| PathBuf::from(repo_path));
        let _ = fs::write(&marker, canonical.to_string_lossy().as_bytes());
    }
    dir
}

/// Read the repo path from a worktree hash directory's `repo_path.txt`.
pub fn read_repo_path(worktree_hash_dir: &Path) -> Option<String> {
    let marker = worktree_hash_dir.join("repo_path.txt");
    fs::read_to_string(marker).ok()
}

/// Compute the filesystem path for a session's worktree.
///
/// Path: `{app_data_dir}/hermes-worktrees/{repo_hash}/{session_prefix}_{branch}/`
pub fn worktree_path_for_session(
    app_data_dir: &Path,
    repo_path: &str,
    session_id: &str,
    branch_name: &str,
) -> PathBuf {
    let base = worktree_dir(app_data_dir, repo_path);
    base.join(worktree_name(session_id, branch_name))
}

/// Find an existing worktree that has the given branch checked out.
/// Uses `git worktree list --porcelain` to find it.
fn find_existing_worktree_for_branch(repo_path: &str, branch_name: &str) -> Option<String> {
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut current_path: Option<String> = None;

    for line in stdout.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            current_path = Some(path.to_string());
        } else if let Some(branch_ref) = line.strip_prefix("branch ") {
            // branch_ref looks like "refs/heads/feature/test1111"
            let short_name = branch_ref.strip_prefix("refs/heads/").unwrap_or(branch_ref);
            if short_name == branch_name {
                if let Some(ref path) = current_path {
                    return Some(path.clone());
                }
            }
        } else if line.is_empty() {
            current_path = None;
        }
    }

    None
}

/// Derive the local branch name from a remote ref by stripping the remote
/// prefix. For example, `"origin/feature-xyz"` becomes `"feature-xyz"`.
fn derive_local_branch_name(remote_ref: &str) -> String {
    // Strip the first path component (e.g. "origin/")
    if let Some(pos) = remote_ref.find('/') {
        remote_ref[pos + 1..].to_string()
    } else {
        remote_ref.to_string()
    }
}

/// Create a new git worktree for a session.
///
/// Worktrees are stored outside the project directory in the app data dir
/// to avoid polluting the user's project with Hermes internal files.
///
/// If `create_branch` is true, a new branch is created from HEAD before
/// adding the worktree. If false, the branch must already exist.
///
/// If `from_remote` is `Some(remote_ref)` (e.g. `"origin/feature-xyz"`),
/// the worktree is created from the remote branch. A local tracking branch
/// is created automatically. If a local branch with the derived name
/// already exists, it must point to the same commit as the remote ref;
/// otherwise an error is returned.
///
/// Uses `git worktree add` via the CLI because git2-rs does not expose a
/// reliable worktree-creation API.
pub fn create_worktree(
    app_data_dir: &Path,
    repo_path: &str,
    session_id: &str,
    branch_name: &str,
    create_branch: bool,
    from_remote: Option<&str>,
) -> Result<WorktreeCreateResult, String> {
    // Validate that we can open the repository
    let repo = Repository::open(repo_path)
        .map_err(|e| format!("Failed to open repository at '{}': {}", repo_path, e))?;

    // When creating from a remote branch, derive the local name and use it
    // for the worktree path and branch name.
    if let Some(remote_ref) = from_remote {
        let local_name = derive_local_branch_name(remote_ref);

        let wt_path = worktree_path_for_session(app_data_dir, repo_path, session_id, &local_name);
        let wt_path_str = wt_path
            .to_str()
            .ok_or_else(|| "Worktree path contains invalid UTF-8".to_string())?;

        // If the worktree directory already exists, return it directly
        if wt_path.exists() {
            return Ok(WorktreeCreateResult {
                worktree_path: wt_path_str.to_string(),
                branch_name: local_name,
                is_main_worktree: false,
                is_shared: false,
            });
        }

        // Check if a local branch with the derived name already exists
        if let Ok(local_branch) = repo.find_branch(&local_name, BranchType::Local) {
            // Local branch exists — verify it points to the same commit as the remote
            let remote_branch = repo
                .find_branch(remote_ref, BranchType::Remote)
                .map_err(|e| format!("Remote branch '{}' not found: {}", remote_ref, e))?;

            let local_oid = local_branch
                .get()
                .peel_to_commit()
                .map_err(|e| format!("Failed to resolve local branch commit: {}", e))?
                .id();
            let remote_oid = remote_branch
                .get()
                .peel_to_commit()
                .map_err(|e| format!("Failed to resolve remote branch commit: {}", e))?
                .id();

            if local_oid != remote_oid {
                return Err(format!(
                    "Local branch '{}' exists but points to a different commit than '{}'. \
                     Please resolve the conflict manually before creating a worktree.",
                    local_name, remote_ref
                ));
            }

            // Same commit — use the existing local branch directly
            let mut cmd = Command::new("git");
            cmd.current_dir(repo_path);
            cmd.args(["worktree", "add", wt_path_str, &local_name]);

            let output = cmd
                .output()
                .map_err(|e| format!("Failed to run 'git worktree add': {}", e))?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);

                if stderr.contains("is already used by worktree at")
                    || stderr.contains("is already checked out at")
                {
                    if let Some(existing_path) =
                        find_existing_worktree_for_branch(repo_path, &local_name)
                    {
                        return Ok(WorktreeCreateResult {
                            worktree_path: existing_path,
                            branch_name: local_name,
                            is_main_worktree: false,
                            is_shared: true,
                        });
                    }
                }

                return Err(format!("git worktree add failed: {}", stderr.trim()));
            }

            return Ok(WorktreeCreateResult {
                worktree_path: wt_path_str.to_string(),
                branch_name: local_name,
                is_main_worktree: false,
                is_shared: false,
            });
        }

        // No local branch exists — create one tracking the remote ref
        // `git worktree add -b <local_name> <path> <remote_ref>`
        let mut cmd = Command::new("git");
        cmd.current_dir(repo_path);
        cmd.args([
            "worktree",
            "add",
            "-b",
            &local_name,
            wt_path_str,
            remote_ref,
        ]);

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run 'git worktree add': {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git worktree add failed: {}", stderr.trim()));
        }

        return Ok(WorktreeCreateResult {
            worktree_path: wt_path_str.to_string(),
            branch_name: local_name,
            is_main_worktree: false,
            is_shared: false,
        });
    }

    // ── from_remote is None — existing behavior ─────────────────────

    let wt_path = worktree_path_for_session(app_data_dir, repo_path, session_id, branch_name);
    let wt_path_str = wt_path
        .to_str()
        .ok_or_else(|| "Worktree path contains invalid UTF-8".to_string())?;

    // If the worktree directory already exists, return it directly
    if wt_path.exists() {
        return Ok(WorktreeCreateResult {
            worktree_path: wt_path_str.to_string(),
            branch_name: branch_name.to_string(),
            is_main_worktree: false,
            is_shared: false,
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
    cmd.args(["worktree", "add", wt_path_str, branch_name]);

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run 'git worktree add': {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);

        // If the branch is already checked out in another worktree, find and reuse it.
        // Git error: "'branch' is already used by worktree at '/path/to/worktree'"
        if stderr.contains("is already used by worktree at")
            || stderr.contains("is already checked out at")
        {
            if let Some(existing_path) = find_existing_worktree_for_branch(repo_path, branch_name) {
                return Ok(WorktreeCreateResult {
                    worktree_path: existing_path,
                    branch_name: branch_name.to_string(),
                    is_main_worktree: false,
                    is_shared: true,
                });
            }
        }

        return Err(format!("git worktree add failed: {}", stderr.trim()));
    }

    Ok(WorktreeCreateResult {
        worktree_path: wt_path_str.to_string(),
        branch_name: branch_name.to_string(),
        is_main_worktree: false,
        is_shared: false,
    })
}

/// Remove a worktree for a session.
///
/// Uses `git worktree remove --force` followed by `git worktree prune`.
/// Also cleans up the directory if it still lingers after removal.
///
/// # Safety
///
/// This function contains multiple guards to prevent catastrophic deletion
/// of project root directories. The `worktree_path` MUST be a linked
/// worktree inside the app data `hermes-worktrees/` directory, never the
/// repo root itself.
pub fn remove_worktree(
    repo_path: &str,
    _session_id: &str,
    worktree_path: &str,
) -> Result<(), String> {
    // ── SAFETY CHECKS ──────────────────────────────────────────────
    // These guards exist to prevent accidental deletion of a project
    // root directory. A bug in a caller could pass the repo root as
    // worktree_path (e.g. when is_main_worktree is true). If that
    // happens, `git worktree remove` will fail (main worktree), and
    // without these guards the fallback `remove_dir_all` would
    // recursively destroy the entire project.

    // Guard 1: worktree_path must live under hermes-worktrees/
    // Normalize separators for cross-platform check (Windows uses backslashes)
    let normalized = worktree_path.replace('\\', "/");
    if !normalized.contains("hermes-worktrees/") {
        return Err(format!(
            "SAFETY: refusing to remove path outside hermes-worktrees/: '{}'",
            worktree_path
        ));
    }

    // Guard 2: worktree_path must never equal the repo root
    let repo_canon = fs::canonicalize(repo_path).ok();
    let wt_canon = fs::canonicalize(worktree_path).ok();
    if let (Some(rc), Some(wc)) = (&repo_canon, &wt_canon) {
        if rc == wc {
            return Err(format!(
                "SAFETY: refusing to remove repo root directory: '{}'",
                worktree_path
            ));
        }
        // Guard 3: worktree_path must not be a parent of the repo root
        if rc.starts_with(wc) {
            return Err(format!(
                "SAFETY: refusing to remove ancestor of repo root: '{}'",
                worktree_path
            ));
        }
    }

    // ── REMOVAL ────────────────────────────────────────────────────

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
        // Final safety re-check before the destructive operation
        if !normalized.contains("hermes-worktrees/") {
            return Err(format!(
                "SAFETY: last-resort guard prevented remove_dir_all on: '{}'",
                worktree_path
            ));
        }
        fs::remove_dir_all(wt).map_err(|e| {
            format!(
                "Failed to remove worktree directory '{}': {}",
                worktree_path, e
            )
        })?;
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
    let main_path = repo.workdir().map(|p| p.to_string_lossy().to_string());

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

    let pruned = before.saturating_sub(after);

    Ok(pruned)
}

/// Check if a path is inside the Hermes worktrees directory.
pub fn is_hermes_worktree_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    normalized.contains("hermes-worktrees/")
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

    /// Helper: create a temp directory to act as app_data_dir for tests.
    fn create_test_app_data_dir() -> TempDir {
        TempDir::new().unwrap()
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
        let app_data = create_test_app_data_dir();
        let path =
            worktree_path_for_session(app_data.path(), "/repo", "abc12345-extra", "feature/auth");
        let path_str = path.to_string_lossy();
        assert!(path_str.contains("hermes-worktrees"));
        assert!(path_str.contains("abc12345_feature-auth"));
    }

    #[test]
    fn test_worktree_path_for_session_truncates_id() {
        let app_data = create_test_app_data_dir();
        let path = worktree_path_for_session(app_data.path(), "/repo", "abcdefghijklmnop", "main");
        let dirname = path.file_name().unwrap().to_string_lossy();
        assert!(dirname.starts_with("abcdefgh_"));
    }

    // ── worktree_dir ───────────────────────────────────────────────────

    #[test]
    fn test_worktree_dir_creates_directory() {
        let app_data = create_test_app_data_dir();
        let repo = create_test_repo();
        let repo_path = repo.path().to_str().unwrap();
        let dir = worktree_dir(app_data.path(), repo_path);
        assert!(dir.exists());
        // Should be under hermes-worktrees
        let dir_str = dir.to_string_lossy();
        assert!(dir_str.contains("hermes-worktrees"));
        // Should have a repo_path.txt marker
        assert!(dir.join("repo_path.txt").exists());
    }

    // ── repo_path_hash ────────────────────────────────────────────────

    #[test]
    fn test_repo_path_hash_deterministic() {
        let repo = create_test_repo();
        let repo_path = repo.path().to_str().unwrap();
        let hash1 = repo_path_hash(repo_path);
        let hash2 = repo_path_hash(repo_path);
        assert_eq!(hash1, hash2);
        assert_eq!(hash1.len(), 16); // 16 hex chars
    }

    // ── create_worktree ────────────────────────────────────────────────

    #[test]
    fn test_create_worktree_new_branch() {
        let app_data = create_test_app_data_dir();
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        let result = create_worktree(
            app_data.path(),
            repo_path,
            "session123",
            "test-branch",
            true,
            None,
        );
        assert!(result.is_ok(), "create_worktree failed: {:?}", result.err());

        let wt = result.unwrap();
        assert_eq!(wt.branch_name, "test-branch");
        assert!(!wt.is_main_worktree);
        assert!(Path::new(&wt.worktree_path).exists());
        // Worktree should be outside the repo
        assert!(!wt.worktree_path.contains(repo_path));
        assert!(wt.worktree_path.contains("hermes-worktrees"));
    }

    #[test]
    fn test_create_worktree_existing_branch() {
        let app_data = create_test_app_data_dir();
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        // Create a branch first
        Command::new("git")
            .args(["branch", "existing-branch"])
            .current_dir(repo_dir.path())
            .output()
            .unwrap();

        let result = create_worktree(
            app_data.path(),
            repo_path,
            "session456",
            "existing-branch",
            false,
            None,
        );
        assert!(result.is_ok(), "create_worktree failed: {:?}", result.err());

        let wt = result.unwrap();
        assert_eq!(wt.branch_name, "existing-branch");
    }

    #[test]
    fn test_create_worktree_returns_existing_if_path_exists() {
        let app_data = create_test_app_data_dir();
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        let wt1 = create_worktree(
            app_data.path(),
            repo_path,
            "session1",
            "my-branch",
            true,
            None,
        )
        .unwrap();
        // Calling again with the same session+branch should return the existing one
        let wt2 = create_worktree(
            app_data.path(),
            repo_path,
            "session1",
            "my-branch",
            true,
            None,
        )
        .unwrap();

        assert_eq!(wt1.worktree_path, wt2.worktree_path);
    }

    #[test]
    fn test_create_worktree_invalid_repo_path() {
        let app_data = create_test_app_data_dir();
        let result = create_worktree(
            app_data.path(),
            "/nonexistent/path",
            "session1",
            "branch",
            true,
            None,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_create_duplicate_branch_different_session() {
        let app_data = create_test_app_data_dir();
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        // Create first worktree on a branch
        create_worktree(
            app_data.path(),
            repo_path,
            "session1",
            "dup-branch",
            true,
            None,
        )
        .unwrap();

        // Creating with a different session reuses the existing worktree (shared)
        let wt2 = create_worktree(
            app_data.path(),
            repo_path,
            "session2",
            "dup-branch",
            false,
            None,
        )
        .unwrap();
        assert!(wt2.is_shared);
        assert_eq!(wt2.branch_name, "dup-branch");
    }

    // ── remove_worktree ────────────────────────────────────────────────

    #[test]
    fn test_remove_worktree() {
        let app_data = create_test_app_data_dir();
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        let wt = create_worktree(
            app_data.path(),
            repo_path,
            "session1",
            "temp-branch",
            true,
            None,
        )
        .unwrap();
        assert!(Path::new(&wt.worktree_path).exists());

        let result = remove_worktree(repo_path, "session1", &wt.worktree_path);
        assert!(result.is_ok());
        assert!(!Path::new(&wt.worktree_path).exists());
    }

    #[test]
    fn test_remove_worktree_already_gone() {
        let app_data = create_test_app_data_dir();
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        let wt = create_worktree(
            app_data.path(),
            repo_path,
            "session1",
            "gone-branch",
            true,
            None,
        )
        .unwrap();
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
        let app_data = create_test_app_data_dir();
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        create_worktree(
            app_data.path(),
            repo_path,
            "session1",
            "list-branch-a",
            true,
            None,
        )
        .unwrap();
        create_worktree(
            app_data.path(),
            repo_path,
            "session2",
            "list-branch-b",
            true,
            None,
        )
        .unwrap();

        let list = list_worktrees(repo_path).unwrap();
        assert_eq!(list.len(), 2);
    }

    #[test]
    fn test_list_worktrees_after_remove() {
        let app_data = create_test_app_data_dir();
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        let wt = create_worktree(
            app_data.path(),
            repo_path,
            "session1",
            "remove-me",
            true,
            None,
        )
        .unwrap();
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
        assert!(
            name == "main" || name == "master",
            "unexpected branch: {}",
            name
        );
    }

    #[test]
    fn test_get_worktree_branch_linked() {
        let app_data = create_test_app_data_dir();
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        let wt = create_worktree(
            app_data.path(),
            repo_path,
            "session1",
            "linked-branch",
            true,
            None,
        )
        .unwrap();
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
        let app_data = create_test_app_data_dir();
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        create_worktree(
            app_data.path(),
            repo_path,
            "session1",
            "wt-branch",
            true,
            None,
        )
        .unwrap();

        let available = is_branch_available(repo_path, "wt-branch", None).unwrap();
        assert!(!available);
    }

    #[test]
    fn test_branch_available_with_exclude() {
        let app_data = create_test_app_data_dir();
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        let wt = create_worktree(
            app_data.path(),
            repo_path,
            "session1",
            "my-branch",
            true,
            None,
        )
        .unwrap();

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
        let app_data = create_test_app_data_dir();
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        // Create a worktree then manually delete its directory to make it stale
        let wt = create_worktree(
            app_data.path(),
            repo_path,
            "session1",
            "stale-branch",
            true,
            None,
        )
        .unwrap();
        assert_eq!(list_worktrees(repo_path).unwrap().len(), 1);

        std::fs::remove_dir_all(&wt.worktree_path).unwrap();

        let pruned = cleanup_stale_worktrees(repo_path).unwrap();
        assert_eq!(pruned, 1);
        assert_eq!(list_worktrees(repo_path).unwrap().len(), 0);
    }

    // ── is_hermes_worktree_path ──────────────────────────────────────

    #[test]
    fn test_is_hermes_worktree_path() {
        assert!(is_hermes_worktree_path(
            "/app/data/hermes-worktrees/abc123/sess_main"
        ));
        assert!(is_hermes_worktree_path(
            "C:\\app\\hermes-worktrees\\abc\\sess_main"
        ));
        assert!(!is_hermes_worktree_path("/Users/dev/project/src"));
        assert!(!is_hermes_worktree_path(
            "/Users/dev/project/.hermes/worktrees/abc"
        ));
    }

    // ── WorktreeCreateResult serialization ─────────────────────────────

    #[test]
    fn test_worktree_create_result_serializes() {
        let result = WorktreeCreateResult {
            worktree_path: "/app/data/hermes-worktrees/hash/abc_main".to_string(),
            branch_name: "main".to_string(),
            is_main_worktree: false,
            is_shared: false,
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

    // ── derive_local_branch_name ─────────────────────────────────────

    #[test]
    fn test_derive_local_branch_name_simple() {
        assert_eq!(
            derive_local_branch_name("origin/feature-xyz"),
            "feature-xyz"
        );
    }

    #[test]
    fn test_derive_local_branch_name_nested() {
        assert_eq!(
            derive_local_branch_name("origin/feature/sub-feature"),
            "feature/sub-feature"
        );
    }

    #[test]
    fn test_derive_local_branch_name_no_slash() {
        assert_eq!(derive_local_branch_name("main"), "main");
    }

    // ── create_worktree from remote branch ──────────────────────────

    /// Helper: create a "remote" repo and a "local" clone so we have remote
    /// branches to test against.
    fn create_cloned_test_repos() -> (TempDir, TempDir) {
        let remote_dir = create_test_repo();

        // Create a branch in the remote repo
        Command::new("git")
            .args(["branch", "feature-xyz"])
            .current_dir(remote_dir.path())
            .output()
            .unwrap();

        // Clone the remote repo into a local repo
        let local_dir = TempDir::new().unwrap();
        let output = Command::new("git")
            .args([
                "clone",
                remote_dir.path().to_str().unwrap(),
                local_dir.path().to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git clone failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        // Configure the local clone for commits
        for (key, val) in &[
            ("user.email", "test@test.com"),
            ("user.name", "Test"),
            ("commit.gpgsign", "false"),
        ] {
            Command::new("git")
                .args(["config", key, val])
                .current_dir(local_dir.path())
                .output()
                .unwrap();
        }

        (remote_dir, local_dir)
    }

    #[test]
    fn test_create_worktree_from_remote_branch() {
        let app_data = create_test_app_data_dir();
        let (_remote_dir, local_dir) = create_cloned_test_repos();
        let local_path = local_dir.path().to_str().unwrap();

        let result = create_worktree(
            app_data.path(),
            local_path,
            "session1",
            "",
            false,
            Some("origin/feature-xyz"),
        );
        assert!(result.is_ok(), "create_worktree failed: {:?}", result.err());

        let wt = result.unwrap();
        assert_eq!(wt.branch_name, "feature-xyz");
        assert!(!wt.is_main_worktree);
        assert!(Path::new(&wt.worktree_path).exists());

        // Verify the local branch was created and is checked out
        let branch = get_worktree_branch(&wt.worktree_path).unwrap();
        assert_eq!(branch, Some("feature-xyz".to_string()));
    }

    #[test]
    fn test_create_worktree_remote_with_existing_local_same_commit() {
        let app_data = create_test_app_data_dir();
        let (_remote_dir, local_dir) = create_cloned_test_repos();
        let local_path = local_dir.path().to_str().unwrap();

        // Create a local branch tracking the remote one (at the same commit)
        Command::new("git")
            .args(["branch", "feature-xyz", "origin/feature-xyz"])
            .current_dir(local_dir.path())
            .output()
            .unwrap();

        // Should succeed since local and remote point to the same commit
        let result = create_worktree(
            app_data.path(),
            local_path,
            "session1",
            "",
            false,
            Some("origin/feature-xyz"),
        );
        assert!(result.is_ok(), "create_worktree failed: {:?}", result.err());

        let wt = result.unwrap();
        assert_eq!(wt.branch_name, "feature-xyz");
    }

    #[test]
    fn test_create_worktree_remote_with_existing_local_different_commit() {
        let app_data = create_test_app_data_dir();
        let (_remote_dir, local_dir) = create_cloned_test_repos();
        let local_path = local_dir.path().to_str().unwrap();

        // Create a local branch that diverges from the remote
        Command::new("git")
            .args(["checkout", "-b", "feature-xyz"])
            .current_dir(local_dir.path())
            .output()
            .unwrap();
        std::fs::write(local_dir.path().join("diverge.txt"), "diverged").unwrap();
        Command::new("git")
            .args(["add", "."])
            .current_dir(local_dir.path())
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-m", "Diverge"])
            .current_dir(local_dir.path())
            .output()
            .unwrap();
        // Go back to main so worktree creation can proceed
        Command::new("git")
            .args(["checkout", "main"])
            .current_dir(local_dir.path())
            .output()
            .unwrap();

        // Should fail because local and remote point to different commits
        let result = create_worktree(
            app_data.path(),
            local_path,
            "session1",
            "",
            false,
            Some("origin/feature-xyz"),
        );
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("different commit"),
            "Expected conflict error, got: {}",
            err
        );
    }

    #[test]
    fn test_create_worktree_remote_none_backward_compat() {
        let app_data = create_test_app_data_dir();
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        // from_remote=None should behave exactly like the old create_worktree
        let result = create_worktree(
            app_data.path(),
            repo_path,
            "session1",
            "compat-branch",
            true,
            None,
        );
        assert!(result.is_ok(), "create_worktree failed: {:?}", result.err());

        let wt = result.unwrap();
        assert_eq!(wt.branch_name, "compat-branch");
        assert!(!wt.is_main_worktree);
        assert!(Path::new(&wt.worktree_path).exists());
    }
}
