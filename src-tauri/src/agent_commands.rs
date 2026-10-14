//! The person's own commands for an agent: the Commands list's "Your
//! commands" section.
//!
//! Read from the folders the agent catalog names for each agent
//! (`setup.custom_commands`, `setup.skills` with `setup.skill_invoke`), in
//! the session's project and in the home folder, the way the agent itself
//! finds them:
//!
//! - markdown commands (Claude Code `.claude/commands`, OpenCode
//!   `.opencode/commands`): `name.md` is `/name`, a sub-folder adds a
//!   namespace (`frontend/component.md` is `/frontend:component`), the
//!   frontmatter `description` (else the first non-empty line) describes it;
//! - TOML commands (Gemini CLI `.gemini/commands`): `git/commit.toml` is
//!   `/git:commit`, described by its `description` key;
//! - skills (`<folder>/<skill>/SKILL.md`): invoked as `/name` (Claude Code,
//!   Copilot CLI) or `$name` (Codex), the frontmatter `name` or the folder's
//!   name; a skill with `user-invocable: false` is left out.
//!
//! Only names, descriptions and argument hints leave this module; a file's
//! body is never read past its first lines. A project command wins over a
//! home one with the same name, as in the agents.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::agent_catalog::{self, CustomCommandDir};

/// How deep sub-folders are followed (namespaces), and how many entries a
/// folder may add: a home folder with a huge tree must not stall the list.
const MAX_DEPTH: usize = 4;
const MAX_ENTRIES: usize = 400;
/// The most of a file read for its frontmatter or description.
const HEAD_BYTES: u64 = 8 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredCommand {
    /// What is typed at the prompt ("/frontend:component", "$review").
    pub invocation: String,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
    /// "command" or "skill".
    pub kind: &'static str,
    /// "project" or "user".
    pub scope: &'static str,
    /// The file it was read from (to tell Library installs apart).
    pub path: String,
}

/// The `key: value` pairs of a `---` frontmatter block, keys lowercased;
/// values unquoted. Anything that is not a plain one-line pair is skipped.
pub(crate) fn frontmatter(text: &str) -> (BTreeMap<String, String>, &str) {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut map = BTreeMap::new();
    let Some(first_nl) = text.find('\n') else {
        return (map, text);
    };
    if text[..first_nl].trim() != "---" {
        return (map, text);
    }
    let mut pos = first_nl + 1;
    while pos < text.len() {
        let end = text[pos..].find('\n').map_or(text.len(), |i| pos + i);
        let line = &text[pos..end];
        if line.trim() == "---" {
            return (map, &text[(end + 1).min(text.len())..]);
        }
        if let Some((key, value)) = line.split_once(':') {
            // Nested values (indented keys) are skipped.
            if !key.starts_with(' ') && !key.starts_with('\t') {
                let value = unquote(value.trim());
                if !value.is_empty() {
                    map.insert(key.trim().to_ascii_lowercase(), value);
                }
            }
        }
        pos = end + 1;
    }
    // An unterminated block: no frontmatter.
    (BTreeMap::new(), text)
}

