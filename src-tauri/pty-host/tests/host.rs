//! Runs the built host binary the way Hermes does and talks to it over its
//! socket: programs keep running when the client goes away, output is
//! replayed on reattach, input reaches the program, and the host exits when
//! it has nothing left to host.

#![cfg(unix)]

use hermes_pty_host::client::{Attached, Connection};
use hermes_pty_host::protocol::{read_frame, write_frame, Frame, Msg, PROTOCOL_VERSION};
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const HOST: &str = env!("CARGO_BIN_EXE_hermes-pty-host");
const TOKEN: &str = "test-token-0123456789";

struct Host {
    child: Child,
    dir: PathBuf,
    socket: PathBuf,
    _tmp: tempfile::TempDir,
}

impl Host {
    fn start(empty_exit_ms: u64, startup_grace_ms: u64) -> Host {
        Self::start_keeping(empty_exit_ms, startup_grace_ms, 2000)
    }

    /// Also sets how long an ended session waits for a client to collect it.
    fn start_keeping(empty_exit_ms: u64, startup_grace_ms: u64, exited_keep_ms: u64) -> Host {
        // A short socket path: macOS allows 104 bytes.
        let tmp = tempfile::Builder::new()
            .prefix("hph-")
            .tempdir_in("/tmp")
            .unwrap();
        let dir = tmp.path().join("host");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(dir.join("token"), format!("{TOKEN}\n")).unwrap();
        // The socket gets a folder of its own, as it does under Hermes.
        let socket = tmp.path().join("sock").join("host.sock");
        let log = std::fs::File::create(dir.join("host.log")).unwrap();
        let child = Self::spawn(
            &dir,
            &socket,
            empty_exit_ms,
            startup_grace_ms,
            exited_keep_ms,
            log,
        );
        let host = Host {
            child,
            dir,
            socket,
            _tmp: tmp,
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(c) = host.connect() {
                drop(c);
                break;
            }
            assert!(
                Instant::now() < deadline,
                "host never came up:\n{}",
                host.log()
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        host
    }

    fn spawn(
        dir: &Path,
        socket: &Path,
        empty_exit_ms: u64,
        startup_grace_ms: u64,
        exited_keep_ms: u64,
        log: std::fs::File,
    ) -> Child {
        Command::new(HOST)
            .arg("--dir")
            .arg(dir)
            .arg("--socket")
            .arg(socket)
            .arg("--empty-exit-ms")
            .arg(empty_exit_ms.to_string())
            .arg("--startup-grace-ms")
            .arg(startup_grace_ms.to_string())
            .arg("--exited-keep-ms")
            .arg(exited_keep_ms.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(log)
            .spawn()
            .unwrap()
    }

    fn connect(&self) -> std::io::Result<Connection> {
        Connection::connect(&self.socket, TOKEN, Duration::from_secs(3))
    }

    fn log(&self) -> String {
        std::fs::read_to_string(self.dir.join("host.log")).unwrap_or_default()
    }

    fn wait_exit(&mut self, within: Duration) -> bool {
        let deadline = Instant::now() + within;
        while Instant::now() < deadline {
            if let Ok(Some(_)) = self.child.try_wait() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn sh(script: &str) -> Vec<String> {
    vec!["/bin/sh".into(), "-c".into(), script.into()]
}

fn env_min() -> Vec<(String, String)> {
    vec![
        ("PATH".into(), "/usr/bin:/bin".into()),
        ("TERM".into(), "xterm-256color".into()),
    ]
}

/// Reads from `reader` until the collected text contains `needle`. The
/// stream must have a read timeout, so a quiet program cannot block forever.
fn read_until(reader: &mut Box<dyn Read + Send>, needle: &str, timeout: Duration) -> String {
    let mut collected = String::new();
    let deadline = Instant::now() + timeout;
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                collected.push_str(&String::from_utf8_lossy(&buf[..n]));
                if collected.contains(needle) {
                    return collected;
                }
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(e) => panic!("read failed: {e}"),
        }
        assert!(
            Instant::now() < deadline,
            "never saw {needle:?}; got:\n{collected}"
        );
    }
    collected
}

/// Reads until the stream ends (the program ended or the host closed it).
fn drain(reader: &mut Box<dyn Read + Send>, timeout: Duration) -> String {
    let mut collected = String::new();
    let deadline = Instant::now() + timeout;
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => return collected,
            Ok(n) => collected.push_str(&String::from_utf8_lossy(&buf[..n])),
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(e) => panic!("read failed: {e}"),
        }
        assert!(
            Instant::now() < deadline,
            "stream never ended; got:\n{collected}"
        );
    }
}

fn last_tick(text: &str) -> u32 {
    text.lines()
        .filter_map(|l| l.trim().strip_prefix("tick "))
        .filter_map(|n| n.trim().parse().ok())
        .max()
        .unwrap_or(0)
}

fn pid_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[test]
fn a_program_outlives_its_client_and_its_output_is_replayed_on_reattach() {
    let mut host = Host::start(500, 200);
    let ticker = sh("i=0; while :; do i=$((i+1)); echo tick $i; sleep 0.05; done");
    let mut c = host.connect().unwrap();
    let pid = c
        .spawn("s1", ticker, env_min(), "/", 24, 80)
        .expect("spawn");
    assert!(pid > 0);

    // First client: sees live output, then vanishes without a word.
    let mut attached: Attached = host.connect().unwrap().attach("s1", 24, 80).unwrap();
    attached
        .set_read_timeout(Some(Duration::from_millis(200)))
        .unwrap();
    assert!(attached.alive);
    let mut reader = attached.take_reader().unwrap();
    let seen = read_until(&mut reader, "tick 3", Duration::from_secs(10));
    let before = last_tick(&seen);
    assert!(before >= 3);
    drop(reader);
    drop(attached);

    std::thread::sleep(Duration::from_millis(400));
    let mut c = host.connect().unwrap();
    let list = c.list().unwrap();
    let info = list.iter().find(|s| s.id == "s1").expect("session listed");
    assert!(info.alive, "the program keeps running without a client");
    assert!(!info.attached, "the vanished client is no longer attached");
    assert!(pid_alive(pid));

    // Second client: replay from the ring (including what the first one
    // saw), then live output that keeps counting up.
    let mut attached = c.attach("s1", 24, 80).unwrap();
    attached
        .set_read_timeout(Some(Duration::from_millis(200)))
        .unwrap();
    assert!(attached.replay_bytes > 0);
    let mut reader = attached.take_reader().unwrap();
    let text = read_until(
        &mut reader,
        &format!("tick {}", before + 8),
        Duration::from_secs(10),
    );
    assert!(
        text.contains("tick 1\r\n"),
        "replay starts from the beginning:\n{text}"
    );
    assert!(last_tick(&text) > before);

    // Stop it: the stream ends, the process is gone, and the host, having
    // nothing left, exits on its own and removes its socket.
    attached.kill().unwrap();
    drain(&mut reader, Duration::from_secs(10));
    let deadline = Instant::now() + Duration::from_secs(5);
    while pid_alive(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!pid_alive(pid), "killed program is gone");
    assert!(
        host.wait_exit(Duration::from_secs(10)),
        "host exits when empty:\n{}",
        host.log()
    );
    assert!(!host.socket.exists(), "socket file removed on exit");
}

#[test]
fn input_reaches_the_program_and_resize_is_seen() {
    let host = Host::start(60_000, 60_000);
    let mut c = host.connect().unwrap();
    c.spawn(
        "cat",
        sh("stty -echo; cat; echo cat-done"),
        env_min(),
        "/",
        24,
        80,
    )
    .unwrap();
    let mut attached = host.connect().unwrap().attach("cat", 24, 80).unwrap();
    attached
        .set_read_timeout(Some(Duration::from_millis(200)))
        .unwrap();
    let mut reader = attached.take_reader().unwrap();
    let mut writer = attached.writer();
    // stty needs a moment before cat is reading.
    std::thread::sleep(Duration::from_millis(300));
    writer.write_all(b"hello host\n").unwrap();
    let text = read_until(&mut reader, "hello host", Duration::from_secs(10));
    assert!(text.contains("hello host"));

    attached.resize(30, 100).unwrap();
    let mut c2 = host.connect().unwrap();
    c2.spawn("size", sh("stty size"), env_min(), "/", 41, 133)
        .unwrap();
    let mut a2 = host.connect().unwrap().attach("size", 0, 0).unwrap();
    a2.set_read_timeout(Some(Duration::from_millis(200)))
        .unwrap();
    let mut r2 = a2.take_reader().unwrap();
    let text = read_until(&mut r2, "41 133", Duration::from_secs(10));
    assert!(
        text.contains("41 133"),
        "program sees the requested size:\n{text}"
    );

    // End of input: cat exits, the stream ends with the program's tail.
    writer.write_all(b"\x04").unwrap();
    let text = read_until(&mut reader, "cat-done", Duration::from_secs(10));
    assert!(text.contains("cat-done"));
    drain(&mut reader, Duration::from_secs(10));
}

#[test]
fn an_ended_session_keeps_its_exit_code_until_a_client_collects_it() {
    let host = Host::start(60_000, 60_000);
    let mut c = host.connect().unwrap();
    c.spawn("bye", sh("echo bye; exit 7"), env_min(), "/", 24, 80)
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let info = loop {
        let list = c.list().unwrap();
        if let Some(s) = list.iter().find(|s| s.id == "bye" && !s.alive) {
            break s.clone();
        }
        assert!(Instant::now() < deadline, "session never ended: {list:?}");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(info.exit_code, Some(7));

    let mut attached = c.attach("bye", 24, 80).unwrap();
    assert!(!attached.alive);
    assert_eq!(attached.exit_code, Some(7));
    attached
        .set_read_timeout(Some(Duration::from_millis(200)))
        .unwrap();
    let mut reader = attached.take_reader().unwrap();
    let all = drain(&mut reader, Duration::from_secs(10));
    assert!(all.contains("bye"));

    // Collected: the host forgets it.
    let mut c = host.connect().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while c.list().unwrap().iter().any(|s| s.id == "bye") {
        assert!(Instant::now() < deadline, "ended session was not forgotten");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn a_session_ended_on_request_is_not_kept_and_the_host_exits() {
    // Kept for a minute if nobody collects it, as a program that ends on
    // its own is; but this one was asked to end, and the client that asked
    // is gone (the app quits right after): the host must not wait for it.
    let mut host = Host::start_keeping(200, 200, 60_000);
    let mut c = host.connect().unwrap();
    c.spawn("stop-me", sh("sleep 30"), env_min(), "/", 24, 80)
        .unwrap();
    c.kill("stop-me").unwrap();
    drop(c);
    assert!(
        host.wait_exit(Duration::from_secs(10)),
        "host exits once the session it was asked to end is gone:\n{}",
        host.log()
    );
}

#[test]
fn bad_token_wrong_protocol_and_junk_are_refused() {
    let host = Host::start(60_000, 60_000);
    let err = match Connection::connect(&host.socket, "wrong-token", Duration::from_secs(3)) {
        Ok(_) => panic!("a wrong token was accepted"),
        Err(e) => e,
    };
    assert!(err.to_string().contains("bad token"), "{err}");

    let mut raw = UnixStream::connect(&host.socket).unwrap();
    raw.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    write_frame(
        &mut raw,
        &Frame::Msg(Msg::Hello {
            token: TOKEN.into(),
            proto: PROTOCOL_VERSION + 1,
        }),
    )
    .unwrap();
    match read_frame(&mut raw).unwrap() {
        Some(Frame::Msg(Msg::Error { message })) => assert!(message.contains("protocol")),
        other => panic!("expected a protocol error, got {other:?}"),
    }

    let mut raw = UnixStream::connect(&host.socket).unwrap();
    raw.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    write_frame(&mut raw, &Frame::Msg(Msg::List)).unwrap();
    match read_frame(&mut raw).unwrap() {
        Some(Frame::Msg(Msg::Error { message })) => assert!(message.contains("hello")),
        other => panic!("expected a hello error, got {other:?}"),
    }

    // A refused client changes nothing: the socket is still there and the
    // host still serves a good one. (An app that took a protocol refusal
    // for a stale socket would unlink it and orphan every session.)
    assert!(host.socket.exists(), "a refusal never removes the socket");
    let mut c = host.connect().unwrap();
    c.ping().unwrap();
    assert!(c.list().unwrap().is_empty());
    assert!(
        pid_alive(host.child.id()),
        "the host is still running:\n{}",
        host.log()
    );
}

#[test]
fn a_socket_folder_that_is_a_symlink_or_open_to_others_is_refused_or_fixed() {
    let tmp = tempfile::Builder::new()
        .prefix("hph-")
        .tempdir_in("/tmp")
        .unwrap();
    let dir = tmp.path().join("host");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("token"), format!("{TOKEN}\n")).unwrap();

    // A symlink where the socket folder should be: the host refuses to
    // bind there and exits.
    let elsewhere = tmp.path().join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let linked = tmp.path().join("sock-link");
    std::os::unix::fs::symlink(&elsewhere, &linked).unwrap();
    let log = std::fs::File::create(dir.join("host.log")).unwrap();
    let mut child = Host::spawn(&dir, &linked.join("host.sock"), 500, 200, 2000, log);
    let status = child.wait().unwrap();
    assert!(
        !status.success(),
        "the host must not start in a symlinked folder"
    );
    let text = std::fs::read_to_string(dir.join("host.log")).unwrap();
    assert!(text.contains("symlink"), "the host says why:\n{text}");
    assert!(!elsewhere.join("host.sock").exists());

    // A folder of ours that others can enter: tightened to 0700, not used
    // as it was.
    let open = tmp.path().join("sock-open");
    std::fs::create_dir_all(&open).unwrap();
    std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o755)).unwrap();
    let log = std::fs::File::create(dir.join("host.log")).unwrap();
    let mut child = Host::spawn(&dir, &open.join("host.sock"), 500, 200, 2000, log);
    let deadline = Instant::now() + Duration::from_secs(10);
    while !open.join("host.sock").exists() {
        assert!(Instant::now() < deadline, "host never bound its socket");
        std::thread::sleep(Duration::from_millis(50));
    }
    let mode = std::fs::metadata(&open).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o700, "the open folder was tightened");
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn a_host_with_nothing_to_do_exits_and_the_socket_folder_is_private() {
    let mut host = Host::start(200, 200);
    let mode = std::fs::metadata(host.socket.parent().unwrap())
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o700, "socket folder is user-only");
    let smode = std::fs::metadata(&host.socket)
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(smode & 0o777, 0o600, "socket is user-only");
    assert!(
        host.wait_exit(Duration::from_secs(5)),
        "idle host exits:\n{}",
        host.log()
    );
    assert!(!Path::new(&host.socket).exists());
    assert!(
        !host.socket.parent().unwrap().exists(),
        "the socket's folder goes with the host when it is empty"
    );
}
