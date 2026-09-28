//! Copy-on-write folder clones.
//!
//! A clone shares the source's disk blocks until one side writes to a file,
//! so a 700 MB `node_modules` appears in a new worktree in about a second and
//! uses a few megabytes. Each platform has its own way:
//!
//! - macOS (APFS): `clonefile(2)` clones the whole folder in one call.
//! - Linux (btrfs, XFS, bcachefs): the `FICLONE` ioctl, file by file.
//! - Windows (ReFS, Dev Drive): `FSCTL_DUPLICATE_EXTENTS_TO_FILE`, file by
//!   file; files that fit in one cluster are copied instead (much faster
//!   there, at a cost of one cluster each).
//!
//! When the disk cannot share blocks (APFS/btrfs/XFS/ReFS absent, or source
//! and destination on different disks) [`clone_dir`] says so with
//! [`CloneError::Unsupported`] and leaves nothing behind; the caller then
//! falls back to a normal install. It never falls back to a plain copy: that
//! would be slow and use the full size on disk.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// How a folder was cloned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CloneMethod {
    /// macOS `clonefile(2)` on APFS.
    Clonefile,
    /// Linux `FICLONE` (btrfs, XFS, bcachefs).
    Reflink,
    /// Windows block cloning (ReFS, Dev Drive).
    BlockClone,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloneError {
    /// This disk, or this pair of folders, cannot share blocks.
    Unsupported(String),
    /// Something else went wrong (permissions, a file vanished, ...).
    Failed(String),
}

impl std::fmt::Display for CloneError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CloneError::Unsupported(why) | CloneError::Failed(why) => f.write_str(why),
        }
    }
}

/// Clone the folder `src` to `dst` (which must not exist) copy-on-write.
///
/// The clone is built under a hidden name next to `dst` and renamed into
/// place at the end, so `dst` either appears complete or not at all.
pub fn clone_dir(src: &Path, dst: &Path) -> Result<CloneMethod, CloneError> {
    if cow_disabled_for_tests() {
        return Err(CloneError::Unsupported(
            "copy-on-write turned off for this test run".into(),
        ));
    }
    let meta = fs::symlink_metadata(src)
        .map_err(|e| CloneError::Failed(format!("cannot read '{}': {e}", src.display())))?;
    if !meta.is_dir() {
        return Err(CloneError::Failed(format!(
            "'{}' is not a folder",
            src.display()
        )));
    }
    if fs::symlink_metadata(dst).is_ok() {
        return Err(CloneError::Failed(format!(
            "'{}' already exists",
            dst.display()
        )));
    }
    let staging = staging_path(dst)?;
    if fs::symlink_metadata(&staging).is_ok() {
        // Left by an earlier attempt that was cut short.
        remove_any(&staging);
    }
    match platform::clone_tree(src, &staging) {
        Ok(method) => match fs::rename(&staging, dst) {
            Ok(()) => Ok(method),
            Err(e) => {
                remove_any(&staging);
                Err(CloneError::Failed(format!(
                    "cannot move the clone into place: {e}"
                )))
            }
        },
        Err(e) => {
            remove_any(&staging);
            Err(e)
        }
    }
}

/// Where a clone of `dst` is built before it is renamed into place.
pub fn staging_path(dst: &Path) -> Result<PathBuf, CloneError> {
    let name = dst
        .file_name()
        .ok_or_else(|| CloneError::Failed(format!("'{}' has no folder name", dst.display())))?;
    let mut staged = std::ffi::OsString::from(".");
    staged.push(name);
    staged.push(".hermes-clone");
    Ok(dst.with_file_name(staged))
}

fn remove_any(path: &Path) {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => {
            let _ = fs::remove_dir_all(path);
        }
        Ok(_) => {
            let _ = fs::remove_file(path);
        }
        Err(_) => {}
    }
}

/// Test builds only: `HERMES_E2E_NO_COPY_ON_WRITE=1` (with `HERMES_E2E=1`)
/// makes every clone report an unsupported disk, so the real-app scenario can
/// show the install fallback on any machine.
fn cow_disabled_for_tests() -> bool {
    #[cfg(feature = "e2e")]
    {
        parse_no_cow_override(
            std::env::var("HERMES_E2E").ok().as_deref(),
            std::env::var("HERMES_E2E_NO_COPY_ON_WRITE").ok().as_deref(),
        )
    }
    #[cfg(not(feature = "e2e"))]
    {
        false
    }
}

#[cfg(any(test, feature = "e2e"))]
fn parse_no_cow_override(e2e: Option<&str>, value: Option<&str>) -> bool {
    crate::e2e_protocol::is_enabled(e2e) && value.map(str::trim) == Some("1")
}

