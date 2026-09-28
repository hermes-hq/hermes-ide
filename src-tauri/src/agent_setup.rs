//! What an agent reads when it starts, and how it was started (F30, F35).
//!
//! * `agent_setup_overview` lists, for one agent in one folder, the
//!   instruction files it will load (following `@path` imports where the
//!   agent does), its settings files and skills, and the MCP servers every
//!   agent in the catalog would see there. Folders attached to the session
//!   are listed too, marked as not loaded: agents started in a terminal only
//!   read their own folder. Everything here is read-only; MCP entries are
//!   reported by name only, never with their commands, URLs or secrets.
//! * `link_instructions_to_agents_md` is the one write: on request it adds
//!   `@AGENTS.md` to the agent's own instruction file (for Claude,
//!   `CLAUDE.md`) in a project folder, so one file holds the project rules.
//! * `session_process_argv` returns the command lines of the catalog agents
//!   running under a session's shell (and nothing else), so the frontend can
//!   tell which agent runs there and whether it was started looser than
//!   Hermes's safety default.
//!
//! The per-agent paths live in the catalog (`setup` in
//! `src/catalog/agents.json`).

use crate::agent_catalog::{self, Agent};
use serde::Serialize;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;

/// Largest instruction file read when looking for `@path` imports.
const MAX_READ_BYTES: u64 = 512 * 1024;
/// Largest MCP config file read (`~/.claude.json` keeps history and grows
/// well past the instruction-file cap).
const MAX_MCP_CONFIG_BYTES: u64 = 16 * 1024 * 1024;
/// Claude Code follows imports at most this many hops deep.
const MAX_IMPORT_DEPTH: usize = 5;
/// Folders walked up from the working folder looking for the repository root.
const MAX_WALK_UP: usize = 32;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SetupItem {
    /// Absolute path on disk.
    pub path: String,
    /// `~/...` for the home folder, else the path relative to its folder.
    pub display: String,
    /// File (or skill folder) name.
    pub name: String,
    /// `global`, `project` or `attached`.
    pub scope: String,
    /// The project or attached folder it belongs to (none for global).
    pub folder: Option<String>,
    /// Whether the agent loads it when started in the working folder.
    pub loaded: bool,
    /// For an imported file: the display path of the file importing it.
    pub via: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerItem {
    pub name: String,
    /// Display path of the file that declares it.
    pub source: String,
    /// `global`, `project`, `local` (Claude's per-folder entry in
    /// ~/.claude.json) or `attached`.
    pub scope: String,
    pub loaded: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentMcp {
    pub agent_id: String,
    pub agent_name: String,
    pub servers: Vec<McpServerItem>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkSuggestion {
    /// The project folder the link is written in.
    pub folder: String,
    /// The agent's own instruction file (e.g. `CLAUDE.md`).
    pub file: String,
    /// Always `AGENTS.md`.
    pub target: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSetupOverview {
    pub agent_id: String,
    pub agent_name: String,
    /// False when the catalog does not say where this agent reads its setup.
    pub known: bool,
    pub instructions: Vec<SetupItem>,
    pub settings: Vec<SetupItem>,
    pub skills: Vec<SetupItem>,
    /// Every catalog agent that has MCP sources: this agent first.
    pub mcp: Vec<AgentMcp>,
    pub link: Option<LinkSuggestion>,
}

// ─── Paths ────────────────────────────────────────────────────────────

fn home() -> Option<PathBuf> {
    crate::platform::home_dir()
}

fn display_path(path: &Path, base: Option<&Path>, home: Option<&Path>) -> String {
    if let Some(base) = base {
        if let Ok(rel) = path.strip_prefix(base) {
            let s = rel.to_string_lossy().replace('\\', "/");
            if !s.is_empty() {
                return s;
            }
        }
    }
    if let Some(h) = home {
        if let Ok(rel) = path.strip_prefix(h) {
            return format!("~/{}", rel.to_string_lossy().replace('\\', "/"));
        }
    }
    path.to_string_lossy().to_string()
}

/// Joins a catalog path (`/`-separated, optional `~/`) onto `base`, or onto
/// the home folder for `~/` paths. `None` for a `~/` path without a home.
fn join_catalog_path(base: &Path, rel: &str, home: Option<&Path>) -> Option<PathBuf> {
    let (root, rest) = match rel.strip_prefix("~/") {
        Some(rest) => (home?.to_path_buf(), rest),
        None => (base.to_path_buf(), rel),
    };
    let mut p = root;
    for part in rest.split('/').filter(|s| !s.is_empty()) {
        if part == ".." {
            return None;
        }
        p.push(part);
    }
    Some(p)
}

/// `prefix*suffix` against one file name (a single `*`, or none).
fn wildcard_match(pattern: &str, name: &str) -> bool {
    match pattern.split_once('*') {
        None => pattern == name,
        Some((pre, post)) => {
            name.len() >= pre.len() + post.len() && name.starts_with(pre) && name.ends_with(post)
        }
    }
}

/// Every existing file a catalog pattern names under `base`: `a|b` is the
/// first alternative that exists; `*` in the last component lists matching
/// files in that folder (sorted).
fn expand(base: &Path, pattern: &str, home: Option<&Path>) -> Vec<PathBuf> {
    for alt in pattern.split('|') {
        let found = expand_one(base, alt, home);
        if !found.is_empty() {
            return found;
        }
    }
    Vec::new()
}

fn expand_one(base: &Path, rel: &str, home: Option<&Path>) -> Vec<PathBuf> {
    let Some(full) = join_catalog_path(base, rel, home) else {
        return Vec::new();
    };
    let last = full
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if !last.contains('*') {
        return if full.exists() {
            vec![full]
        } else {
            Vec::new()
        };
    }
    let Some(dir) = full.parent() else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().is_file())
                .filter(|e| wildcard_match(&last, &e.file_name().to_string_lossy()))
                .map(|e| e.path())
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

/// The folders an agent reads project instructions from when started in
/// `cwd`: from the repository root down to `cwd`. Outside a repository,
/// only `cwd`.
fn project_chain(cwd: &Path, home: Option<&Path>) -> Vec<PathBuf> {
    let mut chain = vec![cwd.to_path_buf()];
    let mut dir = cwd.to_path_buf();
    for _ in 0..MAX_WALK_UP {
        if dir.join(".git").exists() {
            chain.reverse();
            return chain;
        }
        if Some(dir.as_path()) == home {
            break;
        }
        match dir.parent() {
            Some(p) => {
                dir = p.to_path_buf();
                chain.push(dir.clone());
            }
            None => break,
        }
    }
    vec![cwd.to_path_buf()]
}

fn same_path(a: &Path, b: &Path) -> bool {
    a == b || matches!((a.canonicalize(), b.canonicalize()), (Ok(x), Ok(y)) if x == y)
}

/// When `cwd` is inside a git worktree, the main checkout it belongs to
/// (read from the worktree's `.git` file: `gitdir: <main>/.git/worktrees/<name>`).
/// A session on a worktree has its project attached too; that project is
/// the same repository, not another folder.
fn main_checkout_of(cwd: &Path, home: Option<&Path>) -> Option<PathBuf> {
    let root = project_chain(cwd, home).into_iter().next()?;
    let text = fs::read_to_string(root.join(".git")).ok()?;
    let gitdir = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
    let gitdir = PathBuf::from(gitdir);
    let gitdir = if gitdir.is_absolute() {
        gitdir
    } else {
        root.join(gitdir)
    };
    // <main>/.git/worktrees/<name> -> <main>
    let dot_git = gitdir.parent()?.parent()?;
    (dot_git.file_name()? == ".git").then(|| dot_git.parent().map(Path::to_path_buf))?
}

// ─── @path imports ────────────────────────────────────────────────────

/// The `@path` imports in an instruction file, in order. Imports inside
/// fenced code blocks and inline code spans do not count (Claude Code's
/// rule); `@` preceded by a word character (an e-mail address) is not one.
pub(crate) fn find_imports(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_fence = false;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        // Drop inline code spans.
        let mut visible = String::new();
        let mut in_code = false;
        for c in line.chars() {
            if c == '`' {
                in_code = !in_code;
                visible.push(' ');
            } else if !in_code {
                visible.push(c);
            } else {
                visible.push(' ');
            }
        }
        let chars: Vec<char> = visible.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            if chars[i] == '@' && (i == 0 || chars[i - 1].is_whitespace()) {
                let mut j = i + 1;
                while j < chars.len()
                    && (chars[j].is_ascii_alphanumeric() || "._-/~\\".contains(chars[j]))
                {
                    j += 1;
                }
                let mut token: String = chars[i + 1..j].iter().collect();
                while token.ends_with('.') || token.ends_with('/') {
                    token.pop();
                }
                if !token.is_empty() && (token.contains('.') || token.contains('/')) {
                    out.push(token);
                }
                i = j;
            } else {
                i += 1;
            }
        }
    }
    out
}

fn read_text(path: &Path) -> Option<String> {
    read_capped(path, MAX_READ_BYTES)
}

fn read_capped(path: &Path, max: u64) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > max {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn resolve_import(from_file: &Path, import: &str, home: Option<&Path>) -> Option<PathBuf> {
    let import = import.replace('\\', "/");
    if let Some(rest) = import.strip_prefix("~/") {
        return join_catalog_path(Path::new(""), &format!("~/{rest}"), home);
    }
    let p = Path::new(&import);
    if p.is_absolute() {
        return Some(p.to_path_buf());
    }
    let dir = from_file.parent()?;
    let mut out = dir.to_path_buf();
    for part in import.split('/').filter(|s| !s.is_empty() && *s != ".") {
        if part == ".." {
            out.pop();
        } else {
            out.push(part);
        }
    }
    Some(out)
}

// ─── Overview ─────────────────────────────────────────────────────────

struct Ctx<'a> {
    cwd: &'a Path,
    home: Option<&'a Path>,
    attached: Vec<PathBuf>,
    /// MCP config files read so far for this overview, parsed (JSON) or as
    /// text (TOML): each file is read once however many sources name it.
    mcp_files: RefCell<HashMap<PathBuf, Rc<McpFile>>>,
}

enum McpFile {
    Missing,
    Json(serde_json::Value),
    Text(String),
}

impl Ctx<'_> {
    fn mcp_file(&self, path: &Path, format: &str) -> Rc<McpFile> {
        if let Some(f) = self.mcp_files.borrow().get(path) {
            return f.clone();
        }
        let file = match read_capped(path, MAX_MCP_CONFIG_BYTES) {
            None => McpFile::Missing,
            Some(text) if format == "toml" => McpFile::Text(text),
            Some(text) => serde_json::from_str(&text).map_or(McpFile::Missing, McpFile::Json),
        };
        let file = Rc::new(file);
        self.mcp_files
            .borrow_mut()
            .insert(path.to_path_buf(), file.clone());
        file
    }
}

impl Ctx<'_> {
    fn item(&self, path: &Path, scope: &str, folder: Option<&Path>, loaded: bool) -> SetupItem {
        let mut display = display_path(path, folder, self.home);
        // An attached folder's file is shown under that folder's name.
        if scope == "attached" {
            if let Some(name) = folder.and_then(|f| f.file_name()) {
                display = format!("{}/{display}", name.to_string_lossy());
            }
        }
        SetupItem {
            path: path.to_string_lossy().to_string(),
            display,
            name: path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            scope: scope.to_string(),
            folder: folder.map(|f| f.to_string_lossy().to_string()),
            loaded,
            via: None,
        }
    }
}

