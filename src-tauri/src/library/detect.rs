//! The project's stack, detected on the device (hodios TAXONOMY.md §8):
//! manifests and file names to depth 3, ignoring dependency and build
//! folders, matched against `detect` in the catalog vocab
//! (`vocab/stack.yml`). Nothing here leaves the machine.

use super::catalog::Vocab;
use serde::Serialize;
use std::collections::{BTreeSet, HashSet};
use std::path::Path;

const MAX_DEPTH: usize = 3;
const MAX_ENTRIES: usize = 20_000;
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    "out",
    "vendor",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
    "coverage",
    ".gradle",
    "Pods",
];

/// Config folders and files that show which agents a project is set up for
/// (hodios-core `AGENT_MARKERS`, target ids).
const AGENT_MARKERS: &[(&str, &[&str])] = &[
    ("claude-code", &[".claude", "CLAUDE.md"]),
    ("codex", &[".codex", ".agents"]),
    ("cursor", &[".cursor", ".cursorrules"]),
    (
        "copilot",
        &[
            ".github/copilot-instructions.md",
            ".github/prompts",
            ".github/agents",
            ".github/instructions",
        ],
    ),
    ("gemini-cli", &[".gemini", "GEMINI.md"]),
    ("opencode", &[".opencode", "opencode.json"]),
    ("windsurf", &[".windsurf"]),
    ("continue", &[".continue"]),
];

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScan {
    /// File names seen (not paths).
    pub files: BTreeSet<String>,
    /// Dependencies as `npm:react`, `cargo:tauri`, `pypi:django`, ...
    pub deps: BTreeSet<String>,
    /// Target ids of agents the project has config for.
    pub agents: Vec<String>,
}

fn glob_match(pattern: &str, name: &str) -> bool {
    match pattern.split_once('*') {
        None => pattern == name,
        Some((pre, post)) => {
            name.len() >= pre.len() + post.len() && name.starts_with(pre) && name.ends_with(post)
        }
    }
}

fn read_small(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > 2_000_000 {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

fn npm_deps(text: &str, out: &mut BTreeSet<String>) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return;
    };
    for key in [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
    ] {
        if let Some(map) = v.get(key).and_then(|d| d.as_object()) {
            out.extend(map.keys().map(|k| format!("npm:{k}")));
        }
    }
}

fn composer_deps(text: &str, out: &mut BTreeSet<String>) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return;
    };
    for key in ["require", "require-dev"] {
        if let Some(map) = v.get(key).and_then(|d| d.as_object()) {
            out.extend(map.keys().map(|k| format!("composer:{k}")));
        }
    }
}

/// `[dependencies]`-style TOML tables: the keys of the dependency sections.
fn cargo_deps(text: &str, out: &mut BTreeSet<String>) {
    let mut in_deps = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            let section = t.trim_matches(|c| c == '[' || c == ']');
            in_deps = section.ends_with("dependencies");
            if let Some(name) = section.strip_prefix("dependencies.") {
                out.insert(format!("cargo:{name}"));
            }
            continue;
        }
        if in_deps {
            if let Some((name, _)) = t.split_once('=') {
                let name = name.trim().trim_matches('"');
                if !name.is_empty() && !name.starts_with('#') {
                    out.insert(format!("cargo:{name}"));
                }
            }
        }
    }
}

fn python_name(spec: &str) -> Option<String> {
    let name: String = spec
        .trim()
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect();
    (!name.is_empty()).then(|| format!("pypi:{}", name.to_lowercase().replace('_', "-")))
}

fn requirements_deps(text: &str, out: &mut BTreeSet<String>) {
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') || t.starts_with('-') {
            continue;
        }
        out.extend(python_name(t));
    }
}

