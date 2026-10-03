//! Worktree hygiene in the running app: the Storage view's commands, the
//! background pass, and the notices it sends. The rules live in
//! [`super::hygiene`]; this file only gathers what they need (which sessions
//! are open, the database's links, the settings) and acts on the answer.

use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter, Manager};

use super::disk_guard;
use super::hygiene::{
    self, AutoAction, BackupRecord, HygieneSettings, LinkRow, Requester, StorageReport,
};
use super::worktree;
use crate::AppState;

/// Event the background pass sends; the frontend shows it as a notice.
pub const NOTICE_EVENT: &str = "worktree-storage-notice";

/// One pass or removal at a time, whoever asked.
static PASS_LOCK: Mutex<()> = Mutex::new(());

/// Below this, an automatic cleanup is not worth a notice.
const NOTICE_MIN_FREED: u64 = 1_000_000_000;
/// "Old worktrees use X" is worth saying from this much needing the person.
const NOTICE_MIN_NEEDS: u64 = 20_000_000_000;

// ─── Inputs ─────────────────────────────────────────────────────────

struct Inputs {
    app_data: PathBuf,
    base: PathBuf,
    links: Vec<LinkRow>,
    open: HashSet<String>,
    settings: HygieneSettings,
}

/// Sessions that are open: terminals (and ones being opened), running agent
/// processes, sessions kept by the session host, and the saved workspace
/// (restored on the next start). None when that cannot be known for sure;
/// nothing may then be removed.
fn open_sessions(app: &AppHandle) -> Option<HashSet<String>> {
    let state = app.try_state::<AppState>()?;
    let mut open: HashSet<String> = {
        let mgr = state.pty_manager.lock().ok()?;
        mgr.sessions
            .keys()
            .chain(mgr.opening.keys())
            .cloned()
            .collect()
    };
    if let Some(agents) = app.try_state::<crate::agent::AgentState>() {
        open.extend(agents.live_session_ids()?);
    }
    open.extend(crate::session_host::live_hosted_session_ids(app));
    let saved = state
        .db
        .lock()
        .ok()?
        .get_setting(crate::saved_workspace::SETTING_KEY)
        .ok()
        .flatten();
    open.extend(crate::saved_workspace_session_ids(saved.as_deref()));
    Some(open)
}

fn read_settings(app: &AppHandle) -> HygieneSettings {
    let Some(state) = app.try_state::<AppState>() else {
        return HygieneSettings::default();
    };
    let Ok(db) = state.db.lock() else {
        return HygieneSettings::default();
    };
    let get = |k: &str| db.get_setting(k).ok().flatten();
    HygieneSettings::from_values(
        get(hygiene::SETTING_AUTO_CLEANUP).as_deref(),
        get(hygiene::SETTING_IDLE_DAYS).as_deref(),
        get(hygiene::SETTING_LOW_DISK_GB).as_deref(),
    )
}

fn gather(app: &AppHandle) -> Result<Inputs, String> {
    let app_data = crate::instance::app_data_dir(app)?;
    let open = open_sessions(app).ok_or("Could not tell which sessions are open")?;
    let state = app.try_state::<AppState>().ok_or("App is not ready")?;
    let links = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        // Open sessions are in use now: that is what "last used" means.
        let ids: Vec<String> = open.iter().cloned().collect();
        let _ = db.touch_worktrees_of_sessions(&ids);
        db.get_worktree_links()?
    };
    Ok(Inputs {
        base: worktree::worktrees_base_dir(&app_data),
        app_data,
        links,
        open,
        settings: read_settings(app),
    })
}

fn build_report(inputs: &Inputs) -> StorageReport {
    let entries = hygiene::scan(
        &inputs.base,
        &inputs.links,
        &inputs.open,
        &inputs.settings,
        SystemTime::now(),
    );
    hygiene::report(&inputs.base, entries, inputs.settings)
}

/// Free space now, or None when a figure would mean nothing (unreadable, or
/// a test build pretending a number).
fn measured_free(base: &Path) -> Option<u64> {
    if disk_guard::free_space_overridden() {
        return None;
    }
    disk_guard::free_space_bytes(base).ok()
}

