//! Worktree recipes (F26, issue #108).
//!
//! A repository can carry `.hermes/worktree.toml` (read by the frontend's
//! contract parser, `src/agent/contract/worktreeToml.ts`). When Hermes
//! creates a worktree for a new task it prepares it from that file, before
//! any agent starts:
//!
//! 1. `copy`: globs of files git IGNORES (`.env*`) are copied from the
//!    project folder into the new worktree. A pattern that matches a file
//!    git tracks (or one git does not ignore) is refused as a whole: copy
//!    exists for local secrets and caches, never for files that belong in
//!    a commit.
//! 2. `[ports]`: each named port gets a free port at or above the number in
//!    the file, never one handed to another worktree in this run, exposed
//!    to setup as `HERMES_PORT_<NAME>`.
//! 3. `setup`: commands run in order in the worktree (sh on macOS and
//!    Linux, cmd on Windows); the first failure stops the rest.
//!
//! Every line of output streams to the frontend as a `hermes:worktree-recipe`
//! event (the visible log). Secrets: file contents are copied disk to disk
//! and never cross IPC; values found in copied files are masked in the log
//! before it leaves this module; the log is never written to disk, the
//! database or the app log. Hermes stores only a hash of the recipe file,
//! to remember that the user allowed it to run.
//!
//! The file is repository content, so its commands never run without the
//! user's say-so: the first time (and whenever the file changes) the
//! frontend asks, and `worktree_recipe_run` refuses a file whose hash is
//! neither approved in that call nor remembered.

use git2::{ObjectType, Oid, Repository};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, State};

use crate::AppState;

/// Where the recipe lives, relative to a checkout.
pub const RECIPE_FILE: &str = ".hermes/worktree.toml";
/// Tauri event carrying one line of a run's log.
pub const RECIPE_EVENT: &str = "hermes:worktree-recipe";
/// Setting holding `{ projectId: hash }` of recipes the user allowed to run.
/// Machine-specific: excluded from settings export (db/mod.rs).
pub const TRUST_SETTING: &str = "worktree_recipe_trust";

const MAX_RECIPE_BYTES: u64 = 64 * 1024;
/// Values shorter than this are not treated as secrets (ports, `true`, `dev`).
const MIN_SECRET_LEN: usize = 6;
const MAX_SECRET_FILE_BYTES: u64 = 256 * 1024;
/// Keys whose values are never secret. Masking them would hide words like
/// `localhost` or `development` everywhere in the setup log.
const NON_SECRET_KEYS: &[&str] = &[
    "HOST",
    "HOSTNAME",
    "PORT",
    "NODE_ENV",
    "APP_ENV",
    "RAILS_ENV",
    "LOG_LEVEL",
    "TZ",
];
const MAX_LINE_CHARS: usize = 2000;
const MAX_WALK_ENTRIES: usize = 50_000;
const PORT_SEARCH_SPAN: u16 = 100;
const REDACTED: &str = "••••••";

// ─── The recipe file ─────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct RecipeFile {
    /// "worktree" (the new checkout has it) or "project" (only the project
    /// folder has it, e.g. not committed yet).
    pub origin: &'static str,
    pub text: String,
    pub hash: String,
}

/// Git's blob id of the file: changes whenever a byte of it changes.
pub fn recipe_hash(bytes: &[u8]) -> String {
    Oid::hash_object(ObjectType::Blob, bytes)
        .map(|o| o.to_string())
        .unwrap_or_default()
}

/// The recipe of a new worktree: the worktree's own file, else the project
/// folder's. None when neither has one (behaviour unchanged).
pub fn read_recipe(worktree: &Path, project_root: &Path) -> Result<Option<RecipeFile>, String> {
    for (dir, origin) in [(worktree, "worktree"), (project_root, "project")] {
        let path = dir.join(".hermes").join("worktree.toml");
        let meta = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("{} can't be read: {}", RECIPE_FILE, e)),
        };
        if !meta.is_file() {
            return Err(format!("{} is not a regular file", RECIPE_FILE));
        }
        if meta.len() > MAX_RECIPE_BYTES {
            return Err(format!("{} is larger than 64 KB", RECIPE_FILE));
        }
        let bytes = fs::read(&path).map_err(|e| format!("{} can't be read: {}", RECIPE_FILE, e))?;
        let hash = recipe_hash(&bytes);
        let text =
            String::from_utf8(bytes).map_err(|_| format!("{} is not UTF-8 text", RECIPE_FILE))?;
        return Ok(Some(RecipeFile { origin, text, hash }));
    }
    Ok(None)
}

