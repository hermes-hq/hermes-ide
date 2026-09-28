//! The git side of the turn ledger (F20): snapshots of a worktree that never
//! touch HEAD, the user's index or the stash.
//!
//! Every operation goes through a PRIVATE index file kept next to the
//! worktree's git dir (`<git-dir>/hermes-turn-index`) via `GIT_INDEX_FILE`,
//! so `git add -A` there sees exactly what the user's `git add -A` would see
//! (tracked, modified, untracked; never ignored) without changing what the
//! user has staged. The index persists between snapshots so git's stat cache
//! makes the second and later snapshots cheap on large repositories.
//!
//! A snapshot is `write-tree` + `commit-tree` + `update-ref` on a hidden
//! reference (`refs/hermes/<session>/...`, see `crate::contract::turns`).
//! Plumbing only: no hooks run, no branch moves, no reflog for HEAD.

use crate::contract::turns::Diffstat;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// How long a snapshot may take before the ledger gives up on it and keeps
/// only a summary (the spec's 2 s).
pub const DEFAULT_BUDGET: Duration = Duration::from_millis(2000);

/// Largest patch handed to the UI; the rest is cut with a note.
const PATCH_CAP_BYTES: usize = 4 * 1024 * 1024;

const IDENT_NAME: &str = "Hermes";
const IDENT_EMAIL: &str = "hermes@localhost";

/// A worktree the ledger can snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Repo {
    /// The worktree's top level.
    pub root: PathBuf,
    /// This worktree's git dir (for a linked worktree, `.git/worktrees/<x>`).
    pub git_dir: PathBuf,
    /// The ledger's private index file.
    pub index: PathBuf,
}

/// What `write_tree` came back with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteTree {
    Tree(String),
    /// `git add` did not finish inside the budget and was stopped.
    TooSlow {
        elapsed: Duration,
    },
}

