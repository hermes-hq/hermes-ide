use git2::{BranchType, Repository};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

// ─── Constants ──────────────────────────────────────────────────────

/// The directory name used inside the app data directory to store worktrees.
/// This marker is also used by the frontend to detect worktree paths.
pub const HERMES_WORKTREE_MARKER: &str = "hermes-worktrees";

// ─── Data Models ────────────────────────────────────────────────────

/// Sent to the frontend in camelCase, which is what `src/types/git.ts` reads.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub session_id: String,
    pub branch_name: Option<String>,
    pub worktree_path: String,
    pub is_main_worktree: bool,
}

/// Sent to the frontend in camelCase, which is what `src/types/git.ts` reads.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCreateResult {
    pub worktree_path: String,
    pub branch_name: String,
    pub is_main_worktree: bool,
}

/// Prefix of the error `create_worktree` returns when the branch is already
/// checked out somewhere else (another session's worktree or the project
/// folder itself). The rest of the message is JSON: `{"branch", "path"}`.
///
/// Creating a session never falls back to sharing that checkout on its own:
/// the frontend shows a blocking choice (reuse it on purpose, use a new
/// branch, or cancel) and, for "reuse", calls `attach_existing_worktree`.
pub const BRANCH_IN_USE_PREFIX: &str = "BRANCH_IN_USE:";

/// Build the `BRANCH_IN_USE:` error for `branch`, checked out at `path`.
pub fn branch_in_use_error(branch: &str, path: &str) -> String {
    format!(
        "{}{}",
        BRANCH_IN_USE_PREFIX,
        serde_json::json!({ "branch": branch, "path": path })
    )
}

/// Parse an error built by `branch_in_use_error` back into (branch, path).
pub fn parse_branch_in_use_error(err: &str) -> Option<(String, String)> {
    let json = err.strip_prefix(BRANCH_IN_USE_PREFIX)?;
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    Some((
        v.get("branch")?.as_str()?.to_string(),
        v.get("path")?.as_str()?.to_string(),
    ))
}

/// How a branch name collides with a local branch that already exists.
///
/// Git keeps a branch as a file under `.git/refs/heads/`. On a file system
/// that ignores letter case (macOS, Windows) `Develop` and `develop` are the
/// same file, so "creating" `Develop` next to `develop` silently hands back
/// `develop`, and a commit made on it moves `develop`. The same goes for a
/// folder of branches (`Feature/x` next to `feature/y` lands in `feature/`).
/// Hermes treats these names as taken on every OS: a repository made on
/// Linux is often cloned on a Mac.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BranchClash {
    /// A branch with exactly this name exists.
    Same(String),
    /// A branch whose name differs only in letter case exists (the name it has).
    Case(String),
    /// A folder of the name differs only in letter case from one an existing
    /// branch uses (that branch's name).
    Folder(String),
}

impl BranchClash {
    /// The existing branch the name collides with.
    pub fn existing(&self) -> &str {
        match self {
            BranchClash::Same(b) | BranchClash::Case(b) | BranchClash::Folder(b) => b,
        }
    }
}

/// How `name` collides with one of `existing` (exact names first, then a
/// case-only match, then a case-only folder match), or None when it does not.
pub fn branch_name_clash<'a, I>(name: &str, existing: I) -> Option<BranchClash>
where
    I: IntoIterator<Item = &'a str>,
{
    let lower = name.to_lowercase();
    let parts: Vec<&str> = name.split('/').collect();
    let mut case = None;
    let mut folder = None;
    for other in existing {
        if other == name {
            return Some(BranchClash::Same(other.to_string()));
        }
        if case.is_none() && other.to_lowercase() == lower {
            case = Some(other.to_string());
            continue;
        }
        if folder.is_none() {
            // The first folder (or the name itself) where the two differ:
            // when it differs only in case, one folder on disk holds both.
            let first_diff = parts
                .iter()
                .zip(other.split('/'))
                .find(|(a, b)| *a != b)
                .map(|(a, b)| (a.to_lowercase(), b.to_lowercase()));
            if let Some((a, b)) = first_diff {
                if a == b {
                    folder = Some(other.to_string());
                }
            }
        }
    }
    case.map(BranchClash::Case)
        .or(folder.map(BranchClash::Folder))
}

