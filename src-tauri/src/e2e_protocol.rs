//! Transport for the test-only automation bridge (see `e2e_bridge.rs`).
//!
//! A tiny HTTP/1.1 server with JSON bodies and a bearer token. It is kept free
//! of Tauri so its safety rules — loopback only, every request authenticated —
//! can be exercised with plain sockets in `cargo test --lib e2e_protocol`.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::time::Duration;

use serde_json::{json, Value};

pub const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(10);

/// The bridge only ever starts when the process was launched with
/// `HERMES_E2E=1` — not "true", not "yes", not merely set.
pub fn is_enabled(value: Option<&str>) -> bool {
    value == Some("1")
}

/// Bind to the loopback interface on an OS-assigned port. Never `0.0.0.0`.
pub fn bind() -> std::io::Result<TcpListener> {
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
}

/// A fresh 64-hex-character secret for one app process.
pub fn new_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Compare without leaking the match length through timing.
pub fn token_matches(given: &str, expected: &str) -> bool {
    let (a, b) = (given.as_bytes(), expected.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub struct Request {
    pub method: String,
    pub path: String,
    pub token: Option<String>,
    pub body: Vec<u8>,
}

pub struct Response {
    pub status: u16,
    pub body: Value,
}

impl Response {
    pub fn ok(body: Value) -> Self {
        Response { status: 200, body }
    }
    pub fn error(status: u16, message: impl Into<String>) -> Self {
        Response {
            status,
            body: json!({ "ok": false, "error": message.into() }),
        }
    }
}

pub fn read_request(stream: &TcpStream) -> Result<Request, String> {
    let mut reader = BufReader::new(stream);

    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .map_err(|e| format!("read request line: {}", e))?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    if method.is_empty() || path.is_empty() {
        return Err("malformed request line".into());
    }

    let mut content_length = 0usize;
    let mut token = None;
    loop {
        let mut line = String::new();
        let n = reader
            .read_line(&mut line)
            .map_err(|e| format!("read header: {}", e))?;
        if n == 0 {
            break;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => {
                content_length = value
                    .parse()
                    .map_err(|_| "invalid content-length".to_string())?;
            }
            "authorization" => {
                token = value
                    .strip_prefix("Bearer ")
                    .or_else(|| value.strip_prefix("bearer "))
                    .map(|s| s.trim().to_string());
            }
            _ => {}
        }
    }

    if content_length > MAX_BODY_BYTES {
        return Err("request body too large".into());
    }
    let mut body = vec![0u8; content_length];
    reader
        .read_exact(&mut body)
        .map_err(|e| format!("read body: {}", e))?;

    Ok(Request {
        method,
        path,
        token,
        body,
    })
}

pub fn respond(mut stream: &TcpStream, status: u16, body: &Value) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "Internal Server Error",
    };
    let payload = body.to_string();
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        status,
        reason,
        payload.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(payload.as_bytes());
    let _ = stream.flush();
}

/// Read one request, check its token, and only then hand it to `handler`.
/// An unauthenticated request never reaches the handler.
pub fn handle_connection(stream: TcpStream, token: &str, handler: &dyn Fn(&Request) -> Response) {
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));

    let req = match read_request(&stream) {
        Ok(r) => r,
        Err(e) => return respond(&stream, 400, &json!({ "ok": false, "error": e })),
    };

    let authorised = req
        .token
        .as_deref()
        .map(|t| token_matches(t, token))
        .unwrap_or(false);
    if !authorised {
        return respond(
            &stream,
            401,
            &json!({ "ok": false, "error": "missing or wrong token" }),
        );
    }

    let res = handler(&req);
    respond(&stream, res.status, &res.body);
}

