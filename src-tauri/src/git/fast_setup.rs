//! Fast worktrees (N17): a new worktree is ready to run in seconds.
//!
//! - **Dependencies and build caches.** For every lockfile the new worktree
//!   tracks (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`,
//!   `Cargo.lock`, ...), Hermes looks for a checkout of the same repo — the
//!   project folder first, then its other worktrees — whose lockfile is
//!   byte-for-byte the same and that has the matching folder installed
//!   (`node_modules`, `target`). That folder is cloned copy-on-write (see
//!   [`super::cow_clone`]). When no checkout matches, or the disk cannot
//!   share blocks, nothing is copied and the report says to install as usual.
//!   Hermes never runs an install itself: install scripts are the repo's code.
//! - **Ports.** Each worktree gets its own block of [`PORT_BLOCK_SIZE`] ports,
//!   recorded with the session's worktree and handed to its terminal as
//!   `PORT` (the first port), `HERMES_PORT_BASE` and `HERMES_PORT_COUNT`, so
//!   dev servers in parallel worktrees do not collide.
//!
//! Git and file-system work only, the same for every agent: it all happens
//! before any agent starts.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use super::cow_clone::{self, CloneError, CloneMethod};

// ─── What gets cloned ───────────────────────────────────────────────

/// A folder that a lockfile fully determines, and the lockfiles that do.
struct DependencyKind {
    folder: &'static str,
    lockfiles: &'static [&'static str],
    /// Shown to people: "dependencies" or "build cache".
    label: &'static str,
}

const KINDS: &[DependencyKind] = &[
    DependencyKind {
        folder: "node_modules",
        lockfiles: &[
            "package-lock.json",
            "npm-shrinkwrap.json",
            "yarn.lock",
            "pnpm-lock.yaml",
            "bun.lock",
            "bun.lockb",
        ],
        label: "dependencies",
    },
    DependencyKind {
        folder: "target",
        lockfiles: &["Cargo.lock"],
        label: "build cache",
    },
];

/// One folder to set up in the new worktree: `<dir>/<folder>`, decided by
/// the lockfiles in `<dir>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DependencyFolder {
    /// Folder inside the worktree that holds the lockfiles ("" = the root),
    /// always with `/` separators.
    pub dir: String,
    pub folder: &'static str,
    pub label: &'static str,
    pub lockfiles: Vec<String>,
}

impl DependencyFolder {
    /// `node_modules`, `packages/web/node_modules`, `src-tauri/target`.
    pub fn rel_path(&self) -> String {
        join_rel(&self.dir, self.folder)
    }
}

