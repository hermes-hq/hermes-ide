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
//! Security: the socket lives in a folder only the user can enter (0700),
//! every connection must present the token from `<data>/host/token` (0600),
//! and the host checks the connecting process's uid. Anyone who could
//! connect could type into an agent.
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

/// The socket root: `HERMES_HOST_SOCKET_ROOT`, or the system's temp root.
/// Not `TMPDIR`: a test run gives every launch a fresh one, and the socket
/// has to be found again after a relaunch.
pub fn socket_root() -> PathBuf {
    if let Some(root) = std::env::var_os("HERMES_HOST_SOCKET_ROOT").filter(|v| !v.is_empty()) {
        return PathBuf::from(root);
    }
    #[cfg(unix)]
    {
        PathBuf::from("/tmp")
    }
    #[cfg(not(unix))]
    {
        std::env::temp_dir()
    }
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
    Ok(paths_for(&data_dir, &socket_root()))
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
        _ => {
            // Nothing is working (or the user chose to stop): hosted
            // sessions end with the app, as in-process ones always did.
            stop_all_hosted(&state);
            false
        }
    }
}

#[tauri::command]
pub fn session_host_status(
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

/// The user's answer to "keep running or stop?": remember it, act on it,
/// and quit. The exit request then goes through.
#[tauri::command]
pub fn session_host_quit(
    app: AppHandle,
    state: State<'_, AppState>,
    host_state: State<'_, SessionHostState>,
    keep_running: bool,
) -> Result<(), String> {
    if let Ok(mut d) = host_state.quit_decision.lock() {
        *d = Some(keep_running);
    }
    if !keep_running {
        stop_all_hosted(&state);
    }
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

    /// Connects to a running host; never starts one.
    pub fn connect(paths: &HostPaths, timeout: Duration) -> Result<Connection, String> {
        if !paths.socket.exists() {
            return Err("no host socket".to_string());
        }
        let token = read_token(paths)?;
        Connection::connect(&paths.socket, &token, timeout).map_err(|e| e.to_string())
    }

    fn ensure_private_dir(dir: &Path) -> Result<(), String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("chmod {}: {e}", dir.display()))?;
        let meta = std::fs::metadata(dir).map_err(|e| e.to_string())?;
        use std::os::unix::fs::MetadataExt;
        if meta.uid() != unsafe { libc::getuid() } {
            return Err(format!(
                "{} belongs to another user; refusing to use it",
                dir.display()
            ));
        }
        Ok(())
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

    /// Connects to the host, starting it (from a versioned copy) if needed.
    pub fn connect_or_start(app: &AppHandle) -> Result<Connection, String> {
        let paths = paths(app)?;
        ensure_private_dir(&paths.host_dir)?;
        ensure_private_dir(&paths.socket_dir)?;
        let token = ensure_token(&paths)?;
        if let Ok(conn) = Connection::connect(&paths.socket, &token, Duration::from_secs(2)) {
            return Ok(conn);
        }
        if paths.socket.exists() {
            log::info!("[session-host] stale socket, removing it");
            let _ = std::fs::remove_file(&paths.socket);
        }
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
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            match Connection::connect(&paths.socket, &token, Duration::from_secs(2)) {
                Ok(conn) => return Ok(conn),
                Err(e) if Instant::now() >= deadline => {
                    return Err(format!("the session host did not answer: {e}"))
                }
                Err(_) => std::thread::sleep(Duration::from_millis(50)),
            }
        }
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
        let existing = conn
            .list()
            .map_err(|e| format!("host list: {e}"))?
            .into_iter()
            .any(|s| s.id == session_id);
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