// ─── Per-file walk (Linux, Windows) ─────────────────────────────────

/// Recreate `src` at `dst`: folders and symlinks as they are, every file
/// through `clone_file`. The first file decides whether the disk supports
/// cloning at all; an unsupported disk stops the walk straight away.
#[cfg(any(target_os = "linux", target_os = "android", windows, test))]
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn walk_clone(src: &Path, dst: &Path, clone_file: &FileCloner) -> Result<(), CloneError> {
    let fail = |what: &str, p: &Path, e: std::io::Error| {
        CloneError::Failed(format!("cannot {what} '{}': {e}", p.display()))
    };
    // Pass 1: folders and links, and the list of files. The listing's own
    // metadata is used: on Windows it costs nothing, while asking for a
    // path's metadata opens the file.
    let started = std::time::Instant::now();
    fs::create_dir(dst).map_err(|e| fail("create", dst, e))?;
    let mut stack: Vec<(PathBuf, PathBuf)> = vec![(src.to_path_buf(), dst.to_path_buf())];
    let mut dirs: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut files: Vec<(PathBuf, PathBuf, fs::Metadata)> = Vec::new();
    while let Some((from, to)) = stack.pop() {
        let entries = fs::read_dir(&from).map_err(|e| fail("read", &from, e))?;
        for entry in entries {
            let entry = entry.map_err(|e| fail("read", &from, e))?;
            let src_path = entry.path();
            let dst_path = to.join(entry.file_name());
            let meta = entry.metadata().map_err(|e| fail("read", &src_path, e))?;
            if meta.file_type().is_symlink() {
                copy_symlink(&src_path, &dst_path)?;
            } else if meta.is_dir() {
                fs::create_dir(&dst_path).map_err(|e| fail("create", &dst_path, e))?;
                stack.push((src_path.clone(), dst_path.clone()));
                dirs.push((src_path, dst_path));
            } else {
                files.push((src_path, dst_path, meta));
            }
        }
    }

    let listed_ms = started.elapsed().as_millis();

    // Pass 2: the files. The first alone, so an unsupported disk is known
    // after one attempt; the rest on several threads, because creating
    // files (not sharing their blocks) is what takes the time, most of all
    // on Windows.
    let mut workers = 1;
    let clone_one = |(from, to, meta): &(PathBuf, PathBuf, fs::Metadata)| {
        let file = clone_file(from, to, meta)?;
        finish_file(&file, meta, to)
    };
    if let Some(first) = files.first() {
        clone_one(first)?;
    }
    let rest = files.get(1..).unwrap_or_default();
    if !rest.is_empty() {
        use std::sync::atomic::Ordering::Relaxed;
        workers = clone_threads().min(rest.len());
        let stop = std::sync::atomic::AtomicBool::new(false);
        // Each thread takes the next file when it is done with one, so a
        // thread held up (by a large file, or waiting its turn to block
        // clone on Windows) does not leave a share of files waiting on it.
        let next = std::sync::atomic::AtomicUsize::new(0);
        let first_error: std::sync::Mutex<Option<CloneError>> = std::sync::Mutex::new(None);
        std::thread::scope(|s| {
            for _ in 0..workers {
                let (stop, next, first_error, clone_one) = (&stop, &next, &first_error, &clone_one);
                s.spawn(move || {
                    while let Some(item) = rest.get(next.fetch_add(1, Relaxed)) {
                        if stop.load(Relaxed) {
                            return;
                        }
                        if let Err(e) = clone_one(item) {
                            stop.store(true, Relaxed);
                            if let Ok(mut slot) = first_error.lock() {
                                slot.get_or_insert(e);
                            }
                            return;
                        }
                    }
                });
            }
        });
        if let Some(e) = first_error.into_inner().ok().flatten() {
            return Err(e);
        }
    }
    log::info!(
        "[fast-worktrees] cloned {} files and {} folders in {} ms (listing {} ms, {} threads)",
        files.len(),
        dirs.len(),
        started.elapsed().as_millis(),
        listed_ms,
        workers
    );

    // Folder permissions last: a read-only folder must be filled first.
    for (from, to) in dirs
        .iter()
        .rev()
        .chain(std::iter::once(&(src.to_path_buf(), dst.to_path_buf())))
    {
        if let Ok(meta) = fs::metadata(from) {
            let _ = fs::set_permissions(to, meta.permissions());
        }
    }
    Ok(())
}

