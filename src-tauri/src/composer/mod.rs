use ignore::WalkBuilder;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

use crate::AppState;

const FILE_LIST_CAP: usize = 5000;
const FILE_LIST_MAX_DEPTH: usize = 8;
const PASTED_IMAGE_MAX_BYTES: usize = 20 * 1024 * 1024;

/// Look up a session's working directory from the in-memory PTY manager.
fn session_working_directory(state: &State<'_, AppState>, session_id: &str) -> Result<String, String> {
    let mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
    let pty = mgr
        .sessions
        .get(session_id)
        .ok_or_else(|| "Session not found".to_string())?;
    let session = pty.session.lock().map_err(|e| e.to_string())?;
    Ok(session.working_directory.clone())
}

#[tauri::command]
pub async fn list_session_files(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<String>, String> {
    let working_dir = session_working_directory(&state, &session_id)?;

    tokio::task::spawn_blocking(move || -> Result<Vec<String>, String> {
        let root = PathBuf::from(&working_dir);
        if !root.is_dir() {
            return Err(format!(
                "Working directory does not exist: {}",
                root.display()
            ));
        }

        let walker = WalkBuilder::new(&root)
            .git_ignore(true)
            .hidden(true)
            .max_depth(Some(FILE_LIST_MAX_DEPTH))
            .build();

        let mut paths = Vec::with_capacity(256);
        for result in walker {
            // Per-entry walk errors are skipped (ripgrep convention).
            let entry = match result {
                Ok(e) => e,
                Err(_) => continue,
            };

            // Skip directories — only collect files.
            let is_dir = entry
                .file_type()
                .map(|ft| ft.is_dir())
                .unwrap_or(false);
            if is_dir {
                continue;
            }

            let abs = entry.path();
            let rel = abs.strip_prefix(&root).unwrap_or(abs);
            paths.push(rel.to_string_lossy().into_owned());

            if paths.len() >= FILE_LIST_CAP {
                break;
            }
        }

        Ok(paths)
    })
    .await
    .map_err(|e| format!("list_session_files task panicked: {}", e))?
}

#[tauri::command]
pub async fn save_pasted_image(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    bytes: Vec<u8>,
    ext: String,
) -> Result<String, String> {
    let ext_lower = ext.to_ascii_lowercase();
    let allowed = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
    if !allowed.contains(&ext_lower.as_str()) {
        return Err("Unsupported image extension".into());
    }

    if bytes.len() > PASTED_IMAGE_MAX_BYTES {
        return Err("Image too large".into());
    }

    // Validate the session exists before writing anything to disk.
    let _ = session_working_directory(&state, &session_id)?;

    let cache_root = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve cache dir: {}", e))?;

    let dir = cache_root.join("pasted-images").join(&session_id);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create pasted-image dir: {}", e))?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Clock error: {}", e))?;
    let ts_ms = now.as_millis();
    // Not security-sensitive: a short hex tag derived from sub-millisecond bits
    // is enough to avoid collisions when two pastes land in the same millisecond.
    let rand_hex = format!("{:06x}", (now.subsec_nanos() as u64) & 0xff_ffff);

    let filename = format!("{}-{}.{}", ts_ms, rand_hex, ext_lower);
    let target = dir.join(filename);

    std::fs::write(&target, &bytes)
        .map_err(|e| format!("Failed to write pasted image: {}", e))?;

    Ok(target.to_string_lossy().into_owned())
}

/// Read an image file from disk and return its raw bytes. Used by the
/// composer to build data-URL thumbnails for files that were drag-dropped
/// from outside the project. Capped at PASTED_IMAGE_MAX_BYTES, image
/// extensions only.
#[tauri::command]
pub async fn read_image_bytes(path: String) -> Result<Vec<u8>, String> {
    let lower = path.to_ascii_lowercase();
    let allowed = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
    let ext_ok = allowed.iter().any(|e| lower.ends_with(&format!(".{}", e)));
    if !ext_ok {
        return Err("Unsupported image extension".into());
    }

    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("stat {}: {}", path, e))?;
    if metadata.len() as usize > PASTED_IMAGE_MAX_BYTES {
        return Err("Image too large".into());
    }

    tokio::fs::read(&path)
        .await
        .map_err(|e| format!("read {}: {}", path, e))
}
