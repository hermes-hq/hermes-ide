//! The app's side of the host protocol: a control connection for requests
//! and, after `attach`, the live byte channel of one session.

use crate::protocol::{
    read_frame, write_frame, Frame, Msg, SessionInfo, DATA_CHUNK_BYTES, PROTOCOL_VERSION,
};
use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
        Ok(Self { stream, info })
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
        Ok(Attached {
            id: id.to_string(),
            pid,
            alive,
            exit_code,
            replay_bytes,
            out: Arc::new(Mutex::new(self.stream)),
            reader: Some(reader),
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

    fn send(&self, msg: Msg) -> io::Result<()> {
        let mut stream = self.out.lock().unwrap_or_else(|e| e.into_inner());
        write_frame(&mut *stream, &Frame::Msg(msg))
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
        let _ = self.send(Msg::Detach);
        let stream = self.out.lock().unwrap_or_else(|e| e.into_inner());
        let _ = stream.shutdown(std::net::Shutdown::Both);
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