fn instruction_items(agent: &Agent, ctx: &Ctx) -> Vec<SetupItem> {
    let Some(setup) = &agent.setup else {
        return Vec::new();
    };
    let ins = &setup.instructions;
    let mut items: Vec<SetupItem> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let push = |items: &mut Vec<SetupItem>, item: SetupItem, seen: &mut HashSet<PathBuf>| {
        let key = PathBuf::from(&item.path);
        let key = key.canonicalize().unwrap_or(key);
        if seen.insert(key) {
            items.push(item);
        }
    };

    for pattern in &ins.global {
        if let Some(h) = ctx.home {
            for p in expand(h, pattern, ctx.home) {
                push(&mut items, ctx.item(&p, "global", None, true), &mut seen);
            }
        }
    }
    for dir in project_chain(ctx.cwd, ctx.home) {
        for pattern in &ins.project {
            for p in expand(&dir, pattern, ctx.home) {
                push(
                    &mut items,
                    ctx.item(&p, "project", Some(ctx.cwd), true),
                    &mut seen,
                );
            }
        }
    }

    // Imports of everything loaded so far, breadth first.
    if ins.imports {
        let mut frontier: Vec<(PathBuf, String, usize)> = items
            .iter()
            .map(|i| (PathBuf::from(&i.path), i.display.clone(), 0))
            .collect();
        while let Some((file, display, depth)) = frontier.pop() {
            if depth >= MAX_IMPORT_DEPTH {
                continue;
            }
            let Some(text) = read_text(&file) else {
                continue;
            };
            for imp in find_imports(&text) {
                let Some(target) = resolve_import(&file, &imp, ctx.home) else {
                    continue;
                };
                if !target.is_file() {
                    continue;
                }
                let base = if target.starts_with(ctx.cwd) {
                    Some(ctx.cwd)
                } else {
                    None
                };
                let scope = if base.is_some() { "project" } else { "global" };
                let mut item = ctx.item(&target, scope, base, true);
                item.via = Some(display.clone());
                let before = items.len();
                push(&mut items, item, &mut seen);
                if items.len() > before {
                    let d = items[before].display.clone();
                    frontier.push((target, d, depth + 1));
                }
            }
        }
    }

    // Attached folders: listed so the user sees them, but not loaded.
    for folder in &ctx.attached {
        for pattern in &ins.project {
            for p in expand(folder, pattern, ctx.home) {
                push(
                    &mut items,
                    ctx.item(&p, "attached", Some(folder), false),
                    &mut seen,
                );
            }
        }
    }
    items
}

