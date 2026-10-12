//! The app's side of the host protocol: a control connection for requests
//! and, after `attach`, the live byte channel of one session.

use crate::protocol::{
    read_frame, write_frame, Frame, Msg, SessionInfo, DATA_CHUNK_BYTES, PROTOCOL_VERSION,
};
use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};
use std::time::{Duration, Instant};

/// How long resize, kill and detach wait for the live channel while input
/// is being written to it.
const CHANNEL_WAIT: Duration = Duration::from_millis(200);
/// Bounds a request sent beside the live channel, so a host that stopped
/// reading cannot hold the caller (the app's main thread) for good.
const SIDE_REQUEST_TIMEOUT: Duration = Duration::from_secs(2);

/// What the host said in its `HelloAck`.
#[derive(Debug, Clone)]
pub struct HostInfo {
    pub version: String,
    pub pid: u32,
    pub exe: String,
    pub started_at: u64,
}

pub struct Connection {
    stream: UnixStream,
    info: HostInfo,
    socket: PathBuf,
    token: String,
}

fn other(msg: impl Into<String>) -> io::Error {
    io::Error::other(msg.into())
}

impl Connection {
    /// Connects and completes the handshake within `timeout`.
    pub fn connect(socket: &Path, token: &str, timeout: Duration) -> io::Result<Self> {
        let mut stream = UnixStream::connect(socket)?;
        stream.set_read_timeout(Some(timeout))?;
        stream.set_write_timeout(Some(timeout))?;
        write_frame(
            &mut stream,
            &Frame::Msg(Msg::Hello {
                token: token.to_string(),
                proto: PROTOCOL_VERSION,
            }),
        )?;
        let info = match read_frame(&mut stream)? {
            Some(Frame::Msg(Msg::HelloAck {
                proto,
                version,
                pid,
                exe,
                started_at,
            })) => {
                if proto != PROTOCOL_VERSION {
                    return Err(other(format!(
                        "host speaks protocol {proto}, this app speaks {PROTOCOL_VERSION}"
                    )));
                }
                HostInfo {
                    version,
                    pid,
                    exe,
                    started_at,
                }
            }
            Some(Frame::Msg(Msg::Error { message })) => {
                return Err(other(format!("host refused the connection: {message}")))
            }
            _ => return Err(other("host did not answer the hello")),
        };
        Ok(Self {
            stream,
            info,
            socket: socket.to_path_buf(),
            token: token.to_string(),
        })
    }

    pub fn info(&self) -> &HostInfo {
        &self.info
    }

    fn request(&mut self, msg: Msg) -> io::Result<Msg> {
        write_frame(&mut self.stream, &Frame::Msg(msg))?;
        match read_frame(&mut self.stream)? {
            Some(Frame::Msg(Msg::Error { message })) => Err(other(message)),
            Some(Frame::Msg(reply)) => Ok(reply),
            Some(Frame::Data(_)) => Err(other("unexpected data frame")),
            None => Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "host closed the connection",
            )),
        }
    }

    pub fn ping(&mut self) -> io::Result<()> {
        match self.request(Msg::Ping)? {
            Msg::Pong => Ok(()),
            other_msg => Err(other(format!("unexpected reply {other_msg:?}"))),
        }
    }

    pub fn list(&mut self) -> io::Result<Vec<SessionInfo>> {
        match self.request(Msg::List)? {
            Msg::Sessions { sessions } => Ok(sessions),
            other_msg => Err(other(format!("unexpected reply {other_msg:?}"))),
        }
    }

    /// Starts a program in a new PTY owned by the host. Returns its pid.
    pub fn spawn(
        &mut self,
        id: &str,
        argv: Vec<String>,
        env: Vec<(String, String)>,
        cwd: &str,
        rows: u16,
        cols: u16,
    ) -> io::Result<u32> {
        match self.request(Msg::Spawn {
            id: id.to_string(),
            argv,
            env,
            cwd: cwd.to_string(),
            rows,
            cols,
        })? {
            Msg::Spawned { pid, .. } => Ok(pid),
            other_msg => Err(other(format!("unexpected reply {other_msg:?}"))),
        }
    }

    pub fn kill(&mut self, id: &str) -> io::Result<()> {
        match self.request(Msg::Kill { id: id.to_string() })? {
            Msg::Ok => Ok(()),
            other_msg => Err(other(format!("unexpected reply {other_msg:?}"))),
        }
    }

    pub fn kill_all(&mut self) -> io::Result<()> {
        match self.request(Msg::KillAll)? {
            Msg::Ok => Ok(()),
            other_msg => Err(other(format!("unexpected reply {other_msg:?}"))),
        }
    }

    /// Turns this connection into the live channel of `id`. The host replays
    /// the session's ring first, then streams live output.
    pub fn attach(mut self, id: &str, rows: u16, cols: u16) -> io::Result<Attached> {
        write_frame(
            &mut self.stream,
            &Frame::Msg(Msg::Attach {
                id: id.to_string(),
                rows,
                cols,
            }),
        )?;
        let (pid, alive, exit_code, replay_bytes) = match read_frame(&mut self.stream)? {
            Some(Frame::Msg(Msg::Attached {
                pid,
                alive,
                exit_code,
                replay_bytes,
                ..
            })) => (pid, alive, exit_code, replay_bytes),
            Some(Frame::Msg(Msg::Error { message })) => return Err(other(message)),
            _ => return Err(other("host did not confirm the attach")),
        };
        self.stream.set_read_timeout(None)?;
        self.stream.set_write_timeout(None)?;
        let reader = self.stream.try_clone()?;
        let hangup = self.stream.try_clone()?;
        Ok(Attached {
            id: id.to_string(),
            pid,
            alive,
            exit_code,
            replay_bytes,
            out: Arc::new(Mutex::new(self.stream)),
            reader: Some(reader),
            hangup,
            socket: self.socket,
            token: self.token,
        })
    }
}