fn trust_map(db: &crate::db::Database) -> BTreeMap<String, String> {
    db.get_setting(TRUST_SETTING)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn is_trusted(db: &crate::db::Database, project_id: &str, hash: &str) -> bool {
    trust_map(db).get(project_id).map(String::as_str) == Some(hash)
}

fn remember_trust(db: &crate::db::Database, project_id: &str, hash: &str) -> Result<(), String> {
    let mut map = trust_map(db);
    map.insert(project_id.to_string(), hash.to_string());
    let json = serde_json::to_string(&map).map_err(|e| e.to_string())?;
    db.set_setting(TRUST_SETTING, &json)
}

// ─── copy: patterns ──────────────────────────────────────────────────

/// Split a copy pattern into path segments, refusing anything that could
/// leave the repository or reach into `.git`.
pub fn pattern_segments(pattern: &str) -> Result<Vec<String>, String> {
    let p = pattern.trim();
    if p.is_empty() {
        return Err("the pattern is empty".into());
    }
    if p.contains('\\') {
        return Err("use / between folders".into());
    }
    let bytes = p.as_bytes();
    if p.starts_with('/') || (bytes.len() >= 2 && bytes[1] == b':') || p.starts_with('~') {
        return Err("it must be relative to the repository".into());
    }
    let segs: Vec<String> = p.split('/').map(str::to_string).collect();
    for s in &segs {
        if s.is_empty() {
            return Err("it has an empty folder name".into());
        }
        if s == "." || s == ".." {
            return Err("it may not leave the repository".into());
        }
        if s == ".git" {
            return Err("it may not reach into .git".into());
        }
        if s.contains("**") && s != "**" {
            return Err("** must be a whole folder name".into());
        }
    }
    if segs.last().map(String::as_str) == Some("**") {
        return Err("it must end with a file name".into());
    }
    Ok(segs)
}

/// `*` (any run, dots included) and `?` (one character) within one name.
pub fn segment_matches(pattern: &str, name: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let n: Vec<char> = name.chars().collect();
    let (mut pi, mut ni) = (0usize, 0usize);
    let (mut star, mut mark) = (None::<usize>, 0usize);
    while ni < n.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == n[ni]) {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ni;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ni = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

fn join_rel(rel: &str, name: &str) -> String {
    if rel.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", rel, name)
    }
}

struct Walk<'a> {
    root: &'a Path,
    /// Folders `**` does not descend into (the ones git ignores).
    skip_dir: &'a dyn Fn(&str) -> bool,
    seen: usize,
    out: BTreeSet<String>,
}

impl Walk<'_> {
    fn entries(&mut self, rel: &str) -> Result<Vec<(String, fs::FileType)>, String> {
        let dir = if rel.is_empty() {
            self.root.to_path_buf()
        } else {
            self.root.join(rel)
        };
        let mut list = Vec::new();
        let Ok(rd) = fs::read_dir(&dir) else {
            return Ok(list);
        };
        for entry in rd.flatten() {
            self.seen += 1;
            if self.seen > MAX_WALK_ENTRIES {
                return Err(
                    "it looks through too many files; name the folder instead of **".into(),
                );
            }
            let Ok(ft) = entry.file_type() else { continue };
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if name == ".git" {
                continue;
            }
            list.push((name, ft));
        }
        Ok(list)
    }

    fn walk(&mut self, rel: &str, segs: &[String]) -> Result<(), String> {
        let Some((seg, rest)) = segs.split_first() else {
            return Ok(());
        };
        if seg == "**" {
            self.walk(rel, rest)?;
            for (name, ft) in self.entries(rel)? {
                let child = join_rel(rel, &name);
                if ft.is_dir() && !(self.skip_dir)(&child) {
                    self.walk(&child, segs)?;
                }
            }
            return Ok(());
        }
        for (name, ft) in self.entries(rel)? {
            if !segment_matches(seg, &name) {
                continue;
            }
            let child = join_rel(rel, &name);
            if rest.is_empty() {
                // Files and links (a link is refused later, never followed).
                if !ft.is_dir() {
                    self.out.insert(child);
                }
            } else if ft.is_dir() {
                self.walk(&child, rest)?;
            }
        }
        Ok(())
    }
}

/// Files under `root` a pattern matches, as `/`-separated relative paths.
pub fn expand_pattern(
    root: &Path,
    segs: &[String],
    skip_dir: &dyn Fn(&str) -> bool,
) -> Result<Vec<String>, String> {
    let mut w = Walk {
        root,
        skip_dir,
        seen: 0,
        out: BTreeSet::new(),
    };
    w.walk("", segs)?;
    Ok(w.out.into_iter().collect())
}

// ─── copy: git status and the copy itself ────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum GitFileStatus {
    Ignored,
    Tracked,
    NotIgnored,
}

pub fn git_file_status(repo: &Repository, index: &git2::Index, rel: &str) -> GitFileStatus {
    if index.get_path(Path::new(rel), 0).is_some() {
        return GitFileStatus::Tracked;
    }
    match repo.is_path_ignored(Path::new(rel)) {
        Ok(true) => GitFileStatus::Ignored,
        _ => GitFileStatus::NotIgnored,
    }
}

#[derive(Debug, Default)]
pub struct CopyOutcome {
    pub copied: Vec<String>,
    /// One message per refused pattern or failed copy.
    pub problems: Vec<String>,
    /// Values found in the copied files, masked in the log.
    pub secrets: Vec<String>,
}

/// Copy the git-ignored files the patterns match from the project folder to
/// the same place in the worktree. Never overwrites a file already there.
pub fn copy_ignored_files(
    project_root: &Path,
    worktree: &Path,
    patterns: &[String],
    log: &mut dyn FnMut(String),
) -> CopyOutcome {
    let mut out = CopyOutcome::default();
    if patterns.is_empty() {
        return out;
    }
    let repo = match Repository::open(project_root) {
        Ok(r) => r,
        Err(e) => {
            out.problems.push(format!(
                "copy refused: the project folder is not a git repository ({})",
                e.message()
            ));
            return out;
        }
    };
    let index = match repo.index() {
        Ok(i) => i,
        Err(e) => {
            out.problems.push(format!(
                "copy refused: git's index can't be read ({})",
                e.message()
            ));
            return out;
        }
    };
    let skip_dir = |rel: &str| matches!(repo.is_path_ignored(Path::new(rel)), Ok(true));
    for pattern in patterns {
        let segs = match pattern_segments(pattern) {
            Ok(s) => s,
            Err(why) => {
                out.problems
                    .push(format!("Refused copy \"{}\": {}", pattern, why));
                continue;
            }
        };
        let matches = match expand_pattern(project_root, &segs, &skip_dir) {
            Ok(m) => m,
            Err(why) => {
                out.problems
                    .push(format!("Refused copy \"{}\": {}", pattern, why));
                continue;
            }
        };
        if matches.is_empty() {
            log(format!("copy \"{}\": nothing matched", pattern));
            continue;
        }
        let refusal = matches.iter().find_map(|rel| {
            let is_link = fs::symlink_metadata(project_root.join(rel))
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false);
            if is_link {
                return Some(format!("{} is a link", rel));
            }
            match git_file_status(&repo, &index, rel) {
                GitFileStatus::Ignored => None,
                GitFileStatus::Tracked => Some(format!("{} is tracked by git", rel)),
                GitFileStatus::NotIgnored => Some(format!("{} is not ignored by git", rel)),
            }
        });
        if let Some(why) = refusal {
            out.problems.push(format!(
                "Refused copy \"{}\": {} (copy only takes files git ignores)",
                pattern, why
            ));
            continue;
        }
        for rel in matches {
            let src = project_root.join(&rel);
            let dest = worktree.join(&rel);
            if fs::symlink_metadata(&dest).is_ok() {
                log(format!("kept {} (already in the worktree)", rel));
            } else {
                let copied = dest
                    .parent()
                    .map(fs::create_dir_all)
                    .unwrap_or(Ok(()))
                    .and_then(|_| fs::copy(&src, &dest));
                if let Err(e) = copied {
                    out.problems.push(format!("Could not copy {}: {}", rel, e));
                    continue;
                }
                log(format!("copied {}", rel));
                out.copied.push(rel.clone());
            }
            out.secrets.extend(secret_values_in(&dest));
        }
    }
    out
}

