use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use tauri::State;
use uuid::Uuid;
use walkdir::WalkDir;

use crate::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectInfo {
    pub id: String,
    pub path: String,
    pub name: String,
    pub languages: Vec<String>,
    pub frameworks: Vec<String>,
    pub created_at: String,
}

// Directories to skip when scanning
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "vendor",
    "build",
    "dist",
    "__pycache__",
    ".next",
    ".nuxt",
    "target",
    ".cache",
    ".venv",
    "venv",
    ".tox",
    "coverage",
    ".nyc_output",
    ".turbo",
    "hermes-worktrees",
];

// Security denylist — never scan these
const DENY_DIRS: &[&str] = &[".ssh", ".aws", ".gnupg", ".kube"];

// Project marker files
struct ProjectMarker {
    file: &'static str,
    language: &'static str,
    framework_detect: Option<fn(&str) -> Vec<String>>,
}

const MARKERS: &[ProjectMarker] = &[
    ProjectMarker {
        file: "package.json",
        language: "JavaScript/TypeScript",
        framework_detect: Some(detect_js_frameworks),
    },
    ProjectMarker {
        file: "Cargo.toml",
        language: "Rust",
        framework_detect: Some(detect_rust_frameworks),
    },
    ProjectMarker {
        file: "go.mod",
        language: "Go",
        framework_detect: None,
    },
    ProjectMarker {
        file: "pyproject.toml",
        language: "Python",
        framework_detect: None,
    },
    ProjectMarker {
        file: "requirements.txt",
        language: "Python",
        framework_detect: None,
    },
    ProjectMarker {
        file: "Gemfile",
        language: "Ruby",
        framework_detect: None,
    },
    ProjectMarker {
        file: "pom.xml",
        language: "Java",
        framework_detect: None,
    },
    ProjectMarker {
        file: "build.gradle",
        language: "Java/Kotlin",
        framework_detect: None,
    },
    ProjectMarker {
        file: "composer.json",
        language: "PHP",
        framework_detect: None,
    },
    ProjectMarker {
        file: "pubspec.yaml",
        language: "Dart",
        framework_detect: Some(|_| vec!["Flutter".to_string()]),
    },
    ProjectMarker {
        file: "Package.swift",
        language: "Swift",
        framework_detect: None,
    },
    ProjectMarker {
        file: ".csproj",
        language: "C#",
        framework_detect: None,
    },
];

fn detect_js_frameworks(content: &str) -> Vec<String> {
    let mut frameworks = Vec::new();
    let checks = [
        ("next", "Next.js"),
        ("react", "React"),
        ("vue", "Vue"),
        ("nuxt", "Nuxt"),
        ("svelte", "Svelte"),
        ("angular", "Angular"),
        ("express", "Express"),
        ("fastify", "Fastify"),
        ("nest", "NestJS"),
        ("remix", "Remix"),
        ("astro", "Astro"),
        ("tauri", "Tauri"),
        ("electron", "Electron"),
    ];
    for (key, name) in checks {
        if content.contains(&format!("\"{}\"", key)) || content.contains(&format!("\"@{}/", key)) {
            frameworks.push(name.to_string());
        }
    }
    frameworks
}

fn detect_rust_frameworks(content: &str) -> Vec<String> {
    let mut frameworks = Vec::new();
    let checks = [
        ("actix-web", "Actix"),
        ("axum", "Axum"),
        ("rocket", "Rocket"),
        ("tauri", "Tauri"),
        ("tokio", "Tokio"),
        ("warp", "Warp"),
    ];
    for (key, name) in checks {
        if content.contains(key) {
            frameworks.push(name.to_string());
        }
    }
    frameworks
}

