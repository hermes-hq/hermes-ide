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
//! with a dev server or a second test app. The transport and the token check
//! live in `e2e_protocol.rs`, where they have socket-level tests.
//!
//! Protocol: plain HTTP/1.1, JSON bodies, `Authorization: Bearer <token>`.
//!   GET  /health      -> { ok, pid, identifier, version, build }
//!                        `build` is the stamp e2e/app/build.mjs compiled in
//!                        (HERMES_E2E_BUILD_STAMP), so the harness can tell
//!                        the binary it staged from one built elsewhere.
//!   GET  /window      -> { label, title, width, height, x, y, scaleFactor,
//!                          visible, focused, cgWindowId }
//!   POST /eval        -> body { script, timeoutMs?, window? }
//!                        `script` is the body of an async function; its return
//!                        value (JSON-serialisable) comes back as { ok, value }.
//!   POST /screenshot  -> body { file, window? }; writes a PNG of the window
//!                        from inside the app (no focus, no screen-recording
//!                        permission) and returns { ok, file, width, height }.
//!                        A capture that is one flat colour (nothing painted,
//!                        screen locked) is deleted and answered with an error.
//!   POST /quit        -> asks the app to exit cleanly (AppHandle::exit).
//!   POST /menu        -> body { id }; chooses the app menu item `id` the way
//!                        clicking it does (the menu's own event handler runs
//!                        on the main thread). 404 when the menu has no such
//!                        item.

#[cfg(not(debug_assertions))]
compile_error!(
    "the `e2e` feature opens an automation socket and must never be compiled into a release build"
);

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::e2e_evidence;
use crate::e2e_protocol::{self, Request, Response};

const DEFAULT_EVAL_TIMEOUT_MS: u64 = 10_000;
const MAX_EVAL_TIMEOUT_MS: u64 = 120_000;
const POLL_INTERVAL: Duration = Duration::from_millis(15);
const MAIN_THREAD_TIMEOUT: Duration = Duration::from_secs(15);
/// Grows with each retry of a flat screenshot: 250 ms, 500 ms, 750 ms, ...
const SCREENSHOT_RETRY_PAUSE: Duration = Duration::from_millis(250);
/// Set by e2e/app/build.mjs for the build it stages; None for any other build.
const BUILD_STAMP: Option<&str> = option_env!("HERMES_E2E_BUILD_STAMP");

static NEXT_EVAL_ID: AtomicU64 = AtomicU64::new(1);

