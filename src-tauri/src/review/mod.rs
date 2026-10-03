//! Review Desk (F21): the diff a person reviews, one turn's revert, and the
//! review file a terminal agent is asked to read.
//!
//! Everything here is plain git, the same for every agent:
//!
//! - [`review_diff`] is the diff from the merge-base with the default branch
//!   to the worktree, untracked files included. It goes through a private
//!   index file, so the repository's own index, HEAD and stash never move.
//! - [`review_revert_patch`] applies a turn's patch in reverse (`git apply -R`,
//!   falling back to `--3way`), after a preview with `--check`.
//! - [`review_write_file`] writes `review-<n>.md` under the app's data folder
//!   for a session; the one visible line the person pastes names it.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// The patch text handed to the frontend is capped; files past the cap keep
/// their header and counts but no hunks (`truncated`).
const PATCH_TEXT_CAP_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFile {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub is_binary: bool,
    /// The file is executable after the change (mode 100755).
    pub executable: bool,
    pub additions: u32,
    pub deletions: u32,
    /// This file's part of the unified diff, header included.
    pub patch: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDiff {
    /// The commit the diff starts from (the merge-base), full hash.
    pub base: String,
    /// What the base was taken against ("main", "origin/main", or "HEAD"
    /// when the worktree is on the default branch itself).
    pub base_ref: String,
    pub head: String,
    pub branch: Option<String>,
    pub files: Vec<ReviewFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertPreview {
    /// `git apply -R --check` passed: the revert touches only what the
    /// turn changed.
    pub clean: bool,
    /// What git said when it was not clean.
    pub message: String,
    pub files: Vec<ReviewFile>,
    /// The turn's changes are not in the worktree any more (applying the
    /// patch forward would work): it was reverted already, nothing to undo.
    #[serde(default)]
    pub already_reverted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertResult {
    pub ok: bool,
    /// "plain" (worktree only) or "3way" (git merged and staged the files).
    pub method: String,
    pub message: String,
}

fn git(repo: &Path, args: &[&str], env: &[(&str, &str)]) -> Result<String, String> {
    let mut cmd = crate::git::cli::git_command();
    cmd.current_dir(repo).args(args);
    for (k, v) in env {
        cmd.env(k, v);
    }
    // Never let a hook or a prompt hang the app.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd
        .output()
        .map_err(|e| format!("could not run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let msg = if err.is_empty() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            err
        };
        Err(if msg.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            msg
        })
    }
}

fn repo_root(path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    if !p.is_dir() {
        return Err(format!("not a folder: {path}"));
    }
    let top = git(p, &["rev-parse", "--show-toplevel"], &[])?;
    Ok(PathBuf::from(top.trim()))
}

fn rev_ok(repo: &Path, rev: &str) -> bool {
    git(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{rev}^{{commit}}"),
        ],
        &[],
    )
    .is_ok()
}

/// The base of the review: the merge-base of the default branch and HEAD.
/// On the default branch itself (or with none to be found) it is HEAD, so
/// the review shows the uncommitted work.
pub fn review_base(repo: &Path) -> Result<(String, String, String, Option<String>), String> {
    let head = match git(repo, &["rev-parse", "HEAD"], &[]) {
        Ok(h) => h.trim().to_string(),
        // An unborn branch: everything is new against the empty tree.
        Err(_) => {
            let empty = git(repo, &["hash-object", "-t", "tree", "/dev/null"], &[])
                .ok()
                .map(|s| s.trim().to_string())
                .unwrap_or_else(|| "4b825dc642cb6eb9a060e54bf8d69288fbee4904".to_string());
            return Ok((empty, "HEAD".to_string(), String::new(), None));
        }
    };
    let branch = git(repo, &["symbolic-ref", "--short", "-q", "HEAD"], &[])
        .ok()
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty());
    let mut candidates: Vec<String> = Vec::new();
    if let Ok(origin_head) = git(
        repo,
        &["symbolic-ref", "-q", "refs/remotes/origin/HEAD"],
        &[],
    ) {
        if let Some(short) = origin_head.trim().strip_prefix("refs/remotes/") {
            candidates.push(short.to_string());
        }
    }
    for c in ["main", "master", "origin/main", "origin/master", "develop"] {
        candidates.push(c.to_string());
    }
    for candidate in candidates {
        if branch.as_deref() == Some(candidate.as_str()) {
            continue;
        }
        if !rev_ok(repo, &candidate) {
            continue;
        }
        if let Ok(mb) = git(repo, &["merge-base", &candidate, "HEAD"], &[]) {
            let mb = mb.trim().to_string();
            if !mb.is_empty() {
                return Ok((mb, candidate, head, branch));
            }
        }
    }
    Ok((head.clone(), "HEAD".to_string(), head, branch))
}

