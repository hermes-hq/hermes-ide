//! Disk guard and worktree hygiene.
//!
//! - How much free space the disk holding Hermes worktrees has, and a guard
//!   that refuses to create a worktree when it is under 10 GB.
//! - How much disk each worktree uses, and how much of that is build output
//!   (`node_modules`, `target`, `dist`) that can be rebuilt.
//! - Removing that build output, but only folders git ignores and that hold
//!   no tracked file.
//! - Finding worktree folders under `hermes-worktrees/` that no session owns
//!   (orphans), across every repo — including repos Hermes no longer knows —
//!   and removing them.
//!
//! Everything here is plain file-system and git work, the same for every
//! agent.

use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::journal;
use super::worktree;

/// Below this much free space Hermes refuses to create a worktree.
/// Decimal gigabytes, the unit the OS shows people.
pub const MIN_FREE_BYTES_FOR_WORKTREE: u64 = 10_000_000_000;

/// Folder names treated as build output. Only removed when git ignores the
/// folder and no file inside it is tracked.
pub const BUILD_OUTPUT_DIRS: &[&str] = &["node_modules", "target", "dist"];

/// Event the app emits for something that needs the person's attention. The
/// attention inbox will list these; until it exists the frontend shows the
/// same text where the action failed.
pub const INBOX_ITEM_EVENT: &str = "hermes-inbox-item";

/// How deep to look for build output inside a worktree (monorepos keep
/// `packages/*/node_modules`).
const MAX_SCAN_DEPTH: usize = 8;

// ─── Free space ─────────────────────────────────────────────────────

/// Free space available to this user on the disk that holds `path` (the
/// nearest existing ancestor when `path` does not exist yet).
pub fn free_space_bytes(path: &Path) -> Result<u64, String> {
    if let Some(bytes) = free_space_override() {
        return Ok(bytes);
    }
    let existing = nearest_existing_ancestor(path)
        .ok_or_else(|| format!("No existing folder above '{}'", path.display()))?;
    os_free_space(&existing)
}

fn nearest_existing_ancestor(path: &Path) -> Option<PathBuf> {
    path.ancestors().find(|p| p.exists()).map(Path::to_path_buf)
}

#[cfg(unix)]
#[allow(clippy::unnecessary_cast)] // statvfs field widths differ between platforms
fn os_free_space(path: &Path) -> Result<u64, String> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c_path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| format!("Path contains a NUL byte: '{}'", path.display()))?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: c_path is a valid NUL-terminated string and stat a writable struct.
    let rc = unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) };
    if rc != 0 {
        return Err(format!(
            "Could not read free space for '{}': {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok((stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
}

#[cfg(windows)]
fn os_free_space(path: &Path) -> Result<u64, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut available: u64 = 0;
    // SAFETY: wide is NUL-terminated; the out pointer is valid; the other
    // outputs are optional and passed as null.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(format!(
            "Could not read free space for '{}': {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(available)
}

/// Test builds only: `HERMES_E2E_FREE_SPACE_BYTES` pretends the disk has that
/// much free space, so the real-app scenario can prove the refusal without
/// filling a disk. Needs the `e2e` cargo feature (never in a release build)
/// AND `HERMES_E2E=1` at run time.
fn free_space_override() -> Option<u64> {
    #[cfg(feature = "e2e")]
    {
        parse_free_space_override(
            std::env::var("HERMES_E2E").ok().as_deref(),
            std::env::var("HERMES_E2E_FREE_SPACE_BYTES").ok().as_deref(),
        )
    }
    #[cfg(not(feature = "e2e"))]
    {
        None
    }
}

#[cfg(any(test, feature = "e2e"))]
fn parse_free_space_override(e2e: Option<&str>, value: Option<&str>) -> Option<u64> {
    if !crate::e2e_protocol::is_enabled(e2e) {
        return None;
    }
    value?.trim().parse().ok()
}

/// "4.2 GB" — decimal units, one decimal under 100. Rounds down, so a disk
/// just under the guard never reads as having the space it lacks.
pub fn format_gb(bytes: u64) -> String {
    if bytes >= 100_000_000_000 {
        format!("{} GB", bytes / 1_000_000_000)
    } else {
        let tenths = bytes / 100_000_000;
        format!("{}.{} GB", tenths / 10, tenths % 10)
    }
}

/// The disk is too full to create a worktree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LowDiskSpace {
    pub free_bytes: u64,
    pub required_bytes: u64,
}

