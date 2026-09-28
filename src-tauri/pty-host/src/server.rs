//! The host process: owns PTYs and their programs, keeps a ring of output
//! per session, serves attached clients over a user-only Unix socket, and
//! exits once it has no sessions left.

use crate::protocol::{
    now_ms, read_frame, write_frame, Frame, Msg, SessionInfo, DATA_CHUNK_BYTES, PROTOCOL_VERSION,
};
use crate::ring::Ring;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub struct Config {
    /// The host's folder (token file, log). Must be private to the user.
    pub dir: PathBuf,
    pub socket: PathBuf,
    pub token: String,
    pub ring_bytes: usize,
    /// Exit once there have been no sessions for this long...
    pub empty_exit_after: Duration,
    /// ...but never before this much time since the start (the app that
    /// started the host is about to spawn into it).
    pub startup_grace: Duration,
    /// How long an ended session stays listed, so a reattaching app can
    /// still collect its last output and exit code.
    pub exited_keep: Duration,
}

impl Config {
    pub fn new(dir: PathBuf, socket: PathBuf, token: String) -> Self {
        Self {
            dir,
            socket,
            token,
            ring_bytes: 2 * 1024 * 1024,
            empty_exit_after: Duration::from_secs(3),
            startup_grace: Duration::from_secs(10),
            exited_keep: Duration::from_secs(60),
        }
    }
}

type Out = Arc<Mutex<UnixStream>>;

struct HostSession {
    id: String,
    pid: u32,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    ring: Ring,
    client: Option<Out>,
    exited: bool,
    exit_code: Option<i32>,
    exited_at: Option<Instant>,
    /// The attached client was told the program ended.
    exit_delivered: bool,
    last_output: Option<Instant>,
    started_at: u64,
}

impl HostSession {
    fn info(&self) -> SessionInfo {
        SessionInfo {
            id: self.id.clone(),
            pid: self.pid,
            alive: !self.exited,
            exit_code: self.exit_code,
            attached: self.client.is_some(),
            ring_bytes: self.ring.len() as u64,
            total_bytes: self.ring.total(),
            last_output_ms_ago: self.last_output.map(|t| t.elapsed().as_millis() as u64),
            started_at: self.started_at,
        }
    }
}

type SessionRef = Arc<Mutex<HostSession>>;
type Sessions = Arc<Mutex<HashMap<String, SessionRef>>>;

pub fn log(msg: &str) {
    eprintln!("[hermes-pty-host {}] {}", now_ms(), msg);
}

fn send(out: &Out, frame: &Frame) -> io::Result<()> {
    let mut stream = out.lock().unwrap_or_else(|e| e.into_inner());
    write_frame(&mut *stream, frame)
}

/// The uid on the other end of a Unix socket.
pub fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    let fd = stream.as_raw_fd();
    #[cfg(target_os = "linux")]
    {
        let mut cred = libc::ucred {
            pid: 0,
            uid: 0,
            gid: 0,
        };
        let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        let rc = unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                &mut cred as *mut libc::ucred as *mut libc::c_void,
                &mut len,
            )
        };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(cred.uid)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let mut uid: libc::uid_t = 0;
        let mut gid: libc::gid_t = 0;
        let rc = unsafe { libc::getpeereid(fd, &mut uid, &mut gid) };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(uid)
    }
}

