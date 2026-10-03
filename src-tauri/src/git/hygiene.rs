//! Worktree hygiene: keep old worktrees from filling the disk without ever
//! losing work.
//!
//! Every folder under this instance's `hermes-worktrees/<repo hash>/` gets a
//! lifecycle state (open, active, idle, landed, orphaned) from three things:
//! whether a session that is open links it, how long ago it was last used,
//! and what git says about it (uncommitted files, commits that exist only
//! there, whether its branch is already merged). [`decide`] turns that into
//! what may happen automatically and what needs the person — a pure function,
//! so every safety rule is a unit test.
//!
//! Rules (see `docs` in the plan and the tests below):
//! - An open session's worktree is never touched, not even its build output.
//! - Nothing with uncommitted files or commits that exist nowhere else is
//!   removed automatically. When the person removes one, a backup snapshot
//!   is saved first ([`snapshot_backup`]) and nothing is removed if that
//!   fails. Branches are never deleted.
//! - Removal goes through `git worktree remove` (never `--force`
//!   automatically) and `git worktree prune`, so git's own records stay
//!   right. A plain folder delete only happens for a folder git no longer
//!   knows, after a backup, or — on the person's explicit say — for a folder
//!   whose repo is gone.
//! - Only folders exactly two levels under the worktrees base folder.
//!
//! Plain git and file-system work, the same on macOS, Windows and Linux and
//! for every agent.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

use super::disk_guard;
use super::journal;
use super::worktree;

/// Defaults of the three settings.
pub const DEFAULT_IDLE_DAYS: u32 = 7;
pub const DEFAULT_LOW_DISK_GB: u64 = 20;
pub const SETTING_AUTO_CLEANUP: &str = "worktree_auto_cleanup";
pub const SETTING_IDLE_DAYS: &str = "worktree_idle_days";
pub const SETTING_LOW_DISK_GB: &str = "worktree_low_disk_gb";

/// Where backups are listed (one JSON object per line), in the app-data folder.
pub const BACKUP_LOG: &str = "worktree-backups.jsonl";
/// Namespace of backup refs in the repo itself.
pub const BACKUP_REF_PREFIX: &str = "refs/hermes/backups/";

/// How many worktrees are measured at once.
const SCAN_WORKERS: usize = 4;

// ─── Settings ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HygieneSettings {
    pub auto_cleanup: bool,
    pub idle_days: u32,
    pub low_disk_bytes: u64,
}

impl Default for HygieneSettings {
    fn default() -> Self {
        Self {
            auto_cleanup: true,
            idle_days: DEFAULT_IDLE_DAYS,
            low_disk_bytes: DEFAULT_LOW_DISK_GB * 1_000_000_000,
        }
    }
}

impl HygieneSettings {
    /// From the stored values; anything missing or unreadable is the default.
    pub fn from_values(auto: Option<&str>, idle_days: Option<&str>, low_gb: Option<&str>) -> Self {
        let d = Self::default();
        Self {
            auto_cleanup: auto.map(|v| v.trim() != "false").unwrap_or(d.auto_cleanup),
            idle_days: idle_days
                .and_then(|v| v.trim().parse::<u32>().ok())
                .map(|v| v.min(3650))
                .unwrap_or(d.idle_days),
            low_disk_bytes: low_gb
                .and_then(|v| v.trim().parse::<u64>().ok())
                .map(|gb| gb.min(10_000) * 1_000_000_000)
                .unwrap_or(d.low_disk_bytes),
        }
    }
}

// ─── Decision (pure) ────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LifeState {
    /// Its session is open. Never touched.
    Open,
    /// Linked to a session that is not open, used recently.
    Active,
    /// Linked to a session that is not open, unused for the idle period.
    Idle,
    /// Not open, clean, and its branch is already merged: nothing to lose.
    Landed,
    /// No session links it.
    Orphaned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AutoAction {
    None,
    RemoveBuildOutput,
    RemoveWorktree,
}

/// Why a worktree needs the person instead of automatic cleanup.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NeedsReason {
    /// Uncommitted or untracked files.
    Changes,
    /// Commits that are on no remote branch, no other branch and no tag.
    Unpushed,
    /// The repo it was made from is gone: no backup is possible.
    RepoGone,
}

/// What git says about a worktree.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkFacts {
    /// git can read it as a worktree of its repo.
    pub git_knows: bool,
    pub branch: Option<String>,
    pub detached: bool,
    /// Changed tracked files plus untracked files git does not ignore.
    pub changed_files: u32,
    /// Commits reachable from HEAD and from no remote branch, other local
    /// branch or tag.
    pub unpushed_commits: u32,
    /// HEAD is already in the base branch.
    pub merged: bool,
}

