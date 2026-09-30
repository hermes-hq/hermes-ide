//! Backend half of the ⌘N task launcher (F15).
//!
//! The launcher needs three facts about the folder it will start a task in
//! before it lets the user press Enter: is it a git repository (and where is
//! its main checkout), does the branch it is about to create already exist,
//! and what does the repository's `.hermes/worktree.toml` say "done" means.
//! It also writes the first `feature.md` of a Full-track task (ADR 004 §6).

use git2::{BranchType, Repository};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Larger than any real recipe file; a bigger one is not read.
const WORKTREE_TOML_CAP: u64 = 64 * 1024;
/// Branch names returned to the launcher at most.
const BRANCH_LIST_CAP: usize = 10_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RepoProbe {
    /// The main checkout of the repository the folder belongs to (also when
    /// the folder is one of its linked worktrees), or None when it is not in
    /// a git repository.
    pub git_root: Option<String>,
    /// Whether a local branch with the asked-for name exists.
    pub branch_exists: bool,
    /// Every local branch (at most `BRANCH_LIST_CAP`), so the launcher can
    /// judge a name the user types, and suggest a free one, without asking again.
    pub local_branches: Vec<String>,
    /// The text of `<git_root>/.hermes/worktree.toml`, when there is one.
    pub worktree_toml: Option<String>,
    /// The branch checked out in the main checkout (None when detached or
    /// not a repository): what a new branch is cut from by default.
    pub current_branch: Option<String>,
}

fn main_checkout(repo: &Repository) -> Option<PathBuf> {
    if repo.is_worktree() {
        // <main>/.git/worktrees/<name> → commondir is <main>/.git
        let common = repo.commondir();
        return common.parent().map(Path::to_path_buf);
    }
    repo.workdir().map(Path::to_path_buf)
}

pub fn probe_repo(path: &Path, branch: Option<&str>) -> RepoProbe {
    let Ok(repo) = Repository::discover(path) else {
        return RepoProbe {
            git_root: None,
            branch_exists: false,
            local_branches: Vec::new(),
            worktree_toml: None,
            current_branch: None,
        };
    };
    let root = main_checkout(&repo);
    // Taken also when only the letter case differs (see BranchClash).
    let branch_exists = branch
        .filter(|b| !b.trim().is_empty())
        .is_some_and(|b| crate::git::worktree::local_branch_clash(&repo, b.trim()).is_some());
    let local_branches: Vec<String> = repo
        .branches(Some(BranchType::Local))
        .map(|it| {
            it.filter_map(|b| b.ok())
                .filter_map(|(b, _)| b.name().ok().flatten().map(str::to_string))
                .take(BRANCH_LIST_CAP)
                .collect()
        })
        .unwrap_or_default();
    let worktree_toml = root.as_ref().and_then(|r| {
        let file = r.join(".hermes").join("worktree.toml");
        let meta = std::fs::metadata(&file).ok()?;
        if !meta.is_file() || meta.len() > WORKTREE_TOML_CAP {
            return None;
        }
        std::fs::read_to_string(file).ok()
    });
    let current_branch = root
        .as_ref()
        .and_then(|r| Repository::open(r).ok())
        .and_then(|main| {
            let head = main.head().ok()?;
            if !head.is_branch() {
                return None;
            }
            head.shorthand().map(str::to_string)
        });
    RepoProbe {
        git_root: root.map(|r| dunce::simplified(&r).to_string_lossy().to_string()),
        branch_exists,
        local_branches,
        worktree_toml,
        current_branch,
    }
}

#[tauri::command]
pub async fn task_repo_probe(path: String, branch: Option<String>) -> Result<RepoProbe, String> {
    tokio::task::spawn_blocking(move || probe_repo(Path::new(&path), branch.as_deref()))
        .await
        .map_err(|e| e.to_string())
}

