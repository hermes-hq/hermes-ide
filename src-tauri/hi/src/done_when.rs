//! Done-When checks (F27): the commands a repository says must pass before
//! an agent's work counts as done.
//!
//! Where the commands come from, first match wins:
//!
//! 1. `.hermes/features/<slug>/feature.md` front matter `done_when:` — the
//!    feature named with `--feature`, or the one whose branch is checked out
//!    (`hermes/<slug>`), when that file lists at least one command;
//! 2. the task's own checks, as the person set them in the launcher:
//!    `<git dir>/hermes/done-when.json` (`{"v": 1, "done_when": [...]}`),
//!    outside the repository so no commit carries them;
//! 3. `.hermes/worktree.toml` `done_when = [...]`.
//!
//! A file that exists but cannot be read is an error with its line number,
//! never a guess. The two readers are ports of the frontend's contract
//! readers (`src/agent/contract/worktreeToml.ts`, `featureFrontMatter.ts`);
//! `src/doneWhen/fixtures/done-when-files.json` holds the cases both sides
//! must agree on, messages included.
//!
//! Each command runs through the platform shell (`sh -c`, `cmd /c`) in the
//! repository root, with a time budget for the whole run. Its output is kept
//! as a short tail, enough to tell an agent (or a person) what failed.
//!
//! The Stop-hook decision ([`decide`]) is pure: given what happened so far in
//! this turn and the new result, block the agent's stop (it continues and
//! tries again), let it stop, or give up after [`MAX_ATTEMPTS`] automatic
//! continuations or once the retry budget is spent.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// How many times a failing check sends a stopping agent back to work in one
/// turn before Hermes gives up and marks the session `check_failed`.
pub const MAX_ATTEMPTS: u32 = 3;
/// Default time budget for one run of all the checks.
pub const DEFAULT_RUN_BUDGET: Duration = Duration::from_secs(600);
/// Default time, from the first failing stop of a turn, during which a
/// failing check may still send the agent back.
pub const DEFAULT_RETRY_BUDGET: Duration = Duration::from_secs(1800);
/// Environment overrides for the two budgets, in seconds.
pub const RUN_BUDGET_ENV: &str = "HERMES_DONE_WHEN_TIMEOUT_SECS";
pub const RETRY_BUDGET_ENV: &str = "HERMES_DONE_WHEN_BUDGET_SECS";
/// Bytes of a command's output kept for the report.
pub const OUTPUT_TAIL_BYTES: usize = 4096;
/// Longest feedback text handed back to an agent.
pub const FEEDBACK_CAP_BYTES: usize = 6000;

pub const WORKTREE_TOML: &str = ".hermes/worktree.toml";
pub const FEATURES_DIR: &str = ".hermes/features";

// ─── Readers ─────────────────────────────────────────────────────────

/// A reader error: the message and its 1-based line (0: the whole file).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadError {
    pub message: String,
    pub line: usize,
}

fn err<T>(message: impl Into<String>, line: usize) -> Result<T, ReadError> {
    Err(ReadError {
        message: message.into(),
        line,
    })
}

#[derive(Debug, Clone, PartialEq)]
enum TomlValue {
    Str(String),
    /// None: a whole number too large to hold (never a valid port).
    Int(Option<i64>),
    Bool(bool),
    Array(Vec<TomlValue>),
}

#[derive(Debug, Clone, PartialEq)]
enum TomlEntry {
    Value(TomlValue),
    Table(BTreeMap<String, TomlValue>),
}

/// Strip a trailing `#` comment that is not inside a string.
fn toml_strip_comment(text: &str) -> &str {
    let bytes = text.as_bytes();
    let mut in_string: Option<u8> = None;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        match in_string {
            Some(q) => {
                if c == b'\\' && q == b'"' {
                    i += 1;
                } else if c == q {
                    in_string = None;
                }
            }
            None => {
                if c == b'"' || c == b'\'' {
                    in_string = Some(c);
                } else if c == b'#' {
                    return &text[..i];
                }
            }
        }
        i += 1;
    }
    text
}

fn toml_string(raw: &str, line: usize) -> Result<String, ReadError> {
    let chars: Vec<char> = raw.chars().collect();
    let q = chars[0];
    if chars.len() < 2 || chars[chars.len() - 1] != q {
        return err("unterminated string", line);
    }
    let body: Vec<char> = chars[1..chars.len() - 1].to_vec();
    if q == '\'' {
        return Ok(body.into_iter().collect());
    }
    let mut out = String::new();
    let mut i = 0;
    while i < body.len() {
        let c = body[i];
        if c == '\\' && i + 1 < body.len() {
            let e = body[i + 1];
            match e {
                'n' => out.push('\n'),
                't' => out.push('\t'),
                '\\' => out.push('\\'),
                '"' => out.push('"'),
                other => return err(format!("unknown escape \\{other}"), line),
            }
            i += 2;
        } else {
            out.push(c);
            i += 1;
        }
    }
    Ok(out)
}

fn is_toml_int(t: &str) -> bool {
    let digits = t.strip_prefix(['+', '-']).unwrap_or(t);
    let mut chars = digits.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_digit() || c == '_')
}

fn toml_scalar(raw: &str, line: usize) -> Result<TomlValue, ReadError> {
    let t = raw.trim();
    if t.is_empty() {
        return err("missing value", line);
    }
    if t.starts_with('"') || t.starts_with('\'') {
        return toml_string(t, line).map(TomlValue::Str);
    }
    match t {
        "true" => return Ok(TomlValue::Bool(true)),
        "false" => return Ok(TomlValue::Bool(false)),
        _ => {}
    }
    if is_toml_int(t) {
        return Ok(TomlValue::Int(t.replace('_', "").parse::<i64>().ok()));
    }
    err(format!("cannot read value {t}"), line)
}

/// Split the inside of `[...]` on commas outside strings and nested arrays.
fn toml_split_array(inner: &str, line: usize) -> Result<Vec<String>, ReadError> {
    let bytes = inner.as_bytes();
    let mut parts = Vec::new();
    let mut depth: i32 = 0;
    let mut in_string: Option<u8> = None;
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        match in_string {
            Some(q) => {
                if c == b'\\' && q == b'"' {
                    i += 1;
                } else if c == q {
                    in_string = None;
                }
            }
            None => match c {
                b'"' | b'\'' => in_string = Some(c),
                b'[' => depth += 1,
                b']' => depth -= 1,
                b',' if depth == 0 => {
                    parts.push(inner[start..i].to_string());
                    start = i + 1;
                }
                _ => {}
            },
        }
        i += 1;
    }
    if in_string.is_some() {
        return err("unterminated string", line);
    }
    if depth != 0 {
        return err("unbalanced brackets", line);
    }
    parts.push(inner[start.min(inner.len())..].to_string());
    let mut parts: Vec<String> = parts.into_iter().map(|p| p.trim().to_string()).collect();
    // A trailing comma leaves one empty part at the end; that is allowed.
    if parts.last().is_some_and(|p| p.is_empty()) {
        parts.pop();
    }
    Ok(parts)
}

