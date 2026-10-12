//! Notices from the Hermes team: a short list of plain-text notices fetched
//! from the Hermes site, and the count of tasks landed with Hermes (the star
//! ask in the sessions sidebar reads it).
//!
//! The fetch is one GET of `notices.json`, at most once a day, with no
//! cookies, no identifiers and no query string: the same request from
//! everyone. Nothing is fetched while "Show notices from the Hermes team" is
//! off. The file is validated here and the frontend only ever sees what
//! passed: unknown versions, malformed notices, notices outside their version
//! or date window and any notice with a link outside the Hermes site or the
//! hermes-hq GitHub organisation are dropped. A failure of any kind gives an
//! empty list; it never blocks startup and never shows an error.
//!
//! The file (version 1):
//!
//! ```json
//! {"version":1,"notices":[{"id":"...","title":"...","body":"...",
//!   "link":{"label":"...","url":"https://hermes-ide.com/..."},
//!   "minVersion":"2.2.10","maxVersion":"2.3.0",
//!   "from":"2026-10-01","until":"2026-11-01T00:00:00Z"}]}
//! ```
//!
//! `link`, the version bounds and the dates are optional. A date without a
//! time starts at 00:00 UTC (`from`) or lasts the whole day (`until`).
//!
//! A notice may carry `"image":{"url":"https://hermes-ide.com/notices/x.webp",
//! "alt":"..."}`. The address must be under hermes-ide.com/notices/ and end
//! in .png, .webp or .jpg, and the alt text is required; otherwise the image
//! is dropped and the notice kept. Images are fetched with the daily fetch
//! (short timeout, at most 300 KB, the content type must match the file
//! type), kept in the app data folder and handed to the frontend as a
//! `data:` URL, so the webview never loads a remote address. Animated PNG
//! and WebP are refused outright (not cut to their first frame): a notice
//! never moves.

use chrono::{DateTime, NaiveDate, Utc};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::AppState;

// Test builds never fetch it (see `url`).
#[cfg_attr(feature = "e2e", allow(dead_code))]
pub const NOTICES_URL: &str = "https://hermes-ide.com/notices.json";
/// At most one fetch a day, successful or not.
pub const FETCH_INTERVAL_SECS: i64 = 24 * 3600;
const FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// A notices file is a few hundred bytes; anything this big is not one.
const MAX_BYTES: usize = 64 * 1024;
const MAX_NOTICES: usize = 20;
const MAX_ID: usize = 64;
const MAX_TITLE: usize = 120;
const MAX_BODY: usize = 600;
const MAX_LABEL: usize = 60;
const MAX_ALT: usize = 200;
/// Images: the largest accepted, and where they may come from.
pub const MAX_IMAGE_BYTES: usize = 300 * 1024;
const IMAGE_PREFIX: &str = "https://hermes-ide.com/notices/";

/// "on" (default) | "off". Off hides every card and stops the fetch.
pub const ENABLED_KEY: &str = "notices_enabled";
/// Unix seconds of the last fetch attempt.
pub const LAST_FETCH_KEY: &str = "notices_last_fetch";
/// The last notices file the site served (validated again on every read, so
/// a notice whose window ends disappears without a new fetch).
pub const CACHE_KEY: &str = "notices_cache";
/// `{"count":n,"days":["YYYY-MM-DD",...]}`: tasks landed, and the distinct
/// local days they were landed on (the newest few).
pub const LANDED_KEY: &str = "notices_landed";
const MAX_DAYS: usize = 30;

/// Links may only lead here.
const ALLOWED_PREFIXES: &[&str] = &["https://hermes-ide.com/", "https://github.com/hermes-hq/"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NoticeLink {
    pub label: String,
    pub url: String,
}

/// An image ready to draw: `src` is a `data:` URL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NoticeImage {
    pub src: String,
    pub alt: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Notice {
    pub id: String,
    pub title: String,
    pub body: String,
    pub link: Option<NoticeLink>,
    pub image: Option<NoticeImage>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageKind {
    Png,
    Webp,
    Jpeg,
}

impl ImageKind {
    pub fn mime(self) -> &'static str {
        match self {
            ImageKind::Png => "image/png",
            ImageKind::Webp => "image/webp",
            ImageKind::Jpeg => "image/jpeg",
        }
    }
    fn ext(self) -> &'static str {
        match self {
            ImageKind::Png => "png",
            ImageKind::Webp => "webp",
            ImageKind::Jpeg => "jpg",
        }
    }
}

/// A notice's image as the file names it (not fetched yet).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageSpec {
    pub url: String,
    pub alt: String,
    pub kind: ImageKind,
}