impl WorkFacts {
    pub fn has_work(&self) -> bool {
        self.changed_files > 0 || self.unpushed_commits > 0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PolicyInput<'a> {
    /// A session that is open links this folder.
    pub open: bool,
    /// Any session links this folder.
    pub linked: bool,
    /// Last used at least `idle_days` ago.
    pub idle: bool,
    pub repo_exists: bool,
    pub facts: &'a WorkFacts,
    pub build_output_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub state: LifeState,
    pub auto_action: AutoAction,
    pub needs: Option<NeedsReason>,
    /// A removal of this worktree saves a backup snapshot first.
    pub backup_before_removal: bool,
}

/// What may happen to one worktree folder. Pure: every rule is tested.
pub fn decide(i: PolicyInput<'_>) -> Decision {
    let f = i.facts;
    if i.open {
        return Decision {
            state: LifeState::Open,
            auto_action: AutoAction::None,
            needs: None,
            backup_before_removal: false,
        };
    }
    let backup = !f.git_knows || f.has_work();
    if !i.repo_exists {
        return Decision {
            state: if i.linked {
                LifeState::Idle
            } else {
                LifeState::Orphaned
            },
            auto_action: AutoAction::None,
            needs: i.idle.then_some(NeedsReason::RepoGone),
            backup_before_removal: false,
        };
    }
    let state = if !i.linked {
        LifeState::Orphaned
    } else if f.git_knows && !f.has_work() && f.merged {
        LifeState::Landed
    } else if i.idle {
        LifeState::Idle
    } else {
        LifeState::Active
    };
    if !i.idle {
        return Decision {
            state,
            auto_action: AutoAction::None,
            needs: None,
            backup_before_removal: backup,
        };
    }
    if !f.git_knows {
        // git cannot say what is in it: a backup of every non-ignored file
        // is saved before it goes.
        return Decision {
            state,
            auto_action: AutoAction::RemoveWorktree,
            needs: None,
            backup_before_removal: true,
        };
    }
    if f.has_work() {
        return Decision {
            state,
            auto_action: if i.build_output_bytes > 0 {
                AutoAction::RemoveBuildOutput
            } else {
                AutoAction::None
            },
            needs: Some(if f.changed_files > 0 {
                NeedsReason::Changes
            } else {
                NeedsReason::Unpushed
            }),
            backup_before_removal: true,
        };
    }
    let auto_action = match state {
        LifeState::Orphaned | LifeState::Landed => AutoAction::RemoveWorktree,
        _ if i.build_output_bytes > 0 => AutoAction::RemoveBuildOutput,
        _ => AutoAction::None,
    };
    Decision {
        state,
        auto_action,
        needs: None,
        backup_before_removal: false,
    }
}

// ─── Git facts ──────────────────────────────────────────────────────

/// git that never takes optional locks, so measuring never rewrites the
/// index (which would also make an old worktree look recently used).
fn git_at(dir: &Path) -> Command {
    let mut cmd = crate::git::cli::git_command();
    cmd.arg("--no-optional-locks").arg("-C").arg(dir);
    cmd
}

fn run(cmd: &mut Command) -> Option<String> {
    let out = cmd.output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn canonical(path: &Path) -> Option<PathBuf> {
    dunce::canonicalize(path).ok()
}

/// The base branch to compare `branch` with: the one recorded when the
/// worktree was made, else the remote's default, else main/master.
fn base_ref(repo: &Path, branch: Option<&str>) -> Option<String> {
    let repo_s = repo.to_string_lossy();
    if let Some(b) = branch.and_then(|b| worktree::recorded_base_branch(&repo_s, b)) {
        return Some(b);
    }
    if let Some(head) = run(git_at(repo).args(["symbolic-ref", "-q", "refs/remotes/origin/HEAD"])) {
        return Some(head);
    }
    ["main", "master"]
        .iter()
        .find(|b| {
            run(git_at(repo).args(["rev-parse", "--verify", "-q", &format!("refs/heads/{b}")]))
                .is_some()
        })
        .map(|b| b.to_string())
}

/// What git says about the worktree at `path` of `repo`.
pub fn work_facts(repo: &Path, path: &Path) -> WorkFacts {
    let mut f = WorkFacts::default();
    let Some(top) = run(git_at(path).args(["rev-parse", "--show-toplevel"])) else {
        return f;
    };
    // Inside some other repo (a parent folder's) is not "knowing" this one.
    if canonical(Path::new(&top)) != canonical(path) {
        return f;
    }
    f.git_knows = true;
    f.branch = run(git_at(path).args(["symbolic-ref", "-q", "--short", "HEAD"]));
    f.detached = f.branch.is_none();
    f.changed_files =
        run(git_at(path).args(["status", "--porcelain=v1", "-z", "--untracked-files=normal"]))
            .map(|s| s.split('\0').filter(|e| !e.is_empty()).count() as u32)
            .unwrap_or(u32::MAX);
    let has_head = run(git_at(path).args(["rev-parse", "--verify", "-q", "HEAD"])).is_some();
    if has_head {
        let mut cmd = git_at(path);
        cmd.args(["rev-list", "--count", "HEAD", "--not"]);
        if let Some(b) = &f.branch {
            // Patterns for --branches are written without "refs/heads/".
            cmd.arg(format!("--exclude={b}"));
        }
        cmd.args(["--branches", "--remotes", "--tags"]);
        // An unreadable answer counts as work: when in doubt, keep it.
        f.unpushed_commits = run(&mut cmd)
            .and_then(|s| s.parse().ok())
            .unwrap_or(u32::MAX);
        f.merged = base_ref(repo, f.branch.as_deref()).is_some_and(|base| {
            git_at(path)
                .args(["merge-base", "--is-ancestor", "HEAD", &base])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        });
    }
    f
}

/// git's private folder for the worktree at `path` (`.git/worktrees/<name>`).
fn admin_dir(path: &Path) -> Option<PathBuf> {
    run(git_at(path).args(["rev-parse", "--absolute-git-dir"])).map(PathBuf::from)
}

// ─── Last used ──────────────────────────────────────────────────────

/// A time from the database: SQLite's `YYYY-MM-DD HH:MM:SS` (UTC) or RFC 3339.
pub fn parse_db_time(s: &str) -> Option<SystemTime> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let secs = chrono::DateTime::parse_from_rfc3339(s)
        .map(|d| d.timestamp())
        .ok()
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
                .ok()
                .map(|d| d.and_utc().timestamp())
        })?;
    u64::try_from(secs)
        .ok()
        .map(|s| SystemTime::UNIX_EPOCH + Duration::from_secs(s))
}

fn mtime(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// When the worktree was last used: the newest of what the database
/// recorded (Hermes stamps worktrees of open sessions) and git's own files
/// for it (HEAD, index, reflog), else the folder itself.
pub fn last_used(path: &Path, db_times: &[SystemTime]) -> Option<SystemTime> {
    let mut times: Vec<SystemTime> = db_times.to_vec();
    if let Some(admin) = admin_dir(path) {
        for f in ["HEAD", "index", "logs/HEAD"] {
            times.extend(mtime(&admin.join(f)));
        }
    } else {
        times.extend(mtime(path));
    }
    times.into_iter().max()
}

pub fn is_idle(last_used: Option<SystemTime>, now: SystemTime, idle_days: u32) -> bool {
    let Some(t) = last_used else {
        return true;
    };
    now.duration_since(t)
        .map(|d| d >= Duration::from_secs(u64::from(idle_days) * 86_400))
        .unwrap_or(false)
}

// ─── Sizes ──────────────────────────────────────────────────────────

/// Disk space the files under `path` take (allocated blocks where the OS
/// says, else their length). Links are counted as links, never followed.
/// Copy-on-write clones count in full: what a removal really frees is
/// measured from the free space before and after.
pub fn allocated_size(path: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return 0;
    };
    let own = file_bytes(&meta);
    if !meta.is_dir() {
        return own;
    }
    let mut size = own;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            size += allocated_size(&entry.path());
        }
    }
    size
}

#[cfg(unix)]
fn file_bytes(meta: &fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    meta.blocks().saturating_mul(512)
}

#[cfg(not(unix))]
fn file_bytes(meta: &fs::Metadata) -> u64 {
    if meta.is_dir() {
        0
    } else {
        meta.len()
    }
}