/// pyproject.toml: PEP 621 `dependencies = [...]` and Poetry's tables.
fn pyproject_deps(text: &str, out: &mut BTreeSet<String>) {
    let mut in_poetry = false;
    let mut in_list = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            in_poetry = t.contains("poetry") && t.contains("dependencies");
            in_list = false;
            continue;
        }
        if t.starts_with("dependencies") && t.contains('[') {
            in_list = true;
        }
        if in_list {
            for part in t.split(',') {
                if let Some(q) = part.split('"').nth(1).or_else(|| part.split('\'').nth(1)) {
                    out.extend(python_name(q));
                }
            }
            if t.contains(']') {
                in_list = false;
            }
        } else if in_poetry {
            if let Some((name, _)) = t.split_once('=') {
                let name = name.trim();
                if name != "python" {
                    out.extend(python_name(name));
                }
            }
        }
    }
}

fn gem_deps(text: &str, out: &mut BTreeSet<String>) {
    for line in text.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("gem ") {
            if let Some(name) = rest.split(['"', '\'']).nth(1) {
                out.insert(format!("gem:{name}"));
            }
        }
    }
}

fn go_deps(text: &str, out: &mut BTreeSet<String>) {
    for line in text.lines() {
        let t = line
            .trim()
            .trim_start_matches("require")
            .trim()
            .trim_start_matches('(')
            .trim();
        if let Some(module) = t.split_whitespace().next() {
            if module.contains('/') {
                out.insert(format!("go:{module}"));
            }
        }
    }
}

fn pom_deps(text: &str, out: &mut BTreeSet<String>) {
    // <groupId>org.springframework.boot</groupId>: enough for the detect hints.
    for chunk in text.split("<groupId>").skip(1) {
        if let Some(group) = chunk.split("</groupId>").next() {
            out.insert(format!("maven:{}", group.trim()));
        }
    }
}

fn csproj_deps(text: &str, out: &mut BTreeSet<String>) {
    for chunk in text.split("Include=\"").skip(1) {
        if let Some(name) = chunk.split('"').next() {
            out.insert(format!("nuget:{name}"));
        }
    }
    if let Some(sdk) = text
        .split("Sdk=\"")
        .nth(1)
        .and_then(|s| s.split('"').next())
    {
        if sdk.contains("Web") {
            out.insert("nuget:Microsoft.AspNetCore.App".into());
        }
    }
}

/// Reads file names and dependency manifests under `root`.
pub fn scan(root: &Path) -> ProjectScan {
    let mut out = ProjectScan::default();
    let mut seen = 0usize;
    let mut stack: Vec<(std::path::PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            seen += 1;
            if seen > MAX_ENTRIES {
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                if depth + 1 < MAX_DEPTH
                    && !SKIP_DIRS.contains(&name.as_str())
                    && !name.starts_with('.')
                {
                    stack.push((entry.path(), depth + 1));
                }
                // Folders count as names too (*.xcodeproj).
                out.files.insert(name);
                continue;
            }
            let path = entry.path();
            match name.as_str() {
                "package.json" => read_small(&path)
                    .iter()
                    .for_each(|t| npm_deps(t, &mut out.deps)),
                "composer.json" => read_small(&path)
                    .iter()
                    .for_each(|t| composer_deps(t, &mut out.deps)),
                "Cargo.toml" => read_small(&path)
                    .iter()
                    .for_each(|t| cargo_deps(t, &mut out.deps)),
                "pyproject.toml" => read_small(&path)
                    .iter()
                    .for_each(|t| pyproject_deps(t, &mut out.deps)),
                "Gemfile" => read_small(&path)
                    .iter()
                    .for_each(|t| gem_deps(t, &mut out.deps)),
                "go.mod" => read_small(&path)
                    .iter()
                    .for_each(|t| go_deps(t, &mut out.deps)),
                "pom.xml" | "build.gradle" | "build.gradle.kts" => read_small(&path)
                    .iter()
                    .for_each(|t| pom_deps(t, &mut out.deps)),
                n if n.starts_with("requirements") && n.ends_with(".txt") => read_small(&path)
                    .iter()
                    .for_each(|t| requirements_deps(t, &mut out.deps)),
                n if n.ends_with(".csproj") => read_small(&path)
                    .iter()
                    .for_each(|t| csproj_deps(t, &mut out.deps)),
                _ => {}
            }
            out.files.insert(name);
        }
    }
    for (target, markers) in AGENT_MARKERS {
        if markers.iter().any(|m| root.join(m).exists()) {
            out.agents.push(target.to_string());
        }
    }
    out
}

