//! Git operations that must never lose someone's work, done the way git
//! itself does them.
//!
//! libgit2 is handy for reading, but several of its write paths skip the
//! safety checks the git CLI has: a forced checkout overwrites uncommitted
//! edits, `reset --hard` is not `merge --abort`, a path handed to checkout is
//! a glob pattern, `Branch::delete` never asks whether the branch is merged,
//! and `Repository::commit` runs no hooks and signs nothing. Everything here
//! either runs the git CLI (through `cli::git_command`, in the C locale so
//! its messages can be read) or adds the check libgit2 leaves out, and turns
//! git's refusals into sentences a person can act on.

use git2::{BranchType, Oid, Repository};
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Prefix of an error the frontend reads as "a git hook refused the commit"
/// (followed by a JSON object: `{ "hook": ..., "output": ... }`).
pub const HOOK_REFUSED_PREFIX: &str = "HOOK_REFUSED:";
/// Prefix of an error the frontend reads as "this branch has commits that
/// no other branch has" (followed by `{ "branch", "base", "commits" }`).
pub const BRANCH_UNMERGED_PREFIX: &str = "BRANCH_UNMERGED:";

/// What a git process printed, and whether it succeeded.
#[derive(Debug)]
pub struct GitRun {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

/// A git command in `dir` that may run the repository's hooks: no terminal
/// prompts, and the PATH of the person's login shell, so a hook that calls
/// `git-lfs`, `node` or `npx` finds them although the app was started from
/// the Dock (whose PATH is bare).
pub fn git_in(dir: &Path) -> Command {
    let mut cmd = crate::git::cli::git_command();
    cmd.arg("-C").arg(dir).env("GIT_TERMINAL_PROMPT", "0");
    give_hooks_the_login_path(&mut cmd);
    cmd
}

#[cfg(not(test))]
fn give_hooks_the_login_path(cmd: &mut Command) {
    cmd.env("PATH", crate::done_when::check_path_var());
}

#[cfg(test)]
fn give_hooks_the_login_path(_cmd: &mut Command) {}

/// Run `cmd`, feeding `stdin` if given.
pub fn run(cmd: &mut Command, stdin: Option<&str>) -> Result<GitRun, String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.stdin(if stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    let mut child = cmd.spawn().map_err(|e| format!("Could not run git: {e}"))?;
    if let Some(text) = stdin {
        if let Some(mut pipe) = child.stdin.take() {
            // A hook that exits early closes the pipe; that is reported by
            // the exit status, not here.
            let _ = pipe.write_all(text.as_bytes());
        }
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("Could not run git: {e}"))?;
    Ok(GitRun {
        ok: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).trim_end().to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).trim_end().to_string(),
    })
}

/// "a.md" / "a.md and b.md" / "a.md, b.md and 2 more".
pub fn list_files(files: &[String]) -> String {
    match files.len() {
        0 => String::new(),
        1 => files[0].clone(),
        2 => format!("{} and {}", files[0], files[1]),
        3 => format!("{}, {} and {}", files[0], files[1], files[2]),
        n => format!("{}, {} and {} more", files[0], files[1], n - 2),
    }
}

// ─── Pull ───────────────────────────────────────────────────────────

/// The files git lists after "…would be overwritten by merge:" (tracked
/// files with uncommitted changes) and after "untracked working tree files
/// would be overwritten" (untracked ones), in that order.
pub fn parse_would_overwrite(stderr: &str) -> (Vec<String>, Vec<String>) {
    let mut tracked = Vec::new();
    let mut untracked = Vec::new();
    let mut into: Option<bool> = None;
    for line in stderr.lines() {
        let l = line.trim_end_matches('\r');
        if l.contains("would be overwritten by") {
            into = Some(l.contains("untracked"));
            continue;
        }
        match into {
            Some(is_untracked) if l.starts_with('\t') || l.starts_with("    ") => {
                let f = l.trim().to_string();
                if !f.is_empty() {
                    if is_untracked {
                        untracked.push(f);
                    } else {
                        tracked.push(f);
                    }
                }
            }
            _ => into = None,
        }
    }
    (tracked, untracked)
}

/// What to tell someone whose Pull git refused, from git's own message.
pub fn pull_refusal_message(stderr: &str) -> String {
    let (tracked, untracked) = parse_would_overwrite(stderr);
    if !tracked.is_empty() {
        let verb = if tracked.len() == 1 { "has" } else { "have" };
        return format!(
            "Pull stopped: {} {verb} uncommitted changes that the incoming commits also change. Commit them or discard them, then pull again.",
            list_files(&tracked)
        );
    }
    if !untracked.is_empty() {
        let verb = if untracked.len() == 1 { "is" } else { "are" };
        return format!(
            "Pull stopped: {} {verb} not tracked here, and the incoming commits add {}. Move or delete {}, then pull again.",
            list_files(&untracked),
            if untracked.len() == 1 { "it" } else { "them" },
            if untracked.len() == 1 { "it" } else { "them" },
        );
    }
    let first = stderr
        .lines()
        .map(|l| {
            l.trim()
                .trim_start_matches("error: ")
                .trim_start_matches("fatal: ")
        })
        .find(|l| !l.is_empty())
        .unwrap_or("git refused the pull");
    format!("Pull stopped: {first}")
}

