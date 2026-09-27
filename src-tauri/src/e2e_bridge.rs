//! Test-only automation bridge (cargo feature `e2e`).
//!
//! Lets a script drive the REAL app hands-free: it evaluates JavaScript in the
//! main webview and returns the result, so a scenario can click, type and read
//! the screen without the window ever needing focus.
//!
//! Safety rails — all three must hold before a socket is opened:
//!   1. compiled with `--features e2e` (off by default, never in a release:
//!      see the `compile_error!` below);
//!   2. the process was started with `HERMES_E2E=1`;
//!   3. every request carries the random token written to the bridge file.
//!
//! The listener binds to 127.0.0.1 on an OS-assigned port, so it never clashes
//! with a dev server or a second test app.
//!
//! Protocol: plain HTTP/1.1, JSON bodies, `Authorization: Bearer <token>`.
//!   GET  /health  -> { ok, pid, identifier, version }
//!   GET  /window  -> { label, title, width, height, x, y, scaleFactor,
//!                      visible, focused, cgWindowId }
//!   POST /eval    -> body { script, timeoutMs?, window? }
//!                    `script` is the body of an async function; its return
//!                    value (JSON-serialisable) comes back as { ok, value }.
//!   POST /quit    -> asks the app to exit cleanly.

#[cfg(not(debug_assertions))]
compile_error!(
    "the `e2e` feature opens an automation socket and must never be compiled into a release build"
);

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
const DEFAULT_EVAL_TIMEOUT_MS: u64 = 10_000;
const MAX_EVAL_TIMEOUT_MS: u64 = 120_000;
const POLL_INTERVAL: Duration = Duration::from_millis(15);

static NEXT_EVAL_ID: AtomicU64 = AtomicU64::new(1);

fn enabled() -> bool {
    std::env::var("HERMES_E2E").as_deref() == Ok("1")
}

/// Builder tweaks for a test run: launch without becoming the active app, so
/// the run never takes keyboard focus from whoever is using the machine.
pub fn configure(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    if !enabled() {
        return builder;
    }
    #[cfg(target_os = "macos")]
    let builder = builder.activate_ignoring_other_apps(false);
    builder
}

/// Start the bridge. Silently does nothing unless `HERMES_E2E=1`.
pub fn start(app: &AppHandle) {
    if !enabled() {
        log::info!("[e2e] feature compiled in but HERMES_E2E != 1 — bridge not started");
        return;
    }

    let listener = match TcpListener::bind(("127.0.0.1", 0)) {
        Ok(l) => l,
        Err(e) => {
            log::error!("[e2e] failed to bind bridge socket: {}", e);
            return;
        }
    };
    let port = match listener.local_addr() {
        Ok(a) => a.port(),
        Err(e) => {
            log::error!("[e2e] failed to read bridge port: {}", e);
            return;
        }
    };

    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );

    let bridge_file = std::env::var("HERMES_E2E_BRIDGE_FILE")
        .ok()
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| {
            app.path()
                .app_data_dir()
                .ok()
                .map(|d| d.join("e2e-bridge.json"))
        });
    let Some(bridge_file) = bridge_file else {
        log::error!("[e2e] no location for the bridge file");
        return;
    };

    let descriptor = json!({
        "port": port,
        "token": token,
        "pid": std::process::id(),
        "identifier": app.config().identifier,
        "version": app.package_info().version.to_string(),
    });
    if let Err(e) = write_private(&bridge_file, descriptor.to_string().as_bytes()) {
        log::error!("[e2e] failed to write {:?}: {}", bridge_file, e);
        return;
    }
    log::info!(
        "[e2e] bridge listening on 127.0.0.1:{} (descriptor: {:?})",
        port,
        bridge_file
    );

    #[cfg(target_os = "macos")]
    keep_rendering_in_background(app);

    let app = app.clone();
    std::thread::Builder::new()
        .name("hermes-e2e-bridge".into())
        .spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let app = app.clone();
                let token = token.clone();
                let _ = std::thread::Builder::new()
                    .name("hermes-e2e-conn".into())
                    .spawn(move || handle_connection(stream, &app, &token));
            }
        })
        .ok();
}