/// The worktree (tracked and untracked, ignored files excluded) against
/// `base`, through a private index file. Returns the unified diff text.
pub fn worktree_patch(repo: &Path, base: &str) -> Result<String, String> {
    let dir = tempfile::Builder::new()
        .prefix("hermes-review-")
        .tempdir()
        .map_err(|e| format!("could not create a temporary folder: {e}"))?;
    let index = dir.path().join("index");
    let index_str = index.to_string_lossy().to_string();
    let env: [(&str, &str); 1] = [("GIT_INDEX_FILE", index_str.as_str())];
    // Start from HEAD's tree, then record every worktree path in the
    // private index as intent-to-add (`-N`): that lists new files without
    // hashing anything, so the diff below, which compares the base tree to
    // the worktree itself, writes no objects into the repository and leaves
    // its real index alone. Additions, edits, deletions and renames all
    // show; ignored files never do.
    if git(repo, &["rev-parse", "--verify", "--quiet", "HEAD"], &[]).is_ok() {
        git(repo, &["read-tree", "HEAD"], &env)?;
    }
    git(repo, &["add", "-N", "-A", "--", "."], &env)?;
    git(
        repo,
        &[
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--find-renames",
            "--patch",
            base,
            "--",
        ],
        &env,
    )
}

fn count_lines(hunks: &str) -> (u32, u32) {
    let mut add = 0;
    let mut del = 0;
    for line in hunks.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if line.starts_with('+') {
            add += 1;
        } else if line.starts_with('-') {
            del += 1;
        }
    }
    (add, del)
}

fn unquote_path(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        // git quotes unusual paths in C style; unescape the common cases.
        let inner = &trimmed[1..trimmed.len() - 1];
        let mut out = String::new();
        let mut chars = inner.chars();
        while let Some(c) = chars.next() {
            if c == '\\' {
                match chars.next() {
                    Some('n') => out.push('\n'),
                    Some('t') => out.push('\t'),
                    Some('"') => out.push('"'),
                    Some('\\') => out.push('\\'),
                    Some(other) => {
                        out.push('\\');
                        out.push(other);
                    }
                    None => out.push('\\'),
                }
            } else {
                out.push(c);
            }
        }
        out
    } else {
        trimmed.to_string()
    }
}