fn toml_value(raw: &str, line: usize) -> Result<TomlValue, ReadError> {
    let t = raw.trim();
    if t.starts_with('[') {
        if !t.ends_with(']') || t.len() < 2 {
            return err("unterminated array", line);
        }
        let mut items = Vec::new();
        for p in toml_split_array(&t[1..t.len() - 1], line)? {
            if p.is_empty() {
                return err("empty array element", line);
            }
            items.push(toml_value(&p, line)?);
        }
        return Ok(TomlValue::Array(items));
    }
    toml_scalar(t, line)
}

fn is_bare_key(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Bracket depth change of one line, outside strings.
fn toml_bracket_depth(s: &str) -> i32 {
    let bytes = s.as_bytes();
    let mut depth = 0;
    let mut in_string: Option<u8> = None;
    let mut k = 0;
    while k < bytes.len() {
        let c = bytes[k];
        match in_string {
            Some(q) => {
                if c == b'\\' && q == b'"' {
                    k += 1;
                } else if c == q {
                    in_string = None;
                }
            }
            None => match c {
                b'"' | b'\'' => in_string = Some(c),
                b'[' => depth += 1,
                b']' => depth -= 1,
                _ => {}
            },
        }
        k += 1;
    }
    depth
}

fn parse_toml(text: &str) -> Result<BTreeMap<String, TomlEntry>, ReadError> {
    let mut root: BTreeMap<String, TomlEntry> = BTreeMap::new();
    let mut current: Option<String> = None;
    let lines: Vec<&str> = text
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect();
    let mut i = 0;
    while i < lines.len() {
        let line_no = i + 1;
        let line = toml_strip_comment(lines[i]).trim();
        if line.is_empty() {
            i += 1;
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            if is_bare_key(name) {
                if root.contains_key(name) {
                    return err(format!("table [{name}] defined twice"), line_no);
                }
                root.insert(name.to_string(), TomlEntry::Table(BTreeMap::new()));
                current = Some(name.to_string());
                i += 1;
                continue;
            }
        }
        if line.starts_with('[') {
            return err("only [name] tables are supported", line_no);
        }
        let Some(eq) = line.find('=') else {
            return err("expected key = value", line_no);
        };
        let key = line[..eq].trim_end();
        if !is_bare_key(key) {
            return err("expected key = value", line_no);
        }
        let mut raw = line[eq + 1..].trim_start().to_string();
        // A multi-line array: keep reading until the brackets balance.
        if raw.trim_start().starts_with('[') {
            let mut depth = toml_bracket_depth(&raw);
            while depth > 0 && i + 1 < lines.len() {
                i += 1;
                let next = toml_strip_comment(lines[i]);
                raw.push(' ');
                raw.push_str(next.trim());
                depth += toml_bracket_depth(next);
            }
            if depth > 0 {
                return err("unterminated array", line_no);
            }
        }
        let value = toml_value(&raw, line_no)?;
        match &current {
            Some(table) => {
                let Some(TomlEntry::Table(map)) = root.get_mut(table) else {
                    return err("internal: lost the current table", line_no);
                };
                if map.contains_key(key) {
                    return err(format!("key {key} defined twice"), line_no);
                }
                map.insert(key.to_string(), value);
            }
            None => {
                if root.contains_key(key) {
                    return err(format!("key {key} defined twice"), line_no);
                }
                root.insert(key.to_string(), TomlEntry::Value(value));
            }
        }
        i += 1;
    }
    Ok(root)
}

fn string_list(entry: Option<&TomlEntry>, key: &str) -> Result<Vec<String>, ReadError> {
    match entry {
        None => Ok(Vec::new()),
        Some(TomlEntry::Value(TomlValue::Array(items))) => items
            .iter()
            .map(|v| match v {
                TomlValue::Str(s) => Ok(s.clone()),
                _ => err(format!("{key} must be an array of strings"), 0),
            })
            .collect(),
        Some(_) => err(format!("{key} must be an array of strings"), 0),
    }
}

/// The `done_when` list of a `.hermes/worktree.toml`, validating the whole
/// file the way the frontend's reader does (a file it refuses is refused
/// here too).
pub fn worktree_done_when(text: &str) -> Result<Vec<String>, ReadError> {
    let doc = parse_toml(text)?;
    if let Some(ports) = doc.get("ports") {
        let TomlEntry::Table(map) = ports else {
            return err("ports must be a [ports] table", 0);
        };
        for (name, v) in map {
            let ok = matches!(v, TomlValue::Int(Some(n)) if (1..=65535).contains(n));
            if !ok {
                return err(format!("ports.{name} must be a port number (1-65535)"), 0);
            }
        }
    }
    for key in ["setup", "copy", "done_when"] {
        if let Some(TomlEntry::Table(_)) = doc.get(key) {
            return err(format!("{key} must be an array of strings"), 0);
        }
    }
    string_list(doc.get("setup"), "setup")?;
    string_list(doc.get("copy"), "copy")?;
    string_list(doc.get("done_when"), "done_when")
}

// ── feature.md front matter ──

pub const FEATURE_TRACKS: [&str; 3] = ["Quick", "Light", "Full"];
pub const FEATURE_PHASES: [&str; 7] = [
    "questions",
    "research",
    "design",
    "structure",
    "plan",
    "implement",
    "done",
];
pub const FEATURE_GATES: [&str; 3] = ["none", "waiting", "approved"];

/// A slug is a branch component: `hermes/<slug>`.
pub fn is_feature_slug(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && value.len() <= 64
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeatureMeta {
    pub slug: String,
    pub done_when: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum FmValue {
    Scalar(String),
    List(Vec<String>),
}

fn fm_unquote(raw: &str) -> String {
    let t = raw.trim();
    let b = t.as_bytes();
    if b.len() >= 2
        && ((b[0] == b'"' && b[b.len() - 1] == b'"') || (b[0] == b'\'' && b[b.len() - 1] == b'\''))
    {
        return t[1..t.len() - 1].to_string();
    }
    t.to_string()
}

/// Strip a comment: `#` at the start or after white space, outside quotes.
fn fm_strip_comment(text: &str) -> &str {
    let mut in_string: Option<char> = None;
    let mut prev: Option<char> = None;
    for (i, c) in text.char_indices() {
        match in_string {
            Some(q) => {
                if c == q {
                    in_string = None;
                }
            }
            None => {
                if c == '"' || c == '\'' {
                    in_string = Some(c);
                } else if c == '#' && prev.is_none_or(char::is_whitespace) {
                    return &text[..i];
                }
            }
        }
        prev = Some(c);
    }
    text
}

fn fm_inline_list(raw: &str, line: usize) -> Result<Vec<String>, ReadError> {
    let t = raw.trim();
    let inner = t[1..t.len() - 1].trim();
    if inner.is_empty() {
        return Ok(Vec::new());
    }
    inner
        .split(',')
        .map(|p| {
            let v = fm_unquote(p);
            if v.is_empty() {
                err("empty list item", line)
            } else {
                Ok(v)
            }
        })
        .collect()
}

/// A `- item` line (indented or not): the item text.
fn fm_list_item(line: &str) -> Option<&str> {
    let rest = line.trim_start();
    let item = rest.strip_prefix('-')?;
    Some(item.trim_start())
}

type FmFields = BTreeMap<String, (FmValue, usize)>;

fn fm_block(lines: &[&str], first_line_no: usize) -> Result<FmFields, ReadError> {
    let mut out: FmFields = BTreeMap::new();
    let mut pending: Option<String> = None;
    for (i, raw_line) in lines.iter().enumerate() {
        let line_no = first_line_no + i;
        let line = fm_strip_comment(raw_line).trim_end();
        if line.trim().is_empty() {
            continue;
        }
        if let Some(item) = fm_list_item(line) {
            let Some(key) = &pending else {
                return err("list item outside a list", line_no);
            };
            let v = fm_unquote(item);
            if v.is_empty() {
                return err("empty list item", line_no);
            }
            if let Some((FmValue::List(items), _)) = out.get_mut(key) {
                items.push(v);
            }
            continue;
        }
        if line.starts_with(char::is_whitespace) {
            return err("unexpected indentation", line_no);
        }
        pending = None;
        let Some(colon) = line.find(':') else {
            return err("expected key: value", line_no);
        };
        let key = &line[..colon];
        let after = &line[colon + 1..];
        if !is_bare_key(key) || !(after.is_empty() || after.starts_with(char::is_whitespace)) {
            return err("expected key: value", line_no);
        }
        if out.contains_key(key) {
            return err(format!("{key} given twice"), line_no);
        }
        let raw = after.trim();
        if raw.is_empty() {
            pending = Some(key.to_string());
            out.insert(key.to_string(), (FmValue::List(Vec::new()), line_no));
        } else if raw.starts_with('[') {
            if !raw.ends_with(']') || raw.len() < 2 {
                return err("unterminated list", line_no);
            }
            out.insert(
                key.to_string(),
                (FmValue::List(fm_inline_list(raw, line_no)?), line_no),
            );
        } else {
            out.insert(key.to_string(), (FmValue::Scalar(fm_unquote(raw)), line_no));
        }
    }
    Ok(out)
}

fn fm_one_of(fields: &FmFields, key: &str, allowed: &[&str]) -> Result<(), ReadError> {
    let Some((value, line)) = fields.get(key) else {
        return Ok(());
    };
    let FmValue::Scalar(v) = value else {
        return err(format!("{key} must be one word"), *line);
    };
    if !allowed.contains(&v.as_str()) {
        return err(
            format!("{key} must be one of {}", allowed.join(", ")),
            *line,
        );
    }
    Ok(())
}

/// Read a feature.md's front matter, validating it the way the frontend's
/// reader does.
pub fn feature_front_matter(text: &str) -> Result<FeatureMeta, ReadError> {
    let lines: Vec<&str> = text
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect();
    if lines[0].trim() != "---" {
        return err("feature.md must start with ---", 1);
    }
    let Some(close) = (1..lines.len()).find(|&i| lines[i].trim() == "---") else {
        let mut last = lines.len();
        while last > 1 && lines[last - 1].trim().is_empty() {
            last -= 1;
        }
        return err("front matter never closes (missing ---)", last);
    };
    let fields = fm_block(&lines[1..close], 2)?;
    let Some((slug_value, slug_line)) = fields.get("slug") else {
        return err("slug is required", 1);
    };
    let slug = match slug_value {
        FmValue::Scalar(s) if is_feature_slug(s) => s.clone(),
        _ => {
            return err(
                "slug must be lowercase letters, digits and dashes",
                *slug_line,
            )
        }
    };
    if !fields.contains_key("track") {
        return err("track is required (Quick, Light or Full)", 1);
    }
    fm_one_of(&fields, "track", &FEATURE_TRACKS)?;
    fm_one_of(&fields, "phase", &FEATURE_PHASES)?;
    fm_one_of(&fields, "gate", &FEATURE_GATES)?;
    let done_when = match fields.get("done_when") {
        None => Vec::new(),
        Some((FmValue::Scalar(_), line)) => return err("done_when must be a list", *line),
        Some((FmValue::List(items), _)) => items.clone(),
    };
    Ok(FeatureMeta { slug, done_when })
}

// ─── Where the commands come from ────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    Feature,
    /// The checks the launcher set for this task (`<git dir>/hermes/done-when.json`).
    Task,
    Worktree,
}

impl SourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SourceKind::Feature => "feature",
            SourceKind::Task => "task",
            SourceKind::Worktree => "worktree",
        }
    }
}