/// Runs the host until it has no sessions. Returns only on a startup error.
pub fn run(cfg: Config) -> io::Result<()> {
    // Never die with the app's terminal, and never die on a closed socket.
    unsafe {
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    std::fs::create_dir_all(&cfg.dir)?;
    std::fs::set_permissions(&cfg.dir, std::fs::Permissions::from_mode(0o700))?;
    if let Some(parent) = cfg.socket.parent() {
        std::fs::create_dir_all(parent)?;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
    }
    // A socket file left by a host that is gone would refuse the bind.
    if cfg.socket.exists() && UnixStream::connect(&cfg.socket).is_err() {
        let _ = std::fs::remove_file(&cfg.socket);
    }
    let listener = UnixListener::bind(&cfg.socket)?;
    std::fs::set_permissions(&cfg.socket, std::fs::Permissions::from_mode(0o600))?;
    let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
    let started = Instant::now();
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    log(&format!(
        "listening on {} (pid {}, exe {})",
        cfg.socket.display(),
        std::process::id(),
        exe
    ));

    let cfg = Arc::new(cfg);
    janitor(Arc::clone(&sessions), Arc::clone(&cfg), started);

    let my_uid = unsafe { libc::getuid() };
    for stream in listener.incoming() {
        let stream = match stream {
            Ok(s) => s,
            Err(e) => {
                log(&format!("accept failed: {e}"));
                continue;
            }
        };
        match peer_uid(&stream) {
            Ok(uid) if uid == my_uid => {}
            Ok(uid) => {
                log(&format!("refused a connection from uid {uid}"));
                continue;
            }
            Err(e) => {
                log(&format!("refused a connection: peer check failed: {e}"));
                continue;
            }
        }
        let sessions = Arc::clone(&sessions);
        let cfg = Arc::clone(&cfg);
        let exe = exe.clone();
        std::thread::spawn(move || {
            if let Err(e) = serve(stream, sessions, cfg, exe, started) {
                if e.kind() != io::ErrorKind::UnexpectedEof
                    && e.kind() != io::ErrorKind::BrokenPipe
                    && e.kind() != io::ErrorKind::ConnectionReset
                {
                    log(&format!("connection ended: {e}"));
                }
            }
        });
    }
    Ok(())
}

/// Reaps ended sessions and exits the process once nothing is left.
fn janitor(sessions: Sessions, cfg: Arc<Config>, started: Instant) {
    std::thread::spawn(move || {
        let mut empty_since: Option<Instant> = None;
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let mut map = sessions.lock().unwrap_or_else(|e| e.into_inner());
            map.retain(|id, sess| {
                let s = sess.lock().unwrap_or_else(|e| e.into_inner());
                let gone = s.exited
                    && (s.exit_delivered
                        || s.exited_at.is_some_and(|t| t.elapsed() >= cfg.exited_keep));
                if gone {
                    log(&format!("forgot ended session {id}"));
                }
                !gone
            });
            let empty = map.is_empty();
            drop(map);
            if !empty {
                empty_since = None;
                continue;
            }
            let since = *empty_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= cfg.empty_exit_after && started.elapsed() >= cfg.startup_grace {
                log("no sessions left; exiting");
                let _ = std::fs::remove_file(&cfg.socket);
                std::process::exit(0);
            }
        }
    });
}