// ─── secrets ─────────────────────────────────────────────────────────

/// Values of `KEY=value` lines (dotenv syntax: `export`, quotes, comments),
/// except those of [`NON_SECRET_KEYS`].
pub fn dotenv_values(text: &str) -> Vec<String> {
    let mut values = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let t = t.strip_prefix("export ").unwrap_or(t);
        let Some((key, raw)) = t.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty()
            || key.contains(char::is_whitespace)
            || NON_SECRET_KEYS.iter().any(|k| k.eq_ignore_ascii_case(key))
        {
            continue;
        }
        let raw = raw.trim();
        let value = match raw.chars().next() {
            Some(q @ ('"' | '\'')) => match raw[1..].find(q) {
                Some(end) => &raw[1..1 + end],
                None => &raw[1..],
            },
            _ => raw.split(" #").next().unwrap_or("").trim(),
        };
        if !value.is_empty() {
            values.push(value.to_string());
        }
    }
    values
}

fn secret_values_in(path: &Path) -> Vec<String> {
    let Ok(file) = fs::File::open(path) else {
        return Vec::new();
    };
    let mut buf = Vec::new();
    if file
        .take(MAX_SECRET_FILE_BYTES)
        .read_to_end(&mut buf)
        .is_err()
    {
        return Vec::new();
    }
    match String::from_utf8(buf) {
        Ok(text) => dotenv_values(&text),
        Err(_) => Vec::new(),
    }
}

/// Masks known secret values in log lines.
#[derive(Debug, Default)]
pub struct Redactor {
    secrets: Vec<String>,
}

impl Redactor {
    pub fn new(mut secrets: Vec<String>) -> Self {
        secrets.retain(|s| s.chars().count() >= MIN_SECRET_LEN);
        // Longest first, so a value containing another is masked whole.
        secrets.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
        secrets.dedup();
        Self { secrets }
    }

    pub fn redact(&self, line: &str) -> String {
        let mut out = line.to_string();
        for s in &self.secrets {
            if out.contains(s.as_str()) {
                out = out.replace(s.as_str(), REDACTED);
            }
        }
        out
    }
}

// ─── ports ───────────────────────────────────────────────────────────

/// `HERMES_PORT_<NAME>`: upper case, anything but letters and digits as `_`.
pub fn port_env_name(name: &str) -> String {
    let upper: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect();
    format!("HERMES_PORT_{}", upper)
}

/// Ports handed to worktrees in this run of the app.
#[derive(Default)]
pub struct PortBook {
    by_worktree: HashMap<PathBuf, BTreeMap<String, u16>>,
}

impl PortBook {
    /// Pick, for each named port, the first port at or above the requested
    /// one that no other worktree holds and `is_free` accepts.
    pub fn allocate(
        &mut self,
        worktree: &Path,
        requested: &BTreeMap<String, u16>,
        is_free: &dyn Fn(u16) -> bool,
    ) -> Result<BTreeMap<String, u16>, String> {
        // Forget worktrees that are gone, and this one's previous ports.
        self.by_worktree.retain(|p, _| p != worktree && p.exists());
        let mut taken: BTreeSet<u16> = self
            .by_worktree
            .values()
            .flat_map(|m| m.values().copied())
            .collect();
        let mut chosen = BTreeMap::new();
        for (name, &base) in requested {
            let last = base.saturating_add(PORT_SEARCH_SPAN - 1);
            let port = (base..=last)
                .find(|p| !taken.contains(p) && is_free(*p))
                .ok_or_else(|| {
                    format!(
                        "no free port between {} and {} for \"{}\"",
                        base, last, name
                    )
                })?;
            taken.insert(port);
            chosen.insert(name.clone(), port);
        }
        self.by_worktree
            .insert(worktree.to_path_buf(), chosen.clone());
        Ok(chosen)
    }
}

fn port_is_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

lazy_static::lazy_static! {
    static ref PORTS: Mutex<PortBook> = Mutex::new(PortBook::default());
    static ref RUNS: Mutex<HashMap<String, Arc<RunControl>>> = Mutex::new(HashMap::new());
}

// ─── setup commands ──────────────────────────────────────────────────

/// Lets `worktree_recipe_stop` end a run: the running command and
/// everything it started are killed, and no further command starts.
#[derive(Default)]
pub struct RunControl {
    stopped: AtomicBool,
    pid: Mutex<Option<u32>>,
}

impl RunControl {
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(pid) = *self.pid.lock().unwrap_or_else(|e| e.into_inner()) {
            kill_tree(pid);
        }
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }
}