fn enabled() -> bool {
    e2e_protocol::is_enabled(std::env::var("HERMES_E2E").ok().as_deref())
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

    let listener = match e2e_protocol::bind() {
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

    let token = e2e_protocol::new_token();

    let bridge_file = std::env::var("HERMES_E2E_BRIDGE_FILE")
        .ok()
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| {
            crate::instance::app_data_dir(app)
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
        "build": BUILD_STAMP,
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
    e2e_protocol::serve(listener, token, move |req| dispatch(&app, req));
}

/// Write a file readable only by the current user (the token lives in it).
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
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

fn json_body(req: &Request) -> Result<Value, Response> {
    serde_json::from_slice(&req.body)
        .map_err(|e| Response::error(400, format!("invalid JSON body: {}", e)))
}

/// Route an authenticated request. Called on a per-connection thread.
fn dispatch(app: &AppHandle, req: &Request) -> Response {
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/health") => Response::ok(json!({
            "ok": true,
            "pid": std::process::id(),
            "identifier": app.config().identifier,
            "version": app.package_info().version.to_string(),
            "build": BUILD_STAMP,
        })),
        ("GET", "/window") => match window_info(app, "main") {
            Ok(v) => Response::ok(v),
            Err(e) => Response::error(500, e),
        },
        ("POST", "/eval") => {
            let body = match json_body(req) {
                Ok(v) => v,
                Err(r) => return r,
            };
            let Some(script) = body.get("script").and_then(Value::as_str) else {
                return Response::error(400, "`script` is required");
            };
            let label = body.get("window").and_then(Value::as_str).unwrap_or("main");
            let timeout_ms = body
                .get("timeoutMs")
                .and_then(Value::as_u64)
                .unwrap_or(DEFAULT_EVAL_TIMEOUT_MS)
                .min(MAX_EVAL_TIMEOUT_MS);

            match eval_js(app, label, script, Duration::from_millis(timeout_ms)) {
                Ok(v) => Response::ok(v),
                Err(e) => Response::error(500, e),
            }
        }
        ("POST", "/screenshot") => {
            let body = match json_body(req) {
                Ok(v) => v,
                Err(r) => return r,
            };
            let Some(file) = body.get("file").and_then(Value::as_str) else {
                return Response::error(400, "`file` is required");
            };
            let label = body.get("window").and_then(Value::as_str).unwrap_or("main");
            match screenshot(app, label, std::path::Path::new(file)) {
                Ok(v) => Response::ok(v),
                Err(e) => Response::error(500, e),
            }
        }
        ("POST", "/menu") => {
            let body = match json_body(req) {
                Ok(v) => v,
                Err(r) => return r,
            };
            let Some(id) = body.get("id").and_then(Value::as_str).map(str::to_string) else {
                return Response::error(400, "`id` is required");
            };
            let in_menu = app
                .menu()
                .is_some_and(|m| crate::menu::find_menu_item_recursive(&m, &id).is_some());
            if !in_menu {
                return Response::error(404, format!("the app menu has no item '{id}'"));
            }
            // Answer first: the item may quit the app.
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(50));
                let handle = app.clone();
                let _ =
                    app.run_on_main_thread(move || crate::menu::dispatch_menu_action(&handle, id));
            });
            Response::ok(json!({ "ok": true }))
        }
        ("POST", "/quit") => {
            // Answer first: the socket may be gone once the app starts exiting.
            let app = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(50));
                app.exit(0);
            });
            Response::ok(json!({ "ok": true }))
        }
        _ => Response::error(404, "unknown route"),
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

    let started = eval_once(&window, kickoff, Duration::from_secs(5).min(timeout))
        .map_err(|e| format!("{e}; {}", who_is_busy(app)))?;
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

/// After the webview did not answer: whether the app's main thread (which
/// delivers the answer, and runs the synchronous commands) is the one that
/// is stuck, or the page itself is busy. Only for the error message, so a
/// failed run says where to look.
fn who_is_busy(app: &AppHandle) -> String {
    let (tx, rx) = mpsc::channel::<()>();
    let started = Instant::now();
    if app
        .run_on_main_thread(move || {
            let _ = tx.send(());
        })
        .is_err()
    {
        return "the main thread could not be reached".into();
    }
    match rx.recv_timeout(Duration::from_secs(2)) {
        Ok(()) => format!(
            "the app's main thread answered in {} ms, so the page itself was busy",
            started.elapsed().as_millis()
        ),
        Err(_) => "the app's main thread did not answer within 2 s either (it is blocked)".into(),
    }
}

/// Run `f` on the main thread and wait for its result. Native window and
/// toolkit objects must only be touched there.
fn on_main_thread<T, F>(app: &AppHandle, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let (tx, rx) = mpsc::channel::<T>();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| format!("could not reach the main thread: {}", e))?;
    rx.recv_timeout(MAIN_THREAD_TIMEOUT)
        .map_err(|_| "the main thread did not answer (is the app busy?)".to_string())
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

// ─── Screenshots ─────────────────────────────────────────────────────