fn freed(before: Option<u64>, after: Option<u64>, estimate: u64) -> u64 {
    match (before, after) {
        (Some(b), Some(a)) => a.saturating_sub(b),
        _ => estimate,
    }
}

fn forget_links(app: &AppHandle, path: &str) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(db) = state.db.lock() {
            let _ = db.delete_worktree_links_at(path);
        }
    }
}

// ─── Clean up (automatic rules) ─────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupOutcome {
    /// What the disk gained (measured when possible, else the sizes removed).
    pub freed_bytes: u64,
    pub removed_worktrees: Vec<String>,
    pub cleared_build_output: Vec<String>,
    pub backups: Vec<BackupRecord>,
    pub skipped: Vec<Skipped>,
    /// The state after cleaning up.
    pub report: StorageReport,
}

/// Apply the automatic rules once. Every action re-checks that its session
/// is still not open right before it happens.
fn clean_up(app: &AppHandle) -> Result<CleanupOutcome, String> {
    let _guard = PASS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let inputs = gather(app)?;
    let report = build_report(&inputs);
    let before = measured_free(&inputs.base);
    let mut estimate = 0u64;
    let mut removed_worktrees = Vec::new();
    let mut cleared_build_output = Vec::new();
    let mut backups = Vec::new();
    let mut skipped = Vec::new();
    for e in &report.worktrees {
        if e.decision.auto_action == AutoAction::None {
            continue;
        }
        let still_closed = open_sessions(app)
            .is_some_and(|open| !e.session_ids.iter().any(|id| open.contains(id)));
        if !still_closed {
            skipped.push(Skipped {
                path: e.path.clone(),
                reason: "Its session is open".into(),
            });
            continue;
        }
        let path = Path::new(&e.path);
        match e.decision.auto_action {
            AutoAction::RemoveBuildOutput => {
                let r = disk_guard::reclaim_build_output(path);
                estimate += r.freed_bytes;
                if !r.removed.is_empty() {
                    cleared_build_output.push(e.path.clone());
                }
                for f in r.failed {
                    skipped.push(Skipped {
                        path: e.path.clone(),
                        reason: f,
                    });
                }
            }
            AutoAction::RemoveWorktree => {
                let out = hygiene::remove_worktree_safely(
                    &inputs.app_data,
                    &inputs.base,
                    e.repo_path.as_deref().map(Path::new),
                    path,
                    !e.session_ids.is_empty(),
                    Requester::Automatic,
                );
                if out.removed {
                    estimate += e.total_bytes;
                    forget_links(app, &e.path);
                    removed_worktrees.push(e.path.clone());
                    backups.extend(out.backup);
                } else {
                    skipped.push(Skipped {
                        path: e.path.clone(),
                        reason: out.error.unwrap_or_default(),
                    });
                }
            }
            AutoAction::None => {}
        }
    }
    let freed_bytes = freed(before, measured_free(&inputs.base), estimate);
    log::info!(
        "[hygiene] clean-up: {} worktrees removed, build output of {} cleared, {} skipped, {} bytes freed",
        removed_worktrees.len(),
        cleared_build_output.len(),
        skipped.len(),
        freed_bytes
    );
    // The state after, for the view.
    let after = gather(app).map(|i| build_report(&i)).unwrap_or(report);
    Ok(CleanupOutcome {
        freed_bytes,
        removed_worktrees,
        cleared_build_output,
        backups,
        skipped,
        report: after,
    })
}

// ─── Commands ───────────────────────────────────────────────────────

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// Every worktree folder of this app with its state, size and what can go.
#[tauri::command]
pub async fn worktree_storage_report(app: AppHandle) -> Result<StorageReport, String> {
    blocking(move || gather(&app).map(|i| build_report(&i))).await
}

