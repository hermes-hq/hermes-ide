//! The prompt library (Hodios) inside Hermes.
//!
//! - A curated catalog ships with the app (`src-tauri/library/`, fetched and
//!   verified at build time from the tag pinned in `prompt-library.lock.json`)
//!   and is imported into `<app data>/library/library.db` the first time the
//!   Library is opened — never at startup — after checking its manifest
//!   against the hash this binary was built with and every object against
//!   its own hash. Everything in it is searchable and usable offline.
//! - A background task checks for a newer, signed catalog every 12 hours
//!   (`update.rs`); it changes library content only, never project files.
//! - Search, shelves and "why this is here" are computed here, on the
//!   device, from signals that never leave it (`search.rs`, `shelves.rs`).
//! - Installing into a project writes files the webview compiled with
//!   `@hermes-hq/hodios-core`, guarded and recorded in `.hodios.lock`
//!   (`install.rs`).
//!
//! No command returns the whole catalog: search returns one page of at most
//! 50 rows, shelves at most 12 cards each, and a body only for the entry
//! that is open.

#[cfg(test)]
mod bench;
pub mod catalog;
pub mod detect;
pub mod install;
pub mod search;
pub mod shelves;
pub mod store;
pub mod update;
pub mod user_state;
pub mod verify;

use crate::AppState;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};

/// The lock the bundled archive was fetched for (checked again at import).
const LOCK_JSON: &str = include_str!("../../../prompt-library.lock.json");
pub const ARCHIVE_NAME: &str = "catalog-v1.tar.zst";
pub const UPDATED_EVENT: &str = "library-updated";

#[derive(Debug, Clone, Deserialize)]
struct BundledLock {
    catalog: String,
    seq: i64,
    manifest_sha256: String,
}

fn bundled_lock() -> Option<BundledLock> {
    serde_json::from_str(LOCK_JSON).ok()
}

/// When a project was scanned, its stack and its agent folders.
type DetectedAt = (Instant, Vec<String>, Vec<String>);
/// The profile, pins and uses, and decayed use per facet value.
type UserInputs = (
    user_state::Profile,
    user_state::UseSignals,
    Vec<(String, String, f64)>,
);

/// An open library: one connection for reads, one for writes (sync and
/// imports). WAL lets searches keep reading the old snapshot while an
/// update commits.
pub struct Library {
    pub reader: Mutex<Connection>,
    pub writer: Mutex<Connection>,
    detect_cache: Mutex<HashMap<String, DetectedAt>>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    import_ms: Option<u64>,
    last_outcome: Option<update::Outcome>,
    error: Option<String>,
}

#[derive(Default)]
pub struct LibraryState {
    lib: Mutex<Option<Arc<Library>>>,
    runtime: Mutex<RuntimeStatus>,
    checking: AtomicBool,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ─── The bundled archive ──────────────────────────────────────────────

fn archive_path(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("library").join(ARCHIVE_NAME));
    }
    // Next to the executable (a test build staged with its resources).
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
    {
        candidates.push(dir.join("library").join(ARCHIVE_NAME));
    }
    // Development and test builds read it from the checkout.
    #[cfg(any(debug_assertions, feature = "e2e"))]
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("library")
            .join(ARCHIVE_NAME),
    );
    candidates.into_iter().find(|p| p.is_file())
}

/// Reads and verifies the bundled archive: its manifest must be the one the
/// lock pins, and every object must match its hash.
pub fn read_bundled(path: &Path) -> Result<catalog::VerifiedCatalog, String> {
    let lock = bundled_lock().ok_or("prompt-library.lock.json is unreadable")?;
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut files = catalog::read_archive(&bytes)?;
    let manifest = files
        .remove("manifest.json")
        .ok_or("the bundled library has no manifest")?;
    let sha = catalog::sha256_hex(&manifest);
    if sha != lock.manifest_sha256 {
        return Err(format!(
            "the bundled library manifest ({sha}) is not the one this build pins ({}); refusing it",
            lock.manifest_sha256
        ));
    }
    catalog::collect(&manifest, &mut files, true, &Default::default())
}

