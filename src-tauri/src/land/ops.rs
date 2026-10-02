//! The git work behind the Land sheet (F22), on plain paths so the tests can
//! drive it on throwaway repositories.
//!
//! Objects (snapshots, merge results, squash and revert commits) are built
//! with libgit2 in memory. Anything that moves a checked-out branch goes
//! through the git CLI (`merge --ff-only`, `reset --keep`), which refuses
//! rather than overwrite someone's uncommitted work. A branch that is not
//! checked out anywhere is moved with a compare-and-swap `update-ref`.

use git2::{Oid, Repository, Tree};
use std::path::{Path, PathBuf};

use crate::contract::turns::Diffstat;

/// Run git in `dir`; stdout (trimmed) on success, stderr in the error.
pub fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = crate::git::cli::git_command()
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("Could not run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
    } else {
        Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

fn open(path: &Path) -> Result<Repository, String> {
    Repository::open(path).map_err(|e| format!("Could not open '{}': {e}", path.display()))
}

fn oid(s: &str) -> Result<Oid, String> {
    Oid::from_str(s).map_err(|e| format!("Not a commit id '{s}': {e}"))
}

/// The hidden reference that keeps what a branch pointed at before landing:
/// `refs/hermes/<session>/land/<n>/<which>` (`which` is `branch` or `base`).
pub fn land_ref(session_id: &str, n: u32, which: &str) -> Option<String> {
    crate::contract::turns::is_turn_ref_session_id(session_id)
        .then(|| format!("refs/hermes/{session_id}/land/{n}/{which}"))
}

pub fn write_ref(repo_path: &Path, name: &str, target: &str) -> Result<(), String> {
    let repo = open(repo_path)?;
    repo.reference(name, oid(target)?, true, "hermes: before landing")
        .map(|_| ())
        .map_err(|e| format!("Could not write {name}: {e}"))
}

pub fn ref_target(repo_path: &Path, name: &str) -> Option<String> {
    let repo = Repository::open(repo_path).ok()?;
    let r = repo.find_reference(name).ok()?;
    r.target().map(|o| o.to_string())
}

/// The branch a worktree has checked out, and its commit.
pub fn current_branch(worktree: &Path) -> Result<(String, String), String> {
    let repo = open(worktree)?;
    let head = repo
        .head()
        .map_err(|e| format!("Could not read HEAD: {e}"))?;
    if !head.is_branch() {
        return Err("This worktree is not on a branch (detached HEAD)".into());
    }
    let name = head.shorthand().unwrap_or_default().to_string();
    let commit = head
        .peel_to_commit()
        .map_err(|e| format!("Could not resolve HEAD: {e}"))?;
    Ok((name, commit.id().to_string()))
}

pub fn branch_head(repo_path: &Path, branch: &str) -> Option<String> {
    ref_target(repo_path, &format!("refs/heads/{branch}"))
}

pub fn branch_exists(repo_path: &Path, branch: &str) -> bool {
    branch_head(repo_path, branch).is_some()
}

/// Where `branch` is checked out (the project folder or a linked worktree).
pub fn checkout_of_branch(repo_path: &Path, branch: &str) -> Option<PathBuf> {
    let out = git(repo_path, &["worktree", "list", "--porcelain"]).ok()?;
    let want = format!("branch refs/heads/{branch}");
    let mut current: Option<&str> = None;
    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            current = Some(p);
        } else if line == want {
            return current.map(PathBuf::from);
        } else if line.is_empty() {
            current = None;
        }
    }
    None
}

/// The branch to land on: the one the task was started from (`recorded`,
/// when it still exists), else the one checked out in the project folder,
/// unless that is the task branch itself; then the first of main, master,
/// trunk.
pub fn resolve_base(repo_path: &Path, task_branch: &str, recorded: Option<&str>) -> Option<String> {
    if let Some(r) = recorded.filter(|r| *r != task_branch && branch_exists(repo_path, r)) {
        return Some(r.to_string());
    }
    let repo = Repository::open(repo_path).ok()?;
    if let Ok(head) = repo.head() {
        if head.is_branch() {
            if let Some(name) = head.shorthand() {
                if name != task_branch {
                    return Some(name.to_string());
                }
            }
        }
    }
    ["main", "master", "trunk"]
        .into_iter()
        .find(|b| *b != task_branch && branch_exists(repo_path, b))
        .map(str::to_string)
}

/// A tree of everything in the worktree right now (new, changed and deleted
/// files, respecting .gitignore), written to the object store only: the
/// worktree's index file, branch and stash are untouched.
pub fn snapshot_tree(worktree: &Path, skip: &dyn Fn(&str) -> bool) -> Result<Oid, String> {
    let repo = open(worktree)?;
    let mut index = repo
        .index()
        .map_err(|e| format!("Could not read the index: {e}"))?;
    let mut filter = |path: &Path, _spec: &[u8]| -> i32 {
        if skip(&path.to_string_lossy()) {
            1
        } else {
            0
        }
    };
    index
        .add_all(["*"], git2::IndexAddOption::DEFAULT, Some(&mut filter))
        .map_err(|e| format!("Could not read the changes: {e}"))?;
    index
        .update_all(["*"], Some(&mut filter))
        .map_err(|e| format!("Could not read deletions: {e}"))?;
    // write_tree stores tree objects; the index file itself is never written.
    index
        .write_tree()
        .map_err(|e| format!("Could not snapshot the worktree: {e}"))
}

