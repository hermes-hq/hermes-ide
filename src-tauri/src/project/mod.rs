pub mod attunement;
pub mod cartography;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::AppState;

// ─── Types ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchitectureInfo {
    pub pattern: String,
    pub layers: Vec<String>,
    pub entry_points: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Convention {
    pub rule: String,
    pub source: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub path: String,
    pub name: String,
    pub languages: Vec<String>,
    pub frameworks: Vec<String>,
    pub architecture: Option<ArchitectureInfo>,
    pub conventions: Vec<Convention>,
    pub scan_status: String,
    pub last_scanned_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectOrdered {
    pub id: String,
    pub path: String,
    pub name: String,
    pub languages: Vec<String>,
    pub frameworks: Vec<String>,
    pub architecture: Option<ArchitectureInfo>,
    pub conventions: Vec<Convention>,
    pub scan_status: String,
    pub last_scanned_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub session_count: i64,
    pub last_opened_at: Option<String>,
    pub path_exists: bool,
}

// ─── IPC Commands ────────────────────────────────────────────────────

/// What a new project folder starts with (the New folder form's checkboxes).
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewFolderOptions {
    /// `git init`.
    pub git: bool,
    /// An AGENTS.md to fill in, with CLAUDE.md importing it.
    pub agents_md: bool,
    pub readme: bool,
    /// Only with `git`.
    pub gitignore: bool,
}

/// The IDE's "New Project": makes the folder `name` inside `parent` (a
/// leading `~` is the home folder) with what `options` asks for, and adds it
/// as a project. An existing folder is never touched.
#[tauri::command]
pub fn create_project_folder(
    state: State<'_, AppState>,
    app: AppHandle,
    parent: String,
    name: String,
    options: NewFolderOptions,
) -> Result<Project, String> {
    let dir = make_project_folder(&parent, &name, options)?;
    create_project(
        state,
        app,
        dir.to_string_lossy().to_string(),
        Some(name.trim().to_string()),
    )
}

const AGENTS_MD: &str = "# {name}

Instructions for the coding agents working in this project. Claude Code reads
them through CLAUDE.md; Codex, Cursor, Copilot and most others read this file.

## What this project is

## How to build, run and test

## Conventions
";

/// Common clutter of most stacks; a project adds its own.
const GITIGNORE: &str = ".DS_Store
Thumbs.db
.env
.env.*
!.env.example
*.log
node_modules/
dist/
build/
target/
.venv/
__pycache__/
";

fn make_project_folder(
    parent: &str,
    name: &str,
    options: NewFolderOptions,
) -> Result<std::path::PathBuf, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the folder a name.".to_string());
    }
    const NOT_IN_NAMES: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
    if name == "."
        || name == ".."
        || name
            .chars()
            .any(|c| c.is_control() || NOT_IN_NAMES.contains(&c))
    {
        return Err(format!("\"{name}\" cannot be a folder name."));
    }
    let parent = parent.trim();
    let parent = match parent.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') || rest.starts_with('\\') => {
            let home = dirs::home_dir().ok_or("Your home folder could not be found.")?;
            home.join(rest.trim_start_matches(['/', '\\']))
        }
        _ => std::path::PathBuf::from(parent),
    };
    if !parent.is_dir() {
        return Err(format!("{} is not a folder.", parent.display()));
    }
    let dir = parent.join(name);
    std::fs::create_dir(&dir).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            format!("{} already exists.", dir.display())
        } else {
            format!("Could not create {}: {e}", dir.display())
        }
    })?;
    if let Err(e) = fill_project_folder(&dir, name, options) {
        // The folder is ours and new: take it back rather than leave half a project.
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
    }
    Ok(dir)
}

