//! The session host (N20): sessions survive quit, update and crash.
//!
//! With the `sessionHost` feature flag on, terminals are opened in
//! `hermes-pty-host`, a small background process (src-tauri/pty-host) that
//! owns the PTYs and their programs. The app attaches to it over a user-only
//! Unix socket, and when the app comes back — after a quit, an update or a
//! crash — it reattaches to the sessions the host still has, replays the
//! output it missed and nudges the program to repaint.
//!
//! The host runs from a versioned copy under the app's data folder, never
//! from the install folder, so replacing the app (an update) leaves the
//! running host untouched. It exits on its own once it has no sessions.
//!
//! Security: the socket lives in folders only the user can enter (0700),
//! each one created and verified (not a symlink, this uid, no group/other
//! bits) before use because the root may be the shared `/tmp`; every
//! connection must present the token from `<data>/host/token` (0600), and
//! the host checks the connecting process's uid. Anyone who could connect
//! could type into an agent. A socket that answers but cannot be used is
//! left alone (a live host may be behind it); only one nobody listens on
//! is replaced.
//!
//! macOS and Linux first; on Windows this module reports "unsupported" and
//! sessions stay in-process (ConPTY cannot move between processes; a
//! Windows host is a follow-up).

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

use crate::pty::models::{SessionPhase, SessionUpdate};
use crate::pty::PtyManager;
use crate::AppState;

/// Frontend event asking whether to keep working agents running on quit.
pub const QUIT_REQUESTED_EVENT: &str = "session-host-quit-requested";

/// Frontend event: the flag is on but this session had to open in-process
/// (the host could not be reached or used), so it will not survive the app.
pub const FALLBACK_EVENT: &str = "session-host-fallback";

#[derive(Debug, Clone, Serialize)]
pub struct HostFallback {
    pub session_id: String,
    pub reason: String,
}

/// What this app decided about hosted sessions on quit: `Some(true)` keeps
/// them running, `Some(false)` stops them, `None` is not decided yet.
#[derive(Default)]
pub struct SessionHostState {
    pub quit_decision: Mutex<Option<bool>>,
}

/// Where the host's files live for one app instance.
#[derive(Debug, Clone)]
pub struct HostPaths {
    /// `<data>/host`: token, log, versioned copies of the host binary.
    pub host_dir: PathBuf,
    pub bin_dir: PathBuf,
    pub token_file: PathBuf,
    pub log_file: PathBuf,
    /// A short, user-only folder (Unix socket paths are limited to about
    /// 100 bytes), keyed by the data folder so instances never share a host.
    pub socket_dir: PathBuf,
    pub socket: PathBuf,
}

/// The socket root: `HERMES_HOST_SOCKET_ROOT` (the test rig), else the
/// user's own runtime folder — `$XDG_RUNTIME_DIR` on Linux, the per-user
/// temp folder (`confstr(_CS_DARWIN_USER_TEMP_DIR)`) on macOS — and only
/// when neither exists the shared `/tmp`, where every folder Hermes owns is
/// verified before use (`unix::ensure_socket_dirs`). Not `TMPDIR`: a test
/// run gives every launch a fresh one, and the socket has to be found again
/// after a relaunch.
pub fn socket_root() -> PathBuf {
    if let Some(root) = std::env::var_os("HERMES_HOST_SOCKET_ROOT").filter(|v| !v.is_empty()) {
        return PathBuf::from(root);
    }
    #[cfg(unix)]
    {
        user_runtime_dir().unwrap_or_else(|| PathBuf::from("/tmp"))
    }
    #[cfg(not(unix))]
    {
        std::env::temp_dir()
    }
}

/// A folder the system already keeps private to this user, when it has one.
#[cfg(target_os = "linux")]
fn user_runtime_dir() -> Option<PathBuf> {
    let dir = std::env::var_os("XDG_RUNTIME_DIR").filter(|v| !v.is_empty())?;
    let dir = PathBuf::from(dir);
    dir.is_dir().then_some(dir)
}