/// Split a unified diff into files. Pure, so it is table-tested.
pub fn parse_patch(text: &str) -> Vec<ReviewFile> {
    let mut files = Vec::new();
    let mut total = 0usize;
    let mut starts: Vec<usize> = Vec::new();
    let mut pos = 0usize;
    for line in text.split_inclusive('\n') {
        if line.starts_with("diff --git ") {
            starts.push(pos);
        }
        pos += line.len();
    }
    for (i, &start) in starts.iter().enumerate() {
        let end = starts.get(i + 1).copied().unwrap_or(text.len());
        let chunk = &text[start..end];
        let mut lines = chunk.lines();
        let header = lines.next().unwrap_or_default();
        let mut path: Option<String> = None;
        let mut old_path: Option<String> = None;
        let mut status = FileStatus::Modified;
        let mut is_binary = false;
        let mut executable = false;
        let mut hunk_start: Option<usize> = None;
        let mut offset = header.len() + 1;
        for line in lines {
            if line.starts_with("@@") {
                hunk_start = Some(offset);
                break;
            }
            if let Some(rest) = line.strip_prefix("new file mode ") {
                status = FileStatus::Added;
                executable = rest.trim() == "100755";
            } else if line.starts_with("deleted file mode ") {
                status = FileStatus::Deleted;
            } else if let Some(rest) = line.strip_prefix("new mode ") {
                executable = rest.trim() == "100755";
            } else if let Some(from) = line.strip_prefix("rename from ") {
                status = FileStatus::Renamed;
                old_path = Some(unquote_path(from));
            } else if let Some(to) = line.strip_prefix("rename to ") {
                path = Some(unquote_path(to));
            } else if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
                is_binary = true;
            } else if let Some(p) = line.strip_prefix("+++ ") {
                let p = unquote_path(p);
                if p != "/dev/null" {
                    path = Some(p.strip_prefix("b/").unwrap_or(&p).to_string());
                }
            } else if let Some(p) = line.strip_prefix("--- ") {
                let p = unquote_path(p);
                if p != "/dev/null" {
                    let stripped = p.strip_prefix("a/").unwrap_or(&p).to_string();
                    if path.is_none() {
                        path = Some(stripped.clone());
                    }
                    if status == FileStatus::Deleted {
                        path = Some(stripped);
                    }
                }
            }
            offset += line.len() + 1;
        }
        let path = path.unwrap_or_else(|| {
            // "diff --git a/x b/x" is all there is for a binary or a mode-only change.
            let rest = header.trim_start_matches("diff --git ");
            let b = rest.rfind(" b/").map(|i| &rest[i + 3..]).unwrap_or(rest);
            unquote_path(b)
        });
        let hunks = hunk_start.map(|h| &chunk[h..]).unwrap_or("");
        let (additions, deletions) = count_lines(hunks);
        let truncated = total + chunk.len() > PATCH_TEXT_CAP_BYTES;
        let patch = if truncated {
            chunk[..hunk_start.unwrap_or(chunk.len())].to_string()
        } else {
            chunk.to_string()
        };
        total += patch.len();
        files.push(ReviewFile {
            path,
            old_path,
            status,
            is_binary,
            executable,
            additions,
            deletions,
            patch,
            truncated,
        });
    }
    files
}

/// The diff the Review Desk shows for a worktree: merge-base to worktree,
/// untracked files included, the repository's own index untouched.
#[tauri::command]
pub fn review_diff(path: String) -> Result<ReviewDiff, String> {
    let repo = repo_root(&path)?;
    let (base, base_ref, head, branch) = review_base(&repo)?;
    let patch = worktree_patch(&repo, &base)?;
    Ok(ReviewDiff {
        base,
        base_ref,
        head,
        branch,
        files: parse_patch(&patch),
    })
}

fn write_patch_file(patch: &str) -> Result<(tempfile::TempDir, PathBuf), String> {
    let dir = tempfile::Builder::new()
        .prefix("hermes-revert-")
        .tempdir()
        .map_err(|e| format!("could not create a temporary folder: {e}"))?;
    let file = dir.path().join("turn.patch");
    let mut text = patch.to_string();
    if !text.ends_with('\n') {
        text.push('\n');
    }
    std::fs::write(&file, text).map_err(|e| format!("could not write the patch: {e}"))?;
    Ok((dir, file))
}

/// What reverting a turn would do: whether `git apply -R --check` passes,
/// and the files the patch touches.
#[tauri::command]
pub fn review_revert_preview(path: String, patch: String) -> Result<RevertPreview, String> {
    let repo = repo_root(&path)?;
    let files = parse_patch(&patch);
    if files.is_empty() {
        return Ok(RevertPreview {
            clean: false,
            message: "this turn changed nothing that can be reverted".to_string(),
            files,
            already_reverted: false,
        });
    }
    let (_dir, file) = write_patch_file(&patch)?;
    let file_str = file.to_string_lossy().to_string();
    match git(&repo, &["apply", "-R", "--check", &file_str], &[]) {
        Ok(_) => Ok(RevertPreview {
            clean: true,
            message: String::new(),
            files,
            already_reverted: false,
        }),
        Err(message) => {
            // Not reversible, but the patch applies forward: the turn's
            // changes are gone already (reverted before), not in conflict.
            let already_reverted = git(&repo, &["apply", "--check", &file_str], &[]).is_ok();
            Ok(RevertPreview {
                clean: false,
                message,
                files,
                already_reverted,
            })
        }
    }
}

