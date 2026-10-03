//! "Install into project": writes files that `@hermes-hq/hodios-core`
//! compiled (in the webview) for one agent, and records them in the
//! project's `.hodios.lock` — the same file and format the `hodios` CLI
//! writes, so people on any tool share installs.
//!
//! Rules: only paths inside the project root (no `..`, no absolute paths,
//! nothing through a symlink that leaves the root), never `scripts/` or
//! `.git/`, never runs anything. A file someone edited since it was
//! installed (its hash differs from the lock) is never overwritten: the new
//! version goes next to it as `<file>.hodios-new` for the person to compare.
//! Sections merged into shared files (AGENTS.md, CLAUDE.md, GEMINI.md) sit
//! between `<!-- hodios:<id> -->` markers; text outside them is never touched.

use super::catalog::sha256_hex;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

pub const LOCK_FILE: &str = ".hodios.lock";
pub const SIDE_SUFFIX: &str = ".hodios-new";

/// One file compiled for a target (hodios-core `CompiledFile` + lock fields).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompiledFile {
    pub id: String,
    pub version: String,
    pub kind: String,
    /// hodios target id (claude-code, codex, gemini-cli, ...).
    pub target: String,
    /// The adapter that produced it (claude-skill, codex-skill, ...).
    pub format: String,
    /// Relative to the project root, with forward slashes.
    pub path: String,
    pub content: String,
    /// Merged into a shared file between markers instead of written whole.
    pub section: bool,
    pub catalog: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LockEntry {
    pub id: String,
    pub version: String,
    pub kind: String,
    pub target: String,
    pub format: String,
    pub path: String,
    pub section: bool,
    pub hash: String,
    pub catalog: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Lock {
    pub schema: u32,
    pub entries: Vec<LockEntry>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilePlan {
    pub path: String,
    /// "add" | "update" | "unchanged" | "edited" (changed by someone since install).
    pub status: String,
    pub section: bool,
    /// What is there now (the whole file), for the diff.
    pub current: Option<String>,
    /// The whole file after the install.
    pub next: String,
    pub bytes: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstallPlan {
    pub files: Vec<FilePlan>,
    pub lock_before: Option<String>,
    pub lock_after: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub written: Vec<String>,
    /// Edited files left alone; the new version is next to them.
    pub side_files: Vec<String>,
    pub unchanged: Vec<String>,
    pub entries: Vec<LockEntry>,
}

pub fn sha(text: &str) -> String {
    format!("sha256:{}", sha256_hex(text.as_bytes()))
}

// ─── Path guard ──────────────────────────────────────────────────────

/// The absolute path of `rel` inside `root`, or why it is refused.
pub fn guarded_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() || rel.contains('\0') || rel.contains('\\') {
        return Err(format!("refused path {rel:?}"));
    }
    let rel_path = Path::new(rel);
    let mut parts = Vec::new();
    for c in rel_path.components() {
        match c {
            Component::Normal(p) => parts.push(p.to_string_lossy().to_string()),
            _ => {
                return Err(format!(
                    "refused path {rel:?}: it must stay inside the project"
                ))
            }
        }
    }
    match parts.first().map(String::as_str) {
        None => return Err(format!("refused path {rel:?}")),
        Some("scripts") => {
            return Err(format!("refused path {rel:?}: Hermes never writes scripts"))
        }
        Some(".git") => {
            return Err(format!(
                "refused path {rel:?}: Hermes never writes into .git"
            ))
        }
        _ => {}
    }
    let root = dunce::canonicalize(root).map_err(|e| format!("project folder: {e}"))?;
    let full = root.join(rel_path);
    // The deepest part that exists must resolve inside the root (no symlink
    // out of the project), and the file itself must not be a symlink.
    let mut probe = full.clone();
    while !probe.exists() {
        if !probe.pop() {
            break;
        }
    }
    let resolved = dunce::canonicalize(&probe).map_err(|e| format!("{rel}: {e}"))?;
    if !resolved.starts_with(&root) {
        return Err(format!(
            "refused path {rel:?}: it leads outside the project"
        ));
    }
    if std::fs::symlink_metadata(&full)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!("refused path {rel:?}: it is a symbolic link"));
    }
    Ok(full)
}

// ─── Sections (hodios-core upsertSection / findSection / removeSection) ─

fn markers(id: &str) -> (String, String) {
    (
        format!("<!-- hodios:{id} -->"),
        format!("<!-- /hodios:{id} -->"),
    )
}