/// The image type of an allowed image address: https on hermes-ide.com,
/// under /notices/, ending in .png, .webp or .jpg, with no query, fragment,
/// user name or port. None for anything else (SVG included).
pub fn allowed_image_url(url: &str) -> Option<ImageKind> {
    if !url.starts_with(IMAGE_PREFIX) {
        return None;
    }
    let parsed = reqwest::Url::parse(url).ok()?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("hermes-ide.com")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !parsed.path().starts_with("/notices/")
    {
        return None;
    }
    let path = parsed.path().to_ascii_lowercase();
    if path.ends_with(".png") {
        Some(ImageKind::Png)
    } else if path.ends_with(".webp") {
        Some(ImageKind::Webp)
    } else if path.ends_with(".jpg") {
        Some(ImageKind::Jpeg)
    } else {
        None
    }
}

/// The image a notice names, when its address is allowed and it has alt text.
fn image_spec(v: &Value) -> Option<ImageSpec> {
    let image = v.get("image")?;
    let url = image.get("url")?.as_str()?.trim().to_string();
    let alt = text(image, "alt", MAX_ALT)?;
    let kind = allowed_image_url(&url)?;
    Some(ImageSpec { url, alt, kind })
}

/// Whether a PNG has an animation control chunk before its image data.
fn png_animated(bytes: &[u8]) -> bool {
    let mut at = 8;
    while at + 8 <= bytes.len() {
        let len =
            u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]) as usize;
        let kind = &bytes[at + 4..at + 8];
        if kind == b"acTL" {
            return true;
        }
        if kind == b"IDAT" || kind == b"IEND" {
            return false;
        }
        at = at.saturating_add(12).saturating_add(len);
    }
    false
}

/// Whether a WebP is animated (the VP8X animation flag, or an ANIM chunk).
fn webp_animated(bytes: &[u8]) -> bool {
    if bytes.len() > 20 && &bytes[12..16] == b"VP8X" && bytes[20] & 0x02 != 0 {
        return true;
    }
    bytes.windows(4).any(|w| w == b"ANIM")
}

/// Whether `bytes`, served with `content_type`, is a still image of `kind`
/// small enough to keep.
pub fn check_image(
    kind: ImageKind,
    content_type: Option<&str>,
    bytes: &[u8],
) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "{} bytes is not an image Hermes keeps",
            bytes.len()
        ));
    }
    let served = content_type
        .and_then(|c| c.split(';').next())
        .map(|c| c.trim().to_ascii_lowercase());
    if served.as_deref() != Some(kind.mime()) {
        return Err(format!("served as {served:?}, not {}", kind.mime()));
    }
    let ok = match kind {
        ImageKind::Png => bytes.starts_with(b"\x89PNG\r\n\x1a\n") && !png_animated(bytes),
        ImageKind::Webp => {
            bytes.len() > 12
                && &bytes[0..4] == b"RIFF"
                && &bytes[8..12] == b"WEBP"
                && !webp_animated(bytes)
        }
        ImageKind::Jpeg => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
    };
    if ok {
        Ok(())
    } else {
        Err(format!("not a still {} image", kind.mime()))
    }
}

pub fn data_url(kind: ImageKind, bytes: &[u8]) -> String {
    use base64::Engine;
    format!(
        "data:{};base64,{}",
        kind.mime(),
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// Whether a notice may link to `url`: https on hermes-ide.com, or under
/// github.com/hermes-hq/. Checked on the text and on the parsed address, so
/// a dot segment, a user name or a port cannot lead elsewhere.
pub fn allowed_link(url: &str) -> bool {
    if !ALLOWED_PREFIXES.iter().any(|p| url.starts_with(p)) {
        return false;
    }
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
    {
        return false;
    }
    match parsed.host_str() {
        Some("hermes-ide.com") => true,
        Some("github.com") => parsed.path().starts_with("/hermes-hq/"),
        _ => false,
    }
}

/// "x.y.z", digits only.
fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let mut parts = v.split('.');
    let mut next = || -> Option<u64> {
        let p = parts.next()?;
        if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) || p.len() > 9 {
            return None;
        }
        p.parse().ok()
    };
    let out = (next()?, next()?, next()?);
    parts.next().is_none().then_some(out)
}

/// The app's own version, a pre-release or build suffix ignored.
fn app_version(v: &str) -> Option<(u64, u64, u64)> {
    parse_version(v.split(['-', '+']).next().unwrap_or(v))
}