/// Every refusal message starts with this, so the frontend can recognise it.
pub const LOW_DISK_MESSAGE_PREFIX: &str = "Not enough free disk space";

impl LowDiskSpace {
    pub fn message(&self) -> String {
        format!(
            "{}: {} free, {} needed to create a worktree. Nothing was created. \
             Free up space (Git panel > Worktrees can remove orphaned folders and build output), then try again.",
            LOW_DISK_MESSAGE_PREFIX,
            format_gb(self.free_bytes),
            format_gb(self.required_bytes),
        )
    }

    /// The item the attention inbox will show.
    pub fn inbox_item(&self, project_name: &str) -> InboxItem {
        InboxItem {
            id: format!("disk-low-{}", uuid::Uuid::new_v4()),
            kind: "disk_low".to_string(),
            section: "blocked".to_string(),
            source: "disk-guard".to_string(),
            title: format!("Low disk space: could not start work in {}", project_name),
            detail: self.message(),
            created_at: chrono::Utc::now().to_rfc3339(),
            free_bytes: self.free_bytes,
            required_bytes: self.required_bytes,
        }
    }
}

/// Payload of `INBOX_ITEM_EVENT`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub id: String,
    /// What happened, machine-readable ("disk_low").
    pub kind: String,
    /// Inbox section: "blocked" (needs you) or "ready".
    pub section: String,
    pub source: String,
    pub title: String,
    pub detail: String,
    pub created_at: String,
    pub free_bytes: u64,
    pub required_bytes: u64,
}

/// Ok when `free_bytes` leaves room for a new worktree.
pub fn check_room(free_bytes: u64) -> Result<(), LowDiskSpace> {
    if free_bytes < MIN_FREE_BYTES_FOR_WORKTREE {
        Err(LowDiskSpace {
            free_bytes,
            required_bytes: MIN_FREE_BYTES_FOR_WORKTREE,
        })
    } else {
        Ok(())
    }
}

/// Ok when the disk holding `app_data_dir`'s worktrees has room for a new
/// worktree. When free space cannot be read, creation is allowed (logged):
/// the guard must never block work because of its own failure.
pub fn check_room_for_worktree(app_data_dir: &Path) -> Result<(), LowDiskSpace> {
    match free_space_bytes(&worktree::worktrees_base_dir(app_data_dir)) {
        Ok(free) => check_room(free),
        Err(e) => {
            log::warn!("[disk-guard] {} — not blocking worktree creation", e);
            Ok(())
        }
    }
}

// ─── Disk usage ─────────────────────────────────────────────────────

/// Bytes used by the files under `path`. Symbolic links are counted as links
/// and never followed.
pub fn dir_size(path: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return 0;
    };
    if !meta.is_dir() {
        return meta.len();
    }
    let mut size = 0;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            size += dir_size(&entry.path());
        }
    }
    size
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct WorktreeUsage {
    pub path: String,
    pub total_bytes: u64,
    /// The part of `total_bytes` that "Remove build output" would free.
    pub build_output_bytes: u64,
}

pub fn worktree_usage(path: &Path) -> WorktreeUsage {
    let build_output_bytes = removable_build_output(path)
        .iter()
        .map(|p| dir_size(p))
        .sum();
    WorktreeUsage {
        path: path.to_string_lossy().to_string(),
        total_bytes: dir_size(path),
        build_output_bytes,
    }
}

// ─── Build output ───────────────────────────────────────────────────