/// Move the checked-out branch of `dir` forward to `target` the way
/// `git merge --ff-only` does: uncommitted edits git does not have to touch
/// stay, and edits the incoming commits would overwrite stop the pull.
pub fn fast_forward(dir: &Path, target: &str) -> Result<(), String> {
    let out = run(
        git_in(dir).args(["merge", "--ff-only", "--quiet", target]),
        None,
    )?;
    if out.ok {
        Ok(())
    } else {
        Err(pull_refusal_message(&out.stderr))
    }
}

/// How a merge Pull ended.
#[derive(Debug, PartialEq, Eq)]
pub enum MergeRun {
    Merged,
    /// The merge stopped with conflicts (MERGE_HEAD written).
    Conflicts,
}

/// `git merge --no-edit -m <message> <target>`: hooks run, uncommitted
/// edits in files the merge touches stop it before anything changes.
pub fn merge(dir: &Path, target: &str, message: &str) -> Result<MergeRun, String> {
    let out = run(
        git_in(dir).args(["merge", "--no-edit", "--no-ff", "-m", message, target]),
        None,
    )?;
    if out.ok {
        return Ok(MergeRun::Merged);
    }
    let in_merge = Repository::open(dir)
        .map(|r| r.state() == git2::RepositoryState::Merge)
        .unwrap_or(false);
    if in_merge {
        return Ok(MergeRun::Conflicts);
    }
    Err(pull_refusal_message(&out.stderr))
}

// ─── Merge abort ────────────────────────────────────────────────────

/// `git merge --abort`: the files the merge changed go back, every other
/// uncommitted edit stays. git's refusal comes back as it is.
pub fn abort_merge(dir: &Path) -> Result<(), String> {
    let out = run(git_in(dir).args(["merge", "--abort"]), None)?;
    if out.ok {
        Ok(())
    } else {
        let why = out
            .stderr
            .lines()
            .map(|l| {
                l.trim()
                    .trim_start_matches("fatal: ")
                    .trim_start_matches("error: ")
            })
            .find(|l| !l.is_empty())
            .unwrap_or("git refused")
            .to_string();
        Err(format!("The merge was not aborted: {why}"))
    }
}

// ─── Discard / unstage ──────────────────────────────────────────────

/// Restore exactly these files from HEAD. Paths are literal: `pages/[id].tsx`
/// is that one file, never a pattern that also matches `pages/i.tsx`.
pub fn discard_paths(repo: &Repository, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut b = git2::build::CheckoutBuilder::new();
    b.force();
    b.disable_pathspec_match(true);
    for p in paths {
        b.path(p.as_str());
    }
    repo.checkout_head(Some(&mut b))
        .map_err(|e| format!("Failed to discard changes: {e}"))
}

/// Take exactly these files (or everything for `["."]`) out of the index,
/// back to what HEAD has. Paths are literal, as in `discard_paths`.
pub fn unstage_paths(dir: &Path, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let unborn = Repository::open(dir)
        .map_err(|e| e.to_string())?
        .head()
        .is_err();
    let all = paths.len() == 1 && paths[0] == ".";
    let mut cmd = git_in(dir);
    cmd.env("GIT_LITERAL_PATHSPECS", "1");
    if unborn {
        // Nothing to go back to: unstaging is forgetting the new files.
        cmd.args(["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--"]);
    } else {
        cmd.args(["reset", "-q", "--"]);
    }
    if all {
        cmd.arg(".");
    } else {
        cmd.args(paths);
    }
    let out = run(&mut cmd, None)?;
    if out.ok {
        Ok(())
    } else {
        Err(format!("Failed to unstage: {}", out.stderr.trim()))
    }
}

// ─── Branch delete ──────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Unmerged {
    pub branch: String,
    /// The branch the commits are missing from (the default branch, else
    /// the checked-out one).
    pub base: String,
    pub commits: u32,
}

impl Unmerged {
    pub fn error(&self) -> String {
        format!(
            "{BRANCH_UNMERGED_PREFIX}{}",
            serde_json::to_string(self).unwrap_or_default()
        )
    }
}

/// The repository's default branch: what `origin/HEAD` points at, else the
/// first of main, master, trunk that exists.
fn default_branch(repo: &Repository) -> Option<(String, Oid)> {
    if let Ok(r) = repo.find_reference("refs/remotes/origin/HEAD") {
        if let Some(target) = r.symbolic_target() {
            let name = target
                .trim_start_matches("refs/remotes/origin/")
                .to_string();
            if let Ok(resolved) = r.resolve() {
                if let Some(oid) = resolved.target() {
                    return Some((name, oid));
                }
            }
        }
    }
    ["main", "master", "trunk"].into_iter().find_map(|b| {
        repo.find_branch(b, BranchType::Local)
            .ok()
            .and_then(|br| br.get().target())
            .map(|oid| (b.to_string(), oid))
    })
}