/// Revert one turn: `git apply -R`, and when the files moved on since,
/// `git apply -R --3way` (git then merges and stages what it could, leaving
/// conflict markers where it could not).
#[tauri::command]
pub fn review_revert_patch(path: String, patch: String) -> Result<RevertResult, String> {
    let repo = repo_root(&path)?;
    if parse_patch(&patch).is_empty() {
        return Ok(RevertResult {
            ok: false,
            method: "none".to_string(),
            message: "this turn changed nothing that can be reverted".to_string(),
        });
    }
    let (_dir, file) = write_patch_file(&patch)?;
    let file_str = file.to_string_lossy().to_string();
    match git(&repo, &["apply", "-R", &file_str], &[]) {
        Ok(_) => Ok(RevertResult {
            ok: true,
            method: "plain".to_string(),
            message: String::new(),
        }),
        // Reverted already: a three-way merge would only leave markers.
        Err(_) if git(&repo, &["apply", "--check", &file_str], &[]).is_ok() => Ok(RevertResult {
            ok: false,
            method: "already".to_string(),
            message: "this turn is already reverted".to_string(),
        }),
        Err(plain) => match git(&repo, &["apply", "-R", "--3way", &file_str], &[]) {
            Ok(_) => Ok(RevertResult {
                ok: true,
                method: "3way".to_string(),
                message: plain,
            }),
            Err(three) => Ok(RevertResult {
                ok: false,
                method: "3way".to_string(),
                message: three,
            }),
        },
    }
}

/// Where a session's review files live: `<app data>/reviews/<session>/`.
pub fn reviews_dir<R: tauri::Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
) -> Result<PathBuf, String> {
    if !crate::contract::turns::is_turn_ref_session_id(session_id) {
        return Err(format!("not a session id: {session_id:?}"));
    }
    Ok(crate::instance::app_data_dir(app)?
        .join("reviews")
        .join(session_id))
}

