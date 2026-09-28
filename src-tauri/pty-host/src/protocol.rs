//! The framed protocol between the app and the host.
//!
//! Every frame is `[u32 big-endian length][u8 tag][payload]`. Tag 0 carries
//! one JSON control message (`Msg`); tag 1 carries raw terminal bytes for
//! the session the connection is attached to. Frames are written whole under
//! one lock per connection, so a data frame can never interleave with a
//! control message.
//!
//! A connection starts with `Hello {token}` and is refused until it arrives.
//! After that it is either a control connection (`Spawn`, `List`, `Kill`,
//! `KillAll`, `Ping`: one request, one reply) or, after `Attach`, the live
//! channel of one session: the host replays the ring as data frames, then
//! streams live output, and `Exited` ends the stream when the program ends.
//! The client sends input as data frames and `Resize`/`Kill` as messages.

use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};

/// Protocol version. Bumped only for an incompatible change; a host and an
/// app with different versions refuse each other.
pub const PROTOCOL_VERSION: u32 = 1;

/// Largest frame either side accepts (a ring replay is chunked below this).
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

/// Largest data frame the host sends at once.
pub const DATA_CHUNK_BYTES: usize = 64 * 1024;

const TAG_MSG: u8 = 0;
const TAG_DATA: u8 = 1;

/// What the host knows about one session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionInfo {
    pub id: String,
    pub pid: u32,
    /// The program is still running.
    pub alive: bool,
    /// Set once the program ended.
    #[serde(default)]
    pub exit_code: Option<i32>,
    /// A client is attached right now.
    pub attached: bool,
    /// Bytes currently held in the ring.
    pub ring_bytes: u64,
    /// Bytes the session produced in total.
    pub total_bytes: u64,
    /// Milliseconds since the last output, if any.
    #[serde(default)]
    pub last_output_ms_ago: Option<u64>,
    /// Unix time (ms) the session was spawned.
    pub started_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Msg {
    Hello {
        token: String,
        proto: u32,
    },
    HelloAck {
        proto: u32,
        version: String,
        pid: u32,
        /// The path the host runs from (a versioned copy in app data).
        exe: String,
        started_at: u64,
    },
    Spawn {
        id: String,
        argv: Vec<String>,
        env: Vec<(String, String)>,
        cwd: String,
        rows: u16,
        cols: u16,
    },
    Spawned {
        id: String,
        pid: u32,
    },
    List,
    Sessions {
        sessions: Vec<SessionInfo>,
    },
    Attach {
        id: String,
        rows: u16,
        cols: u16,
    },
    Attached {
        id: String,
        pid: u32,
        alive: bool,
        #[serde(default)]
        exit_code: Option<i32>,
        replay_bytes: u64,
    },
    Detach,
    Resize {
        id: String,
        rows: u16,
        cols: u16,
    },
    Kill {
        id: String,
    },
    KillAll,
    Ping,
    Pong,
    Ok,
    Error {
        message: String,
    },
    /// The program in the attached session ended; no more data follows.
    Exited {
        id: String,
        #[serde(default)]
        code: Option<i32>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Msg(Msg),
    Data(Vec<u8>),
}

/// Encodes one frame.
pub fn encode_frame(frame: &Frame) -> io::Result<Vec<u8>> {
    let (tag, payload): (u8, Vec<u8>) = match frame {
        Frame::Msg(msg) => (TAG_MSG, serde_json::to_vec(msg).map_err(io::Error::other)?),
        Frame::Data(bytes) => (TAG_DATA, bytes.clone()),
    };
    let len = payload.len() + 1;
    if len > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("frame of {len} bytes exceeds the limit"),
        ));
    }
    let mut out = Vec::with_capacity(4 + len);
    out.extend_from_slice(&(len as u32).to_be_bytes());
    out.push(tag);
    out.extend_from_slice(&payload);
    Ok(out)
}

/// Writes one frame, whole.
pub fn write_frame<W: Write>(w: &mut W, frame: &Frame) -> io::Result<()> {
    let bytes = encode_frame(frame)?;
    w.write_all(&bytes)?;
    w.flush()
}

/// Reads one frame. `Ok(None)` on a clean end of stream (no partial frame).
pub fn read_frame<R: Read>(r: &mut R) -> io::Result<Option<Frame>> {
    let mut len_buf = [0u8; 4];
    match r.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_be_bytes(len_buf) as usize;
    if len == 0 || len > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("bad frame length {len}"),
        ));
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload)?;
    let tag = payload[0];
    let body = payload.split_off(1);
    match tag {
        TAG_MSG => {
            let msg: Msg = serde_json::from_slice(&body)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            Ok(Some(Frame::Msg(msg)))
        }
        TAG_DATA => Ok(Some(Frame::Data(body))),
        other => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unknown frame tag {other}"),
        )),
    }
}

/// Unix time in milliseconds.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn frames_round_trip_in_order() {
        let frames = vec![
            Frame::Msg(Msg::Hello {
                token: "abc".into(),
                proto: PROTOCOL_VERSION,
            }),
            Frame::Data(b"hello \x1b[31mworld\x1b[0m\r\n".to_vec()),
            Frame::Msg(Msg::Exited {
                id: "s1".into(),
                code: Some(0),
            }),
            Frame::Data(vec![]),
        ];
        let mut wire = Vec::new();
        for f in &frames {
            write_frame(&mut wire, f).unwrap();
        }
        let mut cursor = Cursor::new(wire);
        let mut back = Vec::new();
        while let Some(f) = read_frame(&mut cursor).unwrap() {
            back.push(f);
        }
        assert_eq!(back, frames);
    }

    #[test]
    fn clean_eof_is_none_and_torn_frame_is_an_error() {
        let mut empty = Cursor::new(Vec::<u8>::new());
        assert!(read_frame(&mut empty).unwrap().is_none());

        let mut wire = Vec::new();
        write_frame(&mut wire, &Frame::Data(b"12345".to_vec())).unwrap();
        wire.truncate(wire.len() - 2);
        let mut torn = Cursor::new(wire);
        assert!(read_frame(&mut torn).is_err());
    }

    #[test]
    fn oversized_and_unknown_frames_are_refused() {
        let big = Frame::Data(vec![0u8; MAX_FRAME_BYTES]);
        assert!(encode_frame(&big).is_err());

        let mut wire = Vec::new();
        wire.extend_from_slice(&2u32.to_be_bytes());
        wire.push(9);
        wire.push(0);
        assert!(read_frame(&mut Cursor::new(wire)).is_err());

        let mut zero = Vec::new();
        zero.extend_from_slice(&0u32.to_be_bytes());
        assert!(read_frame(&mut Cursor::new(zero)).is_err());
    }

    #[test]
    fn messages_are_tagged_json_with_optional_fields_defaulted() {
        let json = serde_json::to_string(&Msg::Attach {
            id: "s".into(),
            rows: 24,
            cols: 80,
        })
        .unwrap();
        assert!(json.contains("\"t\":\"attach\""));
        let exited: Msg = serde_json::from_str(r#"{"t":"exited","id":"s"}"#).unwrap();
        assert_eq!(
            exited,
            Msg::Exited {
                id: "s".into(),
                code: None
            }
        );
    }
}