/// How many threads clone files. Measured on CI runners with 6,000 files:
/// XFS went from 775 ms on one thread to about 400 ms on four. ReFS block
/// clones contend when several run at once (6 s became 35 s), so Windows
/// runs those one at a time (see `platform::clone_tree`).
#[cfg(any(target_os = "linux", target_os = "android", windows, test))]
fn clone_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(1, 8)
}

/// Clones one file: creates `dst` (open for writing) sharing `src`'s blocks.
#[cfg(any(target_os = "linux", target_os = "android", windows, test))]
type FileCloner<'a> =
    dyn Fn(&Path, &Path, &fs::Metadata) -> Result<fs::File, CloneError> + Sync + 'a;

/// Give a cloned file its source's timestamps and permissions, through the
/// handle the clone left open (no second open per file).
#[cfg(any(target_os = "linux", target_os = "android", windows, test))]
fn finish_file(file: &fs::File, meta: &fs::Metadata, dst: &Path) -> Result<(), CloneError> {
    let mut times = fs::FileTimes::new();
    if let Ok(t) = meta.modified() {
        times = times.set_modified(t);
    }
    if let Ok(t) = meta.accessed() {
        times = times.set_accessed(t);
    }
    // Build tools compare timestamps: a clone must look as old as its source.
    file.set_times(times)
        .map_err(|e| CloneError::Failed(format!("cannot set times on '{}': {e}", dst.display())))?;
    // On Windows the only permission is read-only, and a new file is not.
    if cfg!(windows) && !meta.permissions().readonly() {
        return Ok(());
    }
    file.set_permissions(meta.permissions()).map_err(|e| {
        CloneError::Failed(format!(
            "cannot set permissions on '{}': {e}",
            dst.display()
        ))
    })
}

#[cfg(all(unix, any(target_os = "linux", target_os = "android", test)))]
fn copy_symlink(src: &Path, dst: &Path) -> Result<(), CloneError> {
    let target = fs::read_link(src)
        .map_err(|e| CloneError::Failed(format!("cannot read link '{}': {e}", src.display())))?;
    std::os::unix::fs::symlink(&target, dst)
        .map_err(|e| CloneError::Failed(format!("cannot create link '{}': {e}", dst.display())))
}

#[cfg(windows)]
fn copy_symlink(src: &Path, dst: &Path) -> Result<(), CloneError> {
    let target = fs::read_link(src)
        .map_err(|e| CloneError::Failed(format!("cannot read link '{}': {e}", src.display())))?;
    // Resolve relative targets against the link's folder to learn the kind.
    let resolved = src
        .parent()
        .map(|p| p.join(&target))
        .unwrap_or_else(|| target.clone());
    let made = if resolved.is_dir() {
        std::os::windows::fs::symlink_dir(&target, dst)
    } else {
        std::os::windows::fs::symlink_file(&target, dst)
    };
    made.map_err(|e| CloneError::Failed(format!("cannot create link '{}': {e}", dst.display())))
}

/// Windows: files up to this size are copied rather than block-cloned. In
/// this repo's node_modules they are 98% of the files but 16% of the bytes
/// (about 27,000 files, 94 MB of 580 MB): block cloning them all took over
/// 9 s on CI, one at a time, while copying them takes a fraction of that on
/// several threads. The large files, where the space is, stay shared.
#[cfg(any(windows, test))]
const COPY_UP_TO: u64 = 64 * 1024;

/// Windows: whether a file of `len` bytes is copied rather than block-cloned
/// on a disk with `cluster`-byte clusters (see `platform::clone_tree`).
#[cfg(any(windows, test))]
fn copies_instead(len: u64, cluster: u64) -> bool {
    len <= COPY_UP_TO.max(cluster)
}

/// A plain copy of a small file, left open like a clone (for `finish_file`).
#[cfg(any(windows, test))]
fn copy_small_file(src: &Path, dst: &Path) -> Result<fs::File, CloneError> {
    let mut from = fs::File::open(src)
        .map_err(|e| CloneError::Failed(format!("cannot open '{}': {e}", src.display())))?;
    let mut to = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dst)
        .map_err(|e| CloneError::Failed(format!("cannot create '{}': {e}", dst.display())))?;
    std::io::copy(&mut from, &mut to)
        .map_err(|e| CloneError::Failed(format!("cannot copy '{}': {e}", src.display())))?;
    Ok(to)
}

