//! Files pasted into the ⌘N task launcher.
//!
//! A file dropped or picked in the launcher already has a path, and the
//! agent's first prompt names that path. Something pasted from the clipboard
//! (a screenshot, an image copied from a browser) has no file behind it, so
//! it is saved here first: `<app data>/attachments/<unique>/<name>`, one
//! folder per file so two pastes with the same name never collide. Folders
//! older than a week are removed at startup.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Larger than any screenshot; a bigger paste is refused.
pub const MAX_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;
/// How long a saved paste is kept.
const KEEP_FOR: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const NAME_CAP: usize = 120;

fn attachments_dir(app_dir: &Path) -> PathBuf {
    app_dir.join("attachments")
}

/// A file name that is safe on every platform: the last path component, with
/// separators, control characters and characters Windows refuses replaced,
/// no leading dots, at most `NAME_CAP` characters (the extension kept).
pub fn safe_file_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned
        .trim()
        .trim_start_matches('.')
        .trim_end_matches(['.', ' ']);
    if cleaned.is_empty() {
        return "attachment".to_string();
    }
    if cleaned.chars().count() <= NAME_CAP {
        return cleaned.to_string();
    }
    let (stem, ext) = match cleaned.rfind('.') {
        Some(i) if cleaned.len() - i <= 10 => (&cleaned[..i], &cleaned[i..]),
        _ => (cleaned, ""),
    };
    let keep = NAME_CAP.saturating_sub(ext.chars().count());
    let stem: String = stem.chars().take(keep).collect();
    format!("{}{}", stem, ext)
}

/// Save `bytes` as `name` in a new folder under `app_dir`; returns the path.
pub fn save_attachment(app_dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    if bytes.is_empty() {
        return Err("The pasted file is empty.".to_string());
    }
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "The pasted file is too large ({} MB; the limit is {} MB).",
            bytes.len().div_ceil(1024 * 1024),
            MAX_ATTACHMENT_BYTES / (1024 * 1024)
        ));
    }
    let stamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let folder = attachments_dir(app_dir).join(format!(
        "{}-{}",
        stamp,
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    ));
    std::fs::create_dir_all(&folder)
        .map_err(|e| format!("Could not create {}: {}", folder.display(), e))?;
    let path = folder.join(safe_file_name(name));
    std::fs::write(&path, bytes)
        .map_err(|e| format!("Could not save {}: {}", path.display(), e))?;
    Ok(path)
}

/// Remove saved pastes older than `keep_for` (by the folder's modified
/// time). Returns how many folders were removed.
pub fn prune_attachments(app_dir: &Path, keep_for: Duration, now: SystemTime) -> usize {
    let Ok(entries) = std::fs::read_dir(attachments_dir(app_dir)) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > keep_for);
        if old && std::fs::remove_dir_all(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Startup: drop pastes older than a week, off the main thread.
pub fn start_pruning<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Ok(dir) = crate::instance::app_data_dir(app) else {
        return;
    };
    std::thread::spawn(move || {
        let n = prune_attachments(&dir, KEEP_FOR, SystemTime::now());
        if n > 0 {
            log::info!(
                "[attachments] removed {} pasted file(s) older than a week",
                n
            );
        }
    });
}

/// Save something pasted into the task launcher (base64 over IPC); returns
/// the file's absolute path.
#[tauri::command]
pub async fn save_launch_attachment(
    app: tauri::AppHandle,
    name: String,
    data: String,
) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("The pasted data could not be read: {}", e))?;
    let dir = crate::instance::app_data_dir(&app)?;
    tokio::task::spawn_blocking(move || save_attachment(&dir, &name, &bytes))
        .await
        .map_err(|e| e.to_string())?
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_safe_name_keeps_only_the_last_component_and_legal_characters() {
        assert_eq!(safe_file_name("shot.png"), "shot.png");
        assert_eq!(safe_file_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_file_name("C:\\Users\\x\\a.txt"), "a.txt");
        assert_eq!(safe_file_name("a:b*c?.png"), "a_b_c_.png");
        assert_eq!(safe_file_name(".hidden"), "hidden");
        assert_eq!(safe_file_name("..."), "attachment");
        assert_eq!(safe_file_name(""), "attachment");
        assert_eq!(safe_file_name("line\nbreak.png"), "line_break.png");
        assert_eq!(safe_file_name("Screen Shot 1.png"), "Screen Shot 1.png");
    }

    #[test]
    fn a_long_name_is_cut_and_keeps_its_extension() {
        let long = format!("{}.png", "a".repeat(300));
        let safe = safe_file_name(&long);
        assert_eq!(safe.chars().count(), NAME_CAP);
        assert!(safe.ends_with(".png"));
    }

    #[test]
    fn a_paste_is_saved_in_its_own_folder_under_attachments() {
        let tmp = tempfile::tempdir().unwrap();
        let a = save_attachment(tmp.path(), "shot.png", b"one").unwrap();
        let b = save_attachment(tmp.path(), "shot.png", b"two").unwrap();
        assert_ne!(a, b, "two pastes with one name never collide");
        assert!(a.starts_with(tmp.path().join("attachments")));
        assert_eq!(a.file_name().unwrap(), "shot.png");
        assert_eq!(std::fs::read(&a).unwrap(), b"one");
        assert_eq!(std::fs::read(&b).unwrap(), b"two");
    }

    #[test]
    fn an_empty_or_too_large_paste_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(save_attachment(tmp.path(), "x.png", b"").is_err());
        let big = vec![0u8; MAX_ATTACHMENT_BYTES + 1];
        let err = save_attachment(tmp.path(), "x.png", &big).unwrap_err();
        assert!(err.contains("too large"), "{err}");
        assert!(
            !tmp.path().join("attachments").exists()
                || std::fs::read_dir(tmp.path().join("attachments"))
                    .unwrap()
                    .next()
                    .is_none()
        );
    }

    #[test]
    fn pruning_removes_only_folders_older_than_the_limit() {
        let tmp = tempfile::tempdir().unwrap();
        let old = save_attachment(tmp.path(), "old.png", b"x").unwrap();
        let fresh = save_attachment(tmp.path(), "new.png", b"y").unwrap();
        let week = Duration::from_secs(7 * 24 * 60 * 60);
        // Seen from eight days on, both are old; from now, neither is.
        assert_eq!(prune_attachments(tmp.path(), week, SystemTime::now()), 0);
        assert!(old.exists() && fresh.exists());
        let later = SystemTime::now() + Duration::from_secs(8 * 24 * 60 * 60);
        assert_eq!(prune_attachments(tmp.path(), week, later), 2);
        assert!(!old.exists() && !fresh.exists());
        assert_eq!(
            prune_attachments(tmp.path(), week, later),
            0,
            "nothing left"
        );
    }

    #[test]
    fn pruning_without_an_attachments_folder_does_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            prune_attachments(tmp.path(), KEEP_FOR, SystemTime::now()),
            0
        );
    }
}