/// Total size of the disk holding `path`, when the OS says.
pub fn disk_total_bytes(path: &Path) -> Option<u64> {
    let existing = path.ancestors().find(|p| p.exists())?;
    os_disk_total(existing)
}

#[cfg(unix)]
#[allow(clippy::unnecessary_cast)] // statvfs field widths differ between platforms
fn os_disk_total(path: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c_path = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: c_path is a valid NUL-terminated string and stat a writable struct.
    let rc = unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) };
    (rc == 0).then(|| (stat.f_blocks as u64).saturating_mul(stat.f_frsize as u64))
}

#[cfg(windows)]
fn os_disk_total(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut total: u64 = 0;
    // SAFETY: wide is NUL-terminated; the out pointer is valid; the other
    // outputs are optional and passed as null.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            std::ptr::null_mut(),
            &mut total,
            std::ptr::null_mut(),
        )
    };
    (ok != 0).then_some(total)
}

// ─── Scan ───────────────────────────────────────────────────────────

/// A session's link to a worktree folder, from the database.
#[derive(Debug, Clone, Default)]
pub struct LinkRow {
    pub session_id: String,
    pub worktree_path: String,
    pub project_path: Option<String>,
    pub created_at: String,
    pub last_activity_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    pub path: String,
    pub repo_path: Option<String>,
    /// Last part of the repo path ("hermes-ide"), or the folder's when unknown.
    pub repo_name: String,
    pub repo_exists: bool,
    pub branch: Option<String>,
    pub session_ids: Vec<String>,
    #[serde(flatten)]
    pub decision: Decision,
    pub facts: WorkFacts,
    /// RFC 3339.
    pub last_used: Option<String>,
    pub total_bytes: u64,
    pub build_output_bytes: u64,
    /// What the automatic rules would free here.
    pub auto_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageReport {
    pub free_bytes: Option<u64>,
    pub disk_total_bytes: Option<u64>,
    /// Under this, new worktrees are refused.
    pub guard_bytes: u64,
    pub settings: HygieneSettings,
    pub worktrees: Vec<WorktreeEntry>,
    pub total_bytes: u64,
    /// Freed by "Clean up now" (or the automatic pass).
    pub auto_bytes: u64,
    /// Held by worktrees that need the person.
    pub needs_bytes: u64,
    pub scanned_at: String,
}

/// Worktree folders under `base`, skipping those being created right now.
fn worktree_folders(base: &Path) -> Vec<(PathBuf, Option<String>)> {
    let mut out = Vec::new();
    let Ok(hash_dirs) = fs::read_dir(base) else {
        return out;
    };
    for hash_dir in hash_dirs.flatten() {
        let hash_dir = hash_dir.path();
        if !hash_dir.is_dir() {
            continue;
        }
        let repo = worktree::read_repo_path(&hash_dir).map(|s| s.trim().to_string());
        let creating: HashSet<PathBuf> =
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
            let Ok(ft) = entry.file_type() else { continue };
            if !ft.is_dir() || ft.is_symlink() {
                continue;
            }
            let p = entry.path();
            if creating.contains(&canonical(&p).unwrap_or_else(|| p.clone())) {
                continue;
            }
            out.push((p, repo.clone()));
        }
    }
    out.sort();
    out
}

fn name_of(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

fn rfc3339(t: SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339()
}

/// Everything about one folder.
pub fn inspect(
    path: &Path,
    repo_hint: Option<String>,
    links: &[&LinkRow],
    open_sessions: &HashSet<String>,
    settings: &HygieneSettings,
    now: SystemTime,
) -> WorktreeEntry {
    let repo_path = repo_hint.or_else(|| links.iter().find_map(|l| l.project_path.clone()));
    let repo_exists = repo_path.as_deref().is_some_and(|p| Path::new(p).is_dir());
    let open = links.iter().any(|l| open_sessions.contains(&l.session_id));
    let facts = match (&repo_path, repo_exists) {
        (Some(r), true) => work_facts(Path::new(r), path),
        _ => WorkFacts::default(),
    };
    let db_times: Vec<SystemTime> = links
        .iter()
        .flat_map(|l| [Some(l.created_at.as_str()), l.last_activity_at.as_deref()])
        .flatten()
        .filter_map(parse_db_time)
        .collect();
    let used = last_used(path, &db_times);
    let build_output_bytes = if open || !facts.git_knows {
        0
    } else {
        disk_guard::removable_build_output(path)
            .iter()
            .map(|p| allocated_size(p))
            .sum()
    };
    let total_bytes = allocated_size(path);
    let decision = decide(PolicyInput {
        open,
        linked: !links.is_empty(),
        idle: is_idle(used, now, settings.idle_days),
        repo_exists,
        facts: &facts,
        build_output_bytes,
    });
    let auto_bytes = match decision.auto_action {
        AutoAction::None => 0,
        AutoAction::RemoveBuildOutput => build_output_bytes,
        AutoAction::RemoveWorktree => total_bytes,
    };
    let path_s = path.to_string_lossy().to_string();
    WorktreeEntry {
        repo_name: repo_path
            .as_deref()
            .map(name_of)
            .unwrap_or_else(|| name_of(&path_s)),
        branch: facts
            .branch
            .clone()
            .or_else(|| name_of(&path_s).split_once('_').map(|(_, b)| b.to_string())),
        path: path_s,
        repo_path,
        repo_exists,
        session_ids: links.iter().map(|l| l.session_id.clone()).collect(),
        decision,
        facts,
        last_used: used.map(rfc3339),
        total_bytes,
        build_output_bytes,
        auto_bytes,
    }
}

/// Every worktree folder under `base`, measured off the caller's thread in
/// a few workers.
pub fn scan(
    base: &Path,
    links: &[LinkRow],
    open_sessions: &HashSet<String>,
    settings: &HygieneSettings,
    now: SystemTime,
) -> Vec<WorktreeEntry> {
    let mut by_path: HashMap<PathBuf, Vec<&LinkRow>> = HashMap::new();
    for l in links {
        let p = PathBuf::from(&l.worktree_path);
        by_path
            .entry(canonical(&p).unwrap_or(p))
            .or_default()
            .push(l);
    }
    let folders = worktree_folders(base);
    let next = std::sync::atomic::AtomicUsize::new(0);
    let results = std::sync::Mutex::new(Vec::with_capacity(folders.len()));
    std::thread::scope(|s| {
        for _ in 0..SCAN_WORKERS.min(folders.len().max(1)) {
            s.spawn(|| loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let Some((path, repo)) = folders.get(i) else {
                    break;
                };
                let key = canonical(path).unwrap_or_else(|| path.clone());
                let rows = by_path.get(&key).cloned().unwrap_or_default();
                let entry = inspect(path, repo.clone(), &rows, open_sessions, settings, now);
                if let Ok(mut r) = results.lock() {
                    r.push(entry);
                }
            });
        }
    });
    let mut out = results.into_inner().unwrap_or_default();
    out.sort_by(|a, b| (&a.repo_name, &a.path).cmp(&(&b.repo_name, &b.path)));
    out
}