fn unquote(v: &str) -> String {
    let bytes = v.as_bytes();
    if v.len() >= 2
        && ((bytes[0] == b'"' && bytes[v.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[v.len() - 1] == b'\''))
    {
        return v[1..v.len() - 1].replace("\\\"", "\"").replace("''", "'");
    }
    v.to_string()
}

/// One line of plain text for a list row: whitespace collapsed, at most 160
/// characters, markdown heading marks dropped.
fn one_line(s: &str) -> Option<String> {
    let s = s.trim().trim_start_matches('#').trim();
    if s.is_empty() || s.chars().all(|c| c == '-') {
        return None;
    }
    let collapsed: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(if collapsed.chars().count() > 160 {
        let cut: String = collapsed.chars().take(159).collect();
        format!("{cut}…")
    } else {
        collapsed
    })
}

/// Description and argument hint of a markdown command or skill file.
pub(crate) fn markdown_meta(
    text: &str,
) -> (Option<String>, Option<String>, BTreeMap<String, String>) {
    let (fm, body) = frontmatter(text);
    let description = fm
        .get("description")
        .and_then(|d| one_line(d))
        .or_else(|| body.lines().find_map(one_line));
    let hint = fm.get("argument-hint").and_then(|h| one_line(h));
    (description, hint, fm)
}

/// The `description` of a Gemini CLI command file: a basic ("…"), literal
/// ('…') or multi-line ("""…""") TOML string at the top level.
pub(crate) fn toml_description(text: &str) -> Option<String> {
    let mut in_table = false;
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        let t = line.trim();
        if t.starts_with('[') {
            in_table = true;
        }
        if in_table {
            continue;
        }
        let Some(rest) = t.strip_prefix("description") else {
            continue;
        };
        let Some(value) = rest.trim_start().strip_prefix('=') else {
            continue;
        };
        let value = value.trim();
        for quote in ["\"\"\"", "'''"] {
            if let Some(start) = value.strip_prefix(quote) {
                let mut buf = start.to_string();
                while !buf.contains(quote) {
                    let Some(next) = lines.next() else {
                        break;
                    };
                    buf.push('\n');
                    buf.push_str(next);
                }
                let inner = buf.split(quote).next().unwrap_or("");
                return one_line(inner);
            }
        }
        if let Some(inner) = value.strip_prefix('"') {
            let mut out = String::new();
            let mut chars = inner.chars();
            while let Some(c) = chars.next() {
                match c {
                    '"' => return one_line(&out),
                    '\\' => match chars.next() {
                        Some('n') | Some('t') => out.push(' '),
                        Some(other) => out.push(other),
                        None => break,
                    },
                    _ => out.push(c),
                }
            }
            return None;
        }
        if let Some(inner) = value.strip_prefix('\'') {
            return inner.split('\'').next().and_then(one_line);
        }
    }
    None
}

fn read_head(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut buf = Vec::new();
    file.take(HEAD_BYTES).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// A name part a person can type: letters, digits, `-`, `_`, `.`.
fn typable(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Commands in one folder (and its sub-folders when namespaced).
fn scan_commands(
    dir: &Path,
    spec: &CustomCommandDir,
    scope: &'static str,
    out: &mut Vec<DiscoveredCommand>,
) {
    let ext = if spec.format == "toml" { "toml" } else { "md" };
    let mut stack = vec![(dir.to_path_buf(), Vec::<String>::new())];
    let mut added = 0;
    while let Some((folder, ns)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&folder) else {
            continue;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            if added >= MAX_ENTRIES {
                return;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if spec.namespaces && ns.len() + 1 < MAX_DEPTH && typable(&name) {
                    let mut next = ns.clone();
                    next.push(name);
                    stack.push((path, next));
                }
                continue;
            }
            let Some(stem) = name.strip_suffix(&format!(".{ext}")) else {
                continue;
            };
            if !typable(stem) {
                continue;
            }
            let Some(text) = read_head(&path) else {
                continue;
            };
            let (description, argument_hint) = if ext == "toml" {
                (toml_description(&text), None)
            } else {
                let (d, h, _) = markdown_meta(&text);
                (d, h)
            };
            let mut parts = ns.clone();
            parts.push(stem.to_string());
            out.push(DiscoveredCommand {
                invocation: format!("/{}", parts.join(":")),
                description,
                argument_hint,
                kind: "command",
                scope,
                path: path.to_string_lossy().into_owned(),
            });
            added += 1;
        }
    }
}

/// Skills in one folder: `<skill>/SKILL.md`.
fn scan_skills(dir: &Path, prefix: &str, scope: &'static str, out: &mut Vec<DiscoveredCommand>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries.into_iter().take(MAX_ENTRIES) {
        let folder = entry.file_name().to_string_lossy().into_owned();
        if folder.starts_with('.') || !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let file = entry.path().join("SKILL.md");
        let Some(text) = read_head(&file) else {
            continue;
        };
        let (description, argument_hint, fm) = markdown_meta(&text);
        if fm
            .get("user-invocable")
            .is_some_and(|v| v.eq_ignore_ascii_case("false"))
        {
            continue;
        }
        let name = fm
            .get("name")
            .filter(|n| typable(n))
            .cloned()
            .unwrap_or(folder);
        if !typable(&name) {
            continue;
        }
        out.push(DiscoveredCommand {
            invocation: format!("{prefix}{name}"),
            description,
            argument_hint,
            kind: "skill",
            scope,
            path: file.to_string_lossy().into_owned(),
        });
    }
}