fn path_items(paths: &crate::agent_catalog::SetupPaths, ctx: &Ctx, skills: bool) -> Vec<SetupItem> {
    let mut out = Vec::new();
    let mut add = |base: &Path, pattern: &str, scope: &str, folder: Option<&Path>, loaded: bool| {
        for p in expand(base, pattern, ctx.home) {
            if skills {
                // A skills folder: one item per skill (a folder with SKILL.md).
                let mut names: Vec<PathBuf> = fs::read_dir(&p)
                    .map(|rd| {
                        rd.flatten()
                            .map(|e| e.path())
                            .filter(|s| s.join("SKILL.md").is_file())
                            .collect()
                    })
                    .unwrap_or_default();
                names.sort();
                for s in names {
                    out.push(ctx.item(&s, scope, folder, loaded));
                }
            } else if p.is_file() {
                out.push(ctx.item(&p, scope, folder, loaded));
            }
        }
    };
    if let Some(h) = ctx.home {
        for pattern in &paths.global {
            add(h, pattern, "global", None, true);
        }
    }
    for pattern in &paths.project {
        add(ctx.cwd, pattern, "project", Some(ctx.cwd), true);
    }
    for folder in &ctx.attached {
        for pattern in &paths.project {
            add(folder, pattern, "attached", Some(folder), false);
        }
    }
    out
}

/// Server names declared in one MCP source file. Values are never read out.
fn mcp_names(file: &McpFile, format: &str, key: &str, cwd: &Path) -> Vec<(String, bool)> {
    match (format, file) {
        ("json" | "claude_local", McpFile::Json(root)) => {
            let obj = if format == "json" {
                root.get(key)
            } else {
                let projects = root.get("projects").and_then(|p| p.as_object());
                projects.and_then(|m| {
                    let direct = cwd.to_string_lossy().to_string();
                    let canon = cwd
                        .canonicalize()
                        .map(|c| c.to_string_lossy().to_string())
                        .unwrap_or_default();
                    m.get(&direct)
                        .or_else(|| m.get(&canon))
                        .or_else(|| m.get(&direct.replace('\\', "/")))
                        .and_then(|p| p.get(key))
                })
            };
            let mut names: Vec<(String, bool)> = obj
                .and_then(|v| v.as_object())
                .map(|m| {
                    m.iter()
                        .map(|(name, spec)| {
                            let disabled = spec
                                .get("disabled")
                                .and_then(|d| d.as_bool())
                                .unwrap_or(false)
                                || spec.get("enabled").and_then(|d| d.as_bool()) == Some(false);
                            (name.clone(), !disabled)
                        })
                        .collect()
                })
                .unwrap_or_default();
            names.sort();
            names
        }
        ("toml", McpFile::Text(text)) => {
            let mut names: Vec<(String, bool)> = Vec::new();
            let prefix = format!("[{key}.");
            for line in text.lines() {
                let l = line.trim();
                let Some(rest) = l.strip_prefix(&prefix) else {
                    continue;
                };
                let Some(inner) = rest.strip_suffix(']') else {
                    continue;
                };
                let name = if let Some(q) = inner.strip_prefix('"') {
                    q.split('"').next().unwrap_or("").to_string()
                } else {
                    inner.split('.').next().unwrap_or("").to_string()
                };
                if !name.is_empty() && !names.iter().any(|(n, _)| *n == name) {
                    names.push((name, true));
                }
            }
            names
        }
        _ => Vec::new(),
    }
}

fn mcp_for(agent: &Agent, ctx: &Ctx) -> Option<AgentMcp> {
    let sources = agent.setup.as_ref()?.mcp.as_ref()?;
    let mut servers = Vec::new();
    for src in sources {
        let targets: Vec<(PathBuf, &str, bool)> = if src.scope == "global" {
            match ctx
                .home
                .and_then(|h| join_catalog_path(h, &src.path, ctx.home))
            {
                Some(p) => vec![(
                    p,
                    if src.format == "claude_local" {
                        "local"
                    } else {
                        "global"
                    },
                    true,
                )],
                None => Vec::new(),
            }
        } else {
            let mut v: Vec<(PathBuf, &str, bool)> = Vec::new();
            if let Some(p) = join_catalog_path(ctx.cwd, &src.path, ctx.home) {
                v.push((p, "project", true));
            }
            for f in &ctx.attached {
                if let Some(p) = join_catalog_path(f, &src.path, ctx.home) {
                    v.push((p, "attached", false));
                }
            }
            v
        };
        for (file, scope, loaded) in targets {
            if !file.is_file() {
                continue;
            }
            let folder: Option<&Path> = match scope {
                "project" => Some(ctx.cwd),
                "attached" => ctx
                    .attached
                    .iter()
                    .find(|a| file.starts_with(a))
                    .map(|a| a.as_path()),
                _ => None,
            };
            let mut source = display_path(&file, folder, ctx.home);
            if scope == "attached" {
                if let Some(name) = folder.and_then(|f| f.file_name()) {
                    source = format!("{}/{source}", name.to_string_lossy());
                }
            }
            let parsed = ctx.mcp_file(&file, &src.format);
            for (name, enabled) in mcp_names(&parsed, &src.format, &src.key, ctx.cwd) {
                servers.push(McpServerItem {
                    name,
                    source: source.clone(),
                    scope: scope.to_string(),
                    loaded: loaded && enabled,
                });
            }
        }
    }
    Some(AgentMcp {
        agent_id: agent.id.clone(),
        agent_name: agent.name.clone(),
        servers,
    })
}