/// An ISO date ("2026-10-12") or date-time ("2026-10-12T09:00:00Z").
fn parse_when(s: &str, end_of_day: bool) -> Option<DateTime<Utc>> {
    if s.len() == 10 {
        let d = NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()?;
        let t = if end_of_day {
            d.and_hms_milli_opt(23, 59, 59, 999)?
        } else {
            d.and_hms_opt(0, 0, 0)?
        };
        return Some(t.and_utc());
    }
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

fn text(v: &Value, key: &str, max: usize) -> Option<String> {
    let s = v.get(key)?.as_str()?.trim();
    (!s.is_empty() && s.chars().count() <= max).then(|| s.to_string())
}

/// An optional string field: `Ok(None)` when absent or null, `Err` when it
/// is there but not a string.
fn optional<'a>(v: &'a Value, key: &str) -> Result<Option<&'a str>, ()> {
    match v.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.trim())),
        Some(_) => Err(()),
    }
}

fn valid_id(id: &str) -> bool {
    id.len() <= MAX_ID
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// One notice (without its image yet) and the image it names, or None when
/// anything about the notice is off. A bad image only loses the image.
fn notice(
    v: &Value,
    app: (u64, u64, u64),
    now: DateTime<Utc>,
) -> Option<(Notice, Option<ImageSpec>)> {
    let id = text(v, "id", MAX_ID).filter(|id| valid_id(id))?;
    let title = text(v, "title", MAX_TITLE)?;
    let body = text(v, "body", MAX_BODY)?;
    let link = match v.get("link") {
        None | Some(Value::Null) => None,
        Some(l @ Value::Object(_)) => {
            let label = text(l, "label", MAX_LABEL)?;
            let url = l.get("url")?.as_str()?.trim().to_string();
            if !allowed_link(&url) {
                return None;
            }
            Some(NoticeLink { label, url })
        }
        Some(_) => return None,
    };
    if let Some(min) = optional(v, "minVersion").ok()? {
        if app < parse_version(min)? {
            return None;
        }
    }
    if let Some(max) = optional(v, "maxVersion").ok()? {
        if app > parse_version(max)? {
            return None;
        }
    }
    if let Some(from) = optional(v, "from").ok()? {
        if now < parse_when(from, false)? {
            return None;
        }
    }
    if let Some(until) = optional(v, "until").ok()? {
        if now > parse_when(until, true)? {
            return None;
        }
    }
    Some((
        Notice {
            id,
            title,
            body,
            link,
            image: None,
        },
        image_spec(v),
    ))
}

/// The notices of a version-1 file (each still a JSON value), or nothing.
fn notice_values(text: &str) -> Vec<Value> {
    let Ok(file) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    if file.get("version").and_then(Value::as_u64) != Some(1) {
        return Vec::new();
    }
    match file.get("notices") {
        Some(Value::Array(list)) => list.iter().take(MAX_NOTICES).cloned().collect(),
        _ => Vec::new(),
    }
}

/// The allowed images the notices in `text` name (fetched with the file).
pub fn image_specs(text: &str) -> Vec<ImageSpec> {
    let mut out: Vec<ImageSpec> = Vec::new();
    for spec in notice_values(text).iter().filter_map(image_spec) {
        if !out.iter().any(|o| o.url == spec.url) {
            out.push(spec);
        }
    }
    out
}

#[cfg(test)]
pub fn validate(text: &str, version: &str, now: DateTime<Utc>) -> Vec<Notice> {
    validate_with(text, version, now, &|_| None)
}

/// The notices in `text` that this app version should show at `now`, in the
/// file's order, each with its image when `image` has it (a `data:` URL).
/// Anything malformed is left out; an unknown file version or a file that is
/// not JSON gives an empty list.
pub fn validate_with(
    text: &str,
    version: &str,
    now: DateTime<Utc>,
    image: &dyn Fn(&ImageSpec) -> Option<String>,
) -> Vec<Notice> {
    let Some(app) = app_version(version) else {
        return Vec::new();
    };
    let mut out: Vec<Notice> = Vec::new();
    for v in notice_values(text) {
        if let Some((mut n, spec)) = notice(&v, app, now) {
            if out.iter().any(|o| o.id == n.id) {
                continue;
            }
            n.image = spec.and_then(|s| {
                image(&s).map(|src| NoticeImage {
                    src,
                    alt: s.alt.clone(),
                })
            });
            out.push(n);
        }
    }
    out
}

/// Whether to fetch now, `interval` seconds after the last try. A stamp in
/// the future (written while the clock was ahead) counts as no stamp, so
/// fetching never stops until the clock catches up.
fn due_every(now: i64, last_fetch: Option<i64>, interval: i64) -> bool {
    last_fetch
        .filter(|&t| t <= now)
        .is_none_or(|t| now - t >= interval)
}

fn interval() -> i64 {
    // e2e builds only: the real-app scenario shortens the day.
    #[cfg(feature = "e2e")]
    if let Some(secs) = std::env::var("HERMES_E2E_NOTICES_INTERVAL_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
    {
        return secs;
    }
    FETCH_INTERVAL_SECS
}

pub fn enabled(value: Option<&str>) -> bool {
    value.map(|v| v.trim().to_ascii_lowercase()) != Some("off".to_string())
}

/// Where the notices file is fetched from. e2e builds fetch only from the
/// address a scenario gives (a local server) and never from the real site,
/// so no test run reaches the network.
fn url() -> Option<String> {
    #[cfg(feature = "e2e")]
    {
        std::env::var("HERMES_E2E_NOTICES_URL")
            .ok()
            .map(|u| u.trim().to_string())
            .filter(|u| !u.is_empty())
    }
    #[cfg(not(feature = "e2e"))]
    {
        Some(NOTICES_URL.to_string())
    }
}

/// Where an allowed image is fetched from. e2e builds: from the origin of
/// the overridden notices address (a local server), same path.
fn image_fetch_url(url: &str) -> String {
    #[cfg(feature = "e2e")]
    if let Ok(over) = std::env::var("HERMES_E2E_NOTICES_URL") {
        if let Ok(o) = reqwest::Url::parse(over.trim()) {
            let origin = o.origin().ascii_serialization();
            return url.replacen("https://hermes-ide.com", &origin, 1);
        }
    }
    url.to_string()
}

fn client() -> Result<reqwest::Client, String> {
    // reqwest is built without a cookie store; the default user agent and
    // no query string: nothing that tells one person from another.
    reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        // No redirects: an answer from hermes-ide.com must not send us elsewhere.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}

/// Fetch one image and check it (size, content type, still image).
async fn fetch_image(client: &reqwest::Client, spec: &ImageSpec) -> Result<Vec<u8>, String> {
    let response = client
        .get(image_fetch_url(&spec.url))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|n| n as usize > MAX_IMAGE_BYTES)
    {
        return Err("too big".into());
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    check_image(spec.kind, content_type.as_deref(), &bytes)?;
    Ok(bytes.to_vec())
}

fn image_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    crate::instance::app_data_dir(app)
        .ok()
        .map(|d| d.join("notices"))
}

/// The file an image is kept in: a hash of its address, so the address never
/// becomes a path.
fn image_file(dir: &std::path::Path, spec: &ImageSpec) -> std::path::PathBuf {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(spec.url.as_bytes());
    let name: String = hash.iter().map(|b| format!("{b:02x}")).collect();
    dir.join(format!("{name}.{}", spec.kind.ext()))
}

/// Fetch the images `text` names into `dir` and forget the ones it no
/// longer names. A failed image is skipped (its notice shows without it).
async fn refresh_images(dir: &std::path::Path, text: &str) {
    let specs = image_specs(text);
    let keep: Vec<std::path::PathBuf> = specs.iter().map(|s| image_file(dir, s)).collect();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            if !keep.contains(&e.path()) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    if specs.is_empty() {
        return;
    }
    let Ok(client) = client() else {
        return;
    };
    let _ = std::fs::create_dir_all(dir);
    for spec in &specs {
        match fetch_image(&client, spec).await {
            Ok(bytes) => {
                let _ = std::fs::write(image_file(dir, spec), bytes);
            }
            Err(e) => {
                log::info!("[notices] image skipped: {e}");
                let _ = std::fs::remove_file(image_file(dir, spec));
            }
        }
    }
}

/// A kept image as a `data:` URL, checked again before it is handed out.
fn kept_image(dir: &std::path::Path, spec: &ImageSpec) -> Option<String> {
    let bytes = std::fs::read(image_file(dir, spec)).ok()?;
    check_image(spec.kind, Some(spec.kind.mime()), &bytes).ok()?;
    Some(data_url(spec.kind, &bytes))
}

enum Fetched {
    /// The site served a file (valid or not: validate decides).
    Body(String),
    /// The site has no notices file.
    Missing,
}

async fn fetch() -> Result<Fetched, String> {
    let response = client()?
        .get(url().ok_or("no notices address in this test run")?)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(Fetched::Missing);
    }
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err(format!(
            "{} bytes is too big for a notices file",
            bytes.len()
        ));
    }
    Ok(Fetched::Body(String::from_utf8_lossy(&bytes).into_owned()))
}