/// The task's checks, relative to the checkout's git dir.
pub const TASK_CHECKS_FILE: &str = "hermes/done-when.json";
/// How the task's checks file is named in a report.
pub const TASK_CHECKS_DISPLAY: &str = ".git/hermes/done-when.json";

/// Read the task's checks file: `{"v": 1, "done_when": ["npm test"]}` (a
/// bare array of strings is read too). Blank commands are dropped.
pub fn task_done_when(text: &str) -> Result<Vec<String>, ReadError> {
    let value: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => return err(format!("not JSON: {e}"), e.line()),
    };
    let list = match &value {
        serde_json::Value::Array(_) => &value,
        serde_json::Value::Object(map) => match map.get("done_when") {
            Some(v) => v,
            None => return err("done_when is missing", 0),
        },
        _ => return err("expected an object with done_when", 0),
    };
    let Some(items) = list.as_array() else {
        return err("done_when must be an array of strings", 0);
    };
    let mut out = Vec::new();
    for item in items {
        let Some(s) = item.as_str() else {
            return err("done_when must be an array of strings", 0);
        };
        if !s.trim().is_empty() {
            out.push(s.to_string());
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
    pub kind: SourceKind,
    /// Relative to the repository root, forward slashes.
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolved {
    /// No file lists any check: nothing to run.
    None,
    Commands {
        source: Source,
        commands: Vec<String>,
    },
    /// A file exists but cannot be read.
    Error { source: Source, message: String },
}

/// The repository (or linked worktree) folder containing `start`: the
/// closest ancestor with a `.git` entry; `start` itself when there is none.
pub fn find_root(start: &Path) -> PathBuf {
    let mut dir = Some(start);
    while let Some(d) = dir {
        if d.join(".git").exists() {
            return d.to_path_buf();
        }
        dir = d.parent();
    }
    start.to_path_buf()
}

/// The git dir of the checkout at `root`: `.git`, or where a linked
/// worktree's `.git` file points (`gitdir:`).
pub fn git_dir(root: &Path) -> Option<PathBuf> {
    let dot_git = root.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    let text = std::fs::read_to_string(&dot_git).ok()?;
    let target = text
        .lines()
        .next()?
        .strip_prefix("gitdir:")?
        .trim()
        .to_string();
    let p = PathBuf::from(&target);
    Some(if p.is_absolute() { p } else { root.join(p) })
}

/// The branch checked out in `root` (`None` when detached or not a repo).
/// Reads `.git/HEAD` directly, following a linked worktree's `gitdir:`.
pub fn current_branch(root: &Path) -> Option<String> {
    let git_dir = git_dir(root)?;
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    head.trim()
        .strip_prefix("ref: refs/heads/")
        .map(str::to_string)
}

/// Which feature a checkout works on: `hermes/<slug>`.
pub fn feature_from_branch(branch: &str) -> Option<&str> {
    branch
        .strip_prefix("hermes/")
        .filter(|slug| is_feature_slug(slug))
}

fn read_error(file: &str, e: &ReadError) -> String {
    if e.line == 0 {
        format!("{file} can't be read: {}", e.message)
    } else {
        format!("{file} can't be read (line {}): {}", e.line, e.message)
    }
}

/// Find the checks for the checkout at `root`.
pub fn resolve(root: &Path, feature: Option<&str>) -> Resolved {
    let branch = current_branch(root);
    let slug = feature
        .filter(|s| is_feature_slug(s))
        .map(str::to_string)
        .or_else(|| {
            branch
                .as_deref()
                .and_then(feature_from_branch)
                .map(str::to_string)
        });
    if let Some(slug) = slug {
        let rel = format!("{FEATURES_DIR}/{slug}/feature.md");
        if let Ok(text) = std::fs::read_to_string(root.join(&rel)) {
            let source = Source {
                kind: SourceKind::Feature,
                path: rel,
            };
            match feature_front_matter(&text) {
                Err(e) => {
                    return Resolved::Error {
                        source,
                        message: read_error("feature.md", &e),
                    }
                }
                Ok(meta) if !meta.done_when.is_empty() => {
                    return Resolved::Commands {
                        source,
                        commands: meta.done_when,
                    }
                }
                Ok(_) => {}
            }
        }
    }
    // The task's own checks, as the person set them in the launcher: kept in
    // the checkout's git dir (never in the repository, so an agent's commit
    // cannot carry them, and they stay with this one task).
    if let Some(file) = git_dir(root).map(|d| d.join(TASK_CHECKS_FILE)) {
        if let Ok(text) = std::fs::read_to_string(&file) {
            let source = Source {
                kind: SourceKind::Task,
                path: TASK_CHECKS_DISPLAY.to_string(),
            };
            return match task_done_when(&text) {
                Err(e) => Resolved::Error {
                    source,
                    message: read_error("done-when.json", &e),
                },
                Ok(commands) if !commands.is_empty() => Resolved::Commands { source, commands },
                // The person removed every check for this task.
                Ok(_) => Resolved::None,
            };
        }
    }
    let Ok(text) = std::fs::read_to_string(root.join(WORKTREE_TOML)) else {
        return Resolved::None;
    };
    let source = Source {
        kind: SourceKind::Worktree,
        path: WORKTREE_TOML.to_string(),
    };
    match worktree_done_when(&text) {
        Err(e) => Resolved::Error {
            source,
            message: read_error("worktree.toml", &e),
        },
        Ok(commands) if commands.iter().any(|c| !c.trim().is_empty()) => Resolved::Commands {
            source,
            commands: commands
                .into_iter()
                .filter(|c| !c.trim().is_empty())
                .collect(),
        },
        Ok(_) => Resolved::None,
    }
}

// ─── Running ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandResult {
    pub command: String,
    /// None: it did not exit on its own (timed out, not started).
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub duration_ms: u64,
    /// The last few KB of stdout and stderr, interleaved.
    pub output_tail: String,
}

impl CommandResult {
    pub fn passed(&self) -> bool {
        self.exit_code == Some(0) && !self.timed_out
    }
}

/// Keeps only the last `cap` bytes written to it.
struct Tail {
    buf: Vec<u8>,
    cap: usize,
}

impl Tail {
    fn push(&mut self, data: &[u8]) {
        self.buf.extend_from_slice(data);
        if self.buf.len() > self.cap * 2 {
            let cut = self.buf.len() - self.cap;
            self.buf.drain(..cut);
        }
    }

    fn text(&self) -> String {
        let start = self.buf.len().saturating_sub(self.cap);
        let text = String::from_utf8_lossy(&self.buf[start..]).to_string();
        // Carriage returns redraw a line in a terminal; in a report they only
        // hide what came before them.
        text.replace("\r\n", "\n").replace('\r', "\n")
    }
}

fn shell_command(command: &str) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("cmd.exe");
        c.args(["/d", "/s", "/c"]);
        c.raw_arg(format!("\"{command}\""));
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = Command::new("sh");
        c.args(["-c", command]);
        c
    }
}