pub fn report(
    base: &Path,
    entries: Vec<WorktreeEntry>,
    settings: HygieneSettings,
) -> StorageReport {
    let needs_bytes = entries
        .iter()
        .filter(|e| e.decision.needs.is_some())
        .map(|e| e.total_bytes.saturating_sub(e.auto_bytes))
        .sum();
    StorageReport {
        free_bytes: disk_guard::free_space_bytes(base).ok(),
        disk_total_bytes: disk_total_bytes(base),
        guard_bytes: disk_guard::MIN_FREE_BYTES_FOR_WORKTREE,
        settings,
        total_bytes: entries.iter().map(|e| e.total_bytes).sum(),
        auto_bytes: entries.iter().map(|e| e.auto_bytes).sum(),
        needs_bytes,
        worktrees: entries,
        scanned_at: rfc3339(SystemTime::now()),
    }
}

// ─── Backup ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupRecord {
    pub ref_name: String,
    pub commit: String,
    pub repo_path: String,
    pub worktree_path: String,
    pub branch: Option<String>,
    pub created_at: String,
    /// Run in the repo to get the files back as a branch.
    pub restore_command: String,
}

fn sanitize(label: &str) -> String {
    let s: String = label
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let s = s.trim_matches(|c| c == '-' || c == '.').to_string();
    if s.is_empty() {
        "worktree".into()
    } else {
        s.chars().take(60).collect()
    }
}

/// Snapshot every file of the folder that git does not ignore (build output
/// folders left out: they can be rebuilt) as a commit, kept as
/// `refs/hermes/backups/<date>-<name>` in `repo`, and list it in the backup
/// log. The commit's parent is the worktree's HEAD when git knows the folder,
/// so commits that exist only there are kept too. Uses a temporary index:
/// the worktree's own index and files are not touched.
pub fn snapshot_backup(
    app_data: &Path,
    repo: &Path,
    folder: &Path,
    git_knows: bool,
    branch: Option<&str>,
) -> Result<BackupRecord, String> {
    let index = std::env::temp_dir().join(format!("hermes-backup-{}.index", uuid::Uuid::new_v4()));
    let result = snapshot_with_index(&index, repo, folder, git_knows, branch);
    let _ = fs::remove_file(&index);
    let record = result?;
    append_backup(app_data, &record);
    Ok(record)
}

fn snapshot_with_index(
    index: &Path,
    repo: &Path,
    folder: &Path,
    git_knows: bool,
    branch: Option<&str>,
) -> Result<BackupRecord, String> {
    let common =
        run(git_at(repo).args(["rev-parse", "--path-format=absolute", "--git-common-dir"]))
            .ok_or_else(|| format!("'{}' is not a git repository", repo.display()))?;
    let cmd = |args: &[&str]| -> Command {
        let mut c = crate::git::cli::git_command();
        if git_knows {
            c.arg("-C").arg(folder);
        } else {
            c.arg("--git-dir")
                .arg(&common)
                .arg("--work-tree")
                .arg(folder)
                .current_dir(folder);
        }
        c.args(args)
            .env("GIT_INDEX_FILE", index)
            .env("GIT_AUTHOR_NAME", "Hermes")
            .env("GIT_AUTHOR_EMAIL", "hermes@localhost")
            .env("GIT_COMMITTER_NAME", "Hermes")
            .env("GIT_COMMITTER_EMAIL", "hermes@localhost");
        c
    };
    let fail = |what: &str, out: &std::process::Output| {
        format!(
            "Backup failed ({}): {}",
            what,
            String::from_utf8_lossy(&out.stderr).trim()
        )
    };
    let parent = if git_knows {
        run(git_at(folder).args(["rev-parse", "--verify", "-q", "HEAD"]))
    } else {
        None
    };
    // Start from HEAD so tracked files are kept even where an ignore rule
    // matches them; `add -A` then records every change and new file.
    if parent.is_some() {
        let out = cmd(&["read-tree", "HEAD"])
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(fail("read-tree", &out));
        }
    }
    // Build output stays out of the backup (it can be rebuilt): an extra
    // ignore file, read instead of the person's global one.
    let excludes = index.with_extension("exclude");
    let patterns: String = disk_guard::BUILD_OUTPUT_DIRS
        .iter()
        .map(|d| format!("{d}/\n"))
        .collect();
    fs::write(&excludes, patterns).map_err(|e| format!("Backup failed: {e}"))?;
    let excludes_cfg = format!("core.excludesFile={}", excludes.to_string_lossy());
    let out = cmd(&["-c", &excludes_cfg, "add", "-A", "--", "."]).output();
    let _ = fs::remove_file(&excludes);
    let out = out.map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(fail("add", &out));
    }
    let out = cmd(&["write-tree"]).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(fail("write-tree", &out));
    }
    let tree = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let folder_name = name_of(&folder.to_string_lossy());
    let message = format!("Hermes backup of {} before removing it", folder_name);
    let mut commit_args = vec!["commit-tree", tree.as_str(), "-m", message.as_str()];
    if let Some(p) = &parent {
        commit_args.extend(["-p", p.as_str()]);
    }
    let out = cmd(&commit_args).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(fail("commit-tree", &out));
    }
    let commit = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let label = sanitize(branch.unwrap_or(&folder_name));
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let mut ref_name = format!("{BACKUP_REF_PREFIX}{stamp}-{label}");
    let mut n = 2;
    while run(git_at(repo).args(["rev-parse", "--verify", "-q", &ref_name])).is_some() {
        ref_name = format!("{BACKUP_REF_PREFIX}{stamp}-{label}-{n}");
        n += 1;
    }
    let out = git_at(repo)
        .args(["update-ref", &ref_name, &commit])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(fail("update-ref", &out));
    }
    Ok(BackupRecord {
        restore_command: format!("git branch restored/{label}-{stamp} {ref_name}"),
        ref_name,
        commit,
        repo_path: repo.to_string_lossy().to_string(),
        worktree_path: folder.to_string_lossy().to_string(),
        branch: branch.map(str::to_string),
        created_at: chrono::Utc::now().to_rfc3339(),
    })
}