#[cfg(unix)]
fn kill_tree(pid: u32) {
    // The command runs in its own process group (see shell_command).
    unsafe {
        libc::kill(-(pid as i32), libc::SIGTERM);
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(2));
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    });
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// The shell a setup command runs in: the user's login shell when it is a
/// POSIX-like one (so its profile's PATH applies), else `/bin/sh`.
#[cfg(unix)]
fn shell_command(cmd: &str) -> Command {
    use std::os::unix::process::CommandExt;
    let user_shell = crate::pty::detect_shell();
    let known = ["sh", "bash", "zsh", "dash", "ksh", "fish"];
    let is_known = Path::new(&user_shell)
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| known.contains(&n));
    let shell = if is_known {
        user_shell
    } else {
        "/bin/sh".to_string()
    };
    let mut c = Command::new(shell);
    c.args(["-l", "-c", cmd]);
    c.process_group(0);
    // A GUI app starts with a short PATH: add the usual tool folders.
    let mut paths: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    for dir in crate::platform::well_known_path_dirs() {
        if !paths.contains(&dir) {
            paths.push(dir);
        }
    }
    if let Ok(joined) = std::env::join_paths(paths) {
        c.env("PATH", joined);
    }
    c
}

#[cfg(windows)]
fn shell_command(cmd: &str) -> Command {
    use std::os::windows::process::CommandExt;
    let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
    let mut c = Command::new(comspec);
    c.args(["/d", "/s", "/c"]);
    c.raw_arg(format!("\"{}\"", cmd));
    c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    c
}

/// One line of a run's log.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    /// "command" (the line being run), "stdout", "stderr", or "hermes".
    pub stream: &'static str,
    pub text: String,
}

fn clean_line(raw: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(raw);
    // A progress bar rewrites its line with \r: keep what it ended as.
    let last = text.split('\r').rev().find(|s| !s.trim().is_empty())?;
    let stripped = strip_ansi_escapes::strip_str(last);
    let trimmed = stripped.trim_end();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(MAX_LINE_CHARS).collect())
}

fn pump(
    stream: impl Read + Send + 'static,
    name: &'static str,
    tx: mpsc::Sender<LogLine>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if let Some(text) = clean_line(&buf) {
                        if tx.send(LogLine { stream: name, text }).is_err() {
                            break;
                        }
                    }
                }
            }
        }
    })
}

#[derive(Debug, PartialEq)]
pub enum SetupEnd {
    Done,
    Failed(String),
    Stopped,
}

/// Run the setup commands in order in `cwd`. Output goes to `emit`, masked.
pub fn run_setup(
    commands: &[String],
    cwd: &Path,
    env: &[(String, String)],
    redactor: &Redactor,
    control: &RunControl,
    emit: &mut dyn FnMut(LogLine),
) -> SetupEnd {
    for cmd in commands {
        if control.is_stopped() {
            return SetupEnd::Stopped;
        }
        emit(LogLine {
            stream: "command",
            text: format!("$ {}", cmd),
        });
        let mut c = shell_command(cmd);
        c.current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in env {
            c.env(k, v);
        }
        let mut child = match c.spawn() {
            Ok(ch) => ch,
            Err(e) => return SetupEnd::Failed(format!("`{}` could not start: {}", cmd, e)),
        };
        *control.pid.lock().unwrap_or_else(|e| e.into_inner()) = Some(child.id());
        if control.is_stopped() {
            kill_tree(child.id());
        }
        let (tx, rx) = mpsc::channel();
        let readers = [
            child.stdout.take().map(|s| pump(s, "stdout", tx.clone())),
            child.stderr.take().map(|s| pump(s, "stderr", tx.clone())),
        ];
        drop(tx);
        for line in rx {
            emit(LogLine {
                stream: line.stream,
                text: redactor.redact(&line.text),
            });
        }
        for r in readers.into_iter().flatten() {
            let _ = r.join();
        }
        let status = child.wait();
        *control.pid.lock().unwrap_or_else(|e| e.into_inner()) = None;
        if control.is_stopped() {
            return SetupEnd::Stopped;
        }
        match status {
            Ok(s) if s.success() => {}
            Ok(s) => {
                return SetupEnd::Failed(match s.code() {
                    Some(code) => format!("`{}` exited with code {}", cmd, code),
                    None => format!("`{}` was killed", cmd),
                })
            }
            Err(e) => return SetupEnd::Failed(format!("`{}` could not finish: {}", cmd, e)),
        }
    }
    SetupEnd::Done
}

// ─── A whole run ─────────────────────────────────────────────────────

/// What the frontend gets back once a run ends.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecipeOutcome {
    pub ok: bool,
    pub stopped: bool,
    /// One line for people: why the run failed.
    pub failure: Option<String>,
    pub copied: Vec<String>,
    pub ports: BTreeMap<String, u16>,
}

pub struct RecipeRequest<'a> {
    pub project_root: &'a Path,
    pub worktree: &'a Path,
    pub session_id: &'a str,
    pub copy: &'a [String],
    pub setup: &'a [String],
    pub ports: &'a BTreeMap<String, u16>,
}