fn kill_tree(child: &mut std::process::Child, own_group: bool) {
    #[cfg(unix)]
    {
        if own_group {
            // SAFETY: plain syscall; a negative pid signals the whole group.
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
        }
    }
    #[cfg(windows)]
    {
        let _ = own_group;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(any(unix, windows)))]
    let _ = own_group;
    let _ = child.kill();
}

/// Run one command through the platform shell in `cwd`, killing it (and
/// what it started) after `timeout`. `own_group` puts it in a process group
/// of its own so a timeout can end everything it started; leave it off when
/// a person runs the check at a terminal, so Ctrl-C reaches it.
pub fn run_command(command: &str, cwd: &Path, timeout: Duration, own_group: bool) -> CommandResult {
    let started = Instant::now();
    let mut cmd = shell_command(command);
    cmd.current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    if own_group {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return CommandResult {
                command: command.to_string(),
                exit_code: None,
                timed_out: false,
                duration_ms: started.elapsed().as_millis() as u64,
                output_tail: format!("could not start the shell: {e}"),
            }
        }
    };
    let tail = Arc::new(Mutex::new(Tail {
        buf: Vec::new(),
        cap: OUTPUT_TAIL_BYTES,
    }));
    let (done_tx, done_rx) = mpsc::channel::<()>();
    let mut readers = 0;
    let pipes: Vec<Box<dyn Read + Send>> = [
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    .collect();
    for mut pipe in pipes {
        readers += 1;
        let tail = Arc::clone(&tail);
        let done = done_tx.clone();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if let Ok(mut t) = tail.lock() {
                            t.push(&chunk[..n]);
                        }
                    }
                }
            }
            let _ = done.send(());
        });
    }
    drop(done_tx);

    let mut timed_out = false;
    let exit_code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break exit_code_of(status),
            Ok(None) => {}
            Err(_) => break None,
        }
        if started.elapsed() >= timeout {
            timed_out = true;
            kill_tree(&mut child, own_group);
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    // Something the command left running in the background can hold the
    // pipes open; do not wait for it for long.
    let grace = Instant::now() + Duration::from_secs(2);
    for _ in 0..readers {
        let left = grace.saturating_duration_since(Instant::now());
        if done_rx.recv_timeout(left).is_err() {
            break;
        }
    }
    let mut output_tail = tail.lock().map(|t| t.text()).unwrap_or_default();
    if timed_out {
        output_tail.push_str(&format!(
            "\n(stopped after {} s: the check time budget ran out)",
            timeout.as_secs()
        ));
    }
    CommandResult {
        command: command.to_string(),
        exit_code: if timed_out { None } else { exit_code },
        timed_out,
        duration_ms: started.elapsed().as_millis() as u64,
        output_tail,
    }
}