// ─── macOS ──────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod platform {
    use super::{CloneError, CloneMethod};
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    pub fn clone_tree(src: &Path, dst: &Path) -> Result<CloneMethod, CloneError> {
        let c = |p: &Path| {
            CString::new(p.as_os_str().as_bytes())
                .map_err(|_| CloneError::Failed(format!("'{}' contains a NUL byte", p.display())))
        };
        let (c_src, c_dst) = (c(src)?, c(dst)?);
        // SAFETY: both are valid NUL-terminated paths; flags 0 (src is a
        // real folder, checked by the caller).
        let rc = unsafe { libc::clonefile(c_src.as_ptr(), c_dst.as_ptr(), 0) };
        if rc == 0 {
            return Ok(CloneMethod::Clonefile);
        }
        let err = std::io::Error::last_os_error();
        Err(match err.raw_os_error() {
            Some(libc::ENOTSUP) => CloneError::Unsupported(
                "this disk does not support copy-on-write clones (APFS needed)".into(),
            ),
            Some(libc::EXDEV) => CloneError::Unsupported(
                "the source and the new worktree are on different disks".into(),
            ),
            _ => CloneError::Failed(format!("clonefile failed: {err}")),
        })
    }
}

// ─── Linux ──────────────────────────────────────────────────────────

#[cfg(any(target_os = "linux", target_os = "android"))]
mod platform {
    use super::{walk_clone, CloneError, CloneMethod};
    use std::fs;
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::io::AsRawFd;
    use std::path::Path;

    pub fn clone_tree(src: &Path, dst: &Path) -> Result<CloneMethod, CloneError> {
        walk_clone(src, dst, &reflink_file)?;
        Ok(CloneMethod::Reflink)
    }

    fn reflink_file(src: &Path, dst: &Path, meta: &fs::Metadata) -> Result<fs::File, CloneError> {
        use std::os::unix::fs::PermissionsExt;
        let from = fs::File::open(src)
            .map_err(|e| CloneError::Failed(format!("cannot open '{}': {e}", src.display())))?;
        let to = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(meta.permissions().mode() | 0o200)
            .open(dst)
            .map_err(|e| CloneError::Failed(format!("cannot create '{}': {e}", dst.display())))?;
        // SAFETY: both descriptors are open for the duration of the call.
        let rc = unsafe { libc::ioctl(to.as_raw_fd(), libc::FICLONE, from.as_raw_fd()) };
        if rc == 0 {
            return Ok(to);
        }
        let err = std::io::Error::last_os_error();
        Err(match err.raw_os_error() {
            Some(libc::EOPNOTSUPP)
            | Some(libc::ENOTTY)
            | Some(libc::EINVAL)
            | Some(libc::ENOSYS) => CloneError::Unsupported(
                "this disk does not support copy-on-write clones (btrfs or XFS needed)".into(),
            ),
            Some(libc::EXDEV) => CloneError::Unsupported(
                "the source and the new worktree are on different disks".into(),
            ),
            _ => CloneError::Failed(format!("reflink of '{}' failed: {err}", src.display())),
        })
    }
}

// ─── Windows ────────────────────────────────────────────────────────

