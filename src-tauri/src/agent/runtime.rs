//! The Claude bridge runtime, shipped as one archive and unpacked on first
//! use (ADR 002).
//!
//! The installer carries `bridge/runtime/bridge-runtime.tar.zst` (the bridge
//! `.mjs` files plus their `node_modules`, packed by
//! `scripts/pack-bridge-runtime.mjs`) and `bridge/runtime/manifest.json`.
//! The first time the bridge is needed, the archive is checked against the
//! manifest's SHA-256 and unpacked into `<data folder>/runtime/<id>/`; later
//! launches reuse that folder. The id changes with every change to the
//! runtime, so an update unpacks next to the old copy and then removes it.
//!
//! Unpacking goes to a temporary folder that is renamed into place only when
//! complete, so a crash or a full disk never leaves a half-unpacked runtime
//! that looks ready. A folder that lost files (a cleanup tool, a user) is
//! noticed by its marker or key files and unpacked again.

use std::fs;
use std::io::{BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Folder (inside the bundle's resources) holding the archive and manifest.
pub const RESOURCE_SUBDIR: &str = "bridge/runtime";
pub const MANIFEST_FILE: &str = "manifest.json";
/// Written last into an unpacked runtime; its presence means "complete".
pub const MARKER_FILE: &str = ".hermes-runtime.json";
/// The archive layout this build understands (`FORMAT` in the packer).
pub const SUPPORTED_FORMAT: u32 = 1;
/// Files that must exist in a usable runtime, besides the entry script.
const KEY_FILES: &[&str] = &[
    "package.json",
    "node_modules/@anthropic-ai/claude-agent-sdk/package.json",
];
/// Leftover temporary folders older than this are someone's crashed unpack.
const STALE_TMP: Duration = Duration::from_secs(60 * 60);
/// Largest zstd window the archive may ask for (the packer uses far less).
const MAX_WINDOW: u64 = 1 << 27;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeManifest {
    pub format: u32,
    pub id: String,
    #[serde(default)]
    pub sdk_version: String,
    pub archive: String,
    pub archive_sha256: String,
    pub archive_bytes: u64,
    pub file_count: u64,
    pub entry: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unpacked {
    /// `<runtimes root>/<id>`
    pub dir: PathBuf,
    /// The bridge script inside `dir`.
    pub bridge: PathBuf,
    pub id: String,
    pub sdk_version: String,
    /// True when this call unpacked the archive, false when it reused it.
    pub unpacked_now: bool,
    pub ms: u64,
}

/// One unpack at a time per process: the prewarm and a session spawn can ask
/// at the same moment.
static UNPACK_LOCK: Mutex<()> = Mutex::new(());

/// Read and check `<bundle_dir>/manifest.json`.
pub fn read_manifest(bundle_dir: &Path) -> Result<RuntimeManifest, String> {
    let path = bundle_dir.join(MANIFEST_FILE);
    let text = fs::read_to_string(&path)
        .map_err(|e| format!("cannot read the runtime manifest {}: {}", path.display(), e))?;
    let m: RuntimeManifest = serde_json::from_str(&text).map_err(|e| {
        format!(
            "the runtime manifest {} is not valid: {}",
            path.display(),
            e
        )
    })?;
    if m.format != SUPPORTED_FORMAT {
        return Err(format!(
            "the runtime archive has format {}, this build reads format {}",
            m.format, SUPPORTED_FORMAT
        ));
    }
    // Both become path components: keep them to plain names.
    let plain = |s: &str| {
        !s.is_empty()
            && s.len() <= 128
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
            && !s.starts_with('.')
    };
    if !plain(&m.id) || !plain(&m.archive) || !plain(&m.entry) {
        return Err("the runtime manifest names an unsafe id, archive or entry".into());
    }
    if m.archive_sha256.len() != 64 || !m.archive_sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("the runtime manifest has no valid archive checksum".into());
    }
    Ok(m)
}

/// Where the bundle's runtime archive is: `HERMES_BRIDGE_RUNTIME_DIR` in test
/// and debug builds, else `<resources>/bridge/runtime` when it holds a
/// manifest. `None` means "no packed runtime" (a dev checkout, where the
/// bridge runs straight from `src-tauri/bridge`).
pub fn bundle_dir(resource_dir: Option<&Path>, env_override: Option<&str>) -> Option<PathBuf> {
    if let Some(dir) = env_override.map(str::trim).filter(|s| !s.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    let dir = resource_dir?.join(RESOURCE_SUBDIR);
    dir.join(MANIFEST_FILE).is_file().then_some(dir)
}

/// Whether `dir` is a complete runtime for `m`.
fn is_complete(dir: &Path, m: &RuntimeManifest) -> bool {
    let marker = match fs::read_to_string(dir.join(MARKER_FILE)) {
        Ok(t) => t,
        Err(_) => return false,
    };
    let recorded: Option<RuntimeManifest> = serde_json::from_str(&marker).ok();
    if recorded.as_ref().map(|r| (&r.id, &r.archive_sha256)) != Some((&m.id, &m.archive_sha256)) {
        return false;
    }
    dir.join(&m.entry).is_file() && KEY_FILES.iter().all(|f| dir.join(f).is_file())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut f =
        fs::File::open(path).map_err(|e| format!("cannot open {}: {}", path.display(), e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f
            .read(&mut buf)
            .map_err(|e| format!("cannot read {}: {}", path.display(), e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect())
}

/// Unpack `archive` (tar + zstd) into `dest`, which must be empty. Every
/// entry must be a regular file or folder under `dest`. Returns the number
/// of files written.
fn unpack_archive(archive: &Path, dest: &Path) -> Result<u64, String> {
    let file =
        fs::File::open(archive).map_err(|e| format!("cannot open {}: {}", archive.display(), e))?;
    let decoder = ruzstd::decoding::StreamingDecoder::new_with_max_window_size(
        BufReader::with_capacity(1 << 20, file),
        MAX_WINDOW,
    )
    .map_err(|e| format!("the runtime archive is not a zstd stream: {}", e))?;
    let mut tar = tar::Archive::new(decoder);
    tar.set_preserve_permissions(true);
    tar.set_preserve_mtime(false);
    tar.set_overwrite(false);
    let mut files = 0u64;
    let entries = tar
        .entries()
        .map_err(|e| format!("the runtime archive cannot be read: {}", e))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("the runtime archive is damaged: {}", e))?;
        let kind = entry.header().entry_type();
        let path = entry
            .path()
            .map_err(|e| format!("the runtime archive has a bad name: {}", e))?
            .into_owned();
        if !path
            .components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
        {
            return Err(format!(
                "the runtime archive has an entry outside its folder: {}",
                path.display()
            ));
        }
        if !(kind.is_file() || kind.is_dir()) {
            return Err(format!(
                "the runtime archive has an entry that is not a file: {}",
                path.display()
            ));
        }
        let ok = entry
            .unpack_in(dest)
            .map_err(|e| format!("cannot unpack {}: {}", path.display(), e))?;
        if !ok {
            return Err(format!("refused to unpack {}", path.display()));
        }
        if kind.is_file() {
            files += 1;
        }
    }
    Ok(files)
}

fn tmp_name(id: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(".tmp-{}-{}-{}", id, std::process::id(), nanos)
}

/// Remove every other runtime and every stale temporary folder under `root`.
/// Best effort: a runtime still in use on Windows cannot be removed and is
/// left for the next time.
pub fn collect_garbage(root: &Path, keep_id: &str) -> Vec<String> {
    let mut removed = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return removed;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == keep_id {
            continue;
        }
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if name.starts_with(".tmp-") {
            let old = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > STALE_TMP);
            if !old {
                continue; // another process may be unpacking right now
            }
        } else if !path.join(MARKER_FILE).is_file() {
            continue; // not a folder we made
        }
        if fs::remove_dir_all(&path).is_ok() {
            removed.push(name);
        }
    }
    removed
}

/// Make sure the runtime in `bundle_dir` is unpacked under `runtimes_root`
/// and return where. Safe to call from several threads and processes.
pub fn ensure_unpacked(bundle_dir: &Path, runtimes_root: &Path) -> Result<Unpacked, String> {
    let started = Instant::now();
    let _guard = UNPACK_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let m = read_manifest(bundle_dir)?;
    let target = runtimes_root.join(&m.id);
    let done = |unpacked_now: bool| Unpacked {
        bridge: target.join(&m.entry),
        dir: target.clone(),
        id: m.id.clone(),
        sdk_version: m.sdk_version.clone(),
        unpacked_now,
        ms: started.elapsed().as_millis() as u64,
    };
    if is_complete(&target, &m) {
        return Ok(done(false));
    }

    let archive = bundle_dir.join(&m.archive);
    let size = fs::metadata(&archive)
        .map_err(|e| {
            format!(
                "the runtime archive {} is missing: {}",
                archive.display(),
                e
            )
        })?
        .len();
    if size != m.archive_bytes {
        return Err(format!(
            "the runtime archive is {} bytes, the manifest says {} — the install is damaged",
            size, m.archive_bytes
        ));
    }
    let sum = sha256_file(&archive)?;
    if !sum.eq_ignore_ascii_case(&m.archive_sha256) {
        return Err(format!(
            "the runtime archive checksum does not match the manifest (got {}, expected {}) — the install is damaged",
            sum, m.archive_sha256
        ));
    }

    fs::create_dir_all(runtimes_root)
        .map_err(|e| format!("cannot create {}: {}", runtimes_root.display(), e))?;
    let tmp = runtimes_root.join(tmp_name(&m.id));
    fs::create_dir(&tmp).map_err(|e| format!("cannot create {}: {}", tmp.display(), e))?;
    let result = (|| {
        let files = unpack_archive(&archive, &tmp)?;
        if files != m.file_count {
            return Err(format!(
                "the runtime archive holds {} files, the manifest says {}",
                files, m.file_count
            ));
        }
        let marker = serde_json::to_string_pretty(&m).map_err(|e| e.to_string())?;
        fs::write(tmp.join(MARKER_FILE), marker)
            .map_err(|e| format!("cannot finish the runtime: {}", e))?;
        if !is_complete(&tmp, &m) {
            return Err(
                "the unpacked runtime is missing the bridge or the Claude Agent SDK".into(),
            );
        }
        // A folder under the target name that is not complete (a damaged
        // earlier copy) makes way; a complete one another process just
        // finished is kept and ours is dropped.
        if target.exists() && !is_complete(&target, &m) {
            fs::remove_dir_all(&target).map_err(|e| {
                format!(
                    "cannot replace the damaged runtime {}: {}",
                    target.display(),
                    e
                )
            })?;
        }
        if !target.exists() {
            if let Err(e) = fs::rename(&tmp, &target) {
                if !is_complete(&target, &m) {
                    return Err(format!(
                        "cannot move the runtime into {}: {}",
                        target.display(),
                        e
                    ));
                }
            }
        }
        Ok(())
    })();
    if tmp.exists() {
        let _ = fs::remove_dir_all(&tmp);
    }
    result?;
    let removed = collect_garbage(runtimes_root, &m.id);
    if !removed.is_empty() {
        log::info!("[bridge runtime] removed older runtimes: {:?}", removed);
    }
    let out = done(true);
    log::info!(
        "[bridge runtime] unpacked {} ({} files, SDK {}) into {} in {} ms",
        m.id,
        m.file_count,
        m.sdk_version,
        out.dir.display(),
        out.ms
    );
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A packed runtime built in the test: `files` as (path, contents, mode).
    struct Packed {
        _tmp: tempfile::TempDir,
        bundle: PathBuf,
        root: PathBuf,
        manifest: RuntimeManifest,
    }

    fn tar_bytes(files: &[(&str, &[u8], u32)]) -> Vec<u8> {
        let mut b = tar::Builder::new(Vec::new());
        for (path, data, mode) in files {
            let mut h = tar::Header::new_ustar();
            h.set_size(data.len() as u64);
            h.set_mode(*mode);
            h.set_entry_type(tar::EntryType::Regular);
            b.append_data(&mut h, path, *data).unwrap();
        }
        b.into_inner().unwrap()
    }

    fn zstd_frame(data: &[u8]) -> Vec<u8> {
        ruzstd::encoding::compress_to_vec(data, ruzstd::encoding::CompressionLevel::Fastest)
    }

    fn sha_hex(data: &[u8]) -> String {
        Sha256::digest(data)
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect()
    }

    fn runtime_files() -> Vec<(&'static str, &'static [u8], u32)> {
        vec![
            ("hermes-claude-bridge.mjs", b"// bridge\n", 0o644),
            ("package.json", b"{}\n", 0o644),
            (
                "node_modules/@anthropic-ai/claude-agent-sdk/package.json",
                b"{\"version\":\"9.9.9\"}\n",
                0o644,
            ),
            (
                "node_modules/@anthropic-ai/claude-agent-sdk-test/claude",
                b"#!/bin/sh\n",
                0o755,
            ),
        ]
    }

    fn pack_with(id: &str, files: &[(&str, &[u8], u32)]) -> Packed {
        let tmp = tempfile::tempdir().unwrap();
        let bundle = tmp.path().join("res").join("bridge").join("runtime");
        fs::create_dir_all(&bundle).unwrap();
        let archive = zstd_frame(&tar_bytes(files));
        fs::write(bundle.join("bridge-runtime.tar.zst"), &archive).unwrap();
        let manifest = RuntimeManifest {
            format: 1,
            id: id.into(),
            sdk_version: "9.9.9".into(),
            archive: "bridge-runtime.tar.zst".into(),
            archive_sha256: sha_hex(&archive),
            archive_bytes: archive.len() as u64,
            file_count: files.len() as u64,
            entry: "hermes-claude-bridge.mjs".into(),
        };
        fs::write(
            bundle.join(MANIFEST_FILE),
            serde_json::to_string(&manifest).unwrap(),
        )
        .unwrap();
        let root = tmp.path().join("data").join("runtime");
        Packed {
            _tmp: tmp,
            bundle,
            root,
            manifest,
        }
    }

    fn pack(id: &str) -> Packed {
        pack_with(id, &runtime_files())
    }

    #[test]
    fn first_call_unpacks_and_second_call_reuses() {
        let p = pack("aaaa000011112222");
        let first = ensure_unpacked(&p.bundle, &p.root).unwrap();
        assert!(first.unpacked_now);
        assert_eq!(first.dir, p.root.join("aaaa000011112222"));
        assert_eq!(first.bridge, first.dir.join("hermes-claude-bridge.mjs"));
        assert_eq!(fs::read(&first.bridge).unwrap(), b"// bridge\n");
        assert!(first
            .dir
            .join("node_modules/@anthropic-ai/claude-agent-sdk/package.json")
            .is_file());
        assert_eq!(first.sdk_version, "9.9.9");

        let second = ensure_unpacked(&p.bundle, &p.root).unwrap();
        assert!(!second.unpacked_now, "a complete runtime is reused");
        assert_eq!(second.dir, first.dir);
        // No temporary folder is left behind.
        let names: Vec<String> = fs::read_dir(&p.root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["aaaa000011112222".to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn executable_bits_survive_the_unpack() {
        use std::os::unix::fs::PermissionsExt;
        let p = pack("bbbb000011112222");
        let u = ensure_unpacked(&p.bundle, &p.root).unwrap();
        let mode = fs::metadata(
            u.dir
                .join("node_modules/@anthropic-ai/claude-agent-sdk-test/claude"),
        )
        .unwrap()
        .permissions()
        .mode();
        assert_eq!(
            mode & 0o111,
            0o111,
            "the native claude binary stays executable"
        );
    }

    #[test]
    fn a_runtime_that_lost_a_file_is_unpacked_again() {
        let p = pack("cccc000011112222");
        let u = ensure_unpacked(&p.bundle, &p.root).unwrap();
        fs::remove_file(
            u.dir
                .join("node_modules/@anthropic-ai/claude-agent-sdk/package.json"),
        )
        .unwrap();
        let again = ensure_unpacked(&p.bundle, &p.root).unwrap();
        assert!(again.unpacked_now, "a damaged runtime is repaired");
        assert!(again
            .dir
            .join("node_modules/@anthropic-ai/claude-agent-sdk/package.json")
            .is_file());
    }

    #[test]
    fn a_folder_without_the_marker_is_never_trusted() {
        let p = pack("dddd000011112222");
        // Looks complete, but was never finished by us (e.g. a crash before
        // the marker was written in an older layout).
        let fake = p.root.join("dddd000011112222");
        fs::create_dir_all(fake.join("node_modules/@anthropic-ai/claude-agent-sdk")).unwrap();
        fs::write(fake.join("hermes-claude-bridge.mjs"), b"stale").unwrap();
        fs::write(fake.join("package.json"), b"{}").unwrap();
        fs::write(
            fake.join("node_modules/@anthropic-ai/claude-agent-sdk/package.json"),
            b"{}",
        )
        .unwrap();
        let u = ensure_unpacked(&p.bundle, &p.root).unwrap();
        assert!(u.unpacked_now);
        assert_eq!(fs::read(&u.bridge).unwrap(), b"// bridge\n");
    }

    #[test]
    fn a_corrupt_archive_is_refused_with_a_clear_reason_and_nothing_is_left() {
        let p = pack("eeee000011112222");
        let archive = p.bundle.join("bridge-runtime.tar.zst");
        let mut bytes = fs::read(&archive).unwrap();
        let mid = bytes.len() / 2;
        bytes[mid] ^= 0xff;
        fs::write(&archive, &bytes).unwrap();
        let err = ensure_unpacked(&p.bundle, &p.root).unwrap_err();
        assert!(err.contains("checksum does not match"), "{err}");
        assert!(!p.root.join("eeee000011112222").exists());
    }

    #[test]
    fn a_truncated_archive_is_refused() {
        let p = pack("ffff000011112222");
        let archive = p.bundle.join("bridge-runtime.tar.zst");
        let bytes = fs::read(&archive).unwrap();
        fs::write(&archive, &bytes[..bytes.len() - 10]).unwrap();
        let err = ensure_unpacked(&p.bundle, &p.root).unwrap_err();
        assert!(err.contains("manifest says"), "{err}");
    }

    #[test]
    fn a_missing_archive_is_reported() {
        let p = pack("abab000011112222");
        fs::remove_file(p.bundle.join("bridge-runtime.tar.zst")).unwrap();
        let err = ensure_unpacked(&p.bundle, &p.root).unwrap_err();
        assert!(err.contains("is missing"), "{err}");
    }

    #[test]
    fn an_archive_whose_file_count_differs_from_the_manifest_is_refused() {
        let mut p = pack("acac000011112222");
        p.manifest.file_count += 1;
        fs::write(
            p.bundle.join(MANIFEST_FILE),
            serde_json::to_string(&p.manifest).unwrap(),
        )
        .unwrap();
        let err = ensure_unpacked(&p.bundle, &p.root).unwrap_err();
        assert!(err.contains("holds 4 files"), "{err}");
        assert!(!p.root.join("acac000011112222").exists());
        let leftovers = fs::read_dir(&p.root).unwrap().count();
        assert_eq!(leftovers, 0, "the temporary folder is removed on failure");
    }

    #[test]
    fn an_archive_without_the_sdk_is_refused() {
        let files: Vec<_> = runtime_files()
            .into_iter()
            .filter(|(p, _, _)| !p.contains("claude-agent-sdk/package.json"))
            .collect();
        let p = pack_with("adad000011112222", &files);
        let err = ensure_unpacked(&p.bundle, &p.root).unwrap_err();
        assert!(
            err.contains("missing the bridge or the Claude Agent SDK"),
            "{err}"
        );
    }

    #[test]
    fn entries_outside_the_folder_are_refused() {
        // Build the escaping tar by hand: tar::Builder refuses `..` names.
        let mut raw = tar_bytes(&[("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", b"x", 0o644)]);
        let name = b"../escape.txt";
        raw[..100].fill(0);
        raw[..name.len()].copy_from_slice(name);
        raw[148..156].copy_from_slice(b"        ");
        let sum: u32 = raw[..512].iter().map(|b| *b as u32).sum();
        raw[148..156].copy_from_slice(format!("{:06o}\0 ", sum).as_bytes());
        let tmp = tempfile::tempdir().unwrap();
        let archive = tmp.path().join("a.tar.zst");
        fs::write(&archive, zstd_frame(&raw)).unwrap();
        let dest = tmp.path().join("dest");
        fs::create_dir(&dest).unwrap();
        let err = unpack_archive(&archive, &dest).unwrap_err();
        assert!(err.contains("outside its folder"), "{err}");
        assert!(!tmp.path().join("escape.txt").exists());
    }

    #[test]
    fn symlinks_in_the_archive_are_refused() {
        let mut b = tar::Builder::new(Vec::new());
        let mut h = tar::Header::new_ustar();
        h.set_entry_type(tar::EntryType::Symlink);
        h.set_size(0);
        b.append_link(&mut h, "link", "/etc/passwd").unwrap();
        let raw = b.into_inner().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let archive = tmp.path().join("a.tar.zst");
        fs::write(&archive, zstd_frame(&raw)).unwrap();
        let dest = tmp.path().join("dest");
        fs::create_dir(&dest).unwrap();
        let err = unpack_archive(&archive, &dest).unwrap_err();
        assert!(err.contains("not a file"), "{err}");
    }

    #[test]
    fn a_new_runtime_replaces_the_old_one() {
        let old = pack("0000aaaa0000aaaa");
        ensure_unpacked(&old.bundle, &old.root).unwrap();
        // Same data folder, an update ships another runtime.
        let new = pack("1111bbbb1111bbbb");
        fs::create_dir_all(&new.root).unwrap();
        fs::rename(
            old.root.join("0000aaaa0000aaaa"),
            new.root.join("0000aaaa0000aaaa"),
        )
        .unwrap();
        let u = ensure_unpacked(&new.bundle, &new.root).unwrap();
        assert!(u.unpacked_now);
        assert!(new.root.join("1111bbbb1111bbbb").is_dir());
        assert!(
            !new.root.join("0000aaaa0000aaaa").exists(),
            "the old runtime is removed once the new one is ready"
        );
    }

    #[test]
    fn garbage_collection_keeps_foreign_folders_and_fresh_temp_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("keepme")).unwrap();
        fs::create_dir_all(root.join("old")).unwrap();
        fs::write(root.join("old").join(MARKER_FILE), "{}").unwrap();
        fs::create_dir_all(root.join("not-ours")).unwrap();
        fs::create_dir_all(root.join(".tmp-x-1-2")).unwrap();
        let removed = collect_garbage(root, "keepme");
        assert_eq!(removed, vec!["old".to_string()]);
        assert!(root.join("keepme").is_dir());
        assert!(
            root.join("not-ours").is_dir(),
            "never deletes what we did not make"
        );
        assert!(
            root.join(".tmp-x-1-2").is_dir(),
            "a fresh temp folder may be in use"
        );
    }

    #[test]
    fn concurrent_callers_get_one_complete_runtime() {
        let p = pack("abcd000011112222");
        let bundle = p.bundle.clone();
        let root = p.root.clone();
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let (b, r) = (bundle.clone(), root.clone());
                std::thread::spawn(move || ensure_unpacked(&b, &r).unwrap())
            })
            .collect();
        let results: Vec<Unpacked> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|u| u.unpacked_now).count(), 1);
        assert!(results.iter().all(|u| u.bridge.is_file()));
    }

    #[test]
    fn unsafe_manifest_values_are_refused() {
        let p = pack("abcd111122223333");
        for (field, value) in [
            ("id", "../../etc"),
            ("archive", "../x"),
            ("entry", ".hidden"),
        ] {
            let mut v = serde_json::to_value(&p.manifest).unwrap();
            v[field] = serde_json::Value::String(value.into());
            fs::write(p.bundle.join(MANIFEST_FILE), v.to_string()).unwrap();
            let err = ensure_unpacked(&p.bundle, &p.root).unwrap_err();
            assert!(err.contains("unsafe"), "{field}: {err}");
        }
        let mut v = serde_json::to_value(&p.manifest).unwrap();
        v["format"] = serde_json::json!(2);
        fs::write(p.bundle.join(MANIFEST_FILE), v.to_string()).unwrap();
        let err = ensure_unpacked(&p.bundle, &p.root).unwrap_err();
        assert!(err.contains("format 2"), "{err}");
    }

    /// The real packer (scripts/pack-bridge-runtime.mjs, what the release
    /// build runs) and this unpacker agree: long names, executable bits,
    /// zstd settings, manifest fields.
    #[test]
    fn unpacks_what_the_real_packer_writes() {
        let Some(node) = crate::agent::which_node() else {
            assert!(std::env::var("CI").is_err(), "node is required on CI");
            eprintln!("skipping: node not found");
            return;
        };
        let tmp = tempfile::tempdir().unwrap();
        let bridge = tmp.path().join("bridge");
        let long = format!(
            "node_modules/@scope/{}index.js",
            "a-rather-long-folder-name/".repeat(6)
        );
        let files: Vec<(String, &[u8])> = vec![
            (
                "hermes-claude-bridge.mjs".into(),
                b"import './helper.mjs';\n",
            ),
            ("helper.mjs".into(), b"export {};\n"),
            ("package.json".into(), b"{}\n"),
            (
                "node_modules/@anthropic-ai/claude-agent-sdk/package.json".into(),
                b"{\"version\":\"4.5.6\"}\n",
            ),
            (
                "node_modules/@anthropic-ai/claude-agent-sdk-test/claude".into(),
                b"#!/bin/sh\n",
            ),
            (long.clone(), b"export const deep = 1;\n"),
        ];
        for (rel, data) in &files {
            let p = bridge.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, data).unwrap();
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                bridge.join("node_modules/@anthropic-ai/claude-agent-sdk-test/claude"),
                fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        }
        let out = tmp.path().join("res").join("bridge").join("runtime");
        let script = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("scripts")
            .join("pack-bridge-runtime.mjs");
        let status = std::process::Command::new(&node)
            .arg(&script)
            .args(["--level", "19", "--bridge-dir"])
            .arg(&bridge)
            .arg("--out-dir")
            .arg(&out)
            .status()
            .unwrap();
        assert!(status.success(), "the packer failed");

        let root = tmp.path().join("data").join("runtime");
        let u = ensure_unpacked(&out, &root).unwrap();
        assert!(u.unpacked_now);
        assert_eq!(u.sdk_version, "4.5.6");
        for (rel, data) in &files {
            assert_eq!(&fs::read(u.dir.join(rel)).unwrap(), data, "{rel}");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(
                u.dir
                    .join("node_modules/@anthropic-ai/claude-agent-sdk-test/claude"),
            )
            .unwrap()
            .permissions()
            .mode();
            assert_eq!(mode & 0o111, 0o111);
        }
        assert!(!ensure_unpacked(&out, &root).unwrap().unpacked_now);
    }

    #[test]
    fn bundle_dir_prefers_the_override_and_needs_a_manifest() {
        let tmp = tempfile::tempdir().unwrap();
        let res = tmp.path();
        assert_eq!(bundle_dir(Some(res), None), None, "no manifest, no runtime");
        fs::create_dir_all(res.join(RESOURCE_SUBDIR)).unwrap();
        assert_eq!(bundle_dir(Some(res), None), None);
        let mut f = fs::File::create(res.join(RESOURCE_SUBDIR).join(MANIFEST_FILE)).unwrap();
        f.write_all(b"{}").unwrap();
        assert_eq!(bundle_dir(Some(res), None), Some(res.join(RESOURCE_SUBDIR)));
        assert_eq!(
            bundle_dir(Some(res), Some("/elsewhere")),
            Some(PathBuf::from("/elsewhere"))
        );
        assert_eq!(
            bundle_dir(Some(res), Some("  ")),
            Some(res.join(RESOURCE_SUBDIR))
        );
        assert_eq!(bundle_dir(None, None), None);
    }
}