pub fn execute_recipe(
    req: &RecipeRequest,
    ports: &Mutex<PortBook>,
    is_free: &dyn Fn(u16) -> bool,
    control: &RunControl,
    emit: &mut dyn FnMut(LogLine),
) -> RecipeOutcome {
    let started = Instant::now();
    let say = |emit: &mut dyn FnMut(LogLine), text: String| {
        emit(LogLine {
            stream: "hermes",
            text,
        })
    };
    say(emit, format!("Preparing the worktree from {}", RECIPE_FILE));

    let copy = copy_ignored_files(req.project_root, req.worktree, req.copy, &mut |t| {
        emit(LogLine {
            stream: "hermes",
            text: t,
        })
    });
    let mut outcome = RecipeOutcome {
        ok: false,
        stopped: false,
        failure: None,
        copied: copy.copied.clone(),
        ports: BTreeMap::new(),
    };
    if !copy.problems.is_empty() {
        for p in &copy.problems {
            say(emit, p.clone());
        }
        say(emit, "Setup did not run.".into());
        outcome.failure = copy.problems.first().cloned();
        return outcome;
    }
    let redactor = Redactor::new(copy.secrets);

    let mut env: Vec<(String, String)> = vec![
        (
            "HERMES_WORKTREE".into(),
            req.worktree.to_string_lossy().into_owned(),
        ),
        (
            "HERMES_PROJECT_ROOT".into(),
            req.project_root.to_string_lossy().into_owned(),
        ),
        ("HERMES_SESSION_ID".into(), req.session_id.to_string()),
    ];
    if !req.ports.is_empty() {
        let allocated = {
            let mut book = ports.lock().unwrap_or_else(|e| e.into_inner());
            book.allocate(req.worktree, req.ports, is_free)
        };
        match allocated {
            Ok(map) => {
                let listed: Vec<String> = map
                    .iter()
                    .map(|(n, p)| format!("{}={} ({})", n, p, port_env_name(n)))
                    .collect();
                say(emit, format!("Ports: {}", listed.join(", ")));
                for (n, p) in &map {
                    env.push((port_env_name(n), p.to_string()));
                }
                outcome.ports = map;
            }
            Err(why) => {
                say(emit, format!("Ports: {}", why));
                say(emit, "Setup did not run.".into());
                outcome.failure = Some(why);
                return outcome;
            }
        }
    }

    match run_setup(req.setup, req.worktree, &env, &redactor, control, emit) {
        SetupEnd::Done => {
            outcome.ok = true;
            say(
                emit,
                format!("Setup finished in {:.1} s", started.elapsed().as_secs_f64()),
            );
        }
        SetupEnd::Failed(why) => {
            say(emit, format!("Setup failed: {}", why));
            outcome.failure = Some(why);
        }
        SetupEnd::Stopped => {
            say(emit, "Setup stopped.".into());
            outcome.stopped = true;
        }
    }
    outcome
}

// ─── IPC ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeFileInfo {
    pub origin: &'static str,
    pub text: String,
    pub hash: String,
    /// The user allowed this exact file for this project before.
    pub trusted: bool,
    pub project_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecipeLogEvent<'a> {
    run_id: &'a str,
    stream: &'static str,
    text: String,
}

/// The session's linked worktree for a project (never the project folder)
/// and the project folder itself.
fn session_worktree(
    state: &State<'_, AppState>,
    session_id: &str,
    project_id: &str,
) -> Result<(PathBuf, PathBuf, String), String> {
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let row = db
        .get_session_worktrees(session_id)?
        .into_iter()
        .find(|r| r.project_id == project_id)
        .ok_or_else(|| "this session has no worktree for that project".to_string())?;
    if row.is_main_worktree {
        return Err("a recipe never runs in the project folder itself".into());
    }
    let project = db
        .get_project(project_id)?
        .ok_or_else(|| format!("Project '{}' not found", project_id))?;
    Ok((
        PathBuf::from(row.worktree_path),
        PathBuf::from(project.path),
        project.name,
    ))
}

/// The recipe a session's new worktree would run, or null when there is none.
#[tauri::command]
pub fn worktree_recipe_read(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
) -> Result<Option<RecipeFileInfo>, String> {
    let (worktree, root, project_name) = match session_worktree(&state, &session_id, &project_id) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    let Some(file) = read_recipe(&worktree, &root)? else {
        return Ok(None);
    };
    let db = state
        .db
        .lock()
        .map_err(|e| format!("DB lock error: {}", e))?;
    let trusted = is_trusted(&db, &project_id, &file.hash);
    Ok(Some(RecipeFileInfo {
        origin: file.origin,
        text: file.text,
        hash: file.hash,
        trusted,
        project_name,
    }))
}

fn valid_run_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Run a session's worktree recipe; the log streams as `RECIPE_EVENT`.
/// `hash` is the file the user saw; `approve` is their "Run setup" click,
/// remembered for this project until the file changes.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command: one argument per IPC field
pub async fn worktree_recipe_run(
    app: AppHandle,
    state: State<'_, AppState>,
    run_id: String,
    session_id: String,
    project_id: String,
    hash: String,
    approve: bool,
    copy: Vec<String>,
    setup: Vec<String>,
    ports: BTreeMap<String, u16>,
) -> Result<RecipeOutcome, String> {
    if !valid_run_id(&run_id) {
        return Err("invalid run id".into());
    }
    let (worktree, root, _) = session_worktree(&state, &session_id, &project_id)?;
    let file = read_recipe(&worktree, &root)?.ok_or_else(|| format!("{} is gone", RECIPE_FILE))?;
    if file.hash != hash {
        return Err(format!(
            "{} changed since it was shown; nothing ran",
            RECIPE_FILE
        ));
    }
    {
        let db = state
            .db
            .lock()
            .map_err(|e| format!("DB lock error: {}", e))?;
        if approve {
            remember_trust(&db, &project_id, &hash)?;
        } else if !is_trusted(&db, &project_id, &hash) {
            return Err(format!("{} was not approved; nothing ran", RECIPE_FILE));
        }
    }

    let control = Arc::new(RunControl::default());
    {
        let mut runs = RUNS.lock().unwrap_or_else(|e| e.into_inner());
        if runs.contains_key(&run_id) {
            return Err("that run is already going".into());
        }
        runs.insert(run_id.clone(), control.clone());
    }
    log::info!(
        "[worktree-recipe] run {} started for session {}",
        run_id,
        session_id
    );
    let task_run_id = run_id.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let req = RecipeRequest {
            project_root: &root,
            worktree: &worktree,
            session_id: &session_id,
            copy: &copy,
            setup: &setup,
            ports: &ports,
        };
        execute_recipe(&req, &PORTS, &port_is_free, &control, &mut |line| {
            let _ = app.emit(
                RECIPE_EVENT,
                RecipeLogEvent {
                    run_id: &task_run_id,
                    stream: line.stream,
                    text: line.text,
                },
            );
        })
    })
    .await
    .map_err(|e| format!("setup task failed: {}", e));
    RUNS.lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&run_id);
    if let Ok(o) = &outcome {
        log::info!(
            "[worktree-recipe] run {} ended: ok={} stopped={}",
            run_id,
            o.ok,
            o.stopped
        );
    }
    outcome
}