#[cfg(windows)]
mod platform {
    use super::{copies_instead, copy_small_file, walk_clone, CloneError, CloneMethod, COPY_UP_TO};
    use std::fs;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        FileEndOfFileInfo, GetDiskFreeSpaceW, GetVolumeInformationByHandleW, GetVolumePathNameW,
        SetFileInformationByHandle, FILE_ATTRIBUTE_SPARSE_FILE, FILE_END_OF_FILE_INFO,
        FILE_FLAG_BACKUP_SEMANTICS,
    };
    use windows_sys::Win32::System::Ioctl::{
        DUPLICATE_EXTENTS_DATA, FSCTL_DUPLICATE_EXTENTS_TO_FILE, FSCTL_GET_INTEGRITY_INFORMATION,
        FSCTL_GET_INTEGRITY_INFORMATION_BUFFER, FSCTL_SET_INTEGRITY_INFORMATION,
        FSCTL_SET_INTEGRITY_INFORMATION_BUFFER, FSCTL_SET_SPARSE,
    };
    use windows_sys::Win32::System::SystemServices::FILE_SUPPORTS_BLOCK_REFCOUNTING;
    use windows_sys::Win32::System::IO::DeviceIoControl;

    /// One duplicate-extents call may move less than 4 GB.
    const MAX_CHUNK: i64 = 1 << 31;

    pub fn clone_tree(src: &Path, dst: &Path) -> Result<CloneMethod, CloneError> {
        let parent = dst
            .parent()
            .ok_or_else(|| CloneError::Failed(format!("'{}' has no parent", dst.display())))?;
        let (src_serial, src_flags) = volume_of(src)?;
        let (dst_serial, _) = volume_of(parent)?;
        if src_flags & FILE_SUPPORTS_BLOCK_REFCOUNTING == 0 {
            return Err(CloneError::Unsupported(
                "this disk does not support block cloning (ReFS or Dev Drive needed)".into(),
            ));
        }
        if src_serial != dst_serial {
            return Err(CloneError::Unsupported(
                "the source and the new worktree are on different disks".into(),
            ));
        }
        // Sharing a file's blocks costs ReFS milliseconds per file however
        // small the file is (measured on CI: 6,000 small files took 22 s), so
        // small files are copied instead (see `COPY_UP_TO`), in a fraction of
        // the time. Larger files, where the space is, are always shared, one
        // at a time: block clones running side by side contend (6 s on one
        // thread became 35 s on four). The copies run in parallel.
        use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering::Relaxed};
        let cluster = cluster_size(parent).unwrap_or(4096);
        let (copied, copy_us, clone_us) =
            (AtomicUsize::new(0), AtomicU64::new(0), AtomicU64::new(0));
        let one_clone_at_a_time = std::sync::Mutex::new(());
        let clone_file = |from: &Path, to: &Path, meta: &fs::Metadata| {
            let started = std::time::Instant::now();
            if copies_instead(meta.len(), cluster) {
                let file = copy_small_file(from, to);
                copied.fetch_add(1, Relaxed);
                copy_us.fetch_add(started.elapsed().as_micros() as u64, Relaxed);
                file
            } else {
                let _turn = one_clone_at_a_time
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let file = block_clone_file(from, to, meta);
                clone_us.fetch_add(started.elapsed().as_micros() as u64, Relaxed);
                file
            }
        };
        walk_clone(src, dst, &clone_file)?;
        log::info!(
            "[fast-worktrees] {} files of {} bytes or less were copied ({} ms), the rest block-cloned ({} ms, waits included)",
            copied.into_inner(),
            COPY_UP_TO.max(cluster),
            copy_us.into_inner() / 1000,
            clone_us.into_inner() / 1000
        );
        Ok(CloneMethod::BlockClone)
    }

    /// The cluster size of the disk holding `path`.
    fn cluster_size(path: &Path) -> Option<u64> {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
        let mut root = [0u16; 1024];
        // SAFETY: `wide` is NUL-terminated; `root` holds `root.len()` units
        // and comes back NUL-terminated on success.
        if unsafe { GetVolumePathNameW(wide.as_ptr(), root.as_mut_ptr(), root.len() as u32) } == 0 {
            return None;
        }
        let (mut per_cluster, mut per_sector, mut free, mut total) = (0u32, 0u32, 0u32, 0u32);
        // SAFETY: `root` is a NUL-terminated volume root; the outputs are u32s.
        let ok = unsafe {
            GetDiskFreeSpaceW(
                root.as_ptr(),
                &mut per_cluster,
                &mut per_sector,
                &mut free,
                &mut total,
            )
        };
        let size = u64::from(per_cluster) * u64::from(per_sector);
        (ok != 0 && size > 0).then_some(size)
    }

    fn volume_of(path: &Path) -> Result<(u32, u32), CloneError> {
        let dir = fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
            .map_err(|e| CloneError::Failed(format!("cannot open '{}': {e}", path.display())))?;
        let (mut serial, mut max_len, mut flags) = (0u32, 0u32, 0u32);
        // SAFETY: the handle is open; null name buffers with size 0 are allowed.
        let ok = unsafe {
            GetVolumeInformationByHandleW(
                dir.as_raw_handle() as HANDLE,
                std::ptr::null_mut(),
                0,
                &mut serial,
                &mut max_len,
                &mut flags,
                std::ptr::null_mut(),
                0,
            )
        };
        if ok == 0 {
            return Err(CloneError::Failed(format!(
                "cannot read the disk of '{}': {}",
                path.display(),
                std::io::Error::last_os_error()
            )));
        }
        Ok((serial, flags))
    }

    fn ioctl(
        handle: HANDLE,
        code: u32,
        input: *const core::ffi::c_void,
        size: u32,
        out: *mut core::ffi::c_void,
        out_size: u32,
    ) -> std::io::Result<()> {
        let mut returned = 0u32;
        // SAFETY: the buffers are valid for the sizes given; no OVERLAPPED.
        let ok = unsafe {
            DeviceIoControl(
                handle,
                code,
                input,
                size,
                out,
                out_size,
                &mut returned,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn block_clone_file(
        src: &Path,
        dst: &Path,
        meta: &fs::Metadata,
    ) -> Result<fs::File, CloneError> {
        use std::os::windows::fs::MetadataExt;
        let failed = |what: &str, e: std::io::Error| {
            CloneError::Failed(format!("{what} '{}' failed: {e}", dst.display()))
        };
        let from = fs::File::open(src)
            .map_err(|e| CloneError::Failed(format!("cannot open '{}': {e}", src.display())))?;
        let to = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(dst)
            .map_err(|e| CloneError::Failed(format!("cannot create '{}': {e}", dst.display())))?;
        let (h_src, h_dst) = (from.as_raw_handle() as HANDLE, to.as_raw_handle() as HANDLE);
        let size = meta.len() as i64;
        if size == 0 {
            return Ok(to);
        }

        // The clone must match the source's integrity setting and learn the
        // cluster size, which every duplicated range is aligned to.
        let mut integrity = FSCTL_GET_INTEGRITY_INFORMATION_BUFFER::default();
        ioctl(
            h_src,
            FSCTL_GET_INTEGRITY_INFORMATION,
            std::ptr::null(),
            0,
            &mut integrity as *mut _ as *mut _,
            std::mem::size_of::<FSCTL_GET_INTEGRITY_INFORMATION_BUFFER>() as u32,
        )
        .map_err(|e| {
            CloneError::Unsupported(format!("block cloning is not available here: {e}"))
        })?;
        let set_integrity = FSCTL_SET_INTEGRITY_INFORMATION_BUFFER {
            ChecksumAlgorithm: integrity.ChecksumAlgorithm,
            Reserved: 0,
            Flags: integrity.Flags,
        };
        ioctl(
            h_dst,
            FSCTL_SET_INTEGRITY_INFORMATION,
            &set_integrity as *const _ as *const _,
            std::mem::size_of::<FSCTL_SET_INTEGRITY_INFORMATION_BUFFER>() as u32,
            std::ptr::null_mut(),
            0,
        )
        .map_err(|e| failed("setting integrity on", e))?;
        if meta.file_attributes() & FILE_ATTRIBUTE_SPARSE_FILE != 0 {
            ioctl(
                h_dst,
                FSCTL_SET_SPARSE,
                std::ptr::null(),
                0,
                std::ptr::null_mut(),
                0,
            )
            .map_err(|e| failed("marking sparse", e))?;
        }
        let eof = FILE_END_OF_FILE_INFO { EndOfFile: size };
        // SAFETY: the handle is open for writing and `eof` lives across the call.
        let ok = unsafe {
            SetFileInformationByHandle(
                h_dst,
                FileEndOfFileInfo,
                &eof as *const _ as *const _,
                std::mem::size_of::<FILE_END_OF_FILE_INFO>() as u32,
            )
        };
        if ok == 0 {
            return Err(failed("sizing", std::io::Error::last_os_error()));
        }

        let cluster = i64::from(integrity.ClusterSizeInBytes.max(4096));
        let rounded = (size + cluster - 1) / cluster * cluster;
        let mut offset = 0i64;
        while offset < rounded {
            let count = (rounded - offset).min(MAX_CHUNK);
            let data = DUPLICATE_EXTENTS_DATA {
                FileHandle: h_src,
                SourceFileOffset: offset,
                TargetFileOffset: offset,
                ByteCount: count,
            };
            ioctl(
                h_dst,
                FSCTL_DUPLICATE_EXTENTS_TO_FILE,
                &data as *const _ as *const _,
                std::mem::size_of::<DUPLICATE_EXTENTS_DATA>() as u32,
                std::ptr::null_mut(),
                0,
            )
            .map_err(|e| {
                if offset == 0 {
                    CloneError::Unsupported(format!("block cloning is not available here: {e}"))
                } else {
                    failed("block cloning", e)
                }
            })?;
            offset += count;
        }
        Ok(to)
    }
}

// ─── Anything else ──────────────────────────────────────────────────

#[cfg(not(any(
    target_os = "macos",
    target_os = "linux",
    target_os = "android",
    windows
)))]
mod platform {
    use super::{CloneError, CloneMethod};
    use std::path::Path;