/// Accept connections forever on a background thread, one thread per request.
pub fn serve<F>(listener: TcpListener, token: String, handler: F)
where
    F: Fn(&Request) -> Response + Send + Sync + 'static,
{
    let handler = std::sync::Arc::new(handler);
    std::thread::Builder::new()
        .name("hermes-e2e-bridge".into())
        .spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let token = token.clone();
                let handler = handler.clone();
                let _ = std::thread::Builder::new()
                    .name("hermes-e2e-conn".into())
                    .spawn(move || handle_connection(stream, &token, handler.as_ref()));
            }
        })
        .ok();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Start a server whose handler counts calls and answers 200.
    fn start() -> (SocketAddr, String, Arc<AtomicUsize>) {
        let listener = bind().expect("bind");
        let addr = listener.local_addr().unwrap();
        let token = new_token();
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        serve(listener, token.clone(), move |req| {
            seen.fetch_add(1, Ordering::SeqCst);
            Response::ok(
                json!({ "ok": true, "path": req.path, "body": String::from_utf8_lossy(&req.body) }),
            )
        });
        (addr, token, calls)
    }

    /// Send raw bytes and return (status, body).
    fn send(addr: SocketAddr, raw: &str) -> (u16, Value) {
        let mut s = TcpStream::connect(addr).expect("connect");
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        s.write_all(raw.as_bytes()).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        let status: u16 = out
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .expect("status line");
        let body = out.split("\r\n\r\n").nth(1).unwrap_or("");
        (status, serde_json::from_str(body).unwrap_or(Value::Null))
    }

    fn get(addr: SocketAddr, path: &str, auth: Option<&str>) -> (u16, Value) {
        let auth_line = auth
            .map(|t| format!("Authorization: Bearer {}\r\n", t))
            .unwrap_or_default();
        send(
            addr,
            &format!("GET {} HTTP/1.1\r\nHost: x\r\n{}\r\n", path, auth_line),
        )
    }

    #[test]
    fn only_the_exact_flag_enables_the_bridge() {
        assert!(is_enabled(Some("1")));
        assert!(!is_enabled(Some("true")));
        assert!(!is_enabled(Some("")));
        assert!(!is_enabled(Some("0")));
        assert!(!is_enabled(None));
    }

    #[test]
    fn listener_is_bound_to_loopback_only() {
        let listener = bind().unwrap();
        let addr = listener.local_addr().unwrap();
        assert!(addr.ip().is_loopback(), "bound to {}", addr);
        assert_ne!(addr.port(), 0);
    }

    #[test]
    fn request_without_token_is_refused_before_the_handler() {
        let (addr, _token, calls) = start();
        let (status, body) = get(addr, "/health", None);
        assert_eq!(status, 401);
        assert_eq!(body["ok"], json!(false));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn request_with_wrong_token_is_refused() {
        let (addr, token, calls) = start();
        let wrong = token.chars().rev().collect::<String>();
        assert_eq!(get(addr, "/health", Some(&wrong)).0, 401);
        assert_eq!(get(addr, "/health", Some(&token[..10])).0, 401);
        assert_eq!(get(addr, "/health", Some("")).0, 401);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn request_with_right_token_reaches_the_handler() {
        let (addr, token, calls) = start();
        let (status, body) = get(addr, "/health", Some(&token));
        assert_eq!(status, 200);
        assert_eq!(body["path"], json!("/health"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn body_is_delivered_by_content_length() {
        let (addr, token, _) = start();
        let payload = r#"{"script":"return 1"}"#;
        let raw = format!(
            "POST /eval HTTP/1.1\r\nAuthorization: bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            token,
            payload.len(),
            payload
        );
        let (status, body) = send(addr, &raw);
        assert_eq!(status, 200);
        assert_eq!(body["body"], json!(payload));
    }

    #[test]
    fn malformed_or_oversized_requests_are_bad_requests() {
        let (addr, token, calls) = start();
        assert_eq!(send(addr, "\r\n\r\n").0, 400);
        let huge = format!(
            "POST /eval HTTP/1.1\r\nAuthorization: Bearer {}\r\nContent-Length: {}\r\n\r\n",
            token,
            MAX_BODY_BYTES + 1
        );
        assert_eq!(send(addr, &huge).0, 400);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn tokens_compare_exactly() {
        assert!(token_matches("abc", "abc"));
        assert!(!token_matches("abd", "abc"));
        assert!(!token_matches("ab", "abc"));
        assert!(!token_matches("", "abc"));
        let (a, b) = (new_token(), new_token());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }
}