/// The marked section of `id`, markers included, ending with a newline.
pub fn find_section(existing: &str, id: &str) -> Option<String> {
    let (start, end) = markers(id);
    let s = existing.find(&start)?;
    let e = existing[s..].find(&end)? + s + end.len();
    let mut out = existing[s..e].to_string();
    if existing[e..].starts_with('\n') || !out.ends_with('\n') {
        out.push('\n');
    }
    Some(out)
}

pub fn upsert_section(existing: &str, id: &str, block: &str) -> String {
    let (start, end) = markers(id);
    if let Some(s) = existing.find(&start) {
        if let Some(rel) = existing[s..].find(&end) {
            let mut e = s + rel + end.len();
            if existing[e..].starts_with('\n') {
                e += 1;
            }
            return format!("{}{}{}", &existing[..s], block, &existing[e..]);
        }
    }
    if existing.trim().is_empty() {
        return block.to_string();
    }
    format!("{}\n\n{}", existing.trim_end_matches('\n'), block)
}

pub fn remove_section(existing: &str, id: &str) -> String {
    let (start, end) = markers(id);
    let Some(s) = existing.find(&start) else {
        return existing.to_string();
    };
    let Some(rel) = existing[s..].find(&end) else {
        return existing.to_string();
    };
    let mut e = s + rel + end.len();
    if existing[e..].starts_with('\n') {
        e += 1;
    }
    let out = format!("{}{}", &existing[..s], &existing[e..]);
    let trimmed = out.trim_start_matches('\n');
    let mut collapsed = String::new();
    let mut blank = 0;
    for line in trimmed.split('\n') {
        if line.is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        collapsed.push_str(line);
        collapsed.push('\n');
    }
    let collapsed = collapsed.trim_end().to_string();
    if collapsed.is_empty() {
        String::new()
    } else {
        format!("{collapsed}\n")
    }
}

// ─── Lock ────────────────────────────────────────────────────────────

pub fn read_lock(root: &Path) -> Lock {
    std::fs::read_to_string(root.join(LOCK_FILE))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .map(|v| Lock {
            schema: 1,
            entries: v
                .get("entries")
                .and_then(|e| serde_json::from_value(e.clone()).ok())
                .unwrap_or_default(),
        })
        .unwrap_or(Lock {
            schema: 1,
            entries: Vec::new(),
        })
}

fn lock_text(lock: &Lock) -> String {
    let mut lock = lock.clone();
    lock.entries.sort_by(|a, b| {
        a.id.cmp(&b.id)
            .then(a.target.cmp(&b.target))
            .then(a.path.cmp(&b.path))
    });
    format!(
        "{}\n",
        serde_json::to_string_pretty(&lock).unwrap_or_default()
    )
}

fn entry_of(f: &CompiledFile) -> LockEntry {
    LockEntry {
        id: f.id.clone(),
        version: f.version.clone(),
        kind: f.kind.clone(),
        target: f.target.clone(),
        format: f.format.clone(),
        path: f.path.clone(),
        section: f.section,
        hash: sha(&f.content),
        catalog: f.catalog.clone(),
    }
}

// ─── Plan and apply ──────────────────────────────────────────────────