    pub fn clone_tree(_src: &Path, _dst: &Path) -> Result<CloneMethod, CloneError> {
        Err(CloneError::Unsupported(
            "copy-on-write clones are not supported on this system".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use tempfile::TempDir;

    fn tree(root: &Path) {
        fs::create_dir_all(root.join("pkg/lib")).unwrap();
        fs::write(root.join("pkg/index.js"), "module.exports = 42;\n").unwrap();
        fs::write(root.join("pkg/lib/big.bin"), vec![7u8; 300_000]).unwrap();
        fs::write(root.join("pkg/empty"), b"").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::create_dir_all(root.join(".bin")).unwrap();
            std::os::unix::fs::symlink("../pkg/index.js", root.join(".bin/pkg")).unwrap();
            fs::set_permissions(root.join("pkg/index.js"), fs::Permissions::from_mode(0o755))
                .unwrap();
        }
    }

    /// A clone, when the disk supports it, is a real independent copy with
    /// the same content; when it does not, nothing is left behind.
    #[test]
    fn clone_dir_copies_the_tree_or_leaves_nothing() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("node_modules");
        tree(&src);
        let dst = tmp.path().join("wt").join("node_modules");
        fs::create_dir_all(dst.parent().unwrap()).unwrap();

        match clone_dir(&src, &dst) {
            Ok(method) => {
                #[cfg(target_os = "macos")]
                assert_eq!(method, CloneMethod::Clonefile);
                #[cfg(target_os = "linux")]
                assert_eq!(method, CloneMethod::Reflink);
                #[cfg(windows)]
                assert_eq!(method, CloneMethod::BlockClone);
                let _ = method;
                assert_eq!(
                    fs::read(dst.join("pkg/index.js")).unwrap(),
                    b"module.exports = 42;\n"
                );
                assert_eq!(
                    fs::read(dst.join("pkg/lib/big.bin")).unwrap(),
                    vec![7u8; 300_000]
                );
                assert_eq!(fs::metadata(dst.join("pkg/empty")).unwrap().len(), 0);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    assert_eq!(
                        fs::read_link(dst.join(".bin/pkg")).unwrap(),
                        Path::new("../pkg/index.js")
                    );
                    let mode = fs::metadata(dst.join("pkg/index.js"))
                        .unwrap()
                        .permissions()
                        .mode();
                    assert_eq!(mode & 0o777, 0o755, "the executable bit survives");
                }
                // Independent: writing the clone leaves the source alone.
                fs::write(dst.join("pkg/index.js"), "changed").unwrap();
                assert_eq!(
                    fs::read(src.join("pkg/index.js")).unwrap(),
                    b"module.exports = 42;\n"
                );
                assert!(
                    !staging_path(&dst).unwrap().exists(),
                    "no staging folder left"
                );
            }
            Err(CloneError::Unsupported(why)) => {
                // e.g. ext4 or NTFS on a CI runner: nothing may be left.
                assert!(!why.is_empty());
                assert!(!dst.exists(), "an unsupported clone creates nothing");
                assert!(
                    !staging_path(&dst).unwrap().exists(),
                    "no staging folder left"
                );
            }
            Err(CloneError::Failed(why)) => panic!("clone failed: {why}"),
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn apfs_temp_folder_clones_with_clonefile() {
        // macOS runners and Macs keep the temp folder on APFS.
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("a");
        tree(&src);
        assert_eq!(
            clone_dir(&src, &tmp.path().join("b")),
            Ok(CloneMethod::Clonefile)
        );
    }

    #[test]
    fn existing_destination_is_refused_and_kept() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("a");
        tree(&src);
        let dst = tmp.path().join("b");
        fs::create_dir_all(&dst).unwrap();
        fs::write(dst.join("mine"), "keep").unwrap();
        assert!(matches!(clone_dir(&src, &dst), Err(CloneError::Failed(_))));
        assert_eq!(fs::read_to_string(dst.join("mine")).unwrap(), "keep");
    }

    #[test]
    fn missing_or_file_source_is_an_error() {
        let tmp = TempDir::new().unwrap();
        let dst = tmp.path().join("b");
        assert!(matches!(
            clone_dir(&tmp.path().join("nope"), &dst),
            Err(CloneError::Failed(_))
        ));
        fs::write(tmp.path().join("file"), "x").unwrap();
        assert!(matches!(
            clone_dir(&tmp.path().join("file"), &dst),
            Err(CloneError::Failed(_))
        ));
        assert!(!dst.exists());
    }

    #[test]
    fn leftover_staging_folder_is_replaced() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("a");
        tree(&src);
        let dst = tmp.path().join("b");
        let staging = staging_path(&dst).unwrap();
        fs::create_dir_all(staging.join("junk")).unwrap();
        let _ = clone_dir(&src, &dst);
        assert!(
            !staging.exists(),
            "the half-built clone from before is gone"
        );
        assert!(!dst.exists() || !dst.join("junk").exists());
    }