fn with_db<T>(app: &AppHandle, f: impl FnOnce(&crate::db::Database) -> T) -> Option<T> {
    let state = app.state::<AppState>();
    let db = state.db.lock().ok()?;
    Some(f(&db))
}

/// The validated notices to show. Fetches first when a day has passed since
/// the last try and notices are on. Never fails: any problem is an empty list.
#[tauri::command]
pub async fn notices_list(app: AppHandle) -> Result<Vec<Notice>, String> {
    let now = Utc::now();
    // Read the switch and the stamp, and claim this fetch, under one lock.
    let should_fetch = with_db(&app, |db| {
        let get = |k: &str| db.get_setting(k).ok().flatten();
        if !enabled(get(ENABLED_KEY).as_deref()) {
            return None;
        }
        let last = get(LAST_FETCH_KEY).and_then(|v| v.trim().parse::<i64>().ok());
        let go = due_every(now.timestamp(), last, interval());
        if go {
            let _ = db.set_setting(LAST_FETCH_KEY, &now.timestamp().to_string());
        }
        Some(go)
    })
    .flatten();
    let Some(should_fetch) = should_fetch else {
        return Ok(Vec::new());
    };
    if should_fetch {
        match fetch().await {
            Ok(Fetched::Body(text)) => {
                with_db(&app, |db| db.set_setting(CACHE_KEY, &text));
                if let Some(dir) = image_dir(&app) {
                    refresh_images(&dir, &text).await;
                }
            }
            Ok(Fetched::Missing) => {
                with_db(&app, |db| db.set_setting(CACHE_KEY, ""));
                if let Some(dir) = image_dir(&app) {
                    refresh_images(&dir, "").await;
                }
            }
            Err(e) => log::info!("[notices] fetch failed: {e}"),
        }
    }
    let cache = with_db(&app, |db| db.get_setting(CACHE_KEY).ok().flatten())
        .flatten()
        .unwrap_or_default();
    let version = app.package_info().version.to_string();
    let dir = image_dir(&app);
    Ok(validate_with(&cache, &version, now, &|spec| {
        dir.as_deref().and_then(|d| kept_image(d, spec))
    }))
}