/// A feature slug is one branch-name component: lowercase letters, digits
/// and single dashes (what the launcher's slugify produces).
pub fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 64
        && !slug.starts_with('-')
        && !slug.ends_with('-')
        && !slug.contains("--")
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Write `<checkout>/.hermes/features/<slug>/feature.md`, unless one is
/// already there. Returns the file's path.
pub fn write_feature_file(checkout: &Path, slug: &str, contents: &str) -> Result<PathBuf, String> {
    if !valid_slug(slug) {
        return Err(format!("not a valid feature name: {slug:?}"));
    }
    if !checkout.is_dir() {
        return Err("the task's folder does not exist".to_string());
    }
    if Repository::open(checkout).is_err() {
        return Err("the task's folder is not a git checkout".to_string());
    }
    let dir = checkout.join(".hermes").join("features").join(slug);
    let file = dir.join("feature.md");
    if file.exists() {
        return Ok(file);
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(&file, contents).map_err(|e| e.to_string())?;
    Ok(file)
}

#[tauri::command]
pub fn task_write_feature_file(
    checkout: String,
    slug: String,
    contents: String,
) -> Result<String, String> {
    write_feature_file(Path::new(&checkout), &slug, &contents)
        .map(|p| p.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_with_commit(dir: &Path) -> Repository {
        let repo = Repository::init(dir).unwrap();
        {
            let sig = git2::Signature::now("Test", "test@example.com").unwrap();
            let tree_id = repo.index().unwrap().write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
                .unwrap();
        }
        repo
    }

    #[test]
    fn a_plain_folder_is_not_a_repository() {
        let dir = tempfile::tempdir().unwrap();
        let p = probe_repo(dir.path(), Some("hermes/x"));
        assert_eq!(p.git_root, None);
        assert!(!p.branch_exists);
        assert_eq!(p.worktree_toml, None);
    }

    #[test]
    fn branches_and_the_recipe_file_are_reported_from_a_subfolder() {
        let dir = tempfile::tempdir().unwrap();
        let repo = repo_with_commit(dir.path());
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("hermes/fix-login", &head, false).unwrap();
        std::fs::create_dir_all(dir.path().join(".hermes")).unwrap();
        std::fs::write(
            dir.path().join(".hermes").join("worktree.toml"),
            "done_when = [\"npm test\"]\n",
        )
        .unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();

        let p = probe_repo(&dir.path().join("src"), Some("hermes/fix-login"));
        let root = dunce::canonicalize(dir.path()).unwrap();
        assert_eq!(
            p.git_root.map(|r| dunce::canonicalize(r).unwrap()),
            Some(root)
        );
        assert!(p.branch_exists);
        assert!(p.local_branches.contains(&"hermes/fix-login".to_string()));
        assert_eq!(
            p.worktree_toml.as_deref(),
            Some("done_when = [\"npm test\"]\n")
        );
        assert!(!probe_repo(dir.path(), Some("hermes/other")).branch_exists);
        assert!(!probe_repo(dir.path(), None).branch_exists);
        // Only the letter case differs: the same branch on macOS and Windows.
        assert!(probe_repo(dir.path(), Some("Hermes/Fix-Login")).branch_exists);
        assert!(probe_repo(dir.path(), Some("HERMES/new-one")).branch_exists);
    }

    #[test]
    fn the_main_checkouts_branch_is_reported_even_from_a_linked_worktree() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("main");
        std::fs::create_dir_all(&main).unwrap();
        let repo = repo_with_commit(&main);
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("develop", &head, false).unwrap();
        repo.set_head("refs/heads/develop").unwrap();
        let wt_path = dir.path().join("wt");
        repo.worktree("wt", &wt_path, None).unwrap();
        assert_eq!(
            probe_repo(&main, None).current_branch.as_deref(),
            Some("develop")
        );
        assert_eq!(
            probe_repo(&wt_path, None).current_branch.as_deref(),
            Some("develop")
        );
        // Detached: no branch to name.
        repo.set_head_detached(head.id()).unwrap();
        assert_eq!(probe_repo(&main, None).current_branch, None);
        assert_eq!(
            probe_repo(dir.path().join("nowhere").as_path(), None).current_branch,
            None
        );
    }

    #[test]
    fn a_linked_worktree_reports_its_main_checkout() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("main");
        std::fs::create_dir_all(&main).unwrap();
        let repo = repo_with_commit(&main);
        let wt_path = dir.path().join("wt");
        repo.worktree("wt", &wt_path, None).unwrap();
        let p = probe_repo(&wt_path, None);
        assert_eq!(
            p.git_root.map(|r| dunce::canonicalize(r).unwrap()),
            Some(dunce::canonicalize(&main).unwrap())
        );
    }

    #[test]
    fn slugs_are_single_branch_components() {
        assert!(valid_slug("fix-login-bug"));
        assert!(valid_slug("a1"));
        for bad in ["", "-a", "a-", "a--b", "A", "a/b", "../x", "a b", "é"] {
            assert!(!valid_slug(bad), "{bad:?}");
        }
    }

    #[test]
    fn the_feature_file_is_written_once_inside_the_checkout() {
        let dir = tempfile::tempdir().unwrap();
        repo_with_commit(dir.path());
        let file =
            write_feature_file(dir.path(), "fix-login", "---\nslug: fix-login\n---\n").unwrap();
        assert_eq!(
            file,
            dir.path()
                .join(".hermes")
                .join("features")
                .join("fix-login")
                .join("feature.md")
        );
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "---\nslug: fix-login\n---\n"
        );
        // Never overwritten.
        write_feature_file(dir.path(), "fix-login", "other").unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "---\nslug: fix-login\n---\n"
        );
        assert!(write_feature_file(dir.path(), "../escape", "x").is_err());
        let plain = tempfile::tempdir().unwrap();
        assert!(write_feature_file(plain.path(), "ok", "x").is_err());
    }
}