fn fill_project_folder(
    dir: &std::path::Path,
    name: &str,
    options: NewFolderOptions,
) -> Result<(), String> {
    let write = |file: &str, text: &str| {
        std::fs::write(dir.join(file), text).map_err(|e| format!("Could not write {file}: {e}"))
    };
    if options.git {
        let out = crate::git::cli::git_command()
            .arg("init")
            .arg("--quiet")
            .current_dir(dir)
            .output()
            .map_err(|e| format!("Could not start a git repository: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "Could not start a git repository: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        if options.gitignore {
            write(".gitignore", GITIGNORE)?;
        }
    }
    if options.readme {
        write("README.md", &format!("# {name}\n"))?;
    }
    if options.agents_md {
        write("AGENTS.md", &AGENTS_MD.replace("{name}", name))?;
        crate::agent_setup::link("claude", dir)?;
    }
    Ok(())
}

#[tauri::command]
pub fn create_project(
    state: State<'_, AppState>,
    app: AppHandle,
    path: String,
    name: Option<String>,
) -> Result<Project, String> {
    // Canonicalize so "." / "./" becomes an absolute path.  dunce avoids the
    // Windows `\\?\` verbatim prefix, which breaks node when used as cwd (#296).
    let canonical =
        dunce::canonicalize(&path).map_err(|e| format!("Cannot resolve path {}: {}", path, e))?;
    let resolved_path = canonical.to_string_lossy().to_string();

    if !canonical.is_dir() {
        return Err(format!("Path {} is not a directory", resolved_path));
    }

    let project_name = name.unwrap_or_else(|| {
        canonical
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string()
    });

    let new_id = Uuid::new_v4().to_string();

    // Run surface scan immediately to get languages/frameworks
    let scan_result = cartography::surface_scan(&resolved_path);

    let languages_json =
        serde_json::to_string(&scan_result.languages).unwrap_or_else(|_| "[]".to_string());
    let frameworks_json =
        serde_json::to_string(&scan_result.frameworks).unwrap_or_else(|_| "[]".to_string());

    let db = state.db.lock().map_err(|e| e.to_string())?;
    // A folder that is already a project keeps its id.
    let id = db.insert_project(
        &new_id,
        &resolved_path,
        &project_name,
        &languages_json,
        &frameworks_json,
    )?;
    db.update_project_scan(
        &id,
        "surface",
        None,
        None,
        Some(&languages_json),
        Some(&frameworks_json),
    )?;

    let project = db
        .get_project(&id)?
        .ok_or_else(|| "Failed to fetch created project".to_string())?;

    // Emit event for frontend
    let _ = app.emit("project-updated", &project);

    // Spawn background deep scan
    let app_clone = app.clone();
    let project_id = id.clone();
    let scan_path = resolved_path.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(2));
        let deep_result = cartography::deep_scan(&scan_path);

        let arch_json = serde_json::to_string(&deep_result.architecture).ok();
        let conv_json = serde_json::to_string(&deep_result.conventions).ok();
        let langs_json = if !deep_result.languages.is_empty() {
            serde_json::to_string(&deep_result.languages).ok()
        } else {
            None
        };
        let fws_json = if !deep_result.frameworks.is_empty() {
            serde_json::to_string(&deep_result.frameworks).ok()
        } else {
            None
        };

        if let Some(state) = app_clone.try_state::<AppState>() {
            if let Ok(db) = state.db.lock() {
                let _ = db.update_project_scan(
                    &project_id,
                    "deep",
                    arch_json.as_deref(),
                    conv_json.as_deref(),
                    langs_json.as_deref(),
                    fws_json.as_deref(),
                );
                // Store conventions individually
                for conv in &deep_result.conventions {
                    let _ = db.insert_convention(
                        &project_id,
                        &conv.rule,
                        &conv.source,
                        conv.confidence,
                    );
                }
                // Emit updated project
                if let Ok(Some(updated)) = db.get_project(&project_id) {
                    let _ = app_clone.emit("project-updated", &updated);
                }
                // Update context files for all sessions attached to this project
                if let Ok(session_ids) = db.get_sessions_for_project(&project_id) {
                    for sid in &session_ids {
                        let _ = attunement::write_session_context_file(&app_clone, &db, sid);
                    }
                }
            }
        }
    });

    Ok(project)
}