/// One session's live channel: raw bytes out (a `Read`), raw bytes in (a
/// `Write`), and resize/kill on the side.
pub struct Attached {
    pub id: String,
    pub pid: u32,
    /// The program was still running at attach time.
    pub alive: bool,
    pub exit_code: Option<i32>,
    /// Bytes the host replayed at the start of the stream.
    pub replay_bytes: u64,
    out: Arc<Mutex<UnixStream>>,
    reader: Option<UnixStream>,
    /// Closes the channel without waiting for `out`.
    hangup: UnixStream,
    socket: PathBuf,
    token: String,
}

impl Attached {
    /// Makes reads on the output stream give up after `timeout` (an error
    /// of kind `WouldBlock` or `TimedOut`); `None` blocks. For tests and
    /// polling readers.
    pub fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        match &self.reader {
            Some(stream) => stream.set_read_timeout(timeout),
            None => Err(other("the reader was already taken")),
        }
    }

    /// The output stream: replayed bytes, then live output, until the
    /// program ends (`Ok(0)`) or the host goes away.
    pub fn take_reader(&mut self) -> Option<Box<dyn Read + Send>> {
        self.reader.take().map(|stream| {
            Box::new(FrameReader {
                stream,
                pending: Vec::new(),
                pos: 0,
                ended: false,
            }) as Box<dyn Read + Send>
        })
    }

    /// Input to the program.
    pub fn writer(&self) -> Box<dyn Write + Send> {
        Box::new(FrameWriter {
            out: Arc::clone(&self.out),
        })
    }

    /// Sends a request on the live channel, or, while input is stuck on it
    /// (the program leaves it unread and an older host waits on that),
    /// over a connection of its own. Never blocks for long either way.
    fn send(&self, msg: Msg) -> io::Result<()> {
        if let Some(mut stream) = lock_within(&self.out, CHANNEL_WAIT) {
            stream.set_write_timeout(Some(SIDE_REQUEST_TIMEOUT))?;
            let sent = write_frame(&mut *stream, &Frame::Msg(msg));
            let _ = stream.set_write_timeout(None);
            if sent.is_err() {
                // A frame cut short leaves the channel unreadable.
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
            return sent;
        }
        let mut conn = Connection::connect(&self.socket, &self.token, SIDE_REQUEST_TIMEOUT)?;
        match conn.request(msg)? {
            Msg::Ok => Ok(()),
            other_msg => Err(other(format!("unexpected reply {other_msg:?}"))),
        }
    }

    pub fn resize(&self, rows: u16, cols: u16) -> io::Result<()> {
        self.send(Msg::Resize {
            id: self.id.clone(),
            rows,
            cols,
        })
    }

    pub fn kill(&self) -> io::Result<()> {
        self.send(Msg::Kill {
            id: self.id.clone(),
        })
    }

    /// Leaves the program running in the host and closes the channel.
    pub fn detach(&self) {
        // The host takes a closed channel as a detach too, so a stuck one is
        // just closed.
        if let Some(mut stream) = lock_within(&self.out, CHANNEL_WAIT) {
            if stream.set_write_timeout(Some(SIDE_REQUEST_TIMEOUT)).is_ok() {
                let _ = write_frame(&mut *stream, &Frame::Msg(Msg::Detach));
            }
        }
        let _ = self.hangup.shutdown(std::net::Shutdown::Both);
    }
}

/// Locks `m`, giving up after `wait`.
fn lock_within<T>(m: &Mutex<T>, wait: Duration) -> Option<MutexGuard<'_, T>> {
    let deadline = Instant::now() + wait;
    loop {
        match m.try_lock() {
            Ok(guard) => return Some(guard),
            Err(TryLockError::Poisoned(e)) => return Some(e.into_inner()),
            Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(TryLockError::WouldBlock) => return None,
        }
    }
}