/// Folders named like build output under `root`, not descending into them,
/// into `.git`, or through symbolic links.
fn build_output_candidates(root: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
        if depth > MAX_SCAN_DEPTH {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() || file_type.is_symlink() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == ".git" {
                continue;
            }
            let path = entry.path();
            if BUILD_OUTPUT_DIRS.contains(&name.as_ref()) {
                out.push(path);
            } else {
                walk(&path, depth + 1, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, 0, &mut out);
    out.sort();
    out
}

fn git_in(worktree: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(worktree);
    cmd
}

/// True when git ignores `rel` in `worktree` and tracks no file under it.
/// Any git failure answers false: when in doubt, keep the folder.
fn is_ignored_and_untracked(worktree: &Path, rel: &Path) -> bool {
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    let ignored = [rel_str.clone(), format!("{}/", rel_str)].iter().any(|p| {
        git_in(worktree)
            .args(["check-ignore", "-q", "--", p])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    });
    if !ignored {
        return false;
    }
    match git_in(worktree)
        .args(["ls-files", "-z", "--", &rel_str])
        .output()
    {
        Ok(o) if o.status.success() => o.stdout.is_empty(),
        _ => false,
    }
}

/// Build-output folders in `worktree` that are safe to delete.
pub fn removable_build_output(worktree: &Path) -> Vec<PathBuf> {
    build_output_candidates(worktree)
        .into_iter()
        .filter(|p| {
            p.strip_prefix(worktree)
                .map(|rel| is_ignored_and_untracked(worktree, rel))
                .unwrap_or(false)
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ReclaimResult {
    pub path: String,
    /// Folders removed, relative to the worktree ("packages/web/node_modules").
    pub removed: Vec<String>,
    pub freed_bytes: u64,
    /// Folders that could not be removed, with the reason.
    pub failed: Vec<String>,
}

/// Remove the build output of one worktree. See `removable_build_output`.
pub fn reclaim_build_output(worktree: &Path) -> ReclaimResult {
    let mut result = ReclaimResult {
        path: worktree.to_string_lossy().to_string(),
        ..Default::default()
    };
    for dir in removable_build_output(worktree) {
        let rel = dir
            .strip_prefix(worktree)
            .unwrap_or(&dir)
            .to_string_lossy()
            .replace('\\', "/");
        let size = dir_size(&dir);
        match fs::remove_dir_all(&dir) {
            Ok(()) => {
                result.freed_bytes += size;
                result.removed.push(rel);
            }
            Err(e) => {
                // Partly removed: count what is gone.
                result.freed_bytes += size.saturating_sub(dir_size(&dir));
                result.failed.push(format!("{}: {}", rel, e));
            }
        }
    }
    result
}

// ─── Paths ──────────────────────────────────────────────────────────

fn canonical(path: &Path) -> Option<PathBuf> {
    dunce::canonicalize(path).ok()
}

/// `path` is a folder exactly two levels under the worktrees base folder
/// (`hermes-worktrees/<repo hash>/<worktree>`), after resolving links. The
/// only shape of folder this module ever deletes.
pub fn is_worktree_folder(base: &Path, path: &Path) -> bool {
    let (Some(base), Some(path)) = (canonical(base), canonical(path)) else {
        return false;
    };
    if !path.is_dir() {
        return false;
    }
    path.parent().and_then(Path::parent) == Some(base.as_path())
}

// ─── Orphans ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct OrphanFolder {
    pub worktree_path: String,
    /// The repo this folder was made from (from `repo_path.txt`).
    pub repo_path: Option<String>,
    /// False when that repo is gone from disk.
    pub repo_exists: bool,
    /// Branch name guessed from the folder name.
    pub branch_hint: Option<String>,
}

/// Worktree folders under `base` that no session owns: not in `known_paths`
/// (the worktrees recorded in the database) and not being created right now
/// (an unfinished CREATE in that repo's journal).
pub fn scan_orphan_folders(base: &Path, known_paths: &HashSet<PathBuf>) -> Vec<OrphanFolder> {
    let known: HashSet<PathBuf> = known_paths
        .iter()
        .map(|p| canonical(p).unwrap_or_else(|| p.clone()))
        .collect();
    let mut orphans = Vec::new();
    let Ok(hash_dirs) = fs::read_dir(base) else {
        return orphans;
    };
    for hash_dir in hash_dirs.flatten() {
        let hash_dir = hash_dir.path();
        if !hash_dir.is_dir() {
            continue;
        }
        let repo_path = worktree::read_repo_path(&hash_dir).map(|s| s.trim().to_string());
        let repo_exists = repo_path.as_deref().is_some_and(|p| Path::new(p).is_dir());
        let in_progress: HashSet<PathBuf> =
            journal::incomplete_operations_in(&hash_dir.join(journal::JOURNAL_FILENAME))
                .into_iter()
                .filter(|e| e.action == "CREATE")
                .map(|e| PathBuf::from(e.worktree_path))
                .map(|p| canonical(&p).unwrap_or(p))
                .collect();
        let Ok(entries) = fs::read_dir(&hash_dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() || file_type.is_symlink() {
                continue;
            }
            let resolved = canonical(&path).unwrap_or_else(|| path.clone());
            if known.contains(&resolved) || in_progress.contains(&resolved) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            orphans.push(OrphanFolder {
                worktree_path: path.to_string_lossy().to_string(),
                repo_path: repo_path.clone(),
                repo_exists,
                branch_hint: name.split_once('_').map(|(_, b)| b.to_string()),
            });
        }
    }
    orphans.sort_by(|a, b| a.worktree_path.cmp(&b.worktree_path));
    orphans
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SweepResult {
    pub path: String,
    pub removed: bool,
    pub freed_bytes: u64,
    pub error: Option<String>,
}

/// Remove the orphaned worktree folders among `requested`. A path is only
/// touched when a fresh scan still finds it orphaned and it has the shape of
/// a worktree folder; anything else is reported and left alone. Afterwards
/// git's worktree records are pruned, and a repo folder whose repo is gone
/// and that holds no worktree any more is removed.
pub fn sweep_orphan_folders(
    base: &Path,
    known_paths: &HashSet<PathBuf>,
    requested: &[String],
) -> Vec<SweepResult> {
    let orphans = scan_orphan_folders(base, known_paths);
    let mut results = Vec::new();
    let mut repos_to_prune: HashSet<String> = HashSet::new();
    let mut hash_dirs: HashSet<PathBuf> = HashSet::new();

    for path in requested {
        let Some(orphan) = orphans.iter().find(|o| same_path(&o.worktree_path, path)) else {
            results.push(SweepResult {
                path: path.clone(),
                removed: false,
                freed_bytes: 0,
                error: Some("Not an orphaned worktree folder (any more); left alone".to_string()),
            });
            continue;
        };
        let dir = PathBuf::from(&orphan.worktree_path);
        if !is_worktree_folder(base, &dir) {
            results.push(SweepResult {
                path: path.clone(),
                removed: false,
                freed_bytes: 0,
                error: Some("Not inside the Hermes worktrees folder; left alone".to_string()),
            });
            continue;
        }
        let size = dir_size(&dir);
        match fs::remove_dir_all(&dir) {
            Ok(()) => {
                if let (Some(repo), true) = (&orphan.repo_path, orphan.repo_exists) {
                    repos_to_prune.insert(repo.clone());
                }
                if let Some(parent) = dir.parent() {
                    hash_dirs.insert(parent.to_path_buf());
                }
                results.push(SweepResult {
                    path: path.clone(),
                    removed: true,
                    freed_bytes: size,
                    error: None,
                });
            }
            Err(e) => results.push(SweepResult {
                path: path.clone(),
                removed: false,
                freed_bytes: size.saturating_sub(dir_size(&dir)),
                error: Some(e.to_string()),
            }),
        }
    }

    for repo in &repos_to_prune {
        let _ = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["worktree", "prune"])
            .output();
    }
    for hash_dir in hash_dirs {
        remove_hash_dir_if_abandoned(base, &hash_dir);
    }
    results
}

fn same_path(a: &str, b: &str) -> bool {
    let (pa, pb) = (Path::new(a), Path::new(b));
    pa == pb || (canonical(pa).is_some() && canonical(pa) == canonical(pb))
}

/// Remove `hermes-worktrees/<hash>/` when it holds no worktree folder and
/// the repo it was made for no longer exists.
fn remove_hash_dir_if_abandoned(base: &Path, hash_dir: &Path) {
    let (Some(base_c), Some(dir_c)) = (canonical(base), canonical(hash_dir)) else {
        return;
    };
    if dir_c.parent() != Some(base_c.as_path()) {
        return;
    }
    let repo_exists =
        worktree::read_repo_path(&dir_c).is_some_and(|p| Path::new(p.trim()).is_dir());
    if repo_exists {
        return;
    }
    let has_subdir = fs::read_dir(&dir_c)
        .map(|entries| entries.flatten().any(|e| e.path().is_dir()))
        .unwrap_or(true);
    if !has_subdir {
        let _ = fs::remove_dir_all(&dir_c);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn write(path: &Path, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![b'x'; bytes]).unwrap();
    }

    /// A repo whose .gitignore lists the build folders, with one `dist`
    /// folder that is committed anyway (it must never be removed).
    fn repo_with_build_output() -> TempDir {
        let dir = TempDir::new().unwrap();
        let p = dir.path();
        git(p, &["init", "-q"]);
        git(p, &["config", "user.email", "test@example.com"]);
        git(p, &["config", "user.name", "Test"]);
        git(p, &["config", "commit.gpgsign", "false"]);
        fs::write(p.join(".gitignore"), "node_modules/\ntarget/\ndist/\n").unwrap();
        write(&p.join("src/main.rs"), 100);
        write(&p.join("docs/dist/index.html"), 50);
        git(p, &["add", ".gitignore", "src"]);
        git(p, &["add", "-f", "docs/dist/index.html"]);
        git(p, &["commit", "-q", "-m", "init"]);
        // Build output (ignored, untracked).
        write(&p.join("node_modules/a/index.js"), 4000);
        write(&p.join("packages/web/node_modules/b/index.js"), 3000);
        write(&p.join("target/debug/app"), 2000);
        write(&p.join("dist/bundle.js"), 1000);
        // Named like build output but NOT ignored: must be kept.
        write(&p.join("vendor/target/keep.txt"), 10);
        fs::write(p.join(".gitignore"), "node_modules/\n/target/\ndist/\n").unwrap();
        dir
    }

    #[test]
    fn free_space_guard_refuses_under_10_gb_and_allows_at_10_gb() {
        let low = check_room(9_999_999_999).unwrap_err();
        assert_eq!(low.free_bytes, 9_999_999_999);
        assert_eq!(low.required_bytes, 10_000_000_000);
        assert!(check_room(10_000_000_000).is_ok());
        assert!(check_room(500_000_000_000).is_ok());
    }

    #[test]
    fn refusal_message_names_the_numbers_and_the_way_out() {
        let msg = check_room(4_200_000_000).unwrap_err().message();
        assert!(msg.starts_with(LOW_DISK_MESSAGE_PREFIX), "{}", msg);
        assert!(msg.contains("4.2 GB free"), "{}", msg);
        assert!(msg.contains("10.0 GB needed"), "{}", msg);
        assert!(msg.contains("Nothing was created"), "{}", msg);
    }

    #[test]
    fn inbox_item_payload_is_camel_case_and_blocked() {
        let item = check_room(1_000_000_000).unwrap_err().inbox_item("demo");
        let json = serde_json::to_value(&item).unwrap();
        assert_eq!(json["kind"], "disk_low");
        assert_eq!(json["section"], "blocked");
        assert_eq!(json["source"], "disk-guard");
        assert_eq!(json["freeBytes"], 1_000_000_000u64);
        assert_eq!(json["requiredBytes"], 10_000_000_000u64);
        assert!(json["title"].as_str().unwrap().contains("demo"));
        assert!(json["createdAt"].as_str().is_some());
    }

    #[test]
    fn format_gb_uses_decimal_units() {
        assert_eq!(format_gb(0), "0.0 GB");
        assert_eq!(format_gb(10_000_000_000), "10.0 GB");
        assert_eq!(format_gb(250_000_000_000), "250 GB");
        assert_eq!(format_gb(4_200_000_000), "4.2 GB");
        // Just under the guard must not read as "10.0 GB".
        assert_eq!(format_gb(9_999_999_999), "9.9 GB");
        assert_eq!(format_gb(99_999_999_999), "99.9 GB");
    }

    #[test]
    fn free_space_override_needs_e2e_mode() {
        assert_eq!(
            parse_free_space_override(Some("1"), Some("5000")),
            Some(5000)
        );
        assert_eq!(parse_free_space_override(None, Some("5000")), None);
        assert_eq!(parse_free_space_override(Some("0"), Some("5000")), None);
        assert_eq!(parse_free_space_override(Some("1"), Some("lots")), None);
        assert_eq!(parse_free_space_override(Some("1"), None), None);
    }

    #[cfg(not(feature = "e2e"))]
    #[test]
    fn free_space_override_is_ignored_outside_test_builds() {
        // Even with both variables set, a normal build reads the real disk.
        std::env::set_var("HERMES_E2E_FREE_SPACE_BYTES", "7");
        assert_eq!(free_space_override(), None);
        std::env::remove_var("HERMES_E2E_FREE_SPACE_BYTES");
    }

    #[test]
    fn free_space_reads_the_real_disk_for_missing_folders() {
        let dir = TempDir::new().unwrap();
        let free = free_space_bytes(&dir.path().join("not/yet/created")).unwrap();
        assert!(free > 0);
        assert!(
            !dir.path().join("not").exists(),
            "reading free space created nothing"
        );
    }

    #[test]
    fn only_ignored_untracked_build_folders_are_removable() {
        let repo = repo_with_build_output();
        let p = repo.path();
        let removable: Vec<String> = removable_build_output(p)
            .iter()
            .map(|d| {
                d.strip_prefix(p)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        assert_eq!(
            removable,
            vec![
                "dist",
                "node_modules",
                "packages/web/node_modules",
                "target"
            ]
        );
    }

    #[test]
    fn usage_reports_total_and_build_output() {
        let repo = repo_with_build_output();
        let usage = worktree_usage(repo.path());
        assert_eq!(usage.build_output_bytes, 4000 + 3000 + 2000 + 1000);
        assert!(usage.total_bytes >= usage.build_output_bytes + 160);
    }

    #[test]
    fn reclaim_removes_build_output_and_keeps_everything_else() {
        let repo = repo_with_build_output();
        let p = repo.path();
        let before = dir_size(p);
        let result = reclaim_build_output(p);
        assert_eq!(result.freed_bytes, 10_000);
        assert_eq!(result.removed.len(), 4);
        assert!(result.failed.is_empty());
        assert_eq!(dir_size(p), before - 10_000);
        assert!(!p.join("node_modules").exists());
        assert!(!p.join("packages/web/node_modules").exists());
        assert!(!p.join("target").exists());
        assert!(!p.join("dist").exists());
        assert!(p.join("docs/dist/index.html").exists(), "tracked dist kept");
        assert!(
            p.join("vendor/target/keep.txt").exists(),
            "unignored target kept"
        );
        assert!(p.join("src/main.rs").exists());
        // Idempotent.
        assert_eq!(reclaim_build_output(p).freed_bytes, 0);
    }

    #[test]
    fn reclaim_outside_a_git_repo_removes_nothing() {
        let dir = TempDir::new().unwrap();
        write(&dir.path().join("node_modules/a.js"), 100);
        let result = reclaim_build_output(dir.path());
        assert_eq!(result.freed_bytes, 0);
        assert!(dir.path().join("node_modules/a.js").exists());
    }

    #[cfg(unix)]
    #[test]
    fn reclaim_never_follows_symbolic_links() {
        let repo = repo_with_build_output();
        let outside = TempDir::new().unwrap();
        write(&outside.path().join("precious.txt"), 10);
        std::os::unix::fs::symlink(outside.path(), repo.path().join("src/linked")).unwrap();
        std::os::unix::fs::symlink(outside.path(), repo.path().join("src/dist")).unwrap();
        reclaim_build_output(repo.path());
        assert!(outside.path().join("precious.txt").exists());
    }

    /// base/<hash>/<worktree> layout with a real repo and git worktrees.
    struct Layout {
        _root: TempDir,
        base: PathBuf,
        repo: PathBuf,
        hash_dir: PathBuf,
    }

    fn layout() -> Layout {
        let root = TempDir::new().unwrap();
        let repo = root.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["config", "user.email", "test@example.com"]);
        git(&repo, &["config", "user.name", "Test"]);
        git(&repo, &["config", "commit.gpgsign", "false"]);
        fs::write(repo.join("README.md"), "x").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        let app_data = root.path().join("data");
        let hash_dir = worktree::worktree_dir(&app_data, repo.to_str().unwrap());
        Layout {
            base: worktree::worktrees_base_dir(&app_data),
            repo,
            hash_dir,
            _root: root,
        }
    }

    fn add_worktree(l: &Layout, name: &str, branch: &str) -> PathBuf {
        let path = l.hash_dir.join(name);
        git(
            &l.repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                branch,
                path.to_str().unwrap(),
            ],
        );
        path
    }

    #[test]
    fn scan_finds_unowned_folders_in_known_and_vanished_repos() {
        let l = layout();
        let owned = add_worktree(&l, "aaaaaaaa_owned", "owned");
        let orphan = add_worktree(&l, "bbbbbbbb_orphan", "orphan");
        // A folder for a repo that no longer exists.
        let gone = l.base.join("00000000deadbeef");
        fs::create_dir_all(gone.join("cccccccc_old-task")).unwrap();
        fs::write(gone.join("repo_path.txt"), "/nonexistent/test/repo").unwrap();

        let known: HashSet<PathBuf> = [owned.clone()].into_iter().collect();
        let found = scan_orphan_folders(&l.base, &known);
        let paths: Vec<&str> = found.iter().map(|o| o.worktree_path.as_str()).collect();
        assert_eq!(found.len(), 2, "{:?}", paths);
        let o = found
            .iter()
            .find(|o| Path::new(&o.worktree_path) == orphan)
            .unwrap();
        assert!(o.repo_exists);
        assert_eq!(o.branch_hint.as_deref(), Some("orphan"));
        let g = found
            .iter()
            .find(|o| o.worktree_path.contains("cccccccc_old-task"))
            .unwrap();
        assert!(!g.repo_exists);
        assert_eq!(g.repo_path.as_deref(), Some("/nonexistent/test/repo"));
    }

    #[test]
    fn scan_skips_worktrees_being_created() {
        let l = layout();
        let creating = add_worktree(&l, "dddddddd_new", "new");
        let app_data = l.base.parent().unwrap();
        journal::log_operation(
            app_data,
            l.repo.to_str().unwrap(),
            "CREATE",
            "dddddddd-session",
            "project",
            "new",
            creating.to_str().unwrap(),
        )
        .unwrap();
        assert!(scan_orphan_folders(&l.base, &HashSet::new()).is_empty());
        journal::log_completed(
            app_data,
            l.repo.to_str().unwrap(),
            "CREATE",
            "dddddddd-session",
            "project",
        )
        .unwrap();
        assert_eq!(scan_orphan_folders(&l.base, &HashSet::new()).len(), 1);
    }

    #[test]
    fn sweep_removes_orphans_prunes_git_and_keeps_owned_worktrees() {
        let l = layout();
        let owned = add_worktree(&l, "aaaaaaaa_owned", "owned");
        let orphan = add_worktree(&l, "bbbbbbbb_orphan", "orphan");
        write(&orphan.join("node_modules/x.js"), 5000);
        let gone = l.base.join("00000000deadbeef");
        write(&gone.join("cccccccc_old-task/file.txt"), 700);
        fs::write(gone.join("repo_path.txt"), "/nonexistent/test/repo").unwrap();

        let known: HashSet<PathBuf> = [owned.clone()].into_iter().collect();
        let requested: Vec<String> = scan_orphan_folders(&l.base, &known)
            .into_iter()
            .map(|o| o.worktree_path)
            .collect();
        let results = sweep_orphan_folders(&l.base, &known, &requested);
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|r| r.removed), "{:?}", results);
        assert!(results.iter().map(|r| r.freed_bytes).sum::<u64>() >= 5700);

        assert!(!orphan.exists());
        assert!(!gone.exists(), "abandoned repo folder removed");
        assert!(owned.join("README.md").exists(), "owned worktree untouched");
        assert!(
            l.hash_dir.join("repo_path.txt").exists(),
            "live repo folder kept"
        );
        let list = Command::new("git")
            .arg("-C")
            .arg(&l.repo)
            .args(["worktree", "list", "--porcelain"])
            .output()
            .unwrap();
        let list = String::from_utf8_lossy(&list.stdout);
        assert!(
            !list.contains("bbbbbbbb_orphan"),
            "git forgot the orphan: {}",
            list
        );
        assert!(list.contains("aaaaaaaa_owned"));
    }

    #[test]
    fn sweep_refuses_paths_that_are_not_orphans() {
        let l = layout();
        let owned = add_worktree(&l, "aaaaaaaa_owned", "owned");
        let known: HashSet<PathBuf> = [owned.clone()].into_iter().collect();
        let requested = vec![
            owned.to_string_lossy().to_string(),
            l.repo.to_string_lossy().to_string(),
            l.base.to_string_lossy().to_string(),
            l.hash_dir.to_string_lossy().to_string(),
        ];
        let results = sweep_orphan_folders(&l.base, &known, &requested);
        assert!(results.iter().all(|r| !r.removed), "{:?}", results);
        assert!(owned.join("README.md").exists());
        assert!(l.repo.join("README.md").exists());
        assert!(l.hash_dir.exists());
    }

    #[test]
    fn worktree_folder_shape_is_exactly_two_levels_under_base() {
        let l = layout();
        let wt = add_worktree(&l, "aaaaaaaa_x", "x");
        assert!(is_worktree_folder(&l.base, &wt));
        assert!(!is_worktree_folder(&l.base, &l.hash_dir));
        assert!(!is_worktree_folder(&l.base, &l.base));
        assert!(!is_worktree_folder(&l.base, &l.repo));
        assert!(!is_worktree_folder(&l.base, &wt.join("sub")));
    }
}