/// `branch_name_clash` against the local branches of `repo`.
pub fn local_branch_clash(repo: &Repository, name: &str) -> Option<BranchClash> {
    let names: Vec<String> = repo
        .branches(Some(BranchType::Local))
        .map(|it| {
            it.filter_map(|b| b.ok())
                .filter_map(|(b, _)| b.name().ok().flatten().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    branch_name_clash(name, names.iter().map(String::as_str))
}

/// Prefix of the error returned when a branch cannot be created or used
/// because its name collides with an existing branch (see `BranchClash`).
/// The rest of the message says which branch, for a person to read.
pub const BRANCH_NAME_CLASH_PREFIX: &str = "BRANCH_NAME_CLASH:";

/// The error for `name`, which collides as `clash` says.
pub fn branch_clash_error(name: &str, clash: &BranchClash) -> String {
    let why = match clash {
        BranchClash::Same(b) => format!("a branch named '{b}' already exists"),
        BranchClash::Case(b) => format!(
            "it differs from the existing branch '{b}' only in letter case, and on macOS and Windows they are the same branch"
        ),
        BranchClash::Folder(b) => format!(
            "its folder differs from the one of the existing branch '{b}' only in letter case, and on macOS and Windows they are the same folder"
        ),
    };
    format!(
        "{BRANCH_NAME_CLASH_PREFIX} cannot use the branch name '{name}': {why}. Choose '{}' as an existing branch, or pick another name.",
        clash.existing()
    )
}

/// Which branch `commit_worktree_changes` puts a session's uncommitted work on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommitTarget {
    /// Commit on the branch the worktree has checked out.
    Session,
    /// Leave the session branch as it is and save the work on a new
    /// `hermes-archive/<branch>` branch cut from it.
    Archive,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitOutcome {
    /// Branch the commit landed on.
    pub branch: String,
    /// Full id of the new commit.
    pub commit: String,
    /// Number of paths the commit recorded (added, changed or deleted).
    pub files: usize,
}

/// Sent to the frontend in camelCase, which is what `src/types/git.ts` reads.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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

/// Where `create_worktree` would put a session's worktree, computed without
/// creating any folder or marker file (unlike `worktree_path_for_session`).
pub fn intended_worktree_path(
    app_data_dir: &Path,
    repo_path: &str,
    session_id: &str,
    branch_name: &str,
    from_remote: Option<&str>,
) -> PathBuf {
    let branch = from_remote
        .map(derive_local_branch_name)
        .unwrap_or_else(|| branch_name.to_string());
    worktrees_base_dir(app_data_dir)
        .join(repo_path_hash(repo_path))
        .join(worktree_name(session_id, &branch))
}

/// True when `create_worktree` would hand back a worktree that already
/// exists (this session's folder, or the branch checked out elsewhere)
/// instead of adding a new one. Such a reuse needs no disk space.
pub fn would_reuse_existing_worktree(
    app_data_dir: &Path,
    repo_path: &str,
    session_id: &str,
    branch_name: &str,
    from_remote: Option<&str>,
) -> bool {
    if intended_worktree_path(
        app_data_dir,
        repo_path,
        session_id,
        branch_name,
        from_remote,
    )
    .exists()
    {
        return true;
    }
    let branch = from_remote
        .map(derive_local_branch_name)
        .unwrap_or_else(|| branch_name.to_string());
    find_existing_worktree_for_branch(repo_path, &branch).is_some()
}

/// Find an existing worktree that has the given branch checked out.
/// Uses `git worktree list --porcelain` to find it.
fn find_existing_worktree_for_branch(repo_path: &str, branch_name: &str) -> Option<String> {
    let output = crate::git::cli::git_command()
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

/// Map `git worktree add` stderr saying the branch is checked out elsewhere
/// to a `BRANCH_IN_USE:` error naming where it is checked out.
fn branch_in_use_from_stderr(repo_path: &str, branch_name: &str, stderr: &str) -> Option<String> {
    if !(stderr.contains("is already used by worktree at")
        || stderr.contains("is already checked out at"))
    {
        return None;
    }
    let path = find_existing_worktree_for_branch(repo_path, branch_name)
        .unwrap_or_else(|| repo_path.to_string());
    Some(branch_in_use_error(branch_name, &path))
}

/// Whether two paths name the same directory.
///
/// The same checkout is spelled differently depending on who wrote it down:
/// `git worktree list` prints the resolved path with forward slashes
/// (`/private/var/...` on macOS, `C:/...` on Windows) while Hermes stores the
/// path it built (`/var/...`, `C:\...`). Existing directories are compared
/// after resolving symlinks; otherwise the spelling is normalised (slashes,
/// trailing separators, and case on Windows).
pub fn same_dir(a: &str, b: &str) -> bool {
    if let (Ok(x), Ok(y)) = (fs::canonicalize(a), fs::canonicalize(b)) {
        return x == y;
    }
    normalize_path_spelling(a) == normalize_path_spelling(b)
}

fn normalize_path_spelling(p: &str) -> String {
    let s = p.replace('\\', "/");
    let s = s.trim_end_matches('/');
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s.to_string()
    }
}

/// Link a session to the checkout that already has `branch_name`, because the
/// user chose to reuse it. Nothing is created on disk.
///
/// When that checkout is the project folder itself, the result says
/// `is_main_worktree: true`, so closing the session never deletes it.
pub fn attach_existing_worktree(
    repo_path: &str,
    branch_name: &str,
) -> Result<WorktreeCreateResult, String> {
    let path = find_existing_worktree_for_branch(repo_path, branch_name)
        .ok_or_else(|| format!("Branch '{}' is not checked out anywhere", branch_name))?;
    let is_main = same_dir(&path, repo_path);
    Ok(WorktreeCreateResult {
        worktree_path: path,
        branch_name: branch_name.to_string(),
        is_main_worktree: is_main,
    })
}

/// First free `hermes-archive/<branch>` name (then `-2`, `-3`, ...).
fn free_archive_branch_name(repo: &Repository, branch: &str) -> String {
    let stem = branch.strip_prefix("hermes/").unwrap_or(branch);
    let base = format!("hermes-archive/{}", stem);
    // Free in letter case too: on macOS and Windows `hermes-archive/Fix`
    // would be written over an existing `hermes-archive/fix`. (A folder
    // that differs only in case is not overwritten, and every candidate
    // shares it, so it does not count here.)
    let taken = |name: &str| {
        matches!(
            local_branch_clash(repo, name),
            Some(BranchClash::Same(_) | BranchClash::Case(_))
        )
    };
    if !taken(&base) {
        return base;
    }
    let mut n = 2;
    loop {
        let candidate = format!("{}-{}", base, n);
        if !taken(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// Commit every uncommitted change in a worktree (new, changed and deleted
/// files, respecting .gitignore) without touching the stash.
///
/// `CommitTarget::Session` commits on the checked-out branch and leaves the
/// worktree clean. `CommitTarget::Archive` leaves the branch, index and files
/// as they are and records the work on a new `hermes-archive/<branch>` branch.
/// `skip` filters out paths that should never be committed (tool noise).
pub fn commit_worktree_changes(
    worktree_path: &str,
    message: &str,
    target: CommitTarget,
    skip: &dyn Fn(&str) -> bool,
) -> Result<CommitOutcome, String> {
    let repo = Repository::open(worktree_path)
        .map_err(|e| format!("Failed to open '{}': {}", worktree_path, e))?;
    let head = repo
        .head()
        .map_err(|e| format!("Failed to read HEAD: {}", e))?;
    let parent = head
        .peel_to_commit()
        .map_err(|e| format!("Failed to resolve HEAD commit: {}", e))?;
    let branch = if head.is_branch() {
        head.shorthand().map(|s| s.to_string())
    } else {
        None
    };
    if target == CommitTarget::Session && branch.is_none() {
        return Err("This session is not on a branch (detached HEAD); nothing to commit to".into());
    }

    let mut index = repo
        .index()
        .map_err(|e| format!("Failed to read index: {}", e))?;
    let mut filter = |path: &Path, _spec: &[u8]| -> i32 {
        if skip(&path.to_string_lossy()) {
            1
        } else {
            0
        }
    };
    index
        .add_all(["*"], git2::IndexAddOption::DEFAULT, Some(&mut filter))
        .map_err(|e| format!("Failed to add changes: {}", e))?;
    index
        .update_all(["*"], Some(&mut filter))
        .map_err(|e| format!("Failed to record deletions: {}", e))?;
    let tree_id = index
        .write_tree()
        .map_err(|e| format!("Failed to write tree: {}", e))?;
    let tree = repo
        .find_tree(tree_id)
        .map_err(|e| format!("Failed to read tree: {}", e))?;
    let parent_tree = parent
        .tree()
        .map_err(|e| format!("Failed to read HEAD tree: {}", e))?;
    let files = repo
        .diff_tree_to_tree(Some(&parent_tree), Some(&tree), None)
        .map_err(|e| format!("Failed to diff: {}", e))?
        .deltas()
        .len();
    if files == 0 {
        return Err("There are no changes to commit".into());
    }

    let sig = repo
        .signature()
        .or_else(|_| git2::Signature::now("Hermes", "hermes@localhost"))
        .map_err(|e| format!("Failed to build commit author: {}", e))?;

    match target {
        CommitTarget::Session => {
            let id = repo
                .commit(Some("HEAD"), &sig, &sig, message, &tree, &[&parent])
                .map_err(|e| format!("Commit failed: {}", e))?;
            // Keep the on-disk index in step with the new commit.
            index
                .write()
                .map_err(|e| format!("Failed to write index: {}", e))?;
            Ok(CommitOutcome {
                branch: branch.unwrap_or_default(),
                commit: id.to_string(),
                files,
            })
        }
        CommitTarget::Archive => {
            let name = free_archive_branch_name(&repo, branch.as_deref().unwrap_or("detached"));
            let refname = format!("refs/heads/{}", name);
            let id = repo
                .commit(Some(&refname), &sig, &sig, message, &tree, &[&parent])
                .map_err(|e| format!("Commit failed: {}", e))?;
            Ok(CommitOutcome {
                branch: name,
                commit: id.to_string(),
                files,
            })
        }
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
#[cfg(test)]
pub fn create_worktree(
    app_data_dir: &Path,
    repo_path: &str,
    session_id: &str,
    branch_name: &str,
    create_branch: bool,
    from_remote: Option<&str>,
) -> Result<WorktreeCreateResult, String> {
    create_worktree_from(
        app_data_dir,
        repo_path,
        session_id,
        branch_name,
        create_branch,
        from_remote,
        None,
    )
}

/// `create_worktree`, where a newly created branch is cut from `base_branch`
/// (a local branch) instead of the repository's HEAD.
///
/// When the branch is already checked out in another worktree, or in the
/// project folder itself, this returns a `BRANCH_IN_USE:` error (see
/// `branch_in_use_error`) instead of handing back that other checkout.
pub fn create_worktree_from(
    app_data_dir: &Path,
    repo_path: &str,
    session_id: &str,
    branch_name: &str,
    create_branch: bool,
    from_remote: Option<&str>,
    base_branch: Option<&str>,
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
            });
        }

        // A local branch whose name differs only in letter case would be
        // taken for this one on macOS and Windows: never use it by accident.
        match local_branch_clash(&repo, &local_name) {
            None | Some(BranchClash::Same(_)) => {}
            Some(clash) => return Err(branch_clash_error(&local_name, &clash)),
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
            let mut cmd = crate::git::cli::git_command();
            cmd.current_dir(repo_path);
            cmd.args(["worktree", "add", wt_path_str, &local_name]);

            let output = cmd
                .output()
                .map_err(|e| format!("Failed to run 'git worktree add': {}", e))?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);

                if let Some(err) = branch_in_use_from_stderr(repo_path, &local_name, &stderr) {
                    return Err(err);
                }

                return Err(format!("git worktree add failed: {}", stderr.trim()));
            }

            return Ok(WorktreeCreateResult {
                worktree_path: wt_path_str.to_string(),
                branch_name: local_name,
                is_main_worktree: false,
            });
        }

        // No local branch exists — create one tracking the remote ref
        // `git worktree add -b <local_name> <path> <remote_ref>`
        let mut cmd = crate::git::cli::git_command();
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
        });
    }

    // A name that differs from an existing branch only in letter case (or
    // whose folder does) is never used, new or not: on macOS and Windows
    // `git worktree add … Develop` would check out `develop`, and the
    // session's commits would move it. An existing branch is used only under
    // its exact name, as before (the branch-in-use choice relies on it: a
    // branch held elsewhere comes back as BRANCH_IN_USE).
    match local_branch_clash(&repo, branch_name) {
        Some(clash @ (BranchClash::Case(_) | BranchClash::Folder(_))) => {
            return Err(branch_clash_error(branch_name, &clash));
        }
        Some(BranchClash::Same(_)) => {}
        None if create_branch => {
            let base = match base_branch {
                Some(base) => repo
                    .find_branch(base, BranchType::Local)
                    .map_err(|e| format!("Base branch '{}' not found: {}", base, e))?
                    .into_reference(),
                None => repo
                    .head()
                    .map_err(|e| format!("Failed to get HEAD: {}", e))?,
            };
            let commit = base
                .peel_to_commit()
                .map_err(|e| format!("Failed to resolve base commit: {}", e))?;
            repo.branch(branch_name, &commit, false)
                .map_err(|e| format!("Failed to create branch '{}': {}", branch_name, e))?;
        }
        None => {}
    }

    // Build the `git worktree add` command
    let mut cmd = crate::git::cli::git_command();
    cmd.current_dir(repo_path);
    cmd.args(["worktree", "add", wt_path_str, branch_name]);

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run 'git worktree add': {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);

        // The branch is already checked out somewhere else. Never hand back
        // that other checkout: the caller must ask the user what to do.
        if let Some(err) = branch_in_use_from_stderr(repo_path, branch_name, &stderr) {
            return Err(err);
        }

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

    // Guard 1: worktree_path must live under THIS instance's hermes-worktrees/
    // (another Hermes instance's checkout, reused on purpose, is not ours
    // to delete either).
    // Normalize separators for cross-platform check (Windows uses backslashes)
    let normalized = worktree_path.replace('\\', "/");
    if !is_instance_worktree_path(worktree_path) {
        return Err(format!(
            "SAFETY: refusing to remove path outside this Hermes' hermes-worktrees/: '{}'",
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
    let remove_output = crate::git::cli::git_command()
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
    let prune_output = crate::git::cli::git_command()
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

    // Step 4: Clean up stale .git/worktrees/ refs that point to the deleted path.
    // `git worktree prune` should handle this, but if it didn't (e.g. the dir
    // was recreated between prune and now, or a race condition), we clean up
    // any refs whose `gitdir` file points to the removed worktree path.
    cleanup_stale_git_worktree_refs(repo_path, worktree_path);

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

/// Clean up stale `.git/worktrees/<name>` refs whose `gitdir` file points to
/// a worktree path that no longer exists. This handles cases where
/// `git worktree prune` didn't fully clean up (e.g. due to race conditions
/// or the directory being recreated between prune and deletion).
fn cleanup_stale_git_worktree_refs(repo_path: &str, removed_worktree_path: &str) {
    let git_worktrees_dir = Path::new(repo_path).join(".git").join("worktrees");
    if !git_worktrees_dir.is_dir() {
        return;
    }

    let entries = match fs::read_dir(&git_worktrees_dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    // Canonicalize the removed path for comparison (if it still exists, which it shouldn't)
    let removed_normalized = removed_worktree_path.replace('\\', "/");

    for entry in entries.flatten() {
        let entry_path = entry.path();
        if !entry_path.is_dir() {
            continue;
        }

        let gitdir_file = entry_path.join("gitdir");
        if !gitdir_file.exists() {
            continue;
        }

        // Read the gitdir file to see what worktree path it references
        if let Ok(content) = fs::read_to_string(&gitdir_file) {
            let referenced_path = content.trim().replace('\\', "/");
            // The gitdir file points to the .git file inside the worktree.
            // Check if it references our removed worktree path.
            if referenced_path.contains(&removed_normalized)
                || removed_normalized.contains(referenced_path.trim_end_matches("/.git"))
            {
                log::info!(
                    "Removing stale .git/worktrees/ ref '{}' (pointed to deleted worktree '{}')",
                    entry_path.display(),
                    removed_worktree_path
                );
                if let Err(e) = fs::remove_dir_all(&entry_path) {
                    log::warn!(
                        "Failed to remove stale .git/worktrees/ ref '{}': {}",
                        entry_path.display(),
                        e
                    );
                }
            }
        }
    }
}

/// Prune stale worktree bookkeeping entries and return how many were cleaned.
///
/// A worktree is "stale" when its directory has been deleted but git still
/// has metadata for it. `git worktree prune` removes those entries.
pub fn cleanup_stale_worktrees(repo_path: &str) -> Result<u32, String> {
    // Count worktrees before pruning
    let before = list_worktrees(repo_path)?.len() as u32;

    let output = crate::git::cli::git_command()
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

/// Where THIS instance keeps its worktrees (`{app_data_dir}/hermes-worktrees`),
/// set once at startup. Unset in unit tests, where every `hermes-worktrees/`
/// path counts as ours.
static INSTANCE_WORKTREES_BASE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Record this instance's worktrees folder; later calls are ignored.
pub fn set_instance_worktrees_base(app_data_dir: &Path) {
    let _ = INSTANCE_WORKTREES_BASE.set(worktrees_base_dir(app_data_dir));
}

/// Whether `path` is a worktree THIS Hermes instance made: under its own
/// `hermes-worktrees/` folder. A checkout of another instance (the installed
/// app next to a dev build, or an isolated test instance) is somebody
/// else's, even though its path also contains `hermes-worktrees/`.
pub fn is_instance_worktree_path(path: &str) -> bool {
    is_worktree_of(INSTANCE_WORKTREES_BASE.get().map(PathBuf::as_path), path)
}

/// `is_instance_worktree_path` for a given base (`None`: any Hermes base).
fn is_worktree_of(base: Option<&Path>, path: &str) -> bool {
    if !is_hermes_worktree_path(path) {
        return false;
    }
    let Some(base) = base else { return true };
    // Hermes builds every worktree path from the same base spelling, so a
    // plain prefix check covers its own rows; resolving symlinks covers a
    // row written with another spelling of an existing folder.
    let base_s = normalize_path_spelling(&base.to_string_lossy());
    let path_s = normalize_path_spelling(path);
    if path_s.starts_with(&format!("{}/", base_s)) {
        return true;
    }
    match (fs::canonicalize(base), fs::canonicalize(path)) {
        (Ok(b), Ok(p)) => p != b && p.starts_with(&b),
        _ => false,
    }
}

/// Whether the session that a `session_worktrees` row belongs to owns that
/// checkout: a linked worktree this Hermes instance created under its
/// `hermes-worktrees/`.
///
/// Everything else is somebody else's checkout and closing the session must
/// leave it alone: the project folder (`is_main_worktree`), a worktree
/// made outside Hermes (`git worktree add` by hand, or another tool) and a
/// worktree of another Hermes instance, when the user chose to reuse one
/// through the Branch In Use choice. Only an owned checkout is removed on
/// close, asked about when it has uncommitted changes, or recreated when
/// its folder went missing.
pub fn is_owned_checkout(is_main_worktree: bool, worktree_path: &str) -> bool {
    if !isolation_fixes_enabled() {
        // Test builds only (negative control): the behaviour before the
        // F09 edge-case fixes, which treated every linked worktree as owned.
        return !is_main_worktree;
    }
    !is_main_worktree && is_instance_worktree_path(worktree_path)
}

/// Test builds only: `HERMES_E2E_ISOLATION_FIXES=off` switches the F09
/// edge-case fixes off (external checkouts treated as owned, no recovery of
/// a missing worktree folder), so the real-app scenario has a negative
/// control that must end in FAIL. Needs the `e2e` cargo feature (never in a
/// release build) AND `HERMES_E2E=1` at run time.
pub fn isolation_fixes_enabled() -> bool {
    #[cfg(feature = "e2e")]
    {
        !isolation_fixes_switched_off(
            std::env::var("HERMES_E2E").ok().as_deref(),
            std::env::var("HERMES_E2E_ISOLATION_FIXES").ok().as_deref(),
        )
    }
    #[cfg(not(feature = "e2e"))]
    {
        true
    }
}

#[cfg(any(test, feature = "e2e"))]
fn isolation_fixes_switched_off(e2e: Option<&str>, value: Option<&str>) -> bool {
    crate::e2e_protocol::is_enabled(e2e) && value.map(str::trim) == Some("off")
}

/// Whether `branch` exists as a local branch of the repository at `repo_path`.
pub fn local_branch_exists(repo_path: &str, branch: &str) -> bool {
    Repository::open(repo_path)
        .and_then(|repo| repo.find_branch(branch, BranchType::Local).map(|_| ()))
        .is_ok()
}

/// Put back a linked worktree whose folder was deleted from disk (by hand,
/// by a cleaner, or by another tool) at the same `worktree_path` and on the
/// same `branch`, so a restored session finds its files where it left them.
///
/// Git still remembers the old folder, so its stale entry is pruned first.
/// Fails when the branch no longer exists (the caller then falls back to
/// the project folder) or is checked out somewhere else (`BRANCH_IN_USE`).
pub fn recreate_worktree(repo_path: &str, worktree_path: &str, branch: &str) -> Result<(), String> {
    if !is_instance_worktree_path(worktree_path) {
        return Err(format!(
            "refusing to recreate a checkout outside this Hermes' hermes-worktrees/: '{}'",
            worktree_path
        ));
    }
    if Path::new(worktree_path).is_dir() {
        return Ok(());
    }
    if !local_branch_exists(repo_path, branch) {
        return Err(format!("branch '{}' no longer exists", branch));
    }
    // The old entry in .git/worktrees still points at the deleted folder;
    // `git worktree add` refuses the path until it is pruned.
    let _ = crate::git::cli::git_command()
        .current_dir(repo_path)
        .args(["worktree", "prune"])
        .output();
    if let Some(parent) = Path::new(worktree_path).parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!(
                "could not create the worktree folder's parent '{}': {}",
                parent.display(),
                e
            )
        })?;
    }
    let output = crate::git::cli::git_command()
        .current_dir(repo_path)
        .args(["worktree", "add", worktree_path, branch])
        .output()
        .map_err(|e| format!("Failed to run 'git worktree add': {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if let Some(err) = branch_in_use_from_stderr(repo_path, branch, &stderr) {
            return Err(err);
        }
        return Err(format!("git worktree add failed: {}", stderr.trim()));
    }
    Ok(())
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
    fn intended_worktree_path_matches_create_and_creates_nothing() {
        let app_data = create_test_app_data_dir();
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        let intended =
            intended_worktree_path(app_data.path(), repo_path, "session123", "feat/x", None);
        assert!(
            !worktrees_base_dir(app_data.path()).exists(),
            "computing the path created a folder"
        );
        let wt = create_worktree(
            app_data.path(),
            repo_path,
            "session123",
            "feat/x",
            true,
            None,
        )
        .unwrap();
        assert_eq!(Path::new(&wt.worktree_path), intended);

        // From a remote ref the folder is named after the local branch.
        let remote = intended_worktree_path(
            app_data.path(),
            repo_path,
            "session456",
            "ignored",
            Some("origin/feature-y"),
        );
        assert!(remote.ends_with("session4_feature-y"));
    }

    #[test]
    fn would_reuse_existing_worktree_sees_own_folder_and_branch_checked_out_elsewhere() {
        let app_data = create_test_app_data_dir();
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        assert!(!would_reuse_existing_worktree(
            app_data.path(),
            repo_path,
            "sessionA1",
            "feat/shared",
            None
        ));
        create_worktree(
            app_data.path(),
            repo_path,
            "sessionA1",
            "feat/shared",
            true,
            None,
        )
        .unwrap();

        // Same session: its own folder exists.
        assert!(would_reuse_existing_worktree(
            app_data.path(),
            repo_path,
            "sessionA1",
            "feat/shared",
            None
        ));
        // Another session asking for the same branch creates no folder (it
        // is refused with BRANCH_IN_USE, or links the existing checkout if
        // the user chooses to reuse it), so it needs no space either.
        assert!(would_reuse_existing_worktree(
            app_data.path(),
            repo_path,
            "sessionB2",
            "feat/shared",
            None
        ));
        let err = create_worktree(
            app_data.path(),
            repo_path,
            "sessionB2",
            "feat/shared",
            false,
            None,
        )
        .unwrap_err();
        assert!(parse_branch_in_use_error(&err).is_some());
        // A branch nobody has checked out needs a new folder.
        assert!(!would_reuse_existing_worktree(
            app_data.path(),
            repo_path,
            "sessionB2",
            "feat/other",
            None
        ));
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

        // A second session on the same branch is refused with BRANCH_IN_USE,
        // naming the first session's worktree — never handed that checkout.
        let err = create_worktree(
            app_data.path(),
            repo_path,
            "session2",
            "dup-branch",
            false,
            None,
        )
        .unwrap_err();
        let (branch, path) = parse_branch_in_use_error(&err).expect("BRANCH_IN_USE error");
        assert_eq!(branch, "dup-branch");
        assert!(
            path.contains("session1"),
            "names the first worktree: {path}"
        );
        // Nothing was created for session2.
        let wt2_dir =
            worktree_path_for_session(app_data.path(), repo_path, "session2", "dup-branch");
        assert!(!wt2_dir.exists());
    }

    #[test]
    fn test_create_on_branch_checked_out_in_project_folder_is_refused() {
        let app_data = create_test_app_data_dir();
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();
        let current = get_worktree_branch(repo_path).unwrap().unwrap();

        let err =
            create_worktree(app_data.path(), repo_path, "s1", &current, false, None).unwrap_err();
        let (branch, path) = parse_branch_in_use_error(&err).expect("BRANCH_IN_USE error");
        assert_eq!(branch, current);
        assert!(
            same_dir(&path, repo_path),
            "names the project folder: {path}"
        );
    }

    #[test]
    fn test_attach_existing_worktree_links_the_checkout_on_purpose() {
        let app_data = create_test_app_data_dir();
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();
        let first =
            create_worktree(app_data.path(), repo_path, "s1", "shared-b", true, None).unwrap();

        let linked = attach_existing_worktree(repo_path, "shared-b").unwrap();
        assert!(same_dir(&linked.worktree_path, &first.worktree_path));
        assert!(!linked.is_main_worktree);

        // The project folder's own branch attaches as the main worktree, so
        // closing the session can never delete the project folder.
        let current = get_worktree_branch(repo_path).unwrap().unwrap();
        let main = attach_existing_worktree(repo_path, &current).unwrap();
        assert!(main.is_main_worktree);

        assert!(attach_existing_worktree(repo_path, "no-such-branch").is_err());
    }

    #[test]
    fn test_create_worktree_from_base_branch() {
        let app_data = create_test_app_data_dir();
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();
        let wt = create_worktree(app_data.path(), repo_path, "s1", "feat", true, None).unwrap();
        std::fs::write(Path::new(&wt.worktree_path).join("feat.txt"), "x").unwrap();
        commit_worktree_changes(
            &wt.worktree_path,
            "feat work",
            CommitTarget::Session,
            &|_| false,
        )
        .unwrap();

        let wt2 = create_worktree_from(
            app_data.path(),
            repo_path,
            "s2",
            "feat-2",
            true,
            None,
            Some("feat"),
        )
        .unwrap();
        assert!(
            Path::new(&wt2.worktree_path).join("feat.txt").exists(),
            "feat-2 starts from feat, not from HEAD"
        );
    }

    fn git_out(dir: &str, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn dirty_worktree(app_data: &Path, repo_path: &str) -> WorktreeCreateResult {
        let wt = create_worktree(app_data, repo_path, "s1", "hermes/task-a", true, None).unwrap();
        let dir = Path::new(&wt.worktree_path);
        std::fs::write(dir.join("README.md"), "# changed").unwrap();
        std::fs::write(dir.join("new.txt"), "new").unwrap();
        std::fs::write(dir.join(".DS_Store"), "noise").unwrap();
        wt
    }

    #[test]
    fn test_commit_to_session_branch_leaves_stash_alone_and_worktree_clean() {
        let app_data = create_test_app_data_dir();
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();
        let wt = dirty_worktree(app_data.path(), repo_path);
        let stash_before = git_out(repo_path, &["stash", "list"]);

        let out = commit_worktree_changes(
            &wt.worktree_path,
            "WIP from Hermes",
            CommitTarget::Session,
            &|p| p.ends_with(".DS_Store"),
        )
        .unwrap();

        assert_eq!(out.branch, "hermes/task-a");
        assert_eq!(out.files, 2);
        assert_eq!(
            git_out(repo_path, &["rev-parse", "hermes/task-a"]),
            out.commit
        );
        assert_eq!(git_out(repo_path, &["stash", "list"]), stash_before);
        let files = git_out(
            repo_path,
            &["show", "--name-only", "--format=", &out.commit],
        );
        assert!(files.contains("README.md") && files.contains("new.txt"));
        assert!(!files.contains(".DS_Store"), "noise is never committed");
        // Only the skipped noise is left uncommitted.
        let status = git_out(&wt.worktree_path, &["status", "--porcelain"]);
        assert_eq!(status, "?? .DS_Store");
    }

    #[test]
    fn test_commit_records_deleted_files() {
        let app_data = create_test_app_data_dir();
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();
        let wt = create_worktree(app_data.path(), repo_path, "s1", "del", true, None).unwrap();
        std::fs::remove_file(Path::new(&wt.worktree_path).join("README.md")).unwrap();
        let out =
            commit_worktree_changes(&wt.worktree_path, "rm", CommitTarget::Session, &|_| false)
                .unwrap();
        assert_eq!(out.files, 1);
        let tree = git_out(repo_path, &["ls-tree", "--name-only", "del"]);
        assert!(!tree.contains("README.md"));
    }

    #[test]
    fn test_archive_keeps_session_branch_and_saves_work_on_archive_branch() {
        let app_data = create_test_app_data_dir();
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();
        let wt = dirty_worktree(app_data.path(), repo_path);
        let branch_before = git_out(repo_path, &["rev-parse", "hermes/task-a"]);
        let stash_before = git_out(repo_path, &["stash", "list"]);

        let out =
            commit_worktree_changes(&wt.worktree_path, "archived", CommitTarget::Archive, &|p| {
                p.ends_with(".DS_Store")
            })
            .unwrap();

        assert_eq!(out.branch, "hermes-archive/task-a");
        assert_eq!(
            git_out(repo_path, &["rev-parse", "hermes/task-a"]),
            branch_before
        );
        assert_eq!(git_out(repo_path, &["rev-parse", &out.branch]), out.commit);
        assert_eq!(
            git_out(repo_path, &["rev-parse", &format!("{}^", out.commit)]),
            branch_before
        );
        assert_eq!(git_out(repo_path, &["stash", "list"]), stash_before);

        // A second archive of the same branch gets its own name.
        std::fs::write(Path::new(&wt.worktree_path).join("more.txt"), "m").unwrap();
        let again =
            commit_worktree_changes(&wt.worktree_path, "again", CommitTarget::Archive, &|_| {
                false
            })
            .unwrap();
        assert_eq!(again.branch, "hermes-archive/task-a-2");
    }

    #[test]
    fn test_commit_with_nothing_to_commit_is_an_error() {
        let app_data = create_test_app_data_dir();
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();
        let wt = create_worktree(app_data.path(), repo_path, "s1", "clean", true, None).unwrap();
        assert!(
            commit_worktree_changes(&wt.worktree_path, "x", CommitTarget::Session, &|_| false)
                .is_err()
        );
    }

    #[test]
    fn test_same_dir_ignores_how_the_path_is_spelled() {
        // Folders that do not exist are compared by spelling.
        assert!(same_dir("/tmp/hermes-test/wt", "/tmp/hermes-test/wt/"));
        assert!(same_dir("C:\\hermes-test\\wt", "C:/hermes-test/wt"));
        assert!(!same_dir("/tmp/hermes-test/wt", "/tmp/hermes-test/wt2"));
        if cfg!(windows) {
            assert!(same_dir("C:\\Hermes-Test\\WT", "c:/hermes-test/wt"));
        }
        // Existing folders are compared after resolving symlinks.
        let dir = TempDir::new().unwrap();
        let real = dir.path().to_str().unwrap();
        let canonical = fs::canonicalize(dir.path()).unwrap();
        assert!(same_dir(real, canonical.to_str().unwrap()));
    }

    #[test]
    fn test_branch_in_use_error_round_trips() {
        let err = branch_in_use_error("a/b \"q\"", "/tmp/hermes-test/x y");
        assert!(err.starts_with(BRANCH_IN_USE_PREFIX));
        assert_eq!(
            parse_branch_in_use_error(&err),
            Some(("a/b \"q\"".to_string(), "/tmp/hermes-test/x y".to_string()))
        );
        assert_eq!(parse_branch_in_use_error("git worktree add failed"), None);
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
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["branchName"], "main");
        assert_eq!(json["isMainWorktree"], false);
        assert_eq!(
            json["worktreePath"],
            "/app/data/hermes-worktrees/hash/abc_main"
        );
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
        assert_eq!(json["sessionId"], "sess1");
        assert_eq!(json["isMainWorktree"], true);
        assert_eq!(json["branchName"], "feature");
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

    // ── BUG 3/5: Worktree cleanup and .git/worktrees/ ref cleanup ─────

    #[test]
    fn test_remove_worktree_cleans_git_worktrees_refs() {
        let app_data = create_test_app_data_dir();
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        let wt = create_worktree(
            app_data.path(),
            repo_path,
            "session1",
            "cleanup-branch",
            true,
            None,
        )
        .unwrap();

        // Verify .git/worktrees/ has an entry
        let git_worktrees = repo_dir.path().join(".git").join("worktrees");
        assert!(
            git_worktrees.is_dir(),
            ".git/worktrees/ should exist after creating a worktree"
        );
        let entries_before: Vec<_> = fs::read_dir(&git_worktrees)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert!(
            !entries_before.is_empty(),
            ".git/worktrees/ should have entries"
        );

        // Remove the worktree
        remove_worktree(repo_path, "session1", &wt.worktree_path).unwrap();

        // .git/worktrees/ entries referencing the removed path should be gone
        if git_worktrees.is_dir() {
            let entries_after: Vec<_> = fs::read_dir(&git_worktrees)
                .unwrap()
                .filter_map(|e| e.ok())
                .collect();
            assert!(
                entries_after.is_empty(),
                ".git/worktrees/ should be empty after removal, found: {:?}",
                entries_after
                    .iter()
                    .map(|e| e.file_name())
                    .collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn test_remove_worktree_cleans_refs_when_dir_already_deleted() {
        let app_data = create_test_app_data_dir();
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        let wt = create_worktree(
            app_data.path(),
            repo_path,
            "session1",
            "ghost-branch",
            true,
            None,
        )
        .unwrap();

        // Manually delete the worktree directory (simulating external deletion)
        fs::remove_dir_all(&wt.worktree_path).unwrap();
        assert!(!Path::new(&wt.worktree_path).exists());

        // remove_worktree should still succeed and clean up .git/worktrees/ refs
        let result = remove_worktree(repo_path, "session1", &wt.worktree_path);
        assert!(
            result.is_ok(),
            "remove_worktree should succeed even when dir is gone: {:?}",
            result.err()
        );

        // After removal + prune + ref cleanup, no stale refs should remain
        let git_worktrees = repo_dir.path().join(".git").join("worktrees");
        if git_worktrees.is_dir() {
            let entries: Vec<_> = fs::read_dir(&git_worktrees)
                .unwrap()
                .filter_map(|e| e.ok())
                .collect();
            assert!(
                entries.is_empty(),
                "Stale .git/worktrees/ refs should have been cleaned up, found: {:?}",
                entries.iter().map(|e| e.file_name()).collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn test_cleanup_stale_git_worktree_refs_no_crash_on_empty_repo() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        // Should not crash even when .git/worktrees/ doesn't exist
        cleanup_stale_git_worktree_refs(repo_path, "/some/nonexistent/path");
        // No assertion needed — just verifying no panic
    }

    #[test]
    fn test_cleanup_stale_worktrees_returns_zero_when_nothing_to_prune() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        let pruned = cleanup_stale_worktrees(repo_path).unwrap();
        assert_eq!(pruned, 0, "Nothing should be pruned on a clean repo");
    }

    #[test]
    fn test_remove_worktree_safety_rejects_non_hermes_path() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();

        // Attempting to remove a path outside hermes-worktrees/ should be rejected
        let result = remove_worktree(repo_path, "session1", "/some/regular/path");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("SAFETY"),
            "Should be rejected by safety guard, got: {}",
            err
        );
    }

    // ── F09 edge cases: owned vs. someone else's checkout ──────────────

    #[test]
    fn only_a_hermes_made_linked_worktree_is_owned() {
        assert!(is_owned_checkout(
            false,
            "/data/hermes-worktrees/abc/s1_main"
        ));
        assert!(is_owned_checkout(
            false,
            "C:\\data\\hermes-worktrees\\abc\\s1_main"
        ));
        // The project folder, and a worktree made outside Hermes.
        assert!(!is_owned_checkout(true, "/work/repo"));
        assert!(!is_owned_checkout(false, "/work/repo-external-wt"));
    }

    #[test]
    fn a_worktree_of_another_hermes_instance_is_not_ours() {
        // Two instances (the installed app and a dev build, or an isolated
        // test instance) each keep their own hermes-worktrees/ folder. A
        // checkout under the other one is reused on purpose at most; it is
        // never removed, asked about or recreated by this instance.
        let mine = Path::new("/data/instance-a/hermes-worktrees");
        assert!(is_worktree_of(
            Some(mine),
            "/data/instance-a/hermes-worktrees/abc/s1_main"
        ));
        assert!(!is_worktree_of(
            Some(mine),
            "/data/instance-b/hermes-worktrees/abc/s1_main"
        ));
        assert!(!is_worktree_of(
            Some(mine),
            "/data/instance-a/hermes-worktrees-old/abc/s1_main"
        ));
        assert!(!is_worktree_of(
            Some(mine),
            "/data/instance-a/hermes-worktrees"
        ));
        assert!(!is_worktree_of(Some(mine), "/work/repo-external-wt"));
        // Windows spelling of the same folders.
        let mine_win = Path::new("C:\\data\\instance-a\\hermes-worktrees");
        assert!(is_worktree_of(
            Some(mine_win),
            "C:\\data\\instance-a\\hermes-worktrees\\abc\\s1_main"
        ));
        assert!(!is_worktree_of(
            Some(mine_win),
            "C:\\data\\instance-b\\hermes-worktrees\\abc\\s1_main"
        ));
        // No base known (unit tests): any Hermes worktree path is ours.
        assert!(is_worktree_of(
            None,
            "/data/instance-b/hermes-worktrees/abc/s1_main"
        ));
        assert!(!is_worktree_of(None, "/work/repo-external-wt"));

        // An existing folder reached through another spelling of the base
        // (a symlinked temp folder) is still recognised.
        let app_data = create_test_app_data_dir();
        let base = worktrees_base_dir(app_data.path());
        let wt = base.join("abc").join("s1_main");
        fs::create_dir_all(&wt).unwrap();
        let canonical_wt = fs::canonicalize(&wt).unwrap();
        assert!(is_worktree_of(Some(&base), canonical_wt.to_str().unwrap()));
        assert!(is_worktree_of(
            Some(&fs::canonicalize(&base).unwrap()),
            wt.to_str().unwrap()
        ));
    }

    #[test]
    fn isolation_fixes_switch_off_only_in_an_e2e_run_that_asks_for_it() {
        assert!(!isolation_fixes_switched_off(None, Some("off")));
        assert!(!isolation_fixes_switched_off(Some("1"), None));
        assert!(!isolation_fixes_switched_off(Some("1"), Some("on")));
        assert!(isolation_fixes_switched_off(Some("1"), Some("off")));
        assert!(isolation_fixes_switched_off(Some("1"), Some(" off ")));
    }

    #[test]
    fn recreate_worktree_puts_a_deleted_folder_back_on_its_branch() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();
        let app_data = create_test_app_data_dir();
        let wt = create_worktree(
            app_data.path(),
            repo_path,
            "s1",
            "hermes/task-a",
            true,
            None,
        )
        .unwrap();
        std::fs::write(Path::new(&wt.worktree_path).join("note.txt"), "x").unwrap();
        Command::new("git")
            .current_dir(&wt.worktree_path)
            .args(["add", "."])
            .output()
            .unwrap();
        Command::new("git")
            .current_dir(&wt.worktree_path)
            .args(["commit", "-q", "-m", "note"])
            .output()
            .unwrap();

        // The folder goes away behind Hermes' back.
        std::fs::remove_dir_all(&wt.worktree_path).unwrap();
        assert!(!Path::new(&wt.worktree_path).exists());

        recreate_worktree(repo_path, &wt.worktree_path, "hermes/task-a").unwrap();
        assert!(Path::new(&wt.worktree_path).join("note.txt").is_file());
        assert_eq!(
            get_worktree_branch(&wt.worktree_path).unwrap().as_deref(),
            Some("hermes/task-a")
        );
        // Idempotent once the folder is there.
        recreate_worktree(repo_path, &wt.worktree_path, "hermes/task-a").unwrap();
    }

    #[test]
    fn recreate_worktree_fails_when_the_branch_is_gone_or_the_path_is_not_ours() {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();
        let app_data = create_test_app_data_dir();
        let wt = create_worktree(
            app_data.path(),
            repo_path,
            "s1",
            "hermes/task-b",
            true,
            None,
        )
        .unwrap();
        std::fs::remove_dir_all(&wt.worktree_path).unwrap();
        Command::new("git")
            .current_dir(repo_path)
            .args(["worktree", "prune"])
            .output()
            .unwrap();
        Command::new("git")
            .current_dir(repo_path)
            .args(["branch", "-D", "hermes/task-b"])
            .output()
            .unwrap();

        let err = recreate_worktree(repo_path, &wt.worktree_path, "hermes/task-b").unwrap_err();
        assert!(err.contains("no longer exists"), "got: {}", err);
        assert!(!Path::new(&wt.worktree_path).exists());

        let outside = repo_dir.path().join("..").join("not-ours");
        let err = recreate_worktree(repo_path, outside.to_str().unwrap(), "main").unwrap_err();
        assert!(err.contains("refusing"), "got: {}", err);
    }

    // ── branch names that differ only in letter case ──────────────────

    #[test]
    fn test_branch_name_clash_kinds() {
        let existing = ["main", "develop", "feature/inbox"];
        let clash = |n: &str| branch_name_clash(n, existing.iter().copied());
        assert_eq!(clash("develop"), Some(BranchClash::Same("develop".into())));
        assert_eq!(clash("Develop"), Some(BranchClash::Case("develop".into())));
        assert_eq!(clash("MAIN"), Some(BranchClash::Case("main".into())));
        assert_eq!(
            clash("Feature/other"),
            Some(BranchClash::Folder("feature/inbox".into()))
        );
        assert_eq!(
            clash("FEATURE/INBOX"),
            Some(BranchClash::Case("feature/inbox".into()))
        );
        assert_eq!(clash("feature/other"), None);
        assert_eq!(clash("developer"), None);
        assert_eq!(clash("hermes/develop"), None);
        // The exact name wins over a case-only match listed before it.
        assert_eq!(
            branch_name_clash("Dev", ["dev", "Dev"]),
            Some(BranchClash::Same("Dev".into()))
        );
        assert!(
            branch_clash_error("Develop", &BranchClash::Case("develop".into()))
                .starts_with(BRANCH_NAME_CLASH_PREFIX)
        );
    }

    fn repo_with_develop() -> (TempDir, String) {
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap().to_string();
        git_out(&repo_path, &["branch", "develop"]);
        git_out(&repo_path, &["checkout", "-q", "develop"]);
        std::fs::write(repo_dir.path().join("dev.txt"), "develop work").unwrap();
        git_out(&repo_path, &["add", "dev.txt"]);
        git_out(&repo_path, &["commit", "-q", "-m", "develop work"]);
        git_out(&repo_path, &["checkout", "-q", "-"]);
        (repo_dir, repo_path)
    }

    fn local_branches(repo_path: &str) -> Vec<String> {
        git_out(
            repo_path,
            &["branch", "--list", "--format=%(refname:short)"],
        )
        .lines()
        .map(str::to_string)
        .collect()
    }

    #[test]
    fn test_new_branch_differing_only_in_case_is_refused_and_develop_never_moves() {
        let app_data = create_test_app_data_dir();
        let (_repo_dir, repo_path) = repo_with_develop();
        let develop_before = git_out(&repo_path, &["rev-parse", "develop"]);
        let branches_before = local_branches(&repo_path);

        let err =
            create_worktree(app_data.path(), &repo_path, "s1", "Develop", true, None).unwrap_err();
        assert!(err.starts_with(BRANCH_NAME_CLASH_PREFIX), "got: {err}");
        assert!(
            err.contains("'develop'"),
            "names the existing branch: {err}"
        );

        // Nothing was made: no branch, no worktree, develop where it was.
        assert_eq!(local_branches(&repo_path), branches_before);
        assert_eq!(
            git_out(&repo_path, &["rev-parse", "develop"]),
            develop_before
        );
        let wt_path = worktree_path_for_session(app_data.path(), &repo_path, "s1", "Develop");
        assert!(!wt_path.exists());
        assert!(!git_out(&repo_path, &["worktree", "list"]).contains("Develop"));

        // Asked to use an existing branch "Develop": also refused.
        let err =
            create_worktree(app_data.path(), &repo_path, "s1", "Develop", false, None).unwrap_err();
        assert!(err.starts_with(BRANCH_NAME_CLASH_PREFIX), "got: {err}");
        assert_eq!(
            git_out(&repo_path, &["rev-parse", "develop"]),
            develop_before
        );
    }

    #[test]
    fn test_new_branch_in_a_folder_differing_only_in_case_is_refused() {
        let app_data = create_test_app_data_dir();
        let (_repo_dir, repo_path) = repo_with_develop();
        git_out(&repo_path, &["branch", "feature/inbox"]);
        let err = create_worktree(app_data.path(), &repo_path, "s2", "Feature/new", true, None)
            .unwrap_err();
        assert!(err.contains("'feature/inbox'"), "got: {err}");
        assert!(!local_branches(&repo_path)
            .iter()
            .any(|b| b.eq_ignore_ascii_case("feature/new")));
    }

    #[test]
    fn test_choosing_the_existing_branch_uses_it() {
        let app_data = create_test_app_data_dir();
        let (_repo_dir, repo_path) = repo_with_develop();
        let wt =
            create_worktree(app_data.path(), &repo_path, "s1", "develop", false, None).unwrap();
        assert_eq!(wt.branch_name, "develop");
        assert_eq!(
            get_worktree_branch(&wt.worktree_path).unwrap(),
            Some("develop".to_string())
        );
        // Chosen on purpose: work in the session lands on develop.
        std::fs::write(Path::new(&wt.worktree_path).join("more.txt"), "m").unwrap();
        git_out(&wt.worktree_path, &["add", "more.txt"]);
        git_out(&wt.worktree_path, &["commit", "-q", "-m", "more"]);
        assert_eq!(
            git_out(&repo_path, &["rev-parse", "develop"]),
            git_out(&wt.worktree_path, &["rev-parse", "HEAD"])
        );
    }

    #[test]
    fn test_a_remote_branch_whose_local_name_differs_only_in_case_is_refused() {
        let app_data = create_test_app_data_dir();
        let (_remote_dir, local_dir) = create_cloned_test_repos();
        let local_path = local_dir.path().to_str().unwrap();
        git_out(local_path, &["branch", "Feature-XYZ"]);
        let before = git_out(local_path, &["rev-parse", "Feature-XYZ"]);
        let err = create_worktree(
            app_data.path(),
            local_path,
            "session1",
            "",
            false,
            Some("origin/feature-xyz"),
        )
        .unwrap_err();
        assert!(err.starts_with(BRANCH_NAME_CLASH_PREFIX), "got: {err}");
        assert_eq!(git_out(local_path, &["rev-parse", "Feature-XYZ"]), before);
    }

    #[test]
    fn test_archive_branch_name_is_free_in_letter_case() {
        let app_data = create_test_app_data_dir();
        let repo_dir = create_test_repo();
        let repo_path = repo_dir.path().to_str().unwrap();
        let wt = dirty_worktree(app_data.path(), repo_path);
        git_out(repo_path, &["branch", "hermes-archive/Task-A"]);
        // Packed, as `git gc` leaves it: a lookup by name is then exact even
        // on macOS, and a loose `task-a` would shadow the packed `Task-A`.
        git_out(repo_path, &["pack-refs", "--all"]);
        let taken = git_out(repo_path, &["rev-parse", "hermes-archive/Task-A"]);
        let out = commit_worktree_changes(
            &wt.worktree_path,
            "archived",
            CommitTarget::Archive,
            &|_| false,
        )
        .unwrap();
        assert_eq!(out.branch, "hermes-archive/task-a-2");
        assert_eq!(
            git_out(repo_path, &["rev-parse", "hermes-archive/Task-A"]),
            taken
        );
        // A folder differing only in case never makes the search run forever.
        let repo = Repository::open(repo_path).unwrap();
        git_out(repo_path, &["branch", "Hermes-Archive/other"]);
        assert_eq!(
            free_archive_branch_name(&repo, "hermes/new"),
            "hermes-archive/new"
        );
    }
}