/// hodios-core `detectStack`: stack values whose `detect` hint matches a
/// file name or a dependency. Sorted.
pub fn detect_stack(scan: &ProjectScan, vocab: &Vocab) -> Vec<String> {
    let deps: HashSet<&str> = scan.deps.iter().map(String::as_str).collect();
    let mut found = Vec::new();
    for (value, rule) in &vocab.detect {
        let by_dep = rule.deps.iter().any(|d| deps.contains(d.as_str()));
        let by_file = rule
            .files
            .iter()
            .any(|p| scan.files.iter().any(|n| glob_match(p, n)));
        if by_dep || by_file {
            found.push(value.clone());
        }
    }
    found.sort();
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::catalog::DetectRule;

    fn vocab() -> Vocab {
        let mut v = Vocab::default();
        let rule = |files: &[&str], deps: &[&str]| DetectRule {
            files: files.iter().map(|s| s.to_string()).collect(),
            deps: deps.iter().map(|s| s.to_string()).collect(),
        };
        v.detect.insert(
            "typescript".into(),
            rule(&["tsconfig.json", "*.ts", "*.tsx"], &["npm:typescript"]),
        );
        v.detect.insert("react".into(), rule(&[], &["npm:react"]));
        v.detect
            .insert("python".into(), rule(&["pyproject.toml", "*.py"], &[]));
        v.detect
            .insert("django".into(), rule(&["manage.py"], &["pypi:django"]));
        v.detect
            .insert("tauri".into(), rule(&["tauri.conf.json"], &["cargo:tauri"]));
        v.detect.insert("rust".into(), rule(&["Cargo.toml"], &[]));
        v
    }

    fn tmp() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("hermes-detect-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn detects_a_typescript_react_project() {
        let d = tmp();
        std::fs::write(
            d.join("package.json"),
            r#"{"dependencies":{"react":"19"},"devDependencies":{"typescript":"6"}}"#,
        )
        .unwrap();
        std::fs::create_dir_all(d.join("src")).unwrap();
        std::fs::write(d.join("src/App.tsx"), "export {}").unwrap();
        std::fs::create_dir_all(d.join("node_modules/python-thing")).unwrap();
        std::fs::write(d.join("node_modules/python-thing/x.py"), "").unwrap();
        std::fs::create_dir_all(d.join(".claude")).unwrap();
        let s = scan(&d);
        assert_eq!(detect_stack(&s, &vocab()), vec!["react", "typescript"]);
        assert_eq!(s.agents, vec!["claude-code"]);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn detects_python_and_rust_projects() {
        let d = tmp();
        std::fs::write(
            d.join("pyproject.toml"),
            "[project]\ndependencies = [\n  \"Django>=5\",\n  'requests',\n]\n",
        )
        .unwrap();
        std::fs::write(d.join("manage.py"), "").unwrap();
        assert_eq!(detect_stack(&scan(&d), &vocab()), vec!["django", "python"]);
        let r = tmp();
        std::fs::write(
            r.join("Cargo.toml"),
            "[package]\nname=\"x\"\n[dependencies]\ntauri = { version = \"2\" }\nserde = \"1\"\n",
        )
        .unwrap();
        assert_eq!(detect_stack(&scan(&r), &vocab()), vec!["rust", "tauri"]);
        let _ = std::fs::remove_dir_all(d);
        let _ = std::fs::remove_dir_all(r);
    }

    #[test]
    fn stops_at_depth_three() {
        let d = tmp();
        let deep = d.join("a/b/c/d");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("x.py"), "").unwrap();
        assert!(detect_stack(&scan(&d), &vocab()).is_empty());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn globs() {
        assert!(glob_match("*.ts", "a.ts"));
        assert!(!glob_match("*.ts", "a.tsx"));
        assert!(glob_match("next.config.*", "next.config.mjs"));
        assert!(glob_match("Cargo.toml", "Cargo.toml"));
    }
}