fn join_rel(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

fn under(root: &Path, rel: &str) -> PathBuf {
    rel.split('/')
        .filter(|s| !s.is_empty())
        .fold(root.to_path_buf(), |p, s| p.join(s))
}

/// Group tracked file paths (as `git ls-files` prints them) into the folders
/// to set up. Lockfiles inside an installed folder are ignored.
pub fn dependency_folders(tracked: &[String]) -> Vec<DependencyFolder> {
    let mut out: Vec<DependencyFolder> = Vec::new();
    for path in tracked {
        let (dir, name) = match path.rsplit_once('/') {
            Some((d, n)) => (d.to_string(), n),
            None => (String::new(), path.as_str()),
        };
        if dir
            .split('/')
            .any(|seg| KINDS.iter().any(|k| k.folder == seg))
        {
            continue;
        }
        let Some(kind) = KINDS.iter().find(|k| k.lockfiles.contains(&name)) else {
            continue;
        };
        match out
            .iter_mut()
            .find(|f| f.dir == dir && f.folder == kind.folder)
        {
            Some(existing) => existing.lockfiles.push(name.to_string()),
            None => out.push(DependencyFolder {
                dir,
                folder: kind.folder,
                label: kind.label,
                lockfiles: vec![name.to_string()],
            }),
        }
    }
    out.sort_by_key(|f| f.rel_path());
    out
}

// ─── Report ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DependencyStatus {
    /// Cloned copy-on-write from another checkout.
    Cloned,
    /// The worktree already had the folder; left alone.
    AlreadyThere,
    /// No checkout of this repo has the same lockfile: install as usual.
    LockfileChanged,
    /// No checkout of this repo has the folder installed yet.
    NotInstalledElsewhere,
    /// The disk cannot share blocks: install as usual.
    CopyOnWriteUnavailable,
    /// Cloning failed for another reason: install as usual.
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencySetup {
    /// `node_modules`, `packages/web/node_modules`, `src-tauri/target`.
    pub folder: String,
    /// "dependencies" or "build cache".
    pub kind: String,
    pub lockfiles: Vec<String>,
    pub status: DependencyStatus,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub method: Option<CloneMethod>,
    /// The checkout it was cloned from.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub source: Option<String>,
    pub millis: u64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortBlock {
    pub base: u16,
    pub count: u16,
}

impl PortBlock {
    /// The variables a session's terminal gets.
    pub fn env(&self) -> [(&'static str, String); 3] {
        [
            ("PORT", self.base.to_string()),
            ("HERMES_PORT_BASE", self.base.to_string()),
            ("HERMES_PORT_COUNT", self.count.to_string()),
        ]
    }
}

/// What preparing a worktree did. Stored with the session's worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSetup {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ports: Option<PortBlock>,
    pub dependencies: Vec<DependencySetup>,
    /// Time spent setting up dependencies, in milliseconds.
    pub millis: u64,
}

impl WorktreeSetup {
    /// Rebuild from what the database recorded; `None` when the worktree was
    /// never prepared (made without the feature).
    pub fn from_record(port_base: Option<u16>, report: Option<&str>) -> Option<WorktreeSetup> {
        let mut setup: WorktreeSetup = serde_json::from_str(report?).ok()?;
        // The column is the authority: it is what keeps blocks unique.
        setup.ports = port_base.map(|base| PortBlock {
            base,
            count: PORT_BLOCK_SIZE,
        });
        Some(setup)
    }
}

// ─── Setting up dependencies ────────────────────────────────────────

/// Files git tracks in `worktree`, `/`-separated.
fn tracked_files(worktree: &Path) -> Vec<String> {
    let Ok(out) = crate::git::cli::git_command()
        .arg("-C")
        .arg(worktree)
        .args(["ls-files", "-z"])
        .output()
    else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    out.stdout
        .split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect()
}

/// Checkouts of the repo at `repo_root` other than `exclude`: the project
/// folder first, then its other worktrees in the order git lists them.
pub fn candidate_checkouts(repo_root: &Path, exclude: &Path) -> Vec<PathBuf> {
    let mut out = vec![repo_root.to_path_buf()];
    if let Ok(o) = crate::git::cli::git_command()
        .arg("-C")
        .arg(repo_root)
        .args(["worktree", "list", "--porcelain"])
        .output()
    {
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                out.push(PathBuf::from(p));
            }
        }
    }
    let mut seen: Vec<PathBuf> = Vec::new();
    out.into_iter()
        .filter(|p| {
            let key = fs::canonicalize(p).unwrap_or_else(|_| p.clone());
            let excluded = fs::canonicalize(exclude).unwrap_or_else(|_| exclude.to_path_buf());
            if key == excluded || seen.contains(&key) {
                return false;
            }
            seen.push(key);
            true
        })
        .collect()
}

/// A real folder (not a link to one).
fn is_real_dir(p: &Path) -> bool {
    fs::symlink_metadata(p).map(|m| m.is_dir()).unwrap_or(false)
}

/// The same lockfile in two checkouts. Text lockfiles are compared ignoring
/// line endings: with `core.autocrlf` (the Windows default) git checks a
/// worktree out with CRLF while a lockfile the package manager wrote in the
/// project folder has LF, and the installed tree is the same. Binary
/// lockfiles (`bun.lockb`) must match byte for byte.
fn same_lockfile(a: &Path, b: &Path) -> bool {
    let (Ok(x), Ok(y)) = (fs::read(a), fs::read(b)) else {
        return false;
    };
    if x == y {
        return true;
    }
    let binary = a.extension().is_some_and(|e| e == "lockb");
    !binary && without_cr_before_lf(&x) == without_cr_before_lf(&y)
}

fn without_cr_before_lf(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'\r' && bytes.get(i + 1) == Some(&b'\n') {
            continue;
        }
        out.push(*b);
    }
    out
}