/// `~/x` against `home`; a relative path against `project`; None when that
/// root is missing or the path tries to leave it.
fn resolve(path: &str, project: Option<&Path>, home: Option<&Path>) -> Option<PathBuf> {
    if path.split('/').any(|p| p == "..") {
        return None;
    }
    match path.strip_prefix("~/") {
        Some(rest) => home.map(|h| h.join(rest)),
        None => project.map(|p| p.join(path)),
    }
}

/// Every command the person has for `agent_id`, project ones first (they
/// win on a name clash), each group sorted by invocation.
pub(crate) fn discover(
    agent_id: &str,
    project: Option<&Path>,
    home: Option<&Path>,
) -> Vec<DiscoveredCommand> {
    let Some(setup) = agent_catalog::agent(agent_id).and_then(|a| a.setup.as_ref()) else {
        return Vec::new();
    };
    let mut found: Vec<DiscoveredCommand> = Vec::new();
    for (scope_name, scope) in [("project", "project"), ("global", "user")] {
        let mut group = Vec::new();
        for spec in setup
            .custom_commands
            .iter()
            .filter(|c| c.scope == scope_name)
        {
            if let Some(dir) = resolve(&spec.path, project, home) {
                scan_commands(&dir, spec, scope, &mut group);
            }
        }
        if let Some(prefix) = setup.skill_invoke.as_deref() {
            let dirs = if scope_name == "project" {
                &setup.skills.project
            } else {
                &setup.skills.global
            };
            for d in dirs {
                let path = if scope_name == "global" && !d.starts_with("~/") {
                    format!("~/{d}")
                } else {
                    d.clone()
                };
                if let Some(dir) = resolve(&path, project, home) {
                    scan_skills(&dir, prefix, scope, &mut group);
                }
            }
        }
        group.sort_by(|a, b| a.invocation.cmp(&b.invocation));
        for c in group {
            if !found.iter().any(|f| f.invocation == c.invocation) {
                found.push(c);
            }
        }
    }
    found
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
        .or_else(crate::platform::home_dir)
}