fn base_command(dir: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        // Never let a read-only git command refresh (write) the user's index.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_AUTHOR_NAME", IDENT_NAME)
        .env("GIT_AUTHOR_EMAIL", IDENT_EMAIL)
        .env("GIT_COMMITTER_NAME", IDENT_NAME)
        .env("GIT_COMMITTER_EMAIL", IDENT_EMAIL)
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

/// Run git in `dir` and return trimmed stdout, or stderr as the error.
fn git_out(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = base_command(dir)
        .args(args)
        .output()
        .map_err(|e| format!("git {}: {e}", args.join(" ")))?;
    if !out.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}

impl Repo {
    /// The repository `dir` belongs to, or None when it is not inside a git
    /// worktree (a bare repo, a `.git` folder, a plain folder).
    pub fn discover(dir: &Path) -> Option<Repo> {
        if !dir.is_dir() {
            return None;
        }
        let root = git_out(dir, &["rev-parse", "--show-toplevel"]).ok()?;
        let git_dir = git_out(dir, &["rev-parse", "--absolute-git-dir"]).ok()?;
        if root.is_empty() || git_dir.is_empty() {
            return None;
        }
        let root = PathBuf::from(root);
        let git_dir = PathBuf::from(git_dir);
        let index = git_dir.join("hermes-turn-index");
        Some(Repo {
            root,
            git_dir,
            index,
        })
    }

    /// A key that is the same for every session in this worktree.
    pub fn lane_key(&self) -> String {
        dunce::canonicalize(&self.git_dir)
            .unwrap_or_else(|_| self.git_dir.clone())
            .to_string_lossy()
            .to_string()
    }

    fn git(&self, args: &[&str]) -> Result<String, String> {
        git_out(&self.root, args)
    }

    /// Git with the private index.
    fn git_idx(&self, args: &[&str]) -> Result<String, String> {
        let out = base_command(&self.root)
            .env("GIT_INDEX_FILE", &self.index)
            .args(args)
            .output()
            .map_err(|e| format!("git {}: {e}", args.join(" ")))?;
        if !out.status.success() {
            return Err(format!(
                "git {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
    }

    /// The tree of the worktree as it is now (tracked + untracked, minus
    /// ignored), through the private index. Stops `git add` when it runs
    /// past `budget` and reports `TooSlow` instead; the half-written private
    /// index lock is removed so the next attempt can start clean.
    pub fn write_tree(&self, budget: Duration) -> Result<WriteTree, String> {
        let started = Instant::now();
        let mut child = base_command(&self.root)
            .env("GIT_INDEX_FILE", &self.index)
            .args(["add", "-A", "--ignore-errors", "--", "."])
            .spawn()
            .map_err(|e| format!("git add: {e}"))?;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        let mut err = String::new();
                        if let Some(mut e) = child.stderr.take() {
                            let _ = std::io::Read::read_to_string(&mut e, &mut err);
                        }
                        return Err(format!("git add failed: {}", err.trim()));
                    }
                    break;
                }
                Ok(None) => {
                    if started.elapsed() > budget {
                        let _ = child.kill();
                        let _ = child.wait();
                        let mut lock = self.index.as_os_str().to_owned();
                        lock.push(".lock");
                        let _ = std::fs::remove_file(PathBuf::from(lock));
                        return Ok(WriteTree::TooSlow {
                            elapsed: started.elapsed(),
                        });
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(e) => return Err(format!("git add: {e}")),
            }
        }
        let tree = self.git_idx(&["write-tree"])?;
        Ok(WriteTree::Tree(tree))
    }

    /// The object id of `spec`, or None when it does not resolve.
    pub fn rev_parse(&self, spec: &str) -> Option<String> {
        self.git(&["rev-parse", "--verify", "-q", spec])
            .ok()
            .filter(|s| !s.is_empty())
    }

    /// The tree a commit points at.
    pub fn tree_of(&self, commit: &str) -> Option<String> {
        self.rev_parse(&format!("{commit}^{{tree}}"))
    }

    /// The parent of a commit, or None for a root commit.
    pub fn parent_of(&self, commit: &str) -> Option<String> {
        self.rev_parse(&format!("{commit}^"))
    }

    /// The empty tree of this repository (hash-agnostic).
    pub fn empty_tree(&self) -> Result<String, String> {
        let out = base_command(&self.root)
            .stdin(Stdio::piped())
            .args(["mktree"])
            .spawn()
            .and_then(|mut c| {
                drop(c.stdin.take());
                c.wait_with_output()
            })
            .map_err(|e| format!("git mktree: {e}"))?;
        if !out.status.success() {
            return Err("git mktree failed".to_string());
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    pub fn commit_tree(
        &self,
        tree: &str,
        parent: Option<&str>,
        message: &str,
    ) -> Result<String, String> {
        let mut args = vec!["commit-tree", tree, "-m", message];
        if let Some(p) = parent {
            args.push("-p");
            args.push(p);
        }
        self.git(&args)
    }

    pub fn update_ref(&self, name: &str, oid: &str) -> Result<(), String> {
        self.git(&["update-ref", "--no-deref", name, oid])
            .map(|_| ())
    }

    pub fn delete_ref(&self, name: &str) -> Result<(), String> {
        self.git(&["update-ref", "-d", "--no-deref", name])
            .map(|_| ())
    }

    /// Every ref under `prefix` (e.g. `refs/hermes/<session>/`).
    pub fn refs_under(&self, prefix: &str) -> Vec<String> {
        self.git(&["for-each-ref", "--format=%(refname)", prefix])
            .map(|s| s.lines().map(str::to_string).collect())
            .unwrap_or_default()
    }

    /// Files, insertions and deletions between two trees. A binary file
    /// counts as a file with no lines.
    pub fn diffstat(&self, from_tree: &str, to_tree: &str) -> Result<Diffstat, String> {
        let out = self.git(&["diff-tree", "-r", "--numstat", from_tree, to_tree])?;
        Ok(parse_numstat(&out))
    }

    /// Unified diff between two trees, cut at [`PATCH_CAP_BYTES`].
    pub fn patch(&self, from_tree: &str, to_tree: &str) -> Result<String, String> {
        let mut p = self.git(&["diff-tree", "-r", "-p", "--no-color", from_tree, to_tree])?;
        if p.len() > PATCH_CAP_BYTES {
            let mut cut = PATCH_CAP_BYTES;
            while !p.is_char_boundary(cut) {
                cut -= 1;
            }
            p.truncate(cut);
            p.push_str("\n... (diff cut here: too large to show in full)\n");
        }
        Ok(p)
    }

    /// The diffstat of what changed in the worktree against HEAD, plus the
    /// untracked files: the summary kept when a snapshot is too slow.
    pub fn summary_diffstat(&self) -> Diffstat {
        let mut stat = self
            .git(&["diff", "--numstat", "HEAD", "--"])
            .map(|s| parse_numstat(&s))
            .unwrap_or_default();
        let untracked = self
            .git(&["ls-files", "--others", "--exclude-standard"])
            .map(|s| s.lines().filter(|l| !l.is_empty()).count())
            .unwrap_or(0);
        stat.files += untracked as u32;
        stat
    }

    /// Paths that differ between two trees, as `git diff-tree` names them,
    /// filtered by `filter` (`D`, `AMT`, ...).
    fn changed_paths(&self, from: &str, to: &str, filter: &str) -> Result<Vec<String>, String> {
        let out = base_command(&self.root)
            .args([
                "diff-tree",
                "-r",
                "-z",
                "--name-only",
                &format!("--diff-filter={filter}"),
                from,
                to,
            ])
            .output()
            .map_err(|e| format!("git diff-tree: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "git diff-tree failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout)
            .split('\0')
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect())
    }

    /// Make the worktree equal `target_tree`, given that it currently equals
    /// `current_tree` (a fresh `write_tree`). Files the target does not have
    /// are removed, the rest written from the target; the user's index,
    /// HEAD and stash are untouched. Returns how many paths were touched.
    pub fn restore(&self, current_tree: &str, target_tree: &str) -> Result<u32, String> {
        let removed = self.changed_paths(current_tree, target_tree, "D")?;
        for rel in &removed {
            let p = self.root.join(rel);
            if p.is_symlink() || p.is_file() {
                std::fs::remove_file(&p).map_err(|e| format!("remove {rel}: {e}"))?;
            }
        }
        let written = self.changed_paths(current_tree, target_tree, "AMT")?;
        self.git_idx(&["read-tree", target_tree])?;
        if !written.is_empty() {
            let mut child = base_command(&self.root)
                .env("GIT_INDEX_FILE", &self.index)
                .args(["checkout-index", "-u", "-f", "-z", "--stdin"])
                .stdin(Stdio::piped())
                .spawn()
                .map_err(|e| format!("git checkout-index: {e}"))?;
            {
                let mut stdin = child.stdin.take().ok_or("checkout-index stdin")?;
                let mut buf = Vec::new();
                for rel in &written {
                    buf.extend_from_slice(rel.as_bytes());
                    buf.push(0);
                }
                std::io::Write::write_all(&mut stdin, &buf)
                    .map_err(|e| format!("checkout-index stdin: {e}"))?;
            }
            let out = child
                .wait_with_output()
                .map_err(|e| format!("git checkout-index: {e}"))?;
            if !out.status.success() {
                return Err(format!(
                    "git checkout-index failed: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ));
            }
        }
        // Belt and braces: the worktree must now be exactly the target.
        match self.write_tree(Duration::from_secs(60))? {
            WriteTree::Tree(t) if t == target_tree => {}
            WriteTree::Tree(t) => {
                return Err(format!(
                    "restore left the worktree at {t}, not {target_tree}"
                ))
            }
            WriteTree::TooSlow { .. } => return Err("restore check timed out".to_string()),
        }
        Ok((removed.len() + written.len()) as u32)
    }
}

fn parse_numstat(out: &str) -> Diffstat {
    let mut stat = Diffstat::default();
    for line in out.lines() {
        let mut parts = line.split('\t');
        let (Some(a), Some(d), Some(_path)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        stat.files += 1;
        stat.insertions += a.parse::<u32>().unwrap_or(0);
        stat.deletions += d.parse::<u32>().unwrap_or(0);
    }
    stat
}

#[cfg(test)]
pub(crate) mod testing {
    use super::*;

    /// A throwaway repository with one commit, a synthetic identity and a
    /// pre-existing stash entry (so "the stash is unchanged" is a real check).
    pub struct TestRepo {
        /// Kept only so the folder lives as long as the repo.
        _dir: tempfile::TempDir,
        pub repo: Repo,
    }

    pub fn git(dir: &Path, args: &[&str]) -> String {
        let out = base_command(dir)
            .args(args)
            .output()
            .unwrap_or_else(|e| panic!("git {args:?}: {e}"));
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim_end().to_string()
    }

    pub fn write(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(p, text).unwrap();
    }

    impl TestRepo {
        pub fn new() -> TestRepo {
            let dir = tempfile::tempdir().unwrap();
            let root = dunce::canonicalize(dir.path()).unwrap();
            git(&root, &["init", "-q", "-b", "main"]);
            git(&root, &["config", "user.name", "Hermes Test"]);
            git(&root, &["config", "user.email", "test@example.com"]);
            git(&root, &["config", "commit.gpgsign", "false"]);
            git(&root, &["config", "core.autocrlf", "false"]);
            write(&root, "README.md", "# demo\n");
            write(&root, "src/app.txt", "hello\n");
            write(&root, ".gitignore", "build/\n*.log\n");
            git(&root, &["add", "."]);
            git(&root, &["commit", "-q", "-m", "initial"]);
            write(&root, "README.md", "# demo (stashed)\n");
            git(&root, &["stash", "push", "-q", "-m", "pre-existing"]);
            let repo = Repo::discover(&root).expect("a repo");
            TestRepo { _dir: dir, repo }
        }

        pub fn root(&self) -> &Path {
            &self.repo.root
        }

        pub fn git(&self, args: &[&str]) -> String {
            git(self.root(), args)
        }

        /// HEAD, the staged index (as `ls-files -s`), the porcelain status
        /// and the stash list: what a snapshot must never change.
        pub fn user_state(&self) -> UserState {
            UserState {
                head: self.git(&["rev-parse", "HEAD"]),
                index: self.git(&["ls-files", "-s"]),
                status: self.git(&["status", "--porcelain=v1", "--untracked-files=all"]),
                stash: self.git(&["stash", "list"]),
                index_mtime: std::fs::metadata(self.repo.git_dir.join("index"))
                    .ok()
                    .and_then(|m| m.modified().ok()),
            }
        }
    }

    #[derive(Debug, PartialEq, Eq)]
    pub struct UserState {
        pub head: String,
        pub index: String,
        pub status: String,
        pub stash: String,
        pub index_mtime: Option<std::time::SystemTime>,
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;

    #[test]
    fn discover_finds_the_worktree_root_and_a_private_index_path() {
        let t = TestRepo::new();
        let sub = t.root().join("src");
        let found = Repo::discover(&sub).expect("found from a subfolder");
        assert_eq!(found.root, t.repo.root);
        assert_eq!(found.index, t.repo.git_dir.join("hermes-turn-index"));
        assert!(found.index.starts_with(&found.git_dir));
        assert_eq!(Repo::discover(&t.repo.git_dir.join("objects")), None);
        let plain = tempfile::tempdir().unwrap();
        assert_eq!(Repo::discover(plain.path()), None);
        assert_eq!(Repo::discover(Path::new("/definitely/not/here")), None);
    }

    #[test]
    fn write_tree_sees_tracked_modified_and_untracked_files_but_not_ignored_ones() {
        let t = TestRepo::new();
        write(t.root(), "src/app.txt", "hello world\n");
        write(t.root(), "notes/new.txt", "draft\n");
        write(t.root(), "build/out.bin", "binary\n");
        write(t.root(), "debug.log", "noise\n");
        let WriteTree::Tree(tree) = t.repo.write_tree(DEFAULT_BUDGET).unwrap() else {
            panic!("too slow");
        };
        let listed = t.git(&["ls-tree", "-r", "--name-only", &tree]);
        let names: Vec<&str> = listed.lines().collect();
        assert!(names.contains(&"src/app.txt"));
        assert!(
            names.contains(&"notes/new.txt"),
            "untracked file is in: {names:?}"
        );
        assert!(
            !names.contains(&"build/out.bin"),
            "ignored dir left out: {names:?}"
        );
        assert!(
            !names.contains(&"debug.log"),
            "ignored file left out: {names:?}"
        );
        assert!(t.repo.index.exists(), "the private index persists");
    }

    #[test]
    fn a_snapshot_changes_nothing_the_user_can_see() {
        let t = TestRepo::new();
        write(t.root(), "src/app.txt", "hello world\n");
        write(t.root(), "notes/new.txt", "draft\n");
        t.git(&["add", "README.md"]); // something staged, to be sure it stays staged
        let before = t.user_state();
        std::thread::sleep(Duration::from_millis(20));
        let WriteTree::Tree(tree) = t.repo.write_tree(DEFAULT_BUDGET).unwrap() else {
            panic!("too slow");
        };
        let head = t.repo.rev_parse("HEAD").unwrap();
        let commit = t.repo.commit_tree(&tree, Some(&head), "turn").unwrap();
        t.repo.update_ref("refs/hermes/s1/turn/1", &commit).unwrap();
        assert_eq!(t.user_state(), before);
        assert_eq!(t.repo.rev_parse("refs/hermes/s1/turn/1"), Some(commit));
        assert_eq!(t.git(&["branch", "--show-current"]), "main");
    }

    #[test]
    fn diffstat_and_patch_describe_what_a_turn_changed() {
        let t = TestRepo::new();
        let head_tree = t.repo.tree_of("HEAD").unwrap();
        write(t.root(), "src/app.txt", "hello world\n");
        write(t.root(), "notes/new.txt", "draft\n");
        let WriteTree::Tree(tree) = t.repo.write_tree(DEFAULT_BUDGET).unwrap() else {
            panic!("too slow");
        };
        let stat = t.repo.diffstat(&head_tree, &tree).unwrap();
        assert_eq!(
            stat,
            Diffstat {
                files: 2,
                insertions: 2,
                deletions: 1
            }
        );
        let patch = t.repo.patch(&head_tree, &tree).unwrap();
        assert!(patch.contains("-hello\n+hello world"), "{patch}");
        assert!(patch.contains("+++ b/notes/new.txt"), "{patch}");
        let empty = t.repo.empty_tree().unwrap();
        assert_eq!(t.repo.diffstat(&empty, &head_tree).unwrap().files, 3);
        assert_eq!(parse_numstat("-\t-\timg.png\n3\t1\ta.txt\n").files, 2);
        assert_eq!(parse_numstat("-\t-\timg.png\n3\t1\ta.txt\n").insertions, 3);
    }

    #[test]
    fn a_too_slow_add_is_stopped_and_leaves_no_lock_behind() {
        let t = TestRepo::new();
        for i in 0..200 {
            write(t.root(), &format!("many/f{i}.txt"), "x\n");
        }
        // A budget no `git add` can meet.
        let r = t.repo.write_tree(Duration::from_nanos(1)).unwrap();
        assert!(matches!(r, WriteTree::TooSlow { .. }), "{r:?}");
        let mut lock = t.repo.index.as_os_str().to_owned();
        lock.push(".lock");
        assert!(
            !PathBuf::from(lock).exists(),
            "the private index lock was removed"
        );
        // And the next attempt works.
        assert!(matches!(
            t.repo.write_tree(Duration::from_secs(30)).unwrap(),
            WriteTree::Tree(_)
        ));
        let stat = t.repo.summary_diffstat();
        assert_eq!(stat.files, 200, "the summary counts the untracked files");
    }

    #[test]
    fn restore_makes_the_worktree_exactly_the_target_tree() {
        let t = TestRepo::new();
        let WriteTree::Tree(t1) = t.repo.write_tree(DEFAULT_BUDGET).unwrap() else {
            panic!()
        };
        write(t.root(), "src/app.txt", "hello world\n");
        write(t.root(), "notes/new.txt", "draft\n");
        std::fs::remove_file(t.root().join("README.md")).unwrap();
        let WriteTree::Tree(t2) = t.repo.write_tree(DEFAULT_BUDGET).unwrap() else {
            panic!()
        };
        assert_ne!(t1, t2);
        let before = t.user_state();
        let touched = t.repo.restore(&t2, &t1).unwrap();
        assert_eq!(touched, 3, "one removed, two written");
        assert_eq!(
            std::fs::read_to_string(t.root().join("src/app.txt")).unwrap(),
            "hello\n"
        );
        assert!(
            !t.root().join("notes/new.txt").exists(),
            "the file T1 did not have is gone"
        );
        assert!(
            t.root().join("README.md").exists(),
            "the deleted file is back"
        );
        let WriteTree::Tree(now) = t.repo.write_tree(DEFAULT_BUDGET).unwrap() else {
            panic!()
        };
        assert_eq!(now, t1, "the worktree is exactly the T1 tree");
        let after = t.user_state();
        assert_eq!(after.head, before.head);
        assert_eq!(after.index, before.index);
        assert_eq!(after.stash, before.stash);
        // Restoring back forward works too (a removed path re-appears).
        t.repo.restore(&t1, &t2).unwrap();
        assert!(t.root().join("notes/new.txt").exists());
        assert!(!t.root().join("README.md").exists());
    }

    #[test]
    fn refs_can_be_listed_and_deleted_per_session() {
        let t = TestRepo::new();
        let head = t.repo.rev_parse("HEAD").unwrap();
        t.repo.update_ref("refs/hermes/s1/turn/1", &head).unwrap();
        t.repo.update_ref("refs/hermes/s1/turn/2", &head).unwrap();
        t.repo.update_ref("refs/hermes/s2/turn/1", &head).unwrap();
        let mut s1 = t.repo.refs_under("refs/hermes/s1/");
        s1.sort();
        assert_eq!(s1, vec!["refs/hermes/s1/turn/1", "refs/hermes/s1/turn/2"]);
        for r in &s1 {
            t.repo.delete_ref(r).unwrap();
        }
        assert!(t.repo.refs_under("refs/hermes/s1/").is_empty());
        assert_eq!(t.repo.refs_under("refs/hermes/s2/").len(), 1);
        assert_eq!(t.repo.parent_of(&head), None);
    }
}