/// "Clean up now": the automatic rules, once, whatever the automatic
/// setting says.
#[tauri::command]
pub async fn worktree_storage_clean_up(app: AppHandle) -> Result<CleanupOutcome, String> {
    blocking(move || clean_up(&app)).await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonRemoval {
    #[serde(flatten)]
    pub outcome: hygiene::RemovalOutcome,
    pub freed_bytes: u64,
}

/// The person removes one worktree. Never an open session's. A backup is
/// saved first when anything in it could be lost; a folder whose repo is
/// gone needs `allow_unrecoverable`.
#[tauri::command]
pub async fn worktree_storage_remove(
    app: AppHandle,
    path: String,
    allow_unrecoverable: bool,
) -> Result<PersonRemoval, String> {
    blocking(move || {
        let _guard = PASS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let inputs = gather(&app)?;
        let entry = hygiene::scan(
            &inputs.base,
            &inputs.links,
            &inputs.open,
            &inputs.settings,
            SystemTime::now(),
        )
        .into_iter()
        .find(|e| worktree::same_dir(&e.path, &path))
        .ok_or("Not a Hermes worktree folder")?;
        if entry.decision.state == hygiene::LifeState::Open {
            return Err("Its session is open. Close the session first.".into());
        }
        let before = measured_free(&inputs.base);
        let outcome = hygiene::remove_worktree_safely(
            &inputs.app_data,
            &inputs.base,
            entry.repo_path.as_deref().map(Path::new),
            Path::new(&entry.path),
            !entry.session_ids.is_empty(),
            Requester::Person {
                allow_unrecoverable,
            },
        );
        if outcome.removed {
            forget_links(&app, &entry.path);
        }
        let estimate = if outcome.removed {
            entry.total_bytes
        } else {
            0
        };
        Ok(PersonRemoval {
            freed_bytes: freed(before, measured_free(&inputs.base), estimate),
            outcome,
        })
    })
    .await
}

/// The person removes one worktree's build output. Not an open session's.
#[tauri::command]
pub async fn worktree_storage_remove_build_output(
    app: AppHandle,
    path: String,
) -> Result<disk_guard::ReclaimResult, String> {
    blocking(move || {
        let _guard = PASS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let inputs = gather(&app)?;
        let base = inputs.base.clone();
        if !disk_guard::is_worktree_folder(&base, Path::new(&path)) {
            return Err("Not a Hermes worktree folder".into());
        }
        let target = dunce::canonicalize(&path).map_err(|e| e.to_string())?;
        let open = inputs.links.iter().any(|l| {
            inputs.open.contains(&l.session_id)
                && dunce::canonicalize(&l.worktree_path).ok().as_ref() == Some(&target)
        });
        if open {
            return Err("Its session is open. Close the session first.".into());
        }
        let mut r = disk_guard::reclaim_build_output(&target);
        r.path = path;
        Ok(r)
    })
    .await
}

/// Backups saved before removals, newest first.
#[tauri::command]
pub async fn worktree_storage_backups(app: AppHandle) -> Result<Vec<BackupRecord>, String> {
    blocking(move || {
        let app_data = crate::instance::app_data_dir(&app)?;
        Ok(hygiene::list_backups(&app_data, 50))
    })
    .await
}

// ─── Background pass and notices ────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    /// "low_disk", "cleaned" or "reclaimable".
    pub kind: String,
    pub free_bytes: Option<u64>,
    pub worktree_bytes: u64,
    pub auto_bytes: u64,
    pub needs_bytes: u64,
    pub freed_bytes: u64,
    pub removed_worktrees: usize,
    pub cleared_build_output: usize,
}

struct Timings {
    start: Duration,
    tick: Duration,
    pass_every: Duration,
    low_notice_every: Duration,
    needs_notice_every: Duration,
}

fn timings() -> Timings {
    let normal = Timings {
        start: Duration::from_secs(120),
        tick: Duration::from_secs(600),
        pass_every: Duration::from_secs(6 * 3600),
        low_notice_every: Duration::from_secs(6 * 3600),
        needs_notice_every: Duration::from_secs(24 * 3600),
    };
    #[cfg(feature = "e2e")]
    {
        let secs = |k: &str| {
            crate::e2e_protocol::is_enabled(std::env::var("HERMES_E2E").ok().as_deref())
                .then(|| std::env::var(k).ok()?.trim().parse::<u64>().ok())
                .flatten()
                .map(Duration::from_secs)
        };
        if let Some(tick) = secs("HERMES_E2E_HYGIENE_TICK_SECS") {
            return Timings {
                start: secs("HERMES_E2E_HYGIENE_START_SECS").unwrap_or(tick),
                tick,
                pass_every: tick,
                low_notice_every: tick,
                needs_notice_every: tick,
            };
        }
    }
    normal
}

