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
    /// feature.md, at most [`TEXT_CAP`] bytes of it.
    pub feature_text: String,
    pub feature_modified_at: i64,
    /// feature.md's size in bytes.
    pub feature_size: u64,
    /// feature.md is larger than [`TEXT_CAP`]: `feature_text` is its start.
    pub feature_truncated: bool,
    /// questions.md, at most [`TEXT_CAP`] bytes of it.
    pub questions_text: Option<String>,
    pub files: Vec<TrackFileInfo>,
}

/// The most of a track file the watcher reads and sends to the window. A
/// feature.md is a few lines; one an agent dumped a log into is shown as
/// "too large" instead of being re-read and shipped whole.
pub const TEXT_CAP: u64 = 256 * 1024;

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

/// The first `cap` bytes of a file as text (cut back to a character
/// boundary), and whether there was more.
fn read_capped(path: &Path, cap: u64) -> Option<(String, bool)> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let mut buf = Vec::new();
    file.take(cap + 1).read_to_end(&mut buf).ok()?;
    let truncated = buf.len() as u64 > cap;
    if truncated {
        buf.truncate(cap as usize);
    }
    let text = match String::from_utf8(buf) {
        Ok(t) => t,
        Err(e) => {
            let valid = e.utf8_error().valid_up_to();
            let mut bytes = e.into_bytes();
            bytes.truncate(valid);
            String::from_utf8(bytes).unwrap_or_default()
        }
    };
    Some((text, truncated))
}

/// A file's line count, read in blocks (never the whole file at once).
fn count_lines(path: &Path) -> Option<usize> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = [0u8; 64 * 1024];
    let (mut lines, mut last) = (0usize, b'\n');
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        lines += buf[..n].iter().filter(|b| **b == b'\n').count();
        last = buf[n - 1];
    }
    // Like str::lines: a last line without a newline still counts.
    Some(if last == b'\n' { lines } else { lines + 1 })
}

