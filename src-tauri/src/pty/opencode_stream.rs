//! OpenCode's local event stream as a signal source (F11).
//!
//! OpenCode has no per-launch hook file, but its TUI runs a local server.
//! Hermes starts it on a loopback port of its choosing with a per-launch
//! password (`OPENCODE_SERVER_PASSWORD`), then reads `GET /event`: a
//! server-sent-events stream whose first event is `server.connected`, then
//! the bus (`permission.asked`, `session.idle`, `session.error`,
//! `session.status`, ...).
//!
//! Hermes only reads. Nothing here ever sends a permission reply or any
//! other request: the one HTTP request this module makes is that GET, and
//! the test below asserts it (see `only_ever_gets_the_event_stream`).
//!
//! Plain `std::net` and a hand-rolled HTTP/1.1 client: no runtime, no
//! extra crate, and easy to serve from a test.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use base64::Engine;
use tauri::AppHandle;

use super::launch::StreamSpec;
use super::models::{Session, SessionPhase};
use crate::contract::signal::status_kind_of;
use crate::contract::{AgentStatus, AgentStatusKind, Confidence, SessionEvent};

/// Connection attempts are spaced this far apart while the agent starts.
const RETRY_EVERY: Duration = Duration::from_secs(1);
/// After this long without a stream, Hermes stops trying.
const GIVE_UP_AFTER: Duration = Duration::from_secs(90);
/// The user name OpenCode expects with `OPENCODE_SERVER_PASSWORD`.
const USERNAME: &str = "opencode";

/// Epoch milliseconds, for the events' `at`.
pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The one request Hermes sends.
pub fn request_bytes(secret: &str) -> Vec<u8> {
    let auth = base64::engine::general_purpose::STANDARD.encode(format!("{USERNAME}:{secret}"));
    format!(
        "GET /event HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\nAuthorization: Basic {auth}\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n"
    )
    .into_bytes()
}

fn payload_str<'a>(v: &'a serde_json::Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| v.get(k).and_then(serde_json::Value::as_str))
        .filter(|s| !s.trim().is_empty())
}

/// The SessionEvent one bus event means, or None for one Hermes ignores.
pub fn event_to_session_event(
    v: &serde_json::Value,
    confidence: Confidence,
    at: i64,
) -> Option<SessionEvent> {
    let kind = v.get("type").and_then(serde_json::Value::as_str)?;
    let props = v
        .get("properties")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let source = Some("stream:opencode".to_string());
    let status_kind = status_kind_of(kind)?;
    let detail = match status_kind {
        AgentStatusKind::NeedsApproval => {
            payload_str(&props, &["title", "message", "permission", "type"])
                .map(str::to_string)
                .unwrap_or_default()
        }
        AgentStatusKind::Error => props
            .get("error")
            .and_then(|e| {
                e.get("data")
                    .and_then(|d| d.get("message"))
                    .or_else(|| e.get("message"))
                    .or_else(|| e.get("name"))
            })
            .and_then(serde_json::Value::as_str)
            .or_else(|| payload_str(&props, &["message"]))
            .map(str::to_string)
            .unwrap_or_default(),
        _ => String::new(),
    };
    Some(SessionEvent::Status {
        at,
        source,
        status: AgentStatus {
            kind: status_kind,
            confidence,
            detail: detail.chars().take(200).collect(),
        },
    })
}

/// Splits a server-sent-events byte stream into the `data:` payload of
/// each event (the lines of a multi-line `data:` joined with '\n').
#[derive(Default)]
pub struct SseParser {
    buf: String,
    data: Vec<String>,
}