/// The Commands list's "Your commands" for an agent in a project folder.
/// `cwd` must be an absolute path; anything else reads only the home folder.
#[tauri::command]
pub async fn discover_agent_commands(
    agent_id: String,
    cwd: Option<String>,
) -> Vec<DiscoveredCommand> {
    tauri::async_runtime::spawn_blocking(move || {
        let project = cwd.map(PathBuf::from).filter(|p| {
            p.is_absolute() && !p.components().any(|c| c == std::path::Component::ParentDir)
        });
        discover(&agent_id, project.as_deref(), home_dir().as_deref())
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    #[test]
    fn frontmatter_gives_the_description_and_hint() {
        let (d, h, _) = markdown_meta("---\ndescription: \"Review a pull request\"\nargument-hint: [pr-number]\nallowed-tools: Bash(git:*)\n---\n# Review\nBody");
        assert_eq!(d.as_deref(), Some("Review a pull request"));
        assert_eq!(h.as_deref(), Some("[pr-number]"));
        // No frontmatter: the first non-empty line, heading marks dropped.
        let (d, h, _) = markdown_meta("\n\n# Explain   the code\nmore");
        assert_eq!(d.as_deref(), Some("Explain the code"));
        assert_eq!(h, None);
        // An unterminated block is not frontmatter.
        let (d, _, fm) = markdown_meta("---\ndescription: x\nbody");
        assert!(fm.is_empty());
        assert_eq!(d.as_deref(), Some("description: x"));
    }

    #[test]
    fn a_gemini_toml_command_is_described_by_its_description_key() {
        assert_eq!(
            toml_description(
                "description = \"Commit with a \\\"good\\\" message\"\nprompt = \"\"\"x\"\"\""
            )
            .as_deref(),
            Some("Commit with a \"good\" message")
        );
        assert_eq!(
            toml_description("description='Literal text'\n").as_deref(),
            Some("Literal text")
        );
        assert_eq!(
            toml_description("prompt = \"p\"\ndescription = \"\"\"\nTwo\nlines\"\"\"\n").as_deref(),
            Some("Two lines")
        );
        // A description inside a table is not the command's.
        assert_eq!(toml_description("[meta]\ndescription = \"no\"\n"), None);
        assert_eq!(toml_description("prompt = \"only\"\n"), None);
    }

    #[test]
    fn claude_commands_are_namespaced_and_skills_listed_project_first() {
        let project = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        write(
            project.path(),
            ".claude/commands/deploy.md",
            "---\ndescription: Deploy to staging\n---\nDo it",
        );
        write(
            project.path(),
            ".claude/commands/frontend/component.md",
            "Make a component",
        );
        write(
            project.path(),
            ".claude/commands/bad name.md",
            "skipped: not typable",
        );
        write(
            project.path(),
            ".claude/commands/notes.txt",
            "not a command",
        );
        write(
            project.path(),
            ".claude/skills/release/SKILL.md",
            "---\nname: ship\ndescription: Ship a release\n---\n",
        );
        write(
            project.path(),
            ".claude/skills/hidden/SKILL.md",
            "---\ndescription: Background\nuser-invocable: false\n---\n",
        );
        write(
            home.path(),
            ".claude/commands/deploy.md",
            "---\ndescription: Home deploy\n---\n",
        );
        write(
            home.path(),
            ".claude/commands/standup.md",
            "---\ndescription: Write my standup\n---\n",
        );
        let got = discover("claude", Some(project.path()), Some(home.path()));
        let rows: Vec<(&str, Option<&str>, &str, &str)> = got
            .iter()
            .map(|c| {
                (
                    c.invocation.as_str(),
                    c.description.as_deref(),
                    c.kind,
                    c.scope,
                )
            })
            .collect();
        assert_eq!(
            rows,
            vec![
                ("/deploy", Some("Deploy to staging"), "command", "project"),
                (
                    "/frontend:component",
                    Some("Make a component"),
                    "command",
                    "project"
                ),
                ("/ship", Some("Ship a release"), "skill", "project"),
                ("/standup", Some("Write my standup"), "command", "user"),
            ]
        );
    }

    #[test]
    fn codex_skills_are_dollar_mentions_and_gemini_commands_toml() {
        let project = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        write(
            project.path(),
            ".agents/skills/review-pr/SKILL.md",
            "---\nname: review-pr\ndescription: Review the open PR\n---\n",
        );
        write(
            home.path(),
            ".codex/skills/notes/SKILL.md",
            "---\ndescription: Keep notes\n---\n",
        );
        let codex: Vec<String> = discover("codex", Some(project.path()), Some(home.path()))
            .into_iter()
            .map(|c| c.invocation)
            .collect();
        assert_eq!(codex, vec!["$review-pr", "$notes"]);

        write(
            project.path(),
            ".gemini/commands/git/commit.toml",
            "description = \"Write a commit\"\nprompt = \"x\"\n",
        );
        write(
            home.path(),
            ".gemini/commands/plan.toml",
            "prompt = \"x\"\n",
        );
        let gemini: Vec<(String, Option<String>)> =
            discover("gemini", Some(project.path()), Some(home.path()))
                .into_iter()
                .map(|c| (c.invocation, c.description))
                .collect();
        assert_eq!(
            gemini,
            vec![
                (
                    "/git:commit".to_string(),
                    Some("Write a commit".to_string())
                ),
                ("/plan".to_string(), None)
            ]
        );
    }

    #[test]
    fn agents_without_folders_and_paths_that_leave_the_root_find_nothing() {
        let project = tempfile::tempdir().unwrap();
        write(project.path(), ".claude/commands/x.md", "x");
        assert!(discover("aider", Some(project.path()), None).is_empty());
        assert!(discover("nope", Some(project.path()), None).is_empty());
        assert_eq!(resolve("../etc", Some(project.path()), None), None);
        assert_eq!(resolve("~/a", Some(project.path()), None), None);
    }
}
