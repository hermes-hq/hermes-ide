//! `hi land`: keep the track files out of the merge.
//!
//! The feature folder is archived as a root commit under
//! `refs/hermes/archive/<slug>` (so `git show refs/hermes/archive/<slug>:.hermes/features/<slug>/plan.md`
//! still works after the merge), removed from the branch in one commit of its
//! own when it was tracked, and deleted from the worktree. The pull request
//! body is built from feature.md and plan.md.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::feature::{FeatureDir, TrackError};
use crate::ARCHIVE_REF_PREFIX;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LandOutcome {
    pub archive_ref: String,
    pub archived_commit: String,
    /// The commit that removed the tracked files from the branch, if any.
    pub removal_commit: Option<String>,
    pub pr_title: String,
    pub pr_body: String,
}

fn git(root: &Path, args: &[&str], envs: &[(&str, &str)]) -> Result<String, TrackError> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(root).args(args);
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let out = cmd
        .output()
        .map_err(|e| TrackError::Git(format!("cannot run git: {e}")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(TrackError::Git(format!(
            "git {} failed: {stderr}",
            args.join(" ")
        )));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// git needs a committer; a worktree without one gets a neutral identity for
/// these two commits only.
fn identity_env(root: &Path) -> Vec<(&'static str, &'static str)> {
    let has = git(root, &["config", "user.email"], &[])
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    if has {
        Vec::new()
    } else {
        vec![
            ("GIT_AUTHOR_NAME", "Hermes"),
            ("GIT_AUTHOR_EMAIL", "hermes@localhost"),
            ("GIT_COMMITTER_NAME", "Hermes"),
            ("GIT_COMMITTER_EMAIL", "hermes@localhost"),
        ]
    }
}

/// The pull request text: the feature's title, its description and the plan.
pub fn pr_text(feature: &FeatureDir) -> Result<(String, String), TrackError> {
    let loaded = feature.load()?;
    let body = loaded.body.trim();
    let title = body
        .lines()
        .find_map(|l| l.strip_prefix("# "))
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| feature.slug.clone());
    let description: String = body
        .lines()
        .skip_while(|l| l.starts_with("# ") || l.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let mut text = String::new();
    if !description.trim().is_empty() {
        text.push_str(description.trim());
        text.push_str("\n\n");
    }
    if let Some(plan_path) = feature.phase_file(crate::phases::Phase::Plan) {
        if let Ok(plan) = fs::read_to_string(&plan_path) {
            let plan = plan.trim();
            let plan_body: Vec<&str> = plan
                .lines()
                .skip_while(|l| l.starts_with("# ") || l.trim().is_empty())
                .collect();
            if !plan_body.is_empty() {
                text.push_str("## Plan\n\n");
                text.push_str(&plan_body.join("\n"));
                text.push_str("\n\n");
            }
        }
    }
    text.push_str(&format!(
        "Track: {} · phase: {} · files archived at {ARCHIVE_REF_PREFIX}{}\n",
        loaded.meta.track.as_str(),
        loaded.meta.phase.as_str(),
        feature.slug
    ));
    Ok((title, text))
}

/// Archive, strip and describe. `root` must be inside a git worktree.
pub fn land(root: &Path, slug: &str) -> Result<LandOutcome, TrackError> {
    let feature = FeatureDir::new(root, slug);
    let (pr_title, pr_body) = pr_text(&feature)?;
    let top = git(root, &["rev-parse", "--show-toplevel"], &[])?;
    let top = PathBuf::from(top);
    let rel = feature
        .dir()
        .strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| feature.relative_dir());
    let ident = identity_env(&top);

    // 1. Archive: a root commit holding only the track files, built through
    //    a private index so the user's index is never touched.
    let tmp_index = std::env::temp_dir().join(format!(
        "hermes-track-{}-{}.index",
        slug,
        std::process::id()
    ));
    let _ = fs::remove_file(&tmp_index);
    let index_env = tmp_index.to_string_lossy().to_string();
    let mut envs: Vec<(&str, &str)> = ident.clone();
    envs.push(("GIT_INDEX_FILE", index_env.as_str()));
    let added = git(root, &["add", "-f", "--", &rel], &envs);
    let tree = added.and_then(|_| git(root, &["write-tree"], &envs));
    let archived_commit = tree.and_then(|tree| {
        git(
            root,
            &[
                "commit-tree",
                &tree,
                "-m",
                &format!("hermes: track files of {slug} (archived at land)"),
            ],
            &envs,
        )
    });
    let _ = fs::remove_file(&tmp_index);
    let archived_commit = archived_commit?;
    let archive_ref = format!("{ARCHIVE_REF_PREFIX}{slug}");
    git(root, &["update-ref", &archive_ref, &archived_commit], &[])?;

    // 2. Strip: the folder leaves the worktree (it is safe in the archive)
    //    and, when the branch tracked it, one commit records just that
    //    deletion (`--only` those paths; other staged work stays staged).
    let tracked = git(root, &["ls-files", "--", &rel], &[])?;
    let dir = feature.dir();
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| TrackError::Io {
            path: dir.clone(),
            message: e.to_string(),
        })?;
    }
    let removal_commit = if tracked.is_empty() {
        None
    } else {
        git(
            root,
            &[
                "commit",
                "-q",
                "-m",
                &format!("Land {slug}: keep the track files out of the merge"),
                "--only",
                "--",
                &rel,
            ],
            &ident,
        )?;
        Some(git(root, &["rev-parse", "HEAD"], &[])?)
    };
    Ok(LandOutcome {
        archive_ref,
        archived_commit,
        removal_commit,
        pr_title,
        pr_body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::phases::Track;

    fn init_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q", "-b", "main"], &[]).unwrap();
        git(root, &["config", "user.email", "test@example.com"], &[]).unwrap();
        git(root, &["config", "user.name", "Test"], &[]).unwrap();
        fs::write(root.join("README.md"), "# demo\n").unwrap();
        git(root, &["add", "README.md"], &[]).unwrap();
        git(root, &["commit", "-q", "-m", "init"], &[]).unwrap();
        dir
    }

    #[test]
    fn land_archives_the_track_files_removes_them_from_the_branch_and_writes_the_pr_body() {
        let dir = init_repo();
        let root = dir.path();
        crate::feature::create(
            root,
            "demo",
            Track::Light,
            "Demo search",
            "Find things fast.\nSecond line.",
        )
        .unwrap();
        fs::write(
            root.join(".hermes/features/demo/plan.md"),
            "# Plan\n\n- [x] index\n- [x] query\n",
        )
        .unwrap();
        git(root, &["add", "-A"], &[]).unwrap();
        git(root, &["commit", "-q", "-m", "track files"], &[]).unwrap();
        fs::write(root.join("src.txt"), "code\n").unwrap();
        git(root, &["add", "src.txt"], &[]).unwrap(); // staged, unrelated: must stay staged
        let head_before = git(root, &["rev-parse", "HEAD"], &[]).unwrap();

        let out = land(root, "demo").unwrap();
        assert_eq!(out.archive_ref, "refs/hermes/archive/demo");
        let archived = git(
            root,
            &[
                "show",
                "refs/hermes/archive/demo:.hermes/features/demo/plan.md",
            ],
            &[],
        )
        .unwrap();
        assert!(archived.contains("- [x] query"));
        let archived_files = git(
            root,
            &["ls-tree", "-r", "--name-only", "refs/hermes/archive/demo"],
            &[],
        )
        .unwrap();
        assert!(
            !archived_files.contains("README.md"),
            "the archive holds only the track files: {archived_files}"
        );
        assert!(
            !root.join(".hermes/features/demo").exists(),
            "the folder is gone from the worktree"
        );
        let head = git(root, &["rev-parse", "HEAD"], &[]).unwrap();
        assert_ne!(head, head_before);
        assert_eq!(out.removal_commit.as_deref(), Some(head.as_str()));
        let in_head = git(root, &["ls-tree", "-r", "--name-only", "HEAD"], &[]).unwrap();
        assert!(
            !in_head.contains(".hermes/features"),
            "HEAD no longer tracks the files: {in_head}"
        );
        assert!(in_head.contains("README.md"));
        let staged = git(root, &["diff", "--cached", "--name-only"], &[]).unwrap();
        assert_eq!(staged, "src.txt", "unrelated staged work is still staged");
        assert_eq!(out.pr_title, "Demo search");
        assert!(
            out.pr_body.starts_with(
                "Find things fast.\nSecond line.\n\n## Plan\n\n- [x] index\n- [x] query"
            ),
            "{}",
            out.pr_body
        );
        assert!(out
            .pr_body
            .contains("files archived at refs/hermes/archive/demo"));
    }

    #[test]
    fn untracked_track_files_are_archived_and_deleted_without_a_commit() {
        let dir = init_repo();
        let root = dir.path();
        crate::feature::create(root, "quiet", Track::Light, "", "").unwrap();
        let head_before = git(root, &["rev-parse", "HEAD"], &[]).unwrap();
        let out = land(root, "quiet").unwrap();
        assert!(out.removal_commit.is_none());
        assert_eq!(git(root, &["rev-parse", "HEAD"], &[]).unwrap(), head_before);
        assert!(git(root, &["rev-parse", "refs/hermes/archive/quiet"], &[]).is_ok());
        assert!(!root.join(".hermes/features/quiet").exists());
        assert_eq!(out.pr_title, "quiet");
        assert!(land(root, "quiet").is_err(), "landing twice: no feature");
    }
}