    /// The per-file walk used on Linux and Windows, with a stand-in for the
    /// clone call: the tree comes out whole, and an unsupported first file
    /// stops the walk with that answer.
    #[test]
    fn walk_recreates_the_tree_through_the_file_cloner() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("a");
        tree(&src);
        let dst = tmp.path().join("b");
        walk_clone(&src, &dst, &copy_file).unwrap();
        assert_eq!(
            fs::read(dst.join("pkg/lib/big.bin")).unwrap(),
            vec![7u8; 300_000]
        );
        let src_time = fs::metadata(src.join("pkg/lib/big.bin"))
            .unwrap()
            .modified()
            .unwrap();
        let dst_time = fs::metadata(dst.join("pkg/lib/big.bin"))
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(src_time, dst_time, "timestamps are kept for build tools");

        let unsupported =
            |_f: &Path, _t: &Path, _m: &fs::Metadata| Err(CloneError::Unsupported("no".into()));
        let dst2 = tmp.path().join("c");
        assert_eq!(
            walk_clone(&src, &dst2, &unsupported),
            Err(CloneError::Unsupported("no".into()))
        );
    }

    /// Stand-in for a clone call: a plain copy, left open like a clone.
    fn copy_file(from: &Path, to: &Path, _m: &fs::Metadata) -> Result<fs::File, CloneError> {
        fs::copy(from, to).map_err(|e| CloneError::Failed(e.to_string()))?;
        fs::OpenOptions::new()
            .write(true)
            .open(to)
            .map_err(|e| CloneError::Failed(e.to_string()))
    }

    fn many_files(root: &Path) -> usize {
        let mut n = 0;
        for d in 0..20 {
            let dir = root.join(format!("pkg-{d}")).join("lib");
            fs::create_dir_all(&dir).unwrap();
            for f in 0..40 {
                fs::write(dir.join(format!("f{f}.js")), format!("{d}/{f}")).unwrap();
                n += 1;
            }
        }
        n
    }

    #[test]
    fn walk_clones_many_files_on_several_threads() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("a");
        let n = many_files(&src);
        let dst = tmp.path().join("b");
        let threads = std::sync::Mutex::new(HashSet::new());
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let counting = |from: &Path, to: &Path, m: &fs::Metadata| {
            calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            threads.lock().unwrap().insert(std::thread::current().id());
            copy_file(from, to, m)
        };
        walk_clone(&src, &dst, &counting).unwrap();
        assert_eq!(calls.into_inner(), n, "every file cloned once");
        for d in 0..20 {
            for f in 0..40 {
                let p = dst.join(format!("pkg-{d}/lib/f{f}.js"));
                assert_eq!(fs::read_to_string(p).unwrap(), format!("{d}/{f}"));
            }
        }
        if clone_threads() > 1 {
            assert!(
                threads.into_inner().unwrap().len() > 1,
                "the files were spread over threads"
            );
        }
    }

    #[test]
    fn only_small_files_are_copied_instead() {
        assert!(copies_instead(0, 4096));
        assert!(copies_instead(4097, 4096));
        assert!(copies_instead(64 * 1024, 4096));
        assert!(!copies_instead(64 * 1024 + 1, 4096));
        // A cluster larger than the limit: a file that fits in it is copied.
        assert!(copies_instead(100_000, 131_072));
        assert!(!copies_instead(131_073, 131_072));
        assert!(!copies_instead(256 << 20, 65_536));
    }

    #[test]
    fn a_small_file_copy_has_the_content_and_the_source_times() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("package.json");
        fs::write(&src, "{\"name\":\"n17\"}").unwrap();
        let old = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_600_000_000);
        fs::File::options()
            .write(true)
            .open(&src)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let meta = fs::metadata(&src).unwrap();
        let dst = tmp.path().join("copy.json");

        let file = copy_small_file(&src, &dst).unwrap();
        finish_file(&file, &meta, &dst).unwrap();
        drop(file);
        assert_eq!(fs::read_to_string(&dst).unwrap(), "{\"name\":\"n17\"}");
        assert_eq!(fs::metadata(&dst).unwrap().modified().unwrap(), old);

        // Never over an existing file.
        assert!(matches!(
            copy_small_file(&src, &dst),
            Err(CloneError::Failed(_))
        ));
    }

    #[test]
    fn a_failure_mid_walk_stops_it_and_is_reported() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("a");
        many_files(&src);
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let fails_later = |from: &Path, to: &Path, m: &fs::Metadata| {
            if calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed) == 100 {
                return Err(CloneError::Failed("disk full".into()));
            }
            copy_file(from, to, m)
        };
        assert_eq!(
            walk_clone(&src, &tmp.path().join("b"), &fails_later),
            Err(CloneError::Failed("disk full".into()))
        );
        assert!(calls.into_inner() < 800, "the other threads stopped early");
    }

    #[test]
    fn no_cow_override_needs_e2e_mode() {
        assert!(parse_no_cow_override(Some("1"), Some("1")));
        assert!(!parse_no_cow_override(None, Some("1")));
        assert!(!parse_no_cow_override(Some("1"), Some("0")));
        assert!(!parse_no_cow_override(Some("1"), None));
    }
}