#[tauri::command]
pub fn get_registered_projects(state: State<'_, AppState>) -> Result<Vec<Project>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_all_projects()
}

#[tauri::command]
pub fn get_projects_ordered(state: State<'_, AppState>) -> Result<Vec<ProjectOrdered>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut projects = db.get_all_projects_ordered()?;

    // Check which paths exist on disk
    for project in &mut projects {
        project.path_exists = std::path::Path::new(&project.path).is_dir();
    }

    // Stable sort: existing folders first (preserving score order), missing folders last
    projects.sort_by_key(|a| std::cmp::Reverse(a.path_exists));

    Ok(projects)
}

#[tauri::command]
pub fn get_project(state: State<'_, AppState>, id: String) -> Result<Option<Project>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_project(&id)
}

#[tauri::command]
pub fn delete_project(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.delete_project(&id)
}

#[tauri::command]
pub fn attach_session_project(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: String,
    project_id: String,
    role: Option<String>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.attach_session_project(
        &session_id,
        &project_id,
        &role.unwrap_or_else(|| "primary".to_string()),
    )?;

    // Write context file for the session
    let _ = attunement::write_session_context_file(&app, &db, &session_id);

    // Emit updated projects list for the session
    let projects = db.get_session_projects(&session_id)?;
    let _ = app.emit(
        &format!("session-projects-updated-{}", session_id),
        &projects,
    );

    // Notify frontend that projects changed (for debounced nudge)
    let _ = app.emit("session-projects-changed", &session_id);

    Ok(())
}

#[tauri::command]
pub fn detach_session_project(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: String,
    project_id: String,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.detach_session_project(&session_id, &project_id)?;

    // Write context file for the session (will delete file if no projects remain)
    let _ = attunement::write_session_context_file(&app, &db, &session_id);

    let projects = db.get_session_projects(&session_id)?;
    let _ = app.emit(
        &format!("session-projects-updated-{}", session_id),
        &projects,
    );

    // Notify frontend that projects changed (for debounced nudge)
    let _ = app.emit("session-projects-changed", &session_id);

    Ok(())
}

#[tauri::command]
pub fn get_session_projects(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<Project>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.get_session_projects(&session_id)
}

#[tauri::command]
pub fn scan_project(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
    depth: Option<String>,
) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let project = db
        .get_project(&id)?
        .ok_or_else(|| "Project not found".to_string())?;
    drop(db);

    let depth = depth.unwrap_or_else(|| "deep".to_string());
    let scan_path = project.path.clone();
    let project_id = project.id.clone();
    let app_clone = app.clone();

    std::thread::spawn(move || {
        let result = match depth.as_str() {
            "surface" => {
                let r = cartography::surface_scan(&scan_path);
                cartography::ScanResult {
                    languages: r.languages,
                    frameworks: r.frameworks,
                    architecture: None,
                    conventions: Vec::new(),
                }
            }
            "full" => cartography::full_scan(&scan_path),
            _ => cartography::deep_scan(&scan_path),
        };

        let arch_json = result
            .architecture
            .as_ref()
            .and_then(|a| serde_json::to_string(a).ok());
        let conv_json = serde_json::to_string(&result.conventions).ok();
        let langs_json = if !result.languages.is_empty() {
            serde_json::to_string(&result.languages).ok()
        } else {
            None
        };
        let fws_json = if !result.frameworks.is_empty() {
            serde_json::to_string(&result.frameworks).ok()
        } else {
            None
        };

        if let Some(state) = app_clone.try_state::<AppState>() {
            if let Ok(db) = state.db.lock() {
                let _ = db.update_project_scan(
                    &project_id,
                    &depth,
                    arch_json.as_deref(),
                    conv_json.as_deref(),
                    langs_json.as_deref(),
                    fws_json.as_deref(),
                );
                for conv in &result.conventions {
                    let _ = db.insert_convention(
                        &project_id,
                        &conv.rule,
                        &conv.source,
                        conv.confidence,
                    );
                }
                if let Ok(Some(updated)) = db.get_project(&project_id) {
                    let _ = app_clone.emit("project-updated", &updated);
                }
                // Update context files for all sessions attached to this project
                if let Ok(session_ids) = db.get_sessions_for_project(&project_id) {
                    for sid in &session_ids {
                        let _ = attunement::write_session_context_file(&app_clone, &db, sid);
                    }
                }
            }
        }
    });

    Ok(())
}