/// Write `review-<n>.md` for a session and return its absolute path.
#[tauri::command]
pub fn review_write_file(
    app: AppHandle,
    session_id: String,
    n: u32,
    content: String,
) -> Result<String, String> {
    if n == 0 {
        return Err("a review number starts at 1".to_string());
    }
    let dir = reviews_dir(&app, &session_id)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let file = dir.join(format!("review-{n}.md"));
    std::fs::write(&file, content)
        .map_err(|e| format!("could not write {}: {e}", file.display()))?;
    Ok(file.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    fn run(repo: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(repo)
            .args(args)
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.com")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.com")
            .output()
            .expect("git runs");
        assert!(
            out.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// A repository on branch `hermes/task` off `main`, with one base commit.
    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        run(&repo, &["init", "-q", "-b", "main"]);
        // Windows runners check files out with CRLF by default; the tests
        // compare exact file text.
        run(&repo, &["config", "core.autocrlf", "false"]);
        run(&repo, &["config", "user.name", "Test"]);
        run(&repo, &["config", "user.email", "test@example.com"]);
        fs::create_dir_all(repo.join("src")).unwrap();
        fs::write(
            repo.join("src/app.js"),
            "const a = 1;\nconst b = 2;\nexport default a + b;\n",
        )
        .unwrap();
        fs::write(repo.join("README.md"), "# fixture\n").unwrap();
        fs::write(
            repo.join("package-lock.json"),
            "{\n  \"name\": \"fixture\"\n}\n",
        )
        .unwrap();
        fs::write(
            repo.join("package.json"),
            "{\n  \"name\": \"fixture\",\n  \"version\": \"1.0.0\",\n  \"private\": true\n}\n",
        )
        .unwrap();
        run(&repo, &["add", "-A"]);
        run(&repo, &["commit", "-q", "-m", "base"]);
        run(&repo, &["checkout", "-q", "-b", "hermes/task"]);
        (dir, repo)
    }

    #[test]
    fn the_diff_runs_from_the_merge_base_and_includes_untracked_files_without_touching_the_index() {
        let (_dir, repo) = fixture();
        // A commit on the task branch, an unstaged edit, a new file, a deletion.
        fs::write(
            repo.join("src/app.js"),
            "const a = 1;\nconst b = 3;\nexport default a + b;\n",
        )
        .unwrap();
        run(&repo, &["commit", "-q", "-am", "turn 1"]);
        fs::write(repo.join("src/util.js"), "export const x = 1;\n").unwrap();
        fs::remove_file(repo.join("README.md")).unwrap();
        fs::write(
            repo.join("package-lock.json"),
            "{\n  \"name\": \"fixture\",\n  \"x\": 1\n}\n",
        )
        .unwrap();
        // Renamed without staging: git sees a deletion plus a new file
        // until rename detection pairs them.
        fs::rename(repo.join("package.json"), repo.join("package.renamed.json")).unwrap();
        // A file that only ever existed on the branch and is gone again
        // is not part of the review.
        fs::write(repo.join("scratch.txt"), "tmp\n").unwrap();
        run(&repo, &["add", "scratch.txt"]);
        run(&repo, &["commit", "-q", "-m", "scratch"]);
        run(&repo, &["rm", "-q", "scratch.txt"]);
        run(&repo, &["commit", "-q", "-m", "drop scratch"]);
        let index_before = run(&repo, &["diff", "--cached", "--name-only"]);
        let status_before = run(&repo, &["status", "--porcelain"]);
        let objects_before = object_files(&repo);

        let diff = review_diff(repo.to_string_lossy().to_string()).unwrap();
        assert_eq!(diff.base_ref, "main");
        assert_eq!(diff.branch.as_deref(), Some("hermes/task"));
        assert_eq!(diff.base, run(&repo, &["rev-parse", "main"]).trim());
        let mut paths: Vec<(String, FileStatus)> = diff
            .files
            .iter()
            .map(|f| (f.path.clone(), f.status))
            .collect();
        paths.sort();
        assert_eq!(
            paths,
            vec![
                ("README.md".to_string(), FileStatus::Deleted),
                ("package-lock.json".to_string(), FileStatus::Modified),
                ("package.renamed.json".to_string(), FileStatus::Renamed),
                ("src/app.js".to_string(), FileStatus::Modified),
                ("src/util.js".to_string(), FileStatus::Added),
            ]
        );
        let renamed = diff
            .files
            .iter()
            .find(|f| f.path == "package.renamed.json")
            .unwrap();
        assert_eq!(renamed.old_path.as_deref(), Some("package.json"));
        let app = diff.files.iter().find(|f| f.path == "src/app.js").unwrap();
        assert_eq!((app.additions, app.deletions), (1, 1));
        assert!(app.patch.contains("-const b = 2;") && app.patch.contains("+const b = 3;"));
        let util = diff.files.iter().find(|f| f.path == "src/util.js").unwrap();
        assert_eq!((util.additions, util.deletions), (1, 0));
        // The repository's own index and status are exactly as before.
        assert_eq!(
            run(&repo, &["diff", "--cached", "--name-only"]),
            index_before
        );
        assert_eq!(run(&repo, &["status", "--porcelain"]), status_before);
        assert!(
            status_before.contains("?? src/util.js"),
            "the new file is still untracked"
        );
        // Reading the diff writes none of the person's content into the
        // repository: no blob for the new or edited files lands in
        // .git/objects. The one object intent-to-add may create is the
        // well-known empty blob (e69de29…), which carries nothing.
        let new_objects: Vec<String> = object_files(&repo)
            .into_iter()
            .filter(|o| !objects_before.contains(o))
            .collect();
        assert!(
            new_objects.iter().all(|o| o
                .replace('\\', "/")
                .ends_with("e6/9de29bb2d1d6434b8b29ae775ad8c2e48c5391")),
            "only the empty blob may appear: {new_objects:?}"
        );
    }

    /// Every loose object and pack file under .git/objects, sorted.
    fn object_files(repo: &Path) -> Vec<String> {
        fn walk(dir: &Path, out: &mut Vec<String>) {
            if let Ok(entries) = fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.is_dir() {
                        walk(&p, out);
                    } else {
                        out.push(p.to_string_lossy().to_string());
                    }
                }
            }
        }
        let mut out = Vec::new();
        walk(&repo.join(".git/objects"), &mut out);
        out.sort();
        out
    }

    #[test]
    fn on_the_default_branch_the_review_shows_the_uncommitted_work() {
        let (_dir, repo) = fixture();
        run(&repo, &["checkout", "-q", "main"]);
        fs::write(repo.join("README.md"), "# fixture\nmore\n").unwrap();
        let diff = review_diff(repo.to_string_lossy().to_string()).unwrap();
        assert_eq!(diff.base_ref, "HEAD");
        assert_eq!(diff.files.len(), 1);
        assert_eq!(diff.files[0].path, "README.md");
    }

    #[test]
    fn a_clean_tree_has_no_files_and_a_non_repo_is_refused() {
        let (_dir, repo) = fixture();
        let diff = review_diff(repo.to_string_lossy().to_string()).unwrap();
        assert!(diff.files.is_empty());
        let other = tempfile::tempdir().unwrap();
        assert!(review_diff(other.path().to_string_lossy().to_string()).is_err());
        assert!(review_diff("/definitely/not/here".to_string()).is_err());
    }

    #[test]
    fn reverting_one_turn_leaves_the_other_turn_intact() {
        let (_dir, repo) = fixture();
        // Turn 1 edits app.js; its patch is what the ledger would hold.
        fs::write(
            repo.join("src/app.js"),
            "const a = 1;\nconst b = 3;\nexport default a + b;\n",
        )
        .unwrap();
        let turn1 = run(&repo, &["diff"]);
        // Turn 2 adds util.js and edits the lockfile.
        fs::write(repo.join("src/util.js"), "export const x = 1;\n").unwrap();
        run(&repo, &["add", "-N", "src/util.js"]);
        fs::write(
            repo.join("package-lock.json"),
            "{\n  \"name\": \"fixture\",\n  \"x\": 1\n}\n",
        )
        .unwrap();
        let turn2 = {
            let all = run(&repo, &["diff"]);
            // Only turn 2's files.
            parse_patch(&all)
                .into_iter()
                .filter(|f| f.path != "src/app.js")
                .map(|f| f.patch)
                .collect::<String>()
        };
        run(&repo, &["reset", "-q", "src/util.js"]);

        let preview =
            review_revert_preview(repo.to_string_lossy().to_string(), turn2.clone()).unwrap();
        assert!(preview.clean, "{}", preview.message);
        let mut touched: Vec<String> = preview.files.iter().map(|f| f.path.clone()).collect();
        touched.sort();
        assert_eq!(touched, vec!["package-lock.json", "src/util.js"]);

        let result =
            review_revert_patch(repo.to_string_lossy().to_string(), turn2.clone()).unwrap();
        assert!(result.ok, "{}", result.message);
        assert_eq!(result.method, "plain");
        assert!(
            !repo.join("src/util.js").exists(),
            "turn 2's new file is gone"
        );
        assert_eq!(
            fs::read_to_string(repo.join("package-lock.json")).unwrap(),
            "{\n  \"name\": \"fixture\"\n}\n"
        );
        assert_eq!(
            fs::read_to_string(repo.join("src/app.js")).unwrap(),
            "const a = 1;\nconst b = 3;\nexport default a + b;\n",
            "turn 1 is intact"
        );
        // Reverting the same turn again is not clean and does nothing.
        let again =
            review_revert_preview(repo.to_string_lossy().to_string(), turn2.clone()).unwrap();
        assert!(!again.clean);
        assert!(!again.message.is_empty());
        // ...because it was reverted already, which the preview says.
        assert!(again.already_reverted);
        assert!(!preview.already_reverted);
        let result =
            review_revert_patch(repo.to_string_lossy().to_string(), turn2.clone()).unwrap();
        assert!(!result.ok);
        assert_eq!(result.method, "already");
        assert!(!repo.join("src/util.js").exists(), "nothing came back");
        // A turn whose lines a later edit changed is in conflict, not reverted.
        fs::write(repo.join("src/app.js"), "const a = 9;\nexport default a;\n").unwrap();
        let conflict =
            review_revert_preview(repo.to_string_lossy().to_string(), turn1.clone()).unwrap();
        assert!(!conflict.clean && !conflict.already_reverted);
        // ...and reverting it goes to the three-way merge, never "already".
        let result =
            review_revert_patch(repo.to_string_lossy().to_string(), turn1.clone()).unwrap();
        assert_eq!(result.method, "3way", "{}", result.message);
    }

    #[test]
    fn an_empty_patch_reverts_nothing() {
        let (_dir, repo) = fixture();
        let preview =
            review_revert_preview(repo.to_string_lossy().to_string(), String::new()).unwrap();
        assert!(!preview.clean && preview.files.is_empty());
        let result =
            review_revert_patch(repo.to_string_lossy().to_string(), String::new()).unwrap();
        assert!(!result.ok);
    }

    #[test]
    fn parse_patch_reads_status_counts_binaries_and_renames() {
        let text = "diff --git a/src/a.js b/src/a.js\nindex 1..2 100644\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1,2 +1,2 @@\n-old\n+new\n context\n\
diff --git a/new.txt b/new.txt\nnew file mode 100755\nindex 0..3\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n\
diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\nindex 4..0\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n\
diff --git a/old-name.txt b/new-name.txt\nsimilarity index 100%\nrename from old-name.txt\nrename to new-name.txt\n\
diff --git a/tool.bin b/tool.bin\nnew file mode 100644\nindex 0..5\nBinary files /dev/null and b/tool.bin differ\n";
        let files = parse_patch(text);
        assert_eq!(files.len(), 5);
        assert_eq!(files[0].path, "src/a.js");
        assert_eq!(files[0].status, FileStatus::Modified);
        assert_eq!((files[0].additions, files[0].deletions), (1, 1));
        assert!(files[0].patch.starts_with("diff --git a/src/a.js"));
        assert_eq!(files[1].path, "new.txt");
        assert_eq!(files[1].status, FileStatus::Added);
        assert!(files[1].executable);
        assert_eq!(files[2].path, "gone.txt");
        assert_eq!(files[2].status, FileStatus::Deleted);
        assert_eq!(files[3].path, "new-name.txt");
        assert_eq!(files[3].old_path.as_deref(), Some("old-name.txt"));
        assert_eq!(files[3].status, FileStatus::Renamed);
        assert_eq!(files[4].path, "tool.bin");
        assert!(files[4].is_binary && files[4].status == FileStatus::Added);
        assert!(files.iter().all(|f| !f.truncated));
        assert!(parse_patch("").is_empty());
    }

    #[test]
    fn quoted_paths_are_unquoted() {
        assert_eq!(unquote_path("\"a b/\\\"c\\\".txt\""), "a b/\"c\".txt");
        assert_eq!(unquote_path("plain.txt"), "plain.txt");
    }

    #[test]
    fn only_a_path_quoted_on_both_ends_is_unquoted() {
        assert_eq!(unquote_path("\"half.txt"), "\"half.txt");
        assert_eq!(unquote_path("half.txt\""), "half.txt\"");
        assert_eq!(unquote_path("\""), "\"");
        assert_eq!(
            unquote_path("\"tab\\there\\\\x\\qy\\\""),
            "tab\there\\x\\qy\\"
        );
    }

    #[test]
    fn file_headers_are_not_counted_as_changed_lines() {
        let text = "--- a/x.txt\n+++ b/x.txt\n@@ -1,2 +1,2 @@\n-old\n+new\n+more\n context\n";
        assert_eq!(count_lines(text), (2, 1));
    }

    #[test]
    fn a_mode_change_says_whether_the_file_is_now_executable() {
        let text = "diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n\
diff --git a/lib.sh b/lib.sh\nold mode 100755\nnew mode 100644\n";
        let files = parse_patch(text);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "run.sh");
        assert!(files[0].executable, "100644 -> 100755 is executable");
        assert_eq!(files[1].path, "lib.sh");
        assert!(!files[1].executable, "100755 -> 100644 is not");
    }

    #[test]
    fn a_deleted_file_is_named_by_its_old_side_even_with_a_space_before_b() {
        // git does not quote spaces, so the header alone ("a/dir b/f.txt
        // b/dir b/f.txt") cannot be split; the "---" line names the file.
        let text = "diff --git a/dir b/f.txt b/dir b/f.txt\ndeleted file mode 100644\nindex 4..0\n--- a/dir b/f.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n";
        let files = parse_patch(text);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "dir b/f.txt");
        assert_eq!(files[0].status, FileStatus::Deleted);
        assert_eq!((files[0].additions, files[0].deletions), (0, 1));
    }

    /// One file's diff, `len` bytes long exactly (filler lines are added).
    fn file_diff(name: &str, len: usize) -> String {
        let head = format!(
            "diff --git a/{name} b/{name}\nindex 1..2 100644\n--- a/{name}\n+++ b/{name}\n@@ -1 +1 @@\n-old\n"
        );
        assert!(len > head.len() + 2, "{len} is too short for a diff");
        let mut body = String::new();
        let mut left = len - head.len();
        while left > 0 {
            // "+" and "\n" around each line; the last line takes the rest.
            let line = if left > 1002 { 1000 } else { left - 2 };
            body.push('+');
            body.push_str(&"x".repeat(line));
            body.push('\n');
            left -= line + 2;
        }
        let text = head + &body;
        assert_eq!(text.len(), len);
        text
    }

    fn header_of(diff: &str) -> &str {
        &diff[..diff.find("@@").unwrap()]
    }

    #[test]
    fn a_file_past_the_patch_cap_keeps_its_header_and_counts_but_no_hunks() {
        let cap = PATCH_TEXT_CAP_BYTES;
        // Exactly at the cap: kept whole.
        let at_cap = file_diff("big.txt", cap);
        let files = parse_patch(&at_cap);
        assert!(!files[0].truncated, "a file of exactly the cap is kept");
        assert_eq!(files[0].patch, at_cap);
        // One byte over: only the header is kept, the counts are still real.
        let over = file_diff("big.txt", cap + 1);
        let files = parse_patch(&over);
        assert!(files[0].truncated);
        assert_eq!(files[0].patch, header_of(&over));
        let added = over.lines().filter(|l| l.starts_with("+x")).count() as u32;
        assert_eq!((files[0].additions, files[0].deletions), (added, 1));
    }

    #[test]
    fn the_cap_counts_the_files_before_this_one() {
        let small = file_diff("small.txt", 200);
        // Fits by itself, not after the small file.
        let second = file_diff("second.txt", PATCH_TEXT_CAP_BYTES - 100);
        let third = file_diff("third.txt", 150);
        let text = format!("{small}{second}{third}");
        let files = parse_patch(&text);
        assert_eq!(files.len(), 3);
        assert!(!files[0].truncated);
        assert_eq!(files[0].patch, small);
        assert!(files[1].truncated, "200 + (cap - 100) is past the cap");
        assert_eq!(files[1].patch, header_of(&second));
        // What the truncated file kept (its header) counts, so the third
        // file still fits.
        assert!(!files[2].truncated);
        assert_eq!(files[2].patch, third);
    }

    #[test]
    fn a_patch_without_its_last_newline_still_reverts() {
        let (_dir, repo) = fixture();
        fs::write(
            repo.join("src/app.js"),
            "const a = 1;\nconst b = 3;\nexport default a + b;\n",
        )
        .unwrap();
        let patch = run(&repo, &["diff"]);
        let trimmed = patch.trim_end_matches('\n').to_string();
        let preview =
            review_revert_preview(repo.to_string_lossy().to_string(), trimmed.clone()).unwrap();
        assert!(preview.clean, "{}", preview.message);
        let result = review_revert_patch(repo.to_string_lossy().to_string(), trimmed).unwrap();
        assert!(result.ok, "{}", result.message);
        assert_eq!(
            fs::read_to_string(repo.join("src/app.js")).unwrap(),
            "const a = 1;\nconst b = 2;\nexport default a + b;\n"
        );
    }
}