/// Whether deleting local branch `name` would lose commits: its tip must be
/// on HEAD, on its upstream, or on the default branch (what `git branch -d`
/// checks, plus the default branch). `None` when it is safe.
pub fn unmerged_commits(repo: &Repository, name: &str) -> Result<Option<Unmerged>, String> {
    let branch = repo
        .find_branch(name, BranchType::Local)
        .map_err(|e| format!("Branch '{name}' not found: {e}"))?;
    let Some(tip) = branch.get().target() else {
        return Ok(None);
    };
    let mut keepers: Vec<(String, Oid)> = Vec::new();
    if let Some(d) = default_branch(repo) {
        keepers.push(d);
    }
    if let Ok(head) = repo.head() {
        if let Some(oid) = head.target() {
            keepers.push((head.shorthand().unwrap_or("HEAD").to_string(), oid));
        }
    }
    if let Ok(up) = branch.upstream() {
        if let Some(oid) = up.get().target() {
            keepers.push((
                up.name().ok().flatten().unwrap_or("upstream").to_string(),
                oid,
            ));
        }
    }
    for (_, keeper) in &keepers {
        if *keeper == tip || repo.graph_descendant_of(*keeper, tip).unwrap_or(false) {
            return Ok(None);
        }
    }
    let mut walk = repo.revwalk().map_err(|e| e.to_string())?;
    walk.push(tip).map_err(|e| e.to_string())?;
    for (_, keeper) in &keepers {
        let _ = walk.hide(*keeper);
    }
    let commits = walk.take(10_000).count() as u32;
    let base = keepers
        .first()
        .map(|(n, _)| n.clone())
        .unwrap_or_else(|| "any other branch".to_string());
    Ok(Some(Unmerged {
        branch: name.to_string(),
        base,
        commits,
    }))
}

// ─── Commit ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HookRefusal {
    /// `pre-commit`, `commit-msg`, `prepare-commit-msg`, or "a git hook".
    pub hook: String,
    /// What the hook printed.
    pub output: String,
}

impl HookRefusal {
    pub fn error(&self) -> String {
        format!(
            "{HOOK_REFUSED_PREFIX}{}",
            serde_json::to_string(self).unwrap_or_default()
        )
    }
}

/// The last commit hook git's trace says it ran.
pub fn last_hook_in_trace(trace: &str) -> Option<String> {
    let mut last = None;
    for line in trace.lines() {
        if !line.contains("run_command") {
            continue;
        }
        for hook in ["pre-commit", "prepare-commit-msg", "commit-msg"] {
            let needle = format!("hooks/{hook}");
            if let Some(i) = line.find(&needle) {
                let after = line[i + needle.len()..].chars().next();
                if after.is_none_or(|c| !c.is_alphanumeric() && c != '-') {
                    last = Some(hook.to_string());
                }
            }
        }
    }
    last
}

fn trace_file() -> PathBuf {
    std::env::temp_dir().join(format!("hermes-git-trace-{}", uuid::Uuid::new_v4()))
}

/// Commit what is staged in `dir` with `git commit -F -`: the repository's
/// hooks run and its signing settings apply, as they would in a terminal.
/// `author` sets author and committer (the app's author setting); without
/// it, git's own configuration is used, and a repository with no identity
/// at all commits as Hermes. Returns the new commit. A hook that refuses
/// comes back as a `HOOK_REFUSED:` error with what it printed.
pub fn commit_staged(
    dir: &Path,
    message: &str,
    author: Option<(&str, &str)>,
) -> Result<String, String> {
    commit_staged_with(dir, message, author, true)
}

/// `commit_staged`; `verify: false` skips the pre-commit and commit-msg
/// hooks (signing still applies). Only for an archive snapshot on a
/// `hermes-archive/` branch, which — like `git stash` — keeps work that a
/// hook refused to let onto the real branch.
pub fn commit_staged_with(
    dir: &Path,
    message: &str,
    author: Option<(&str, &str)>,
    verify: bool,
) -> Result<String, String> {
    let trace = trace_file();
    let mut cmd = git_in(dir);
    // `whitespace`: a line starting with `#` is part of the message.
    cmd.args(["commit", "--quiet", "--cleanup=whitespace", "-F", "-"])
        .env("GIT_TRACE", &trace);
    if !verify {
        cmd.arg("--no-verify");
    }
    let identity = Repository::open(dir)
        .map(|r| r.signature().is_ok())
        .unwrap_or(false);
    match author {
        Some((name, email)) if !name.is_empty() && !email.is_empty() => {
            cmd.env("GIT_AUTHOR_NAME", name)
                .env("GIT_AUTHOR_EMAIL", email)
                .env("GIT_COMMITTER_NAME", name)
                .env("GIT_COMMITTER_EMAIL", email);
        }
        _ if !identity => {
            cmd.env("GIT_AUTHOR_NAME", "Hermes")
                .env("GIT_AUTHOR_EMAIL", "hermes@localhost")
                .env("GIT_COMMITTER_NAME", "Hermes")
                .env("GIT_COMMITTER_EMAIL", "hermes@localhost");
        }
        _ => {}
    }
    let out = run(&mut cmd, Some(message));
    let traced = std::fs::read_to_string(&trace).unwrap_or_default();
    let _ = std::fs::remove_file(&trace);
    let out = out?;
    if !out.ok {
        let printed = [out.stderr.trim(), out.stdout.trim()]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        if let Some(hook) = last_hook_in_trace(&traced) {
            return Err(HookRefusal {
                hook,
                output: printed,
            }
            .error());
        }
        return Err(format!("Commit failed: {printed}"));
    }
    run(git_in(dir).args(["rev-parse", "HEAD"]), None)
        .and_then(|r| {
            if r.ok {
                Ok(r.stdout.trim().to_string())
            } else {
                Err(r.stderr)
            }
        })
        .map_err(|e| format!("Committed, but could not read the new commit: {e}"))
}

// ─── Detached HEAD, operations in progress, submodules ──────────────

