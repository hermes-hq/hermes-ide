//! The feature folder and its state machine.
//!
//! ```text
//!   hi phase <p>      phase: p, gate: none        (creates <p>.md from its template)
//!   hi phase done     gate: waiting               (the person reviews the file)
//!   hi approve        phase: next, gate: approved (people only)
//!   hi phase          starts the approved phase   (gate back to none)
//!   hi phase skip     phase: next, gate: none     (people only; recorded in `skipped:`)
//! ```
//!
//! Every write replaces the file atomically (write a sibling, then rename),
//! so a watcher polling the file never reads half of it.

use std::fs;
use std::path::{Path, PathBuf};

use crate::front_matter::{self, is_slug, Meta};
use crate::phases::{next_phase, split_prompt, track_phases, Gate, Phase, Track, PROMPTED_PHASES};
use crate::{CLAUDE_COMMAND_FILE, FEATURES_DIR, PHASES_DIR};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrackError {
    /// No feature.md for the slug.
    NoFeature {
        path: PathBuf,
    },
    /// feature.md can't be read (line n).
    FrontMatter {
        path: PathBuf,
        message: String,
        line: usize,
    },
    Io {
        path: PathBuf,
        message: String,
    },
    /// The state machine says no; the message says what to do instead.
    Refused(String),
    Git(String),
}

impl std::fmt::Display for TrackError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TrackError::NoFeature { path } => {
                write!(f, "no feature here: {} is missing", path.display())
            }
            TrackError::FrontMatter {
                path,
                message,
                line,
            } => {
                write!(
                    f,
                    "{} can't be read (line {line}): {message}",
                    path.display()
                )
            }
            TrackError::Io { path, message } => write!(f, "{}: {message}", path.display()),
            TrackError::Refused(m) => f.write_str(m),
            TrackError::Git(m) => write!(f, "git: {m}"),
        }
    }
}

impl std::error::Error for TrackError {}

fn io_err(path: &Path, e: std::io::Error) -> TrackError {
    TrackError::Io {
        path: path.to_path_buf(),
        message: e.to_string(),
    }
}

/// Write `text` to `path` through a sibling file and a rename.
pub fn write_atomic(path: &Path, text: &str) -> Result<(), TrackError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| io_err(parent, e))?;
    }
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let tmp = path.with_file_name(format!(".{file_name}.{}.tmp", std::process::id()));
    fs::write(&tmp, text).map_err(|e| io_err(&tmp, e))?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(io_err(path, e));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Loaded {
    pub text: String,
    pub meta: Meta,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeatureDir {
    pub root: PathBuf,
    pub slug: String,
}

impl FeatureDir {
    pub fn new(root: impl Into<PathBuf>, slug: impl Into<String>) -> FeatureDir {
        FeatureDir {
            root: root.into(),
            slug: slug.into(),
        }
    }

    pub fn dir(&self) -> PathBuf {
        self.root.join(FEATURES_DIR).join(&self.slug)
    }

    pub fn feature_file(&self) -> PathBuf {
        self.dir().join("feature.md")
    }

    pub fn phase_file(&self, phase: Phase) -> Option<PathBuf> {
        phase.file_name().map(|n| self.dir().join(n))
    }

    /// The folder relative to the worktree, with forward slashes (for
    /// prompts and git pathspecs).
    pub fn relative_dir(&self) -> String {
        format!("{FEATURES_DIR}/{}", self.slug)
    }

    pub fn load(&self) -> Result<Loaded, TrackError> {
        let path = self.feature_file();
        let text = match fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(TrackError::NoFeature { path })
            }
            Err(e) => return Err(io_err(&path, e)),
        };
        let parsed = front_matter::parse(&text).map_err(|e| TrackError::FrontMatter {
            path: path.clone(),
            message: e.message,
            line: e.line,
        })?;
        Ok(Loaded {
            text,
            meta: parsed.meta,
            body: parsed.body,
        })
    }

    fn set(&self, text: &str, keys: &[(&str, &str)]) -> Result<(), TrackError> {
        let path = self.feature_file();
        let out = front_matter::set_keys(text, keys).map_err(|e| TrackError::FrontMatter {
            path: path.clone(),
            message: e.message,
            line: e.line,
        })?;
        write_atomic(&path, &out)
    }
}

/// Slugs with a feature.md under `.hermes/features`, sorted.
pub fn list_features(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(root.join(FEATURES_DIR)) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if is_slug(&name) && entry.path().join("feature.md").is_file() {
                out.push(name);
            }
        }
    }
    out.sort();
    out
}