/// Capture the window's pixels from inside the app and write them as a PNG.
///
/// Every platform asks the window (or the webview) to paint into a buffer of
/// ours, so this works while the window is covered, unfocused, on a virtual
/// display (Linux xvfb) or on a CI runner that has never granted a
/// screen-recording permission. A capture that is one flat colour is not
/// evidence of anything: it is deleted and taken again after the window was
/// asked to repaint (see `capture::prepare`), and when every attempt is flat
/// the request fails. The answer says how many attempts it took.
fn screenshot(app: &AppHandle, label: &str, file: &std::path::Path) -> Result<Value, String> {
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| format!("no webview window labelled '{}'", label))?;
    if !file.is_absolute() {
        return Err("`file` must be an absolute path".into());
    }
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {:?}: {}", parent, e))?;
    }

    let painted =
        e2e_evidence::capture_until_painted(file, e2e_evidence::PAINT_ATTEMPTS, |attempt| {
            if attempt > 1 {
                std::thread::sleep(SCREENSHOT_RETRY_PAUSE * (attempt - 1));
            }
            capture::prepare(app, &window);
            capture::capture_png(app, window.clone(), file)
        })?;
    if let Some(colour) = painted.flat_before {
        eprintln!(
            "[e2e bridge] screenshot of '{}' was one flat colour ({}) until attempt {}",
            label,
            e2e_evidence::hex(colour),
            painted.attempt
        );
    }
    Ok(json!({
        "ok": true,
        "file": file.to_string_lossy(),
        "width": painted.width,
        "height": painted.height,
        "bytes": painted.bytes,
        "attempts": painted.attempt,
    }))
}

/// Interleaved 32-bit BGRA pixels (what GDI hands out) → an opaque RGBA PNG.
#[cfg(target_os = "windows")]
fn write_png_from_bgra(
    file: &std::path::Path,
    width: u32,
    height: u32,
    stride: usize,
    pixels: &[u8],
) -> Result<(), String> {
    let row_bytes = width as usize * 4;
    let mut rgba = Vec::with_capacity(row_bytes * height as usize);
    for y in 0..height as usize {
        let row = pixels
            .get(y * stride..y * stride + row_bytes)
            .ok_or("pixel buffer is shorter than the image")?;
        for px in row.chunks_exact(4) {
            // The window is opaque; dropping alpha also undoes premultiplication.
            rgba.extend_from_slice(&[px[2], px[1], px[0], 255]);
        }
    }
    let img = image::RgbaImage::from_raw(width, height, rgba)
        .ok_or("could not assemble the image buffer")?;
    img.save(file)
        .map_err(|e| format!("write PNG {:?}: {}", file, e))
}

#[cfg(target_os = "macos")]
mod capture {
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSImage;
    use objc2_foundation::NSError;
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
    use tauri::AppHandle;

    const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(20);

    /// Nothing to do: WebKit renders the snapshot itself, whatever covers
    /// the window (and `afterScreenUpdates` waits for pending paint work).
    pub fn prepare(_app: &AppHandle, _window: &tauri::WebviewWindow) {}

    /// Ask WebKit itself for a picture of the page. The web content process
    /// renders it, so it works while the window is covered, in the background
    /// or behind a locked screen — where the window server, and so any
    /// screen capture, only hands out black.
    pub fn capture_png(
        _app: &AppHandle,
        window: tauri::WebviewWindow,
        file: &std::path::Path,
    ) -> Result<(u32, u32), String> {
        let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
        window
            .with_webview(move |webview| {
                let Some(mtm) = MainThreadMarker::new() else {
                    let _ = tx.send(Err("the webview was not reached on the main thread".into()));
                    return;
                };
                let wk = webview.inner() as *const WKWebView;
                if wk.is_null() {
                    let _ = tx.send(Err("the window has no webview yet".into()));
                    return;
                }
                // SAFETY: `inner()` is the live WKWebView of this window, and
                // `with_webview` runs this closure on the main thread.
                let wk = unsafe { &*wk };
                // SAFETY: plain WebKit calls on the main thread; the completion
                // block only reads the objects WebKit hands to it.
                unsafe {
                    let config = WKSnapshotConfiguration::new(mtm);
                    // Wait for pending layout and paint work first: the picture
                    // must show what the page is showing now, not a frame ago.
                    config.setAfterScreenUpdates(true);
                    let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                        let result = if !image.is_null() {
                            (*image)
                                .TIFFRepresentation()
                                .map(|data| data.to_vec())
                                .ok_or_else(|| "the snapshot has no bitmap".to_string())
                        } else if !error.is_null() {
                            Err(format!(
                                "WebKit could not take a snapshot: {}",
                                (*error).localizedDescription()
                            ))
                        } else {
                            Err("WebKit returned neither an image nor an error".into())
                        };
                        let _ = tx.send(result);
                    });
                    wk.takeSnapshotWithConfiguration_completionHandler(Some(&config), &handler);
                }
            })
            .map_err(|e| format!("could not reach the webview: {}", e))?;

        let tiff = rx
            .recv_timeout(SNAPSHOT_TIMEOUT)
            .map_err(|_| "WebKit did not deliver the snapshot in time".to_string())??;
        let image = image::load_from_memory_with_format(&tiff, image::ImageFormat::Tiff)
            .map_err(|e| format!("decode the snapshot: {}", e))?
            .into_rgba8();
        image
            .save(file)
            .map_err(|e| format!("write PNG {:?}: {}", file, e))?;
        Ok(image.dimensions())
    }
}