fn exit_code_of(status: std::process::ExitStatus) -> Option<i32> {
    if let Some(code) = status.code() {
        return Some(code);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            return Some(128 + sig);
        }
    }
    Some(1)
}

/// Run every command in order, sharing one time budget. A command that
/// cannot start because the budget is spent is reported as timed out.
pub fn run_all(
    commands: &[String],
    cwd: &Path,
    budget: Duration,
    own_group: bool,
) -> Vec<CommandResult> {
    let started = Instant::now();
    commands
        .iter()
        .map(|command| {
            let left = budget.saturating_sub(started.elapsed());
            if left.is_zero() {
                return CommandResult {
                    command: command.clone(),
                    exit_code: None,
                    timed_out: true,
                    duration_ms: 0,
                    output_tail: "(not started: the check time budget ran out)".to_string(),
                };
            }
            run_command(command, cwd, left, own_group)
        })
        .collect()
}

// ─── Reports ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Passed,
    Failed,
    /// A done_when file could not be read.
    Error,
    /// Nothing to check here.
    None,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Passed => "passed",
            State::Failed => "failed",
            State::Error => "error",
            State::None => "none",
        }
    }
}

/// One run of the checks, as `hi check --json` prints it and the spool
/// line carries it (the app reads the same fields).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub state: State,
    pub trigger: String,
    pub source: Option<Source>,
    pub error: Option<String>,
    pub commands: Vec<CommandResult>,
    pub started_at: u64,
    pub duration_ms: u64,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Resolve and run the checks of the checkout containing `cwd`.
pub fn check(
    cwd: &Path,
    feature: Option<&str>,
    trigger: &str,
    budget: Duration,
    own_group: bool,
) -> Report {
    let started_at = now_ms();
    let t0 = Instant::now();
    let root = find_root(cwd);
    let (state, source, error, commands) = match resolve(&root, feature) {
        Resolved::None => (State::None, None, None, Vec::new()),
        Resolved::Error { source, message } => {
            (State::Error, Some(source), Some(message), Vec::new())
        }
        Resolved::Commands { source, commands } => {
            let results = run_all(&commands, &root, budget, own_group);
            let state = if results.iter().all(CommandResult::passed) {
                State::Passed
            } else {
                State::Failed
            };
            (state, Some(source), None, results)
        }
    };
    Report {
        state,
        trigger: trigger.to_string(),
        source,
        error,
        commands,
        started_at,
        duration_ms: t0.elapsed().as_millis() as u64,
    }
}

fn truncate_tail(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &s[start..])
}