/// What a worktree's HEAD is doing, for the close dialog.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadState {
    /// The branch HEAD is on; None when detached.
    pub branch: Option<String>,
    pub detached: bool,
    pub head: Option<String>,
    /// Commits reachable from a detached HEAD and from no branch, tag or
    /// remote branch: closing would leave them reachable from nothing.
    pub lost_commits: u32,
    /// "rebase", "merge", "bisect", "cherry-pick" or "revert" when one is
    /// in progress.
    pub operation: Option<String>,
    /// Submodules with uncommitted changes inside them (Hermes cannot
    /// commit those from the superproject).
    pub dirty_submodules: Vec<String>,
}

fn operation_name(state: git2::RepositoryState) -> Option<&'static str> {
    use git2::RepositoryState as S;
    match state {
        S::Clean => None,
        S::Merge => Some("merge"),
        S::Revert | S::RevertSequence => Some("revert"),
        S::CherryPick | S::CherryPickSequence => Some("cherry-pick"),
        S::Bisect => Some("bisect"),
        S::Rebase | S::RebaseInteractive | S::RebaseMerge | S::ApplyMailbox => Some("rebase"),
        S::ApplyMailboxOrRebase => Some("rebase"),
    }
}

/// Commits reachable from `from` that no branch, tag or remote branch has.
pub fn commits_on_no_ref(repo: &Repository, from: Oid) -> u32 {
    let Ok(mut walk) = repo.revwalk() else {
        return 0;
    };
    if walk.push(from).is_err() {
        return 0;
    }
    if let Ok(refs) = repo.references() {
        for r in refs.flatten() {
            let Some(name) = r.name() else { continue };
            if !(name.starts_with("refs/heads/")
                || name.starts_with("refs/tags/")
                || name.starts_with("refs/remotes/"))
            {
                continue;
            }
            if let Ok(c) = r.peel_to_commit() {
                let _ = walk.hide(c.id());
            }
        }
    }
    walk.take(10_000).count() as u32
}

pub fn head_state(worktree: &Path) -> Result<HeadState, String> {
    let repo =
        Repository::open(worktree).map_err(|e| format!("Could not open the worktree: {e}"))?;
    let mut st = HeadState {
        operation: operation_name(repo.state()).map(str::to_string),
        ..HeadState::default()
    };
    // A bisect in a linked worktree keeps its files in that worktree's own
    // git folder, which libgit2's state check does not always look at.
    if st.operation.is_none() && repo.path().join("BISECT_LOG").exists() {
        st.operation = Some("bisect".into());
    }
    if let Ok(head) = repo.head() {
        st.head = head.target().map(|o| o.to_string());
        if head.is_branch() {
            st.branch = head.shorthand().map(str::to_string);
        } else {
            st.detached = true;
            if let Some(oid) = head.target() {
                st.lost_commits = commits_on_no_ref(&repo, oid);
            }
        }
    }
    if let Ok(subs) = repo.submodules() {
        for sm in subs {
            let Some(name) = sm.name() else { continue };
            let Ok(status) = repo.submodule_status(name, git2::SubmoduleIgnore::None) else {
                continue;
            };
            if status.intersects(
                git2::SubmoduleStatus::WD_INDEX_MODIFIED
                    | git2::SubmoduleStatus::WD_WD_MODIFIED
                    | git2::SubmoduleStatus::WD_UNTRACKED,
            ) {
                st.dirty_submodules
                    .push(sm.path().to_string_lossy().replace('\\', "/"));
            }
        }
    }
    Ok(st)
}

/// Keep a detached HEAD's commits on a new branch (`hermes-archive/<stem>-
/// detached`, or the next free name), with HEAD attached to it so the
/// worktree's uncommitted changes can be committed there too. Returns the
/// branch name.
pub fn save_detached_head(
    worktree: &Path,
    recorded_branch: Option<&str>,
) -> Result<String, String> {
    let repo =
        Repository::open(worktree).map_err(|e| format!("Could not open the worktree: {e}"))?;
    let head = repo
        .head()
        .map_err(|e| format!("Could not read HEAD: {e}"))?;
    let commit = head
        .peel_to_commit()
        .map_err(|e| format!("Could not read HEAD: {e}"))?;
    let stem = recorded_branch
        .map(|b| b.strip_prefix("hermes/").unwrap_or(b).to_string())
        .unwrap_or_else(|| "task".into());
    let name = crate::git::worktree::free_archive_branch_name(&repo, &format!("{stem}-detached"));
    repo.branch(&name, &commit, false)
        .map_err(|e| format!("Could not create {name}: {e}"))?;
    let out = run(
        git_in(worktree).args(["symbolic-ref", "HEAD", &format!("refs/heads/{name}")]),
        None,
    )?;
    if !out.ok {
        return Err(format!(
            "Saved {name}, but could not switch to it: {}",
            out.stderr
        ));
    }
    Ok(name)
}

// ─── Submodules of a worktree that is about to go ───────────────────

/// A submodule whose commits exist only in a worktree's private module store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StrandedModule {
    /// Its path in the worktree (`vendor/lib`).
    pub path: String,
    pub commits: u32,
}

/// The `.git/worktrees/<name>` folder of a linked worktree.
fn worktree_git_dir(worktree: &Path) -> Option<PathBuf> {
    Repository::open(worktree)
        .ok()
        .map(|r| r.path().to_path_buf())
}

