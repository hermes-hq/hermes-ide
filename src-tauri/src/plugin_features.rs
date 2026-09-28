//! Read-only access to a repository's feature tracks for plugins (F36,
//! plugin API v2).
//!
//! A feature track lives in `.hermes/features/<slug>/feature.md` at the root
//! of the repository (docs/adr/004-2.0-contracts.md, section 6). F28 owns the
//! folder, the watcher and the gates; this module only reads the files so a
//! plugin with the `features.read` permission can see which tracks exist and
//! where they stand. The frontend parses the front matter with the contract's
//! own reader (`src/agent/contract/featureFrontMatter.ts`), so there is one
//! parser for everyone.
//!
//! Only `feature.md` files directly under `.hermes/features/<slug>/` are ever
//! read. Symbolic links are not followed, folder names must be valid slugs,
//! a file is capped at 64 KB and a repository at 100 tracks.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

use crate::db::Database;
use crate::plugin_identity::PluginIdentityState;
use crate::AppState;

/// The permission a plugin needs to read feature tracks.
pub const FEATURES_READ_PERMISSION: &str = "features.read";
/// At most this many tracks are returned (sorted by slug).
pub const MAX_FEATURE_TRACKS: usize = 100;
/// A feature.md larger than this is reported, not read.
pub const MAX_FEATURE_FILE_BYTES: u64 = 64 * 1024;

/// One track as read from disk: its folder name and either the text of its
/// feature.md or why it could not be read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureTrackFile {
    pub slug: String,
    pub text: Option<String>,
    pub error: Option<String>,
}

/// A slug is a branch component (`hermes/<slug>`), same rule as the
/// frontend's `isFeatureSlug`.
pub fn is_feature_slug(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    let first_ok = bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit();
    first_ok
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// The repository a folder belongs to: the nearest ancestor (or the folder
/// itself) holding a `.git` entry. A folder outside any repository is its
/// own root.
pub fn repository_root(start: &Path) -> PathBuf {
    let mut dir = Some(start);
    while let Some(d) = dir {
        if fs::symlink_metadata(d.join(".git")).is_ok() {
            return d.to_path_buf();
        }
        dir = d.parent();
    }
    start.to_path_buf()
}

/// A real directory, never a symbolic link to one.
fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.file_type().is_dir())
        .unwrap_or(false)
}

fn read_one(file: &Path) -> Option<Result<String, String>> {
    let meta = fs::symlink_metadata(file).ok()?;
    if !meta.file_type().is_file() {
        return Some(Err("feature.md is not a regular file".to_string()));
    }
    if meta.len() > MAX_FEATURE_FILE_BYTES {
        return Some(Err("feature.md is larger than 64 KB".to_string()));
    }
    Some(match fs::read(file) {
        Ok(bytes) => {
            String::from_utf8(bytes).map_err(|_| "feature.md is not UTF-8 text".to_string())
        }
        Err(e) => Err(format!("feature.md can't be read: {e}")),
    })
}

/// The feature tracks of the repository `dir` is in, sorted by slug.
/// A repository without `.hermes/features` has none.
pub fn read_feature_tracks(dir: &Path) -> Vec<FeatureTrackFile> {
    let root = repository_root(dir);
    let hermes = root.join(".hermes");
    let features = hermes.join("features");
    if !is_real_dir(&hermes) || !is_real_dir(&features) {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(&features) else {
        return Vec::new();
    };
    let mut slugs: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|name| is_feature_slug(name))
        .collect();
    slugs.sort();
    slugs.truncate(MAX_FEATURE_TRACKS);
    slugs
        .into_iter()
        .filter_map(|slug| {
            let read = read_one(&features.join(&slug).join("feature.md"))?;
            Some(match read {
                Ok(text) => FeatureTrackFile {
                    slug,
                    text: Some(text),
                    error: None,
                },
                Err(error) => FeatureTrackFile {
                    slug,
                    text: None,
                    error: Some(error),
                },
            })
        })
        .collect()
}