/// Write a file readable only by the current user (the token lives in it).
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    f.write_all(bytes)?;
    f.flush()
}

struct Request {
    method: String,
    path: String,
    token: Option<String>,
    body: Vec<u8>,
}

fn read_request(stream: &TcpStream) -> Result<Request, String> {
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

fn respond(mut stream: &TcpStream, status: u16, body: &Value) {
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

/// Compare without leaking the match length through timing.
fn token_matches(given: &str, expected: &str) -> bool {
    let (a, b) = (given.as_bytes(), expected.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn handle_connection(stream: TcpStream, app: &AppHandle, token: &str) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));

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

    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/health") => respond(
            &stream,
            200,
            &json!({
                "ok": true,
                "pid": std::process::id(),
                "identifier": app.config().identifier,
                "version": app.package_info().version.to_string(),
            }),
        ),
        ("GET", "/window") => match window_info(app, "main") {
            Ok(v) => respond(&stream, 200, &v),
            Err(e) => respond(&stream, 500, &json!({ "ok": false, "error": e })),
        },
        ("POST", "/eval") => {
            let body: Value = match serde_json::from_slice(&req.body) {
                Ok(v) => v,
                Err(e) => {
                    return respond(
                        &stream,
                        400,
                        &json!({ "ok": false, "error": format!("invalid JSON body: {}", e) }),
                    )
                }
            };
            let Some(script) = body.get("script").and_then(Value::as_str) else {
                return respond(
                    &stream,
                    400,
                    &json!({ "ok": false, "error": "`script` is required" }),
                );
            };
            let label = body.get("window").and_then(Value::as_str).unwrap_or("main");
            let timeout_ms = body
                .get("timeoutMs")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_EVAL_TIMEOUT_MS)
                .min(MAX_EVAL_TIMEOUT_MS);

            match eval_js(app, label, script, Duration::from_millis(timeout_ms)) {
                Ok(v) => respond(&stream, 200, &v),
                Err(e) => respond(&stream, 500, &json!({ "ok": false, "error": e })),
            }
        }
        ("POST", "/quit") => {
            respond(&stream, 200, &json!({ "ok": true }));
            app.exit(0);
        }
        _ => respond(
            &stream,
            404,
            &json!({ "ok": false, "error": "unknown route" }),
        ),
    }
}