/// Every submodule checkout inside `worktree` whose git folder lives in
/// that worktree's own module store (`.git/worktrees/<wt>/modules/…`),
/// which `git worktree remove`/prune deletes with the worktree.
fn private_modules(worktree: &Path) -> Vec<(String, PathBuf)> {
    let Some(wt_git) = worktree_git_dir(worktree) else {
        return Vec::new();
    };
    let store = wt_git.join("modules");
    if !store.is_dir() {
        return Vec::new();
    }
    let Ok(repo) = Repository::open(worktree) else {
        return Vec::new();
    };
    let Ok(subs) = repo.submodules() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for sm in subs {
        let path = sm.path().to_string_lossy().replace('\\', "/");
        let checkout = worktree.join(sm.path());
        let Ok(sub) = Repository::open(&checkout) else {
            continue;
        };
        let gitdir = sub.path().to_path_buf();
        let inside = std::fs::canonicalize(&gitdir)
            .ok()
            .zip(std::fs::canonicalize(&store).ok())
            .map(|(g, s)| g.starts_with(s))
            .unwrap_or(false);
        if inside {
            out.push((path, gitdir));
        }
    }
    out
}

/// The commits a module store has at HEAD and on its branches.
fn module_tips(module_git: &Path) -> Vec<Oid> {
    let Ok(repo) = Repository::open(module_git) else {
        return Vec::new();
    };
    let mut tips = Vec::new();
    if let Ok(h) = repo.head() {
        if let Some(o) = h.target() {
            tips.push(o);
        }
    }
    if let Ok(branches) = repo.branches(Some(BranchType::Local)) {
        for (b, _) in branches.flatten() {
            if let Some(o) = b.get().target() {
                if !tips.contains(&o) {
                    tips.push(o);
                }
            }
        }
    }
    tips
}

fn sanitize_ref_part(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/') {
                c
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('/')
        .replace("..", "-")
}

/// Before a worktree goes: copy every submodule commit that exists only in
/// its private module store into a store that stays (the project's own
/// `.git/modules/<path>`, else the superproject itself), under
/// `refs/hermes/archive/<session>/<submodule>/…`. Returns the modules it
/// could not rescue, with how many commits each would lose.
pub fn rescue_submodule_commits(
    repo_path: &Path,
    worktree: &Path,
    session_id: &str,
) -> Vec<StrandedModule> {
    let mut stranded = Vec::new();
    let Ok(sup) = Repository::open(repo_path) else {
        return stranded;
    };
    let common = sup.commondir().to_path_buf();
    for (path, gitdir) in private_modules(worktree) {
        let tips = module_tips(&gitdir);
        if tips.is_empty() {
            continue;
        }
        let main_store = common.join("modules").join(&path);
        let dest = if main_store.is_dir() {
            main_store
        } else {
            common.clone()
        };
        let dest_repo = Repository::open(&dest).ok();
        let missing: Vec<Oid> = tips
            .iter()
            .copied()
            .filter(|t| {
                dest_repo
                    .as_ref()
                    .map(|r| r.find_commit(*t).is_err())
                    .unwrap_or(true)
            })
            .collect();
        if missing.is_empty() {
            continue;
        }
        let prefix = format!(
            "refs/hermes/archive/{}/{}",
            sanitize_ref_part(session_id),
            sanitize_ref_part(&path)
        );
        let mut ok = true;
        for (i, tip) in missing.iter().enumerate() {
            let refname = format!("{prefix}/{i}");
            let out = run(
                crate::git::cli::git_command()
                    .arg("--git-dir")
                    .arg(&dest)
                    .args([
                        "-c",
                        "protocol.file.allow=always",
                        "fetch",
                        "--quiet",
                        "--no-tags",
                    ])
                    .arg(&gitdir)
                    .arg(format!("+{tip}:{refname}"))
                    .env("GIT_TERMINAL_PROMPT", "0"),
                None,
            );
            match out {
                Ok(r) if r.ok => {}
                Ok(r) => {
                    log::warn!(
                        "[worktree] could not keep {path}'s commit {tip}: {}",
                        r.stderr
                    );
                    ok = false;
                }
                Err(e) => {
                    log::warn!("[worktree] could not keep {path}'s commit {tip}: {e}");
                    ok = false;
                }
            }
        }
        if !ok {
            let commits = Repository::open(&gitdir)
                .map(|r| {
                    missing
                        .iter()
                        .map(|t| commits_on_no_ref_except(&r, *t, dest_repo.as_ref()))
                        .max()
                        .unwrap_or(1)
                })
                .unwrap_or(1);
            stranded.push(StrandedModule { path, commits });
        }
    }
    stranded
}

/// Commits from `tip` that `other` does not have (counted in `repo`).
fn commits_on_no_ref_except(repo: &Repository, tip: Oid, other: Option<&Repository>) -> u32 {
    let Ok(mut walk) = repo.revwalk() else {
        return 1;
    };
    if walk.push(tip).is_err() {
        return 1;
    }
    let mut n = 0;
    for oid in walk.flatten().take(10_000) {
        if other.map(|r| r.find_commit(oid).is_ok()).unwrap_or(false) {
            break;
        }
        n += 1;
    }
    n.max(1)
}