impl SseParser {
    /// Feed bytes; returns the payloads of every event completed by them.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.push_str(&String::from_utf8_lossy(bytes));
        let mut out = Vec::new();
        while let Some(pos) = self.buf.find('\n') {
            let line = self.buf[..pos].trim_end_matches('\r').to_string();
            self.buf = self.buf[pos + 1..].to_string();
            if line.is_empty() {
                if !self.data.is_empty() {
                    out.push(std::mem::take(&mut self.data).join("\n"));
                }
            } else if let Some(rest) = line.strip_prefix("data:") {
                self.data
                    .push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
            }
            // `event:`, `id:`, `retry:` and comments (`:`) carry nothing for Hermes.
        }
        out
    }
}

/// Decodes an HTTP/1.1 `Transfer-Encoding: chunked` body as it arrives.
#[derive(Default)]
pub struct ChunkedDecoder {
    buf: Vec<u8>,
    /// Bytes still expected of the current chunk; None while waiting for a size line.
    remaining: Option<usize>,
    done: bool,
}

impl ChunkedDecoder {
    /// Feed raw bytes; returns the decoded body bytes they complete.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<u8> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        loop {
            if self.done {
                break;
            }
            match self.remaining {
                None => {
                    let Some(pos) = self.buf.windows(2).position(|w| w == b"\r\n") else {
                        break;
                    };
                    let line = String::from_utf8_lossy(&self.buf[..pos]).to_string();
                    self.buf.drain(..pos + 2);
                    let size_text = line.split(';').next().unwrap_or("").trim();
                    let size = usize::from_str_radix(size_text, 16).unwrap_or(0);
                    if size == 0 {
                        self.done = true;
                        break;
                    }
                    self.remaining = Some(size);
                }
                Some(left) => {
                    let take = left.min(self.buf.len());
                    out.extend_from_slice(&self.buf[..take]);
                    self.buf.drain(..take);
                    let left = left - take;
                    if left == 0 {
                        // The CRLF after the chunk.
                        if self.buf.len() < 2 {
                            self.remaining = Some(0);
                            if self.buf.len() == 2 {
                                self.buf.clear();
                                self.remaining = None;
                            }
                            break;
                        }
                        self.buf.drain(..2);
                        self.remaining = None;
                    } else {
                        self.remaining = Some(left);
                        break;
                    }
                }
            }
        }
        out
    }
}

/// Read the stream on an open connection until it ends or `stop` says so,
/// handing each `data:` payload to `on_event`. Returns Err when the server
/// refused the request (a status other than 200), so the caller can retry.
pub fn read_stream<S: Read + Write>(
    mut stream: S,
    secret: &str,
    mut stop: impl FnMut() -> bool,
    mut on_event: impl FnMut(&str),
) -> Result<(), String> {
    stream
        .write_all(&request_bytes(secret))
        .map_err(|e| e.to_string())?;
    let mut head = Vec::new();
    let mut buf = [0u8; 4096];
    // Headers first.
    let body_start;
    loop {
        let n = stream.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("closed before the headers".to_string());
        }
        head.extend_from_slice(&buf[..n]);
        if let Some(pos) = head.windows(4).position(|w| w == b"\r\n\r\n") {
            body_start = pos + 4;
            break;
        }
        if head.len() > 64 * 1024 {
            return Err("headers too long".to_string());
        }
    }
    let header_text = String::from_utf8_lossy(&head[..body_start]).to_string();
    let status_line = header_text.lines().next().unwrap_or("");
    if !status_line.contains(" 200") {
        return Err(format!("server answered {status_line}"));
    }
    let chunked = header_text.lines().any(|l| {
        l.to_ascii_lowercase().starts_with("transfer-encoding:")
            && l.to_ascii_lowercase().contains("chunked")
    });
    let mut chunks = ChunkedDecoder::default();
    let mut sse = SseParser::default();
    let deliver = |bytes: &[u8], sse: &mut SseParser, on_event: &mut dyn FnMut(&str)| {
        for payload in sse.feed(bytes) {
            on_event(&payload);
        }
    };
    let first = head[body_start..].to_vec();
    if chunked {
        let decoded = chunks.feed(&first);
        deliver(&decoded, &mut sse, &mut on_event);
    } else {
        deliver(&first, &mut sse, &mut on_event);
    }
    loop {
        if stop() {
            return Ok(());
        }
        let n = match stream.read(&mut buf) {
            Ok(0) => return Ok(()),
            Ok(n) => n,
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                continue
            }
            Err(e) => return Err(e.to_string()),
        };
        if chunked {
            let decoded = chunks.feed(&buf[..n]);
            deliver(&decoded, &mut sse, &mut on_event);
        } else {
            deliver(&buf[..n], &mut sse, &mut on_event);
        }
    }
}