fn detect_project_at_path(dir: &Path) -> Option<ProjectInfo> {
    if !dir.is_dir() {
        return None;
    }

    // Check denylist
    if let Some(dir_name) = dir.file_name().and_then(|n| n.to_str()) {
        if DENY_DIRS.contains(&dir_name) {
            return None;
        }
    }

    // Skip Hermes worktree directories — they are not standalone projects
    let path_str = dir.to_string_lossy();
    if path_str.contains("hermes-worktrees/")
        || path_str.contains("hermes-worktrees\\")
        || path_str.contains(".hermes/worktrees/")
        || path_str.contains(".hermes\\worktrees\\")
    {
        return None;
    }

    // Must have .git to be considered a project root
    if !dir.join(".git").exists() {
        return None;
    }

    let mut languages = Vec::new();
    let mut frameworks = Vec::new();

    for marker in MARKERS {
        let marker_path = dir.join(marker.file);
        if marker_path.exists() {
            if !languages.contains(&marker.language.to_string()) {
                languages.push(marker.language.to_string());
            }
            if let Some(detect_fn) = marker.framework_detect {
                if let Ok(content) = std::fs::read_to_string(&marker_path) {
                    for fw in detect_fn(&content) {
                        if !frameworks.contains(&fw) {
                            frameworks.push(fw);
                        }
                    }
                }
            }
        }
    }

    // Also detect languages by file extension counts
    let mut ext_counts: HashMap<String, usize> = HashMap::new();
    for entry in WalkDir::new(dir)
        .max_depth(3)
        .into_iter()
        .filter_entry(|e| {
            e.file_name()
                .to_str()
                .map(|s| !SKIP_DIRS.contains(&s))
                .unwrap_or(true)
        })
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() {
            if let Some(ext) = entry.path().extension().and_then(|e| e.to_str()) {
                *ext_counts.entry(ext.to_lowercase()).or_insert(0) += 1;
            }
        }
    }

    let ext_lang_map = [
        ("ts", "TypeScript"),
        ("tsx", "TypeScript"),
        ("js", "JavaScript"),
        ("jsx", "JavaScript"),
        ("py", "Python"),
        ("rs", "Rust"),
        ("go", "Go"),
        ("rb", "Ruby"),
        ("java", "Java"),
        ("kt", "Kotlin"),
        ("swift", "Swift"),
        ("cs", "C#"),
        ("cpp", "C++"),
        ("c", "C"),
    ];

    for (ext, lang) in ext_lang_map {
        if ext_counts.get(ext).copied().unwrap_or(0) > 2 {
            let lang_str = lang.to_string();
            if !languages.contains(&lang_str) {
                languages.push(lang_str);
            }
        }
    }

    let name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    Some(ProjectInfo {
        id: Uuid::new_v4().to_string(),
        path: dir.to_string_lossy().to_string(),
        name,
        languages,
        frameworks,
        created_at: chrono::Utc::now().to_rfc3339(),
    })
}

#[tauri::command]
pub async fn scan_directory(
    state: State<'_, AppState>,
    path: String,
    max_depth: Option<usize>,
) -> Result<Vec<ProjectInfo>, String> {
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err(format!("Path {} is not a directory", path));
    }

    if let Some(dir_name) = root.file_name().and_then(|n| n.to_str()) {
        if DENY_DIRS.contains(&dir_name) {
            return Err("Cannot scan denied directory".to_string());
        }
    }

    let path_owned = path.clone();

    // Move the expensive directory walk off the main thread.
    // Collect detected projects first, then persist to DB after.
    let projects: Vec<ProjectInfo> = tokio::task::spawn_blocking(move || {
        let root = Path::new(&path_owned);
        let depth = max_depth.unwrap_or(3);
        let mut projects = Vec::new();

        for entry in WalkDir::new(root)
            .max_depth(depth)
            .into_iter()
            .filter_entry(|e| {
                e.file_name()
                    .to_str()
                    .map(|s| !SKIP_DIRS.contains(&s) && !DENY_DIRS.contains(&s))
                    .unwrap_or(true)
            })
            .filter_map(|e| e.ok())
        {
            if entry.file_type().is_dir() {
                if let Some(project) = detect_project_at_path(entry.path()) {
                    projects.push(project);
                }
            }
        }

        projects
    })
    .await
    .map_err(|e| format!("scan_directory task panicked: {}", e))?;

    // Persist discovered projects to DB (fast, no filesystem I/O)
    let db = state.db.lock().map_err(|e| e.to_string())?;
    for project in &projects {
        let languages_json = serde_json::to_string(&project.languages).unwrap_or_default();
        let frameworks_json = serde_json::to_string(&project.frameworks).unwrap_or_default();
        db.upsert_project(
            &project.id,
            &project.path,
            &project.name,
            &languages_json,
            &frameworks_json,
        )
        .ok();
    }
    drop(db);

    Ok(projects)
}