#[cfg(target_os = "windows")]
mod capture {
    use super::on_main_thread;
    use tauri::AppHandle;
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows_sys::Win32::Storage::Xps::PrintWindow;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetClientRect;

    /// Not in the public headers, but honoured since Windows 8.1: render the
    /// full composed content, which is what a WebView2 window needs.
    const PW_RENDERFULLCONTENT: u32 = 0x0000_0002;

    /// Nothing to do: PrintWindow makes the window paint into our bitmap,
    /// whatever covers it.
    pub fn prepare(_app: &AppHandle, _window: &tauri::WebviewWindow) {}

    /// PrintWindow asks the window to paint itself into our bitmap, so it
    /// works while the window is covered or the runner has no real screen.
    pub fn capture_png(
        app: &AppHandle,
        window: tauri::WebviewWindow,
        file: &std::path::Path,
    ) -> Result<(u32, u32), String> {
        let hwnd: *mut core::ffi::c_void = window.hwnd().map_err(|e| e.to_string())?.0;
        let hwnd_addr = hwnd as usize;
        let file = file.to_path_buf();
        on_main_thread(app, move || {
            let hwnd = hwnd_addr as *mut core::ffi::c_void;
            // SAFETY: plain GDI calls on handles this function creates and
            // releases itself; `hwnd` is the live main window.
            unsafe {
                let mut rect = RECT {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                };
                if GetClientRect(hwnd, &mut rect) == 0 {
                    return Err("GetClientRect failed".to_string());
                }
                let width = (rect.right - rect.left).max(0) as u32;
                let height = (rect.bottom - rect.top).max(0) as u32;
                if width == 0 || height == 0 {
                    return Err("the window has no client area".to_string());
                }

                let screen_dc = GetDC(std::ptr::null_mut());
                let mem_dc = CreateCompatibleDC(screen_dc);
                let bitmap = CreateCompatibleBitmap(screen_dc, width as i32, height as i32);
                let previous = SelectObject(mem_dc, bitmap);
                let printed = PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT);
                SelectObject(mem_dc, previous);

                let mut result = Err("PrintWindow failed".to_string());
                if printed != 0 {
                    let mut info: BITMAPINFO = std::mem::zeroed();
                    info.bmiHeader = BITMAPINFOHEADER {
                        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: width as i32,
                        biHeight: -(height as i32), // top-down rows
                        biPlanes: 1,
                        biBitCount: 32,
                        biCompression: BI_RGB,
                        biSizeImage: 0,
                        biXPelsPerMeter: 0,
                        biYPelsPerMeter: 0,
                        biClrUsed: 0,
                        biClrImportant: 0,
                    };
                    let stride = width as usize * 4;
                    let mut pixels = vec![0u8; stride * height as usize];
                    let rows = GetDIBits(
                        mem_dc,
                        bitmap,
                        0,
                        height,
                        pixels.as_mut_ptr() as *mut core::ffi::c_void,
                        &mut info,
                        DIB_RGB_COLORS,
                    );
                    result = if rows as u32 == height {
                        super::write_png_from_bgra(&file, width, height, stride, &pixels)
                            .map(|_| (width, height))
                    } else {
                        Err(format!("GetDIBits copied {} of {} rows", rows, height))
                    };
                }

                DeleteObject(bitmap);
                DeleteDC(mem_dc);
                ReleaseDC(std::ptr::null_mut(), screen_dc);
                result
            }
        })?
    }
}