#[cfg(target_os = "macos")]
fn user_runtime_dir() -> Option<PathBuf> {
    let mut buf = vec![0u8; libc::PATH_MAX as usize];
    let len = unsafe {
        libc::confstr(
            libc::_CS_DARWIN_USER_TEMP_DIR,
            buf.as_mut_ptr() as *mut libc::c_char,
            buf.len(),
        )
    };
    if len == 0 || len > buf.len() {
        return None;
    }
    buf.truncate(len - 1); // the NUL
    let dir = PathBuf::from(String::from_utf8(buf).ok()?);
    dir.is_dir().then_some(dir)
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn user_runtime_dir() -> Option<PathBuf> {
    None
}

pub fn paths_for(data_dir: &Path, socket_root: &Path) -> HostPaths {
    let host_dir = data_dir.join("host");
    let hash = crate::instance::instance_hash(data_dir);
    #[cfg(unix)]
    let uid = unsafe { libc::getuid() };
    #[cfg(not(unix))]
    let uid = 0u32;
    let socket_dir = socket_root
        .join(format!("hermes-host-{uid}"))
        .join(format!("{hash:016x}"));
    HostPaths {
        bin_dir: host_dir.join("bin"),
        token_file: host_dir.join("token"),
        log_file: host_dir.join("host.log"),
        socket: socket_dir.join("host.sock"),
        socket_dir,
        host_dir,
    }
}

pub fn paths(app: &AppHandle) -> Result<HostPaths, String> {
    let data_dir = crate::instance::app_data_dir(app)?;
    let paths = paths_for(&data_dir, &socket_root());
    // Unix socket paths are limited to about 100 bytes: a long user folder
    // falls back to the shared temp root (verified before use). A root the
    // rig chose is used as given.
    let rig_root = std::env::var_os("HERMES_HOST_SOCKET_ROOT").is_some_and(|v| !v.is_empty());
    if cfg!(unix) && !rig_root && paths.socket.as_os_str().len() > 100 {
        return Ok(paths_for(&data_dir, Path::new("/tmp")));
    }
    Ok(paths)
}

/// The app version the host copy is keyed by. A test build can pretend to
/// be another version, to prove an update reattaches to a running host.
pub fn app_version(app: &AppHandle) -> String {
    #[cfg(feature = "e2e")]
    if let Ok(v) = std::env::var("HERMES_E2E_APP_VERSION") {
        if !v.trim().is_empty() {
            return v.trim().to_string();
        }
    }
    app.package_info().version.to_string()
}

/// Whether this platform has a session host.
pub const fn supported() -> bool {
    cfg!(unix)
}

/// The host binary shipped with the app: next to the executable (dev, test
/// rig, macOS bundle) or under the bundle's `helpers` resources (Linux).
pub fn shipped_host_binary(app: &AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    let name = if cfg!(windows) {
        "hermes-pty-host.exe"
    } else {
        "hermes-pty-host"
    };
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    if let Ok(resources) = app.path().resource_dir() {
        for candidate in [resources.join("helpers").join(name), resources.join(name)] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// The folder name of the versioned copy for this app version and binary.
pub fn copy_key(version: &str, binary: &[u8]) -> String {
    let hash = crate::instance::fnv1a_hash(binary);
    let mut safe: String = version
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    // A folder name, never a path: no separators, no ".." runs.
    while safe.contains("..") {
        safe = safe.replace("..", "_");
    }
    format!("{safe}-{:08x}", (hash & 0xffff_ffff) as u32)
}

/// Copies the shipped host binary to `<bin_dir>/<key>/hermes-pty-host`
/// unless that copy exists, and keeps only the newest few copies (a running
/// host keeps its own file open; on Unix a removed file stays readable).
pub fn install_copy(shipped: &Path, bin_dir: &Path, version: &str) -> Result<PathBuf, String> {
    let bytes = std::fs::read(shipped).map_err(|e| format!("read {}: {e}", shipped.display()))?;
    let key = copy_key(version, &bytes);
    let dir = bin_dir.join(&key);
    let name = shipped
        .file_name()
        .ok_or_else(|| "host binary has no file name".to_string())?;
    let target = dir.join(name);
    if !target.is_file() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        let tmp = dir.join(format!(
            ".{}.{}",
            name.to_string_lossy(),
            std::process::id()
        ));
        std::fs::write(&tmp, &bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
        }
        std::fs::rename(&tmp, &target).map_err(|e| format!("install {}: {e}", target.display()))?;
        log::info!("[session-host] installed host copy {}", target.display());
    }
    prune_copies(bin_dir, &key, 3);
    Ok(target)
}

fn prune_copies(bin_dir: &Path, keep_key: &str, keep_newest: usize) {
    let Ok(entries) = std::fs::read_dir(bin_dir) else {
        return;
    };
    let mut dirs: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|e| e.file_name() != keep_key)
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            meta.is_dir()
                .then(|| (meta.modified().unwrap_or(std::time::UNIX_EPOCH), e.path()))
        })
        .collect();
    dirs.sort_by_key(|d| std::cmp::Reverse(d.0));
    for (_, dir) in dirs.into_iter().skip(keep_newest.saturating_sub(1)) {
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct HostSessionStatus {
    pub id: String,
    pub pid: u32,
    pub alive: bool,
    pub attached: bool,
}

/// What the frontend (and the test rig) can ask about the host.
#[derive(Debug, Clone, Serialize)]
pub struct HostStatus {
    pub supported: bool,
    pub running: bool,
    pub pid: Option<u32>,
    pub exe: Option<String>,
    pub host_version: Option<String>,
    pub app_version: String,
    pub socket: String,
    pub bin_dir: String,
    pub sessions: Vec<HostSessionStatus>,
    /// Sessions of this app that live in the host.
    pub hosted_session_ids: Vec<String>,
    /// Hosted sessions with an agent at work (the ones quit asks about).
    pub working_session_ids: Vec<String>,
    pub quit_decision: Option<bool>,
}

/// Hosted sessions whose program is busy or has an agent in it: quitting
/// asks whether to keep these running.
pub fn working_hosted_sessions(mgr: &PtyManager) -> Vec<SessionUpdate> {
    let mut out: Vec<SessionUpdate> = mgr
        .sessions
        .values()
        .filter(|ps| ps.transport.hosted())
        .filter_map(|ps| {
            let s = ps.session.lock().ok()?;
            let live = !matches!(
                s.phase,
                SessionPhase::Destroyed | SessionPhase::Disconnected | SessionPhase::Closing
            );
            let working = matches!(
                s.phase,
                SessionPhase::Busy | SessionPhase::NeedsInput | SessionPhase::LaunchingAgent
            ) || s.detected_agent.is_some();
            (live && working).then(|| SessionUpdate::from(&*s))
        })
        .collect();
    out.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    out
}

fn hosted_session_ids(mgr: &PtyManager) -> Vec<String> {
    let mut ids: Vec<String> = mgr
        .sessions
        .iter()
        .filter(|(_, ps)| ps.transport.hosted())
        .map(|(id, _)| id.clone())
        .collect();
    ids.sort();
    ids
}

/// Ends every hosted session's program (the host then exits on its own).
pub fn stop_all_hosted(state: &AppState) {
    let mut mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
    for (id, ps) in mgr.sessions.iter_mut() {
        if ps.transport.hosted() {
            if let Err(e) = ps.transport.kill() {
                log::warn!("[session-host] could not stop {id}: {e}");
            }
        }
    }
}

/// Called on every exit request. Returns true when the exit must wait for
/// the user's answer (the frontend shows the keep-or-stop dialog).
pub fn on_exit_requested(app: &AppHandle) -> bool {
    use tauri::Manager;
    let Some(state) = app.try_state::<AppState>() else {
        return false;
    };
    let decision = app
        .try_state::<SessionHostState>()
        .and_then(|s| s.quit_decision.lock().ok().map(|d| *d))
        .unwrap_or(None);
    let working = {
        let mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
        working_hosted_sessions(&mgr)
    };
    match decision {
        None if !working.is_empty() => {
            log::info!(
                "[session-host] quit requested with {} working hosted session(s); asking",
                working.len()
            );
            let _ = app.emit(QUIT_REQUESTED_EVENT, &working);
            true
        }
        Some(true) => {
            log::info!("[session-host] quitting; hosted sessions keep running");
            false
        }
        // Nothing is working, or the user chose to stop: the exit goes
        // ahead, and the hosted sessions end once the workspace is saved
        // (stop_hosted_unless_kept) — stopping them now would let the save
        // see them ended and leave them out of the workspace.
        _ => false,
    }
}

/// Called when the exit really goes ahead, after the workspace was saved:
/// hosted sessions end with the app, as in-process ones always did, unless
/// the person chose to keep them running. Sessions still working without an
/// answer (an exit that could not ask) are left running.
pub fn stop_hosted_unless_kept(app: &AppHandle) {
    use tauri::Manager;
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let decision = app
        .try_state::<SessionHostState>()
        .and_then(|s| s.quit_decision.lock().ok().map(|d| *d))
        .unwrap_or(None);
    let stop = match decision {
        Some(keep) => !keep,
        None => {
            let mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
            working_hosted_sessions(&mgr).is_empty()
        }
    };
    if stop {
        stop_all_hosted(&state);
    }
}

/// Async: it talks to the host with a timeout, and a hung host must not
/// freeze the window (the close button asks this before it closes).
#[tauri::command]
pub async fn session_host_status(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<HostStatus, String> {
    use tauri::Manager;
    let paths = paths(&app)?;
    let (hosted, working) = {
        let mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
        (
            hosted_session_ids(&mgr),
            working_hosted_sessions(&mgr)
                .into_iter()
                .map(|s| s.id)
                .collect::<Vec<_>>(),
        )
    };
    let quit_decision = app
        .try_state::<SessionHostState>()
        .and_then(|s| s.quit_decision.lock().ok().map(|d| *d))
        .unwrap_or(None);
    // Only a Unix build fills the host part in below.
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut status = HostStatus {
        supported: supported(),
        running: false,
        pid: None,
        exe: None,
        host_version: None,
        app_version: app_version(&app),
        socket: paths.socket.to_string_lossy().to_string(),
        bin_dir: paths.bin_dir.to_string_lossy().to_string(),
        sessions: Vec::new(),
        hosted_session_ids: hosted,
        working_session_ids: working,
        quit_decision,
    };
    #[cfg(unix)]
    if let Ok(mut conn) = unix::connect(&paths, std::time::Duration::from_secs(2)) {
        let info = conn.info().clone();
        status.running = true;
        status.pid = Some(info.pid);
        status.exe = Some(info.exe);
        status.host_version = Some(info.version);
        if let Ok(list) = conn.list() {
            status.sessions = list
                .into_iter()
                .map(|s| HostSessionStatus {
                    id: s.id,
                    pid: s.pid,
                    alive: s.alive,
                    attached: s.attached,
                })
                .collect();
        }
    }
    Ok(status)
}

/// The user's answer to "keep running or stop?": remember it and quit
/// (the exit acts on it once the workspace is saved). The exit request then goes through.
#[tauri::command]
pub fn session_host_quit(
    app: AppHandle,
    host_state: State<'_, SessionHostState>,
    keep_running: bool,
) -> Result<(), String> {
    if let Ok(mut d) = host_state.quit_decision.lock() {
        *d = Some(keep_running);
    }
    // The programs are stopped once the exit goes ahead, after the
    // workspace is saved (stop_hosted_unless_kept).
    log::info!(
        "[session-host] quit: {}",
        if keep_running {
            "keep hosted sessions running"
        } else {
            "stop hosted sessions"
        }
    );
    crate::save_workspace_state(&app);
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(50));
        app2.exit(0);
    });
    Ok(())
}