/// The feature a worktree is about: the one named by its `hermes/<slug>`
/// branch when that folder exists, else the only folder there is.
pub fn find_slug(root: &Path, branch: Option<&str>) -> Option<String> {
    let all = list_features(root);
    if let Some(slug) = branch.and_then(|b| b.strip_prefix("hermes/")) {
        if all.iter().any(|s| s == slug) {
            return Some(slug.to_string());
        }
    }
    match all.as_slice() {
        [one] => Some(one.clone()),
        _ => None,
    }
}

/// The current branch of a worktree, without running git: HEAD is a file.
pub fn current_branch(root: &Path) -> Option<String> {
    let git = root.join(".git");
    let git_dir = if git.is_file() {
        let text = fs::read_to_string(&git).ok()?;
        let rel = text.trim().strip_prefix("gitdir:")?.trim();
        let p = Path::new(rel);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            root.join(p)
        }
    } else {
        git
    };
    let head = fs::read_to_string(git_dir.join("HEAD")).ok()?;
    head.trim()
        .strip_prefix("ref: refs/heads/")
        .map(str::to_string)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateOutcome {
    /// False for a Quick track: nothing is written at all.
    pub created: bool,
    pub track: Track,
    pub feature_file: Option<PathBuf>,
    /// Phase prompts and the Claude command written because they were missing.
    pub seeded: Vec<PathBuf>,
}

const CLAUDE_COMMAND: &str = "---\ndescription: Run a Hermes feature-track phase (questions, research, design, structure, plan, implement, done)\n---\nRun `hi phase $ARGUMENTS` in the terminal and follow the instructions it prints. It tells you which file to write, its line cap, and how to hand the phase over for review (`hi phase done`). Never edit the `gate:` line of feature.md yourself; a person approves (or skips) phases from Hermes.\n";

/// Create `.hermes/features/<slug>/feature.md` for a Light or Full track,
/// seed the repository's phase prompts and the one Claude slash command
/// when they are missing. A Quick track creates nothing.
pub fn create(
    root: &Path,
    slug: &str,
    track: Track,
    title: &str,
    body: &str,
) -> Result<CreateOutcome, TrackError> {
    if !is_slug(slug) {
        return Err(TrackError::Refused(format!(
            "{slug:?} is not a slug: use lowercase letters, digits and dashes (a branch component)"
        )));
    }
    if track == Track::Quick {
        return Ok(CreateOutcome {
            created: false,
            track,
            feature_file: None,
            seeded: Vec::new(),
        });
    }
    let feature = FeatureDir::new(root, slug);
    let file = feature.feature_file();
    if file.exists() {
        return Err(TrackError::Refused(format!(
            "{} already exists; run `hi phase` to continue it",
            feature.relative_dir()
        )));
    }
    let first = track_phases(track)[0];
    write_atomic(
        &file,
        &front_matter::render_new(slug, track, first, title, body),
    )?;
    let seeded = seed_repo_files(root)?;
    Ok(CreateOutcome {
        created: true,
        track,
        feature_file: Some(file),
        seeded,
    })
}

/// Put the worktree on `hermes/<slug>` when it is a repository and not there
/// yet: `hi feature new` and the app's "Make it a feature" both go through
/// here, so one feature is one branch whichever way it was created. Never
/// fatal: the folder is what matters. Returns one line saying what happened,
/// or `None` outside a repository.
pub fn ensure_branch(root: &Path, slug: &str) -> Option<String> {
    if !root.join(".git").exists() {
        return None;
    }
    let want = format!("hermes/{slug}");
    if current_branch(root).as_deref() == Some(want.as_str()) {
        return Some(format!("On branch {want}"));
    }
    let out = crate::git_command()
        .arg("-C")
        .arg(root)
        .args(["switch", "-c", &want])
        .output();
    match out {
        Ok(o) if o.status.success() => Some(format!("Switched to a new branch {want}")),
        Ok(o) => Some(format!(
            "Stayed on the current branch (git switch -c {want} said: {})",
            String::from_utf8_lossy(&o.stderr).trim()
        )),
        Err(e) => Some(format!(
            "Stayed on the current branch (git not available: {e})"
        )),
    }
}

/// The phase prompts (`.hermes/phases/`) and the one Claude slash command,
/// where they are missing. Returns what was written.
pub fn seed_repo_files(root: &Path) -> Result<Vec<PathBuf>, TrackError> {
    let mut seeded = seed_phase_prompts(root)?;
    let command = root.join(CLAUDE_COMMAND_FILE);
    if !command.exists() {
        write_atomic(&command, CLAUDE_COMMAND)?;
        seeded.push(command);
    }
    Ok(seeded)
}