/// What the background loop remembers between ticks.
#[derive(Default)]
struct NoticeMemory {
    last_pass: Option<Instant>,
    last_low: Option<Instant>,
    below_guard_said: bool,
    last_needs: Option<Instant>,
    last_report: Option<(u64, u64, u64)>,
}

fn due(last: Option<Instant>, every: Duration) -> bool {
    last.is_none_or(|t| t.elapsed() >= every)
}

/// Which notices one tick sends. Pure, so the throttling is tested.
fn notices_for_tick(
    mem: &mut NoticeMemory,
    t: &Timings,
    free: Option<u64>,
    settings: &HygieneSettings,
    pass: Option<(&StorageReport, Option<&CleanupOutcome>)>,
) -> Vec<Notice> {
    let mut out = Vec::new();
    if let Some((report, cleaned)) = pass {
        mem.last_report = Some((report.total_bytes, report.auto_bytes, report.needs_bytes));
        if let Some(c) = cleaned.filter(|c| c.freed_bytes >= NOTICE_MIN_FREED) {
            out.push(Notice {
                kind: "cleaned".into(),
                free_bytes: free,
                worktree_bytes: c.report.total_bytes,
                auto_bytes: c.report.auto_bytes,
                needs_bytes: c.report.needs_bytes,
                freed_bytes: c.freed_bytes,
                removed_worktrees: c.removed_worktrees.len(),
                cleared_build_output: c.cleared_build_output.len(),
            });
        }
        if report.needs_bytes >= NOTICE_MIN_NEEDS && due(mem.last_needs, t.needs_notice_every) {
            mem.last_needs = Some(Instant::now());
            out.push(Notice {
                kind: "reclaimable".into(),
                free_bytes: free,
                worktree_bytes: report.total_bytes,
                auto_bytes: report.auto_bytes,
                needs_bytes: report.needs_bytes,
                freed_bytes: 0,
                removed_worktrees: 0,
                cleared_build_output: 0,
            });
        }
    }
    if let Some(f) = free {
        let below_guard = f < disk_guard::MIN_FREE_BYTES_FOR_WORKTREE;
        if f >= settings.low_disk_bytes {
            mem.below_guard_said = false;
        } else if due(mem.last_low, t.low_notice_every) || (below_guard && !mem.below_guard_said) {
            mem.last_low = Some(Instant::now());
            mem.below_guard_said = below_guard;
            let (total, auto, needs) = mem.last_report.unwrap_or_default();
            out.push(Notice {
                kind: "low_disk".into(),
                free_bytes: Some(f),
                worktree_bytes: total,
                auto_bytes: auto,
                needs_bytes: needs,
                freed_bytes: 0,
                removed_worktrees: 0,
                cleared_build_output: 0,
            });
        }
    }
    out
}

fn tick(app: &AppHandle, mem: &mut NoticeMemory, t: &Timings) {
    let settings = read_settings(app);
    let Ok(app_data) = crate::instance::app_data_dir(app) else {
        return;
    };
    let base = worktree::worktrees_base_dir(&app_data);
    let free = disk_guard::free_space_bytes(&base).ok();
    let low = free.is_some_and(|f| f < settings.low_disk_bytes);
    // Low disk: run the pass now, not in six hours (at most once a tick).
    let pass_due = due(mem.last_pass, t.pass_every) || (low && due(mem.last_pass, t.tick));
    let mut notices = Vec::new();
    if pass_due {
        mem.last_pass = Some(Instant::now());
        let result = if settings.auto_cleanup {
            clean_up(app).map(|c| (c.report.clone(), Some(c)))
        } else {
            gather(app).map(|i| (build_report(&i), None))
        };
        match result {
            Ok((report, cleaned)) => {
                let free = disk_guard::free_space_bytes(&base).ok();
                notices =
                    notices_for_tick(mem, t, free, &settings, Some((&report, cleaned.as_ref())));
            }
            Err(e) => log::warn!("[hygiene] background pass skipped: {}", e),
        }
    } else {
        notices = notices_for_tick(mem, t, free, &settings, None);
    }
    for n in notices {
        let _ = app.emit(NOTICE_EVENT, &n);
    }
}