/// Set up every dependency folder the new `worktree` needs by cloning it from
/// one of `candidates` whose lockfiles match. `clone` is [`cow_clone::clone_dir`]
/// outside tests.
pub fn setup_dependencies(
    worktree: &Path,
    folders: &[DependencyFolder],
    candidates: &[PathBuf],
    clone: &dyn Fn(&Path, &Path) -> Result<CloneMethod, CloneError>,
) -> Vec<DependencySetup> {
    let mut report = Vec::new();
    // Once the disk says it cannot share blocks, it will not for the rest.
    let mut unavailable: Option<String> = None;
    for f in folders {
        let started = Instant::now();
        let rel = f.rel_path();
        let dst = under(worktree, &rel);
        let mut entry = DependencySetup {
            folder: rel.clone(),
            kind: f.label.to_string(),
            lockfiles: f.lockfiles.clone(),
            status: DependencyStatus::NotInstalledElsewhere,
            method: None,
            source: None,
            millis: 0,
            detail: None,
        };
        if fs::symlink_metadata(&dst).is_ok() {
            entry.status = DependencyStatus::AlreadyThere;
            report.push(entry);
            continue;
        }
        let installed: Vec<&PathBuf> = candidates
            .iter()
            .filter(|c| is_real_dir(&under(c, &rel)))
            .collect();
        let matching = installed.iter().find(|c| {
            f.lockfiles.iter().all(|lock| {
                let name = join_rel(&f.dir, lock);
                same_lockfile(&under(worktree, &name), &under(c, &name))
            })
        });
        match (matching, installed.is_empty()) {
            (None, true) => entry.status = DependencyStatus::NotInstalledElsewhere,
            (None, false) => entry.status = DependencyStatus::LockfileChanged,
            (Some(src_root), _) => {
                entry.source = Some(src_root.to_string_lossy().into_owned());
                if let Some(why) = &unavailable {
                    entry.status = DependencyStatus::CopyOnWriteUnavailable;
                    entry.detail = Some(why.clone());
                } else {
                    if let Some(parent) = dst.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    match clone(&under(src_root, &rel), &dst) {
                        Ok(method) => {
                            entry.status = DependencyStatus::Cloned;
                            entry.method = Some(method);
                        }
                        Err(CloneError::Unsupported(why)) => {
                            entry.status = DependencyStatus::CopyOnWriteUnavailable;
                            entry.detail = Some(why.clone());
                            unavailable = Some(why);
                        }
                        Err(CloneError::Failed(why)) => {
                            entry.status = DependencyStatus::Failed;
                            entry.detail = Some(why);
                        }
                    }
                }
            }
        }
        entry.millis = started.elapsed().as_millis() as u64;
        report.push(entry);
    }
    report
}

/// Set up the dependency folders of the worktree at `worktree`, made from the
/// repo at `repo_root`.
pub fn prepare_dependencies(repo_root: &Path, worktree: &Path) -> Vec<DependencySetup> {
    let folders = dependency_folders(&tracked_files(worktree));
    if folders.is_empty() {
        return Vec::new();
    }
    let candidates = candidate_checkouts(repo_root, worktree);
    setup_dependencies(worktree, &folders, &candidates, &cow_clone::clone_dir)
}

// ─── Ports ──────────────────────────────────────────────────────────

/// Ports per worktree: PORT, and room for a second server, HMR, a debugger.
pub const PORT_BLOCK_SIZE: u16 = 10;
/// First port handed out. 21000-25999 stays below every OS's range for
/// outgoing connections (Linux starts at 32768, macOS and Windows at 49152)
/// and clear of the usual dev-server defaults (3000, 5173, 8000, 8080).
pub const PORT_RANGE_START: u16 = 21_000;
pub const PORT_BLOCKS: u16 = 500;

/// The first block not recorded for another worktree and with every port
/// free right now.
pub fn pick_port_block(
    taken: &HashSet<u16>,
    is_free: &(dyn Fn(u16) -> bool + Sync),
) -> Option<PortBlock> {
    (0..PORT_BLOCKS)
        .map(|i| PORT_RANGE_START + i * PORT_BLOCK_SIZE)
        .filter(|base| !taken.contains(base))
        .find(|base| block_is_free(*base, is_free))
        .map(|base| PortBlock {
            base,
            count: PORT_BLOCK_SIZE,
        })
}