fn link_suggestion(agent: &Agent, ctx: &Ctx, instructions: &[SetupItem]) -> Option<LinkSuggestion> {
    let setup = agent.setup.as_ref()?;
    if !setup.instructions.imports {
        return None;
    }
    let file = own_instruction_file(agent)?;
    let agents_md = ctx.cwd.join("AGENTS.md");
    if !agents_md.is_file() {
        return None;
    }
    let already = instructions
        .iter()
        .any(|i| i.loaded && Path::new(&i.path) == agents_md.as_path());
    if already {
        return None;
    }
    Some(LinkSuggestion {
        folder: ctx.cwd.to_string_lossy().to_string(),
        file,
        target: "AGENTS.md".to_string(),
    })
}

/// The agent's own instruction file name (its first project entry), when
/// that is a plain file name other than AGENTS.md.
fn own_instruction_file(agent: &Agent) -> Option<String> {
    let first = agent.setup.as_ref()?.instructions.project.first()?;
    let valid = !first.contains(['/', '|', '*', '~']) && first != "AGENTS.md";
    valid.then(|| first.clone())
}

/// The full overview, MCP servers included.
#[cfg(test)]
pub(crate) fn overview(
    agent_id: &str,
    cwd: &Path,
    attached: &[String],
    home: Option<&Path>,
) -> Result<AgentSetupOverview, String> {
    overview_with(agent_id, cwd, attached, home, true)
}

/// `include_mcp: false` leaves the MCP servers out (they are only shown in
/// the open view; the chip's background refresh does not need them).
pub(crate) fn overview_with(
    agent_id: &str,
    cwd: &Path,
    attached: &[String],
    home: Option<&Path>,
    include_mcp: bool,
) -> Result<AgentSetupOverview, String> {
    let agent =
        agent_catalog::agent(agent_id).ok_or_else(|| format!("unknown agent: {agent_id}"))?;
    if !cwd.is_absolute() {
        return Err("the working folder must be an absolute path".into());
    }
    let main_checkout = main_checkout_of(cwd, home);
    let mut attached_out: Vec<PathBuf> = Vec::new();
    for p in attached.iter().map(PathBuf::from) {
        let skip = !p.is_absolute()
            || !p.is_dir()
            || same_path(&p, cwd)
            || main_checkout.as_deref().is_some_and(|m| same_path(&p, m))
            || attached_out.iter().any(|a| same_path(a, &p));
        if !skip {
            attached_out.push(p);
        }
    }
    let attached = attached_out;
    let ctx = Ctx {
        cwd,
        home,
        attached,
        mcp_files: RefCell::new(HashMap::new()),
    };
    let instructions = instruction_items(agent, &ctx);
    let (settings, skills) = match &agent.setup {
        Some(s) => (
            path_items(&s.settings, &ctx, false),
            path_items(&s.skills, &ctx, true),
        ),
        None => (Vec::new(), Vec::new()),
    };
    let mut mcp: Vec<AgentMcp> = Vec::new();
    if let Some(m) = mcp_for(agent, &ctx).filter(|_| include_mcp) {
        mcp.push(m);
    }
    for other in &agent_catalog::catalog().agents {
        if include_mcp && other.id != agent.id {
            if let Some(m) = mcp_for(other, &ctx) {
                mcp.push(m);
            }
        }
    }
    let link = link_suggestion(agent, &ctx, &instructions);
    Ok(AgentSetupOverview {
        agent_id: agent.id.clone(),
        agent_name: agent.name.clone(),
        known: agent.setup.is_some(),
        instructions,
        settings,
        skills,
        mcp,
        link,
    })
}

/// Adds `@AGENTS.md` to the agent's own instruction file in `folder`
/// (creating the file when missing). Returns `created`, `updated` or
/// `already`.
pub(crate) fn link(agent_id: &str, folder: &Path) -> Result<&'static str, String> {
    let agent =
        agent_catalog::agent(agent_id).ok_or_else(|| format!("unknown agent: {agent_id}"))?;
    if !agent.setup.as_ref().is_some_and(|s| s.instructions.imports) {
        return Err(format!("{} does not follow @imports", agent.name));
    }
    let file = own_instruction_file(agent).ok_or("this agent has no instruction file to link")?;
    if !folder.is_absolute() || !folder.is_dir() {
        return Err("the folder must be an existing absolute path".into());
    }
    if !folder.join("AGENTS.md").is_file() {
        return Err("there is no AGENTS.md in this folder".into());
    }
    let link_path = folder.join(&file);
    // A symlinked instruction file is written through to its target, so the
    // link stays a link.
    let path = match fs::symlink_metadata(&link_path) {
        Ok(m) if m.file_type().is_symlink() => fs::canonicalize(&link_path)
            .map_err(|e| format!("{file} links to a file that cannot be read: {e}"))?,
        _ => link_path,
    };
    let existing = if path.exists() {
        Some(fs::read_to_string(&path).map_err(|e| format!("read {file}: {e}"))?)
    } else {
        None
    };
    if let Some(text) = &existing {
        if find_imports(text)
            .iter()
            .any(|i| i == "AGENTS.md" || i == "./AGENTS.md")
        {
            return Ok("already");
        }
    }
    let content = match &existing {
        Some(text) => format!("@AGENTS.md\n\n{text}"),
        None => "@AGENTS.md\n".to_string(),
    };
    let dir = path.parent().unwrap_or(folder);
    let tmp = dir.join(format!(".{file}.hermes-tmp"));
    fs::write(&tmp, content).map_err(|e| format!("write {file}: {e}"))?;
    // Keep the file's permissions (the temporary file got the defaults).
    if let Ok(meta) = fs::metadata(&path) {
        if let Err(e) = fs::set_permissions(&tmp, meta.permissions()) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("write {file}: {e}"));
        }
    }
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("write {file}: {e}")
    })?;
    Ok(if existing.is_some() {
        "updated"
    } else {
        "created"
    })
}