/// Refuses a plugin that was not granted `features.read`.
pub fn require_features_read(db: &Database, plugin_id: &str) -> Result<(), String> {
    if db.has_plugin_permission(plugin_id, FEATURES_READ_PERMISSION)? {
        Ok(())
    } else {
        Err(format!(
            "Plugin \"{plugin_id}\" does not have \"{FEATURES_READ_PERMISSION}\" permission"
        ))
    }
}

/// Feature tracks of the repository `directory` is in. Token-bound: the
/// caller is the plugin the token was issued to, and it must hold
/// `features.read`. The frontend passes the working directory of the session
/// the plugin asked about.
#[tauri::command]
pub async fn plugin_read_feature_tracks(
    directory: String,
    plugin_token: String,
    state: State<'_, AppState>,
    identity: State<'_, PluginIdentityState>,
) -> Result<Vec<FeatureTrackFile>, String> {
    let plugin_id = identity.plugin_for(&plugin_token)?;
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        require_features_read(&db, &plugin_id)?;
    }
    let dir = PathBuf::from(&directory);
    if directory.is_empty() || !dir.is_absolute() {
        return Err(format!("not an absolute folder: {directory:?}"));
    }
    tokio::task::spawn_blocking(move || read_feature_tracks(&dir))
        .await
        .map_err(|e| format!("reading feature tracks failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FEATURE: &str =
        "---\nslug: search-index\ntrack: Full\nphase: plan\ngate: waiting\n---\nBody\n";

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        dir
    }

    #[test]
    fn slugs_follow_the_branch_component_rule() {
        assert!(is_feature_slug("search-index"));
        assert!(is_feature_slug("a1"));
        assert!(!is_feature_slug(""));
        assert!(!is_feature_slug("-lead"));
        assert!(!is_feature_slug("Upper"));
        assert!(!is_feature_slug("dot.name"));
        assert!(!is_feature_slug(".."));
        assert!(!is_feature_slug(&"a".repeat(65)));
    }

    #[test]
    fn reads_every_track_of_the_repository_from_a_subfolder() {
        let r = repo();
        write(
            &r.path().join(".hermes/features/search-index/feature.md"),
            FEATURE,
        );
        write(
            &r.path().join(".hermes/features/auth/feature.md"),
            "---\nslug: auth\ntrack: Quick\n---\n",
        );
        fs::create_dir_all(r.path().join("src/deep")).unwrap();

        let tracks = read_feature_tracks(&r.path().join("src/deep"));
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].slug, "auth", "sorted by slug");
        assert_eq!(tracks[1].slug, "search-index");
        assert_eq!(tracks[1].text.as_deref(), Some(FEATURE));
        assert_eq!(tracks[1].error, None);
    }

    #[test]
    fn a_repository_without_tracks_has_none() {
        let r = repo();
        assert!(read_feature_tracks(r.path()).is_empty());
        write(&r.path().join(".hermes/worktree.toml"), "setup = []\n");
        assert!(read_feature_tracks(r.path()).is_empty());
    }

    #[test]
    fn skips_folders_that_are_not_slugs_or_have_no_feature_md() {
        let r = repo();
        write(
            &r.path().join(".hermes/features/Not A Slug/feature.md"),
            FEATURE,
        );
        write(&r.path().join(".hermes/features/empty/notes.md"), "x");
        write(&r.path().join(".hermes/features/stray.md"), "x");
        write(&r.path().join(".hermes/features/ok/feature.md"), FEATURE);
        let slugs: Vec<_> = read_feature_tracks(r.path())
            .into_iter()
            .map(|t| t.slug)
            .collect();
        assert_eq!(slugs, vec!["ok".to_string()]);
    }

    #[test]
    fn reports_files_it_will_not_read() {
        let r = repo();
        let big = "x".repeat(MAX_FEATURE_FILE_BYTES as usize + 1);
        write(&r.path().join(".hermes/features/big/feature.md"), &big);
        fs::create_dir_all(r.path().join(".hermes/features/binary")).unwrap();
        fs::write(
            r.path().join(".hermes/features/binary/feature.md"),
            [0xff, 0xfe, 0x00],
        )
        .unwrap();
        fs::create_dir_all(r.path().join(".hermes/features/folder/feature.md")).unwrap();

        let tracks = read_feature_tracks(r.path());
        let by = |slug: &str| tracks.iter().find(|t| t.slug == slug).unwrap().clone();
        assert_eq!(by("big").text, None);
        assert!(by("big").error.unwrap().contains("64 KB"));
        assert!(by("binary").error.unwrap().contains("UTF-8"));
        assert!(by("folder").error.unwrap().contains("regular file"));
    }

    #[test]
    fn caps_the_number_of_tracks() {
        let r = repo();
        for i in 0..(MAX_FEATURE_TRACKS + 5) {
            write(
                &r.path()
                    .join(format!(".hermes/features/f{i:03}/feature.md")),
                FEATURE,
            );
        }
        assert_eq!(read_feature_tracks(r.path()).len(), MAX_FEATURE_TRACKS);
    }

    #[cfg(unix)]
    #[test]
    fn never_follows_symbolic_links_out_of_the_repository() {
        let r = repo();
        let outside = tempfile::tempdir().unwrap();
        write(&outside.path().join("secret/feature.md"), "SECRET");
        write(&outside.path().join("secret.md"), "SECRET");
        fs::create_dir_all(r.path().join(".hermes/features/linked-file")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.md"),
            r.path().join(".hermes/features/linked-file/feature.md"),
        )
        .unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret"),
            r.path().join(".hermes/features/linked-dir"),
        )
        .unwrap();

        let tracks = read_feature_tracks(r.path());
        assert!(tracks.iter().all(|t| t.text.as_deref() != Some("SECRET")));
        assert!(
            !tracks.iter().any(|t| t.slug == "linked-dir"),
            "a linked folder is skipped"
        );
        let linked = tracks.iter().find(|t| t.slug == "linked-file").unwrap();
        assert!(linked.error.as_deref().unwrap().contains("regular file"));

        // A .hermes/features that is itself a link is ignored entirely.
        let r2 = repo();
        fs::create_dir_all(r2.path().join(".hermes")).unwrap();
        std::os::unix::fs::symlink(outside.path(), r2.path().join(".hermes/features")).unwrap();
        assert!(read_feature_tracks(r2.path()).is_empty());
    }

    #[test]
    fn only_a_plugin_granted_features_read_may_read() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Database::new(tmp.path()).unwrap();
        let grant = |id: &str, perms: &str| {
            db.conn
                .execute(
                    "INSERT INTO plugins (id, version, name, permissions_granted) VALUES (?1, '1', 'x', ?2)",
                    rusqlite::params![id, perms],
                )
                .unwrap();
        };
        grant("reader", r#"["sessions.read","features.read"]"#);
        grant("other", r#"["sessions.read","inbox.raise"]"#);
        assert!(require_features_read(&db, "reader").is_ok());
        let refused = require_features_read(&db, "other").unwrap_err();
        assert!(refused.contains("features.read"), "{refused}");
        assert!(require_features_read(&db, "unknown").is_err());
    }

    #[test]
    fn the_root_is_the_nearest_folder_with_git() {
        let r = repo();
        fs::create_dir_all(r.path().join("a/b")).unwrap();
        assert_eq!(repository_root(&r.path().join("a/b")), r.path());
        // A worktree has a .git FILE, which counts too.
        let wt = r.path().join("a/wt");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), "gitdir: elsewhere\n").unwrap();
        assert_eq!(repository_root(&wt.join("x")), wt);
    }
}