/// Start the background pass: shortly after launch, then every few hours,
/// with a free-space check in between.
pub fn start(app: AppHandle) {
    let _ = std::thread::Builder::new()
        .name("worktree-hygiene".into())
        .spawn(move || {
            let t = timings();
            std::thread::sleep(t.start);
            let mut mem = NoticeMemory::default();
            loop {
                tick(&app, &mut mem, &t);
                std::thread::sleep(t.tick);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t() -> Timings {
        Timings {
            start: Duration::ZERO,
            tick: Duration::from_secs(600),
            pass_every: Duration::from_secs(3600),
            low_notice_every: Duration::from_secs(3600),
            needs_notice_every: Duration::from_secs(3600),
        }
    }

    fn report(total: u64, auto: u64, needs: u64) -> StorageReport {
        StorageReport {
            free_bytes: None,
            disk_total_bytes: None,
            guard_bytes: disk_guard::MIN_FREE_BYTES_FOR_WORKTREE,
            settings: HygieneSettings::default(),
            worktrees: Vec::new(),
            total_bytes: total,
            auto_bytes: auto,
            needs_bytes: needs,
            scanned_at: String::new(),
        }
    }

    const GB: u64 = 1_000_000_000;

    #[test]
    fn low_disk_notice_is_throttled_and_repeats_when_under_the_guard() {
        let s = HygieneSettings::default(); // warns under 20 GB
        let mut mem = NoticeMemory::default();
        let n = notices_for_tick(
            &mut mem,
            &t(),
            Some(15 * GB),
            &s,
            Some((&report(50 * GB, 30 * GB, 5 * GB), None)),
        );
        assert_eq!(n.len(), 1);
        assert_eq!(n[0].kind, "low_disk");
        assert_eq!((n[0].worktree_bytes, n[0].auto_bytes), (50 * GB, 30 * GB));
        // Next tick, still low: quiet.
        assert!(notices_for_tick(&mut mem, &t(), Some(14 * GB), &s, None).is_empty());
        // Dropping under the 10 GB guard is said once more.
        let n = notices_for_tick(&mut mem, &t(), Some(8 * GB), &s, None);
        assert_eq!(n.len(), 1);
        assert!(notices_for_tick(&mut mem, &t(), Some(7 * GB), &s, None).is_empty());
        // Plenty of space: nothing.
        let mut mem = NoticeMemory::default();
        assert!(notices_for_tick(&mut mem, &t(), Some(80 * GB), &s, None).is_empty());
    }

    #[test]
    fn cleanup_notice_only_when_it_freed_a_gigabyte_and_needs_notice_once() {
        let s = HygieneSettings::default();
        let mut mem = NoticeMemory::default();
        let after = report(40 * GB, 0, 25 * GB);
        let cleaned = CleanupOutcome {
            freed_bytes: 3 * GB,
            removed_worktrees: vec!["a".into()],
            cleared_build_output: vec!["b".into(), "c".into()],
            backups: Vec::new(),
            skipped: Vec::new(),
            report: after.clone(),
        };
        let n = notices_for_tick(
            &mut mem,
            &t(),
            Some(90 * GB),
            &s,
            Some((&after, Some(&cleaned))),
        );
        let kinds: Vec<&str> = n.iter().map(|n| n.kind.as_str()).collect();
        assert_eq!(kinds, ["cleaned", "reclaimable"]);
        assert_eq!((n[0].removed_worktrees, n[0].cleared_build_output), (1, 2));
        // Same again: the cleanup notice repeats only if it freed space again;
        // "reclaimable" waits for its interval.
        let small = CleanupOutcome {
            freed_bytes: 10,
            ..cleaned
        };
        let n = notices_for_tick(
            &mut mem,
            &t(),
            Some(90 * GB),
            &s,
            Some((&after, Some(&small))),
        );
        assert!(n.is_empty(), "{n:?}");
    }

    #[test]
    fn freed_prefers_the_measured_difference() {
        assert_eq!(freed(Some(10), Some(25), 999), 15);
        assert_eq!(freed(Some(10), Some(5), 999), 0);
        assert_eq!(freed(None, Some(5), 999), 999);
    }
}