/// Every port of the block at `base` is free, asked all at once: on Windows
/// a probe of a free port lasts its whole connect timeout (a refused
/// loopback connection is retried), so ten probes in a row took seconds.
fn block_is_free(base: u16, is_free: &(dyn Fn(u16) -> bool + Sync)) -> bool {
    std::thread::scope(|s| {
        let probes: Vec<_> = (base..base + PORT_BLOCK_SIZE)
            .map(|port| s.spawn(move || is_free(port)))
            .collect();
        // The scope waits for any probe left once one is busy.
        probes.into_iter().all(|p| p.join().unwrap_or(false))
    })
}

/// Nothing listens on `port` on this machine: no answer on 127.0.0.1 or
/// ::1, and 127.0.0.1 can be bound. Never listens on a public address.
pub fn port_is_free(port: u16) -> bool {
    use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream};
    use std::time::Duration;
    let v4 = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let v6 = SocketAddr::from((Ipv6Addr::LOCALHOST, port));
    let answers =
        |a: &SocketAddr| TcpStream::connect_timeout(a, Duration::from_millis(150)).is_ok();
    // Both addresses at once, for the same reason as `block_is_free`.
    let (on_v4, on_v6) = std::thread::scope(|s| {
        let v6_probe = s.spawn(|| answers(&v6));
        (answers(&v4), v6_probe.join().unwrap_or(true))
    });
    if on_v4 || on_v6 {
        return false;
    }
    TcpListener::bind(v4).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::TempDir;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn lockfiles_map_to_the_folders_they_determine() {
        let folders = dependency_folders(&s(&[
            "package.json",
            "package-lock.json",
            "src/index.js",
            "packages/web/yarn.lock",
            "src-tauri/Cargo.lock",
            "src-tauri/bridge/package-lock.json",
            "vendor/node_modules/x/package-lock.json",
        ]));
        let got: Vec<(String, Vec<String>)> = folders
            .iter()
            .map(|f| (f.rel_path(), f.lockfiles.clone()))
            .collect();
        assert_eq!(
            got,
            vec![
                ("node_modules".to_string(), s(&["package-lock.json"])),
                ("packages/web/node_modules".to_string(), s(&["yarn.lock"])),
                (
                    "src-tauri/bridge/node_modules".to_string(),
                    s(&["package-lock.json"])
                ),
                ("src-tauri/target".to_string(), s(&["Cargo.lock"])),
            ]
        );
        assert_eq!(folders[3].label, "build cache");
        assert_eq!(folders[0].label, "dependencies");
    }

    #[test]
    fn two_js_lockfiles_in_one_folder_share_one_node_modules() {
        let f = dependency_folders(&s(&["yarn.lock", "package-lock.json"]));
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].lockfiles, s(&["yarn.lock", "package-lock.json"]));
    }

    struct Fixture {
        _tmp: TempDir,
        wt: PathBuf,
        main: PathBuf,
        other: PathBuf,
    }

    fn fixture() -> Fixture {
        let tmp = TempDir::new().unwrap();
        let wt = tmp.path().join("wt");
        let main = tmp.path().join("main");
        let other = tmp.path().join("other");
        for d in [&wt, &main, &other] {
            fs::create_dir_all(d).unwrap();
            fs::write(d.join("package-lock.json"), "lock-v1").unwrap();
        }
        fs::create_dir_all(main.join("node_modules/dep")).unwrap();
        fs::write(main.join("node_modules/dep/index.js"), "main").unwrap();
        fs::create_dir_all(other.join("node_modules/dep")).unwrap();
        fs::write(other.join("node_modules/dep/index.js"), "other").unwrap();
        Fixture {
            _tmp: tmp,
            wt,
            main,
            other,
        }
    }

    fn folders() -> Vec<DependencyFolder> {
        dependency_folders(&s(&["package-lock.json"]))
    }

    /// Copies instead of cloning, so the matching logic is tested the same
    /// on every file system.
    fn copying_clone(src: &Path, dst: &Path) -> Result<CloneMethod, CloneError> {
        fn copy(src: &Path, dst: &Path) {
            fs::create_dir_all(dst).unwrap();
            for e in fs::read_dir(src).unwrap() {
                let e = e.unwrap();
                if e.file_type().unwrap().is_dir() {
                    copy(&e.path(), &dst.join(e.file_name()));
                } else {
                    fs::copy(e.path(), dst.join(e.file_name())).unwrap();
                }
            }
        }
        copy(src, dst);
        Ok(CloneMethod::Clonefile)
    }

    #[test]
    fn matching_lockfile_clones_from_the_project_folder_first() {
        let f = fixture();
        let r = setup_dependencies(
            &f.wt,
            &folders(),
            &[f.main.clone(), f.other.clone()],
            &copying_clone,
        );
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].status, DependencyStatus::Cloned);
        assert_eq!(r[0].method, Some(CloneMethod::Clonefile));
        assert_eq!(r[0].source.as_deref(), Some(f.main.to_str().unwrap()));
        assert_eq!(
            fs::read_to_string(f.wt.join("node_modules/dep/index.js")).unwrap(),
            "main"
        );
    }

    #[test]
    fn a_worktree_with_the_same_lockfile_is_used_when_the_project_folder_differs() {
        let f = fixture();
        fs::write(f.main.join("package-lock.json"), "lock-v2").unwrap();
        let r = setup_dependencies(
            &f.wt,
            &folders(),
            &[f.main.clone(), f.other.clone()],
            &copying_clone,
        );
        assert_eq!(r[0].status, DependencyStatus::Cloned);
        assert_eq!(r[0].source.as_deref(), Some(f.other.to_str().unwrap()));
        assert_eq!(
            fs::read_to_string(f.wt.join("node_modules/dep/index.js")).unwrap(),
            "other"
        );
    }

    #[test]
    fn line_endings_do_not_change_a_text_lockfile() {
        let tmp = TempDir::new().unwrap();
        let p = |n: &str| tmp.path().join(n);
        fs::write(p("lf.json"), "{\n  \"v\": 1\n}\n").unwrap();
        fs::write(p("crlf.json"), "{\r\n  \"v\": 1\r\n}\r\n").unwrap();
        fs::write(p("other.json"), "{\r\n  \"v\": 2\r\n}\r\n").unwrap();
        assert!(same_lockfile(&p("lf.json"), &p("crlf.json")));
        assert!(!same_lockfile(&p("lf.json"), &p("other.json")));
        assert!(!same_lockfile(&p("lf.json"), &p("missing.json")));

        // A binary lockfile must match exactly.
        fs::write(p("a.lockb"), b"ab\ncd").unwrap();
        fs::write(p("b.lockb"), b"ab\r\ncd").unwrap();
        assert!(!same_lockfile(&p("a.lockb"), &p("b.lockb")));
        assert!(same_lockfile(&p("a.lockb"), &p("a.lockb")));
    }

    #[test]
    fn a_changed_lockfile_clones_nothing() {
        let f = fixture();
        fs::write(f.wt.join("package-lock.json"), "lock-v3").unwrap();
        let r = setup_dependencies(
            &f.wt,
            &folders(),
            &[f.main.clone(), f.other.clone()],
            &copying_clone,
        );
        assert_eq!(r[0].status, DependencyStatus::LockfileChanged);
        assert!(!f.wt.join("node_modules").exists());
    }

    #[test]
    fn nothing_installed_anywhere_clones_nothing() {
        let f = fixture();
        fs::remove_dir_all(f.main.join("node_modules")).unwrap();
        fs::remove_dir_all(f.other.join("node_modules")).unwrap();
        let r = setup_dependencies(
            &f.wt,
            &folders(),
            &[f.main.clone(), f.other.clone()],
            &copying_clone,
        );
        assert_eq!(r[0].status, DependencyStatus::NotInstalledElsewhere);
    }

    #[test]
    fn an_existing_folder_is_left_alone() {
        let f = fixture();
        fs::create_dir_all(f.wt.join("node_modules")).unwrap();
        fs::write(f.wt.join("node_modules/mine"), "keep").unwrap();
        let r = setup_dependencies(
            &f.wt,
            &folders(),
            std::slice::from_ref(&f.main),
            &copying_clone,
        );
        assert_eq!(r[0].status, DependencyStatus::AlreadyThere);
        assert_eq!(
            fs::read_to_string(f.wt.join("node_modules/mine")).unwrap(),
            "keep"
        );
        assert!(!f.wt.join("node_modules/dep").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_node_modules_is_not_a_source() {
        let f = fixture();
        fs::remove_dir_all(f.main.join("node_modules")).unwrap();
        std::os::unix::fs::symlink(f.other.join("node_modules"), f.main.join("node_modules"))
            .unwrap();
        let r = setup_dependencies(
            &f.wt,
            &folders(),
            std::slice::from_ref(&f.main),
            &copying_clone,
        );
        assert_eq!(r[0].status, DependencyStatus::NotInstalledElsewhere);
    }

    #[test]
    fn an_unsupported_disk_is_reported_once_and_not_retried() {
        let tmp = TempDir::new().unwrap();
        let wt = tmp.path().join("wt");
        let main = tmp.path().join("main");
        for d in [&wt, &main] {
            fs::create_dir_all(d.join("a")).unwrap();
            fs::write(d.join("package-lock.json"), "x").unwrap();
            fs::write(d.join("a/yarn.lock"), "y").unwrap();
        }
        fs::create_dir_all(main.join("node_modules")).unwrap();
        fs::create_dir_all(main.join("a/node_modules")).unwrap();
        let calls = std::cell::Cell::new(0);
        let unsupported = |_s: &Path, _d: &Path| {
            calls.set(calls.get() + 1);
            Err(CloneError::Unsupported("no copy-on-write here".into()))
        };
        let folders = dependency_folders(&s(&["package-lock.json", "a/yarn.lock"]));
        let r = setup_dependencies(&wt, &folders, std::slice::from_ref(&main), &unsupported);
        assert_eq!(calls.get(), 1, "the second folder is not attempted");
        assert!(r
            .iter()
            .all(|e| e.status == DependencyStatus::CopyOnWriteUnavailable));
        assert!(r
            .iter()
            .all(|e| e.detail.as_deref() == Some("no copy-on-write here")));
        assert!(!wt.join("node_modules").exists());
    }

    #[test]
    fn a_failed_clone_is_reported_with_its_reason() {
        let f = fixture();
        let failing = |_s: &Path, _d: &Path| Err(CloneError::Failed("permission denied".into()));
        let r = setup_dependencies(&f.wt, &folders(), std::slice::from_ref(&f.main), &failing);
        assert_eq!(r[0].status, DependencyStatus::Failed);
        assert_eq!(r[0].detail.as_deref(), Some("permission denied"));
    }

    /// End to end on a real repo with real worktrees and the real cloner.
    #[test]
    fn prepare_dependencies_on_a_real_repo() {
        let tmp = TempDir::new().unwrap();
        let repo = tmp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        let git = |dir: &Path, args: &[&str]| {
            let out = Command::new("git")
                .arg("-C")
                .arg(dir)
                .args([
                    "-c",
                    "user.email=t@example.com",
                    "-c",
                    "user.name=T",
                    "-c",
                    "commit.gpgsign=false",
                ])
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&repo, &["init", "-q", "-b", "main"]);
        fs::write(repo.join(".gitignore"), "node_modules/\n").unwrap();
        fs::write(repo.join("package-lock.json"), "{\"v\":1}").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        fs::create_dir_all(repo.join("node_modules/dep")).unwrap();
        fs::write(
            repo.join("node_modules/dep/index.js"),
            "module.exports = 1;",
        )
        .unwrap();

        let wt = tmp.path().join("wt");
        git(
            &repo,
            &["worktree", "add", "-q", "-b", "task", wt.to_str().unwrap()],
        );
        let r = prepare_dependencies(&repo, &wt);
        assert_eq!(r.len(), 1);
        match r[0].status {
            DependencyStatus::Cloned => {
                assert_eq!(
                    fs::read_to_string(wt.join("node_modules/dep/index.js")).unwrap(),
                    "module.exports = 1;"
                );
            }
            // ext4 / NTFS on CI runners.
            DependencyStatus::CopyOnWriteUnavailable => assert!(!wt.join("node_modules").exists()),
            other => panic!("unexpected {other:?}: {:?}", r[0].detail),
        }
        let candidates = candidate_checkouts(&repo, &wt);
        assert_eq!(
            candidates.len(),
            1,
            "the new worktree is not its own source"
        );
        assert!(worktree_same(&candidates[0], &repo));
    }

    fn worktree_same(a: &Path, b: &Path) -> bool {
        fs::canonicalize(a).unwrap() == fs::canonicalize(b).unwrap()
    }

    #[test]
    fn port_blocks_skip_recorded_and_busy_ones() {
        let none: HashSet<u16> = HashSet::new();
        let all_free = |_p: u16| true;
        assert_eq!(
            pick_port_block(&none, &all_free),
            Some(PortBlock {
                base: 21_000,
                count: 10
            })
        );

        let taken: HashSet<u16> = [21_000, 21_010].into_iter().collect();
        assert_eq!(pick_port_block(&taken, &all_free).unwrap().base, 21_020);

        // One busy port rules out its whole block.
        let busy = |p: u16| p != 21_005;
        assert_eq!(pick_port_block(&none, &busy).unwrap().base, 21_010);

        let nothing_free = |_p: u16| false;
        assert_eq!(pick_port_block(&none, &nothing_free), None);
    }

    #[test]
    fn a_block_is_probed_all_at_once() {
        // Every probe of a free port lasting a whole timeout (as on Windows)
        // must cost one timeout per block, not ten.
        let slow = |_p: u16| {
            std::thread::sleep(std::time::Duration::from_millis(200));
            true
        };
        let started = std::time::Instant::now();
        assert_eq!(
            pick_port_block(&HashSet::new(), &slow).unwrap().base,
            21_000
        );
        let took = started.elapsed();
        assert!(
            took < std::time::Duration::from_millis(1_000),
            "ten 200 ms probes took {took:?}"
        );
    }

    #[test]
    fn port_block_env_names_the_first_port_and_the_size() {
        let b = PortBlock {
            base: 21_030,
            count: 10,
        };
        let env = b.env();
        assert_eq!(env[0], ("PORT", "21030".to_string()));
        assert_eq!(env[1], ("HERMES_PORT_BASE", "21030".to_string()));
        assert_eq!(env[2], ("HERMES_PORT_COUNT", "10".to_string()));
    }

    #[test]
    fn a_listening_port_is_not_free() {
        // The server stays open for the whole check. (Closing a probe and
        // binding its port again raced the other tests, which take ports
        // from the same pool while they run in parallel.)
        let server = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = server.local_addr().unwrap().port();
        assert!(!port_is_free(port), "a server on {port} makes it busy");
        assert!(
            !port_is_free(port),
            "still busy on a second look while the server is open"
        );
        drop(server);
    }

    #[test]
    fn a_port_nothing_listens_on_is_free() {
        // The OS hands out a fresh port, which is closed again before the
        // check. Another test running in parallel may take that same port
        // in between, so a busy answer is retried on another fresh port;
        // only a port_is_free that never says "free" fails every attempt.
        let free = (0..10).any(|_| {
            let probe = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let port = probe.local_addr().unwrap().port();
            drop(probe);
            port_is_free(port)
        });
        assert!(free, "ten ports nothing listens on all looked busy");
    }

    #[test]
    fn a_port_only_listening_on_ipv6_loopback_is_not_free() {
        // 127.0.0.1 can still be bound on that port; only the ::1 probe
        // sees the server.
        let Ok(server) = std::net::TcpListener::bind(("::1", 0)) else {
            eprintln!("no IPv6 loopback on this machine: nothing to check");
            return;
        };
        let port = server.local_addr().unwrap().port();
        assert!(
            !port_is_free(port),
            "a server on [::1]:{port} makes it busy"
        );
        drop(server);
    }

    #[test]
    fn setup_report_round_trips_as_json() {
        let setup = WorktreeSetup {
            ports: Some(PortBlock {
                base: 21_000,
                count: 10,
            }),
            dependencies: vec![DependencySetup {
                folder: "node_modules".into(),
                kind: "dependencies".into(),
                lockfiles: vec!["package-lock.json".into()],
                status: DependencyStatus::Cloned,
                method: Some(CloneMethod::Reflink),
                source: Some("/srv/n17/repo".into()),
                millis: 12,
                detail: None,
            }],
            millis: 15,
        };
        let json = serde_json::to_string(&setup).unwrap();
        assert!(json.contains("\"status\":\"cloned\""));
        assert!(json.contains("\"method\":\"reflink\""));
        let back: WorktreeSetup = serde_json::from_str(&json).unwrap();
        assert_eq!(back, setup);

        assert_eq!(
            WorktreeSetup::from_record(Some(21_000), Some(&json)),
            Some(setup.clone())
        );
        let moved = WorktreeSetup::from_record(Some(21_040), Some(&json)).unwrap();
        assert_eq!(
            moved.ports.unwrap().base,
            21_040,
            "the recorded column wins"
        );
        assert_eq!(
            WorktreeSetup::from_record(Some(21_000), None),
            None,
            "never prepared"
        );
        assert_eq!(WorktreeSetup::from_record(None, Some("not json")), None);
    }
}
