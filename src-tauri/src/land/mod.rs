//! Land sheet with undo (F22).
//!
//! Ship a task's worktree in one step and clean up without losing anything:
//!
//! - **Commit** on the task branch;
//! - **Pull request**: commit, push, `gh pr create`; then read `gh pr checks`
//!   and hand a failing check's log to the agent (a file in the worktree);
//! - **Merge locally**: one squash commit on the base branch, only when the
//!   base has not moved (fast-forward) or the in-memory merge is clean. A
//!   conflict changes nothing and is routed to a pull request or a rebase.
//! - **Archive**: the worktree folder (build output included) goes, the
//!   branch and every `refs/hermes/...` reference stay.
//!
//! Before anything moves, the branch and base commits are kept in
//! `refs/hermes/<session>/land/<n>/{branch,base}` and a record under
//! `<app data>/land/`. Undo resets the base if it has not moved (else
//! reverts the landed commit), closes the pull request and deletes the
//! pushed branch, restores an archived worktree, and uncommits the work.
//!
//! Pure git and gh: the same for every agent.

pub mod gh;
pub mod ops;
pub mod record;

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

use crate::git::worktree;
use crate::AppState;
use record::{LandMode, LandRecord};

/// Paths whose contents are read for the sheet, capped per file.
const MAX_REPO_FILE_BYTES: u64 = 64 * 1024;
/// A failing check's log kept for the agent, tail first.
const MAX_CI_LOG_BYTES: usize = 256 * 1024;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The session's own worktree, checked: a Hermes worktree folder, not the
/// project folder, and whether another session shares it.
#[derive(Debug, Clone)]
struct Target {
    repo_path: PathBuf,
    worktree_path: PathBuf,
    shared: bool,
}

fn target(
    state: &State<'_, AppState>,
    session_id: &str,
    project_id: &str,
) -> Result<Target, String> {
    let db = state.db.lock().map_err(|e| format!("DB lock error: {e}"))?;
    let wt = db
        .get_worktree_by_session_and_project(session_id, project_id)?
        .ok_or_else(|| "This session has no worktree of its own to land".to_string())?;
    let project = db
        .get_project(project_id)?
        .ok_or_else(|| format!("Project '{project_id}' not found"))?;
    if wt.is_main_worktree || !worktree::is_hermes_worktree_path(&wt.worktree_path) {
        return Err(
            "This session works in the project folder; there is no task worktree to land".into(),
        );
    }
    let shared = db
        .count_sessions_for_worktree_path(&wt.worktree_path)
        .map(|n| n > 1)
        .unwrap_or(true);
    Ok(Target {
        repo_path: PathBuf::from(project.path),
        worktree_path: PathBuf::from(wt.worktree_path),
        shared,
    })
}

fn noise(path: &str) -> bool {
    crate::git::is_dirty_close_noise_file(path)
}