/// The first message an agent gets for a task tracked as a feature: the
/// task, how the track works, and the first phase's instructions (the
/// repository's `.hermes/phases/<phase>.md`, else the built-in), ending with
/// the gate: hand the file over with `hi phase done`, then stop and wait for
/// a person. Without it the agent only sees the task and does all of it at
/// once, while the Track panel waits for questions that never come.
pub fn first_prompt(root: &Path, slug: &str, track: Track, task: &str) -> String {
    let phases = track_phases(track);
    let Some(first) = phases.first().copied() else {
        return task.trim().to_string();
    };
    let (prompt, _) = prompt_for(root, first);
    let names = phases
        .iter()
        .map(|p| p.as_str())
        .collect::<Vec<_>>()
        .join(" → ");
    let dir = format!("{FEATURES_DIR}/{slug}");
    let mut text = format!(
        "Hermes Feature Track ({track}): this task is planned in phases before any code is written, and every phase stops at a gate for a person's approval.\n\n\
         The task (feature \"{slug}\", {dir}/feature.md):\n{task}\n\n\
         Phases: {names}. Do only the current phase. Do not write or change code before the implement phase.\n\n\
         Current phase: {first} (1 of {count}).\n\n{prompt}\n\n",
        track = track.as_str(),
        task = task.trim(),
        first = first.as_str(),
        count = phases.len(),
        prompt = prompt.trim(),
    );
    if let (Some(file), Some(cap)) = (first.file_name(), first.line_cap()) {
        text.push_str(&format!("Write {dir}/{file} (at most {cap} lines). "));
    }
    text.push_str(
        "When it is written, run `hi phase done`, then STOP: end your turn and wait. \
         A person reviews the file in Hermes and approves it or sends you edits. \
         Never edit the gate: line of feature.md yourself. \
         When Hermes tells you the phase was approved, run `hi phase` and follow what it prints for the next phase, the same way. \
         (`hi` is Hermes's helper on your PATH; if your shell does not find it, run \"$HERMES_BIN_DIR/hi\".)",
    );
    text
}

/// Copy the built-in prompts into `.hermes/phases/` where none exist, so a
/// repository can edit them. Returns what was written.
pub fn seed_phase_prompts(root: &Path) -> Result<Vec<PathBuf>, TrackError> {
    let mut written = Vec::new();
    for phase in PROMPTED_PHASES {
        let path = root.join(PHASES_DIR).join(format!("{}.md", phase.as_str()));
        if path.exists() {
            continue;
        }
        if let Some(text) = phase.default_prompt() {
            write_atomic(&path, text)?;
            written.push(path);
        }
    }
    Ok(written)
}