/// Stop a run: kill its running command and start no more. False when it
/// is not running.
#[tauri::command]
pub fn worktree_recipe_stop(run_id: String) -> bool {
    let control = RUNS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&run_id)
        .cloned();
    match control {
        Some(c) => {
            c.stop();
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as Cmd;
    use tempfile::TempDir;

    fn git(dir: &Path, args: &[&str]) {
        let ok = Cmd::new("git")
            .current_dir(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "Hermes Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.com")
            .env("GIT_COMMITTER_NAME", "Hermes Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.com")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .expect("git runs");
        assert!(
            ok.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&ok.stderr)
        );
    }

    /// A repo with `.gitignore` ignoring `.env*` (but tracking `.env.example`
    /// on purpose), `node_modules/`, and a worktree folder beside it.
    fn repo() -> (TempDir, PathBuf, PathBuf) {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("repo");
        let wt = tmp.path().join("wt");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&wt).unwrap();
        git(&root, &["init", "-q"]);
        fs::write(
            root.join(".gitignore"),
            ".env*\n!.env.example\nnode_modules/\n",
        )
        .unwrap();
        fs::write(root.join(".env.example"), "API_KEY=\n").unwrap();
        fs::write(root.join("README.md"), "# r\n").unwrap();
        git(&root, &["add", "."]);
        git(
            &root,
            &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"],
        );
        (tmp, root, wt)
    }

    fn strings(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn segment_globs() {
        assert!(segment_matches(".env*", ".env"));
        assert!(segment_matches(".env*", ".env.local"));
        assert!(!segment_matches(".env*", "env"));
        assert!(segment_matches("*.pem", "key.pem"));
        assert!(!segment_matches("*.pem", "key.pem.bak"));
        assert!(segment_matches("a?c", "abc"));
        assert!(!segment_matches("a?c", "ac"));
        assert!(segment_matches("*", ".hidden"));
    }

    #[test]
    fn patterns_that_leave_the_repo_are_refused() {
        assert_eq!(pattern_segments(".env*").unwrap(), strings(&[".env*"]));
        assert_eq!(
            pattern_segments("apps/**/.env").unwrap(),
            strings(&["apps", "**", ".env"])
        );
        for bad in [
            "",
            "../x",
            "a/../b",
            "/etc/passwd",
            "C:/x",
            "~/x",
            "a\\b",
            ".git/config",
            "a//b",
            "a**/b",
            "**",
        ] {
            assert!(pattern_segments(bad).is_err(), "{:?} must be refused", bad);
        }
    }

    #[test]
    fn copies_ignored_files_and_never_overwrites() {
        let (_t, root, wt) = repo();
        fs::write(root.join(".env"), "API_KEY=fake-aaaa-bbbb\nPORT=3000\n").unwrap();
        fs::write(
            root.join(".env.local"),
            "export TOKEN=\"quoted-secret-value\" # note\n",
        )
        .unwrap();
        fs::write(wt.join(".env.local"), "TOKEN=mine\n").unwrap();
        let mut log = Vec::new();
        let out = copy_ignored_files(&root, &wt, &strings(&[".env", ".env.local"]), &mut |l| {
            log.push(l)
        });
        assert!(out.problems.is_empty(), "{:?}", out.problems);
        assert_eq!(out.copied, strings(&[".env"]));
        assert_eq!(
            fs::read_to_string(wt.join(".env")).unwrap(),
            "API_KEY=fake-aaaa-bbbb\nPORT=3000\n"
        );
        assert_eq!(
            fs::read_to_string(wt.join(".env.local")).unwrap(),
            "TOKEN=mine\n",
            "an existing file is kept"
        );
        assert!(log.iter().any(|l| l == "copied .env"));
        assert!(log.iter().any(|l| l.starts_with("kept .env.local")));
        assert!(out.secrets.contains(&"fake-aaaa-bbbb".to_string()));
        assert!(out.secrets.contains(&"mine".to_string()));
    }

    #[test]
    fn a_pattern_matching_a_tracked_file_is_refused_whole() {
        let (_t, root, wt) = repo();
        fs::write(root.join(".env"), "API_KEY=fake-aaaa-bbbb\n").unwrap();
        let mut log = Vec::new();
        // `.env*` matches the ignored .env AND the tracked .env.example.
        let out = copy_ignored_files(&root, &wt, &strings(&[".env*"]), &mut |l| log.push(l));
        assert_eq!(out.problems.len(), 1);
        assert!(
            out.problems[0].contains(".env.example is tracked by git"),
            "{}",
            out.problems[0]
        );
        assert!(out.copied.is_empty());
        assert!(
            !wt.join(".env").exists(),
            "nothing from a refused pattern is copied"
        );
    }

    #[test]
    fn a_file_git_does_not_ignore_is_refused() {
        let (_t, root, wt) = repo();
        fs::write(root.join("notes.txt"), "x\n").unwrap();
        let out = copy_ignored_files(&root, &wt, &strings(&["notes.txt"]), &mut |_| {});
        assert!(
            out.problems[0].contains("notes.txt is not ignored by git"),
            "{:?}",
            out.problems
        );
        assert!(!wt.join("notes.txt").exists());
    }

    #[test]
    fn globstar_finds_nested_files_but_skips_ignored_folders() {
        let (_t, root, wt) = repo();
        fs::create_dir_all(root.join("apps/web")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("apps/web/.env"), "K=nested-secret-1\n").unwrap();
        fs::write(root.join("node_modules/pkg/.env"), "K=x\n").unwrap();
        let mut log = Vec::new();
        let out = copy_ignored_files(&root, &wt, &strings(&["**/.env", "nope/*.key"]), &mut |l| {
            log.push(l)
        });
        assert!(out.problems.is_empty(), "{:?}", out.problems);
        assert_eq!(out.copied, strings(&["apps/web/.env"]));
        assert!(wt.join("apps/web/.env").exists());
        assert!(!wt.join("node_modules").exists());
        assert!(log
            .iter()
            .any(|l| l == "copy \"nope/*.key\": nothing matched"));
    }

    #[test]
    fn dotenv_values_are_read_like_dotenv() {
        let v = dotenv_values("# c\nA=1\nexport B='two two'\nC=\"three\" # x\nD=four # comment\nbad line\n=novalue\nE=\n");
        assert_eq!(v, strings(&["1", "two two", "three", "four"]));
    }

    #[test]
    fn dotenv_values_skip_keys_that_are_never_secret() {
        let v = dotenv_values(
            "HOST=localhost\nexport NODE_ENV=development\nport=3000\nAPI_TOKEN=fake-token-123\nHOSTS=keep-me-too\n",
        );
        assert_eq!(v, strings(&["fake-token-123", "keep-me-too"]));
        let r = Redactor::new(v);
        assert_eq!(
            r.redact("GET http://localhost:3000 token=fake-token-123"),
            "GET http://localhost:3000 token=••••••"
        );
    }

    #[test]
    fn redactor_masks_long_values_only() {
        let r = Redactor::new(strings(&["fake-aaaa-bbbb", "3000", "fake-aaaa"]));
        assert_eq!(
            r.redact("key=fake-aaaa-bbbb port=3000"),
            "key=•••••• port=3000"
        );
        assert_eq!(r.redact("short fake-aaaa"), "short ••••••");
    }

    #[test]
    fn ports_skip_taken_and_busy_ones() {
        let tmp = TempDir::new().unwrap();
        let (a, b) = (tmp.path().join("a"), tmp.path().join("b"));
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        let mut book = PortBook::default();
        let req: BTreeMap<String, u16> =
            [("web".to_string(), 4100u16), ("api".to_string(), 4101)].into();
        let busy = |p: u16| p != 4100; // 4100 is in use by something else
        let pa = book.allocate(&a, &req, &busy).unwrap();
        assert_eq!(pa["api"], 4101); // names are taken in order: api, web
        assert_eq!(pa["web"], 4102, "4100 is busy, 4101 is api's");
        let pb = book.allocate(&b, &req, &busy).unwrap();
        assert_eq!(pb["api"], 4103, "never a port another worktree holds");
        assert_eq!(pb["web"], 4104);
        // Re-running a worktree gives its own ports back.
        let pa2 = book.allocate(&a, &req, &busy).unwrap();
        assert_eq!(pa2, pa);
        // A worktree that is gone frees its ports.
        fs::remove_dir_all(&b).unwrap();
        let c = tmp.path().join("c");
        fs::create_dir_all(&c).unwrap();
        assert_eq!(book.allocate(&c, &req, &busy).unwrap()["web"], 4104);
        let none = |_p: u16| false;
        assert!(book.allocate(&c, &req, &none).is_err());
        assert_eq!(port_env_name("web-ui.2"), "HERMES_PORT_WEB_UI_2");
    }

    #[test]
    fn recipe_prefers_the_worktree_file_and_hashes_bytes() {
        let tmp = TempDir::new().unwrap();
        let (wt, root) = (tmp.path().join("wt"), tmp.path().join("root"));
        fs::create_dir_all(wt.join(".hermes")).unwrap();
        fs::create_dir_all(root.join(".hermes")).unwrap();
        assert_eq!(read_recipe(&wt, &root).unwrap(), None);
        fs::write(root.join(".hermes/worktree.toml"), "setup = [\"a\"]\n").unwrap();
        let from_root = read_recipe(&wt, &root).unwrap().unwrap();
        assert_eq!(from_root.origin, "project");
        fs::write(wt.join(".hermes/worktree.toml"), "setup = [\"b\"]\n").unwrap();
        let from_wt = read_recipe(&wt, &root).unwrap().unwrap();
        assert_eq!(from_wt.origin, "worktree");
        assert_eq!(from_wt.text, "setup = [\"b\"]\n");
        assert_ne!(from_wt.hash, from_root.hash);
        assert_eq!(from_wt.hash, recipe_hash(b"setup = [\"b\"]\n"));
    }

    #[test]
    fn a_recipe_of_exactly_64_kb_is_read_and_one_byte_more_is_refused() {
        let tmp = TempDir::new().unwrap();
        let (wt, root) = (tmp.path().join("wt"), tmp.path().join("root"));
        fs::create_dir_all(wt.join(".hermes")).unwrap();
        fs::create_dir_all(&root).unwrap();
        let file = wt.join(".hermes/worktree.toml");
        let at_cap = "#".repeat(MAX_RECIPE_BYTES as usize);
        fs::write(&file, &at_cap).unwrap();
        assert_eq!(read_recipe(&wt, &root).unwrap().unwrap().text, at_cap);
        fs::write(&file, "#".repeat(MAX_RECIPE_BYTES as usize + 1)).unwrap();
        let err = read_recipe(&wt, &root).unwrap_err();
        assert!(err.contains("larger than 64 KB"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn a_recipe_that_cannot_be_looked_at_is_an_error_not_a_missing_file() {
        // `.hermes` is a file, so the recipe path cannot even be looked up:
        // that is reported, not treated as "no recipe here".
        let tmp = TempDir::new().unwrap();
        let (wt, root) = (tmp.path().join("wt"), tmp.path().join("root"));
        fs::create_dir_all(&wt).unwrap();
        fs::create_dir_all(root.join(".hermes")).unwrap();
        fs::write(wt.join(".hermes"), "not a folder").unwrap();
        fs::write(root.join(".hermes/worktree.toml"), "setup = []\n").unwrap();
        let err = read_recipe(&wt, &root).unwrap_err();
        assert!(err.contains("can't be read"), "{err}");
    }

    #[test]
    fn a_recipe_is_trusted_per_project_and_per_exact_file() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = crate::db::Database::new(tmp.path()).unwrap();
        assert!(trust_map(&db).is_empty());
        assert!(!is_trusted(&db, "p1", "h1"));
        remember_trust(&db, "p1", "h1").unwrap();
        assert!(is_trusted(&db, "p1", "h1"));
        assert!(
            !is_trusted(&db, "p1", "h2"),
            "a changed file is not trusted"
        );
        assert!(
            !is_trusted(&db, "p2", "h1"),
            "another project is not trusted"
        );
        remember_trust(&db, "p2", "h2").unwrap();
        remember_trust(&db, "p1", "h3").unwrap();
        let want: BTreeMap<String, String> = [("p1", "h3"), ("p2", "h2")]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        assert_eq!(trust_map(&db), want);
        assert!(!is_trusted(&db, "p1", "h1"), "the newer file replaced it");
    }

    fn node_cmd(script: &str) -> String {
        // `node -e` runs the same on sh and cmd; single quotes inside.
        format!("node -e \"{}\"", script)
    }

    fn node_available() -> bool {
        Cmd::new("node")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn setup_streams_output_masks_secrets_and_stops_at_the_first_failure() {
        if !node_available() {
            eprintln!("node not found; skipping");
            return;
        }
        let (_t, root, wt) = repo();
        fs::write(root.join(".env"), "API_KEY=fake-aaaa-bbbb\n").unwrap();
        let req_ports: BTreeMap<String, u16> = [("web".to_string(), 4300u16)].into();
        let setup = vec![
            node_cmd("console.log('key is ' + require('fs').readFileSync('.env','utf8').trim()); console.log('port ' + process.env.HERMES_PORT_WEB)"),
            node_cmd("console.error('boom'); process.exit(3)"),
            node_cmd("console.log('never runs')"),
        ];
        let copy = strings(&[".env"]);
        let req = RecipeRequest {
            project_root: &root,
            worktree: &wt,
            session_id: "s1",
            copy: &copy,
            setup: &setup,
            ports: &req_ports,
        };
        let book = Mutex::new(PortBook::default());
        let mut lines = Vec::new();
        let out = execute_recipe(
            &req,
            &book,
            &|p| p == 4301,
            &RunControl::default(),
            &mut |l| lines.push(l),
        );
        let text: Vec<String> = lines
            .iter()
            .map(|l| format!("{}: {}", l.stream, l.text))
            .collect();
        assert!(!out.ok && !out.stopped, "{:?}", text);
        assert!(
            out.failure
                .as_deref()
                .unwrap()
                .contains("exited with code 3"),
            "{:?}",
            out.failure
        );
        assert_eq!(out.ports["web"], 4301);
        assert!(
            text.contains(&"stdout: key is API_KEY=••••••".to_string()),
            "{:?}",
            text
        );
        assert!(
            text.contains(&"stdout: port 4301".to_string()),
            "{:?}",
            text
        );
        assert!(text.contains(&"stderr: boom".to_string()), "{:?}", text);
        assert!(
            !text.iter().any(|l| l.contains("fake-aaaa-bbbb")),
            "the secret never reaches the log"
        );
        assert!(!text.iter().any(|l| l.contains("never runs")), "{:?}", text);
    }

    #[test]
    fn a_refused_copy_means_setup_does_not_run() {
        let (_t, root, wt) = repo();
        let setup = strings(&["echo should-not-run"]);
        let copy = strings(&[".env*"]);
        let ports = BTreeMap::new();
        let req = RecipeRequest {
            project_root: &root,
            worktree: &wt,
            session_id: "s1",
            copy: &copy,
            setup: &setup,
            ports: &ports,
        };
        let mut lines = Vec::new();
        let out = execute_recipe(
            &req,
            &Mutex::new(PortBook::default()),
            &|_| true,
            &RunControl::default(),
            &mut |l| lines.push(l),
        );
        assert!(!out.ok);
        assert!(out
            .failure
            .unwrap()
            .contains(".env.example is tracked by git"));
        assert!(
            !lines.iter().any(|l| l.stream == "command"),
            "no command ran"
        );
    }

    #[test]
    fn stop_kills_the_running_command() {
        if !node_available() {
            return;
        }
        let tmp = TempDir::new().unwrap();
        let control = Arc::new(RunControl::default());
        let c2 = control.clone();
        let stopper = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            c2.stop();
        });
        let started = Instant::now();
        let end = run_setup(
            &[
                node_cmd("setTimeout(()=>{}, 60000)"),
                "echo next".to_string(),
            ],
            tmp.path(),
            &[],
            &Redactor::default(),
            &control,
            &mut |_| {},
        );
        stopper.join().unwrap();
        assert_eq!(end, SetupEnd::Stopped);
        assert!(
            started.elapsed().as_secs() < 30,
            "the command was killed, not waited for"
        );
    }
}