fn import_needed(info: Option<&store::CatalogInfo>) -> bool {
    let Some(info) = info else { return true };
    let Some(lock) = bundled_lock() else {
        return false;
    };
    // A newer app brings a newer bundled catalog; a newer update stays.
    update::newer((&lock.catalog, lock.seq), (&info.catalog, info.seq))
}

// ─── Opening ──────────────────────────────────────────────────────────

fn library_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::instance::app_data_dir(app)?.join("library"))
}

/// The open library, importing the bundled catalog on the very first open.
pub fn open(app: &AppHandle) -> Result<Arc<Library>, String> {
    let state = app.state::<LibraryState>();
    let mut slot = lock(&state.lib);
    if let Some(lib) = slot.as_ref() {
        return Ok(Arc::clone(lib));
    }
    let dir = library_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let path = dir.join("library.db");
    let writer = store::open(&path)?;
    let mut writer = writer;
    let started = Instant::now();
    if import_needed(store::info(&writer).as_ref()) {
        match archive_path(app) {
            Some(archive) => {
                let cat = read_bundled(&archive)?;
                let summary = store::apply(&mut writer, &cat, "bundled")?;
                let ms = started.elapsed().as_millis() as u64;
                log::info!(
                    "[library] imported the bundled catalog {} ({} rows) in {ms} ms",
                    summary.catalog,
                    summary.rows
                );
                lock(&state.runtime).import_ms = Some(ms);
            }
            None => log::warn!(
                "[library] no bundled catalog in this build (run npm run prepare:library)"
            ),
        }
    }
    let reader = Connection::open_with_flags(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    reader
        .execute_batch(
            "PRAGMA cache_size=-16000; PRAGMA mmap_size=268435456; PRAGMA busy_timeout=5000;",
        )
        .map_err(|e| e.to_string())?;
    let lib = Arc::new(Library {
        reader: Mutex::new(reader),
        writer: Mutex::new(writer),
        detect_cache: Mutex::new(HashMap::new()),
    });
    *slot = Some(Arc::clone(&lib));
    Ok(lib)
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

fn with_db<T>(app: &AppHandle, f: impl FnOnce(&Connection) -> T) -> Result<T, String> {
    let state = app.state::<AppState>();
    let db = state.db.lock().map_err(|e| e.to_string())?;
    Ok(f(&db.conn))
}

fn setting(app: &AppHandle, key: &str) -> Option<String> {
    let state = app.state::<AppState>();
    let db = state.db.lock().ok()?;
    db.get_setting(key).ok().flatten()
}

fn set_setting(app: &AppHandle, key: &str, value: &str) {
    let state = app.state::<AppState>();
    if let Ok(db) = state.db.lock() {
        let _ = db.set_setting(key, value);
    };
}

/// The detected stack and agent folders of a project (cached a minute).
fn detect_project(lib: &Library, path: &str) -> (Vec<String>, Vec<String>) {
    if let Some((at, stack, agents)) = lock(&lib.detect_cache).get(path) {
        if at.elapsed().as_secs() < 60 {
            return (stack.clone(), agents.clone());
        }
    }
    let vocab = store::vocab(&lock(&lib.reader));
    let scan = detect::scan(Path::new(path));
    let stack = detect::detect_stack(&scan, &vocab);
    lock(&lib.detect_cache).insert(
        path.to_string(),
        (Instant::now(), stack.clone(), scan.agents.clone()),
    );
    (stack, scan.agents)
}

fn user_inputs(app: &AppHandle) -> Result<UserInputs, String> {
    with_db(app, |c| {
        (
            user_state::read_profile(c),
            user_state::use_signals(c),
            user_state::affinity(c, user_state::now_secs()),
        )
    })
}

// ─── Status ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub ready: bool,
    pub catalog: Option<store::CatalogInfo>,
    pub bundled: Option<(String, i64)>,
    pub has_bundled_archive: bool,
    pub offline_bodies: i64,
    pub updates: String,
    pub last_check: Option<i64>,
    pub last_success: Option<i64>,
    pub last_error: Option<String>,
    pub trusted_keys: usize,
    pub import_ms: Option<u64>,
    pub last_outcome: Option<update::Outcome>,
    pub checking: bool,
    pub error: Option<String>,
}

fn status_of(app: &AppHandle) -> Status {
    let opened = open(app);
    let state = app.state::<LibraryState>();
    let runtime = lock(&state.runtime).clone();
    let (catalog, offline_bodies) = match &opened {
        Ok(lib) => {
            let r = lock(&lib.reader);
            let n: i64 = r
                .query_row("SELECT count(*) FROM body_cache", [], |x| x.get(0))
                .unwrap_or(0);
            (store::info(&r), n)
        }
        Err(_) => (None, 0),
    };
    Status {
        ready: catalog.as_ref().is_some_and(|c| c.rows > 0),
        catalog,
        bundled: bundled_lock().map(|l| (l.catalog, l.seq)),
        has_bundled_archive: archive_path(app).is_some(),
        offline_bodies,
        updates: setting(app, "library_updates").unwrap_or_else(|| "auto".into()),
        last_check: setting(app, "library_last_check").and_then(|v| v.parse().ok()),
        last_success: setting(app, "library_last_success").and_then(|v| v.parse().ok()),
        last_error: setting(app, "library_last_error").filter(|v| !v.is_empty()),
        trusted_keys: verify::trusted_keys().len(),
        import_ms: runtime.import_ms,
        last_outcome: runtime.last_outcome,
        checking: state.checking.load(Ordering::SeqCst),
        error: opened.err().or(runtime.error),
    }
}

#[tauri::command]
pub async fn library_status(app: AppHandle) -> Result<Status, String> {
    blocking(move || Ok(status_of(&app))).await
}

// ─── Search, shelves, entries ─────────────────────────────────────────

fn signals_for(
    app: &AppHandle,
    lib: &Library,
    ctx: &shelves::Context,
) -> Result<search::Signals, String> {
    let (profile, uses, affinity) = user_inputs(app)?;
    if ctx.show_everything || !profile.personalise_on() {
        return Ok(search::Signals {
            hidden: uses.hidden,
            ..Default::default()
        });
    }
    let stack = ctx
        .project_path
        .as_deref()
        .map(|p| detect_project(lib, p).0)
        .unwrap_or_default();
    Ok(shelves::signals(&profile, &uses, affinity, &stack, ctx))
}

#[tauri::command]
pub async fn library_search(
    app: AppHandle,
    request: search::SearchRequest,
    context: Option<shelves::Context>,
) -> Result<search::SearchPage, String> {
    blocking(move || {
        let lib = open(&app)?;
        let ctx = context.unwrap_or_default();
        let signals = signals_for(&app, &lib, &ctx)?;
        let r = lock(&lib.reader);
        search::search(&r, &request, Some(&signals))
    })
    .await
}

#[tauri::command]
pub async fn library_shelves(
    app: AppHandle,
    context: shelves::Context,
) -> Result<shelves::Shelves, String> {
    blocking(move || {
        let lib = open(&app)?;
        let (profile, uses, affinity) = user_inputs(&app)?;
        let (stack, agents) = context
            .project_path
            .as_deref()
            .map(|p| detect_project(&lib, p))
            .unwrap_or_default();
        let r = lock(&lib.reader);
        Ok(shelves::build(
            &r, profile, &uses, affinity, stack, agents, &context,
        ))
    })
    .await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryDetail {
    pub id: String,
    /// The id that was asked for, when it was an alias (an old built-in id).
    pub resolved_from: Option<String>,
    pub row: serde_json::Value,
    /// The body object `{schema, fm, body, steps}`.
    pub body: Option<serde_json::Value>,
    pub state: user_state::ItemState,
    pub is_new: bool,
}

#[tauri::command]
pub async fn library_get(app: AppHandle, id: String) -> Result<EntryDetail, String> {
    let lib = blocking({
        let app = app.clone();
        move || open(&app)
    })
    .await?;
    let (row, raw, body) = {
        let lib = Arc::clone(&lib);
        let id = id.clone();
        blocking(move || {
            let r = lock(&lib.reader);
            let stored =
                store::row_by_id(&r, &id).ok_or_else(|| format!("{id} is not in the library"))?;
            let raw: String = r
                .query_row(
                    "SELECT row FROM entry WHERE rowid = ?1",
                    [stored.rank],
                    |x| x.get(0),
                )
                .map_err(|e| e.to_string())?;
            let body = store::body(&r, &stored.row.body);
            Ok((stored.row, raw, body))
        })
        .await?
    };
    // Not cached (a later tier): fetched by hash, checked, kept.
    let body = match body {
        Some(b) => Some(b),
        None if setting(&app, "library_updates").as_deref() != Some("off") => {
            let hex = catalog::parse_ref(&row.body)?;
            let fetcher = update::HttpFetcher::new(update::mirrors())?;
            use update::Fetcher;
            match fetcher.get(&catalog::object_rel(&hex)).await {
                Ok(Some(bytes)) if catalog::sha256_hex(&bytes) == hex => {
                    store::store_body(&lock(&lib.writer), &hex, &bytes)?;
                    String::from_utf8(bytes).ok()
                }
                _ => None,
            }
        }
        None => None,
    };
    let state = with_db(&app, |c| {
        user_state::item_states(c)
            .into_iter()
            .find(|s| s.item_id == row.id)
    })?
    .unwrap_or(user_state::ItemState {
        item_id: row.id.clone(),
        ..Default::default()
    });
    let is_new = store::new_ids(&lock(&lib.reader)).contains(&row.id);
    Ok(EntryDetail {
        resolved_from: (row.id != id).then_some(id),
        id: row.id.clone(),
        row: serde_json::from_str(&raw).unwrap_or_default(),
        body: body.and_then(|b| serde_json::from_str(&b).ok()),
        state,
        is_new,
    })
}

/// Rows for a list of ids (pinned, installed), in that order, with reasons.
#[tauri::command]
pub async fn library_hits(
    app: AppHandle,
    ids: Vec<String>,
    context: Option<shelves::Context>,
) -> Result<Vec<search::Hit>, String> {
    blocking(move || {
        let lib = open(&app)?;
        let ctx = context.unwrap_or_default();
        let mut signals = signals_for(&app, &lib, &ctx)?;
        // Asked for by id: shown even when hidden.
        signals.hidden.clear();
        let r = lock(&lib.reader);
        Ok(search::hits_for_ids(&r, &ids, &signals))
    })
    .await
}

/// Old ids (built-in templates, roles, styles, pins) -> library ids, for
/// the ones the catalog carries as an id or an alias.
#[tauri::command]
pub async fn library_resolve(
    app: AppHandle,
    ids: Vec<String>,
) -> Result<HashMap<String, String>, String> {
    blocking(move || {
        let lib = open(&app)?;
        let r = lock(&lib.reader);
        Ok(ids
            .into_iter()
            .filter_map(|id| store::resolve_id(&r, &id).map(|to| (id, to)))
            .collect())
    })
    .await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabLists {
    pub facets: HashMap<String, Vec<shelves::Labeled>>,
}

/// Labels of facet values (role, domain, category, subject, stack) for the
/// pickers, and live counts for domains.
#[tauri::command]
pub async fn library_vocab(app: AppHandle, facets: Vec<String>) -> Result<VocabLists, String> {
    blocking(move || {
        let lib = open(&app)?;
        let vocab = store::vocab(&lock(&lib.reader));
        let mut out = HashMap::new();
        for f in facets {
            let mut values: Vec<shelves::Labeled> = vocab
                .facets
                .get(&f)
                .map(|fv| {
                    fv.labels
                        .iter()
                        .map(|(v, l)| shelves::Labeled {
                            value: v.clone(),
                            label: l.clone(),
                        })
                        .collect()
                })
                .unwrap_or_default();
            values.sort_by(|a, b| a.label.cmp(&b.label));
            out.insert(f, values);
        }
        Ok(VocabLists { facets: out })
    })
    .await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detected {
    pub stack: Vec<shelves::Labeled>,
    pub agents: Vec<String>,
}

#[tauri::command]
pub async fn library_detect(app: AppHandle, path: String) -> Result<Detected, String> {
    blocking(move || {
        let lib = open(&app)?;
        let (stack, agents) = detect_project(&lib, &path);
        let vocab = store::vocab(&lock(&lib.reader));
        Ok(Detected {
            stack: stack
                .iter()
                .map(|v| shelves::Labeled {
                    value: v.clone(),
                    label: vocab.label("stack", v).to_string(),
                })
                .collect(),
            agents,
        })
    })
    .await
}

// ─── What the person does ─────────────────────────────────────────────

#[tauri::command]
pub async fn library_record_use(app: AppHandle, id: String) -> Result<(), String> {
    blocking(move || {
        let lib = open(&app)?;
        let row = store::row_by_id(&lock(&lib.reader), &id).map(|s| s.row);
        let Some(row) = row else { return Ok(()) };
        with_db(&app, |c| {
            let learn = user_state::read_profile(c).learning_on();
            user_state::record_use(c, &row, learn, user_state::now_secs())
        })?
    })
    .await
}

#[tauri::command]
pub async fn library_set_item(
    app: AppHandle,
    id: String,
    pinned: Option<bool>,
    favorite: Option<bool>,
    hidden: Option<bool>,
) -> Result<(), String> {
    blocking(move || {
        // Stored under the canonical id: an alias pins its entry.
        let canonical = open(&app)
            .ok()
            .and_then(|lib| store::resolve_id(&lock(&lib.reader), &id))
            .unwrap_or(id);
        with_db(&app, |c| {
            user_state::set_flags(c, &canonical, pinned, favorite, hidden)
        })?
    })
    .await
}

#[tauri::command]
pub async fn library_item_states(app: AppHandle) -> Result<Vec<user_state::ItemState>, String> {
    blocking(move || with_db(&app, user_state::item_states)).await
}

#[tauri::command]
pub async fn library_get_profile(app: AppHandle) -> Result<user_state::Profile, String> {
    blocking(move || with_db(&app, user_state::read_profile)).await
}

#[tauri::command]
pub async fn library_set_profile(
    app: AppHandle,
    profile: user_state::Profile,
) -> Result<(), String> {
    blocking(move || with_db(&app, |c| user_state::write_profile(c, &profile))?).await
}

#[tauri::command]
pub async fn library_reset_personalisation(app: AppHandle) -> Result<(), String> {
    blocking(move || with_db(&app, user_state::reset)?).await
}

// ─── Updates ──────────────────────────────────────────────────────────

fn now() -> i64 {
    user_state::now_secs()
}

fn ignored_versions(app: &AppHandle) -> Vec<String> {
    setting(app, "library_ignored_versions")
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default()
}

/// One check, as the background task or "Check now" runs it.
pub async fn run_check(app: &AppHandle, manual: bool, apply_now: Option<bool>) -> update::Outcome {
    let mode = setting(app, "library_updates").unwrap_or_else(|| "auto".into());
    if mode == "off" && !manual {
        return update::Outcome::Off;
    }
    let state = app.state::<LibraryState>();
    if state.checking.swap(true, Ordering::SeqCst) {
        return update::Outcome::Failed {
            reason: "a check is already running".into(),
        };
    }
    let outcome = check_inner(app, manual, apply_now.unwrap_or(mode == "auto" || manual)).await;
    state.checking.store(false, Ordering::SeqCst);
    let t = now().to_string();
    set_setting(app, "library_last_check", &t);
    match &outcome {
        update::Outcome::Applied { .. }
        | update::Outcome::UpToDate { .. }
        | update::Outcome::Available { .. } => {
            set_setting(app, "library_last_success", &t);
            set_setting(app, "library_last_error", "");
        }
        o if o.awaiting_signed_release() => {
            log::info!(
                "[library] update: the catalog has no signed release yet; keeping the one here"
            );
            set_setting(app, "library_last_success", &t);
            set_setting(app, "library_last_error", "");
        }
        update::Outcome::Refused { reason, .. } | update::Outcome::Failed { reason } => {
            log::warn!("[library] update: {reason}");
            set_setting(app, "library_last_error", reason);
        }
        update::Outcome::Off => {}
    }
    lock(&state.runtime).last_outcome = Some(outcome.clone());
    if let update::Outcome::Applied { summary, .. } = &outcome {
        let _ = app.emit(UPDATED_EVENT, summary);
    }
    outcome
}

async fn check_inner(app: &AppHandle, _manual: bool, apply_now: bool) -> update::Outcome {
    let lib = match blocking({
        let app = app.clone();
        move || open(&app)
    })
    .await
    {
        Ok(l) => l,
        Err(e) => return update::Outcome::Failed { reason: e },
    };
    let fetcher: Arc<dyn update::Fetcher> = match update::HttpFetcher::new(update::mirrors()) {
        Ok(f) => Arc::new(f),
        Err(e) => return update::Outcome::Failed { reason: e },
    };
    let (current, known) = {
        let w = lock(&lib.writer);
        (
            store::info(&w).map(|i| (i.catalog, i.seq)),
            store::known_bodies(&w),
        )
    };
    let ignored = ignored_versions(app);
    let local = |hex: &str| store::stored_object(&lock(&lib.writer), hex);
    let lib2 = Arc::clone(&lib);
    let mut apply =
        move |cat: &catalog::VerifiedCatalog| store::apply(&mut lock(&lib2.writer), cat, "update");
    update::check(
        fetcher,
        &verify::trusted_keys(),
        current,
        &ignored,
        &local,
        &known,
        apply_now,
        &mut apply,
    )
    .await
}

#[tauri::command]
pub async fn library_check_update(
    app: AppHandle,
    apply: Option<bool>,
) -> Result<update::Outcome, String> {
    Ok(run_check(&app, true, apply).await)
}

#[tauri::command]
pub async fn library_rollback(app: AppHandle) -> Result<store::ApplySummary, String> {
    blocking(move || {
        let lib = open(&app)?;
        let before = store::info(&lock(&lib.reader)).map(|i| format!("{}@{}", i.catalog, i.seq));
        let summary = {
            let mut w = lock(&lib.writer);
            match update::rollback(&mut w) {
                Ok(s) => s,
                // Nothing earlier was kept: the bundled catalog is the floor.
                Err(_) => {
                    let archive =
                        archive_path(&app).ok_or("there is no earlier catalog to go back to")?;
                    store::apply(&mut w, &read_bundled(&archive)?, "bundled")?
                }
            }
        };
        // Do not take the rolled-back version again on the next check.
        if let Some(v) = before {
            let mut ignored = ignored_versions(&app);
            if !ignored.contains(&v) {
                ignored.push(v);
            }
            set_setting(
                &app,
                "library_ignored_versions",
                &serde_json::to_string(&ignored).unwrap_or_default(),
            );
        }
        let _ = app.emit(UPDATED_EVENT, &summary);
        Ok(summary)
    })
    .await
}

/// The background task: a first look 5 s after launch, then hourly; it only
/// downloads when 12 hours have passed since the last successful check.
pub fn start_updates(app: &AppHandle) {
    #[cfg(feature = "e2e")]
    if std::env::var("HERMES_E2E_LIBRARY_URL")
        .map(|v| v.is_empty())
        .unwrap_or(true)
    {
        // Test runs never reach the real catalog on their own.
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let first = std::env::var("HERMES_LIBRARY_FIRST_CHECK_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(5);
        tokio::time::sleep(std::time::Duration::from_secs(first)).await;
        loop {
            let mode = setting(&app, "library_updates").unwrap_or_else(|| "auto".into());
            let last_check = setting(&app, "library_last_check").and_then(|v| v.parse().ok());
            let last_success = setting(&app, "library_last_success").and_then(|v| v.parse().ok());
            // A build that trusts no key would refuse every download, so it
            // makes none. "Check now" still asks and shows the refusal.
            let signed = !verify::trusted_keys().is_empty();
            if mode != "off" && signed && update::due(now(), last_check, last_success) {
                let outcome = run_check(&app, false, None).await;
                log::info!("[library] update check: {outcome:?}");
            }
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        }
    });
}

// ─── Install into a project ───────────────────────────────────────────

#[tauri::command]
pub async fn library_install_preview(
    project_path: String,
    files: Vec<install::CompiledFile>,
) -> Result<install::InstallPlan, String> {
    blocking(move || install::plan(Path::new(&project_path), &files)).await
}

#[tauri::command]
pub async fn library_install_apply(
    app: AppHandle,
    project_path: String,
    agent_id: String,
    files: Vec<install::CompiledFile>,
) -> Result<install::InstallResult, String> {
    blocking(move || {
        let root = PathBuf::from(&project_path);
        let result = install::apply(&root, &files)?;
        let t = now();
        with_db(&app, |c| {
            for e in &result.entries {
                let _ = user_state::record_install(
                    c,
                    &user_state::InstallRecord {
                        project_path: project_path.clone(),
                        item_id: e.id.clone(),
                        agent_id: agent_id.clone(),
                        version: e.version.clone(),
                        path: e.path.clone(),
                        hash: e.hash.clone(),
                        installed_at: t,
                    },
                );
            }
        })?;
        if let Some(first) = files.first() {
            if let Ok(lib) = open(&app) {
                if let Some(row) = store::row_by_id(&lock(&lib.reader), &first.id).map(|s| s.row) {
                    let _ = with_db(&app, |c| {
                        user_state::record_use(
                            c,
                            &row,
                            user_state::read_profile(c).learning_on(),
                            t,
                        )
                    });
                }
            }
        }
        Ok(result)
    })
    .await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInstalls {
    pub lock: install::Lock,
    pub records: Vec<user_state::InstallRecord>,
}

#[tauri::command]
pub async fn library_installs(
    app: AppHandle,
    project_path: Option<String>,
) -> Result<ProjectInstalls, String> {
    blocking(move || {
        let lock = project_path
            .as_deref()
            .map(|p| install::read_lock(Path::new(p)))
            .unwrap_or(install::Lock {
                schema: 1,
                entries: Vec::new(),
            });
        let records = with_db(&app, |c| user_state::installs(c, project_path.as_deref()))?;
        Ok(ProjectInstalls { lock, records })
    })
    .await
}

#[tauri::command]
pub async fn library_uninstall(
    app: AppHandle,
    project_path: String,
    item_id: String,
    target: String,
    agent_id: String,
) -> Result<Vec<String>, String> {
    blocking(move || {
        let kept = install::uninstall(Path::new(&project_path), &item_id, &target)?;
        with_db(&app, |c| {
            user_state::remove_install(c, &project_path, &item_id, &agent_id)
        })??;
        Ok(kept)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_lock_pins_a_catalog() {
        let lock = bundled_lock().expect("prompt-library.lock.json parses");
        assert_eq!(lock.manifest_sha256.len(), 64);
        assert!(lock.seq > 0);
    }

    /// The real bundled catalog, when it has been fetched: it verifies,
    /// imports, and answers searches within budget.
    #[test]
    fn the_bundled_catalog_imports_and_searches() {
        let archive = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("library")
            .join(ARCHIVE_NAME);
        if !archive.is_file() {
            eprintln!(
                "skipped: {} not fetched (npm run prepare:library)",
                archive.display()
            );
            return;
        }
        let started = Instant::now();
        let cat = read_bundled(&archive).unwrap();
        let mut conn = store::open_in_memory().unwrap();
        let s = store::apply(&mut conn, &cat, "bundled").unwrap();
        let import_ms = started.elapsed().as_millis();
        let lock = bundled_lock().unwrap();
        assert_eq!(s.catalog, lock.catalog);
        assert_eq!(store::info(&conn).unwrap().rows as usize, cat.rows.len());
        let lock_rows =
            serde_json::from_str::<serde_json::Value>(LOCK_JSON).unwrap()["rows"].as_i64();
        assert_eq!(Some(cat.rows.len() as i64), lock_rows);
        // Every tier the manifest lists is imported, each row under its own.
        for (tier, tier_ref) in &cat.manifest.tiers {
            let stored: i64 = conn
                .query_row(
                    "SELECT count(*) FROM entry WHERE tier = ?1",
                    [catalog::tier_order(tier)],
                    |r| r.get(0),
                )
                .unwrap();
            eprintln!("{tier}: {stored} rows");
            assert_eq!(Some(stored), tier_ref.rows, "{tier}");
        }
        // Every body is there: the library works offline.
        let bodies: i64 = conn
            .query_row("SELECT count(*) FROM body_cache", [], |r| r.get(0))
            .unwrap();
        assert_eq!(bodies as usize, cat.rows.len());
        let page = search::search(
            &conn,
            &search::SearchRequest {
                query: "review pull request".into(),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert!(
            page.hits.iter().any(|h| h.id == "review-pull-request"),
            "{:?}",
            page.hits.iter().map(|h| &h.id).collect::<Vec<_>>()
        );
        eprintln!("import {import_ms} ms, search {:.2} ms", page.took_ms);
        assert!(import_ms < 5000, "import took {import_ms} ms");
    }
}