/// The prompt and template for a phase: the repository's file when it has
/// one, else the built-in.
pub fn prompt_for(root: &Path, phase: Phase) -> (String, String) {
    let path = root.join(PHASES_DIR).join(format!("{}.md", phase.as_str()));
    let text = fs::read_to_string(&path)
        .ok()
        .or_else(|| phase.default_prompt().map(str::to_string))
        .unwrap_or_default();
    split_prompt(&text)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartOutcome {
    pub phase: Phase,
    /// What to print: the prompt plus where to write and how to hand over.
    pub prompt: String,
    pub file: Option<PathBuf>,
    pub created_file: bool,
    pub cap: Option<usize>,
}

fn phase_list(track: Track) -> String {
    track_phases(track)
        .iter()
        .map(|p| p.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

/// `hi phase [name]`: start (or re-print) a phase.
pub fn start_phase(
    root: &Path,
    slug: &str,
    requested: Option<Phase>,
) -> Result<StartOutcome, TrackError> {
    let feature = FeatureDir::new(root, slug);
    let loaded = feature.load()?;
    let meta = &loaded.meta;
    if meta.track == Track::Quick {
        return Err(TrackError::Refused(
            "a Quick track has no phases; just do the work".to_string(),
        ));
    }
    let target = requested.unwrap_or(meta.phase);
    if target == Phase::Done {
        return Err(TrackError::Refused(format!(
            "{slug} is done; land it from Hermes or with `hi land`"
        )));
    }
    if !track_phases(meta.track).contains(&target) {
        return Err(TrackError::Refused(format!(
            "{} is not a phase of a {} track ({})",
            target.as_str(),
            meta.track.as_str(),
            phase_list(meta.track)
        )));
    }
    match meta.gate {
        Gate::Waiting if target != meta.phase => {
            return Err(TrackError::Refused(format!(
                "{} is waiting for a person's approval; nothing else starts until it is approved (or skipped) from Hermes",
                meta.phase.as_str()
            )));
        }
        Gate::None | Gate::Approved if target > meta.phase => {
            return Err(TrackError::Refused(format!(
                "finish {} first, then run `hi phase done`",
                meta.phase.as_str()
            )));
        }
        _ => {}
    }
    let mut created_file = false;
    let (prompt, template) = prompt_for(root, target);
    let file = feature.phase_file(target);
    if let Some(path) = &file {
        if !path.exists() {
            let text = if template.is_empty() {
                format!("# {}\n", capitalise(target.as_str()))
            } else {
                format!("{template}\n")
            };
            write_atomic(path, &text)?;
            created_file = true;
        }
    }
    // Re-printing a waiting phase changes nothing; starting one records it.
    if meta.gate != Gate::Waiting {
        feature.set(
            &loaded.text,
            &[("phase", target.as_str()), ("gate", "none")],
        )?;
    }
    let cap = target.line_cap();
    let mut text = prompt;
    text.push_str("\n\n—\n");
    match (&file, cap) {
        (Some(path), Some(cap)) => text.push_str(&format!(
            "Write {} (at most {cap} lines). When it is ready: hi phase done\nThen stop and wait: a person approves the phase in Hermes before the next one starts.\n",
            display_relative(root, path)
        )),
        _ => text.push_str("When the work is finished and the checks pass: hi phase done\nThen stop and wait for the person's review in Hermes.\n"),
    }
    Ok(StartOutcome {
        phase: target,
        prompt: text,
        file,
        created_file,
        cap,
    })
}

fn capitalise(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

fn display_relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    /// Path relative to the worktree.
    pub file: String,
    pub message: String,
}

/// Everything wrong with a feature folder: an unreadable feature.md, a
/// phase file over its line cap, the current phase's file missing.
pub fn check(root: &Path, slug: &str) -> Vec<Problem> {
    let feature = FeatureDir::new(root, slug);
    let rel = |p: &Path| display_relative(root, p);
    let loaded = match feature.load() {
        Ok(l) => l,
        Err(TrackError::FrontMatter {
            path,
            message,
            line,
        }) => {
            return vec![Problem {
                file: rel(&path),
                message: format!("can't be read (line {line}): {message}"),
            }]
        }
        Err(e) => {
            return vec![Problem {
                file: rel(&feature.feature_file()),
                message: e.to_string(),
            }]
        }
    };
    let mut problems = Vec::new();
    if loaded.text.lines().count() > 60 {
        problems.push(Problem {
            file: rel(&feature.feature_file()),
            message: format!(
                "has {} lines; keep feature.md under 60",
                loaded.text.lines().count()
            ),
        });
    }
    for phase in track_phases(loaded.meta.track) {
        let (Some(path), Some(cap)) = (feature.phase_file(*phase), phase.line_cap()) else {
            continue;
        };
        match fs::read_to_string(&path) {
            Ok(text) => {
                let lines = text.lines().count();
                if lines > cap {
                    problems.push(Problem {
                        file: rel(&path),
                        message: format!(
                            "has {lines} lines; the cap for {} is {cap}",
                            phase.as_str()
                        ),
                    });
                }
            }
            Err(_) if *phase == loaded.meta.phase && loaded.meta.gate == Gate::Waiting => {
                problems.push(Problem {
                    file: rel(&path),
                    message: format!("is missing but {} is waiting for review", phase.as_str()),
                });
            }
            Err(_) => {}
        }
    }
    problems
}

/// `hi phase done`: the phase's file is ready for a person to review.
pub fn finish_phase(root: &Path, slug: &str) -> Result<Phase, TrackError> {
    let feature = FeatureDir::new(root, slug);
    let loaded = feature.load()?;
    let meta = &loaded.meta;
    match meta.gate {
        Gate::Waiting => {
            return Err(TrackError::Refused(format!(
                "{} is already waiting for approval",
                meta.phase.as_str()
            )))
        }
        Gate::Approved => {
            return Err(TrackError::Refused(format!(
                "{} was approved but not started; run `hi phase` first",
                meta.phase.as_str()
            )))
        }
        Gate::None => {}
    }
    if meta.phase == Phase::Done {
        return Err(TrackError::Refused(format!("{slug} is already done")));
    }
    if let (Some(path), Some(cap)) = (feature.phase_file(meta.phase), meta.phase.line_cap()) {
        let text = fs::read_to_string(&path).map_err(|_| {
            TrackError::Refused(format!(
                "{} does not exist yet; run `hi phase {}` and write it",
                display_relative(root, &path),
                meta.phase.as_str()
            ))
        })?;
        let lines = text.lines().count();
        if lines > cap {
            return Err(TrackError::Refused(format!(
                "{} has {lines} lines; the cap for {} is {cap}. Cut it down, then run `hi phase done` again",
                display_relative(root, &path),
                meta.phase.as_str()
            )));
        }
    }
    feature.set(&loaded.text, &[("gate", "waiting")])?;
    Ok(meta.phase)
}

/// `hi phase skip`: move on without a review. Only a person skips (from
/// Hermes or their own shell); an agent never does, waiting gate or not:
/// deciding that a phase needs no review is the person's call. The skipped
/// phase is recorded in feature.md (`skipped:`, with when), so a skipped
/// phase is never mistaken for an approved one.
pub fn skip_phase(root: &Path, slug: &str, by_person: bool) -> Result<(Phase, Phase), TrackError> {
    skip_phase_at(root, slug, by_person, &utc_now_text())
}

/// [`skip_phase`] with the time to record.
pub fn skip_phase_at(
    root: &Path,
    slug: &str,
    by_person: bool,
    when: &str,
) -> Result<(Phase, Phase), TrackError> {
    let feature = FeatureDir::new(root, slug);
    let loaded = feature.load()?;
    let meta = &loaded.meta;
    if !by_person {
        return Err(TrackError::Refused(format!(
            "only a person can skip a phase; finish {} first, then run `hi phase done`",
            meta.phase.as_str()
        )));
    }
    if meta.phase == Phase::Done {
        return Err(TrackError::Refused(format!("{slug} is already done")));
    }
    let next = next_phase(meta.track, meta.phase);
    let path = feature.feature_file();
    let fm_err = |e: front_matter::FrontMatterError| TrackError::FrontMatter {
        path: path.clone(),
        message: e.message,
        line: e.line,
    };
    let text = front_matter::set_keys(&loaded.text, &[("phase", next.as_str()), ("gate", "none")])
        .map_err(fm_err)?;
    let mut skipped: Vec<String> = front_matter::list_value(&text, SKIPPED_KEY)
        .into_iter()
        .filter(|s| skipped_phase_of(s) != Some(meta.phase))
        .collect();
    skipped.push(format!("{} ({when})", meta.phase.as_str()));
    let text = front_matter::set_list(&text, SKIPPED_KEY, &skipped).map_err(fm_err)?;
    write_atomic(&path, &text)?;
    Ok((meta.phase, next))
}

/// The front matter key listing the phases a person skipped, each as
/// `research (2026-10-01 14:05 UTC)`.
pub const SKIPPED_KEY: &str = "skipped";

/// The phase of one `skipped:` item.
pub fn skipped_phase_of(item: &str) -> Option<Phase> {
    Phase::parse(item.split_whitespace().next()?)
}

/// Now, as `2026-10-01 14:05 UTC` (no comma: it goes in an inline list).
pub fn utc_now_text() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    utc_text(secs)
}

/// Seconds since the epoch as `2026-10-01 14:05 UTC`.
pub fn utc_text(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // The civil date of a day count (Howard Hinnant's days_from_civil, inverted).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02} UTC",
        rem / 3600,
        (rem % 3600) / 60
    )
}

/// `hi approve` / ⌘⏎: a person approves the waiting phase. The file moves
/// to the next phase with `gate: approved`; `hi phase` then starts it.
pub fn approve(root: &Path, slug: &str) -> Result<(Phase, Phase), TrackError> {
    let feature = FeatureDir::new(root, slug);
    let loaded = feature.load()?;
    let meta = &loaded.meta;
    if meta.gate != Gate::Waiting {
        return Err(TrackError::Refused(format!(
            "nothing to approve: {} is not waiting (gate: {})",
            meta.phase.as_str(),
            meta.gate.as_str()
        )));
    }
    let next = next_phase(meta.track, meta.phase);
    feature.set(
        &loaded.text,
        &[("phase", next.as_str()), ("gate", "approved")],
    )?;
    Ok((meta.phase, next))
}

/// Undo an approval nobody gave: back to `phase`, waiting again.
pub fn revert_gate(root: &Path, slug: &str, phase: Phase) -> Result<(), TrackError> {
    let feature = FeatureDir::new(root, slug);
    let loaded = feature.load()?;
    feature.set(
        &loaded.text,
        &[("phase", phase.as_str()), ("gate", "waiting")],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn meta(root: &Path, slug: &str) -> Meta {
        FeatureDir::new(root, slug).load().unwrap().meta
    }

    #[test]
    fn the_first_prompt_carries_the_task_the_first_phase_and_the_gate() {
        let dir = repo();
        let text = first_prompt(
            dir.path(),
            "fail-notice",
            Track::Full,
            "  Build the failure notification  ",
        );
        assert!(text.contains("The task (feature \"fail-notice\", .hermes/features/fail-notice/feature.md):\nBuild the failure notification\n"), "{text}");
        assert!(
            text.contains("Phases: questions → research → design → structure → plan → implement."),
            "{text}"
        );
        assert!(
            text.contains("Current phase: questions (1 of 6)."),
            "{text}"
        );
        // The built-in questions prompt, without its template.
        assert!(text.contains("# Phase: questions"), "{text}");
        assert!(!text.contains("## Template"), "{text}");
        assert!(
            text.contains("Write .hermes/features/fail-notice/questions.md (at most 40 lines)."),
            "{text}"
        );
        assert!(
            text.contains("run `hi phase done`, then STOP: end your turn and wait."),
            "{text}"
        );
        // The repository's own prompt wins.
        let phases = dir.path().join(PHASES_DIR);
        fs::create_dir_all(&phases).unwrap();
        fs::write(
            phases.join("questions.md"),
            "# Phase: questions\n\nAsk about the database only.\n\n## Template\n# Q\n",
        )
        .unwrap();
        let own = first_prompt(dir.path(), "fail-notice", Track::Light, "x");
        assert!(own.contains("Ask about the database only."), "{own}");
        assert!(
            own.contains("Phases: questions → plan → implement."),
            "{own}"
        );
        assert!(own.contains("Current phase: questions (1 of 3)."), "{own}");
        // A Quick track has no phases: just the task.
        assert_eq!(
            first_prompt(dir.path(), "q", Track::Quick, " do it "),
            "do it"
        );
    }

    #[test]
    fn seeding_writes_the_phase_prompts_and_the_command_once() {
        let dir = repo();
        let first = seed_repo_files(dir.path()).unwrap();
        assert_eq!(first.len(), PROMPTED_PHASES.len() + 1);
        assert!(dir.path().join(CLAUDE_COMMAND_FILE).exists());
        assert!(seed_repo_files(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn quick_creates_nothing_and_light_creates_the_folder_prompts_and_command() {
        let dir = repo();
        let out = create(dir.path(), "quick-one", Track::Quick, "", "").unwrap();
        assert!(!out.created);
        assert!(
            !dir.path().join(".hermes").exists(),
            "a Quick task creates no .hermes/features folder"
        );

        let out = create(dir.path(), "demo", Track::Light, "Demo", "Body").unwrap();
        assert!(out.created);
        let m = meta(dir.path(), "demo");
        assert_eq!(
            (m.track, m.phase, m.gate),
            (Track::Light, Phase::Questions, Gate::None)
        );
        assert!(dir.path().join(".hermes/phases/plan.md").is_file());
        assert!(dir
            .path()
            .join(".claude/commands/hermes-phase.md")
            .is_file());
        assert_eq!(out.seeded.len(), 7, "six prompts and one command");
        assert_eq!(list_features(dir.path()), vec!["demo"]);
        // A second feature seeds nothing again and never overwrites.
        fs::write(
            dir.path().join(".hermes/phases/plan.md"),
            "# custom\n## Template\n# My plan\n",
        )
        .unwrap();
        let out = create(dir.path(), "other", Track::Full, "", "").unwrap();
        assert!(out.seeded.is_empty());
        assert_eq!(
            fs::read_to_string(dir.path().join(".hermes/phases/plan.md")).unwrap(),
            "# custom\n## Template\n# My plan\n"
        );
        assert!(matches!(
            create(dir.path(), "demo", Track::Light, "", ""),
            Err(TrackError::Refused(_))
        ));
        assert!(matches!(
            create(dir.path(), "Bad Slug", Track::Light, "", ""),
            Err(TrackError::Refused(_))
        ));
    }

    #[test]
    fn a_light_track_walks_questions_plan_implement_through_gates() {
        let dir = repo();
        let root = dir.path();
        create(root, "demo", Track::Light, "", "").unwrap();
        let start = start_phase(root, "demo", None).unwrap();
        assert_eq!(start.phase, Phase::Questions);
        assert!(start.created_file);
        assert!(start.prompt.starts_with("# Phase: questions"));
        assert!(start
            .prompt
            .contains("Write .hermes/features/demo/questions.md (at most 40 lines)"));
        assert!(
            fs::read_to_string(root.join(".hermes/features/demo/questions.md"))
                .unwrap()
                .starts_with("# Questions")
        );

        // Cannot jump ahead without finishing; the refusal never offers a skip.
        let e = start_phase(root, "demo", Some(Phase::Plan)).unwrap_err();
        assert_eq!(
            e.to_string(),
            "finish questions first, then run `hi phase done`"
        );
        // Research is not a Light phase.
        let e = start_phase(root, "demo", Some(Phase::Research)).unwrap_err();
        assert!(
            e.to_string().contains("not a phase of a Light track"),
            "{e}"
        );

        assert_eq!(finish_phase(root, "demo").unwrap(), Phase::Questions);
        assert_eq!(meta(root, "demo").gate, Gate::Waiting);
        // Waiting: the agent can re-print the prompt but cannot move.
        assert_eq!(
            start_phase(root, "demo", None).unwrap().phase,
            Phase::Questions
        );
        assert_eq!(meta(root, "demo").gate, Gate::Waiting);
        assert!(start_phase(root, "demo", Some(Phase::Plan)).is_err());
        assert!(finish_phase(root, "demo").is_err());
        assert!(
            skip_phase(root, "demo", false).is_err(),
            "an agent cannot skip a waiting gate"
        );

        let (from, to) = approve(root, "demo").unwrap();
        assert_eq!((from, to), (Phase::Questions, Phase::Plan));
        let m = meta(root, "demo");
        assert_eq!((m.phase, m.gate), (Phase::Plan, Gate::Approved));
        assert!(approve(root, "demo").is_err(), "nothing waiting");
        assert!(
            finish_phase(root, "demo").is_err(),
            "approved but not started"
        );

        let start = start_phase(root, "demo", None).unwrap();
        assert_eq!(start.phase, Phase::Plan);
        assert_eq!(meta(root, "demo").gate, Gate::None);
        // Over the cap: done refuses and says so.
        let plan = root.join(".hermes/features/demo/plan.md");
        fs::write(&plan, "- [ ] x\n".repeat(121)).unwrap();
        let e = finish_phase(root, "demo").unwrap_err();
        assert!(
            e.to_string()
                .contains("has 121 lines; the cap for plan is 120"),
            "{e}"
        );
        assert_eq!(
            check(root, "demo")[0].message,
            "has 121 lines; the cap for plan is 120"
        );
        fs::write(&plan, "- [ ] x\n".repeat(3)).unwrap();
        assert!(check(root, "demo").is_empty());
        finish_phase(root, "demo").unwrap();
        approve(root, "demo").unwrap();
        assert_eq!(meta(root, "demo").phase, Phase::Implement);
        let start = start_phase(root, "demo", None).unwrap();
        assert!(start.file.is_none() && start.cap.is_none());
        assert!(start.prompt.contains("When the work is finished"));
        finish_phase(root, "demo").unwrap();
        assert_eq!(
            approve(root, "demo").unwrap(),
            (Phase::Implement, Phase::Done)
        );
        assert!(start_phase(root, "demo", None)
            .unwrap_err()
            .to_string()
            .contains("is done"));
        assert!(finish_phase(root, "demo").is_err());
    }

    #[test]
    fn an_agent_never_skips_whatever_the_gate() {
        let dir = repo();
        let root = dir.path();
        create(root, "full", Track::Full, "", "").unwrap();
        let before = fs::read_to_string(root.join(".hermes/features/full/feature.md")).unwrap();
        // Gate none, then approved (the person approved questions), then waiting.
        let e = skip_phase(root, "full", false).unwrap_err();
        assert!(
            e.to_string()
                .contains("finish questions first, then run `hi phase done`"),
            "{e}"
        );
        start_phase(root, "full", None).unwrap();
        finish_phase(root, "full").unwrap();
        assert!(skip_phase(root, "full", false).is_err());
        approve(root, "full").unwrap();
        for _ in 0..5 {
            assert!(skip_phase(root, "full", false).is_err());
        }
        let m = meta(root, "full");
        assert_eq!((m.phase, m.gate), (Phase::Research, Gate::Approved));
        assert!(!before.contains("skipped"));
        assert!(front_matter::list_value(
            &fs::read_to_string(root.join(".hermes/features/full/feature.md")).unwrap(),
            SKIPPED_KEY
        )
        .is_empty());
    }

    #[test]
    fn a_skip_is_recorded_with_when_and_survives_a_second_skip() {
        let dir = repo();
        let root = dir.path();
        create(root, "full", Track::Full, "", "").unwrap();
        skip_phase_at(root, "full", true, "2026-10-01 14:05 UTC").unwrap();
        skip_phase_at(root, "full", true, "2026-10-01 14:06 UTC").unwrap();
        let text = fs::read_to_string(root.join(".hermes/features/full/feature.md")).unwrap();
        assert!(
            text.contains(
                "skipped: [questions (2026-10-01 14:05 UTC), research (2026-10-01 14:06 UTC)]"
            ),
            "{text}"
        );
        let items = front_matter::list_value(&text, SKIPPED_KEY);
        assert_eq!(
            items
                .iter()
                .map(|i| skipped_phase_of(i))
                .collect::<Vec<_>>(),
            vec![Some(Phase::Questions), Some(Phase::Research)]
        );
        assert_eq!(meta(root, "full").phase, Phase::Design);
        assert_eq!(utc_text(0), "1970-01-01 00:00 UTC");
        assert_eq!(utc_text(1_790_863_500), "2026-10-01 14:05 UTC");
    }

    #[test]
    fn skip_moves_on_without_a_gate_and_revert_puts_a_gate_back() {
        let dir = repo();
        let root = dir.path();
        create(root, "full", Track::Full, "", "").unwrap();
        assert_eq!(
            skip_phase(root, "full", true).unwrap(),
            (Phase::Questions, Phase::Research)
        );
        assert_eq!(meta(root, "full").gate, Gate::None);
        start_phase(root, "full", None).unwrap();
        finish_phase(root, "full").unwrap();
        // A person can skip a waiting gate.
        assert_eq!(
            skip_phase(root, "full", true).unwrap(),
            (Phase::Research, Phase::Design)
        );
        // Someone wrote gate: approved by hand: revert to the waiting phase.
        let feature = FeatureDir::new(root, "full");
        let text = feature.load().unwrap().text;
        write_atomic(
            &feature.feature_file(),
            &front_matter::set_keys(&text, &[("phase", "plan"), ("gate", "approved")]).unwrap(),
        )
        .unwrap();
        revert_gate(root, "full", Phase::Design).unwrap();
        let m = meta(root, "full");
        assert_eq!((m.phase, m.gate), (Phase::Design, Gate::Waiting));
    }

    #[test]
    fn unreadable_feature_md_is_reported_with_its_line() {
        let dir = repo();
        let root = dir.path();
        create(root, "demo", Track::Light, "", "").unwrap();
        fs::write(
            root.join(".hermes/features/demo/feature.md"),
            "---\nslug: demo\ntrack: Light\ngate: maybe\n---\n",
        )
        .unwrap();
        let e = FeatureDir::new(root, "demo").load().unwrap_err();
        assert!(
            matches!(e, TrackError::FrontMatter { line: 4, .. }),
            "{e:?}"
        );
        assert!(e.to_string().contains("can't be read (line 4)"));
        assert_eq!(
            check(root, "demo")[0].message,
            "can't be read (line 4): gate must be one of none, waiting, approved"
        );
        assert!(matches!(
            start_phase(root, "missing", None),
            Err(TrackError::NoFeature { .. })
        ));
    }

    #[test]
    fn find_slug_prefers_the_branch_then_the_only_folder() {
        let dir = repo();
        let root = dir.path();
        assert_eq!(find_slug(root, Some("hermes/x")), None);
        create(root, "one", Track::Light, "", "").unwrap();
        assert_eq!(find_slug(root, None).as_deref(), Some("one"));
        assert_eq!(find_slug(root, Some("main")).as_deref(), Some("one"));
        create(root, "two", Track::Light, "", "").unwrap();
        assert_eq!(
            find_slug(root, None),
            None,
            "two folders, no branch: ambiguous"
        );
        assert_eq!(find_slug(root, Some("hermes/two")).as_deref(), Some("two"));
        assert_eq!(find_slug(root, Some("hermes/three")), None);
    }

    #[test]
    fn current_branch_reads_head_of_a_repo_and_of_a_linked_worktree() {
        let dir = repo();
        let root = dir.path();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/HEAD"), "ref: refs/heads/hermes/demo\n").unwrap();
        assert_eq!(current_branch(root).as_deref(), Some("hermes/demo"));
        let wt = root.join("wt");
        fs::create_dir_all(root.join(".git/worktrees/wt")).unwrap();
        fs::write(
            root.join(".git/worktrees/wt/HEAD"),
            "ref: refs/heads/other\n",
        )
        .unwrap();
        fs::create_dir_all(&wt).unwrap();
        fs::write(
            wt.join(".git"),
            format!("gitdir: {}\n", root.join(".git/worktrees/wt").display()),
        )
        .unwrap();
        assert_eq!(current_branch(&wt).as_deref(), Some("other"));
        fs::write(
            root.join(".git/HEAD"),
            "0123456789abcdef0123456789abcdef01234567\n",
        )
        .unwrap();
        assert_eq!(current_branch(root), None, "detached HEAD has no branch");
    }
}