#[cfg(target_os = "linux")]
mod capture {
    use std::time::Duration;

    use super::on_main_thread;
    use gtk::gdk::prelude::*;
    use gtk::prelude::*;
    use tauri::AppHandle;

    /// Waits for the page to draw two frames: one to start a frame after the
    /// repaint request, one to know it has been handed to the window.
    const NEXT_FRAMES: &str =
        "await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });";

    /// Bring the window to the top and have it repaint everything before its
    /// pixels are read.
    ///
    /// GDK reads the pixels from the X server, and xvfb runs without a window
    /// manager or compositor: every test app opens at the same spot, the one
    /// started last covers the others, and a covered window has no pixels of
    /// its own until it is exposed and repaints. Reading it before that gives
    /// whatever is on the screen there, often plain black. So: raise it, mark
    /// all of it dirty, let the main loop handle the resulting expose and draw
    /// (this returns before capture_png's own main-thread hop), and wait for
    /// the page to draw a frame. The window is never resized: that would
    /// resize the terminals in it.
    pub fn prepare(app: &AppHandle, window: &tauri::WebviewWindow) {
        let target = window.clone();
        let _ = on_main_thread(app, move || {
            let Ok(gtk_window) = target.gtk_window() else {
                return;
            };
            if let Some(gdk_window) = gtk_window.window() {
                gdk_window.raise();
                gdk_window.invalidate_rect(None, true);
                gdk_window.display().flush();
            }
            gtk_window.queue_draw();
        });
        // Best effort: a page that cannot answer still gets captured, and the
        // flat-colour check judges the result.
        let _ = super::eval_js(app, window.label(), NEXT_FRAMES, Duration::from_secs(2));
    }

    /// GDK reads the window's pixels straight from the X server, so a virtual
    /// display (xvfb) is enough — no compositor and no window manager needed.
    pub fn capture_png(
        app: &AppHandle,
        window: tauri::WebviewWindow,
        file: &std::path::Path,
    ) -> Result<(u32, u32), String> {
        let file = file.to_path_buf();
        on_main_thread(app, move || {
            let gtk_window = window.gtk_window().map_err(|e| e.to_string())?;
            let gdk_window = gtk_window
                .window()
                .ok_or("the window is not realised yet")?;
            let (width, height) = (gdk_window.width(), gdk_window.height());
            if width <= 0 || height <= 0 {
                return Err("the window has no size yet".to_string());
            }
            // Everything drawn so far must have reached the X server before
            // its pixels are read back.
            gdk_window.display().sync();
            let pixbuf = gdk_window
                .pixbuf(0, 0, width, height)
                .ok_or("gdk_pixbuf_get_from_window returned nothing")?;
            pixbuf
                .savev(&file, "png", &[])
                .map_err(|e| format!("write PNG {:?}: {}", file, e))?;
            Ok((width as u32, height as u32))
        })?
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod capture {
    use tauri::AppHandle;
    pub fn prepare(_app: &AppHandle, _window: &tauri::WebviewWindow) {}
    pub fn capture_png(
        _app: &AppHandle,
        _window: tauri::WebviewWindow,
        _file: &std::path::Path,
    ) -> Result<(u32, u32), String> {
        Err("screenshots are not implemented on this platform".into())
    }
}

// ─── macOS: keep painting while hidden, expose the window number ─────

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
    let window = window.clone();
    on_main_thread(app, move || {
        window.ns_window().ok().and_then(|ns_window| {
            if ns_window.is_null() {
                return None;
            }
            // SAFETY: `ns_window` is a live NSWindow owned by the runtime and
            // `-[NSWindow windowNumber]` takes no arguments and returns NSInteger.
            Some(unsafe { objc::send_isize(ns_window, c"windowNumber") } as i64)
        })
    })
    .ok()
    .flatten()
}

#[cfg(not(target_os = "macos"))]
fn native_window_id(_app: &AppHandle, _window: &tauri::WebviewWindow) -> Option<i64> {
    None
}