fn read_capped(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_REPO_FILE_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

#[derive(Debug, Clone, Serialize)]
pub struct FeatureFile {
    pub folder: String,
    pub text: String,
}

/// `.hermes/features/<folder>/feature.md` files in the worktree (the
/// frontend parses them with the contract reader and picks the task's).
fn feature_files(worktree: &Path) -> Vec<FeatureFile> {
    let Ok(entries) = std::fs::read_dir(worktree.join(".hermes").join("features")) else {
        return Vec::new();
    };
    let mut out: Vec<FeatureFile> = entries
        .flatten()
        .filter_map(|e| {
            let folder = e.file_name().to_string_lossy().to_string();
            let text = read_capped(&e.path().join("feature.md"))?;
            Some(FeatureFile { folder, text })
        })
        .take(50)
        .collect();
    out.sort_by(|a, b| a.folder.cmp(&b.folder));
    out
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LandPreview {
    #[serde(flatten)]
    pub analysis: ops::Analysis,
    pub worktree_path: String,
    pub repo_path: String,
    /// Another session works in the same checkout: archive is not offered.
    pub shared: bool,
    /// The remote a pull request pushes to.
    pub remote: Option<String>,
    pub worktree_toml: Option<String>,
    pub features: Vec<FeatureFile>,
    /// Earlier landings of this session, oldest first.
    pub landings: Vec<LandRecord>,
}

fn preview(app_data: &Path, session_id: &str, t: &Target) -> Result<LandPreview, String> {
    let analysis = ops::analyze(&t.worktree_path, &t.repo_path, &noise)?;
    let remote = ops::pick_remote(&t.repo_path, &analysis.branch);
    Ok(LandPreview {
        remote,
        worktree_toml: read_capped(&t.worktree_path.join(".hermes").join("worktree.toml")),
        features: feature_files(&t.worktree_path),
        landings: record::list_for_session(app_data, session_id),
        worktree_path: t.worktree_path.to_string_lossy().to_string(),
        repo_path: t.repo_path.to_string_lossy().to_string(),
        shared: t.shared,
        analysis,
    })
}

#[tauri::command]
pub async fn land_preview(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
) -> Result<LandPreview, String> {
    let t = target(&state, &session_id, &project_id)?;
    let app_data = crate::instance::app_data_dir(&app)?;
    tokio::task::spawn_blocking(move || preview(&app_data, &session_id, &t))
        .await
        .map_err(|e| e.to_string())?
}

/// Whether gh is installed and signed in (separate from the preview: it can
/// take a moment, and the sheet should not wait for it).
#[tauri::command]
pub async fn land_gh_status(
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
) -> Result<gh::GhStatus, String> {
    let t = target(&state, &session_id, &project_id)?;
    tokio::task::spawn_blocking(move || gh::status(&t.repo_path))
        .await
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LandRequest {
    pub mode: LandMode,
    /// Commit message (the squash commit's too).
    pub message: String,
    #[serde(default)]
    pub pr_title: Option<String>,
    #[serde(default)]
    pub pr_body: Option<String>,
    #[serde(default)]
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LandStatus {
    Landed,
    /// A local merge would conflict: nothing was merged.
    Conflict,
    /// A step after the pre-land record failed; undo is available.
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LandOutcome {
    pub status: LandStatus,
    /// None when nothing was changed (a conflict found before committing).
    pub record: Option<LandRecord>,
    pub conflict_files: Vec<String>,
    pub error: Option<String>,
}

fn subject(message: &str) -> String {
    message.lines().next().unwrap_or("").trim().to_string()
}

fn execute(
    app_data: &Path,
    session_id: &str,
    project_id: &str,
    t: &Target,
    req: &LandRequest,
    gh_cmd: Option<gh::GhCommand>,
) -> Result<LandOutcome, String> {
    if subject(&req.message).is_empty() {
        return Err("Write a commit message first".into());
    }
    let a = ops::analyze(&t.worktree_path, &t.repo_path, &noise)?;
    let base = a.base.as_ref().map(|b| b.name.clone());
    let has_work = a.uncommitted_files > 0 || a.commits_ahead > 0;
    let mut remote = None;
    match req.mode {
        LandMode::Commit => {
            if a.uncommitted_files == 0 {
                return Err("There are no uncommitted changes to commit".into());
            }
        }
        LandMode::Merge => {
            if base.is_none() {
                return Err("There is no branch to merge into".into());
            }
            match &a.merge {
                ops::MergeCheck::Conflict { files } => {
                    return Ok(LandOutcome {
                        status: LandStatus::Conflict,
                        record: None,
                        conflict_files: files.clone(),
                        error: None,
                    })
                }
                ops::MergeCheck::NothingToMerge => {
                    return Err(format!(
                        "'{}' already has everything on this branch",
                        base.unwrap_or_default()
                    ))
                }
                _ => {}
            }
        }
        LandMode::Pr => {
            if base.is_none() {
                return Err("There is no branch to open the pull request against".into());
            }
            if !has_work {
                return Err("There is nothing on this branch to open a pull request for".into());
            }
            if gh_cmd.is_none() {
                return Err("GitHub CLI (gh) is not installed".into());
            }
            remote = Some(
                ops::pick_remote(&t.repo_path, &a.branch)
                    .ok_or_else(|| "This repository has no remote to push to".to_string())?,
            );
        }
        LandMode::Archive => return Err("Archive is its own action".into()),
    }

    // ── Pre-land record and references: from here on, undo works ────
    let n = record::next_n(app_data, session_id);
    let mut rec = LandRecord {
        id: format!("{session_id}-{n}"),
        n,
        session_id: session_id.to_string(),
        project_id: project_id.to_string(),
        repo_path: t.repo_path.to_string_lossy().to_string(),
        worktree_path: t.worktree_path.to_string_lossy().to_string(),
        branch: a.branch.clone(),
        label: req.label.clone(),
        mode: req.mode,
        created_at: now_ms(),
        branch_before: a.head.clone(),
        branch_after: None,
        base: base.clone(),
        base_before: a.base.as_ref().map(|b| b.head.clone()),
        merged_commit: None,
        remote: remote.clone(),
        remote_before: None,
        pushed: None,
        pr_url: None,
        archived: false,
        undone_steps: Vec::new(),
        undone: false,
    };
    if let Some(r) = ops::land_ref(session_id, n, "branch") {
        ops::write_ref(&t.repo_path, &r, &rec.branch_before)?;
    }
    if let (Some(r), Some(before)) = (ops::land_ref(session_id, n, "base"), &rec.base_before) {
        ops::write_ref(&t.repo_path, &r, before)?;
    }
    record::save(app_data, &rec)?;

    let failed = |rec: &LandRecord, error: String| -> Result<LandOutcome, String> {
        record::save(app_data, rec)?;
        Ok(LandOutcome {
            status: LandStatus::Failed,
            record: Some(rec.clone()),
            conflict_files: Vec::new(),
            error: Some(error),
        })
    };

    // ── Commit the uncommitted work on the task branch ──────────────
    if a.uncommitted_files > 0 {
        match worktree::commit_worktree_changes(
            &rec.worktree_path,
            &req.message,
            worktree::CommitTarget::Session,
            &noise,
        ) {
            Ok(c) => rec.branch_after = Some(c.commit),
            Err(e) => return failed(&rec, e),
        }
    } else {
        rec.branch_after = Some(a.head.clone());
    }
    record::save(app_data, &rec)?;
    let landed_head = rec.branch_after.clone().unwrap_or_default();

    match req.mode {
        LandMode::Merge => {
            let base = base.unwrap_or_default();
            match ops::squash_merge(&t.repo_path, &base, &landed_head, &req.message) {
                Ok(ops::SquashOutcome::Merged { commit, .. }) => {
                    rec.merged_commit = Some(commit);
                }
                Ok(ops::SquashOutcome::Conflict { files }) => {
                    record::save(app_data, &rec)?;
                    return Ok(LandOutcome {
                        status: LandStatus::Conflict,
                        record: Some(rec),
                        conflict_files: files,
                        error: None,
                    });
                }
                Ok(ops::SquashOutcome::NothingToMerge) => {
                    return failed(
                        &rec,
                        format!("'{base}' already has everything on this branch"),
                    )
                }
                Err(e) => return failed(&rec, e),
            }
        }
        LandMode::Pr => {
            let remote = remote.unwrap_or_default();
            match ops::remote_branch_head(&t.worktree_path, &remote, &a.branch) {
                Ok(before) => rec.remote_before = before,
                Err(e) => return failed(&rec, e),
            }
            record::save(app_data, &rec)?;
            if let Err(e) = ops::push_branch(&t.worktree_path, &remote, &a.branch) {
                return failed(&rec, e);
            }
            rec.pushed = Some(landed_head.clone());
            record::save(app_data, &rec)?;
            let title = req
                .pr_title
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| subject(&req.message));
            let body = req.pr_body.clone().unwrap_or_else(|| {
                req.message
                    .split_once('\n')
                    .map(|(_, b)| b.trim().to_string())
                    .unwrap_or_default()
            });
            let gh_cmd = gh_cmd.expect("checked above");
            match gh::create_pr(
                &gh_cmd,
                &t.worktree_path,
                &base.unwrap_or_default(),
                &a.branch,
                &title,
                &body,
            ) {
                Ok(url) => rec.pr_url = Some(url),
                Err(e) => return failed(&rec, e),
            }
        }
        LandMode::Commit | LandMode::Archive => {}
    }
    record::save(app_data, &rec)?;
    Ok(LandOutcome {
        status: LandStatus::Landed,
        record: Some(rec),
        conflict_files: Vec::new(),
        error: None,
    })
}

#[tauri::command]
pub async fn land_execute(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    request: LandRequest,
) -> Result<LandOutcome, String> {
    let t = target(&state, &session_id, &project_id)?;
    if t.shared {
        return Err(
            "Another session works in this checkout; land from one session at a time".into(),
        );
    }
    let app_data = crate::instance::app_data_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        let gh_cmd = matches!(request.mode, LandMode::Pr)
            .then(gh::gh_command)
            .flatten();
        let out = execute(&app_data, &session_id, &project_id, &t, &request, gh_cmd);
        if let Ok(o) = &out {
            log::info!(
                "[land] {:?} {:?} for session {}",
                request.mode,
                o.status,
                session_id
            );
        }
        out
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Get a worktree ready to be archived: refuse when it has uncommitted work
/// (land or commit it first) or another session shares it; record the
/// archive so it can be undone. The frontend then closes the session, which
/// removes the worktree folder (build output included) and keeps the branch.
fn prepare_archive(
    app_data: &Path,
    session_id: &str,
    project_id: &str,
    t: &Target,
    land_id: Option<&str>,
    label: &str,
) -> Result<LandRecord, String> {
    if t.shared {
        return Err("Another session works in this checkout; it is not archived".into());
    }
    let a = ops::analyze(&t.worktree_path, &t.repo_path, &noise)?;
    if a.uncommitted_files > 0 {
        return Err(format!(
            "{} uncommitted file(s) would be lost; land or commit them first",
            a.uncommitted_files
        ));
    }
    let mut rec = match land_id {
        Some(id) => {
            let rec = record::load(app_data, id)?;
            if rec.session_id != session_id || rec.undone {
                return Err("That landing can't be archived".into());
            }
            rec
        }
        None => {
            let n = record::next_n(app_data, session_id);
            if let Some(r) = ops::land_ref(session_id, n, "branch") {
                ops::write_ref(&t.repo_path, &r, &a.head)?;
            }
            LandRecord {
                id: format!("{session_id}-{n}"),
                n,
                session_id: session_id.to_string(),
                project_id: project_id.to_string(),
                repo_path: t.repo_path.to_string_lossy().to_string(),
                worktree_path: t.worktree_path.to_string_lossy().to_string(),
                branch: a.branch.clone(),
                label: label.to_string(),
                mode: LandMode::Archive,
                created_at: now_ms(),
                branch_before: a.head.clone(),
                branch_after: Some(a.head.clone()),
                base: None,
                base_before: None,
                merged_commit: None,
                remote: None,
                remote_before: None,
                pushed: None,
                pr_url: None,
                archived: false,
                undone_steps: Vec::new(),
                undone: false,
            }
        }
    };
    rec.archived = true;
    if rec.label.is_empty() {
        rec.label = label.to_string();
    }
    record::save(app_data, &rec)?;
    Ok(rec)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivePlan {
    pub record: LandRecord,
    /// What the folder holds now, all of which goes with it.
    pub total_bytes: u64,
    pub build_output_bytes: u64,
}

#[tauri::command]
pub async fn land_archive(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
    land_id: Option<String>,
    label: String,
) -> Result<ArchivePlan, String> {
    let t = target(&state, &session_id, &project_id)?;
    let app_data = crate::instance::app_data_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        let rec = prepare_archive(
            &app_data,
            &session_id,
            &project_id,
            &t,
            land_id.as_deref(),
            &label,
        )?;
        let usage = crate::git::disk_guard::worktree_usage(&t.worktree_path);
        Ok(ArchivePlan {
            record: rec,
            total_bytes: usage.total_bytes,
            build_output_bytes: usage.build_output_bytes,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredWorktree {
    pub session_id: String,
    pub project_id: String,
    pub worktree_path: String,
    pub branch: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoOutcome {
    pub record: LandRecord,
    /// What undo did, one line each, in order.
    pub steps: Vec<String>,
    /// Set when an archived worktree was restored: the frontend opens a
    /// session with this id in it.
    pub restored: Option<RestoredWorktree>,
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(8)]
}

/// Undo one landing. Each step is recorded as it finishes, so after a
/// failure a retry only does what is left.
fn undo(
    app_data: &Path,
    rec: &mut LandRecord,
    restore_session_id: &str,
    gh_cmd: Option<gh::GhCommand>,
    link_restored: &mut dyn FnMut(&LandRecord) -> Result<(), String>,
) -> Result<UndoOutcome, String> {
    if rec.undone {
        return Err("This landing was already undone".into());
    }
    let repo = PathBuf::from(&rec.repo_path);
    let wt = PathBuf::from(&rec.worktree_path);
    let mut steps = Vec::new();
    let mut restored = None;

    fn done(rec: &LandRecord, key: &str) -> bool {
        rec.undone_steps.iter().any(|s| s == key)
    }
    fn mark(
        app_data: &Path,
        rec: &mut LandRecord,
        steps: &mut Vec<String>,
        key: &str,
        text: String,
    ) -> Result<(), String> {
        rec.undone_steps.push(key.to_string());
        steps.push(text);
        record::save(app_data, rec)
    }

    // 1. The pull request.
    if let Some(url) = rec.pr_url.clone().filter(|_| !done(rec, "pr")) {
        let gh_cmd = gh_cmd
            .as_ref()
            .ok_or("GitHub CLI (gh) is not installed; the pull request is still open")?;
        gh::close_pr(gh_cmd, &repo, &url)?;
        mark(
            app_data,
            rec,
            &mut steps,
            "pr",
            format!("Closed the pull request {url}"),
        )?;
    }
    // 2. The pushed branch.
    if let (Some(remote), Some(pushed)) = (rec.remote.clone(), rec.pushed.clone()) {
        if !done(rec, "remote") {
            ops::unpush_branch(
                &repo,
                &remote,
                &rec.branch,
                &pushed,
                rec.remote_before.as_deref(),
            )?;
            let text = match &rec.remote_before {
                None => format!("Deleted {} on {remote}", rec.branch),
                Some(sha) => format!("Put {remote}/{} back at {}", rec.branch, short(sha)),
            };
            mark(app_data, rec, &mut steps, "remote", text)?;
        }
    }
    // 3. The base branch: reset when it has not moved, else revert.
    if let (Some(base), Some(merged), Some(before)) = (
        rec.base.clone(),
        rec.merged_commit.clone(),
        rec.base_before.clone(),
    ) {
        if !done(rec, "base") {
            let now = ops::branch_head(&repo, &base).unwrap_or_default();
            let text = if now == merged {
                ops::rewind_branch(&repo, &base, &merged, &before)?;
                format!("{base} is back at {}", short(&before))
            } else {
                let revert = ops::revert_on_branch(&repo, &base, &merged)?;
                format!(
                    "{base} had moved on, so the landed commit was reverted ({})",
                    short(&revert)
                )
            };
            mark(app_data, rec, &mut steps, "base", text)?;
        }
    }
    // 4. An archived worktree comes back.
    if !wt.exists() && !done(rec, "archive") {
        ops::restore_worktree(&repo, &wt, &rec.branch)?;
        link_restored(rec)?;
        restored = Some(RestoredWorktree {
            session_id: restore_session_id.to_string(),
            project_id: rec.project_id.clone(),
            worktree_path: rec.worktree_path.clone(),
            branch: rec.branch.clone(),
            label: rec.label.clone(),
        });
        mark(
            app_data,
            rec,
            &mut steps,
            "archive",
            format!("Restored the worktree of {}", rec.branch),
        )?;
    }
    // 5. The land commit: the work is uncommitted again.
    if let Some(after) = rec.branch_after.clone() {
        if after != rec.branch_before && !done(rec, "commit") {
            match ops::uncommit(&wt, &after, &rec.branch_before) {
                Ok(()) => mark(
                    app_data,
                    rec,
                    &mut steps,
                    "commit",
                    "The changes are uncommitted again, as before landing".into(),
                )?,
                Err(e) => steps.push(e),
            }
        }
    }
    rec.undone = true;
    record::save(app_data, rec)?;
    Ok(UndoOutcome {
        record: rec.clone(),
        steps,
        restored,
    })
}

#[tauri::command]
pub async fn land_undo(
    app: AppHandle,
    land_id: String,
    restore_session_id: String,
) -> Result<UndoOutcome, String> {
    let app_data = crate::instance::app_data_dir(&app)?;
    let mut rec = record::load(&app_data, &land_id)?;
    if !crate::contract::turns::is_turn_ref_session_id(&restore_session_id) {
        return Err("Not a session id".into());
    }
    let handle = app.clone();
    let result = tokio::task::spawn_blocking(move || {
        let gh_cmd = rec.pr_url.as_ref().and_then(|_| gh::gh_command());
        let mut link = |r: &LandRecord| -> Result<(), String> {
            let state = handle.state::<AppState>();
            let db = state.db.lock().map_err(|e| format!("DB lock error: {e}"))?;
            db.insert_session_worktree(
                &uuid::Uuid::new_v4().to_string(),
                &restore_session_id,
                &r.project_id,
                &r.worktree_path,
                Some(&r.branch),
                false,
            )
        };
        undo(&app_data, &mut rec, &restore_session_id, gh_cmd, &mut link)
    })
    .await
    .map_err(|e| e.to_string())?;
    log::info!(
        "[land] undo {land_id}: {}",
        match &result {
            Ok(o) => o.steps.join("; "),
            Err(e) => format!("failed: {e}"),
        }
    );
    result
}

#[tauri::command]
pub async fn land_pr_checks(app: AppHandle, land_id: String) -> Result<Vec<gh::PrCheck>, String> {
    let app_data = crate::instance::app_data_dir(&app)?;
    let rec = record::load(&app_data, &land_id)?;
    let url = rec
        .pr_url
        .clone()
        .ok_or("This landing opened no pull request")?;
    tokio::task::spawn_blocking(move || {
        let gh_cmd = gh::gh_command().ok_or("GitHub CLI (gh) is not installed")?;
        gh::pr_checks(&gh_cmd, Path::new(&rec.repo_path), &url)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A file name for a check's log: lowercase letters, digits and dashes.
pub fn log_file_name(check: &str) -> String {
    let mut out = String::new();
    for c in check.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-');
    let name = if trimmed.is_empty() { "check" } else { trimmed };
    format!("{}.log", &name[..name.len().min(60)])
}

/// Keep the end of a long log (where the failure is).
pub fn tail(log: &str, max: usize) -> &str {
    if log.len() <= max {
        return log;
    }
    let mut start = log.len() - max;
    while !log.is_char_boundary(start) {
        start += 1;
    }
    &log[start..]
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CiLogFile {
    /// Relative to the worktree, with forward slashes.
    pub relative_path: String,
    pub bytes: usize,
}

/// Save a failing check's log in the worktree (`.hermes/ci/`, ignored by
/// git) for the agent to read. Nothing is typed anywhere: the frontend
/// offers the one line to paste, and the person sends it.
fn save_ci_log(worktree: &Path, check: &str, log: &str) -> Result<CiLogFile, String> {
    let dir = worktree.join(".hermes").join("ci");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not save the log: {e}"))?;
    let ignore = dir.join(".gitignore");
    if !ignore.exists() {
        std::fs::write(&ignore, "*\n").map_err(|e| format!("Could not save the log: {e}"))?;
    }
    let name = log_file_name(check);
    let text = tail(log, MAX_CI_LOG_BYTES);
    std::fs::write(dir.join(&name), text).map_err(|e| format!("Could not save the log: {e}"))?;
    Ok(CiLogFile {
        relative_path: format!(".hermes/ci/{name}"),
        bytes: text.len(),
    })
}

#[tauri::command]
pub async fn land_ci_log(
    app: AppHandle,
    land_id: String,
    check_name: String,
    link: String,
) -> Result<CiLogFile, String> {
    let app_data = crate::instance::app_data_dir(&app)?;
    let rec = record::load(&app_data, &land_id)?;
    let wt = PathBuf::from(&rec.worktree_path);
    if !wt.is_dir() {
        return Err("The worktree was archived; restore it to hand the log to the agent".into());
    }
    tokio::task::spawn_blocking(move || {
        let gh_cmd = gh::gh_command().ok_or("GitHub CLI (gh) is not installed")?;
        let log = gh::failed_log(&gh_cmd, Path::new(&rec.repo_path), &link)?;
        save_ci_log(&wt, &check_name, &log)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::ops::tests::{repo_with_task, sh};
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn target_for(repo: &Path, wt: &Path) -> Target {
        Target {
            repo_path: repo.to_path_buf(),
            worktree_path: wt.to_path_buf(),
            shared: false,
        }
    }

    fn req(mode: LandMode, message: &str) -> LandRequest {
        LandRequest {
            mode,
            message: message.into(),
            pr_title: None,
            pr_body: None,
            label: "Task".into(),
        }
    }

    fn no_link(_: &LandRecord) -> Result<(), String> {
        Ok(())
    }

    #[test]
    fn merge_then_undo_puts_main_back_and_the_work_back_to_uncommitted() {
        let (_t, repo, wt) = repo_with_task();
        let data = TempDir::new().unwrap();
        fs::write(wt.join("b.txt"), "task\n").unwrap();
        let main_before = sh(&repo, &["rev-parse", "main"]);
        let out = execute(
            data.path(),
            "s1",
            "p1",
            &target_for(&repo, &wt),
            &req(LandMode::Merge, "Add b\n\nTurn 1"),
            None,
        )
        .unwrap();
        assert_eq!(out.status, LandStatus::Landed);
        let mut rec = out.record.unwrap();
        assert_eq!(
            sh(&repo, &["rev-parse", "refs/hermes/s1/land/1/base"]),
            main_before,
            "the pre-land ref keeps main's old commit"
        );
        assert_eq!(sh(&repo, &["log", "-1", "--format=%s", "main"]), "Add b");
        assert!(repo.join("b.txt").exists());

        let undone = undo(data.path(), &mut rec, "s2", None, &mut no_link).unwrap();
        assert_eq!(sh(&repo, &["rev-parse", "main"]), main_before);
        assert!(!repo.join("b.txt").exists());
        assert_eq!(sh(&wt, &["status", "--porcelain"]), "?? b.txt");
        assert_eq!(undone.steps.len(), 2, "{:?}", undone.steps);
        assert!(record::load(data.path(), "s1-1").unwrap().undone);
        assert!(undo(data.path(), &mut rec, "s2", None, &mut no_link).is_err());
    }

    #[test]
    fn a_conflicting_merge_is_refused_before_anything_changes() {
        let (_t, repo, wt) = repo_with_task();
        let data = TempDir::new().unwrap();
        fs::write(wt.join("a.txt"), "one\ntask\nthree\n").unwrap();
        fs::write(repo.join("a.txt"), "one\nmain\nthree\n").unwrap();
        sh(&repo, &["commit", "-q", "-am", "main"]);
        let main_before = sh(&repo, &["rev-parse", "main"]);
        let wt_head = sh(&wt, &["rev-parse", "HEAD"]);
        let out = execute(
            data.path(),
            "s1",
            "p1",
            &target_for(&repo, &wt),
            &req(LandMode::Merge, "x"),
            None,
        )
        .unwrap();
        assert_eq!(out.status, LandStatus::Conflict);
        assert_eq!(out.conflict_files, vec!["a.txt"]);
        assert!(out.record.is_none());
        assert_eq!(sh(&repo, &["rev-parse", "main"]), main_before);
        assert_eq!(
            sh(&wt, &["rev-parse", "HEAD"]),
            wt_head,
            "nothing committed"
        );
        assert_eq!(record::next_n(data.path(), "s1"), 1, "no record");
    }

    #[test]
    fn undo_after_main_moved_reverts_instead_of_resetting() {
        let (_t, repo, wt) = repo_with_task();
        let data = TempDir::new().unwrap();
        fs::write(wt.join("b.txt"), "task\n").unwrap();
        let mut rec = execute(
            data.path(),
            "s1",
            "p1",
            &target_for(&repo, &wt),
            &req(LandMode::Merge, "Add b"),
            None,
        )
        .unwrap()
        .record
        .unwrap();
        fs::write(repo.join("later.txt"), "x\n").unwrap();
        sh(&repo, &["add", "later.txt"]);
        sh(&repo, &["commit", "-q", "-m", "later"]);
        let out = undo(data.path(), &mut rec, "s2", None, &mut no_link).unwrap();
        assert!(out.steps[0].contains("reverted"), "{:?}", out.steps);
        assert!(!repo.join("b.txt").exists());
        assert!(repo.join("later.txt").exists());
    }

    #[test]
    fn archive_needs_a_clean_worktree_and_undo_restores_it() {
        let (_t, repo, wt) = repo_with_task();
        let data = TempDir::new().unwrap();
        fs::write(wt.join("b.txt"), "task\n").unwrap();
        let t = target_for(&repo, &wt);
        assert!(prepare_archive(data.path(), "s1", "p1", &t, None, "Task")
            .unwrap_err()
            .contains("uncommitted"));
        let landed = execute(
            data.path(),
            "s1",
            "p1",
            &t,
            &req(LandMode::Commit, "Add b"),
            None,
        )
        .unwrap()
        .record
        .unwrap();
        let mut rec =
            prepare_archive(data.path(), "s1", "p1", &t, Some(&landed.id), "Task").unwrap();
        assert!(rec.archived);
        // What closing the session does: remove the folder, keep the branch.
        sh(
            &repo,
            &["worktree", "remove", "--force", wt.to_str().unwrap()],
        );
        assert!(!wt.exists());
        assert!(ops::branch_exists(&repo, "task"));
        let mut linked = Vec::new();
        let mut link = |r: &LandRecord| {
            linked.push(r.worktree_path.clone());
            Ok(())
        };
        let out = undo(data.path(), &mut rec, "s2", None, &mut link).unwrap();
        assert!(wt.is_dir(), "the worktree is back");
        assert_eq!(linked, vec![rec.worktree_path.clone()]);
        assert_eq!(out.restored.unwrap().session_id, "s2");
        assert_eq!(sh(&wt, &["status", "--porcelain"]), "?? b.txt");
    }

    #[test]
    fn commit_mode_needs_uncommitted_work() {
        let (_t, repo, wt) = repo_with_task();
        let data = TempDir::new().unwrap();
        let err = execute(
            data.path(),
            "s1",
            "p1",
            &target_for(&repo, &wt),
            &req(LandMode::Commit, "x"),
            None,
        )
        .unwrap_err();
        assert!(err.contains("no uncommitted"));
        let err = execute(
            data.path(),
            "s1",
            "p1",
            &target_for(&repo, &wt),
            &req(LandMode::Commit, "  "),
            None,
        )
        .unwrap_err();
        assert!(err.contains("message"));
    }

    /// A stand-in gh that logs its arguments and stdin and answers like gh.
    #[cfg(unix)]
    fn fake_gh(dir: &Path) -> (gh::GhCommand, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let log = dir.join("gh.log");
        let script = dir.join("gh");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\necho \"ARGS $*\" >> '{log}'\nif [ \"$1 $2\" = \"pr create\" ]; then cat >> '{log}'; echo https://github.test/o/r/pull/7; fi\nexit 0\n",
                log = log.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        (
            gh::GhCommand {
                program: script,
                prefix: vec![],
            },
            log,
        )
    }

    #[cfg(unix)]
    #[test]
    fn a_pull_request_pushes_opens_and_undo_closes_it_and_deletes_the_branch() {
        let (t, repo, wt) = repo_with_task();
        let data = TempDir::new().unwrap();
        let bare = t.path().join("remote.git");
        sh(t.path(), &["init", "-q", "--bare", bare.to_str().unwrap()]);
        sh(&repo, &["remote", "add", "origin", bare.to_str().unwrap()]);
        let (gh_cmd, log) = fake_gh(t.path());
        fs::write(wt.join("b.txt"), "task\n").unwrap();
        let mut r = req(LandMode::Pr, "Add b");
        r.pr_body = Some("## Turns\n- Turn 1".into());
        let out = execute(
            data.path(),
            "s1",
            "p1",
            &target_for(&repo, &wt),
            &r,
            Some(gh_cmd.clone()),
        )
        .unwrap();
        assert_eq!(out.status, LandStatus::Landed, "{:?}", out.error);
        let mut rec = out.record.unwrap();
        assert_eq!(
            rec.pr_url.as_deref(),
            Some("https://github.test/o/r/pull/7")
        );
        assert_eq!(
            ops::remote_branch_head(&wt, "origin", "task")
                .unwrap()
                .as_deref(),
            rec.pushed.as_deref()
        );
        let logged = fs::read_to_string(&log).unwrap();
        assert!(logged.contains("pr create --base main --head task --title Add b --body-file -"));
        assert!(
            logged.contains("## Turns\n- Turn 1"),
            "the body went through stdin"
        );

        let out = undo(data.path(), &mut rec, "s2", Some(gh_cmd), &mut no_link).unwrap();
        assert!(fs::read_to_string(&log)
            .unwrap()
            .contains("pr close https://github.test/o/r/pull/7"));
        assert_eq!(
            ops::remote_branch_head(&wt, "origin", "task").unwrap(),
            None
        );
        assert_eq!(out.steps.len(), 3, "{:?}", out.steps);
        assert!(ops::branch_exists(&repo, "task"), "the local branch stays");
    }

    #[test]
    fn ci_logs_are_saved_ignored_and_named_safely() {
        let (_t, _repo, wt) = repo_with_task();
        let f = save_ci_log(&wt, "CI / test (ubuntu)", "boom\n").unwrap();
        assert_eq!(f.relative_path, ".hermes/ci/ci-test-ubuntu.log");
        assert_eq!(
            fs::read_to_string(wt.join(".hermes/ci/ci-test-ubuntu.log")).unwrap(),
            "boom\n"
        );
        assert_eq!(
            sh(&wt, &["status", "--porcelain"]),
            "",
            "git ignores the log"
        );
        assert_eq!(log_file_name("../../etc"), "etc.log");
        assert_eq!(tail("abcdef", 3), "def");
        assert_eq!(tail("é-ab", 3), "-ab");
    }
}