fn truncate_head(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

impl Report {
    pub fn failed_commands(&self) -> Vec<&CommandResult> {
        self.commands.iter().filter(|c| !c.passed()).collect()
    }

    /// JSON with each command's output cut to `tail_bytes`.
    pub fn to_json(&self, tail_bytes: usize) -> serde_json::Value {
        serde_json::json!({
            "v": 1,
            "state": self.state.as_str(),
            "trigger": self.trigger,
            "source": self.source.as_ref().map(|s| serde_json::json!({ "kind": s.kind.as_str(), "path": s.path })),
            "error": self.error,
            "commands": self.commands.iter().map(|c| serde_json::json!({
                "command": c.command,
                "exit_code": c.exit_code,
                "timed_out": c.timed_out,
                "duration_ms": c.duration_ms,
                "output_tail": truncate_tail(&c.output_tail, tail_bytes),
            })).collect::<Vec<_>>(),
            "started_at": self.started_at,
            "duration_ms": self.duration_ms,
        })
    }

    /// The text handed back to an agent: which checks failed and how.
    pub fn feedback(&self, attempt: Option<(u32, u32)>) -> String {
        let mut out = String::new();
        let where_from = self
            .source
            .as_ref()
            .map(|s| format!(" (from {})", s.path))
            .unwrap_or_default();
        match attempt {
            Some((n, max)) => out.push_str(&format!(
                "Hermes Done-When checks failed{where_from}, attempt {n} of {max}. You are not done yet: fix what these checks report, then finish again.\n"
            )),
            None => out.push_str(&format!(
                "Hermes Done-When checks failed{where_from}. Fix what these checks report, then finish again.\n"
            )),
        }
        let failed = self.failed_commands();
        let per_command = (FEEDBACK_CAP_BYTES / failed.len().max(1)).clamp(400, 3000);
        for c in failed {
            let how = if c.timed_out {
                "timed out".to_string()
            } else {
                match c.exit_code {
                    Some(code) => format!("exit {code}"),
                    None => "did not run".to_string(),
                }
            };
            out.push_str(&format!("\n$ {} ({how})\n", c.command));
            let tail = c.output_tail.trim_end();
            if !tail.is_empty() {
                out.push_str(&truncate_tail(tail, per_command));
                out.push('\n');
            }
        }
        truncate_head(&out, FEEDBACK_CAP_BYTES)
    }
}

// ─── The Stop hook's decision ────────────────────────────────────────

/// What the Stop hook remembers within one turn (a file in the session's
/// launch folder).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HookState {
    /// Failing stops so far in this turn.
    pub attempts: u32,
    /// When the first of them happened (epoch ms).
    pub first_failure_ms: Option<u64>,
}

impl HookState {
    pub fn parse(text: &str) -> HookState {
        let v: serde_json::Value = serde_json::from_str(text).unwrap_or_default();
        HookState {
            attempts: v.get("attempts").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
            first_failure_ms: v.get("first_failure_ms").and_then(|x| x.as_u64()),
        }
    }

    pub fn to_json(self) -> String {
        serde_json::json!({ "attempts": self.attempts, "first_failure_ms": self.first_failure_ms })
            .to_string()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Let the agent stop (checks passed, nothing to check, or unreadable).
    Allow,
    /// Send it back to work with the failures (attempt n of max).
    Block { attempt: u32 },
    /// Checks still fail but the attempts or the budget are used up: let it
    /// stop, and report `check_failed`.
    GiveUp { attempt: u32 },
}

/// Decide what a Stop hook does. `continuing` is the hook payload's
/// `stop_hook_active`: false means this is the first stop of a new turn, so
/// the attempt count starts over.
pub fn decide(
    state: &mut HookState,
    continuing: bool,
    outcome: State,
    now_ms: u64,
    max_attempts: u32,
    retry_budget: Duration,
) -> Decision {
    if !continuing {
        *state = HookState::default();
    }
    if outcome != State::Failed {
        *state = HookState::default();
        return Decision::Allow;
    }
    state.attempts += 1;
    let first = *state.first_failure_ms.get_or_insert(now_ms);
    let within_budget = now_ms.saturating_sub(first) <= retry_budget.as_millis() as u64;
    let attempt = state.attempts;
    if attempt <= max_attempts && within_budget {
        Decision::Block { attempt }
    } else {
        *state = HookState::default();
        Decision::GiveUp { attempt }
    }
}

/// A budget from the environment (whole seconds), else the default.
pub fn budget_from_env(name: &str, default: Duration) -> Duration {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|&s| s > 0)
        .map(Duration::from_secs)
        .unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shared with src/__tests__/done-when-files.test.ts.
    const FIXTURE: &str = include_str!("../../../src/doneWhen/fixtures/done-when-files.json");

    fn fixture() -> serde_json::Value {
        serde_json::from_str(FIXTURE).expect("fixture is JSON")
    }

    fn strings(v: &serde_json::Value) -> Vec<String> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn the_worktree_reader_agrees_with_the_frontend_on_every_fixture_case() {
        let cases = fixture()["worktree"].as_array().unwrap().clone();
        assert!(cases.len() >= 10);
        for case in cases {
            let text = case["text"].as_str().unwrap();
            let got = worktree_done_when(text);
            if let Some(expected) = case.get("doneWhen") {
                assert_eq!(got, Ok(strings(expected)), "{}", case["name"]);
            } else {
                let e = &case["error"];
                assert_eq!(
                    got,
                    Err(ReadError {
                        message: e["message"].as_str().unwrap().to_string(),
                        line: e["line"].as_u64().unwrap() as usize
                    }),
                    "{}",
                    case["name"]
                );
            }
        }
    }

    #[test]
    fn the_feature_reader_agrees_with_the_frontend_on_every_fixture_case() {
        let cases = fixture()["feature"].as_array().unwrap().clone();
        assert!(cases.len() >= 10);
        for case in cases {
            let text = case["text"].as_str().unwrap();
            let got = feature_front_matter(text);
            if let Some(expected) = case.get("doneWhen") {
                let meta = got.unwrap_or_else(|e| panic!("{}: {e:?}", case["name"]));
                assert_eq!(meta.done_when, strings(expected), "{}", case["name"]);
                assert_eq!(
                    meta.slug,
                    case["slug"].as_str().unwrap(),
                    "{}",
                    case["name"]
                );
            } else {
                let e = &case["error"];
                assert_eq!(
                    got,
                    Err(ReadError {
                        message: e["message"].as_str().unwrap().to_string(),
                        line: e["line"].as_u64().unwrap() as usize
                    }),
                    "{}",
                    case["name"]
                );
            }
        }
    }

    fn repo(branch: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        std::fs::write(
            dir.path().join(".git/HEAD"),
            format!("ref: refs/heads/{branch}\n"),
        )
        .unwrap();
        dir
    }