fn serve(
    stream: UnixStream,
    sessions: Sessions,
    cfg: Arc<Config>,
    exe: String,
    started: Instant,
) -> io::Result<()> {
    let mut input = stream.try_clone()?;
    let out: Out = Arc::new(Mutex::new(stream));
    // The handshake must arrive promptly; after it, reads block for input.
    input.set_read_timeout(Some(Duration::from_secs(5)))?;
    match read_frame(&mut input)? {
        Some(Frame::Msg(Msg::Hello { token, proto })) => {
            if proto != PROTOCOL_VERSION {
                send(
                    &out,
                    &Frame::Msg(Msg::Error {
                        message: format!(
                            "protocol {proto} not supported (host speaks {PROTOCOL_VERSION})"
                        ),
                    }),
                )?;
                return Ok(());
            }
            if !constant_time_eq(token.as_bytes(), cfg.token.as_bytes()) {
                log("refused a connection: bad token");
                send(
                    &out,
                    &Frame::Msg(Msg::Error {
                        message: "bad token".into(),
                    }),
                )?;
                return Ok(());
            }
        }
        _ => {
            send(
                &out,
                &Frame::Msg(Msg::Error {
                    message: "expected hello".into(),
                }),
            )?;
            return Ok(());
        }
    }
    send(
        &out,
        &Frame::Msg(Msg::HelloAck {
            proto: PROTOCOL_VERSION,
            version: crate::HOST_VERSION.to_string(),
            pid: std::process::id(),
            exe,
            started_at: now_ms().saturating_sub(started.elapsed().as_millis() as u64),
        }),
    )?;
    input.set_read_timeout(None)?;

    let mut attached: Option<SessionRef> = None;
    let result = loop {
        let frame = match read_frame(&mut input) {
            Ok(Some(f)) => f,
            Ok(None) => break Ok(()),
            Err(e) => break Err(e),
        };
        match frame {
            Frame::Data(bytes) => {
                if let Some(sess) = &attached {
                    let mut s = sess.lock().unwrap_or_else(|e| e.into_inner());
                    if !s.exited {
                        if let Err(e) = s.writer.write_all(&bytes).and_then(|_| s.writer.flush()) {
                            log(&format!("input to {} failed: {e}", s.id));
                        }
                    }
                }
            }
            Frame::Msg(msg) => match msg {
                Msg::Ping => send(&out, &Frame::Msg(Msg::Pong))?,
                Msg::List => {
                    let map = sessions.lock().unwrap_or_else(|e| e.into_inner());
                    let mut list: Vec<SessionInfo> = map
                        .values()
                        .map(|s| s.lock().unwrap_or_else(|e| e.into_inner()).info())
                        .collect();
                    list.sort_by_key(|s| s.started_at);
                    drop(map);
                    send(&out, &Frame::Msg(Msg::Sessions { sessions: list }))?;
                }
                Msg::Spawn {
                    id,
                    argv,
                    env,
                    cwd,
                    rows,
                    cols,
                } => {
                    let reply = match spawn_session(&sessions, &cfg, id, argv, env, cwd, rows, cols)
                    {
                        Ok((id, pid)) => Msg::Spawned { id, pid },
                        Err(e) => Msg::Error {
                            message: e.to_string(),
                        },
                    };
                    send(&out, &Frame::Msg(reply))?;
                }
                Msg::Attach { id, rows, cols } => {
                    let found = sessions
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .get(&id)
                        .cloned();
                    match found {
                        None => send(
                            &out,
                            &Frame::Msg(Msg::Error {
                                message: format!("no session {id}"),
                            }),
                        )?,
                        Some(sess) => {
                            attach(&sess, &out, rows, cols)?;
                            attached = Some(sess);
                        }
                    }
                }
                Msg::Detach => {
                    if let Some(sess) = attached.take() {
                        let mut s = sess.lock().unwrap_or_else(|e| e.into_inner());
                        if s.client.as_ref().is_some_and(|c| Arc::ptr_eq(c, &out)) {
                            s.client = None;
                        }
                    }
                    send(&out, &Frame::Msg(Msg::Ok))?;
                }
                Msg::Resize { id, rows, cols } => {
                    let found = sessions
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .get(&id)
                        .cloned();
                    if let Some(sess) = found {
                        let s = sess.lock().unwrap_or_else(|e| e.into_inner());
                        resize(&s, rows, cols);
                    }
                    // No reply on an attached channel: only data and Exited
                    // flow back there. A control connection gets an Ok.
                    if attached.is_none() {
                        send(&out, &Frame::Msg(Msg::Ok))?;
                    }
                }
                Msg::Kill { id } => {
                    let found = sessions
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .get(&id)
                        .cloned();
                    if let Some(sess) = found {
                        kill_session(&sess);
                    }
                    if attached.is_none() {
                        send(&out, &Frame::Msg(Msg::Ok))?;
                    }
                }
                Msg::KillAll => {
                    let all: Vec<SessionRef> = sessions
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .values()
                        .cloned()
                        .collect();
                    for sess in all {
                        kill_session(&sess);
                    }
                    if attached.is_none() {
                        send(&out, &Frame::Msg(Msg::Ok))?;
                    }
                }
                other => {
                    send(
                        &out,
                        &Frame::Msg(Msg::Error {
                            message: format!("unexpected message {other:?}"),
                        }),
                    )?;
                }
            },
        }
    };
    // The client went away: its session keeps running, unattached.
    if let Some(sess) = attached {
        let mut s = sess.lock().unwrap_or_else(|e| e.into_inner());
        if s.client.as_ref().is_some_and(|c| Arc::ptr_eq(c, &out)) {
            s.client = None;
            log(&format!("client detached from {}", s.id));
        }
    }
    result
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[allow(clippy::too_many_arguments)]
fn spawn_session(
    sessions: &Sessions,
    cfg: &Config,
    id: String,
    argv: Vec<String>,
    env: Vec<(String, String)>,
    cwd: String,
    rows: u16,
    cols: u16,
) -> io::Result<(String, u32)> {
    if id.is_empty() || argv.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "a session needs an id and a program",
        ));
    }
    if sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(&id)
    {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("session {id} already exists"),
        ));
    }
    let size = PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| io::Error::other(format!("open pty: {e}")))?;
    let _ = pair.master.resize(size);
    let mut cmd = CommandBuilder::from_argv(argv.iter().map(Into::into).collect());
    cmd.env_clear();
    for (k, v) in &env {
        cmd.env(k, v);
    }
    if !cwd.is_empty() {
        cmd.cwd(&cwd);
    }
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| io::Error::other(format!("spawn: {e}")))?;
    drop(pair.slave);
    let pid = child.process_id().unwrap_or(0);
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| io::Error::other(format!("pty writer: {e}")))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| io::Error::other(format!("pty reader: {e}")))?;
    let session = Arc::new(Mutex::new(HostSession {
        id: id.clone(),
        pid,
        master: pair.master,
        writer,
        child,
        ring: Ring::new(cfg.ring_bytes),
        client: None,
        exited: false,
        exit_code: None,
        exited_at: None,
        exit_delivered: false,
        last_output: None,
        started_at: now_ms(),
    }));
    sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.clone(), Arc::clone(&session));
    log(&format!("spawned {id}: pid {pid}, {}", argv.join(" ")));
    read_loop(session, reader);
    Ok((id, pid))
}