#[cfg(test)]
mod new_folder_tests {
    use super::{make_project_folder, NewFolderOptions};

    const PLAIN: NewFolderOptions = NewFolderOptions {
        git: false,
        agents_md: false,
        readme: false,
        gitignore: false,
    };

    fn names(dir: &std::path::Path) -> Vec<String> {
        let mut n: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        n.sort();
        n
    }

    #[test]
    fn makes_the_folder_with_everything_asked_for() {
        let tmp = tempfile::TempDir::new().unwrap();
        let all = NewFolderOptions {
            git: true,
            agents_md: true,
            readme: true,
            gitignore: true,
        };
        let dir =
            make_project_folder(tmp.path().to_str().unwrap(), "  habit-tracker ", all).unwrap();
        assert_eq!(dir, tmp.path().join("habit-tracker"));
        assert_eq!(
            names(&dir),
            [".git", ".gitignore", "AGENTS.md", "CLAUDE.md", "README.md"]
        );
        assert!(dir.join(".git").is_dir());
        let agents = std::fs::read_to_string(dir.join("AGENTS.md")).unwrap();
        assert!(agents.starts_with("# habit-tracker\n"), "{agents}");
        assert_eq!(
            std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap(),
            "@AGENTS.md\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("README.md")).unwrap(),
            "# habit-tracker\n"
        );
        assert!(std::fs::read_to_string(dir.join(".gitignore"))
            .unwrap()
            .contains(".env\n"));
    }

    #[test]
    fn makes_an_empty_folder_when_nothing_is_asked() {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = make_project_folder(tmp.path().to_str().unwrap(), "notes", PLAIN).unwrap();
        assert!(dir.is_dir());
        assert!(names(&dir).is_empty());
    }

    #[test]
    fn writes_no_gitignore_without_a_repository() {
        let tmp = tempfile::TempDir::new().unwrap();
        let opts = NewFolderOptions {
            gitignore: true,
            ..PLAIN
        };
        let dir = make_project_folder(tmp.path().to_str().unwrap(), "plain", opts).unwrap();
        assert!(names(&dir).is_empty());
    }

    #[test]
    fn never_touches_an_existing_folder() {
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::create_dir(tmp.path().join("taken")).unwrap();
        std::fs::write(tmp.path().join("taken").join("keep.txt"), "mine").unwrap();
        let all = NewFolderOptions {
            git: true,
            agents_md: true,
            readme: true,
            gitignore: true,
        };
        let err = make_project_folder(tmp.path().to_str().unwrap(), "taken", all).unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        assert_eq!(names(&tmp.path().join("taken")), ["keep.txt"]);
    }

    #[test]
    fn refuses_names_that_are_not_one_folder() {
        let tmp = tempfile::TempDir::new().unwrap();
        let parent = tmp.path().to_str().unwrap();
        for bad in ["", "   ", ".", "..", "a/b", "a\\b", "x:y"] {
            assert!(make_project_folder(parent, bad, PLAIN).is_err(), "{bad:?}");
        }
        assert!(names(tmp.path()).is_empty());
    }

    #[test]
    fn refuses_a_parent_that_is_not_a_folder() {
        let tmp = tempfile::TempDir::new().unwrap();
        let missing = tmp.path().join("nope");
        let err = make_project_folder(missing.to_str().unwrap(), "app", PLAIN).unwrap_err();
        assert!(err.contains("is not a folder"), "{err}");
    }
}