#[tauri::command]
pub fn detect_project(
    state: State<'_, AppState>,
    path: String,
) -> Result<Option<ProjectInfo>, String> {
    let dir = Path::new(&path);

    // Walk up to find project root
    let mut current = dir.to_path_buf();
    loop {
        if let Some(project) = detect_project_at_path(&current) {
            let db = state.db.lock().map_err(|e| e.to_string())?;
            let languages_json = serde_json::to_string(&project.languages).unwrap_or_default();
            let frameworks_json = serde_json::to_string(&project.frameworks).unwrap_or_default();
            db.upsert_project(
                &project.id,
                &project.path,
                &project.name,
                &languages_json,
                &frameworks_json,
            )
            .ok();
            return Ok(Some(project));
        }
        if !current.pop() {
            break;
        }
    }

    Ok(None)
}

#[tauri::command]
pub fn get_projects(state: State<'_, AppState>) -> Result<Vec<ProjectInfo>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_all_detected_projects()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::TempDir;

    /// Helper: create a minimal git repo so `.git` exists and `detect_project_at_path` recognises it.
    fn init_git(dir: &Path) {
        Command::new("git")
            .args(["init"])
            .current_dir(dir)
            .output()
            .unwrap();
    }

    // ── SKIP_DIRS contains hermes-worktrees ─────────────────────────────

    #[test]
    fn skip_dirs_includes_hermes_worktrees() {
        assert!(
            SKIP_DIRS.contains(&"hermes-worktrees"),
            "SKIP_DIRS must contain 'hermes-worktrees' so worktree dirs are never scanned"
        );
    }

    // ── detect_project_at_path rejects worktree paths ───────────────────

    #[test]
    fn detect_project_skips_hermes_worktrees_path() {
        let tmp = TempDir::new().unwrap();
        // Simulate: {tmp}/hermes-worktrees/{hash}/{session}_{branch}/
        let wt = tmp
            .path()
            .join("hermes-worktrees")
            .join("a1b2c3d4e5f6a7b8")
            .join("abc12345_feature-login");
        std::fs::create_dir_all(&wt).unwrap();
        init_git(&wt);

        assert!(
            detect_project_at_path(&wt).is_none(),
            "worktree inside hermes-worktrees/ must not be detected as a project"
        );
    }

    #[test]
    fn detect_project_skips_legacy_hermes_worktrees_path() {
        let tmp = TempDir::new().unwrap();
        // Simulate old format: {project}/.hermes/worktrees/{session}_{branch}/
        let wt = tmp
            .path()
            .join(".hermes")
            .join("worktrees")
            .join("abc12345_feature-login");
        std::fs::create_dir_all(&wt).unwrap();
        init_git(&wt);

        assert!(
            detect_project_at_path(&wt).is_none(),
            "worktree inside .hermes/worktrees/ must not be detected as a project"
        );
    }

    #[test]
    fn detect_project_allows_normal_project() {
        let tmp = TempDir::new().unwrap();
        let project = tmp.path().join("my-app");
        std::fs::create_dir_all(&project).unwrap();
        init_git(&project);
        // Add a package.json so it gets detected with languages
        std::fs::write(project.join("package.json"), "{}").unwrap();

        let result = detect_project_at_path(&project);
        assert!(result.is_some(), "normal project should be detected");
        assert_eq!(result.unwrap().name, "my-app");
    }
}