fn diff_trees(repo: &Repository, a: &Tree, b: &Tree) -> Result<(Diffstat, Vec<String>), String> {
    let diff = repo
        .diff_tree_to_tree(Some(a), Some(b), None)
        .map_err(|e| format!("Could not diff: {e}"))?;
    let stats = diff.stats().map_err(|e| format!("Could not count: {e}"))?;
    let files = diff
        .deltas()
        .filter_map(|d| {
            d.new_file()
                .path()
                .or_else(|| d.old_file().path())
                .map(|p| p.to_string_lossy().replace('\\', "/"))
        })
        .collect();
    Ok((
        Diffstat {
            files: stats.files_changed() as u32,
            insertions: stats.insertions() as u32,
            deletions: stats.deletions() as u32,
        },
        files,
    ))
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum MergeCheck {
    /// The base has not moved since the branch was cut.
    FastForward,
    /// The base moved, and merging the work in has no conflict.
    Clean,
    /// Merging would conflict in these files.
    Conflict { files: Vec<String> },
    /// The work is already in the base.
    NothingToMerge,
    /// There is no base branch to land on.
    NoBase,
    /// The base is checked out (the project folder) with uncommitted
    /// changes in files landing would write: merging would have to
    /// overwrite them, so it is not offered.
    DirtyBase { files: Vec<String> },
}

/// Files with uncommitted changes (new files included) in a checkout.
pub fn dirty_files(checkout: &Path) -> Vec<String> {
    let Ok(repo) = Repository::open(checkout) else {
        return Vec::new();
    };
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let Ok(statuses) = repo.statuses(Some(&mut opts)) else {
        return Vec::new();
    };
    statuses
        .iter()
        .filter(|e| !e.status().is_empty() && !e.status().contains(git2::Status::IGNORED))
        .filter_map(|e| e.path().map(|p| p.replace('\\', "/")))
        .collect()
}

/// The sentence for a base whose checkout has uncommitted changes in files
/// landing would write.
pub fn dirty_base_message(files: &[String], base: &str) -> String {
    let verb = if files.len() == 1 { "has" } else { "have" };
    format!(
        "{} {verb} uncommitted changes in the project folder ({base})",
        crate::git::safety::list_files(files)
    )
}

/// Commits `base_head` has that `other_head` does not (how much landing
/// into `other` would bring along when the task was started from `base`).
pub fn commits_not_in(repo_path: &Path, base: &str, other: &str) -> u32 {
    let (Some(b), Some(o)) = (branch_head(repo_path, base), branch_head(repo_path, other)) else {
        return 0;
    };
    let Ok(repo) = Repository::open(repo_path) else {
        return 0;
    };
    let (Ok(b), Ok(o)) = (Oid::from_str(&b), Oid::from_str(&o)) else {
        return 0;
    };
    let Ok(mut walk) = repo.revwalk() else {
        return 0;
    };
    if walk.push(b).is_err() || walk.hide(o).is_err() {
        return 0;
    }
    walk.take(10_000).count() as u32
}

/// Local branch names, for the Land sheet's "Land into" choice.
pub fn local_branches(repo_path: &Path) -> Vec<String> {
    let Ok(repo) = Repository::open(repo_path) else {
        return Vec::new();
    };
    let Ok(branches) = repo.branches(Some(git2::BranchType::Local)) else {
        return Vec::new();
    };
    let mut names: Vec<String> = branches
        .flatten()
        .filter_map(|(b, _)| b.name().ok().flatten().map(str::to_string))
        .collect();
    names.sort();
    names
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseState {
    pub name: String,
    pub head: String,
    /// Where the base branch is checked out, if anywhere.
    pub checked_out_at: Option<String>,
}

/// What landing a worktree would do, computed without changing anything.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    pub branch: String,
    pub head: String,
    /// Files with uncommitted changes (new files included).
    pub uncommitted_files: u32,
    /// Commits on the branch that the base does not have.
    pub commits_ahead: u32,
    /// Everything landing would bring to the base (committed and not).
    pub diffstat: Diffstat,
    pub changed_files: Vec<String>,
    pub base: Option<BaseState>,
    pub merge: MergeCheck,
}

pub fn analyze(
    worktree: &Path,
    repo_path: &Path,
    skip: &dyn Fn(&str) -> bool,
) -> Result<Analysis, String> {
    analyze_into(worktree, repo_path, skip, None)
}

/// `analyze`, landing into `base` (the branch the task was started from, or
/// the one picked on the sheet) when given and it exists.
pub fn analyze_into(
    worktree: &Path,
    repo_path: &Path,
    skip: &dyn Fn(&str) -> bool,
    base: Option<&str>,
) -> Result<Analysis, String> {
    let (branch, head) = current_branch(worktree)?;
    let snapshot = snapshot_tree(worktree, skip)?;
    let repo = open(worktree)?;
    let head_commit = repo
        .find_commit(oid(&head)?)
        .map_err(|e| format!("Could not read HEAD: {e}"))?;
    let head_tree = head_commit.tree().map_err(|e| e.to_string())?;
    let snap_tree = repo.find_tree(snapshot).map_err(|e| e.to_string())?;
    let (uncommitted, _) = diff_trees(&repo, &head_tree, &snap_tree)?;

    let base_name = resolve_base(repo_path, &branch, base);
    let Some(base_name) = base_name else {
        let (diffstat, files) = diff_trees(&repo, &head_tree, &snap_tree)?;
        return Ok(Analysis {
            branch,
            head,
            uncommitted_files: uncommitted.files,
            commits_ahead: 0,
            diffstat,
            changed_files: files,
            base: None,
            merge: MergeCheck::NoBase,
        });
    };
    let base_head = branch_head(repo_path, &base_name)
        .ok_or_else(|| format!("Branch '{base_name}' has no commit"))?;
    let base_oid = oid(&base_head)?;
    let merge_base = repo
        .merge_base(base_oid, head_commit.id())
        .map_err(|e| format!("'{branch}' and '{base_name}' share no history: {e}"))?;
    let (ahead, _) = repo
        .graph_ahead_behind(head_commit.id(), base_oid)
        .map_err(|e| e.to_string())?;
    let mb_tree = repo
        .find_commit(merge_base)
        .and_then(|c| c.tree())
        .map_err(|e| e.to_string())?;
    let (diffstat, files) = diff_trees(&repo, &mb_tree, &snap_tree)?;
    let base_tree = repo
        .find_commit(base_oid)
        .and_then(|c| c.tree())
        .map_err(|e| e.to_string())?;
    let mut merge = merge_check(
        &repo, merge_base, base_oid, &base_tree, &mb_tree, &snap_tree,
    )?;
    let checked_out_at = checkout_of_branch(repo_path, &base_name);
    // Landing writes the task's files into the base's checkout; one with
    // uncommitted changes in those files would refuse the fast-forward.
    if matches!(merge, MergeCheck::FastForward | MergeCheck::Clean) {
        if let Some(dir) = &checked_out_at {
            let dirty = dirty_files(dir);
            let mut both: Vec<String> = files
                .iter()
                .filter(|f| dirty.contains(f))
                .cloned()
                .collect();
            both.sort();
            both.dedup();
            if !both.is_empty() {
                merge = MergeCheck::DirtyBase { files: both };
            }
        }
    }
    Ok(Analysis {
        branch,
        head,
        uncommitted_files: uncommitted.files,
        commits_ahead: ahead as u32,
        diffstat,
        changed_files: files,
        base: Some(BaseState {
            checked_out_at: checked_out_at.map(|p| p.to_string_lossy().to_string()),
            name: base_name,
            head: base_head,
        }),
        merge,
    })
}

fn merge_check(
    repo: &Repository,
    merge_base: Oid,
    base: Oid,
    base_tree: &Tree,
    mb_tree: &Tree,
    work_tree: &Tree,
) -> Result<MergeCheck, String> {
    if merge_base == base {
        return Ok(if work_tree.id() == base_tree.id() {
            MergeCheck::NothingToMerge
        } else {
            MergeCheck::FastForward
        });
    }
    let (tree, conflicts) = merge_result(repo, mb_tree, base_tree, work_tree)?;
    if !conflicts.is_empty() {
        return Ok(MergeCheck::Conflict { files: conflicts });
    }
    Ok(if tree == Some(base_tree.id()) {
        MergeCheck::NothingToMerge
    } else {
        MergeCheck::Clean
    })
}

/// A three-way merge in memory (the merge-tree check): the merged tree, or
/// the files that conflict.
fn merge_result(
    repo: &Repository,
    ancestor: &Tree,
    ours: &Tree,
    theirs: &Tree,
) -> Result<(Option<Oid>, Vec<String>), String> {
    let mut index = repo
        .merge_trees(ancestor, ours, theirs, None)
        .map_err(|e| format!("Could not check the merge: {e}"))?;
    if index.has_conflicts() {
        let mut files: Vec<String> = index
            .conflicts()
            .map_err(|e| e.to_string())?
            .filter_map(|c| c.ok())
            .filter_map(|c| c.our.or(c.their).or(c.ancestor))
            .map(|e| String::from_utf8_lossy(&e.path).replace('\\', "/"))
            .collect();
        files.sort();
        files.dedup();
        return Ok((None, files));
    }
    let tree = index
        .write_tree_to(repo)
        .map_err(|e| format!("Could not write the merge: {e}"))?;
    Ok((Some(tree), Vec::new()))
}

fn signature(repo: &Repository) -> Result<git2::Signature<'static>, String> {
    repo.signature()
        .map(|s| s.to_owned())
        .or_else(|_| git2::Signature::now("Hermes", "hermes@localhost"))
        .map_err(|e| format!("Could not build the commit author: {e}"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SquashOutcome {
    Merged { commit: String, fast_forward: bool },
    Conflict { files: Vec<String> },
    NothingToMerge,
}

/// Squash `head` onto `base` as one commit with `message`, only when the
/// base has not moved (fast-forward) or the in-memory merge is clean. A
/// conflict changes nothing and names the files.
pub fn squash_merge(
    repo_path: &Path,
    base: &str,
    head: &str,
    message: &str,
) -> Result<SquashOutcome, String> {
    let repo = open(repo_path)?;
    let base_head = branch_head(repo_path, base).ok_or_else(|| format!("No branch '{base}'"))?;
    let base_commit = repo
        .find_commit(oid(&base_head)?)
        .map_err(|e| e.to_string())?;
    let head_commit = repo.find_commit(oid(head)?).map_err(|e| e.to_string())?;
    let mb = repo
        .merge_base(base_commit.id(), head_commit.id())
        .map_err(|e| format!("No shared history: {e}"))?;
    let base_tree = base_commit.tree().map_err(|e| e.to_string())?;
    let head_tree = head_commit.tree().map_err(|e| e.to_string())?;
    let fast_forward = mb == base_commit.id();
    let tree_id = if fast_forward {
        head_tree.id()
    } else {
        let mb_tree = repo
            .find_commit(mb)
            .and_then(|c| c.tree())
            .map_err(|e| e.to_string())?;
        match merge_result(&repo, &mb_tree, &base_tree, &head_tree)? {
            (Some(tree), _) => tree,
            (None, files) => return Ok(SquashOutcome::Conflict { files }),
        }
    };
    if tree_id == base_tree.id() {
        return Ok(SquashOutcome::NothingToMerge);
    }
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
    let sig = signature(&repo)?;
    let commit = repo
        .commit(None, &sig, &sig, message, &tree, &[&base_commit])
        .map_err(|e| format!("Could not create the merge commit: {e}"))?;
    advance_branch(repo_path, base, &base_head, &commit.to_string())?;
    Ok(SquashOutcome::Merged {
        commit: commit.to_string(),
        fast_forward,
    })
}

fn checkout_head(dir: &Path) -> Result<String, String> {
    git(dir, &["rev-parse", "HEAD"])
}

/// Move `branch` forward from `expected` to `new` (a descendant). Where it
/// is checked out, the files follow (`merge --ff-only`, which refuses to
/// overwrite uncommitted work); elsewhere the ref moves only if it still
/// points at `expected`.
pub fn advance_branch(
    repo_path: &Path,
    branch: &str,
    expected: &str,
    new: &str,
) -> Result<(), String> {
    match checkout_of_branch(repo_path, branch) {
        Some(dir) => {
            if checkout_head(&dir)? != expected {
                return Err(format!(
                    "'{branch}' moved while landing; nothing was changed"
                ));
            }
            git(&dir, &["merge", "--ff-only", "--quiet", new])
                .map(|_| ())
                .map_err(|e| {
                    // Never git's "stash them" advice: say which files are
                    // in the way, where.
                    let (tracked, untracked) = crate::git::safety::parse_would_overwrite(&e);
                    let files: Vec<String> = tracked.into_iter().chain(untracked).collect();
                    if files.is_empty() {
                        format!("Could not update '{branch}' in {}: {e}", dir.display())
                    } else {
                        dirty_base_message(&files, branch)
                    }
                })
        }
        None => git(
            repo_path,
            &["update-ref", &format!("refs/heads/{branch}"), new, expected],
        )
        .map(|_| ()),
    }
}

/// Move `branch` back from `current` to `target`. Where it is checked out,
/// `reset --keep` keeps uncommitted work and refuses if it would be lost.
pub fn rewind_branch(
    repo_path: &Path,
    branch: &str,
    current: &str,
    target: &str,
) -> Result<(), String> {
    match checkout_of_branch(repo_path, branch) {
        Some(dir) => {
            if checkout_head(&dir)? != current {
                return Err(format!("'{branch}' moved; it was not reset"));
            }
            git(&dir, &["reset", "--keep", "--quiet", target])
                .map(|_| ())
                .map_err(|e| format!("Could not reset '{branch}' in {}: {e}", dir.display()))
        }
        None => git(
            repo_path,
            &[
                "update-ref",
                &format!("refs/heads/{branch}"),
                target,
                current,
            ],
        )
        .map(|_| ()),
    }
}

/// Add a commit on `branch` that undoes `commit`, for a base that moved on
/// since landing. Refuses (changing nothing) when the revert conflicts.
pub fn revert_on_branch(repo_path: &Path, branch: &str, commit: &str) -> Result<String, String> {
    let repo = open(repo_path)?;
    let now = branch_head(repo_path, branch).ok_or_else(|| format!("No branch '{branch}'"))?;
    let ours = repo.find_commit(oid(&now)?).map_err(|e| e.to_string())?;
    let target = repo.find_commit(oid(commit)?).map_err(|e| e.to_string())?;
    let mut index = repo
        .revert_commit(&target, &ours, 0, None)
        .map_err(|e| format!("Could not revert: {e}"))?;
    if index.has_conflicts() {
        return Err(format!(
            "The landed commit can't be reverted automatically on '{branch}': later commits changed the same lines"
        ));
    }
    let tree_id = index.write_tree_to(&repo).map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
    let subject = target.summary().unwrap_or("landed work").to_string();
    let sig = signature(&repo)?;
    let new = repo
        .commit(
            None,
            &sig,
            &sig,
            &format!(
                "Revert \"{subject}\"\n\nThis reverts commit {}.",
                target.id()
            ),
            &tree,
            &[&ours],
        )
        .map_err(|e| format!("Could not create the revert commit: {e}"))?
        .to_string();
    advance_branch(repo_path, branch, &now, &new)?;
    Ok(new)
}

/// Undo a land commit in its worktree: the branch goes back to `before` and
/// the files stay as they are, so the work shows as uncommitted again.
pub fn uncommit(worktree: &Path, landed: &str, before: &str) -> Result<(), String> {
    if checkout_head(worktree)? != landed {
        return Err("The branch has new commits since landing; it was left as it is".into());
    }
    git(worktree, &["reset", "--mixed", "--quiet", before]).map(|_| ())
}

/// Re-create an archived worktree at `path` on `branch`.
pub fn restore_worktree(repo_path: &Path, path: &Path, branch: &str) -> Result<(), String> {
    if path.exists() {
        return Err(format!("'{}' already exists", path.display()));
    }
    let p = path.to_string_lossy().to_string();
    git(repo_path, &["worktree", "add", "--quiet", &p, branch]).map(|_| ())
}

// ─── Remotes ────────────────────────────────────────────────────────

/// The remote to push the branch to: its upstream's remote, else `origin`,
/// else the only remote there is.
pub fn pick_remote(repo_path: &Path, branch: &str) -> Option<String> {
    let repo = Repository::open(repo_path).ok()?;
    if let Ok(cfg) = repo.config() {
        if let Ok(r) = cfg.get_string(&format!("branch.{branch}.remote")) {
            if repo.find_remote(&r).is_ok() {
                return Some(r);
            }
        }
    }
    let remotes = repo.remotes().ok()?;
    let names: Vec<String> = remotes.iter().flatten().map(str::to_string).collect();
    if names.iter().any(|n| n == "origin") {
        return Some("origin".into());
    }
    (names.len() == 1).then(|| names[0].clone())
}

/// The commit `branch` has on `remote`, or None when the remote lacks it.
pub fn remote_branch_head(
    dir: &Path,
    remote: &str,
    branch: &str,
) -> Result<Option<String>, String> {
    let out = git(
        dir,
        &[
            "ls-remote",
            "--heads",
            remote,
            &format!("refs/heads/{branch}"),
        ],
    )?;
    Ok(out
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().next())
        .map(str::to_string))
}

pub fn push_branch(dir: &Path, remote: &str, branch: &str) -> Result<(), String> {
    git(
        dir,
        &[
            "push",
            "--quiet",
            "-u",
            remote,
            &format!("refs/heads/{branch}:refs/heads/{branch}"),
        ],
    )
    .map(|_| ())
}

/// Put the remote branch back to `before` (None: delete it), but only while
/// it still points at what Hermes pushed (`pushed`).
pub fn unpush_branch(
    dir: &Path,
    remote: &str,
    branch: &str,
    pushed: &str,
    before: Option<&str>,
) -> Result<(), String> {
    let lease = format!("--force-with-lease=refs/heads/{branch}:{pushed}");
    let spec = match before {
        Some(sha) => format!("{sha}:refs/heads/{branch}"),
        None => format!(":refs/heads/{branch}"),
    };
    git(dir, &["push", "--quiet", &lease, remote, &spec]).map(|_| ())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use tempfile::TempDir;

    pub fn sh(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args([
                "-c",
                "user.email=test@example.com",
                "-c",
                "user.name=Test",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "init.defaultBranch=main",
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

    /// A repo on `main` with one commit, and a linked worktree on `task`.
    pub fn repo_with_task() -> (TempDir, PathBuf, PathBuf) {
        let tmp = TempDir::new().unwrap();
        let repo = tmp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        sh(&repo, &["init", "-q", "-b", "main"]);
        sh(&repo, &["config", "user.email", "test@example.com"]);
        sh(&repo, &["config", "user.name", "Test"]);
        fs::write(repo.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        fs::write(repo.join(".gitignore"), "node_modules/\n").unwrap();
        sh(&repo, &["add", "."]);
        sh(&repo, &["commit", "-q", "-m", "init"]);
        let wt = tmp.path().join("wt");
        sh(
            &repo,
            &["worktree", "add", "-q", "-b", "task", wt.to_str().unwrap()],
        );
        (tmp, repo, wt)
    }

    fn none(_: &str) -> bool {
        false
    }

    #[test]
    fn a_snapshot_counts_new_changed_and_deleted_files_without_touching_the_index() {
        let (_t, repo, wt) = repo_with_task();
        fs::write(wt.join("a.txt"), "one\nTWO\nthree\nfour\n").unwrap();
        fs::write(wt.join("new.txt"), "hello\n").unwrap();
        fs::create_dir_all(wt.join("node_modules")).unwrap();
        fs::write(wt.join("node_modules/x.js"), "ignored\n").unwrap();
        let status_before = sh(&wt, &["status", "--porcelain"]);
        let a = analyze(&wt, &repo, &none).unwrap();
        assert_eq!(a.branch, "task");
        assert_eq!(a.uncommitted_files, 2);
        assert_eq!(
            a.diffstat,
            Diffstat {
                files: 2,
                insertions: 3,
                deletions: 1
            }
        );
        assert_eq!(a.changed_files, vec!["a.txt", "new.txt"]);
        assert_eq!(a.base.as_ref().unwrap().name, "main");
        assert_eq!(a.merge, MergeCheck::FastForward);
        assert_eq!(
            sh(&wt, &["status", "--porcelain"]),
            status_before,
            "analysis changed nothing in the worktree"
        );
        assert_eq!(sh(&wt, &["diff", "--cached", "--name-only"]), "");
    }

    #[test]
    fn the_merge_check_sees_a_clean_merge_and_a_conflict() {
        let (_t, repo, wt) = repo_with_task();
        fs::write(wt.join("b.txt"), "task\n").unwrap();
        // main moves on with an unrelated change: clean.
        fs::write(repo.join("c.txt"), "main\n").unwrap();
        sh(&repo, &["add", "c.txt"]);
        sh(&repo, &["commit", "-q", "-m", "main moves"]);
        assert_eq!(analyze(&wt, &repo, &none).unwrap().merge, MergeCheck::Clean);
        // Both change the same line: conflict, named.
        fs::write(wt.join("a.txt"), "one\ntask\nthree\n").unwrap();
        fs::write(repo.join("a.txt"), "one\nmain\nthree\n").unwrap();
        sh(&repo, &["commit", "-q", "-am", "main edits a"]);
        assert_eq!(
            analyze(&wt, &repo, &none).unwrap().merge,
            MergeCheck::Conflict {
                files: vec!["a.txt".into()]
            }
        );
    }

    #[test]
    fn squash_merge_fast_forwards_the_checked_out_base_with_one_commit() {
        let (_t, repo, wt) = repo_with_task();
        fs::write(wt.join("b.txt"), "1\n").unwrap();
        sh(&wt, &["add", "."]);
        sh(&wt, &["commit", "-q", "-m", "one"]);
        fs::write(wt.join("b.txt"), "1\n2\n").unwrap();
        sh(&wt, &["commit", "-q", "-am", "two"]);
        let before = sh(&repo, &["rev-parse", "main"]);
        let head = sh(&wt, &["rev-parse", "HEAD"]);
        let out = squash_merge(&repo, "main", &head, "Land task").unwrap();
        let SquashOutcome::Merged {
            commit,
            fast_forward,
        } = out
        else {
            panic!("{out:?}")
        };
        assert!(fast_forward);
        assert_eq!(sh(&repo, &["rev-parse", "main"]), commit);
        assert_eq!(sh(&repo, &["rev-parse", "main^"]), before, "one commit");
        assert_eq!(
            sh(&repo, &["log", "-1", "--format=%s", "main"]),
            "Land task"
        );
        assert_eq!(
            // A checkout may write CRLF (core.autocrlf on Windows).
            fs::read_to_string(repo.join("b.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "1\n2\n",
            "the project folder's files moved with main"
        );
        assert_eq!(sh(&repo, &["status", "--porcelain"]), "");
    }

    #[test]
    fn squash_merge_refuses_a_conflict_and_changes_nothing() {
        let (_t, repo, wt) = repo_with_task();
        fs::write(wt.join("a.txt"), "one\ntask\nthree\n").unwrap();
        sh(&wt, &["commit", "-q", "-am", "task"]);
        fs::write(repo.join("a.txt"), "one\nmain\nthree\n").unwrap();
        sh(&repo, &["commit", "-q", "-am", "main"]);
        let before = sh(&repo, &["rev-parse", "main"]);
        let head = sh(&wt, &["rev-parse", "HEAD"]);
        assert_eq!(
            squash_merge(&repo, "main", &head, "x").unwrap(),
            SquashOutcome::Conflict {
                files: vec!["a.txt".into()]
            }
        );
        assert_eq!(sh(&repo, &["rev-parse", "main"]), before);
        assert_eq!(
            fs::read_to_string(repo.join("a.txt")).unwrap(),
            "one\nmain\nthree\n"
        );
    }

    #[test]
    fn a_base_not_checked_out_anywhere_moves_by_compare_and_swap() {
        let (_t, repo, wt) = repo_with_task();
        sh(&repo, &["branch", "release"]);
        fs::write(wt.join("b.txt"), "x\n").unwrap();
        sh(&wt, &["add", "."]);
        sh(&wt, &["commit", "-q", "-m", "x"]);
        let head = sh(&wt, &["rev-parse", "HEAD"]);
        let before = sh(&repo, &["rev-parse", "release"]);
        let SquashOutcome::Merged { commit, .. } =
            squash_merge(&repo, "release", &head, "Land").unwrap()
        else {
            panic!()
        };
        assert_eq!(sh(&repo, &["rev-parse", "release"]), commit);
        // A stale expectation is refused.
        assert!(advance_branch(&repo, "release", &before, &head).is_err());
        rewind_branch(&repo, "release", &commit, &before).unwrap();
        assert_eq!(sh(&repo, &["rev-parse", "release"]), before);
    }

    #[test]
    fn undo_resets_an_unmoved_base_and_reverts_a_moved_one() {
        let (_t, repo, wt) = repo_with_task();
        fs::write(wt.join("b.txt"), "task\n").unwrap();
        sh(&wt, &["add", "."]);
        sh(&wt, &["commit", "-q", "-m", "task"]);
        let head = sh(&wt, &["rev-parse", "HEAD"]);
        let before = sh(&repo, &["rev-parse", "main"]);
        let SquashOutcome::Merged { commit, .. } =
            squash_merge(&repo, "main", &head, "Land").unwrap()
        else {
            panic!()
        };
        // Not moved: reset.
        rewind_branch(&repo, "main", &commit, &before).unwrap();
        assert_eq!(sh(&repo, &["rev-parse", "main"]), before);
        assert!(!repo.join("b.txt").exists());

        // Land again, then main moves on: revert keeps the later work.
        let SquashOutcome::Merged { commit, .. } =
            squash_merge(&repo, "main", &head, "Land").unwrap()
        else {
            panic!()
        };
        fs::write(repo.join("later.txt"), "later\n").unwrap();
        sh(&repo, &["add", "later.txt"]);
        sh(&repo, &["commit", "-q", "-m", "later"]);
        assert!(rewind_branch(&repo, "main", &commit, &before).is_err());
        let revert = revert_on_branch(&repo, "main", &commit).unwrap();
        assert_eq!(sh(&repo, &["rev-parse", "main"]), revert);
        assert!(!repo.join("b.txt").exists(), "the landed file is gone");
        assert!(repo.join("later.txt").exists(), "later work is kept");
        assert!(sh(&repo, &["log", "-1", "--format=%s"]).starts_with("Revert \"Land\""));
    }

    #[test]
    fn uncommit_brings_the_work_back_as_uncommitted_changes() {
        let (_t, _repo, wt) = repo_with_task();
        let before = sh(&wt, &["rev-parse", "HEAD"]);
        fs::write(wt.join("b.txt"), "x\n").unwrap();
        sh(&wt, &["add", "."]);
        sh(&wt, &["commit", "-q", "-m", "x"]);
        let landed = sh(&wt, &["rev-parse", "HEAD"]);
        uncommit(&wt, &landed, &before).unwrap();
        assert_eq!(sh(&wt, &["rev-parse", "HEAD"]), before);
        assert_eq!(sh(&wt, &["status", "--porcelain"]), "?? b.txt");
        // Not again: HEAD is no longer the landed commit.
        assert!(uncommit(&wt, &landed, &before).is_err());
    }

    #[test]
    fn push_and_unpush_against_a_local_bare_remote() {
        let (t, repo, wt) = repo_with_task();
        let bare = t.path().join("remote.git");
        sh(t.path(), &["init", "-q", "--bare", bare.to_str().unwrap()]);
        sh(&repo, &["remote", "add", "origin", bare.to_str().unwrap()]);
        assert_eq!(pick_remote(&repo, "task").as_deref(), Some("origin"));
        assert_eq!(remote_branch_head(&wt, "origin", "task").unwrap(), None);
        fs::write(wt.join("b.txt"), "x\n").unwrap();
        sh(&wt, &["add", "."]);
        sh(&wt, &["commit", "-q", "-m", "x"]);
        let head = sh(&wt, &["rev-parse", "HEAD"]);
        push_branch(&wt, "origin", "task").unwrap();
        assert_eq!(
            remote_branch_head(&wt, "origin", "task")
                .unwrap()
                .as_deref(),
            Some(head.as_str())
        );
        unpush_branch(&wt, "origin", "task", &head, None).unwrap();
        assert_eq!(remote_branch_head(&wt, "origin", "task").unwrap(), None);
    }

    #[test]
    fn land_refs_live_under_the_session() {
        assert_eq!(
            land_ref("s-1", 2, "base").as_deref(),
            Some("refs/hermes/s-1/land/2/base")
        );
        assert_eq!(land_ref("../x", 2, "base"), None);
        let (_t, repo, _wt) = repo_with_task();
        let main = sh(&repo, &["rev-parse", "main"]);
        write_ref(&repo, "refs/hermes/s-1/land/1/base", &main).unwrap();
        assert_eq!(
            ref_target(&repo, "refs/hermes/s-1/land/1/base").as_deref(),
            Some(main.as_str())
        );
    }

    #[test]
    fn restore_worktree_re_adds_the_branch_checkout() {
        let (t, repo, wt) = repo_with_task();
        sh(
            &repo,
            &["worktree", "remove", "--force", wt.to_str().unwrap()],
        );
        assert!(!wt.exists());
        restore_worktree(&repo, &wt, "task").unwrap();
        assert_eq!(current_branch(&wt).unwrap().0, "task");
        assert!(restore_worktree(&repo, &wt, "task").is_err());
        drop(t);
    }

    #[test]
    fn a_branch_that_was_never_created_does_not_exist() {
        let (_t, repo, _wt) = repo_with_task();
        assert!(branch_exists(&repo, "main"));
        assert!(branch_exists(&repo, "task"));
        assert!(!branch_exists(&repo, "never-made"));
    }

    #[test]
    fn the_base_is_the_project_folder_s_branch_unless_that_is_the_task_itself() {
        let (_t, repo, _wt) = repo_with_task();
        assert_eq!(resolve_base(&repo, "task", None).as_deref(), Some("main"));
        // The project folder on another branch: that branch is the base.
        sh(&repo, &["checkout", "-q", "-b", "develop"]);
        assert_eq!(
            resolve_base(&repo, "task", None).as_deref(),
            Some("develop")
        );
        // The project folder on the task branch itself: main, not the task.
        assert_eq!(
            resolve_base(&repo, "develop", None).as_deref(),
            Some("main")
        );
    }

    #[test]
    fn a_task_on_main_itself_has_no_base() {
        let (_t, repo, _wt) = repo_with_task();
        // Checked out in the project folder and the only candidate: nothing
        // to land on.
        assert_eq!(resolve_base(&repo, "main", None), None);
    }

    #[test]
    fn the_branch_the_task_was_started_from_is_the_base() {
        let (t, repo, wt) = repo_with_task();
        // develop is one commit ahead of main; the project folder stays on main.
        sh(&repo, &["branch", "develop"]);
        let dev = t.path().join("dev");
        sh(
            &repo,
            &["worktree", "add", "-q", dev.to_str().unwrap(), "develop"],
        );
        fs::write(dev.join("DEVELOP.md"), "only on develop\n").unwrap();
        sh(&dev, &["add", "."]);
        sh(&dev, &["commit", "-q", "-m", "develop work"]);
        sh(&dev, &["checkout", "-q", "--detach"]);
        assert_eq!(
            resolve_base(&repo, "task", Some("develop")).as_deref(),
            Some("develop")
        );
        // A recorded base that is gone: back to the project folder's branch.
        assert_eq!(
            resolve_base(&repo, "task", Some("gone")).as_deref(),
            Some("main")
        );
        assert_eq!(commits_not_in(&repo, "develop", "main"), 1);
        assert_eq!(commits_not_in(&repo, "main", "develop"), 0);
        let a = analyze_into(&wt, &repo, &none, Some("develop")).unwrap();
        assert_eq!(a.base.unwrap().name, "develop");
        assert!(local_branches(&repo).contains(&"develop".to_string()));
    }

    #[test]
    fn a_dirty_file_in_the_base_checkout_that_landing_writes_blocks_the_merge() {
        let (_t, repo, wt) = repo_with_task();
        fs::write(wt.join("a.txt"), "one\ntask\nthree\n").unwrap();
        sh(&wt, &["commit", "-q", "-am", "task"]);
        // An unrelated dirty file in the project folder is fine.
        fs::write(repo.join("other.txt"), "mine\n").unwrap();
        assert_eq!(
            analyze(&wt, &repo, &none).unwrap().merge,
            MergeCheck::FastForward
        );
        // The same file landing writes: refused before anything moves.
        fs::write(repo.join("a.txt"), "one\nmy edit\nthree\n").unwrap();
        assert_eq!(
            analyze(&wt, &repo, &none).unwrap().merge,
            MergeCheck::DirtyBase {
                files: vec!["a.txt".into()]
            }
        );
        assert_eq!(
            dirty_base_message(&["a.txt".into()], "main"),
            "a.txt has uncommitted changes in the project folder (main)"
        );
        // And if it got that far, the refusal says the same, never "stash".
        let head = sh(&wt, &["rev-parse", "HEAD"]);
        let before = sh(&repo, &["rev-parse", "main"]);
        let err = squash_merge(&repo, "main", &head, "Land").unwrap_err();
        assert_eq!(
            err,
            "a.txt has uncommitted changes in the project folder (main)"
        );
        assert_eq!(sh(&repo, &["rev-parse", "main"]), before);
    }
}