/// Read the state of every feature folder in a worktree.
pub fn snapshot(worktree: &Path) -> TrackWorktreeSnapshot {
    let mut features = Vec::new();
    for slug in ht::list_features(worktree) {
        let dir = ht::FeatureDir::new(worktree, &slug);
        let feature_file = dir.feature_file();
        let feature_size = std::fs::metadata(&feature_file)
            .map(|m| m.len())
            .unwrap_or(0);
        let (feature_text, feature_truncated) =
            read_capped(&feature_file, TEXT_CAP).unwrap_or_default();
        let questions_text = read_capped(&dir.dir().join("questions.md"), TEXT_CAP).map(|(t, _)| t);
        let mut files = Vec::new();
        for name in READABLE.iter().skip(1) {
            let path = dir.dir().join(name);
            if let Some(lines) = count_lines(&path) {
                files.push(TrackFileInfo {
                    name: (*name).to_string(),
                    lines,
                    modified_at: mtime_ms(&path),
                });
            }
        }
        features.push(TrackFeatureSnapshot {
            slug,
            feature_text,
            feature_modified_at: mtime_ms(&feature_file),
            feature_size,
            feature_truncated,
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

/// What a poll looks at first, from `stat` calls only: the branch and the
/// size and modification time of every track file. A worktree whose
/// fingerprint did not move is not read at all.
fn fingerprint(worktree: &Path) -> String {
    let stamp = |p: &Path| match std::fs::metadata(p) {
        Ok(m) => {
            let t = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            format!("{}:{t}", m.len())
        }
        Err(_) => "-".to_string(),
    };
    let mut out = ht::current_branch(worktree).unwrap_or_default();
    for slug in ht::list_features(worktree) {
        let dir = ht::FeatureDir::new(worktree, &slug).dir();
        out.push('\n');
        out.push_str(&slug);
        for name in READABLE {
            out.push(' ');
            out.push_str(&stamp(&dir.join(name)));
        }
    }
    out
}

#[derive(Default)]
pub struct TrackWatchState {
    /// worktree path -> sessions attached to it.
    watched: Mutex<BTreeMap<String, BTreeSet<String>>>,
    last: Mutex<HashMap<String, String>>,
    /// worktree path -> its fingerprint at the last read.
    prints: Mutex<HashMap<String, String>>,
    stopped: AtomicBool,
}

impl TrackWatchState {
    /// One poll of one worktree: the snapshot when something changed since
    /// the last one, else None (and nothing but `stat` calls were made).
    fn poll(&self, path: &str) -> Option<TrackWorktreeSnapshot> {
        let print = fingerprint(Path::new(path));
        let moved = self
            .prints
            .lock()
            .map(|mut p| p.insert(path.to_string(), print.clone()) != Some(print))
            .unwrap_or(true);
        if !moved {
            return None;
        }
        let snap = snapshot(Path::new(path));
        let d = digest(&snap);
        let changed = self
            .last
            .lock()
            .map(|mut last| last.insert(path.to_string(), d.clone()) != Some(d))
            .unwrap_or(false);
        changed.then_some(snap)
    }
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
                if let Some(snap) = state.poll(&path) {
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
        let print = fingerprint(&path);
        let snap = snapshot(&path);
        if let Ok(mut p) = self.prints.lock() {
            p.insert(key.clone(), print);
        }
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
            if let Ok(mut prints) = self.prints.lock() {
                prints.retain(|k, _| live.contains(k));
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
    /// Every file written (feature.md, the phase prompts, the command).
    pub written: Vec<WrittenFile>,
}

/// One file "Make it a feature" wrote, so Undo can remove exactly it.
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WrittenFile {
    /// Relative to the worktree, forward slashes.
    pub path: String,
    /// FNV-1a of the bytes written: Undo leaves a file someone changed since.
    pub hash: String,
}

fn fnv1a(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

fn relative_slash(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// The files "Make it a feature" would write in this worktree now (the
/// confirmation says how many and where): feature.md, and the phase prompts
/// and the Claude command where the repository has none yet.
pub fn promote_plan(root: &Path, slug: &str, track: ht::Track) -> Vec<String> {
    if track == ht::Track::Quick {
        return Vec::new();
    }
    let mut out = vec![relative_slash(
        root,
        &ht::FeatureDir::new(root, slug).feature_file(),
    )];
    for phase in ht::phases::PROMPTED_PHASES {
        let path = root
            .join(ht::PHASES_DIR)
            .join(format!("{}.md", phase.as_str()));
        if !path.exists() && phase.default_prompt().is_some() {
            out.push(relative_slash(root, &path));
        }
    }
    if !root.join(ht::CLAUDE_COMMAND_FILE).exists() {
        out.push(ht::CLAUDE_COMMAND_FILE.replace('\\', "/"));
    }
    out
}

/// What "Make it a feature" would write, for its confirmation.
#[tauri::command]
pub fn track_promote_plan(
    worktree_path: String,
    slug: String,
    track: String,
) -> Result<Vec<String>, String> {
    let root = absolute_dir(&worktree_path)?;
    let slug = checked_slug(&slug)?;
    let track = ht::Track::parse(&track).ok_or_else(|| format!("unknown track {track:?}"))?;
    Ok(promote_plan(&root, slug, track))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UndoPromoteOutcome {
    /// Files removed (unchanged since "Make it a feature" wrote them).
    pub removed: Vec<String>,
    /// Files kept because they changed since (an agent or the person wrote them).
    pub kept: Vec<String>,
}

/// Undo of "Make it a feature": remove exactly the files it wrote that
/// nobody changed since, then the folders left empty. A file that changed
/// is kept and named, never deleted.
pub fn undo_promote(root: &Path, written: &[WrittenFile]) -> UndoPromoteOutcome {
    let mut out = UndoPromoteOutcome {
        removed: Vec::new(),
        kept: Vec::new(),
    };
    let mut dirs: BTreeSet<PathBuf> = BTreeSet::new();
    for w in written {
        // Only paths inside the two folders it writes to.
        let rel = Path::new(&w.path);
        let inside = (w.path.starts_with(".hermes/") || w.path.starts_with(".claude/commands/"))
            && rel
                .components()
                .all(|c| matches!(c, std::path::Component::Normal(_)));
        if !inside {
            out.kept.push(w.path.clone());
            continue;
        }
        let path = root.join(rel);
        match std::fs::read(&path) {
            Ok(bytes) if fnv1a(&bytes) == w.hash => match std::fs::remove_file(&path) {
                Ok(()) => {
                    out.removed.push(w.path.clone());
                    let mut d = path.parent();
                    while let Some(dir) = d {
                        if dir == root {
                            break;
                        }
                        dirs.insert(dir.to_path_buf());
                        d = dir.parent();
                    }
                }
                Err(_) => out.kept.push(w.path.clone()),
            },
            Ok(_) => out.kept.push(w.path.clone()),
            Err(_) => {}
        }
    }
    // Deepest first; remove_dir refuses a folder that is not empty.
    for dir in dirs.iter().rev() {
        let _ = std::fs::remove_dir(dir);
    }
    out
}

/// Undo "Make it a feature" (the toast's Undo).
#[tauri::command]
pub fn track_undo_promote(
    worktree_path: String,
    written: Vec<WrittenFile>,
) -> Result<UndoPromoteOutcome, String> {
    let root = absolute_dir(&worktree_path)?;
    Ok(undo_promote(&root, &written))
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
    let written = out
        .feature_file
        .iter()
        .chain(out.seeded.iter())
        .filter_map(|p| {
            std::fs::read(p).ok().map(|bytes| WrittenFile {
                path: relative_slash(&root, p),
                hash: fnv1a(&bytes),
            })
        })
        .collect();
    let branch = ht::ensure_branch(&root, &slug);
    Ok(PromoteOutcome {
        created: out.created,
        slug,
        feature_file: out.feature_file.map(|p| p.to_string_lossy().to_string()),
        branch,
        written,
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

/// Pure: the review file's text and the line for the agent. The person's
/// edits are already saved in the file (the diff runs from what the agent
/// handed over to what is there now), so the agent is never asked to apply
/// them; and while the phase waits at its gate it is told to take them into
/// account and NOT to hand the phase over again (the gate already waits).
pub fn review_text(
    slug: &str,
    name: &str,
    n: u32,
    before: Option<&str>,
    after: &str,
    waiting: bool,
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
            format!("The file as I saved it:\n\n```markdown\n{after}\n```\n"),
            after.lines().count(),
        ),
    };
    let file = format!("{}/{slug}/{name}", ht::FEATURES_DIR);
    let (ask, line) = if waiting {
        (
            format!("I edited `{file}` (diff below); my edits are already in the file. Take them into account; the gate is still waiting — do not run `hi phase done` again."),
            format!("hermes review: I edited {name} (diff in {rel}). Take it into account; the gate is still waiting — do not run `hi phase done` again."),
        )
    } else {
        (
            format!("I edited `{file}` (diff below); my edits are already in the file. Take them into account and keep working on the phase from there."),
            format!("hermes review: I edited {name} (diff in {rel}). Take it into account and keep working on the phase from there."),
        )
    };
    let text = format!("# Review {n}: my edits to {name}\n\n{ask}\n\n{body}");
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
    let waiting = ht::FeatureDir::new(&root, &slug)
        .load()
        .map(|l| l.meta.gate == ht::Gate::Waiting)
        .unwrap_or(false);
    let (text, line, changed_lines) =
        review_text(&slug, &name, n, baseline.as_deref(), &after, waiting)?;
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
    fn a_huge_feature_md_is_capped_and_an_unchanged_worktree_is_not_read_again() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        ht::create(root, "big", ht::Track::Light, "Big", "").unwrap();
        let file = root.join(".hermes/features/big/feature.md");
        let head = std::fs::read_to_string(&file).unwrap();
        let big = format!("{head}{}", "log line é\n".repeat(60_000));
        std::fs::write(&file, &big).unwrap();
        let snap = snapshot(root);
        let f = &snap.features[0];
        assert!(f.feature_truncated);
        assert_eq!(f.feature_size, big.len() as u64);
        assert!(f.feature_text.len() as u64 <= TEXT_CAP);
        assert!(f.feature_text.starts_with("---\nslug: big"));
        // A plan file's lines are counted without reading it whole.
        std::fs::write(root.join(".hermes/features/big/plan.md"), "a\nb\nc").unwrap();
        assert_eq!(
            count_lines(&root.join(".hermes/features/big/plan.md")),
            Some(3)
        );

        let state = TrackWatchState::default();
        let wt = root.to_string_lossy().to_string();
        state.watch("s1", &wt).unwrap();
        // Nothing moved: no snapshot (stat calls only).
        assert!(state.poll(&wt).is_none());
        assert!(state.poll(&wt).is_none());
        // A real change is seen once.
        std::fs::write(
            root.join(".hermes/features/big/questions.md"),
            "- [ ] Which?\n",
        )
        .unwrap();
        assert!(state.poll(&wt).is_some());
        assert!(state.poll(&wt).is_none());
    }

    #[test]
    fn make_it_a_feature_says_what_it_writes_and_undo_removes_exactly_that() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let wt = root.to_string_lossy().to_string();
        let plan = track_promote_plan(wt.clone(), "demo".into(), "Light".into()).unwrap();
        assert_eq!(plan[0], ".hermes/features/demo/feature.md");
        assert!(plan.contains(&".claude/commands/hermes-phase.md".to_string()));
        assert!(plan.iter().any(|p| p.starts_with(".hermes/phases/")));
        assert!(
            track_promote_plan(wt.clone(), "demo".into(), "Quick".into())
                .unwrap()
                .is_empty()
        );
        // The person already had a .claude folder of their own.
        std::fs::create_dir_all(root.join(".claude")).unwrap();
        std::fs::write(root.join(".claude/settings.json"), "{}").unwrap();
        let out = track_promote(wt.clone(), "demo".into(), "Light".into(), None).unwrap();
        assert_eq!(
            out.written
                .iter()
                .map(|w| w.path.clone())
                .collect::<Vec<_>>(),
            plan
        );
        // Someone edits one of them before Undo: it stays.
        std::fs::write(root.join(".hermes/phases/plan.md"), "my own plan prompt\n").unwrap();
        let undo = track_undo_promote(wt.clone(), out.written.clone()).unwrap();
        assert_eq!(undo.kept, vec![".hermes/phases/plan.md".to_string()]);
        assert_eq!(undo.removed.len(), plan.len() - 1);
        assert!(!root.join(".hermes/features").exists());
        assert!(!root.join(".claude/commands").exists());
        assert!(root.join(".claude/settings.json").is_file());
        assert!(root.join(".hermes/phases/plan.md").is_file());
        // Never outside the two folders.
        let evil = vec![WrittenFile {
            path: "../outside.txt".into(),
            hash: fnv1a(b""),
        }];
        assert_eq!(undo_promote(root, &evil).removed.len(), 0);
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
        let (text, line, changed) =
            review_text("demo", "plan.md", 2, Some(before), after, true).unwrap();
        assert!(text.starts_with("# Review 2: my edits to plan.md"));
        assert!(
            text.contains("-- [ ] index\n+- [ ] index (with tests)"),
            "{text}"
        );
        assert_eq!(changed, 2);
        // The edits are already in the file, and the gate waits: never
        // "apply" them, never "continue", never hand the phase over again.
        assert!(text.contains("I edited `.hermes/features/demo/plan.md` (diff below); my edits are already in the file. Take them into account; the gate is still waiting — do not run `hi phase done` again."), "{text}");
        assert!(!text.contains("Apply these edits") && !text.contains("continue the phase"));
        assert_eq!(line, "hermes review: I edited plan.md (diff in .hermes/features/demo/review-2.md). Take it into account; the gate is still waiting — do not run `hi phase done` again.");
        assert!(!line.contains("then continue"));
        // While the phase is still being written, the agent keeps working on it.
        let (text, line, _) =
            review_text("demo", "plan.md", 3, Some(before), after, false).unwrap();
        assert!(
            text.contains("keep working on the phase from there"),
            "{text}"
        );
        assert!(line.contains("keep working on the phase") && !line.contains("hi phase done"));
        let (text, _, changed) = review_text("demo", "plan.md", 1, None, after, true).unwrap();
        assert!(text.contains("The file as I saved it"));
        assert_eq!(changed, 4);
        let (text, _, _) = review_text("demo", "plan.md", 1, Some(after), after, true).unwrap();
        assert!(
            text.contains("The file as I saved it"),
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

    #[test]
    fn a_track_file_is_read_and_located_only_once_it_exists() {
        let dir = tempfile::tempdir().unwrap();
        ht::create(dir.path(), "demo", ht::Track::Light, "Demo", "").unwrap();
        let wt = dir.path().to_string_lossy().to_string();
        let on_disk = dir.path().join(".hermes/features/demo/feature.md");
        let text = track_read_file(wt.clone(), "demo".into(), "feature.md".into()).unwrap();
        assert!(!text.is_empty());
        assert_eq!(text, std::fs::read_to_string(&on_disk).unwrap());
        let path = track_file_path(wt.clone(), "demo".into(), "feature.md".into()).unwrap();
        assert_eq!(PathBuf::from(path), on_disk);
        let err = track_file_path(wt.clone(), "demo".into(), "research.md".into()).unwrap_err();
        assert!(err.contains("does not exist yet"), "{err}");
        assert!(track_read_file(wt, "demo".into(), "research.md".into()).is_err());
    }

    #[test]
    fn a_track_error_reads_as_its_message() {
        let e = ht::TrackError::NoFeature {
            path: PathBuf::from("/tmp/demo/feature.md"),
        };
        let want = e.to_string();
        assert!(!want.is_empty());
        assert_eq!(track_err(e), want);
    }

    #[test]
    fn times_are_wall_clock_milliseconds() {
        let before = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let now = now_ms();
        assert!(now >= before && now - before < 60_000, "{now} vs {before}");
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("f.txt");
        std::fs::write(&file, "x").unwrap();
        let m = mtime_ms(&file);
        assert!((m - before).abs() < 60_000, "{m} vs {before}");
        assert_eq!(mtime_ms(&dir.path().join("missing")), 0);
    }

    #[test]
    fn fnv1a_is_the_standard_64_bit_hash() {
        assert_eq!(fnv1a(b""), "cbf29ce484222325");
        assert_eq!(fnv1a(b"a"), "af63dc4c8601ec8c");
        assert_eq!(fnv1a(b"foobar"), "85944171f73967e8");
    }

    #[test]
    fn a_file_of_exactly_the_cap_is_whole_and_one_byte_more_is_cut() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.md");
        std::fs::write(&path, "abcd").unwrap();
        assert_eq!(read_capped(&path, 4), Some(("abcd".to_string(), false)));
        assert_eq!(read_capped(&path, 3), Some(("abc".to_string(), true)));
        // A feature.md of 100 KB is read whole (the cap is 256 KB).
        let big = "x".repeat(100 * 1024);
        std::fs::write(&path, &big).unwrap();
        assert_eq!(read_capped(&path, TEXT_CAP), Some((big, false)));
    }

    #[test]
    fn the_plan_leaves_out_phase_prompts_the_repository_already_has() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let all = promote_plan(root, "demo", ht::Track::Full);
        assert!(
            all.contains(&".hermes/phases/questions.md".to_string()),
            "{all:?}"
        );
        std::fs::create_dir_all(root.join(ht::PHASES_DIR)).unwrap();
        std::fs::write(root.join(ht::PHASES_DIR).join("questions.md"), "mine\n").unwrap();
        let plan = promote_plan(root, "demo", ht::Track::Full);
        assert!(
            !plan.contains(&".hermes/phases/questions.md".to_string()),
            "{plan:?}"
        );
        assert_eq!(plan.len(), all.len() - 1);
    }

    #[test]
    fn undo_never_removes_a_file_outside_the_two_folders() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("wt");
        std::fs::create_dir_all(root.join(".hermes")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(dir.path().join("outside.txt"), "x").unwrap();
        std::fs::write(root.join("src/main.rs"), "x").unwrap();
        let written = vec![
            // Starts with .hermes/ but climbs out of it.
            WrittenFile {
                path: ".hermes/../../outside.txt".into(),
                hash: fnv1a(b"x"),
            },
            // A plain path in neither folder.
            WrittenFile {
                path: "src/main.rs".into(),
                hash: fnv1a(b"x"),
            },
        ];
        let out = undo_promote(&root, &written);
        assert!(out.removed.is_empty(), "{out:?}");
        assert_eq!(out.kept.len(), 2);
        assert!(dir.path().join("outside.txt").is_file());
        assert!(root.join("src/main.rs").is_file());
    }

    #[test]
    fn a_review_while_the_gate_waits_says_not_to_hand_the_phase_over_again() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        ht::create(root, "demo", ht::Track::Light, "", "").unwrap();
        let fd = ht::FeatureDir::new(root, "demo");
        let phase = fd.load().unwrap().meta.phase;
        let file = fd.phase_file(phase).expect("the first phase has a file");
        std::fs::write(&file, "a\n").unwrap();
        let name = file.file_name().unwrap().to_string_lossy().to_string();
        let wt = root.to_string_lossy().to_string();
        let writing = track_write_review(wt.clone(), "demo".into(), name.clone(), None).unwrap();
        assert!(
            writing.line.contains("keep working on the phase"),
            "{}",
            writing.line
        );
        ht::finish_phase(root, "demo").unwrap();
        let waiting = track_write_review(wt, "demo".into(), name, None).unwrap();
        assert!(
            waiting.line.contains("the gate is still waiting"),
            "{}",
            waiting.line
        );
    }
}