fn append_backup(app_data: &Path, record: &BackupRecord) {
    let Ok(line) = serde_json::to_string(record) else {
        return;
    };
    let _ = fs::create_dir_all(app_data);
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(app_data.join(BACKUP_LOG))
    {
        let _ = writeln!(f, "{line}");
    }
}

/// Backups saved before removals, newest first.
pub fn list_backups(app_data: &Path, limit: usize) -> Vec<BackupRecord> {
    let Ok(text) = fs::read_to_string(app_data.join(BACKUP_LOG)) else {
        return Vec::new();
    };
    let mut out: Vec<BackupRecord> = text
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    out.reverse();
    out.truncate(limit);
    out
}

// ─── Removal ────────────────────────────────────────────────────────

/// Who asked for a removal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Requester {
    /// The automatic pass or "Clean up now": only what [`decide`] allows.
    Automatic,
    /// The person, for this worktree. `allow_unrecoverable` is their
    /// explicit yes to deleting a folder whose repo is gone.
    Person { allow_unrecoverable: bool },
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemovalOutcome {
    pub path: String,
    pub removed: bool,
    pub backup: Option<BackupRecord>,
    pub error: Option<String>,
}

/// Remove the worktree folder at `path` safely.
///
/// - Refuses anything not exactly two levels under `base`.
/// - Re-reads git's facts now (they may have changed since the scan): the
///   automatic requester only removes when [`decide`] still says so.
/// - Saves a backup first when anything in it could be lost; a failed
///   backup removes nothing.
/// - git-known worktrees go through `git worktree remove` (`--force` only
///   after a backup, for the person) and `git worktree prune`; the branch
///   stays.
pub fn remove_worktree_safely(
    app_data: &Path,
    base: &Path,
    repo: Option<&Path>,
    path: &Path,
    linked: bool,
    requester: Requester,
) -> RemovalOutcome {
    let mut outcome = RemovalOutcome {
        path: path.to_string_lossy().to_string(),
        ..Default::default()
    };
    if !disk_guard::is_worktree_folder(base, path) {
        outcome.error = Some("Not a Hermes worktree folder; left alone".into());
        return outcome;
    }
    let repo = repo.filter(|r| r.is_dir());
    let Some(repo) = repo else {
        // The repo is gone: nothing to back up into.
        match requester {
            Requester::Person {
                allow_unrecoverable: true,
            } => match fs::remove_dir_all(path) {
                Ok(()) => outcome.removed = true,
                Err(e) => outcome.error = Some(e.to_string()),
            },
            _ => {
                outcome.error = Some(
                    "Its repo is gone, so no backup is possible; only you can delete it".into(),
                )
            }
        }
        return outcome;
    };
    let facts = work_facts(repo, path);
    if requester == Requester::Automatic {
        let d = decide(PolicyInput {
            open: false,
            linked,
            idle: true,
            repo_exists: true,
            facts: &facts,
            build_output_bytes: 0,
        });
        if d.auto_action != AutoAction::RemoveWorktree {
            outcome.error = Some("It has work in it now; left for you to decide".into());
            return outcome;
        }
    }
    let needs_backup = !facts.git_knows || facts.has_work();
    if needs_backup {
        match snapshot_backup(
            app_data,
            repo,
            path,
            facts.git_knows,
            facts.branch.as_deref(),
        ) {
            Ok(b) => outcome.backup = Some(b),
            Err(e) => {
                outcome.error = Some(format!("{e}. Nothing was removed."));
                return outcome;
            }
        }
    }
    if facts.git_knows {
        let stranded = crate::git::safety::rescue_submodule_commits(repo, path, "storage-cleanup");
        if !stranded.is_empty() {
            outcome.error = Some(crate::git::safety::stranded_message(
                &stranded,
                &outcome.path,
            ));
            return outcome;
        }
        let mut cmd = git_at(repo);
        cmd.args(["worktree", "remove"]);
        if needs_backup && outcome.backup.is_some() {
            cmd.arg("--force");
        }
        match cmd.arg(path).output() {
            Ok(o) if o.status.success() => outcome.removed = true,
            Ok(o) => {
                outcome.error = Some(String::from_utf8_lossy(&o.stderr).trim().to_string());
            }
            Err(e) => outcome.error = Some(e.to_string()),
        }
    } else {
        match fs::remove_dir_all(path) {
            Ok(()) => outcome.removed = true,
            Err(e) => outcome.error = Some(e.to_string()),
        }
    }
    let _ = git_at(repo).args(["worktree", "prune"]).output();
    outcome
}