/// `prev` (the stored `notices_landed`) with one more task landed on `day`.
pub fn bump_landed(prev: Option<&str>, day: &str) -> String {
    let prev: Value = prev
        .and_then(|p| serde_json::from_str(p).ok())
        .unwrap_or(Value::Null);
    let count = prev.get("count").and_then(Value::as_u64).unwrap_or(0) + 1;
    let mut days: Vec<String> = prev
        .get("days")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|d| d.as_str())
                .filter(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").is_ok())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if !days.iter().any(|d| d == day) {
        days.push(day.to_string());
    }
    days.sort();
    days.dedup();
    if days.len() > MAX_DAYS {
        days.drain(..days.len() - MAX_DAYS);
    }
    serde_json::json!({ "count": count, "days": days }).to_string()
}

/// A task was landed: count it, and the local day it was landed on.
pub fn record_landing(app: &AppHandle) {
    let day = chrono::Local::now().format("%Y-%m-%d").to_string();
    with_db(app, |db| {
        let prev = db.get_setting(LANDED_KEY).ok().flatten();
        if let Err(e) = db.set_setting(LANDED_KEY, &bump_landed(prev.as_deref(), &day)) {
            log::warn!("[notices] could not count the landing: {e}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn file(notices: Value) -> String {
        serde_json::json!({ "version": 1, "notices": notices }).to_string()
    }

    fn ids(text: &str, version: &str, now: &str) -> Vec<String> {
        validate(text, version, at(now))
            .into_iter()
            .map(|n| n.id)
            .collect()
    }

    const NOW: &str = "2026-10-12T12:00:00Z";

    #[test]
    fn a_plain_notice_passes_with_its_text() {
        let text = file(serde_json::json!([{
            "id": "whats-new-2.2.10", "title": "  Start a project  ", "body": "New folder in one step.",
            "link": { "label": "Read the release notes", "url": "https://hermes-ide.com/changelog" }
        }]));
        let got = validate(&text, "2.2.10", at(NOW));
        assert_eq!(
            got,
            vec![Notice {
                id: "whats-new-2.2.10".into(),
                title: "Start a project".into(),
                body: "New folder in one step.".into(),
                link: Some(NoticeLink {
                    label: "Read the release notes".into(),
                    url: "https://hermes-ide.com/changelog".into()
                }),
                image: None,
            }]
        );
    }

    #[test]
    fn links_are_allowed_only_to_the_site_and_the_github_org() {
        for ok in [
            "https://hermes-ide.com/",
            "https://hermes-ide.com/changelog#2.2.10",
            "https://github.com/hermes-hq/hermes-ide",
            "https://github.com/hermes-hq/hermes-ide/releases/tag/v2.2.10",
        ] {
            assert!(allowed_link(ok), "{ok} should be allowed");
        }
        for bad in [
            "http://hermes-ide.com/",
            "https://hermes-ide.com",
            "https://evil.example/",
            "https://hermes-ide.com.evil.example/",
            "https://www.hermes-ide.com/",
            "https://hermes-ide.com:8443/",
            "https://hermes-ide.com@example.com/",
            "https://github.com/hermes-hq-evil/x",
            "https://github.com/someone/hermes-ide",
            "https://github.com/hermes-hq/../evil/x",
            "https://gist.github.com/hermes-hq/x",
            "javascript:alert(1)",
            "HTTPS://hermes-ide.com/",
            "",
        ] {
            assert!(!allowed_link(bad), "{bad} should be refused");
        }
    }

    #[test]
    fn a_notice_with_a_foreign_link_is_dropped_entirely() {
        let text = file(serde_json::json!([
            { "id": "a", "title": "T", "body": "B", "link": { "label": "Go", "url": "https://evil.example/x" } },
            { "id": "b", "title": "T", "body": "B", "link": { "label": "Go", "url": "https://github.com/hermes-hq/hermes-ide" } },
            { "id": "c", "title": "T", "body": "B", "link": "https://hermes-ide.com/" },
            { "id": "d", "title": "T", "body": "B", "link": { "url": "https://hermes-ide.com/" } },
            { "id": "e", "title": "T", "body": "B", "link": null }
        ]));
        assert_eq!(ids(&text, "2.2.10", NOW), vec!["b", "e"]);
    }

    #[test]
    fn version_bounds_are_inclusive_and_malformed_bounds_drop_the_notice() {
        let text = file(serde_json::json!([
            { "id": "min", "title": "T", "body": "B", "minVersion": "2.2.10" },
            { "id": "max", "title": "T", "body": "B", "maxVersion": "2.2.9" },
            { "id": "both", "title": "T", "body": "B", "minVersion": "2.2.0", "maxVersion": "2.3.0" },
            { "id": "bad", "title": "T", "body": "B", "minVersion": "2.2" },
            { "id": "num", "title": "T", "body": "B", "minVersion": 2 }
        ]));
        assert_eq!(ids(&text, "2.2.10", NOW), vec!["min", "both"]);
        assert_eq!(ids(&text, "2.2.9", NOW), vec!["max", "both"]);
        assert_eq!(ids(&text, "2.2.10-beta.1", NOW), vec!["min", "both"]);
        assert_eq!(ids(&text, "2.10.0", NOW), vec!["min"]);
        assert!(ids(&text, "not-a-version", NOW).is_empty());
    }

    #[test]
    fn date_windows_filter_and_a_bare_until_lasts_the_whole_day() {
        let text = file(serde_json::json!([
            { "id": "future", "title": "T", "body": "B", "from": "2026-10-13" },
            { "id": "started", "title": "T", "body": "B", "from": "2026-10-12" },
            { "id": "ended", "title": "T", "body": "B", "until": "2026-10-11" },
            { "id": "today", "title": "T", "body": "B", "until": "2026-10-12" },
            { "id": "exact", "title": "T", "body": "B", "from": "2026-10-12T11:59:00Z", "until": "2026-10-12T12:01:00+00:00" },
            { "id": "bad-date", "title": "T", "body": "B", "from": "12/10/2026" }
        ]));
        assert_eq!(ids(&text, "2.2.10", NOW), vec!["started", "today", "exact"]);
        assert_eq!(
            ids(&text, "2.2.10", "2026-10-12T23:59:59Z"),
            vec!["started", "today"]
        );
    }

    #[test]
    fn malformed_input_gives_nothing_and_never_panics() {
        for text in [
            "",
            "not json",
            "[]",
            "null",
            r#"{"version":2,"notices":[{"id":"a","title":"T","body":"B"}]}"#,
            r#"{"version":"1","notices":[{"id":"a","title":"T","body":"B"}]}"#,
            r#"{"version":1}"#,
            r#"{"version":1,"notices":{}}"#,
            r#"{"version":1,"notices":"x"}"#,
        ] {
            assert!(validate(text, "2.2.10", at(NOW)).is_empty(), "{text}");
        }
        let text = file(serde_json::json!([
            1, "x", null, [],
            { "title": "no id", "body": "B" },
            { "id": "", "title": "T", "body": "B" },
            { "id": "has space", "title": "T", "body": "B" },
            { "id": "no-title", "body": "B" },
            { "id": "blank", "title": "   ", "body": "B" },
            { "id": "long", "title": "x".repeat(121), "body": "B" },
            { "id": "num-body", "title": "T", "body": 5 },
            { "id": "ok", "title": "T", "body": "B", "extra": { "ignored": true } },
            { "id": "ok", "title": "duplicate", "body": "B" }
        ]));
        let got = validate(&text, "2.2.10", at(NOW));
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].title, "T");
    }

    #[test]
    fn at_most_twenty_notices_are_read() {
        let many: Vec<Value> = (0..50)
            .map(|i| serde_json::json!({ "id": format!("n{i}"), "title": "T", "body": "B" }))
            .collect();
        assert_eq!(
            validate(&file(Value::Array(many)), "2.2.10", at(NOW)).len(),
            MAX_NOTICES
        );
    }

    #[test]
    fn fetches_at_most_once_a_day() {
        let now = 1_000_000_000;
        let due = |last| due_every(now, last, FETCH_INTERVAL_SECS);
        assert!(due(None));
        assert!(!due(Some(now - 3600)));
        assert!(!due(Some(now - FETCH_INTERVAL_SECS + 1)));
        assert!(due(Some(now - FETCH_INTERVAL_SECS)));
        // A stamp from a clock that ran ahead does not stop fetching.
        assert!(due(Some(now + 3600)));
    }

    #[test]
    fn the_switch_is_on_unless_off() {
        assert!(enabled(None));
        assert!(enabled(Some("on")));
        assert!(enabled(Some("")));
        assert!(!enabled(Some("off")));
        assert!(!enabled(Some(" OFF ")));
    }

    #[test]
    fn landings_count_every_task_and_each_day_once() {
        let a = bump_landed(None, "2026-10-01");
        let b = bump_landed(Some(&a), "2026-10-01");
        let c = bump_landed(Some(&b), "2026-10-03");
        let v: Value = serde_json::from_str(&c).unwrap();
        assert_eq!(v["count"], 3);
        assert_eq!(v["days"], serde_json::json!(["2026-10-01", "2026-10-03"]));
        // A damaged value starts again instead of failing.
        let d: Value = serde_json::from_str(&bump_landed(Some("{oops"), "2026-10-04")).unwrap();
        assert_eq!(d["count"], 1);
        // Only the newest days are kept.
        let mut s = None;
        for i in 1..=40 {
            s = Some(bump_landed(
                s.as_deref(),
                &format!("2026-08-{:02}", i.min(31)),
            ));
        }
        let v: Value = serde_json::from_str(s.as_deref().unwrap()).unwrap();
        assert_eq!(v["count"], 40);
        assert!(v["days"].as_array().unwrap().len() <= MAX_DAYS);
    }

    // ── Images ──────────────────────────────────────────────────────────

    fn png(chunks: &[&[u8; 4]]) -> Vec<u8> {
        let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
        for kind in chunks {
            out.extend_from_slice(&0u32.to_be_bytes());
            out.extend_from_slice(*kind);
            out.extend_from_slice(&[0, 0, 0, 0]);
        }
        out
    }

    fn webp(vp8x_flags: Option<u8>) -> Vec<u8> {
        let mut out = b"RIFF\0\0\0\0WEBP".to_vec();
        match vp8x_flags {
            Some(f) => {
                out.extend_from_slice(b"VP8X");
                out.extend_from_slice(&10u32.to_le_bytes());
                out.extend_from_slice(&[f, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            }
            None => out.extend_from_slice(b"VP8 \0\0\0\0"),
        }
        out
    }

    #[test]
    fn images_are_allowed_only_under_the_site_notices_folder_as_png_webp_or_jpg() {
        for (url, kind) in [
            ("https://hermes-ide.com/notices/a.png", ImageKind::Png),
            (
                "https://hermes-ide.com/notices/2.2.10/hero.webp",
                ImageKind::Webp,
            ),
            ("https://hermes-ide.com/notices/a.JPG", ImageKind::Jpeg),
        ] {
            assert_eq!(allowed_image_url(url), Some(kind), "{url}");
        }
        for bad in [
            "https://hermes-ide.com/notices/a.svg",
            "https://hermes-ide.com/notices/a.gif",
            "https://hermes-ide.com/notices/a.jpeg",
            "https://hermes-ide.com/a.png",
            "https://hermes-ide.com/noticesx/a.png",
            "https://hermes-ide.com/notices/../a.png",
            "http://hermes-ide.com/notices/a.png",
            "https://hermes-ide.com/notices/a.png?x=1",
            "https://hermes-ide.com/notices/a.png#f",
            "https://hermes-ide.com:444/notices/a.png",
            "https://hermes-ide.com@example.com/notices/a.png",
            "https://evil.example/notices/a.png",
            "https://github.com/hermes-hq/notices/a.png",
            "data:image/png;base64,AAAA",
        ] {
            assert_eq!(allowed_image_url(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_bad_or_unfetched_image_drops_the_image_not_the_notice() {
        let text = file(serde_json::json!([
            { "id": "ok", "title": "T", "body": "B", "image": { "url": "https://hermes-ide.com/notices/a.png", "alt": "A star" } },
            { "id": "foreign", "title": "T", "body": "B", "image": { "url": "https://evil.example/a.png", "alt": "x" } },
            { "id": "no-alt", "title": "T", "body": "B", "image": { "url": "https://hermes-ide.com/notices/a.png" } },
            { "id": "svg", "title": "T", "body": "B", "image": { "url": "https://hermes-ide.com/notices/a.svg", "alt": "x" } },
            { "id": "missing", "title": "T", "body": "B", "image": { "url": "https://hermes-ide.com/notices/gone.webp", "alt": "x" } },
            { "id": "junk", "title": "T", "body": "B", "image": "https://hermes-ide.com/notices/a.png" }
        ]));
        let got = validate_with(&text, "2.2.10", at(NOW), &|s| {
            (s.url.ends_with("a.png")).then(|| "data:image/png;base64,AA==".to_string())
        });
        let ids: Vec<&str> = got.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["ok", "foreign", "no-alt", "svg", "missing", "junk"]
        );
        assert_eq!(
            got[0].image,
            Some(NoticeImage {
                src: "data:image/png;base64,AA==".into(),
                alt: "A star".into()
            })
        );
        assert!(got[1..].iter().all(|n| n.image.is_none()));
        // Only the allowed image is fetched.
        let specs = image_specs(&text);
        assert_eq!(
            specs.iter().map(|s| s.url.as_str()).collect::<Vec<_>>(),
            vec![
                "https://hermes-ide.com/notices/a.png",
                "https://hermes-ide.com/notices/gone.webp"
            ]
        );
    }

    #[test]
    fn images_must_be_small_still_and_served_as_their_type() {
        let still = png(&[b"IHDR", b"IDAT", b"IEND"]);
        assert!(check_image(ImageKind::Png, Some("image/png"), &still).is_ok());
        assert!(check_image(ImageKind::Png, Some("image/png; charset=binary"), &still).is_ok());
        // The content type must match the file type.
        assert!(check_image(ImageKind::Png, Some("image/webp"), &still).is_err());
        assert!(check_image(ImageKind::Png, Some("text/html"), &still).is_err());
        assert!(check_image(ImageKind::Png, None, &still).is_err());
        // The bytes must be that type too.
        assert!(check_image(ImageKind::Png, Some("image/png"), b"<svg></svg>").is_err());
        assert!(check_image(
            ImageKind::Jpeg,
            Some("image/jpeg"),
            &[0xFF, 0xD8, 0xFF, 0xE0]
        )
        .is_ok());
        assert!(check_image(ImageKind::Jpeg, Some("image/jpeg"), &still).is_err());
        // At most 300 KB, and not empty.
        let mut big = still.clone();
        big.resize(MAX_IMAGE_BYTES + 1, 0);
        assert!(check_image(ImageKind::Png, Some("image/png"), &big).is_err());
        let mut edge = still.clone();
        edge.resize(MAX_IMAGE_BYTES, 0);
        assert!(check_image(ImageKind::Png, Some("image/png"), &edge).is_ok());
        assert!(check_image(ImageKind::Png, Some("image/png"), &[]).is_err());
        // Animated images are refused.
        let apng = png(&[b"IHDR", b"acTL", b"IDAT", b"IEND"]);
        assert!(check_image(ImageKind::Png, Some("image/png"), &apng).is_err());
        assert!(check_image(ImageKind::Webp, Some("image/webp"), &webp(None)).is_ok());
        assert!(check_image(ImageKind::Webp, Some("image/webp"), &webp(Some(0x10))).is_ok());
        assert!(check_image(ImageKind::Webp, Some("image/webp"), &webp(Some(0x02))).is_err());
    }

    #[test]
    fn a_kept_image_is_handed_out_as_a_data_url() {
        let bytes = png(&[b"IHDR", b"IDAT", b"IEND"]);
        let url = data_url(ImageKind::Png, &bytes);
        assert!(url.starts_with("data:image/png;base64,iVBORw0KGgo"));
        let dir = std::env::temp_dir().join(format!("hermes-notices-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let spec = ImageSpec {
            url: "https://hermes-ide.com/notices/a.png".into(),
            alt: "A".into(),
            kind: ImageKind::Png,
        };
        assert_eq!(kept_image(&dir, &spec), None);
        let path = image_file(&dir, &spec);
        assert!(path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .ends_with(".png"));
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(kept_image(&dir, &spec), Some(url));
        // A damaged file is not handed out.
        std::fs::write(&path, b"oops").unwrap();
        assert_eq!(kept_image(&dir, &spec), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