struct FrameReader {
    stream: UnixStream,
    pending: Vec<u8>,
    pos: usize,
    ended: bool,
}

impl Read for FrameReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            if self.pos < self.pending.len() {
                let n = (self.pending.len() - self.pos).min(buf.len());
                buf[..n].copy_from_slice(&self.pending[self.pos..self.pos + n]);
                self.pos += n;
                return Ok(n);
            }
            if self.ended {
                return Ok(0);
            }
            match read_frame(&mut self.stream)? {
                None => {
                    self.ended = true;
                    return Ok(0);
                }
                Some(Frame::Data(bytes)) => {
                    self.pending = bytes;
                    self.pos = 0;
                }
                Some(Frame::Msg(Msg::Exited { .. })) => {
                    self.ended = true;
                    return Ok(0);
                }
                Some(Frame::Msg(Msg::Error { message })) => return Err(other(message)),
                Some(Frame::Msg(_)) => {}
            }
        }
    }
}

struct FrameWriter {
    out: Arc<Mutex<UnixStream>>,
}

impl Write for FrameWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        // One frame holds at most DATA_CHUNK_BYTES: a big paste goes as
        // several frames (`write_all` loops), never as one the host refuses
        // for being over MAX_FRAME_BYTES (CHAOS-05).
        let n = buf.len().min(DATA_CHUNK_BYTES);
        let mut stream = self.out.lock().unwrap_or_else(|e| e.into_inner());
        write_frame(&mut *stream, &Frame::Data(buf[..n].to_vec()))?;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;
    use std::sync::mpsc;

    fn handshake(stream: &mut UnixStream) {
        match read_frame(stream).unwrap() {
            Some(Frame::Msg(Msg::Hello { .. })) => {}
            other => panic!("expected hello, got {other:?}"),
        }
        write_frame(
            stream,
            &Frame::Msg(Msg::HelloAck {
                proto: PROTOCOL_VERSION,
                version: "test".into(),
                pid: 1,
                exe: String::new(),
                started_at: 0,
            }),
        )
        .unwrap();
    }

    /// A host that stops reading the live channel after the attach (as an
    /// older host did while the program left its input unread): input
    /// written to it blocks, and resize, kill and detach must still return
    /// promptly instead of waiting behind it.
    #[test]
    fn resize_kill_and_detach_return_while_input_is_stuck_on_the_channel() {
        let tmp = tempfile::Builder::new()
            .prefix("hpc-")
            .tempdir_in("/tmp")
            .unwrap();
        let socket = tmp.path().join("s.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let (seen_tx, seen_rx) = mpsc::channel::<Msg>();
        std::thread::spawn(move || {
            let (mut live, _) = listener.accept().unwrap();
            handshake(&mut live);
            match read_frame(&mut live).unwrap() {
                Some(Frame::Msg(Msg::Attach { id, .. })) => write_frame(
                    &mut live,
                    &Frame::Msg(Msg::Attached {
                        id,
                        pid: 1,
                        alive: true,
                        exit_code: None,
                        replay_bytes: 0,
                    }),
                )
                .unwrap(),
                other => panic!("expected attach, got {other:?}"),
            }
            // Never read from `live` again; answer side requests.
            for conn in listener.incoming() {
                let mut conn = conn.unwrap();
                handshake(&mut conn);
                if let Ok(Some(Frame::Msg(msg))) = read_frame(&mut conn) {
                    let _ = write_frame(&mut conn, &Frame::Msg(Msg::Ok));
                    let _ = seen_tx.send(msg);
                }
            }
            drop(live);
        });

        let attached = Connection::connect(&socket, "token", Duration::from_secs(3))
            .unwrap()
            .attach("s1", 24, 80)
            .unwrap();
        let mut writer = attached.writer();
        let feeder = std::thread::spawn(move || writer.write_all(&vec![b'x'; 16 << 20]));
        // Long enough for the socket buffers to fill and the write to block.
        std::thread::sleep(Duration::from_millis(500));
        assert!(!feeder.is_finished(), "the input write should be stuck");

        let started = Instant::now();
        attached.resize(30, 100).unwrap();
        attached.kill().unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "resize and kill waited {:?}",
            started.elapsed()
        );
        let got = |rx: &mpsc::Receiver<Msg>| rx.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(
            got(&seen_rx),
            Msg::Resize {
                id: "s1".into(),
                rows: 30,
                cols: 100
            }
        );
        assert_eq!(got(&seen_rx), Msg::Kill { id: "s1".into() });

        let started = Instant::now();
        attached.detach();
        assert!(started.elapsed() < Duration::from_secs(3));
        // Closing the channel also frees the stuck input write.
        assert!(feeder.join().unwrap().is_err());
    }
}