    fn write(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    #[test]
    fn the_features_checks_win_over_the_worktree_file_on_its_branch() {
        let r = repo("hermes/search");
        write(r.path(), WORKTREE_TOML, "done_when = [\"npm test\"]\n");
        write(
            r.path(),
            ".hermes/features/search/feature.md",
            "---\nslug: search\ntrack: Full\ndone_when:\n  - npm run e2e\n---\nbody\n",
        );
        assert_eq!(
            resolve(r.path(), None),
            Resolved::Commands {
                source: Source {
                    kind: SourceKind::Feature,
                    path: ".hermes/features/search/feature.md".into()
                },
                commands: vec!["npm run e2e".into()]
            }
        );
        // Another branch: the feature is not this checkout's, so the
        // worktree file applies.
        let other = repo("main");
        write(other.path(), WORKTREE_TOML, "done_when = [\"npm test\"]\n");
        write(
            other.path(),
            ".hermes/features/search/feature.md",
            "---\nslug: search\ntrack: Full\ndone_when: [x]\n---\n",
        );
        assert!(matches!(
            resolve(other.path(), None),
            Resolved::Commands { source: Source { kind: SourceKind::Worktree, .. }, ref commands } if commands == &["npm test".to_string()]
        ));
        // ...unless the feature is named.
        assert!(matches!(
            resolve(other.path(), Some("search")),
            Resolved::Commands {
                source: Source {
                    kind: SourceKind::Feature,
                    ..
                },
                ..
            }
        ));
    }

    #[test]
    fn a_feature_without_checks_falls_back_and_an_unreadable_file_is_an_error() {
        let r = repo("hermes/a");
        write(r.path(), WORKTREE_TOML, "done_when = [\"make check\"]\n");
        write(
            r.path(),
            ".hermes/features/a/feature.md",
            "---\nslug: a\ntrack: Quick\n---\n",
        );
        assert!(matches!(
            resolve(r.path(), None),
            Resolved::Commands {
                source: Source {
                    kind: SourceKind::Worktree,
                    ..
                },
                ..
            }
        ));
        write(
            r.path(),
            ".hermes/features/a/feature.md",
            "---\nslug: a\ntrack: Huge\n---\n",
        );
        assert_eq!(
            resolve(r.path(), None),
            Resolved::Error {
                source: Source {
                    kind: SourceKind::Feature,
                    path: ".hermes/features/a/feature.md".into()
                },
                message:
                    "feature.md can't be read (line 3): track must be one of Quick, Light, Full"
                        .into()
            }
        );
        let bad = repo("main");
        write(bad.path(), WORKTREE_TOML, "done_when = \"npm test\"\n");
        assert!(matches!(
            resolve(bad.path(), None),
            Resolved::Error { ref message, .. } if message == "worktree.toml can't be read: done_when must be an array of strings"
        ));
        let none = repo("main");
        assert_eq!(resolve(none.path(), None), Resolved::None);
        write(
            none.path(),
            WORKTREE_TOML,
            "setup = [\"npm ci\"]\ndone_when = []\n",
        );
        assert_eq!(resolve(none.path(), None), Resolved::None);
    }

    #[test]
    fn the_tasks_launcher_checks_win_over_the_worktree_file() {
        let r = repo("hermes/add");
        write(r.path(), WORKTREE_TOML, "done_when = [\"npm test\"]\n");
        write(
            r.path(),
            ".git/hermes/done-when.json",
            "{\"v\": 1, \"done_when\": [\"node -e \\\"process.exit(3)\\\"\", \"  \"]}\n",
        );
        assert_eq!(
            resolve(r.path(), None),
            Resolved::Commands {
                source: Source {
                    kind: SourceKind::Task,
                    path: TASK_CHECKS_DISPLAY.into()
                },
                commands: vec!["node -e \"process.exit(3)\"".into()]
            }
        );
        // A feature's own checks still come first.
        write(
            r.path(),
            ".hermes/features/add/feature.md",
            "---\nslug: add\ntrack: Full\ndone_when: [npm run e2e]\n---\n",
        );
        assert!(matches!(
            resolve(r.path(), None),
            Resolved::Commands {
                source: Source {
                    kind: SourceKind::Feature,
                    ..
                },
                ..
            }
        ));
        // Every check removed in the launcher: none run.
        let none = repo("hermes/b");
        write(none.path(), WORKTREE_TOML, "done_when = [\"npm test\"]\n");
        write(
            none.path(),
            ".git/hermes/done-when.json",
            "{\"v\":1,\"done_when\":[]}",
        );
        assert_eq!(resolve(none.path(), None), Resolved::None);
        // A bare array is read too; anything else is an error, never a guess.
        assert_eq!(task_done_when("[\"make\"]").unwrap(), vec!["make"]);
        write(
            none.path(),
            ".git/hermes/done-when.json",
            "{\"done_when\": \"make\"}",
        );
        assert!(matches!(
            resolve(none.path(), None),
            Resolved::Error { ref message, .. } if message == "done-when.json can't be read: done_when must be an array of strings"
        ));
        assert!(task_done_when("{").is_err());
    }

    #[test]
    fn a_linked_worktree_reads_the_tasks_checks_from_its_own_git_dir() {
        let main = tempfile::tempdir().unwrap();
        let gitdir = main.path().join("worktrees").join("wt");
        std::fs::create_dir_all(gitdir.join("hermes")).unwrap();
        std::fs::write(gitdir.join("HEAD"), "ref: refs/heads/hermes/x\n").unwrap();
        std::fs::write(
            gitdir.join("hermes/done-when.json"),
            "{\"v\":1,\"done_when\":[\"true\"]}",
        )
        .unwrap();
        let wt = tempfile::tempdir().unwrap();
        std::fs::write(
            wt.path().join(".git"),
            format!("gitdir: {}\n", gitdir.display()),
        )
        .unwrap();
        assert!(matches!(
            resolve(wt.path(), None),
            Resolved::Commands { source: Source { kind: SourceKind::Task, .. }, ref commands } if commands == &["true".to_string()]
        ));
    }

    #[test]
    fn a_linked_worktree_finds_its_branch_through_gitdir() {
        let main = tempfile::tempdir().unwrap();
        let gitdir = main.path().join("worktrees").join("wt");
        std::fs::create_dir_all(&gitdir).unwrap();
        std::fs::write(gitdir.join("HEAD"), "ref: refs/heads/hermes/login-page\n").unwrap();
        let wt = tempfile::tempdir().unwrap();
        std::fs::write(
            wt.path().join(".git"),
            format!("gitdir: {}\n", gitdir.display()),
        )
        .unwrap();
        let sub = wt.path().join("src").join("deep");
        std::fs::create_dir_all(&sub).unwrap();
        assert_eq!(find_root(&sub), wt.path());
        assert_eq!(
            current_branch(wt.path()).as_deref(),
            Some("hermes/login-page")
        );
        assert_eq!(feature_from_branch("hermes/login-page"), Some("login-page"));
        assert_eq!(feature_from_branch("hermes/Not Valid"), None);
        assert_eq!(feature_from_branch("main"), None);
    }

    fn sh(posix: &str, windows: &str) -> String {
        if cfg!(windows) { windows } else { posix }.to_string()
    }

    #[test]
    fn commands_run_in_order_with_their_exit_codes_and_output() {
        let dir = tempfile::tempdir().unwrap();
        let cmds = vec![
            sh("echo first && exit 0", "echo first& exit /b 0"),
            sh("echo broken >&2; exit 3", "echo broken 1>&2& exit /b 3"),
        ];
        let results = run_all(&cmds, dir.path(), Duration::from_secs(30), true);
        assert_eq!(results.len(), 2);
        assert!(results[0].passed());
        assert!(results[0].output_tail.contains("first"));
        assert_eq!(results[1].exit_code, Some(3));
        assert!(results[1].output_tail.contains("broken"));
        assert!(!results[1].passed());
    }

    #[test]
    fn a_command_over_budget_is_killed_and_the_rest_do_not_start() {
        let dir = tempfile::tempdir().unwrap();
        let cmds = vec![
            sh("sleep 20", "ping -n 30 127.0.0.1 >NUL"),
            sh("echo never", "echo never"),
        ];
        let t0 = Instant::now();
        let results = run_all(&cmds, dir.path(), Duration::from_millis(700), true);
        assert!(t0.elapsed() < Duration::from_secs(10), "{:?}", t0.elapsed());
        assert!(results[0].timed_out && results[0].exit_code.is_none());
        assert!(results[0].output_tail.contains("budget ran out"));
        assert!(results[1].timed_out);
        assert!(!results[1].output_tail.contains("never\n"));
    }

    #[test]
    fn the_whole_check_reports_state_source_and_commands() {
        let r = repo("main");
        let fail = sh("echo nope; exit 1", "echo nope& exit /b 1");
        write(
            r.path(),
            WORKTREE_TOML,
            &format!("done_when = [{}]\n", serde_json::to_string(&fail).unwrap()),
        );
        let report = check(r.path(), None, "cli", Duration::from_secs(30), true);
        assert_eq!(report.state, State::Failed);
        assert_eq!(report.trigger, "cli");
        assert_eq!(report.source.as_ref().unwrap().path, WORKTREE_TOML);
        let json = report.to_json(1024);
        assert_eq!(json["state"], "failed");
        assert_eq!(json["source"]["kind"], "worktree");
        assert_eq!(json["commands"][0]["exit_code"], 1);
        let feedback = report.feedback(Some((2, 3)));
        assert!(feedback.contains("attempt 2 of 3"), "{feedback}");
        assert!(
            feedback.contains("(exit 1)") && feedback.contains("nope"),
            "{feedback}"
        );

        write(r.path(), WORKTREE_TOML, "done_when = [\"exit 0\"]\n");
        assert_eq!(
            check(r.path(), None, "cli", Duration::from_secs(30), true).state,
            State::Passed
        );
        write(r.path(), WORKTREE_TOML, "done_when = [\n");
        let e = check(r.path(), None, "cli", Duration::from_secs(30), true);
        assert_eq!(e.state, State::Error);
        assert_eq!(
            e.error.as_deref(),
            Some("worktree.toml can't be read (line 1): unterminated array")
        );
        std::fs::remove_file(r.path().join(WORKTREE_TOML)).unwrap();
        assert_eq!(
            check(r.path(), None, "cli", Duration::from_secs(30), true).state,
            State::None
        );
    }

    #[test]
    fn feedback_stays_under_its_cap_and_keeps_the_end_of_the_output() {
        let report = Report {
            state: State::Failed,
            trigger: "stop_hook".into(),
            source: None,
            error: None,
            commands: vec![CommandResult {
                command: "npm test".into(),
                exit_code: Some(1),
                timed_out: false,
                duration_ms: 5,
                output_tail: format!("{}THE-END", "x".repeat(20_000)),
            }],
            started_at: 0,
            duration_ms: 5,
        };
        let text = report.feedback(None);
        assert!(text.len() <= FEEDBACK_CAP_BYTES + 4);
        assert!(text.contains("THE-END"));
    }

    #[test]
    fn the_stop_hook_blocks_three_times_per_turn_then_gives_up() {
        let budget = Duration::from_secs(1800);
        let mut s = HookState::default();
        // First stop of a turn (not continuing).
        assert_eq!(
            decide(&mut s, false, State::Failed, 1000, 3, budget),
            Decision::Block { attempt: 1 }
        );
        assert_eq!(
            decide(&mut s, true, State::Failed, 2000, 3, budget),
            Decision::Block { attempt: 2 }
        );
        assert_eq!(
            decide(&mut s, true, State::Failed, 3000, 3, budget),
            Decision::Block { attempt: 3 }
        );
        assert_eq!(
            decide(&mut s, true, State::Failed, 4000, 3, budget),
            Decision::GiveUp { attempt: 4 }
        );
        assert_eq!(s, HookState::default());
        // A new turn starts over.
        assert_eq!(
            decide(&mut s, false, State::Failed, 5000, 3, budget),
            Decision::Block { attempt: 1 }
        );
        // Passing lets it stop and forgets the count.
        assert_eq!(
            decide(&mut s, true, State::Passed, 6000, 3, budget),
            Decision::Allow
        );
        assert_eq!(s.attempts, 0);
        // Nothing to check, or a file that cannot be read: never block.
        assert_eq!(
            decide(&mut s, false, State::None, 7000, 3, budget),
            Decision::Allow
        );
        assert_eq!(
            decide(&mut s, false, State::Error, 7000, 3, budget),
            Decision::Allow
        );
        // A stale count from an earlier turn does not carry over.
        let mut stale = HookState {
            attempts: 3,
            first_failure_ms: Some(1),
        };
        assert_eq!(
            decide(&mut stale, false, State::Failed, 9000, 3, budget),
            Decision::Block { attempt: 1 }
        );
    }

    #[test]
    fn the_stop_hook_gives_up_once_the_retry_budget_is_spent() {
        let budget = Duration::from_secs(60);
        let mut s = HookState::default();
        assert_eq!(
            decide(&mut s, false, State::Failed, 0, 3, budget),
            Decision::Block { attempt: 1 }
        );
        assert_eq!(
            decide(&mut s, true, State::Failed, 61_000, 3, budget),
            Decision::GiveUp { attempt: 2 }
        );
        let round = HookState {
            attempts: 2,
            first_failure_ms: Some(5),
        };
        assert_eq!(HookState::parse(&round.to_json()), round);
        assert_eq!(HookState::parse("garbage"), HookState::default());
    }
}