/// Forwards a session's output into its ring and to its attached client,
/// then records how the program ended.
fn read_loop(sess: SessionRef, mut reader: Box<dyn Read + Send>) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let mut s = sess.lock().unwrap_or_else(|e| e.into_inner());
            s.ring.push(&buf[..n]);
            s.last_output = Some(Instant::now());
            if let Some(client) = s.client.clone() {
                if send(&client, &Frame::Data(buf[..n].to_vec())).is_err() {
                    s.client = None;
                }
            }
        }
        let code = wait_child(&sess);
        let mut s = sess.lock().unwrap_or_else(|e| e.into_inner());
        s.exited = true;
        s.exit_code = code;
        s.exited_at = Some(Instant::now());
        log(&format!("{} ended with {:?}", s.id, code));
        if let Some(client) = s.client.take() {
            let id = s.id.clone();
            if send(&client, &Frame::Msg(Msg::Exited { id, code })).is_ok() {
                s.exit_delivered = true;
            }
        }
    });
}

/// Reaps the program after its terminal closed: polls briefly, then makes
/// sure with SIGKILL (a program can close the terminal and hang on).
fn wait_child(sess: &SessionRef) -> Option<i32> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        {
            let mut s = sess.lock().unwrap_or_else(|e| e.into_inner());
            match s.child.try_wait() {
                Ok(Some(status)) => return Some(status.exit_code() as i32),
                Ok(None) => {}
                Err(_) => return None,
            }
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let mut s = sess.lock().unwrap_or_else(|e| e.into_inner());
    unsafe {
        libc::kill(-(s.pid as i32), libc::SIGKILL);
    }
    s.child.wait().ok().map(|st| st.exit_code() as i32)
}

fn attach(sess: &SessionRef, out: &Out, rows: u16, cols: u16) -> io::Result<()> {
    // Held for the whole replay, so the reader cannot push live output in
    // between: replay first, then live, in one ordered stream.
    let mut s = sess.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(old) = s.client.take() {
        if !Arc::ptr_eq(&old, out) {
            let _ = old
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .shutdown(std::net::Shutdown::Both);
        }
    }
    if rows > 0 && cols > 0 && !s.exited {
        resize(&s, rows, cols);
    }
    let replay = s.ring.contents();
    send(
        out,
        &Frame::Msg(Msg::Attached {
            id: s.id.clone(),
            pid: s.pid,
            alive: !s.exited,
            exit_code: s.exit_code,
            replay_bytes: replay.len() as u64,
        }),
    )?;
    for chunk in replay.chunks(DATA_CHUNK_BYTES) {
        send(out, &Frame::Data(chunk.to_vec()))?;
    }
    if s.exited {
        send(
            out,
            &Frame::Msg(Msg::Exited {
                id: s.id.clone(),
                code: s.exit_code,
            }),
        )?;
        s.exit_delivered = true;
    } else {
        s.client = Some(Arc::clone(out));
    }
    log(&format!(
        "client attached to {} (replayed {} bytes)",
        s.id,
        replay.len()
    ));
    Ok(())
}

fn resize(s: &HostSession, rows: u16, cols: u16) {
    let _ = s.master.resize(PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    });
    if s.pid > 0 && !s.exited {
        unsafe {
            libc::kill(-(s.pid as i32), libc::SIGWINCH);
        }
    }
}

/// Ends a session's program: hang-up first, then SIGKILL if it stays.
fn kill_session(sess: &SessionRef) {
    let pid = {
        let s = sess.lock().unwrap_or_else(|e| e.into_inner());
        if s.exited || s.pid == 0 {
            return;
        }
        s.pid as i32
    };
    unsafe {
        libc::kill(-pid, libc::SIGHUP);
    }
    for _ in 0..6 {
        std::thread::sleep(Duration::from_millis(50));
        let mut s = sess.lock().unwrap_or_else(|e| e.into_inner());
        if s.exited || matches!(s.child.try_wait(), Ok(Some(_))) {
            return;
        }
    }
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }
}