/// What installing `files` would do, without writing anything.
pub fn plan(root: &Path, files: &[CompiledFile]) -> Result<InstallPlan, String> {
    let lock = read_lock(root);
    let lock_before = std::fs::read_to_string(root.join(LOCK_FILE)).ok();
    let mut next_lock = lock.clone();
    let mut planned: Vec<FilePlan> = Vec::new();
    // Several sections can land in one shared file: merge them in order.
    let mut pending: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for f in files {
        let abs = guarded_path(root, &f.path)?;
        let on_disk = std::fs::read_to_string(&abs).ok();
        let current = pending.get(&f.path).cloned().or(on_disk.clone());
        let ours = if f.section {
            current.as_deref().and_then(|c| find_section(c, &f.id))
        } else {
            current.clone()
        };
        let previous = lock
            .entries
            .iter()
            .find(|l| l.path == f.path && l.id == f.id && l.target == f.target);
        let status = if ours.as_deref() == Some(f.content.as_str()) {
            "unchanged"
        } else if ours.is_some()
            && previous.is_none_or(|p| ours.as_deref().map(sha) != Some(p.hash.clone()))
        {
            "edited"
        } else if ours.is_none() {
            "add"
        } else {
            "update"
        };
        let next = if f.section {
            upsert_section(current.as_deref().unwrap_or(""), &f.id, &f.content)
        } else {
            f.content.clone()
        };
        if status != "edited" {
            pending.insert(f.path.clone(), next.clone());
            next_lock
                .entries
                .retain(|l| !(l.id == f.id && l.target == f.target && l.path == f.path));
            next_lock.entries.push(entry_of(f));
        }
        planned.push(FilePlan {
            path: f.path.clone(),
            status: status.into(),
            section: f.section,
            current: on_disk,
            bytes: next.len(),
            next,
        });
    }
    Ok(InstallPlan {
        files: planned,
        lock_before,
        lock_after: lock_text(&next_lock),
    })
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let tmp = path.with_extension(format!(
        "{}hodios-tmp",
        path.extension()
            .map(|e| format!("{}.", e.to_string_lossy()))
            .unwrap_or_default()
    ));
    std::fs::write(&tmp, text).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Writes the files (re-planned now, so nothing changed under the person
/// since the preview goes unnoticed) and the lock. Edited files get a
/// `.hodios-new` next to them instead.
pub fn apply(root: &Path, files: &[CompiledFile]) -> Result<InstallResult, String> {
    let p = plan(root, files)?;
    let mut result = InstallResult {
        written: Vec::new(),
        side_files: Vec::new(),
        unchanged: Vec::new(),
        entries: Vec::new(),
    };
    let mut last_for_path: std::collections::HashMap<&str, &FilePlan> =
        std::collections::HashMap::new();
    for fp in &p.files {
        match fp.status.as_str() {
            "edited" => {
                let side = format!("{}{}", fp.path, SIDE_SUFFIX);
                let abs = guarded_path(root, &side)?;
                write_atomic(&abs, &fp.next)?;
                result.side_files.push(side);
            }
            "unchanged" => result.unchanged.push(fp.path.clone()),
            _ => {
                last_for_path.insert(fp.path.as_str(), fp);
            }
        }
    }
    for (path, fp) in last_for_path {
        write_atomic(&guarded_path(root, path)?, &fp.next)?;
        result.written.push(path.to_string());
    }
    result.written.sort();
    write_atomic(&root.join(LOCK_FILE), &p.lock_after)?;
    let lock = read_lock(root);
    result.entries = lock
        .entries
        .into_iter()
        .filter(|e| {
            files
                .iter()
                .any(|f| f.id == e.id && f.target == e.target && f.path == e.path)
        })
        .collect();
    Ok(result)
}

/// Removes what an install wrote, unless it was edited since (then it stays
/// and the reason is returned). The lock forgets the entries either way.
pub fn uninstall(root: &Path, id: &str, target: &str) -> Result<Vec<String>, String> {
    let mut lock = read_lock(root);
    let mut kept = Vec::new();
    for e in lock
        .entries
        .iter()
        .filter(|e| e.id == id && e.target == target)
    {
        let abs = guarded_path(root, &e.path)?;
        let Ok(current) = std::fs::read_to_string(&abs) else {
            continue;
        };
        let ours = if e.section {
            find_section(&current, id)
        } else {
            Some(current.clone())
        };
        if ours.as_deref().map(sha) != Some(e.hash.clone()) {
            kept.push(e.path.clone());
            continue;
        }
        if e.section {
            let rest = remove_section(&current, id);
            if rest.is_empty() {
                std::fs::remove_file(&abs).map_err(|err| err.to_string())?;
            } else {
                write_atomic(&abs, &rest)?;
            }
        } else {
            std::fs::remove_file(&abs).map_err(|err| err.to_string())?;
            // Folders the install made and left empty go too.
            let mut dir = abs.parent().map(Path::to_path_buf);
            while let Some(d) = dir {
                if !d.starts_with(root) || d == root || std::fs::remove_dir(&d).is_err() {
                    break;
                }
                dir = d.parent().map(Path::to_path_buf);
            }
        }
    }
    lock.entries.retain(|e| !(e.id == id && e.target == target));
    if lock.entries.is_empty() {
        let _ = std::fs::remove_file(root.join(LOCK_FILE));
    } else {
        write_atomic(&root.join(LOCK_FILE), &lock_text(&lock))?;
    }
    Ok(kept)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("hermes-install-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        dunce::canonicalize(d).unwrap()
    }

    fn file(path: &str, content: &str, section: bool) -> CompiledFile {
        CompiledFile {
            id: "review-pr".into(),
            version: "1.0.0".into(),
            kind: "prompt".into(),
            target: "codex".into(),
            format: "codex-skill".into(),
            path: path.into(),
            content: content.into(),
            section,
            catalog: "2026.1003.0".into(),
        }
    }

    #[test]
    fn installs_a_skill_and_writes_the_lock() {
        let root = tmp();
        let f = file(".agents/skills/review-pr/SKILL.md", "# Review\n", false);
        let p = plan(&root, std::slice::from_ref(&f)).unwrap();
        assert_eq!(p.files[0].status, "add");
        assert!(!root.join(".agents").exists(), "a plan writes nothing");
        let r = apply(&root, std::slice::from_ref(&f)).unwrap();
        assert_eq!(r.written, vec![".agents/skills/review-pr/SKILL.md"]);
        assert_eq!(
            std::fs::read_to_string(root.join(".agents/skills/review-pr/SKILL.md")).unwrap(),
            "# Review\n"
        );
        let lock = read_lock(&root);
        assert_eq!(lock.entries.len(), 1);
        assert_eq!(lock.entries[0].hash, sha("# Review\n"));
        assert_eq!(plan(&root, &[f]).unwrap().files[0].status, "unchanged");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn an_edited_file_is_never_overwritten() {
        let root = tmp();
        let f = file("SKILL.md", "v1\n", false);
        apply(&root, &[f]).unwrap();
        std::fs::write(root.join("SKILL.md"), "my own edit\n").unwrap();
        let newer = file("SKILL.md", "v2\n", false);
        let p = plan(&root, std::slice::from_ref(&newer)).unwrap();
        assert_eq!(p.files[0].status, "edited");
        let r = apply(&root, &[newer]).unwrap();
        assert_eq!(r.side_files, vec!["SKILL.md.hodios-new"]);
        assert_eq!(
            std::fs::read_to_string(root.join("SKILL.md")).unwrap(),
            "my own edit\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("SKILL.md.hodios-new")).unwrap(),
            "v2\n"
        );
        // The lock still describes what Hermes installed (v1).
        assert_eq!(read_lock(&root).entries[0].hash, sha("v1\n"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn an_untouched_file_updates() {
        let root = tmp();
        apply(&root, &[file("a.md", "v1\n", false)]).unwrap();
        let p = plan(&root, &[file("a.md", "v2\n", false)]).unwrap();
        assert_eq!(p.files[0].status, "update");
        apply(&root, &[file("a.md", "v2\n", false)]).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("a.md")).unwrap(), "v2\n");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn merges_a_section_and_leaves_the_rest_alone() {
        let root = tmp();
        std::fs::write(root.join("AGENTS.md"), "# Team rules\n\nBe kind.\n").unwrap();
        let block = "<!-- hodios:review-pr -->\n## Review\n\nRules.\n<!-- /hodios:review-pr -->\n";
        apply(&root, &[file("AGENTS.md", block, true)]).unwrap();
        let text = std::fs::read_to_string(root.join("AGENTS.md")).unwrap();
        assert!(
            text.starts_with("# Team rules\n\nBe kind.\n\n<!-- hodios:review-pr -->"),
            "{text}"
        );
        let kept = uninstall(&root, "review-pr", "codex").unwrap();
        assert!(kept.is_empty());
        assert_eq!(
            std::fs::read_to_string(root.join("AGENTS.md")).unwrap(),
            "# Team rules\n\nBe kind.\n"
        );
        assert!(!root.join(LOCK_FILE).exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn refuses_paths_outside_the_project_and_scripts() {
        let root = tmp();
        for bad in [
            "../x.md",
            "/etc/passwd",
            "scripts/run.sh",
            ".git/config",
            "a/../../b",
            "",
        ] {
            assert!(guarded_path(&root, bad).is_err(), "{bad}");
        }
        assert!(guarded_path(&root, ".claude/skills/x/SKILL.md").is_ok());
        #[cfg(unix)]
        {
            let outside = tmp();
            std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
            assert!(guarded_path(&root, "link/SKILL.md").is_err());
            let _ = std::fs::remove_dir_all(outside);
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn uninstall_keeps_an_edited_file() {
        let root = tmp();
        apply(
            &root,
            &[file(".agents/skills/review-pr/SKILL.md", "v1\n", false)],
        )
        .unwrap();
        std::fs::write(root.join(".agents/skills/review-pr/SKILL.md"), "edited\n").unwrap();
        let kept = uninstall(&root, "review-pr", "codex").unwrap();
        assert_eq!(kept, vec![".agents/skills/review-pr/SKILL.md"]);
        assert!(root.join(".agents/skills/review-pr/SKILL.md").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn section_helpers_match_hodios_core() {
        let block = "<!-- hodios:a -->\nA\n<!-- /hodios:a -->\n";
        assert_eq!(upsert_section("", "a", block), block);
        let two = upsert_section("intro\n", "a", block);
        assert_eq!(two, format!("intro\n\n{block}"));
        assert_eq!(find_section(&two, "a").unwrap(), block);
        let replaced = upsert_section(&two, "a", "<!-- hodios:a -->\nB\n<!-- /hodios:a -->\n");
        assert!(replaced.contains("\nB\n") && !replaced.contains("\nA\n"));
        assert_eq!(remove_section(&two, "a"), "intro\n");
    }
}