/// The message for a worktree kept because a submodule's commits could not
/// be saved anywhere else.
pub fn stranded_message(stranded: &[StrandedModule], worktree: &str) -> String {
    let parts: Vec<String> = stranded
        .iter()
        .map(|s| {
            format!(
                "{} has {} commit{} that exist{} only in this task's worktree",
                s.path,
                s.commits,
                if s.commits == 1 { "" } else { "s" },
                if s.commits == 1 { "s" } else { "" },
            )
        })
        .collect();
    format!("{}. Kept the worktree at {worktree}.", parts.join("; "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    pub fn sh(dir: &Path, args: &[&str]) -> String {
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

    fn repo() -> (TempDir, PathBuf) {
        let t = TempDir::new().unwrap();
        let r = t.path().join("repo");
        fs::create_dir_all(&r).unwrap();
        sh(&r, &["init", "-q", "-b", "main"]);
        sh(&r, &["config", "user.email", "test@example.com"]);
        sh(&r, &["config", "user.name", "Test"]);
        sh(&r, &["config", "commit.gpgsign", "false"]);
        // Windows runners set core.autocrlf=true globally; the tests compare
        // exact bytes, so checkouts here keep the committed line endings.
        sh(&r, &["config", "core.autocrlf", "false"]);
        fs::write(r.join("README.md"), "# readme\n\nline\n").unwrap();
        fs::write(r.join("NOTES.md"), "notes\n").unwrap();
        sh(&r, &["add", "."]);
        sh(&r, &["commit", "-q", "-m", "init"]);
        (t, r)
    }

    /// A clone of `origin` whose remote then gets `commit` (file, content).
    fn clone_behind(t: &TempDir, origin: &Path, file: &str, content: &str) -> PathBuf {
        let c = t.path().join("clone");
        sh(
            t.path(),
            &[
                "clone",
                "-q",
                "-c",
                "core.autocrlf=false",
                origin.to_str().unwrap(),
                c.to_str().unwrap(),
            ],
        );
        sh(&c, &["config", "user.email", "test@example.com"]);
        sh(&c, &["config", "user.name", "Test"]);
        fs::write(origin.join(file), content).unwrap();
        sh(origin, &["add", file]);
        sh(origin, &["commit", "-q", "-m", "upstream"]);
        sh(&c, &["fetch", "-q", "origin"]);
        c
    }

    #[test]
    fn a_fast_forward_keeps_a_dirty_file_the_incoming_commits_do_not_touch() {
        let (t, origin) = repo();
        let c = clone_behind(&t, &origin, "NEWS.md", "news\n");
        fs::write(c.join("README.md"), "my edit\n").unwrap();
        fast_forward(&c, "origin/main").unwrap();
        assert_eq!(
            fs::read_to_string(c.join("README.md")).unwrap(),
            "my edit\n"
        );
        assert!(c.join("NEWS.md").exists());
        assert_eq!(
            sh(&c, &["rev-parse", "HEAD"]),
            sh(&origin, &["rev-parse", "HEAD"])
        );
    }

    #[test]
    fn a_fast_forward_that_would_overwrite_a_dirty_file_is_refused_and_names_it() {
        let (t, origin) = repo();
        let c = clone_behind(&t, &origin, "README.md", "upstream readme\n");
        fs::write(c.join("README.md"), "my edit\n").unwrap();
        let before = sh(&c, &["rev-parse", "HEAD"]);
        let err = fast_forward(&c, "origin/main").unwrap_err();
        assert_eq!(
            err,
            "Pull stopped: README.md has uncommitted changes that the incoming commits also change. Commit them or discard them, then pull again."
        );
        assert!(!err.contains("stash"));
        assert_eq!(
            fs::read_to_string(c.join("README.md")).unwrap(),
            "my edit\n"
        );
        assert_eq!(sh(&c, &["rev-parse", "HEAD"]), before);
    }

    #[test]
    fn overwrite_lists_are_read_from_git_s_messages() {
        let stderr = "error: Your local changes to the following files would be overwritten by merge:\n\tREADME.md\n\tdocs/a b.md\nPlease commit your changes or stash them before you merge.\nAborting";
        assert_eq!(
            parse_would_overwrite(stderr),
            (vec!["README.md".into(), "docs/a b.md".into()], vec![])
        );
        let un = "error: The following untracked working tree files would be overwritten by merge:\n\tNEWS.md\nPlease move or remove them before you merge.\nAborting";
        assert_eq!(parse_would_overwrite(un), (vec![], vec!["NEWS.md".into()]));
        assert!(pull_refusal_message(un).starts_with("Pull stopped: NEWS.md is not tracked here"));
        assert_eq!(
            pull_refusal_message("fatal: Not possible to fast-forward, aborting."),
            "Pull stopped: Not possible to fast-forward, aborting."
        );
    }

    #[test]
    fn abort_merge_keeps_an_unrelated_uncommitted_edit() {
        let (t, origin) = repo();
        let c = clone_behind(&t, &origin, "README.md", "theirs\n");
        fs::write(c.join("README.md"), "ours\n").unwrap();
        sh(&c, &["commit", "-q", "-am", "ours"]);
        fs::write(c.join("NOTES.md"), "an hour of notes\n").unwrap();
        assert_eq!(
            merge(&c, "origin/main", "Merge").unwrap(),
            MergeRun::Conflicts
        );
        assert_eq!(
            fs::read_to_string(c.join("NOTES.md")).unwrap(),
            "an hour of notes\n"
        );
        abort_merge(&c).unwrap();
        assert_eq!(
            fs::read_to_string(c.join("NOTES.md")).unwrap(),
            "an hour of notes\n"
        );
        assert_eq!(fs::read_to_string(c.join("README.md")).unwrap(), "ours\n");
        assert!(abort_merge(&c)
            .unwrap_err()
            .starts_with("The merge was not aborted:"));
    }

    #[test]
    fn discard_takes_a_bracketed_path_literally() {
        let (_t, r) = repo();
        fs::create_dir_all(r.join("pages")).unwrap();
        for f in ["[id].tsx", "i.tsx", "d.tsx"] {
            fs::write(r.join("pages").join(f), format!("{f}\n")).unwrap();
        }
        sh(&r, &["add", "."]);
        sh(&r, &["commit", "-q", "-m", "pages"]);
        for f in ["[id].tsx", "i.tsx", "d.tsx"] {
            fs::write(r.join("pages").join(f), "edited\n").unwrap();
        }
        let repo = Repository::open(&r).unwrap();
        discard_paths(&repo, &["pages/[id].tsx".into()]).unwrap();
        assert_eq!(
            fs::read_to_string(r.join("pages/[id].tsx")).unwrap(),
            "[id].tsx\n"
        );
        assert_eq!(
            fs::read_to_string(r.join("pages/i.tsx")).unwrap(),
            "edited\n"
        );
        assert_eq!(
            fs::read_to_string(r.join("pages/d.tsx")).unwrap(),
            "edited\n"
        );
    }

    #[test]
    fn unstage_takes_a_bracketed_path_literally() {
        let (_t, r) = repo();
        fs::create_dir_all(r.join("pages")).unwrap();
        for f in ["[id].tsx", "i.tsx"] {
            fs::write(r.join("pages").join(f), "new\n").unwrap();
        }
        sh(&r, &["add", "."]);
        unstage_paths(&r, &["pages/[id].tsx".into()]).unwrap();
        let staged = sh(&r, &["diff", "--cached", "--name-only"]);
        assert_eq!(staged, "pages/i.tsx");
        unstage_paths(&r, &[".".into()]).unwrap();
        assert_eq!(sh(&r, &["diff", "--cached", "--name-only"]), "");
    }

    #[test]
    fn unstage_works_before_the_first_commit() {
        let t = TempDir::new().unwrap();
        let r = t.path().join("fresh");
        fs::create_dir_all(&r).unwrap();
        sh(&r, &["init", "-q", "-b", "main"]);
        fs::write(r.join("a.txt"), "a\n").unwrap();
        fs::write(r.join("b.txt"), "b\n").unwrap();
        sh(&r, &["add", "."]);
        unstage_paths(&r, &["a.txt".into()]).unwrap();
        assert_eq!(sh(&r, &["diff", "--cached", "--name-only"]), "b.txt");
    }

    #[test]
    fn deleting_a_branch_with_commits_no_other_branch_has_is_refused() {
        let (_t, r) = repo();
        sh(&r, &["branch", "merged"]);
        sh(&r, &["checkout", "-q", "-b", "hermes/old-task"]);
        fs::write(r.join("OLD.md"), "old\n").unwrap();
        sh(&r, &["add", "."]);
        sh(&r, &["commit", "-q", "-m", "old"]);
        sh(&r, &["checkout", "-q", "main"]);
        let repo = Repository::open(&r).unwrap();
        assert_eq!(unmerged_commits(&repo, "merged").unwrap(), None);
        let u = unmerged_commits(&repo, "hermes/old-task").unwrap().unwrap();
        assert_eq!(
            u,
            Unmerged {
                branch: "hermes/old-task".into(),
                base: "main".into(),
                commits: 1
            }
        );
        assert!(u.error().starts_with(BRANCH_UNMERGED_PREFIX));
        // Once main has it, it may go.
        sh(&r, &["merge", "-q", "--ff-only", "hermes/old-task"]);
        assert_eq!(unmerged_commits(&repo, "hermes/old-task").unwrap(), None);
    }

    #[cfg(unix)]
    fn hook(r: &Path, name: &str, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        let p = r.join(".git").join("hooks").join(name);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, body).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn commits_run_the_pre_commit_hook_and_a_refusal_says_what_it_printed() {
        let (_t, r) = repo();
        hook(
            &r,
            "pre-commit",
            "#!/bin/sh\necho 'lint: 2 problems in a.js' >&2\nexit 1\n",
        );
        fs::write(r.join("a.js"), "x\n").unwrap();
        sh(&r, &["add", "a.js"]);
        let before = sh(&r, &["rev-parse", "HEAD"]);
        let err = commit_staged(&r, "Add a.js", None).unwrap_err();
        let json = err.strip_prefix(HOOK_REFUSED_PREFIX).expect(&err);
        let v: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(v["hook"], "pre-commit");
        assert!(v["output"].as_str().unwrap().contains("lint: 2 problems"));
        assert_eq!(sh(&r, &["rev-parse", "HEAD"]), before);

        hook(&r, "pre-commit", "#!/bin/sh\nexit 0\n");
        hook(
            &r,
            "commit-msg",
            "#!/bin/sh\necho 'subject too long' >&2\nexit 1\n",
        );
        let err = commit_staged(&r, "Add a.js", None).unwrap_err();
        assert!(err.contains("\"hook\":\"commit-msg\""), "{err}");

        fs::remove_file(r.join(".git/hooks/commit-msg")).unwrap();
        let sha = commit_staged(
            &r,
            "Add a.js\n\nbody",
            Some(("Ann Example", "ann@example.com")),
        )
        .unwrap();
        assert_eq!(sh(&r, &["rev-parse", "HEAD"]), sha);
        assert_eq!(
            sh(&r, &["log", "-1", "--format=%an <%ae>|%s"]),
            "Ann Example <ann@example.com>|Add a.js"
        );
    }

    #[test]
    fn the_trace_names_the_last_hook_git_ran() {
        let trace = "12:00 trace: run_command: .git/hooks/pre-commit\n12:00 trace: run_command: '.git/hooks/commit-msg' .git/COMMIT_EDITMSG\n";
        assert_eq!(last_hook_in_trace(trace).as_deref(), Some("commit-msg"));
        assert_eq!(last_hook_in_trace("trace: run_command: git status"), None);
        assert_eq!(
            last_hook_in_trace("trace: run_command: /x/hooks/pre-commit-extra\ntrace: run_command: /x/hooks/pre-commit"),
            Some("pre-commit".into())
        );
    }

    #[test]
    fn a_detached_commit_on_no_branch_is_counted_and_can_be_saved() {
        let (_t, r) = repo();
        let st = head_state(&r).unwrap();
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert!(!st.detached);
        sh(&r, &["checkout", "-q", "--detach"]);
        assert_eq!(
            head_state(&r).unwrap().lost_commits,
            0,
            "HEAD is still on main"
        );
        fs::write(r.join("FIX.md"), "fix\n").unwrap();
        sh(&r, &["add", "."]);
        sh(&r, &["commit", "-q", "-m", "fix"]);
        let st = head_state(&r).unwrap();
        assert!(st.detached);
        assert_eq!(st.lost_commits, 1);
        let name = save_detached_head(&r, Some("hermes/bisect-build")).unwrap();
        assert_eq!(name, "hermes-archive/bisect-build-detached");
        assert_eq!(sh(&r, &["branch", "--show-current"]), name);
        assert_eq!(head_state(&r).unwrap().lost_commits, 0);
    }

    #[test]
    fn an_operation_in_progress_is_named() {
        let (t, origin) = repo();
        let c = clone_behind(&t, &origin, "README.md", "theirs\n");
        fs::write(c.join("README.md"), "ours\n").unwrap();
        sh(&c, &["commit", "-q", "-am", "ours"]);
        let _ = merge(&c, "origin/main", "Merge");
        assert_eq!(head_state(&c).unwrap().operation.as_deref(), Some("merge"));
    }

    /// A superproject with a submodule `vendor/lib`, and a linked worktree
    /// of it whose submodule is initialised in the worktree's own store.
    fn superproject_with_worktree() -> (TempDir, PathBuf, PathBuf) {
        let t = TempDir::new().unwrap();
        let lib = t.path().join("lib");
        fs::create_dir_all(&lib).unwrap();
        sh(&lib, &["init", "-q", "-b", "main"]);
        fs::write(lib.join("lib.txt"), "v1\n").unwrap();
        sh(&lib, &["add", "."]);
        sh(&lib, &["commit", "-q", "-m", "lib"]);
        let sup = t.path().join("sup");
        fs::create_dir_all(&sup).unwrap();
        sh(&sup, &["init", "-q", "-b", "main"]);
        fs::write(sup.join("README.md"), "sup\n").unwrap();
        sh(&sup, &["add", "."]);
        sh(&sup, &["commit", "-q", "-m", "init"]);
        sh(
            &sup,
            &[
                "submodule",
                "add",
                "-q",
                lib.to_str().unwrap(),
                "vendor/lib",
            ],
        );
        sh(&sup, &["commit", "-q", "-m", "vendor"]);
        let wt = t.path().join("wt");
        sh(
            &sup,
            &["worktree", "add", "-q", "-b", "task", wt.to_str().unwrap()],
        );
        sh(&wt, &["submodule", "update", "--init", "-q"]);
        (t, sup, wt)
    }

    #[test]
    fn a_submodule_commit_made_only_in_a_worktree_is_kept_before_it_goes() {
        let (_t, sup, wt) = superproject_with_worktree();
        let sub = wt.join("vendor/lib");
        fs::write(sub.join("lib.txt"), "v2\n").unwrap();
        sh(&sub, &["commit", "-q", "-am", "fix in lib"]);
        let sha = sh(&sub, &["rev-parse", "HEAD"]);
        let store = sup.join(".git/modules/vendor/lib");
        assert!(Repository::open(&store)
            .unwrap()
            .find_commit(Oid::from_str(&sha).unwrap())
            .is_err());
        let stranded = rescue_submodule_commits(&sup, &wt, "s-1");
        assert!(stranded.is_empty(), "{stranded:?}");
        let kept = Repository::open(&store).unwrap();
        assert!(kept.find_commit(Oid::from_str(&sha).unwrap()).is_ok());
        assert_eq!(
            sh(
                &store,
                &[
                    "for-each-ref",
                    "--format=%(refname)",
                    "refs/hermes/archive/"
                ]
            ),
            "refs/hermes/archive/s-1/vendor/lib/0"
        );
        // Nothing new: nothing to do the second time.
        assert!(rescue_submodule_commits(&sup, &wt, "s-1").is_empty());
    }

    #[test]
    fn uncommitted_edits_inside_a_submodule_are_reported() {
        let (_t, _sup, wt) = superproject_with_worktree();
        fs::write(wt.join("vendor/lib/lib.txt"), "dirty\n").unwrap();
        assert_eq!(
            head_state(&wt).unwrap().dirty_submodules,
            vec!["vendor/lib".to_string()]
        );
    }

    #[test]
    fn the_stranded_message_names_the_submodule_and_the_folder() {
        assert_eq!(
            stranded_message(
                &[StrandedModule {
                    path: "vendor/lib".into(),
                    commits: 1
                }],
                "/w/x"
            ),
            "vendor/lib has 1 commit that exists only in this task's worktree. Kept the worktree at /w/x."
        );
    }
}