// ─── Tauri commands ───────────────────────────────────────────────────

#[tauri::command]
pub async fn agent_setup_overview(
    agent_id: String,
    cwd: String,
    attached: Vec<String>,
    include_mcp: Option<bool>,
) -> Result<AgentSetupOverview, String> {
    tokio::task::spawn_blocking(move || {
        overview_with(
            &agent_id,
            Path::new(&cwd),
            &attached,
            home().as_deref(),
            include_mcp.unwrap_or(true),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn link_instructions_to_agents_md(agent_id: String, folder: String) -> Result<String, String> {
    link(&agent_id, Path::new(&folder)).map(str::to_string)
}

/// The command lines of the catalog agents running under a session's shell,
/// each starting at the agent's command (`claude --permission-mode plan`).
/// Other processes are never returned: command lines can carry secrets.
#[tauri::command]
pub async fn session_process_argv(
    state: tauri::State<'_, crate::AppState>,
    session_id: String,
) -> Result<Vec<Vec<String>>, String> {
    let shell_pid = {
        let mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
        let session = mgr
            .sessions
            .get(&session_id)
            .ok_or_else(|| format!("Session {session_id} not found"))?;
        session
            .transport
            .pid()
            .ok_or_else(|| "Shell process ID not available".to_string())?
    };
    let mut sys = state.sys.lock().unwrap_or_else(|e| e.into_inner());
    let commands = agent_commands();
    Ok(descendant_argv(&mut sys, shell_pid)
        .iter()
        .filter_map(|argv| agent_command_line(argv, commands))
        .collect())
}

/// The command names of the catalog's agents (`claude`, `codex`, `kiro-cli`).
fn agent_commands() -> &'static HashSet<String> {
    static COMMANDS: std::sync::OnceLock<HashSet<String>> = std::sync::OnceLock::new();
    COMMANDS.get_or_init(|| {
        agent_catalog::catalog()
            .agents
            .iter()
            .filter(|a| !a.custom)
            .filter_map(|a| a.terminal.argv.first())
            .map(|c| c.to_ascii_lowercase())
            .collect()
    })
}

/// `/usr/local/bin/Claude.EXE` -> `claude`.
fn command_name(token: &str) -> String {
    let base = token.rsplit(['/', '\\']).next().unwrap_or(token);
    let lower = base.to_ascii_lowercase();
    for ext in [".exe", ".cmd", ".bat", ".ps1", ".js", ".mjs", ".cjs"] {
        if let Some(stem) = lower.strip_suffix(ext) {
            return stem.to_string();
        }
    }
    lower
}

/// Programs that run the program named by their first non-option argument:
/// script runners (an npm-installed agent runs as `node .../bin/claude`) and
/// launch wrappers (`caffeinate -i claude`, `env A=1 codex`, `cmd /c
/// codex.cmd`).
const WRAPPERS: &[&str] = &[
    "node",
    "nodejs",
    "bun",
    "deno",
    "python",
    "python3",
    "env",
    "caffeinate",
    "nohup",
    "time",
    "cmd",
];

/// The part of a command line that runs a catalog agent, from the agent's
/// command on. An agent counts only as the program itself or as the program
/// a known wrapper runs, never as a later argument: `cat claude`, `git log
/// --grep goose` and `tail -f codex` are not agents.
pub(crate) fn agent_command_line(
    argv: &[String],
    commands: &HashSet<String>,
) -> Option<Vec<String>> {
    agent_command_line_at(argv, commands, 0)
}

fn agent_command_line_at(
    argv: &[String],
    commands: &HashSet<String>,
    depth: usize,
) -> Option<Vec<String>> {
    if depth > 4 {
        return None;
    }
    let name = command_name(argv.first()?);
    if commands.contains(&name) {
        return Some(argv.to_vec());
    }
    if !WRAPPERS.contains(&name.as_str()) {
        return None;
    }
    let mut j = 1;
    while let Some(t) = argv.get(j) {
        let skip = t.starts_with('-')
            || (name == "cmd" && t.starts_with('/'))
            || (name == "env" && t.contains('='))
            || (name == "deno" && t == "run");
        if !skip {
            break;
        }
        j += 1;
    }
    let program = argv.get(j)?;
    // `cmd /c "codex.cmd --yolo"` can arrive as one argument.
    if name == "cmd" && program.contains(char::is_whitespace) {
        let mut split: Vec<String> = program
            .split_whitespace()
            .map(|w| w.trim_matches('"').to_string())
            .filter(|w| !w.is_empty())
            .collect();
        split.extend(argv[j + 1..].iter().cloned());
        return agent_command_line_at(&split, commands, depth + 1);
    }
    agent_command_line_at(&argv[j..], commands, depth + 1)
}

/// One process as far as the parent walk needs it.
struct ProcInfo {
    pid: u32,
    parent: Option<u32>,
    start_time: u64,
    name: String,
}

/// The children of `parent` (started `parent_started`), sorted by pid.
/// Windows reuses process ids and keeps an orphan's old parent id: a process
/// that started before its "parent" is not its child. The console host
/// Windows starts for a console program is not one either.
fn children_of(procs: &[ProcInfo], parent: u32, parent_started: u64) -> Vec<u32> {
    let mut out: Vec<u32> = procs
        .iter()
        .filter(|p| p.parent == Some(parent) && p.start_time >= parent_started)
        .filter(|p| {
            let name = p.name.to_ascii_lowercase();
            name != "conhost.exe" && name != "openconsole.exe"
        })
        .map(|p| p.pid)
        .collect();
    out.sort_unstable();
    out
}

/// A full process-table refresh is skipped when one ran this recently: every
/// terminal pane polls, and they share one table.
const FULL_REFRESH_EVERY: std::time::Duration = std::time::Duration::from_millis(1_000);

fn descendant_argv(sys: &mut sysinfo::System, root: u32) -> Vec<Vec<String>> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, UpdateKind};
    static LAST_FULL: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
    // Every process's parent first (cheap, and shared by all panes), then
    // command lines only for the shell's descendants.
    {
        let mut last = LAST_FULL.lock().unwrap_or_else(|e| e.into_inner());
        if sys.processes().is_empty() || last.is_none_or(|t| t.elapsed() >= FULL_REFRESH_EVERY) {
            sys.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing(),
            );
            *last = Some(std::time::Instant::now());
        }
    }
    let procs: Vec<ProcInfo> = sys
        .processes()
        .iter()
        .map(|(pid, p)| ProcInfo {
            pid: pid.as_u32(),
            parent: p.parent().map(|pp| pp.as_u32()),
            start_time: p.start_time(),
            name: p.name().to_string_lossy().to_string(),
        })
        .collect();
    let started = |pid: u32| {
        procs
            .iter()
            .find(|p| p.pid == pid)
            .map_or(0, |p| p.start_time)
    };
    let mut pids: Vec<Pid> = Vec::new();
    let mut frontier = vec![root];
    let mut seen: HashSet<u32> = HashSet::from([root]);
    while let Some(parent) = frontier.pop() {
        for pid in children_of(&procs, parent, started(parent)) {
            if seen.insert(pid) {
                pids.push(Pid::from_u32(pid));
                frontier.push(pid);
            }
        }
    }
    if pids.is_empty() {
        return Vec::new();
    }
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        false,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
    );
    pids.iter()
        .filter_map(|pid| sys.process(*pid))
        .map(|p| {
            p.cmd()
                .iter()
                .map(|s| s.to_string_lossy().to_string())
                .collect::<Vec<String>>()
        })
        .filter(|argv| !argv.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    struct Tree {
        _dir: tempfile::TempDir,
        home: PathBuf,
        project: PathBuf,
    }

    fn tree() -> Tree {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let home = root.join("home");
        let project = root.join("work").join("app");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(project.join(".git")).unwrap();
        Tree {
            _dir: dir,
            home,
            project,
        }
    }

    fn names(items: &[SetupItem]) -> Vec<String> {
        items.iter().map(|i| i.display.clone()).collect()
    }

    #[test]
    fn imports_ignore_code_emails_and_plain_words() {
        let text = "See @AGENTS.md and @docs/rules.md.\nmail me@example.com\n`@not-this.md`\n```\n@fenced.md\n```\n@~/global.md\n@team";
        assert_eq!(
            find_imports(text),
            vec!["AGENTS.md", "docs/rules.md", "~/global.md"]
        );
    }

    #[test]
    fn codex_lists_agents_md_and_claude_lists_claude_md() {
        let t = tree();
        write(&t.project.join("AGENTS.md"), "# rules\n");
        write(&t.project.join("CLAUDE.md"), "# claude only\n");
        let codex = overview("codex", &t.project, &[], Some(&t.home)).unwrap();
        assert_eq!(names(&codex.instructions), vec!["AGENTS.md"]);
        let claude = overview("claude", &t.project, &[], Some(&t.home)).unwrap();
        assert_eq!(names(&claude.instructions), vec!["CLAUDE.md"]);
        // AGENTS.md exists but Claude does not load it: offer the link.
        let link = claude.link.expect("a link suggestion");
        assert_eq!(link.file, "CLAUDE.md");
        assert_eq!(Path::new(&link.folder), t.project.as_path());
        // Codex loads AGENTS.md natively: nothing to link.
        assert!(codex.link.is_none());
    }

    #[test]
    fn codex_override_wins_and_the_repo_root_is_walked() {
        let t = tree();
        let sub = t.project.join("pkg");
        write(&t.project.join("AGENTS.md"), "root\n");
        write(&sub.join("AGENTS.md"), "pkg\n");
        write(&sub.join("AGENTS.override.md"), "override\n");
        write(&t.home.join(".codex").join("AGENTS.md"), "global\n");
        let o = overview("codex", &sub, &[], Some(&t.home)).unwrap();
        let shown: Vec<(String, String)> = o
            .instructions
            .iter()
            .map(|i| (i.scope.clone(), i.path.clone()))
            .collect();
        assert_eq!(
            shown,
            vec![
                (
                    "global".into(),
                    t.home
                        .join(".codex/AGENTS.md")
                        .to_string_lossy()
                        .to_string()
                ),
                (
                    "project".into(),
                    t.project.join("AGENTS.md").to_string_lossy().to_string()
                ),
                (
                    "project".into(),
                    sub.join("AGENTS.override.md").to_string_lossy().to_string()
                ),
            ]
        );
    }

    #[test]
    fn linking_makes_claude_load_agents_md_and_is_idempotent() {
        let t = tree();
        write(&t.project.join("AGENTS.md"), "# rules\n");
        // No CLAUDE.md yet.
        let before = overview("claude", &t.project, &[], Some(&t.home)).unwrap();
        assert!(before.instructions.is_empty());
        assert!(before.link.is_some());

        assert_eq!(link("claude", &t.project).unwrap(), "created");
        assert_eq!(
            fs::read_to_string(t.project.join("CLAUDE.md")).unwrap(),
            "@AGENTS.md\n"
        );
        let after = overview("claude", &t.project, &[], Some(&t.home)).unwrap();
        assert_eq!(names(&after.instructions), vec!["CLAUDE.md", "AGENTS.md"]);
        assert_eq!(after.instructions[1].via.as_deref(), Some("CLAUDE.md"));
        assert!(after.link.is_none());

        assert_eq!(link("claude", &t.project).unwrap(), "already");
        assert_eq!(
            fs::read_to_string(t.project.join("CLAUDE.md")).unwrap(),
            "@AGENTS.md\n"
        );
    }

    #[test]
    fn linking_keeps_an_existing_claude_md() {
        let t = tree();
        write(&t.project.join("AGENTS.md"), "# rules\n");
        write(&t.project.join("CLAUDE.md"), "# mine\nkeep me\n");
        assert_eq!(link("claude", &t.project).unwrap(), "updated");
        assert_eq!(
            fs::read_to_string(t.project.join("CLAUDE.md")).unwrap(),
            "@AGENTS.md\n\n# mine\nkeep me\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn linking_keeps_a_symlinked_claude_md_a_link_and_keeps_its_mode() {
        use std::os::unix::fs::PermissionsExt;
        let t = tree();
        write(&t.project.join("AGENTS.md"), "# Rules\n");
        let shared = t.home.join("shared-claude.md");
        write(&shared, "# Shared\n");
        fs::set_permissions(&shared, fs::Permissions::from_mode(0o640)).unwrap();
        std::os::unix::fs::symlink(&shared, t.project.join("CLAUDE.md")).unwrap();

        assert_eq!(link("claude", &t.project).unwrap(), "updated");
        let meta = fs::symlink_metadata(t.project.join("CLAUDE.md")).unwrap();
        assert!(meta.file_type().is_symlink(), "CLAUDE.md is still a link");
        assert_eq!(
            fs::read_to_string(&shared).unwrap(),
            "@AGENTS.md\n\n# Shared\n"
        );
        assert_eq!(
            fs::metadata(&shared).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }

    #[cfg(unix)]
    #[test]
    fn linking_refuses_a_dangling_claude_md_link() {
        let t = tree();
        write(&t.project.join("AGENTS.md"), "# Rules\n");
        std::os::unix::fs::symlink(t.home.join("gone.md"), t.project.join("CLAUDE.md")).unwrap();
        assert!(link("claude", &t.project).is_err());
        assert!(fs::symlink_metadata(t.project.join("CLAUDE.md"))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn linking_refuses_without_agents_md_or_for_agents_without_imports() {
        let t = tree();
        assert!(link("claude", &t.project).is_err());
        write(&t.project.join("AGENTS.md"), "x\n");
        assert!(link("codex", &t.project).is_err());
        assert!(!t.project.join("CLAUDE.md").exists());
    }

    #[test]
    fn attached_folders_are_listed_but_not_loaded() {
        let t = tree();
        let other = t.home.join("shared-lib");
        write(&other.join("CLAUDE.md"), "shared\n");
        write(&other.join(".claude/settings.json"), "{}");
        write(
            &other.join(".claude/skills/deploy/SKILL.md"),
            "---\nname: deploy\n---\n",
        );
        write(
            &other.join(".mcp.json"),
            r#"{"mcpServers":{"lib-db":{"command":"x","env":{"TOKEN":"secret"}}}}"#,
        );
        let o = overview(
            "claude",
            &t.project,
            &[
                other.to_string_lossy().to_string(),
                t.project.to_string_lossy().to_string(),
            ],
            Some(&t.home),
        )
        .unwrap();
        let attached: Vec<(&str, bool)> = o
            .instructions
            .iter()
            .map(|i| (i.scope.as_str(), i.loaded))
            .collect();
        assert_eq!(attached, vec![("attached", false)]);
        assert_eq!(o.instructions[0].display, "shared-lib/CLAUDE.md");
        assert_eq!(o.settings.len(), 1);
        assert!(!o.settings[0].loaded);
        assert_eq!(o.skills.len(), 1);
        assert_eq!(o.skills[0].name, "deploy");
        let claude = &o.mcp[0];
        assert_eq!(claude.agent_id, "claude");
        assert_eq!(claude.servers.len(), 1);
        assert_eq!(claude.servers[0].name, "lib-db");
        assert!(!claude.servers[0].loaded);
        // Values never leave the backend.
        let json = serde_json::to_string(&o).unwrap();
        assert!(!json.contains("secret"));
    }

    #[test]
    fn a_worktrees_own_project_is_not_an_attached_folder() {
        let t = tree();
        write(&t.project.join("CLAUDE.md"), "main\n");
        let wt = t.home.join("worktrees").join("task-a");
        write(
            &wt.join(".git"),
            &format!(
                "gitdir: {}\n",
                t.project.join(".git/worktrees/task-a").display()
            ),
        );
        write(&wt.join("CLAUDE.md"), "worktree\n");
        let o = overview(
            "claude",
            &wt,
            &[t.project.to_string_lossy().to_string()],
            Some(&t.home),
        )
        .unwrap();
        let scopes: Vec<&str> = o.instructions.iter().map(|i| i.scope.as_str()).collect();
        assert_eq!(scopes, vec!["project"], "{:?}", o.instructions);
    }

    #[test]
    fn mcp_view_lists_what_each_agent_sees() {
        let t = tree();
        write(
            &t.project.join(".mcp.json"),
            r#"{"mcpServers":{"proj-a":{},"proj-b":{"disabled":true}}}"#,
        );
        let project_key = t.project.to_string_lossy().to_string();
        write(
            &t.home.join(".claude.json"),
            &serde_json::json!({
                "mcpServers": {"user-wide": {"command": "npx"}},
                "projects": {project_key: {"mcpServers": {"local-only": {}}}}
            })
            .to_string(),
        );
        write(
            &t.home.join(".codex/config.toml"),
            "model = \"x\"\n[mcp_servers.docs]\ncommand = \"d\"\n[mcp_servers.docs.env]\nK = \"v\"\n[mcp_servers.\"my.server\"]\n",
        );
        let o = overview("codex", &t.project, &[], Some(&t.home)).unwrap();
        assert_eq!(
            o.mcp[0].agent_id, "codex",
            "this session's agent comes first"
        );
        let codex: Vec<&str> = o.mcp[0].servers.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(codex, vec!["docs", "my.server"]);
        let claude = o.mcp.iter().find(|m| m.agent_id == "claude").unwrap();
        let got: Vec<(&str, &str, bool)> = claude
            .servers
            .iter()
            .map(|s| (s.name.as_str(), s.scope.as_str(), s.loaded))
            .collect();
        assert_eq!(
            got,
            vec![
                ("proj-a", "project", true),
                ("proj-b", "project", false),
                ("user-wide", "global", true),
                ("local-only", "local", true),
            ]
        );
        // The chip's background refresh leaves the MCP servers out.
        let quick = overview_with("codex", &t.project, &[], Some(&t.home), false).unwrap();
        assert!(quick.mcp.is_empty());
        assert_eq!(quick.instructions, o.instructions);
    }

    #[test]
    fn a_large_user_config_is_read_up_to_its_cap_only() {
        let t = tree();
        let claude_servers = |o: &AgentSetupOverview| -> Vec<String> {
            o.mcp
                .iter()
                .find(|m| m.agent_id == "claude")
                .unwrap()
                .servers
                .iter()
                .map(|s| s.name.clone())
                .collect()
        };
        // Past the instruction-file cap (history makes it big): still read.
        let pad = "x".repeat(MAX_READ_BYTES as usize + 1);
        let big = serde_json::json!({"mcpServers": {"user-wide": {}}, "pad": pad}).to_string();
        write(&t.home.join(".claude.json"), &big);
        let o = overview("claude", &t.project, &[], Some(&t.home)).unwrap();
        assert_eq!(claude_servers(&o), vec!["user-wide"]);
        // Past the MCP config cap: not read at all.
        let pad = "x".repeat(MAX_MCP_CONFIG_BYTES as usize + 1);
        let huge = serde_json::json!({"mcpServers": {"user-wide": {}}, "pad": pad}).to_string();
        write(&t.home.join(".claude.json"), &huge);
        let o = overview("claude", &t.project, &[], Some(&t.home)).unwrap();
        assert!(claude_servers(&o).is_empty());
    }

    #[test]
    fn overview_never_writes() {
        let t = tree();
        write(&t.project.join("AGENTS.md"), "x\n");
        write(&t.home.join(".claude.json"), "{}");
        let before: Vec<_> = walk(&t.home).into_iter().chain(walk(&t.project)).collect();
        for id in [
            "claude", "codex", "gemini", "copilot", "opencode", "goose", "kiro", "custom",
        ] {
            overview(id, &t.project, &[], Some(&t.home)).unwrap();
        }
        let after: Vec<_> = walk(&t.home).into_iter().chain(walk(&t.project)).collect();
        assert_eq!(before, after);
    }

    fn walk(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut out = Vec::new();
        for e in fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                out.extend(walk(&p));
            } else {
                out.push((p.clone(), fs::read(&p).unwrap()));
            }
        }
        out.sort();
        out
    }

    #[test]
    fn unknown_agents_and_relative_folders_are_refused() {
        let t = tree();
        assert!(overview("nope", &t.project, &[], Some(&t.home)).is_err());
        assert!(overview("claude", Path::new("relative"), &[], Some(&t.home)).is_err());
    }

    fn line(words: &[&str]) -> Vec<String> {
        words.iter().map(|w| w.to_string()).collect()
    }

    fn agent_line(words: &[&str]) -> Option<Vec<String>> {
        agent_command_line(&line(words), agent_commands())
    }

    #[test]
    fn an_agent_is_found_as_the_program_or_behind_a_wrapper() {
        let want = Some(line(&["claude", "--dangerously-skip-permissions"]));
        assert_eq!(
            agent_line(&["claude", "--dangerously-skip-permissions"]),
            want
        );
        assert_eq!(
            agent_line(&["/opt/tools/bin/claude", "-p"]),
            Some(line(&["/opt/tools/bin/claude", "-p"]))
        );
        // npm-installed agents run as `node <script named after the agent>`.
        assert_eq!(
            agent_line(&[
                "/usr/bin/node",
                "--no-warnings",
                "/usr/lib/bin/codex.js",
                "--yolo"
            ]),
            Some(line(&["/usr/lib/bin/codex.js", "--yolo"]))
        );
        assert_eq!(
            agent_line(&[
                "caffeinate",
                "-i",
                "claude",
                "--dangerously-skip-permissions"
            ]),
            want
        );
        assert_eq!(
            agent_line(&["env", "FOO=1", "claude", "--dangerously-skip-permissions"]),
            want
        );
        assert_eq!(
            agent_line(&[
                "C:\\Windows\\system32\\cmd.exe",
                "/d",
                "/c",
                "D:\\npm\\codex.cmd",
                "-s",
                "danger-full-access"
            ]),
            Some(line(&["D:\\npm\\codex.cmd", "-s", "danger-full-access"]))
        );
        // cmd can get the whole command as one argument.
        assert_eq!(
            agent_line(&["cmd.exe", "/s", "/c", "\"codex.cmd --yolo\""]),
            Some(line(&["codex.cmd", "--yolo"]))
        );
        assert_eq!(
            agent_line(&["kiro-cli", "chat", "--trust-all-tools"]),
            Some(line(&["kiro-cli", "chat", "--trust-all-tools"]))
        );
    }

    #[test]
    fn an_agent_name_as_a_later_argument_is_not_an_agent() {
        for words in [
            &["cat", "claude"][..],
            &["git", "log", "--grep", "goose"],
            &["tail", "-f", "codex"],
            &["vim", "opencode"],
            &["node", "/tmp/tool.mjs", "claude"],
            &["-zsh"],
            &[],
        ] {
            assert_eq!(agent_line(words), None, "{words:?}");
        }
    }

    fn proc(pid: u32, parent: u32, start_time: u64, name: &str) -> ProcInfo {
        ProcInfo {
            pid,
            parent: Some(parent),
            start_time,
            name: name.to_string(),
        }
    }

    #[test]
    fn a_reused_parent_id_and_the_console_host_are_not_children() {
        let procs = vec![
            proc(10, 1, 100, "pwsh.exe"),
            proc(11, 10, 105, "node.exe"),
            // Windows: the console host started for the shell.
            proc(12, 10, 101, "conhost.exe"),
            proc(13, 10, 102, "OpenConsole.exe"),
            // An orphan whose dead parent had id 10 before the shell did.
            proc(14, 10, 50, "stale.exe"),
            proc(9, 10, 100, "same-second.exe"),
        ];
        assert_eq!(children_of(&procs, 10, 100), vec![9, 11]);
        assert_eq!(children_of(&procs, 11, 105), Vec::<u32>::new());
    }

    #[test]
    fn a_session_shells_children_are_read_with_their_arguments() {
        // Spawns a real child of this test process and reads it back.
        let mut child = std::process::Command::new(if cfg!(windows) { "cmd" } else { "sleep" })
            .args(if cfg!(windows) {
                vec!["/C", "ping", "-n", "5", "127.0.0.1"]
            } else {
                vec!["5"]
            })
            .spawn()
            .unwrap();
        let mut sys = sysinfo::System::new();
        let argvs = descendant_argv(&mut sys, std::process::id());
        let _ = child.kill();
        let _ = child.wait();
        let want = if cfg!(windows) { "ping" } else { "5" };
        assert!(
            argvs.iter().any(|a| a.iter().any(|t| t == want)),
            "the child's argv was not found: {argvs:?}"
        );
    }
}
