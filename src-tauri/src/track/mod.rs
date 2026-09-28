//! Feature Tracks in the app (F28).
//!
//! The files under `.hermes/features/<slug>/` are the API (see the
//! `hermes-track` crate, shared with the `hi` helper). This module:
//!
//! - watches every worktree a session is attached to and emits
//!   `hermes:track-changed` with the raw file texts when anything under
//!   `.hermes/features` moves. The frontend parses them with the contract
//!   reader (`featureFrontMatter.ts`), raises the inbox items and decides
//!   what to show. Polling (not a native watcher): it is a handful of
//!   `stat` calls per worktree every half second, it behaves the same on
//!   every OS and on network folders, and it meets the 2 s budget with room.
//! - runs the actions a person takes from the Track view: approve, skip,
//!   revert an approval nobody gave, promote a session to a feature, write
//!   the review file that carries their edits back to the agent.
//!
//! Nothing here types into a terminal: the one tagged line that tells the
//! agent about a review is sent by the frontend when the person presses `r`.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use hermes_track as ht;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

pub const TRACK_CHANGED_EVENT: &str = "hermes:track-changed";
const POLL: Duration = Duration::from_millis(500);
/// The files the Track view may read or open: nothing outside the folder.
const READABLE: &[&str] = &[
    "feature.md",
    "questions.md",
    "research.md",
    "design.md",
    "structure.md",
    "plan.md",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrackFileInfo {
    pub name: String,
    pub lines: usize,
    /// Epoch milliseconds.
    pub modified_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrackFeatureSnapshot {
    pub slug: String,
    pub feature_text: String,
    pub feature_modified_at: i64,
    pub questions_text: Option<String>,
    pub files: Vec<TrackFileInfo>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrackWorktreeSnapshot {
    pub worktree_path: String,
    pub branch: Option<String>,
    pub features: Vec<TrackFeatureSnapshot>,
    /// Epoch milliseconds when the snapshot was taken.
    pub at: i64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn mtime_ms(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Read the state of every feature folder in a worktree.
pub fn snapshot(worktree: &Path) -> TrackWorktreeSnapshot {
    let mut features = Vec::new();
    for slug in ht::list_features(worktree) {
        let dir = ht::FeatureDir::new(worktree, &slug);
        let feature_file = dir.feature_file();
        let feature_text = std::fs::read_to_string(&feature_file).unwrap_or_default();
        let questions_text = std::fs::read_to_string(dir.dir().join("questions.md")).ok();
        let mut files = Vec::new();
        for name in READABLE.iter().skip(1) {
            let path = dir.dir().join(name);
            if let Ok(text) = std::fs::read_to_string(&path) {
                files.push(TrackFileInfo {
                    name: (*name).to_string(),
                    lines: text.lines().count(),
                    modified_at: mtime_ms(&path),
                });
            }
        }
        features.push(TrackFeatureSnapshot {
            slug,
            feature_text,
            feature_modified_at: mtime_ms(&feature_file),
            questions_text,
            files,
        });
    }
    TrackWorktreeSnapshot {
        worktree_path: worktree.to_string_lossy().to_string(),
        branch: ht::current_branch(worktree),
        features,
        at: now_ms(),
    }
}

/// What the watcher compares between polls: everything but `at`.
fn digest(snap: &TrackWorktreeSnapshot) -> String {
    serde_json::to_string(&(&snap.branch, &snap.features)).unwrap_or_default()
}

#[derive(Default)]
pub struct TrackWatchState {
    /// worktree path -> sessions attached to it.
    watched: Mutex<BTreeMap<String, BTreeSet<String>>>,
    last: Mutex<HashMap<String, String>>,
    stopped: AtomicBool,
}

impl TrackWatchState {
    fn watched_paths(&self) -> Vec<String> {
        self.watched
            .lock()
            .map(|w| w.keys().cloned().collect())
            .unwrap_or_default()
    }
}

/// One thread for the whole app; a poll takes microseconds per worktree.
pub fn start(app: AppHandle, state: Arc<TrackWatchState>) {
    std::thread::Builder::new()
        .name("hermes-track-watch".into())
        .spawn(move || loop {
            std::thread::sleep(POLL);
            if state.stopped.load(Ordering::Relaxed) {
                return;
            }
            for path in state.watched_paths() {
                let snap = snapshot(Path::new(&path));
                let d = digest(&snap);
                let changed = state
                    .last
                    .lock()
                    .map(|mut last| last.insert(path.clone(), d.clone()) != Some(d))
                    .unwrap_or(false);
                if changed {
                    if let Err(e) = app.emit(TRACK_CHANGED_EVENT, &snap) {
                        log::warn!("[track] could not emit change for {path}: {e}");
                    }
                }
            }
        })
        .map(|_| ())
        .unwrap_or_else(|e| log::warn!("[track] watcher thread not started: {e}"));
}

fn absolute_dir(raw: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(raw);
    if !p.is_absolute() {
        return Err(format!("not an absolute path: {raw}"));
    }
    if !p.is_dir() {
        return Err(format!("no such folder: {raw}"));
    }
    Ok(p)
}

fn track_err(e: ht::TrackError) -> String {
    e.to_string()
}

impl TrackWatchState {
    /// Attach a session to a worktree and read its state now; the watcher
    /// then reports every later change.
    pub fn watch(&self, session_id: &str, raw_path: &str) -> Result<TrackWorktreeSnapshot, String> {
        let path = absolute_dir(raw_path)?;
        let key = path.to_string_lossy().to_string();
        let snap = snapshot(&path);
        if let Ok(mut w) = self.watched.lock() {
            w.entry(key.clone())
                .or_default()
                .insert(session_id.to_string());
        }
        if let Ok(mut last) = self.last.lock() {
            last.insert(key, digest(&snap));
        }
        Ok(snap)
    }

    /// A session closed: forget it, and a worktree nobody watches any more.
    pub fn unwatch(&self, session_id: &str) {
        if let Ok(mut w) = self.watched.lock() {
            w.retain(|_, sessions| {
                sessions.remove(session_id);
                !sessions.is_empty()
            });
            let live: BTreeSet<String> = w.keys().cloned().collect();
            if let Ok(mut last) = self.last.lock() {
                last.retain(|k, _| live.contains(k));
            }
        }
    }
}

/// Attach a session to a worktree and return its current state. The
/// watcher then reports every later change on `hermes:track-changed`.
#[tauri::command]
pub fn track_watch(
    state: State<'_, Arc<TrackWatchState>>,
    session_id: String,
    worktree_path: String,
) -> Result<TrackWorktreeSnapshot, String> {
    state.watch(&session_id, &worktree_path)
}

#[tauri::command]
pub fn track_unwatch(state: State<'_, Arc<TrackWatchState>>, session_id: String) {
    state.unwatch(&session_id);
}

/// Read the files right now (a person opened the view).
#[tauri::command]
pub fn track_snapshot(worktree_path: String) -> Result<TrackWorktreeSnapshot, String> {
    Ok(snapshot(&absolute_dir(&worktree_path)?))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseMove {
    pub from: String,
    pub to: String,
}

fn phase_move((from, to): (ht::Phase, ht::Phase)) -> PhaseMove {
    PhaseMove {
        from: from.as_str().to_string(),
        to: to.as_str().to_string(),
    }
}

/// ⌘⏎ in the Track view: a person approves the waiting gate.
#[tauri::command]
pub fn track_approve(worktree_path: String, slug: String) -> Result<PhaseMove, String> {
    let root = absolute_dir(&worktree_path)?;
    let slug = checked_slug(&slug)?;
    ht::approve(&root, slug).map(phase_move).map_err(track_err)
}

/// `s` in the Track view: a person skips the phase, waiting or not.
#[tauri::command]
pub fn track_skip(worktree_path: String, slug: String) -> Result<PhaseMove, String> {
    let root = absolute_dir(&worktree_path)?;
    let slug = checked_slug(&slug)?;
    ht::skip_phase(&root, slug, true)
        .map(phase_move)
        .map_err(track_err)
}

/// An approval that came from the agent's own turn: back to waiting.
#[tauri::command]
pub fn track_revert_gate(worktree_path: String, slug: String, phase: String) -> Result<(), String> {
    let root = absolute_dir(&worktree_path)?;
    let slug = checked_slug(&slug)?;
    let phase = ht::Phase::parse(&phase).ok_or_else(|| format!("unknown phase {phase:?}"))?;
    ht::revert_gate(&root, slug, phase).map_err(track_err)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromoteOutcome {
    pub created: bool,
    pub slug: String,
    pub feature_file: Option<String>,
    /// What happened to the branch (`hermes/<slug>`, like `hi feature new`),
    /// or `None` outside a repository.
    pub branch: Option<String>,
}

/// "Make it a feature": the worktree gets its folder and, like `hi feature
/// new`, its `hermes/<slug>` branch (never fatal: the folder is what matters).
#[tauri::command]
pub fn track_promote(
    worktree_path: String,
    slug: String,
    track: String,
    title: Option<String>,
) -> Result<PromoteOutcome, String> {
    let root = absolute_dir(&worktree_path)?;
    let track = ht::Track::parse(&track).ok_or_else(|| format!("unknown track {track:?}"))?;
    let out =
        ht::create(&root, &slug, track, title.as_deref().unwrap_or(""), "").map_err(track_err)?;
    let branch = ht::ensure_branch(&root, &slug);
    Ok(PromoteOutcome {
        created: out.created,
        slug,
        feature_file: out.feature_file.map(|p| p.to_string_lossy().to_string()),
        branch,
    })
}

/// Every command takes the slug from the frontend as a string; only a real
/// slug may name a folder under `.hermes/features/`.
fn checked_slug(slug: &str) -> Result<&str, String> {
    if ht::front_matter::is_slug(slug) {
        Ok(slug)
    } else {
        Err(format!("not a feature slug: {slug}"))
    }
}

fn readable(root: &Path, slug: &str, name: &str) -> Result<PathBuf, String> {
    if !READABLE.contains(&name) {
        return Err(format!("not a track file: {name}"));
    }
    let slug = checked_slug(slug)?;
    Ok(ht::FeatureDir::new(root, slug).dir().join(name))
}

/// `o` in the Track view: the file's text for the built-in preview.
#[tauri::command]
pub fn track_read_file(
    worktree_path: String,
    slug: String,
    name: String,
) -> Result<String, String> {
    let root = absolute_dir(&worktree_path)?;
    let path = readable(&root, &slug, &name)?;
    std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))
}

/// The absolute path of a track file (for the editor split).
#[tauri::command]
pub fn track_file_path(
    worktree_path: String,
    slug: String,
    name: String,
) -> Result<String, String> {
    let root = absolute_dir(&worktree_path)?;
    let path = readable(&root, &slug, &name)?;
    if !path.is_file() {
        return Err(format!("{} does not exist yet", path.display()));
    }
    Ok(path.to_string_lossy().to_string())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewOutcome {
    /// Relative to the worktree, forward slashes.
    pub path: String,
    pub n: u32,
    /// The one line the frontend sends to the writer agent.
    pub line: String,
    pub changed_lines: usize,
}

/// A unified diff of `before` -> `after` (git's own algorithm, no shell).
pub fn unified_diff(name: &str, before: &str, after: &str) -> Result<String, String> {
    let mut opts = git2::DiffOptions::new();
    opts.context_lines(3);
    let patch = git2::Patch::from_buffers(
        before.as_bytes(),
        Some(Path::new(name)),
        after.as_bytes(),
        Some(Path::new(name)),
        Some(&mut opts),
    )
    .map_err(|e| format!("diff: {e}"))?;
    let mut patch = patch;
    let buf = patch.to_buf().map_err(|e| format!("diff: {e}"))?;
    Ok(String::from_utf8_lossy(&buf).to_string())
}

/// Pure: the review file's text and the line for the agent.
pub fn review_text(
    slug: &str,
    name: &str,
    n: u32,
    before: Option<&str>,
    after: &str,
) -> Result<(String, String, usize), String> {
    let rel = format!("{}/{slug}/review-{n}.md", ht::FEATURES_DIR);
    let (body, changed) = match before {
        Some(b) if b != after => {
            let diff = unified_diff(name, b, after)?;
            let changed = diff
                .lines()
                .filter(|l| {
                    (l.starts_with('+') || l.starts_with('-'))
                        && !l.starts_with("+++")
                        && !l.starts_with("---")
                })
                .count();
            (format!("```diff\n{diff}```\n"), changed)
        }
        _ => (
            format!("The file as I want it:\n\n```markdown\n{after}\n```\n"),
            after.lines().count(),
        ),
    };
    let text = format!(
        "# Review {n}: my edits to {name}\n\nApply these edits to `{}/{slug}/{name}`, keep everything else, then continue the phase.\n\n{body}",
        ht::FEATURES_DIR
    );
    let line = format!("hermes review: read {rel} and apply my edits to {name}, then continue");
    Ok((text, line, changed))
}

/// `r` in the Track view: write `review-<n>.md` with the person's edits
/// (a diff against the version the agent handed over, or the whole file)
/// and return the one line to send to the writer agent.
#[tauri::command]
pub fn track_write_review(
    worktree_path: String,
    slug: String,
    name: String,
    baseline: Option<String>,
) -> Result<ReviewOutcome, String> {
    let root = absolute_dir(&worktree_path)?;
    let path = readable(&root, &slug, &name)?;
    let after = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let dir = ht::FeatureDir::new(&root, &slug).dir();
    let mut n = 1u32;
    while dir.join(format!("review-{n}.md")).exists() {
        n += 1;
    }
    let (text, line, changed_lines) = review_text(&slug, &name, n, baseline.as_deref(), &after)?;
    let review = dir.join(format!("review-{n}.md"));
    ht::feature::write_atomic(&review, &text).map_err(track_err)?;
    Ok(ReviewOutcome {
        path: format!("{}/{slug}/review-{n}.md", ht::FEATURES_DIR),
        n,
        line,
        changed_lines,
    })
}

/// Where the bundled `hi` helper is, for the Track view's hints.
#[tauri::command]
pub fn track_hi_path(app: AppHandle) -> Option<String> {
    crate::pty::launch::hi_path(&app).map(|p| p.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approve_skip_and_revert_refuse_anything_but_a_slug() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        ht::create(dir.path(), "demo", ht::Track::Light, "Demo", "").unwrap();
        std::fs::create_dir_all(dir.path().join("outside")).unwrap();
        for bad in ["../outside", "Demo Search", "", "a/b"] {
            let err = track_approve(root.clone(), bad.to_string()).unwrap_err();
            assert!(
                err.starts_with("not a feature slug:"),
                "approve {bad:?}: {err}"
            );
            let err = track_skip(root.clone(), bad.to_string()).unwrap_err();
            assert!(
                err.starts_with("not a feature slug:"),
                "skip {bad:?}: {err}"
            );
            let err = track_revert_gate(root.clone(), bad.to_string(), "plan".into()).unwrap_err();
            assert!(
                err.starts_with("not a feature slug:"),
                "revert {bad:?}: {err}"
            );
        }
        assert!(!dir.path().join("outside/feature.md").exists());
        // A real slug still reaches the state machine (which has its own say).
        let err = track_approve(root, "demo".into()).unwrap_err();
        assert!(!err.starts_with("not a feature slug:"), "{err}");
    }

    #[test]
    fn promote_creates_the_folder_and_the_branch_like_hi_feature_new() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(root)
                .args(args)
                .output()
                .expect("git");
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        git(&["init", "-q", "-b", "main"]);
        git(&[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@test",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "root",
        ]);
        let out = track_promote(
            root.to_string_lossy().to_string(),
            "demo-search".into(),
            "Light".into(),
            Some("Demo".into()),
        )
        .unwrap();
        assert!(out.created);
        assert_eq!(
            out.branch.as_deref(),
            Some("Switched to a new branch hermes/demo-search")
        );
        assert_eq!(git(&["branch", "--show-current"]), "hermes/demo-search");
        assert!(root
            .join(".hermes/features/demo-search/feature.md")
            .is_file());
        // Outside a repository there is no branch to speak of.
        let plain = tempfile::tempdir().unwrap();
        let out = track_promote(
            plain.path().to_string_lossy().to_string(),
            "x".into(),
            "Quick".into(),
            None,
        )
        .unwrap();
        assert!(!out.created && out.branch.is_none());
    }

    #[test]
    fn a_snapshot_lists_every_feature_with_its_texts_and_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let empty = snapshot(root);
        assert!(empty.features.is_empty());
        ht::create(root, "demo", ht::Track::Light, "Demo", "").unwrap();
        ht::start_phase(root, "demo", None).unwrap();
        std::fs::write(
            root.join(".hermes/features/demo/questions.md"),
            "- [ ] ! Which?\n",
        )
        .unwrap();
        let snap = snapshot(root);
        assert_eq!(snap.features.len(), 1);
        let f = &snap.features[0];
        assert_eq!(f.slug, "demo");
        assert!(f.feature_text.starts_with("---\nslug: demo"));
        assert_eq!(f.questions_text.as_deref(), Some("- [ ] ! Which?\n"));
        assert_eq!(f.files.len(), 1);
        assert_eq!(
            (f.files[0].name.as_str(), f.files[0].lines),
            ("questions.md", 1)
        );
        assert!(f.feature_modified_at > 0 && f.files[0].modified_at > 0);
        assert_ne!(digest(&empty), digest(&snap));
        // `at` never counts as a change.
        let again = snapshot(root);
        assert_eq!(digest(&snap), digest(&again));
    }

    #[test]
    fn only_track_files_can_be_read() {
        let dir = tempfile::tempdir().unwrap();
        assert!(readable(dir.path(), "demo", "plan.md").is_ok());
        assert!(readable(dir.path(), "demo", "../../secret").is_err());
        assert!(readable(dir.path(), "../x", "plan.md").is_err());
        assert!(readable(dir.path(), "demo", "feature.md").is_ok());
    }

    #[test]
    fn a_review_is_a_diff_against_the_handed_over_version_or_the_whole_file() {
        let before = "# Plan\n\n- [ ] index\n- [ ] query\n";
        let after = "# Plan\n\n- [ ] index (with tests)\n- [ ] query\n";
        let (text, line, changed) = review_text("demo", "plan.md", 2, Some(before), after).unwrap();
        assert!(text.starts_with("# Review 2: my edits to plan.md"));
        assert!(
            text.contains("-- [ ] index\n+- [ ] index (with tests)"),
            "{text}"
        );
        assert_eq!(changed, 2);
        assert_eq!(line, "hermes review: read .hermes/features/demo/review-2.md and apply my edits to plan.md, then continue");
        let (text, _, changed) = review_text("demo", "plan.md", 1, None, after).unwrap();
        assert!(text.contains("The file as I want it"));
        assert_eq!(changed, 4);
        let (text, _, _) = review_text("demo", "plan.md", 1, Some(after), after).unwrap();
        assert!(
            text.contains("The file as I want it"),
            "identical: send the file"
        );
    }

    #[test]
    fn write_review_numbers_files_and_returns_the_line() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        ht::create(root, "demo", ht::Track::Light, "", "").unwrap();
        std::fs::write(root.join(".hermes/features/demo/plan.md"), "a\nb\n").unwrap();
        let wt = root.to_string_lossy().to_string();
        let one = track_write_review(
            wt.clone(),
            "demo".into(),
            "plan.md".into(),
            Some("a\n".into()),
        )
        .unwrap();
        assert_eq!(
            (one.n, one.path.as_str()),
            (1, ".hermes/features/demo/review-1.md")
        );
        assert_eq!(one.changed_lines, 1);
        assert!(root.join(".hermes/features/demo/review-1.md").is_file());
        let two = track_write_review(wt.clone(), "demo".into(), "plan.md".into(), None).unwrap();
        assert_eq!(two.n, 2);
        assert!(track_write_review(wt, "demo".into(), "../x".into(), None).is_err());
        assert!(
            track_write_review("relative".into(), "demo".into(), "plan.md".into(), None).is_err()
        );
    }

    #[test]
    fn watch_state_tracks_sessions_per_worktree_and_notices_changes() {
        let dir = tempfile::tempdir().unwrap();
        let state = TrackWatchState::default();
        let wt = dir.path().to_string_lossy().to_string();
        let snap = state.watch("s1", &wt).unwrap();
        assert_eq!(snap.worktree_path, wt);
        state.watch("s2", &wt).unwrap();
        assert_eq!(state.watched_paths(), vec![wt.clone()]);
        // The poll compares digests: a new feature folder is a change once.
        let unchanged = state.last.lock().unwrap().get(&wt).cloned();
        assert_eq!(unchanged, Some(digest(&snapshot(dir.path()))));
        ht::create(dir.path(), "demo", ht::Track::Light, "", "").unwrap();
        assert_ne!(unchanged, Some(digest(&snapshot(dir.path()))));
        state.unwatch("s1");
        assert_eq!(state.watched_paths(), vec![wt.clone()]);
        state.unwatch("s2");
        assert!(state.watched_paths().is_empty());
        assert!(state.last.lock().unwrap().is_empty());
        assert!(state.watch("s3", "not/absolute").is_err());
    }
}