/// Run one JavaScript call and wait for its result.
///
/// The webview's native "evaluate" does not await promises, so this works in
/// two phases: start the async function and park its outcome in a slot on
/// `window`, then poll that slot until it is filled or the timeout expires.
fn eval_js(app: &AppHandle, label: &str, script: &str, timeout: Duration) -> Result<Value, String> {
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| format!("no webview window labelled '{}'", label))?;

    let slot = format!("r{}", NEXT_EVAL_ID.fetch_add(1, Ordering::SeqCst));
    let deadline = Instant::now() + timeout;

    let kickoff = format!(
        r#"(function () {{
  var store = (window.__HERMES_E2E_RESULTS__ = window.__HERMES_E2E_RESULTS__ || {{}});
  var done = function (ok, value) {{
    var out;
    try {{ out = JSON.stringify({{ ok: ok, value: value === undefined ? null : value }}); }}
    catch (e) {{ out = JSON.stringify({{ ok: false, value: "result is not JSON-serialisable: " + String(e) }}); }}
    store["{slot}"] = out;
  }};
  var describe = function (e) {{ return (e && (e.stack || e.message)) ? String(e.message || e) + "\n" + String(e.stack || "") : String(e); }};
  try {{
    Promise.resolve((async function () {{
{script}
    }})()).then(function (v) {{ done(true, v); }}, function (e) {{ done(false, describe(e)); }});
  }} catch (e) {{ done(false, describe(e)); }}
  return "started";
}})()"#,
        slot = slot,
        script = script
    );

    let started = eval_once(&window, kickoff, Duration::from_secs(5).min(timeout))?;
    if started.as_str() != Some("started") {
        return Err(format!(
            "script did not start (syntax error, or the page is still loading); webview returned: {}",
            started
        ));
    }

    let poll = format!(
        r#"(function () {{
  var store = window.__HERMES_E2E_RESULTS__;
  if (!store || !Object.prototype.hasOwnProperty.call(store, "{slot}")) return null;
  var v = store["{slot}"];
  delete store["{slot}"];
  return v;
}})()"#,
        slot = slot
    );

    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(format!(
                "script did not finish within {} ms",
                timeout.as_millis()
            ));
        }
        let got = eval_once(
            &window,
            poll.clone(),
            remaining.max(Duration::from_millis(250)),
        )?;
        if let Some(text) = got.as_str() {
            return serde_json::from_str::<Value>(text)
                .map_err(|e| format!("could not decode script result: {}", e));
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// One synchronous evaluate; returns the expression's value decoded from JSON
/// (`Value::Null` when the webview reports nothing, e.g. on a syntax error).
fn eval_once(
    window: &tauri::WebviewWindow,
    js: String,
    timeout: Duration,
) -> Result<Value, String> {
    let (tx, rx) = mpsc::channel::<String>();
    window
        .eval_with_callback(js, move |result| {
            let _ = tx.send(result);
        })
        .map_err(|e| format!("eval failed: {}", e))?;

    match rx.recv_timeout(timeout) {
        Ok(raw) if raw.is_empty() => Ok(Value::Null),
        Ok(raw) => Ok(serde_json::from_str(&raw).unwrap_or(Value::String(raw))),
        Err(_) => Err("the webview did not answer (page not loaded yet?)".into()),
    }
}

fn window_info(app: &AppHandle, label: &str) -> Result<Value, String> {
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| format!("no webview window labelled '{}'", label))?;

    let size = window.inner_size().map_err(|e| e.to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;

    Ok(json!({
        "ok": true,
        "label": label,
        "pid": std::process::id(),
        "title": window.title().unwrap_or_default(),
        "width": size.width,
        "height": size.height,
        "x": pos.x,
        "y": pos.y,
        "scaleFactor": window.scale_factor().unwrap_or(1.0),
        "visible": window.is_visible().unwrap_or(false),
        "focused": window.is_focused().unwrap_or(false),
        "cgWindowId": native_window_id(app, &window),
    }))
}

#[cfg(target_os = "macos")]
mod objc {
    use std::ffi::c_void;
    use std::os::raw::c_char;

    #[link(name = "objc", kind = "dylib")]
    extern "C" {
        pub fn sel_registerName(name: *const c_char) -> *mut c_void;
        pub fn objc_getClass(name: *const c_char) -> *mut c_void;
        pub fn objc_retain(obj: *mut c_void) -> *mut c_void;
        pub fn objc_msgSend();
    }

    pub type Id = *mut c_void;

    /// SAFETY (all four): `obj` must be a live object that implements `sel`
    /// with exactly this argument list and return type.
    pub unsafe fn send_id(obj: Id, sel: &std::ffi::CStr) -> Id {
        let f: extern "C" fn(Id, Id) -> Id =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        f(obj, sel_registerName(sel.as_ptr()))
    }
    pub unsafe fn send_isize(obj: Id, sel: &std::ffi::CStr) -> isize {
        let f: extern "C" fn(Id, Id) -> isize =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        f(obj, sel_registerName(sel.as_ptr()))
    }
    pub unsafe fn send_bool_arg(obj: Id, sel: &std::ffi::CStr, arg: bool) {
        let f: extern "C" fn(Id, Id, bool) =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        f(obj, sel_registerName(sel.as_ptr()), arg)
    }
    pub unsafe fn responds_to(obj: Id, sel: &std::ffi::CStr) -> bool {
        let f: extern "C" fn(Id, Id, Id) -> bool =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        f(
            obj,
            sel_registerName(c"respondsToSelector:".as_ptr()),
            sel_registerName(sel.as_ptr()),
        )
    }
}

/// macOS pauses painting, animations and animation frames in a window that is
/// covered, in the background, or behind a locked screen — which is exactly
/// where a hands-free test window lives. Tell the webview to keep going, and
/// tell the system not to put the process to sleep ("App Nap").
#[cfg(target_os = "macos")]
fn keep_rendering_in_background(app: &AppHandle) {
    use objc::*;

    // SAFETY: standard Foundation calls; the activity token is retained on
    // purpose so the "stay awake" request lasts for the life of the process.
    unsafe {
        let info = send_id(objc_getClass(c"NSProcessInfo".as_ptr()), c"processInfo");
        let reason: Id = {
            let f: extern "C" fn(Id, Id, *const std::os::raw::c_char) -> Id =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            f(
                objc_getClass(c"NSString".as_ptr()),
                sel_registerName(c"stringWithUTF8String:".as_ptr()),
                c"Hermes end-to-end test run".as_ptr(),
            )
        };
        // NSActivityUserInitiatedAllowingIdleSystemSleep | NSActivityLatencyCritical
        let options: u64 = (0x00FF_FFFF & !(1 << 20)) | 0xFF_0000_0000;
        let f: extern "C" fn(Id, Id, u64, Id) -> Id =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let token = f(
            info,
            sel_registerName(c"beginActivityWithOptions:reason:".as_ptr()),
            options,
            reason,
        );
        if !token.is_null() {
            objc_retain(token);
        }
    }

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let result = window.with_webview(|webview| {
        let wk = webview.inner();
        if wk.is_null() {
            return;
        }
        // SAFETY: `wk` is the live WKWebView; the selector is checked first.
        unsafe {
            let sel = c"_setWindowOcclusionDetectionEnabled:";
            if responds_to(wk, sel) {
                send_bool_arg(wk, sel, false);
                // The webview only re-reads its visibility when something
                // about the view changes, so nudge it once.
                send_bool_arg(wk, c"setHidden:", true);
                send_bool_arg(wk, c"setHidden:", false);
                log::info!("[e2e] webview keeps rendering while hidden or covered");
            } else {
                log::warn!("[e2e] this macOS cannot keep a hidden webview rendering");
            }
        }
    });
    if let Err(e) = result {
        log::warn!("[e2e] could not reach the webview: {}", e);
    }
}

/// macOS: the window number, which is what `screencapture -l <id>` takes.
/// Capturing by id needs neither focus nor the window being frontmost.
#[cfg(target_os = "macos")]
fn native_window_id(app: &AppHandle, window: &tauri::WebviewWindow) -> Option<i64> {
    // AppKit objects must be touched on the main thread.
    let (tx, rx) = mpsc::channel::<Option<i64>>();
    let window = window.clone();
    app.run_on_main_thread(move || {
        let id = window.ns_window().ok().and_then(|ns_window| {
            if ns_window.is_null() {
                return None;
            }
            // SAFETY: `ns_window` is a live NSWindow owned by the runtime and
            // `-[NSWindow windowNumber]` takes no arguments and returns NSInteger.
            Some(unsafe { objc::send_isize(ns_window, c"windowNumber") } as i64)
        });
        let _ = tx.send(id);
    })
    .ok()?;

    rx.recv_timeout(Duration::from_secs(5)).ok().flatten()
}

#[cfg(not(target_os = "macos"))]
fn native_window_id(_app: &AppHandle, _window: &tauri::WebviewWindow) -> Option<i64> {
    None
}