/// Connect to the agent's stream (retrying while it starts) and turn its
/// events into SessionEvents until the session ends.
pub(crate) fn watch(
    app: AppHandle,
    session: Arc<StdMutex<Session>>,
    spec: StreamSpec,
    confidence: Confidence,
) {
    if spec.port == 0 {
        return;
    }
    let session_id = session.lock().map(|s| s.id.clone()).unwrap_or_default();
    std::thread::spawn(move || {
        let started = Instant::now();
        let addr = SocketAddr::from(([127, 0, 0, 1], spec.port));
        let ended = || {
            session
                .lock()
                .map(|s| {
                    matches!(
                        s.phase,
                        SessionPhase::Destroyed | SessionPhase::Disconnected
                    )
                })
                .unwrap_or(true)
        };
        loop {
            if ended() {
                return;
            }
            if started.elapsed() > GIVE_UP_AFTER {
                log::info!(
                    "[SIGNALS] {session_id}: no event stream on port {} after {:?}; giving up",
                    spec.port,
                    GIVE_UP_AFTER
                );
                return;
            }
            let Ok(stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
                std::thread::sleep(RETRY_EVERY);
                continue;
            };
            let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
            let app = app.clone();
            let sid = session_id.clone();
            let result = read_stream(stream, &spec.secret, ended, |payload| {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else {
                    return;
                };
                if let Some(event) = event_to_session_event(&v, confidence, now_millis()) {
                    crate::contract::emit_session_event(&app, &sid, event);
                }
            });
            match result {
                Ok(()) if ended() => return,
                Ok(()) => std::thread::sleep(RETRY_EVERY),
                Err(e) => {
                    log::debug!("[SIGNALS] {session_id}: event stream: {e}");
                    std::thread::sleep(RETRY_EVERY);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::mpsc;

    #[test]
    fn bus_events_map_to_statuses_and_the_rest_is_ignored() {
        let at = 9;
        let ev = |json: &str| {
            event_to_session_event(&serde_json::from_str(json).unwrap(), Confidence::Exact, at)
        };
        assert_eq!(ev(r#"{"type":"server.connected","properties":{}}"#), None);
        assert!(
            matches!(ev(r#"{"type":"permission.asked","properties":{"title":"Run npm test"}}"#),
            Some(SessionEvent::Status { status, source, at: 9 }) if status.kind == AgentStatusKind::NeedsApproval && status.detail == "Run npm test" && status.confidence == Confidence::Exact && source.as_deref() == Some("stream:opencode"))
        );
        assert!(
            matches!(ev(r#"{"type":"session.idle","properties":{"sessionID":"s"}}"#),
            Some(SessionEvent::Status { status, .. }) if status.kind == AgentStatusKind::DoneUnread)
        );
        assert!(
            matches!(ev(r#"{"type":"session.status","properties":{"status":{"type":"busy"}}}"#),
            Some(SessionEvent::Status { status, .. }) if status.kind == AgentStatusKind::Working)
        );
        assert!(
            matches!(ev(r#"{"type":"session.error","properties":{"error":{"name":"ProviderError","data":{"message":"quota"}}}}"#),
            Some(SessionEvent::Status { status, .. }) if status.kind == AgentStatusKind::Error && status.detail == "quota")
        );
        assert_eq!(ev(r#"{"type":"message.updated","properties":{}}"#), None);
        assert_eq!(ev(r#"{"nope":1}"#), None);
    }

    #[test]
    fn sse_and_chunked_bodies_are_reassembled_across_reads() {
        let mut sse = SseParser::default();
        assert!(sse.feed(b"event: x\ndata: {\"a\":").is_empty());
        assert_eq!(
            sse.feed(b"1}\n\n: comment\ndata: 2\ndata: 3\n\n"),
            vec!["{\"a\":1}".to_string(), "2\n3".to_string()]
        );
        let mut chunks = ChunkedDecoder::default();
        let mut out = chunks.feed(b"5\r\nhel");
        out.extend(chunks.feed(b"lo\r\n3;ext\r\n wo\r\n0\r\n\r\n"));
        assert_eq!(out, b"hello wo");
        assert!(chunks.feed(b"ignored after the end").is_empty());
    }

    /// The observe-only contract: the one request is `GET /event`, with the
    /// per-launch password; a permission that is asked is reported, never
    /// answered (no second request, no POST, ever).
    #[test]
    fn only_ever_gets_the_event_stream() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut req = vec![0u8; 4096];
            let n = sock.read(&mut req).unwrap();
            let body = concat!(
                "data: {\"type\":\"server.connected\",\"properties\":{}}\n\n",
                "data: {\"type\":\"permission.asked\",\"properties\":{\"title\":\"Run npm test\"}}\n\n",
                "data: {\"type\":\"session.idle\",\"properties\":{}}\n\n",
            );
            let mut resp = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
            // Two chunks, the split in the middle of an event.
            let (a, b) = body.split_at(40);
            resp.extend(
                format!(
                    "{:x}\r\n{}\r\n{:x}\r\n{}\r\n0\r\n\r\n",
                    a.len(),
                    a,
                    b.len(),
                    b
                )
                .into_bytes(),
            );
            sock.write_all(&resp).unwrap();
            // Anything the client sends after the stream ended would be a
            // second request: record it too.
            let _ = sock.set_read_timeout(Some(Duration::from_millis(300)));
            let mut more = Vec::new();
            let _ = sock.read_to_end(&mut more);
            let mut all = req[..n].to_vec();
            all.extend(more);
            tx.send(all).unwrap();
        });
        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut got = Vec::new();
        read_stream(stream, "pa55", || false, |p| got.push(p.to_string())).unwrap();
        server.join().unwrap();
        let requests = String::from_utf8(rx.recv().unwrap()).unwrap();
        assert!(
            requests.starts_with("GET /event HTTP/1.1\r\n"),
            "{requests}"
        );
        let expected_auth = base64::engine::general_purpose::STANDARD.encode("opencode:pa55");
        assert!(requests.contains(&format!("Authorization: Basic {expected_auth}\r\n")));
        assert_eq!(
            requests.matches("HTTP/1.1").count(),
            1,
            "exactly one request, ever: {requests}"
        );
        assert!(
            !requests.contains("POST"),
            "Hermes never answers a permission: {requests}"
        );
        assert_eq!(got.len(), 3);
        let events: Vec<SessionEvent> = got
            .iter()
            .filter_map(|p| {
                event_to_session_event(&serde_json::from_str(p).unwrap(), Confidence::Exact, 1)
            })
            .collect();
        assert_eq!(events.len(), 2);
        assert!(
            matches!(&events[0], SessionEvent::Status { status, .. } if status.kind == AgentStatusKind::NeedsApproval && status.detail == "Run npm test")
        );
        assert!(
            matches!(&events[1], SessionEvent::Status { status, .. } if status.kind == AgentStatusKind::DoneUnread)
        );
    }

    #[test]
    fn a_refused_request_is_an_error_so_the_caller_retries() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut req = [0u8; 1024];
            let _ = sock.read(&mut req);
            sock.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
        });
        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let err = read_stream(stream, "wrong", || false, |_| panic!("no events")).unwrap_err();
        assert!(err.contains("401"), "{err}");
    }
}