/// Startup's orphan pass: remove the folder only when git vouches that
/// nothing in it can be lost (clean, no commits that exist only there).
/// Anything else stays for the Storage view. True when removed.
pub fn remove_orphan_if_nothing_to_lose(app_data: &Path, repo: &Path, path: &Path) -> bool {
    let facts = work_facts(repo, path);
    if !facts.git_knows || facts.has_work() {
        log::info!(
            "[hygiene] keeping orphaned worktree '{}': {}",
            path.display(),
            if facts.git_knows {
                "it has uncommitted files or commits that exist only there"
            } else {
                "git cannot say what is in it"
            }
        );
        return false;
    }
    let base = worktree::worktrees_base_dir(app_data);
    remove_worktree_safely(
        app_data,
        &base,
        Some(repo),
        path,
        false,
        Requester::Automatic,
    )
    .removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn facts(git_knows: bool, changed: u32, unpushed: u32, merged: bool) -> WorkFacts {
        WorkFacts {
            git_knows,
            branch: Some("b".into()),
            detached: false,
            changed_files: changed,
            unpushed_commits: unpushed,
            merged,
        }
    }

    fn input(f: &WorkFacts) -> PolicyInput<'_> {
        PolicyInput {
            open: false,
            linked: true,
            idle: true,
            repo_exists: true,
            facts: f,
            build_output_bytes: 1000,
        }
    }

    // ── decide: one test per safety rule ──

    #[test]
    fn open_session_is_never_touched_even_when_idle_merged_and_full_of_build_output() {
        for f in [
            facts(true, 0, 0, true),
            facts(true, 5, 2, false),
            facts(false, 0, 0, false),
        ] {
            let d = decide(PolicyInput {
                open: true,
                ..input(&f)
            });
            assert_eq!(d.state, LifeState::Open);
            assert_eq!(d.auto_action, AutoAction::None);
            assert_eq!(d.needs, None);
        }
    }

    #[test]
    fn dirty_worktree_is_never_removed_automatically_only_its_build_output() {
        let f = facts(true, 3, 0, true);
        let d = decide(input(&f));
        assert_eq!(d.auto_action, AutoAction::RemoveBuildOutput);
        assert_eq!(d.needs, Some(NeedsReason::Changes));
        assert!(d.backup_before_removal);
        assert_ne!(
            d.state,
            LifeState::Landed,
            "dirty is never 'nothing to lose'"
        );
        let d = decide(PolicyInput {
            build_output_bytes: 0,
            ..input(&f)
        });
        assert_eq!(d.auto_action, AutoAction::None);
    }

    #[test]
    fn unpushed_commits_are_never_removed_automatically() {
        let f = facts(true, 0, 2, false);
        let d = decide(input(&f));
        assert_eq!(d.auto_action, AutoAction::RemoveBuildOutput);
        assert_eq!(d.needs, Some(NeedsReason::Unpushed));
        assert!(d.backup_before_removal);
        // Orphaned with unpushed commits: same.
        let d = decide(PolicyInput {
            linked: false,
            ..input(&f)
        });
        assert_eq!(d.state, LifeState::Orphaned);
        assert_ne!(d.auto_action, AutoAction::RemoveWorktree);
    }

    #[test]
    fn merged_and_clean_is_landed_and_removed_once_idle() {
        let f = facts(true, 0, 0, true);
        let d = decide(input(&f));
        assert_eq!(d.state, LifeState::Landed);
        assert_eq!(d.auto_action, AutoAction::RemoveWorktree);
        assert!(!d.backup_before_removal);
        let d = decide(PolicyInput {
            idle: false,
            ..input(&f)
        });
        assert_eq!(d.state, LifeState::Landed);
        assert_eq!(
            d.auto_action,
            AutoAction::None,
            "not before the idle period"
        );
    }

    #[test]
    fn clean_unmerged_idle_worktree_only_loses_build_output() {
        let f = facts(true, 0, 0, false);
        let d = decide(input(&f));
        assert_eq!(d.state, LifeState::Idle);
        assert_eq!(d.auto_action, AutoAction::RemoveBuildOutput);
        assert_eq!(d.needs, None);
    }

    #[test]
    fn recent_worktree_is_active_and_untouched() {
        let f = facts(true, 4, 1, false);
        let d = decide(PolicyInput {
            idle: false,
            ..input(&f)
        });
        assert_eq!(d.state, LifeState::Active);
        assert_eq!(d.auto_action, AutoAction::None);
        assert_eq!(d.needs, None, "no nagging about work in active use");
    }

    #[test]
    fn orphan_with_nothing_to_lose_is_removed_once_idle() {
        let f = facts(true, 0, 0, false);
        let d = decide(PolicyInput {
            linked: false,
            ..input(&f)
        });
        assert_eq!(d.state, LifeState::Orphaned);
        assert_eq!(d.auto_action, AutoAction::RemoveWorktree);
        assert!(!d.backup_before_removal);
    }

    #[test]
    fn orphan_git_no_longer_knows_is_backed_up_before_removal() {
        let f = WorkFacts::default();
        let d = decide(PolicyInput {
            linked: false,
            build_output_bytes: 0,
            ..input(&f)
        });
        assert_eq!(d.state, LifeState::Orphaned);
        assert_eq!(d.auto_action, AutoAction::RemoveWorktree);
        assert!(d.backup_before_removal);
    }

    #[test]
    fn folder_whose_repo_is_gone_is_never_automatic_and_needs_the_person() {
        let f = WorkFacts::default();
        let d = decide(PolicyInput {
            linked: false,
            repo_exists: false,
            ..input(&f)
        });
        assert_eq!(d.auto_action, AutoAction::None);
        assert_eq!(d.needs, Some(NeedsReason::RepoGone));
    }

    #[test]
    fn idle_period_and_settings_parse() {
        let now = SystemTime::now();
        let day = Duration::from_secs(86_400);
        assert!(!is_idle(Some(now - day * 6), now, 7));
        assert!(is_idle(Some(now - day * 7), now, 7));
        assert!(is_idle(None, now, 7));
        assert!(is_idle(Some(now), now, 0));
        assert!(
            !is_idle(Some(now + day), now, 0),
            "a future time is not idle"
        );
        let s = HygieneSettings::from_values(Some("false"), Some("14"), Some("50"));
        assert_eq!(
            s,
            HygieneSettings {
                auto_cleanup: false,
                idle_days: 14,
                low_disk_bytes: 50_000_000_000
            }
        );
        assert_eq!(
            HygieneSettings::from_values(None, Some("junk"), Some("")),
            HygieneSettings::default()
        );
    }

    #[test]
    fn db_times_parse_in_both_formats() {
        let a = parse_db_time("2026-05-09 12:50:45").unwrap();
        let b = parse_db_time("2026-05-09T12:50:45+00:00").unwrap();
        assert_eq!(a, b);
        assert!(parse_db_time("").is_none());
        assert!(parse_db_time("yesterday").is_none());
    }

    // ── git: real repositories ──

    fn git(dir: &Path, args: &[&str]) -> String {
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
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    struct Layout {
        _root: TempDir,
        app_data: PathBuf,
        base: PathBuf,
        repo: PathBuf,
        hash_dir: PathBuf,
    }

    fn layout() -> Layout {
        let root = TempDir::new().unwrap();
        let repo = root.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["config", "user.email", "test@example.com"]);
        git(&repo, &["config", "user.name", "Test"]);
        git(&repo, &["config", "commit.gpgsign", "false"]);
        fs::write(repo.join(".gitignore"), "node_modules/\ntarget/\n.env\n").unwrap();
        fs::write(repo.join("README.md"), "x").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        let app_data = root.path().join("data");
        let hash_dir = worktree::worktree_dir(&app_data, repo.to_str().unwrap());
        fs::create_dir_all(&hash_dir).unwrap();
        fs::write(hash_dir.join("repo_path.txt"), repo.to_str().unwrap()).unwrap();
        Layout {
            base: worktree::worktrees_base_dir(&app_data),
            app_data,
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

    fn commit_in(wt: &Path, file: &str) {
        fs::write(wt.join(file), "work").unwrap();
        git(wt, &["add", file]);
        git(wt, &["commit", "-q", "-m", file]);
    }

    #[test]
    fn facts_tell_clean_dirty_unpushed_merged_and_unknown_apart() {
        let l = layout();
        let clean = add_worktree(&l, "a_clean", "clean");
        let f = work_facts(&l.repo, &clean);
        assert!(f.git_knows && f.merged && !f.has_work(), "{f:?}");
        assert_eq!(f.branch.as_deref(), Some("clean"));

        let dirty = add_worktree(&l, "b_dirty", "dirty");
        fs::write(dirty.join("new.txt"), "untracked").unwrap();
        fs::write(dirty.join("README.md"), "edited").unwrap();
        let f = work_facts(&l.repo, &dirty);
        assert_eq!(f.changed_files, 2, "{f:?}");

        // Ignored files are not work.
        let ignored = add_worktree(&l, "c_ignored", "ignored");
        fs::create_dir_all(ignored.join("node_modules/x")).unwrap();
        fs::write(ignored.join("node_modules/x/i.js"), "1").unwrap();
        assert_eq!(work_facts(&l.repo, &ignored).changed_files, 0);

        let ahead = add_worktree(&l, "d_ahead", "ahead");
        commit_in(&ahead, "feature.txt");
        let f = work_facts(&l.repo, &ahead);
        assert_eq!(f.unpushed_commits, 1);
        assert!(!f.merged);
        // Once main has it, nothing is unique and it is merged.
        git(&l.repo, &["merge", "-q", "--ff-only", "ahead"]);
        let f = work_facts(&l.repo, &ahead);
        assert_eq!(f.unpushed_commits, 0);
        assert!(f.merged);

        // A detached HEAD with a commit no ref holds: that commit is work.
        let detached = add_worktree(&l, "f_detached", "detached");
        git(&detached, &["checkout", "-q", "--detach"]);
        commit_in(&detached, "loose.txt");
        let f = work_facts(&l.repo, &detached);
        assert!(f.detached && f.branch.is_none());
        assert_eq!(f.unpushed_commits, 1);

        // A folder git no longer knows (its admin data pruned).
        let gone = add_worktree(&l, "e_gone", "gone");
        let admin = PathBuf::from(git(&gone, &["rev-parse", "--absolute-git-dir"]));
        fs::remove_dir_all(admin).unwrap();
        assert!(!work_facts(&l.repo, &gone).git_knows);
    }

    #[test]
    fn automatic_removal_takes_clean_worktree_and_keeps_its_branch() {
        let l = layout();
        let wt = add_worktree(&l, "a_done", "done");
        fs::create_dir_all(wt.join("node_modules/p")).unwrap();
        fs::write(wt.join("node_modules/p/i.js"), "1").unwrap();
        let out = remove_worktree_safely(
            &l.app_data,
            &l.base,
            Some(&l.repo),
            &wt,
            true,
            Requester::Automatic,
        );
        assert!(out.removed, "{out:?}");
        assert!(out.backup.is_none());
        assert!(!wt.exists());
        assert!(!git(&l.repo, &["worktree", "list"]).contains("a_done"));
        git(&l.repo, &["rev-parse", "--verify", "refs/heads/done"]);
    }

    #[test]
    fn automatic_removal_refuses_dirty_and_unpushed_worktrees() {
        let l = layout();
        let dirty = add_worktree(&l, "a_dirty", "dirty");
        fs::write(dirty.join("notes.txt"), "mine").unwrap();
        let out = remove_worktree_safely(
            &l.app_data,
            &l.base,
            Some(&l.repo),
            &dirty,
            true,
            Requester::Automatic,
        );
        assert!(!out.removed && dirty.join("notes.txt").exists(), "{out:?}");

        let ahead = add_worktree(&l, "b_ahead", "ahead");
        commit_in(&ahead, "f.txt");
        let out = remove_worktree_safely(
            &l.app_data,
            &l.base,
            Some(&l.repo),
            &ahead,
            true,
            Requester::Automatic,
        );
        assert!(!out.removed && ahead.exists(), "{out:?}");
        assert!(
            list_backups(&l.app_data, 10).is_empty(),
            "no backup when nothing is removed"
        );
    }

    #[test]
    fn person_removal_of_dirty_worktree_backs_up_every_file_first() {
        let l = layout();
        let wt = add_worktree(&l, "a_work", "work");
        commit_in(&wt, "committed.txt");
        fs::write(wt.join("README.md"), "edited").unwrap();
        fs::write(wt.join("untracked.txt"), "new").unwrap();
        fs::write(wt.join(".env"), "SECRET=1").unwrap(); // ignored: not backed up
        fs::create_dir_all(wt.join("node_modules/p")).unwrap();
        fs::write(wt.join("node_modules/p/i.js"), "1").unwrap();
        let out = remove_worktree_safely(
            &l.app_data,
            &l.base,
            Some(&l.repo),
            &wt,
            true,
            Requester::Person {
                allow_unrecoverable: false,
            },
        );
        assert!(out.removed, "{out:?}");
        let b = out.backup.expect("backup saved");
        assert!(b.ref_name.starts_with(BACKUP_REF_PREFIX));
        let files = git(&l.repo, &["ls-tree", "-r", "--name-only", &b.ref_name]);
        for f in ["README.md", "committed.txt", "untracked.txt"] {
            assert!(files.lines().any(|l| l == f), "{f} missing from {files}");
        }
        assert!(!files.contains("node_modules") && !files.contains(".env"));
        assert_eq!(
            git(&l.repo, &["show", &format!("{}:README.md", b.ref_name)]),
            "edited"
        );
        // The branch and its commit stay.
        git(&l.repo, &["rev-parse", "--verify", "refs/heads/work"]);
        assert_eq!(list_backups(&l.app_data, 10), vec![b]);
    }

    #[test]
    fn folder_git_no_longer_knows_is_backed_up_then_removed() {
        let l = layout();
        let wt = add_worktree(&l, "a_lost", "lost");
        fs::write(wt.join("draft.md"), "only copy").unwrap();
        let admin = PathBuf::from(git(&wt, &["rev-parse", "--absolute-git-dir"]));
        fs::remove_dir_all(admin).unwrap();
        let out = remove_worktree_safely(
            &l.app_data,
            &l.base,
            Some(&l.repo),
            &wt,
            false,
            Requester::Automatic,
        );
        assert!(out.removed, "{out:?}");
        let b = out.backup.unwrap();
        assert_eq!(
            git(&l.repo, &["show", &format!("{}:draft.md", b.ref_name)]),
            "only copy"
        );
        assert!(!wt.exists());
    }

    #[cfg(unix)]
    fn set_mode_recursive(dir: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        for entry in fs::read_dir(dir).unwrap().flatten() {
            if entry.file_type().unwrap().is_dir() {
                set_mode_recursive(&entry.path(), mode);
            }
        }
        fs::set_permissions(dir, fs::Permissions::from_mode(mode)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn failed_backup_removes_nothing() {
        // SAFETY: geteuid has no preconditions. Root ignores permissions.
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let l = layout();
        let wt = add_worktree(&l, "a_x", "x");
        fs::write(wt.join("mine.txt"), "x").unwrap();
        // A read-only object store: the snapshot cannot be written.
        let objects = l.repo.join(".git/objects");
        set_mode_recursive(&objects, 0o555);
        let out = remove_worktree_safely(
            &l.app_data,
            &l.base,
            Some(&l.repo),
            &wt,
            true,
            Requester::Person {
                allow_unrecoverable: false,
            },
        );
        set_mode_recursive(&objects, 0o755);
        assert!(!out.removed, "{out:?}");
        assert!(out.error.unwrap().contains("Nothing was removed"));
        assert!(wt.join("mine.txt").exists());
        assert!(list_backups(&l.app_data, 10).is_empty());
    }

    #[test]
    fn repo_gone_needs_explicit_yes_and_outside_paths_are_refused() {
        let l = layout();
        let gone_hash = l.base.join("00000000deadbeef");
        let folder = gone_hash.join("cccccccc_old");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("f.txt"), "x").unwrap();
        let missing = PathBuf::from("/nonexistent/repo");
        let out = remove_worktree_safely(
            &l.app_data,
            &l.base,
            Some(&missing),
            &folder,
            false,
            Requester::Automatic,
        );
        assert!(!out.removed && folder.exists());
        let out = remove_worktree_safely(
            &l.app_data,
            &l.base,
            Some(&missing),
            &folder,
            false,
            Requester::Person {
                allow_unrecoverable: false,
            },
        );
        assert!(!out.removed && folder.exists());
        let out = remove_worktree_safely(
            &l.app_data,
            &l.base,
            Some(&missing),
            &folder,
            false,
            Requester::Person {
                allow_unrecoverable: true,
            },
        );
        assert!(out.removed && !folder.exists());
        // The repo itself, and the hash folder, are never removable.
        for p in [&l.repo, &l.hash_dir] {
            let out = remove_worktree_safely(
                &l.app_data,
                &l.base,
                Some(&l.repo),
                p,
                false,
                Requester::Person {
                    allow_unrecoverable: true,
                },
            );
            assert!(!out.removed && p.exists());
        }
    }

    #[test]
    fn startup_orphan_pass_keeps_anything_with_work() {
        let l = layout();
        let clean = add_worktree(&l, "a_clean", "clean");
        let dirty = add_worktree(&l, "b_dirty", "dirty");
        fs::write(dirty.join("x.txt"), "x").unwrap();
        assert!(remove_orphan_if_nothing_to_lose(
            &l.app_data,
            &l.repo,
            &clean
        ));
        assert!(!clean.exists());
        assert!(!remove_orphan_if_nothing_to_lose(
            &l.app_data,
            &l.repo,
            &dirty
        ));
        assert!(dirty.join("x.txt").exists());
    }

    #[test]
    fn scan_classifies_every_folder_and_counts_what_can_go() {
        let l = layout();
        let open = add_worktree(&l, "a_open", "open");
        let landed = add_worktree(&l, "b_landed", "landed");
        let orphan = add_worktree(&l, "c_orphan", "orphan");
        let dirty = add_worktree(&l, "d_dirty", "dirty");
        fs::write(dirty.join("x.txt"), "x").unwrap();
        for wt in [&open, &landed, &orphan, &dirty] {
            fs::create_dir_all(wt.join("target/debug")).unwrap();
            fs::write(wt.join("target/debug/app"), vec![b'x'; 50_000]).unwrap();
        }
        let link = |id: &str, p: &Path| LinkRow {
            session_id: id.into(),
            worktree_path: p.to_string_lossy().to_string(),
            project_path: Some(l.repo.to_string_lossy().to_string()),
            created_at: "2020-01-01 00:00:00".into(),
            last_activity_at: None,
        };
        let links = vec![
            link("s-open", &open),
            link("s-landed", &landed),
            link("s-dirty", &dirty),
        ];
        let open_ids: HashSet<String> = ["s-open".to_string()].into_iter().collect();
        let settings = HygieneSettings {
            idle_days: 0,
            ..Default::default()
        };
        let entries = scan(
            &l.base,
            &links,
            &open_ids,
            &settings,
            SystemTime::now() + Duration::from_secs(60),
        );
        let by = |p: &Path| {
            entries
                .iter()
                .find(|e| canonical(Path::new(&e.path)) == canonical(p))
                .unwrap()
                .clone()
        };
        assert_eq!(by(&open).decision.state, LifeState::Open);
        assert_eq!(by(&open).auto_bytes, 0);
        assert_eq!(by(&landed).decision.state, LifeState::Landed);
        assert_eq!(by(&landed).decision.auto_action, AutoAction::RemoveWorktree);
        assert_eq!(by(&orphan).decision.state, LifeState::Orphaned);
        assert_eq!(by(&dirty).decision.needs, Some(NeedsReason::Changes));
        assert_eq!(
            by(&dirty).decision.auto_action,
            AutoAction::RemoveBuildOutput
        );
        assert!(by(&dirty).build_output_bytes >= 50_000);
        let r = report(&l.base, entries, settings);
        assert!(r.auto_bytes > 0 && r.needs_bytes > 0 && r.total_bytes >= r.auto_bytes);
        assert_eq!(r.worktrees.len(), 4);
    }

    #[test]
    fn measuring_does_not_make_an_old_worktree_look_used() {
        let l = layout();
        let wt = add_worktree(&l, "a_old", "old");
        fs::write(wt.join("README.md"), "changed").unwrap(); // stat info now stale
        let admin = PathBuf::from(git(&wt, &["rev-parse", "--absolute-git-dir"]));
        let before = mtime(&admin.join("index"));
        std::thread::sleep(Duration::from_millis(1100));
        let _ = work_facts(&l.repo, &wt);
        assert_eq!(mtime(&admin.join("index")), before);
    }
}