/// Ends every hosted program without quitting.
#[tauri::command]
pub fn session_host_stop_all(state: State<'_, AppState>) -> Result<(), String> {
    stop_all_hosted(&state);
    Ok(())
}

/// Session ids a running host still has, without starting one. Empty when
/// there is no host. Used at startup to keep those sessions' launch files.
pub fn live_hosted_session_ids(app: &AppHandle) -> Vec<String> {
    #[cfg(unix)]
    {
        let Ok(paths) = paths(app) else {
            return Vec::new();
        };
        match unix::connect(&paths, std::time::Duration::from_secs(2)) {
            Ok(mut conn) => conn
                .list()
                .map(|l| l.into_iter().map(|s| s.id).collect())
                .unwrap_or_default(),
            Err(_) => Vec::new(),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = app;
        Vec::new()
    }
}

/// A terminal opened through the host: attached to a session the host still
/// had (`reattached`), or freshly spawned there.
pub struct HostedOpen {
    pub transport: Box<dyn crate::pty::transport::PtyTransport>,
    pub reattached: bool,
    /// The program had already ended when the app came back.
    pub ended_before_attach: Option<Option<i32>>,
}

#[cfg(unix)]
pub use unix::{has_session, open_hosted};

#[cfg(not(unix))]
pub fn has_session(_app: &AppHandle, _session_id: &str) -> bool {
    false
}

#[cfg(not(unix))]
pub fn open_hosted(
    _app: &AppHandle,
    _session_id: &str,
    _cmd: Option<&portable_pty::CommandBuilder>,
    _rows: u16,
    _cols: u16,
) -> Result<HostedOpen, String> {
    Err("the session host is not available on this platform yet".to_string())
}

#[cfg(unix)]
mod unix {
    use super::*;
    use hermes_pty_host::client::Connection;
    use std::os::unix::fs::PermissionsExt;
    use std::time::{Duration, Instant};

    fn read_token(paths: &HostPaths) -> Result<String, String> {
        std::fs::read_to_string(&paths.token_file)
            .map(|t| t.trim().to_string())
            .map_err(|e| format!("read host token: {e}"))
    }

    /// Connects to a running host; never starts one. The socket's folders
    /// are verified first (as `connect_or_start` does), so a folder planted
    /// under a shared root never receives the token.
    pub fn connect(paths: &HostPaths, timeout: Duration) -> Result<Connection, String> {
        if std::fs::symlink_metadata(&paths.socket).is_err() {
            return Err("no host socket".to_string());
        }
        ensure_socket_dirs(paths)?;
        let token = read_token(paths)?;
        Connection::connect(&paths.socket, &token, timeout).map_err(|e| e.to_string())
    }

    /// Creates and verifies every folder Hermes owns on the way to the
    /// socket: `<root>/hermes-host-<uid>` and its `<hash>` child. Each must
    /// be a real folder (not a symlink) of this user, mode 0700; anything
    /// else is refused, because a folder another user planted under the
    /// shared root could point the app at a fake host. The root itself
    /// (`/tmp`, the user's runtime folder, or the rig's) is not ours.
    pub(super) fn ensure_socket_dirs(paths: &HostPaths) -> Result<(), String> {
        use hermes_pty_host::privdir::ensure_private_dir;
        if let Some(parent) = paths.socket_dir.parent() {
            ensure_private_dir(parent).map_err(|e| e.to_string())?;
        }
        ensure_private_dir(&paths.socket_dir).map_err(|e| e.to_string())
    }

    fn ensure_private_dir(dir: &Path) -> Result<(), String> {
        if let Some(parent) = dir.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
        hermes_pty_host::privdir::ensure_private_dir(dir).map_err(|e| e.to_string())
    }

    fn ensure_token(paths: &HostPaths) -> Result<String, String> {
        if let Ok(t) = read_token(paths) {
            if t.len() >= 32 {
                return Ok(t);
            }
        }
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let tmp = paths
            .host_dir
            .join(format!(".token.{}", std::process::id()));
        std::fs::write(&tmp, format!("{token}\n")).map_err(|e| format!("write token: {e}"))?;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod token: {e}"))?;
        std::fs::rename(&tmp, &paths.token_file).map_err(|e| format!("install token: {e}"))?;
        Ok(token)
    }

    /// What a connection attempt found at the socket.
    pub(super) enum Found {
        Host(Connection),
        /// No socket file, or nobody listening behind it: safe to start a
        /// host (and to remove the file).
        NobodyListening,
        /// Something answered but the connection could not be used: another
        /// protocol version, a bad token, a handshake timeout. A live host
        /// may be behind it, so its socket must be left alone.
        Unusable(String),
    }

    pub(super) fn try_connect(socket: &Path, token: &str, timeout: Duration) -> Found {
        match Connection::connect(socket, token, timeout) {
            Ok(conn) => Found::Host(conn),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
                ) =>
            {
                Found::NobodyListening
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                Found::Unusable(format!(
                    "it did not answer within {} s",
                    timeout.as_secs_f64()
                ))
            }
            Err(e) => Found::Unusable(e.to_string()),
        }
    }

    /// Connects to the host, starting it (from a versioned copy) if needed.
    pub fn connect_or_start(app: &AppHandle) -> Result<Connection, String> {
        let paths = paths(app)?;
        ensure_private_dir(&paths.host_dir)?;
        ensure_socket_dirs(&paths)?;
        let token = ensure_token(&paths)?;
        connect_or_start_with(&paths, &token, || start_host(app, &paths))
    }

    /// The connect-or-start decision, apart from the app: a socket nobody
    /// listens on is stale and replaced by a new host; a socket that
    /// answers but cannot be used (another protocol, a bad token, a slow
    /// handshake) is left alone and reported, so an update never unlinks
    /// the socket of a host that is still running the user's agents.
    pub(super) fn connect_or_start_with(
        paths: &HostPaths,
        token: &str,
        start: impl FnOnce() -> Result<(), String>,
    ) -> Result<Connection, String> {
        match try_connect(&paths.socket, token, Duration::from_secs(2)) {
            Found::Host(conn) => return Ok(conn),
            Found::Unusable(why) => {
                return Err(format!(
                    "a session host is listening on {} but cannot be used ({why}); \
                     its sessions are left as they are",
                    paths.socket.display()
                ));
            }
            Found::NobodyListening => {}
        }
        if paths.socket.exists() {
            log::info!("[session-host] stale socket (nobody listening), removing it");
            let _ = std::fs::remove_file(&paths.socket);
        }
        start()?;
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            match try_connect(&paths.socket, token, Duration::from_secs(2)) {
                Found::Host(conn) => return Ok(conn),
                Found::Unusable(why) => {
                    return Err(format!("the session host just started refused us: {why}"))
                }
                Found::NobodyListening if Instant::now() >= deadline => {
                    return Err("the session host did not answer".to_string())
                }
                Found::NobodyListening => std::thread::sleep(Duration::from_millis(50)),
            }
        }
    }

    /// Starts a host from a versioned copy of the shipped binary.
    fn start_host(app: &AppHandle, paths: &HostPaths) -> Result<(), String> {
        let shipped = shipped_host_binary(app)
            .ok_or_else(|| "the session host binary is missing from this install".to_string())?;
        let copy = install_copy(&shipped, &paths.bin_dir, &app_version(app))?;
        let log_file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&paths.log_file)
            .map_err(|e| format!("open host log: {e}"))?;
        let log_err = log_file.try_clone().map_err(|e| e.to_string())?;
        let child = std::process::Command::new(&copy)
            .arg("--dir")
            .arg(&paths.host_dir)
            .arg("--socket")
            .arg(&paths.socket)
            .stdin(std::process::Stdio::null())
            .stdout(log_file)
            .stderr(log_err)
            .spawn()
            .map_err(|e| format!("start {}: {e}", copy.display()))?;
        log::info!(
            "[session-host] started {} (pid {})",
            copy.display(),
            child.id()
        );
        // Not waited for: the host outlives this process on purpose.
        std::mem::drop(child);
        Ok(())
    }

    /// Whether a running host still has `session_id` (no host is started).
    pub fn has_session(app: &AppHandle, session_id: &str) -> bool {
        let Ok(paths) = paths(app) else {
            return false;
        };
        match connect(&paths, Duration::from_secs(2)) {
            Ok(mut conn) => conn
                .list()
                .map(|l| l.iter().any(|s| s.id == session_id))
                .unwrap_or(false),
            Err(_) => false,
        }
    }

    /// Opens `session_id` in the host: attaches when the host still has it,
    /// otherwise spawns `cmd` there (which must then be given).
    pub fn open_hosted(
        app: &AppHandle,
        session_id: &str,
        cmd: Option<&portable_pty::CommandBuilder>,
        rows: u16,
        cols: u16,
    ) -> Result<HostedOpen, String> {
        let mut conn = connect_or_start(app)?;
        // A session Hermes itself ended (quitting with nothing working stops
        // hosted terminals) is not reattached: like an in-process terminal,
        // the restore starts a new program under the same id.
        let existing = conn
            .list()
            .map_err(|e| format!("host list: {e}"))?
            .into_iter()
            .any(|s| s.id == session_id && !s.killed);
        if !existing {
            let cmd = cmd.ok_or_else(|| {
                format!("session {session_id} is not in the host and no command was given")
            })?;
            let argv: Vec<String> = cmd
                .get_argv()
                .iter()
                .map(|a| a.to_string_lossy().to_string())
                .collect();
            let env: Vec<(String, String)> = cmd
                .iter_full_env_as_str()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
            let cwd = cmd
                .get_cwd()
                .map(|c| c.to_string_lossy().to_string())
                .unwrap_or_default();
            conn.spawn(session_id, argv, env, &cwd, rows, cols)
                .map_err(|e| format!("host spawn: {e}"))?;
        }
        let attached = conn
            .attach(session_id, rows, cols)
            .map_err(|e| format!("host attach: {e}"))?;
        let hosted = crate::pty::transport::HostedPty::new(attached);
        let ended_before_attach = hosted.ended_before_attach;
        if existing {
            log::info!(
                "[session-host] reattached to {session_id} (replayed {} bytes)",
                hosted.replayed_bytes
            );
        }
        Ok(HostedOpen {
            transport: Box::new(hosted),
            reattached: existing,
            ended_before_attach,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_keyed_by_the_data_folder_and_short_enough_for_a_socket() {
        let root = Path::new("/tmp");
        let a = paths_for(Path::new("/fixture-home/data/hermes-a"), root);
        let b = paths_for(Path::new("/fixture-home/data/hermes-b"), root);
        assert_ne!(a.socket, b.socket, "two instances never share a host");
        assert_eq!(a, paths_for(Path::new("/fixture-home/data/hermes-a"), root));
        assert!(a.socket.starts_with(root));
        assert!(a.socket.to_string_lossy().len() < 100, "{:?}", a.socket);
        assert_eq!(a.token_file, a.host_dir.join("token"));
        assert!(a.bin_dir.starts_with(&a.host_dir));
    }

    impl PartialEq for HostPaths {
        fn eq(&self, other: &Self) -> bool {
            self.socket == other.socket && self.host_dir == other.host_dir
        }
    }

    #[test]
    fn copy_key_changes_with_the_version_and_with_the_binary() {
        let k1 = copy_key("1.4.1", b"binary-one");
        let k2 = copy_key("1.4.1", b"binary-two");
        let k3 = copy_key("1.5.0", b"binary-one");
        assert_ne!(k1, k2);
        assert_ne!(k1, k3);
        assert_eq!(k1, copy_key("1.4.1", b"binary-one"));
        assert!(k1.starts_with("1.4.1-"));
        let weird = copy_key("2.0.0-beta.1/../x", b"b");
        assert!(!weird.contains('/') && !weird.contains(".."), "{weird}");
    }

    #[test]
    fn socket_root_prefers_the_rig_then_a_user_private_folder() {
        // The rig's root wins; otherwise a folder that exists.
        let root = socket_root();
        assert!(root.is_absolute());
        if std::env::var_os("HERMES_HOST_SOCKET_ROOT").is_none() && cfg!(unix) {
            assert!(root.is_dir(), "{root:?}");
        }
    }

    #[test]
    fn install_copy_is_idempotent_versioned_and_prunes_old_copies() {
        let tmp = tempfile::tempdir().unwrap();
        let shipped = tmp.path().join("hermes-pty-host");
        std::fs::write(&shipped, b"#!/bin/sh\necho v1\n").unwrap();
        let bin = tmp.path().join("bin");

        let first = install_copy(&shipped, &bin, "1.0.0").unwrap();
        assert!(first.is_file());
        assert!(first.starts_with(&bin));
        assert_eq!(std::fs::read(&first).unwrap(), b"#!/bin/sh\necho v1\n");
        let again = install_copy(&shipped, &bin, "1.0.0").unwrap();
        assert_eq!(first, again, "same version and bytes: same copy");

        // An update: new bytes and version get their own folder; the old
        // copy (which a running host may be using) stays for now.
        std::fs::write(&shipped, b"#!/bin/sh\necho v2\n").unwrap();
        let second = install_copy(&shipped, &bin, "1.1.0").unwrap();
        assert_ne!(first, second);
        assert!(first.is_file() && second.is_file());

        // Only the newest few copies are kept.
        for v in ["1.2.0", "1.3.0", "1.4.0"] {
            std::fs::write(&shipped, format!("#!/bin/sh\necho {v}\n")).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(20));
            install_copy(&shipped, &bin, v).unwrap();
        }
        let dirs = std::fs::read_dir(&bin).unwrap().count();
        assert!(dirs <= 3, "kept {dirs} copies");
        assert!(!first.is_file(), "the oldest copy was pruned");
    }
}

#[cfg(all(test, unix))]
mod unix_tests {
    use super::unix::{connect, connect_or_start_with, ensure_socket_dirs};
    use super::*;
    use hermes_pty_host::protocol::{read_frame, write_frame, Frame, Msg, PROTOCOL_VERSION};
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::os::unix::net::UnixListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    const TOKEN: &str = "unit-test-token-0123456789abcdef";

    /// A short root under /tmp (socket paths are limited to ~100 bytes).
    fn short_root() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("hsh-")
            .tempdir_in("/tmp")
            .unwrap()
    }

    fn test_paths(root: &Path) -> HostPaths {
        let paths = paths_for(&root.join("data"), root);
        std::fs::create_dir_all(&paths.host_dir).unwrap();
        paths
    }

    /// What a fake host answers the hello with.
    #[derive(Clone, Copy)]
    enum Answer {
        /// A refusal, as a real host of another protocol version sends it.
        ProtocolError,
        /// A hello-ack claiming another protocol version.
        OtherProtoAck,
        /// Silence: the handshake times out.
        Hang,
        /// A proper host.
        Good,
    }

    /// Listens on `socket` and answers every hello as `answer` says.
    fn fake_host(socket: &Path, answer: Answer) -> UnixListener {
        let listener = UnixListener::bind(socket).unwrap();
        let accept = listener.try_clone().unwrap();
        std::thread::spawn(move || {
            for stream in accept.incoming() {
                let Ok(mut stream) = stream else { break };
                let _ = read_frame(&mut stream);
                let reply = match answer {
                    Answer::ProtocolError => Msg::Error {
                        message: format!(
                            "protocol {} not supported (host speaks {})",
                            PROTOCOL_VERSION,
                            PROTOCOL_VERSION + 1
                        ),
                    },
                    Answer::OtherProtoAck => Msg::HelloAck {
                        proto: PROTOCOL_VERSION + 1,
                        version: "9.9.9".into(),
                        pid: 1,
                        exe: String::new(),
                        started_at: 0,
                    },
                    Answer::Hang => {
                        std::thread::sleep(Duration::from_secs(4));
                        continue;
                    }
                    Answer::Good => Msg::HelloAck {
                        proto: PROTOCOL_VERSION,
                        version: "0.0.0-test".into(),
                        pid: std::process::id(),
                        exe: String::new(),
                        started_at: 0,
                    },
                };
                let _ = write_frame(&mut stream, &Frame::Msg(reply));
                // Keep the good connection open until the client drops it.
                if matches!(answer, Answer::Good) {
                    let _ = read_frame(&mut stream);
                }
            }
        });
        listener
    }

    #[test]
    fn a_host_that_answers_but_cannot_be_used_keeps_its_socket_and_starts_nothing() {
        for answer in [Answer::ProtocolError, Answer::OtherProtoAck, Answer::Hang] {
            let root = short_root();
            let paths = test_paths(root.path());
            ensure_socket_dirs(&paths).unwrap();
            let _listener = fake_host(&paths.socket, answer);
            let started = Arc::new(AtomicBool::new(false));
            let flag = Arc::clone(&started);
            let result = connect_or_start_with(&paths, TOKEN, move || {
                flag.store(true, Ordering::SeqCst);
                Ok(())
            });
            let err = match result {
                Ok(_) => panic!("an unusable host was accepted"),
                Err(e) => e,
            };
            assert!(err.contains("cannot be used"), "{err}");
            if matches!(answer, Answer::Hang) {
                assert!(
                    err.contains("did not answer within 2 s") && !err.contains("os error"),
                    "a hung handshake is reported in plain words: {err}"
                );
            }
            assert!(
                paths.socket.exists(),
                "the live host's socket is never unlinked (its sessions would be orphaned)"
            );
            assert!(
                !started.load(Ordering::SeqCst),
                "no second host is started next to a live one"
            );
        }
    }

    #[test]
    fn a_socket_nobody_listens_on_is_stale_and_a_host_is_started() {
        let root = short_root();
        let paths = test_paths(root.path());
        ensure_socket_dirs(&paths).unwrap();
        // A file left by a host that is gone: bind, then drop the listener.
        drop(UnixListener::bind(&paths.socket).unwrap());
        assert!(paths.socket.exists());
        let socket = paths.socket.clone();
        let conn = connect_or_start_with(&paths, TOKEN, move || {
            assert!(
                !socket.exists(),
                "the stale file was removed before the start"
            );
            std::mem::forget(fake_host(&socket, Answer::Good));
            Ok(())
        })
        .expect("connects to the host it started");
        assert_eq!(conn.info().version, "0.0.0-test");

        // No socket at all: the same, without anything to remove.
        let root = short_root();
        let paths = test_paths(root.path());
        ensure_socket_dirs(&paths).unwrap();
        let socket = paths.socket.clone();
        connect_or_start_with(&paths, TOKEN, move || {
            std::mem::forget(fake_host(&socket, Answer::Good));
            Ok(())
        })
        .expect("connects to the host it started");
    }

    #[test]
    fn a_plain_connect_verifies_the_socket_folders_and_never_sends_the_token_behind_a_symlink() {
        // A good host reachable only through a planted `hermes-host-<uid>`
        // symlink: `connect` (startup listing, has_session) refuses it
        // before any byte is written, just as `connect_or_start` does.
        let root = short_root();
        let paths = test_paths(root.path());
        let theirs = root.path().join("theirs");
        let hash = paths.socket_dir.file_name().unwrap();
        std::fs::create_dir_all(theirs.join(hash)).unwrap();
        std::os::unix::fs::symlink(&theirs, paths.socket_dir.parent().unwrap()).unwrap();
        std::fs::write(&paths.token_file, format!("{TOKEN}\n")).unwrap();
        let hellos = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = Arc::clone(&hellos);
        let listener = UnixListener::bind(theirs.join(hash).join("host.sock")).unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                seen.fetch_add(1, Ordering::SeqCst);
                let _ = read_frame(&mut stream);
            }
        });
        assert!(
            paths.socket.exists(),
            "the fake host is reachable through the link"
        );
        let err = match connect(&paths, Duration::from_secs(1)) {
            Ok(_) => panic!("connected through a planted symlink"),
            Err(e) => e,
        };
        assert!(err.contains("symlink"), "{err}");
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(
            hellos.load(Ordering::SeqCst),
            0,
            "nothing was sent to the planted host"
        );

        // The same folders, real: the connection goes through.
        let root = short_root();
        let paths = test_paths(root.path());
        ensure_socket_dirs(&paths).unwrap();
        std::fs::write(&paths.token_file, format!("{TOKEN}\n")).unwrap();
        let _listener = fake_host(&paths.socket, Answer::Good);
        assert_eq!(
            connect(&paths, Duration::from_secs(1))
                .unwrap()
                .info()
                .version,
            "0.0.0-test"
        );
    }

    #[test]
    fn socket_folders_are_created_user_only_and_a_planted_parent_is_refused() {
        let root = short_root();
        let paths = test_paths(root.path());
        ensure_socket_dirs(&paths).unwrap();
        let uid = unsafe { libc::getuid() };
        for dir in [paths.socket_dir.parent().unwrap(), &paths.socket_dir] {
            let meta = std::fs::symlink_metadata(dir).unwrap();
            assert!(meta.is_dir() && !meta.file_type().is_symlink());
            assert_eq!(meta.uid(), uid);
            assert_eq!(meta.permissions().mode() & 0o777, 0o700, "{dir:?}");
        }

        // Another user pre-created `<root>/hermes-host-<uid>` as a symlink
        // to a folder of theirs (sticky /tmp lets anyone create names):
        // refused, nothing is created behind it.
        let root = short_root();
        let paths = test_paths(root.path());
        let elsewhere = root.path().join("theirs");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, paths.socket_dir.parent().unwrap()).unwrap();
        let err = ensure_socket_dirs(&paths).unwrap_err();
        assert!(err.contains("symlink"), "{err}");
        assert!(std::fs::read_dir(&elsewhere).unwrap().next().is_none());

        // The parent is ours but open to everyone (an older build's umask):
        // tightened before use.
        let root = short_root();
        let paths = test_paths(root.path());
        let parent = paths.socket_dir.parent().unwrap();
        std::fs::create_dir_all(parent).unwrap();
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o755)).unwrap();
        ensure_socket_dirs(&paths).unwrap();
        assert_eq!(
            std::fs::metadata(parent).unwrap().permissions().mode() & 0o777,
            0o700
        );

        // A parent that belongs to another user: refused. `/` is root's.
        if uid != 0 {
            let paths = paths_for(Path::new("/nonexistent-data"), Path::new("/"));
            let planted = HostPaths {
                socket_dir: PathBuf::from("/"),
                socket: PathBuf::from("/host.sock"),
                ..paths
            };
            let err = ensure_socket_dirs(&planted).unwrap_err();
            assert!(err.contains("belongs to uid 0"), "{err}");
        }
    }
}
