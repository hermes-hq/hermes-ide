//! A folder only this user can enter, verified rather than assumed.
//!
//! The socket's folders live under a root other users can write to (`/tmp`
//! when nothing better exists), so every component Hermes owns is created
//! with mode 0700 and then checked with `lstat`: a real folder (never a
//! symlink), owned by this uid, with no group or other bits. Anything else
//! is refused, because a folder another user planted could point the app
//! at a fake host that would receive the token, the session's environment
//! and every keystroke.

use std::io;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::Path;

/// Creates `dir` (mode 0700) if it is missing and refuses to use it unless
/// it is a plain folder owned by this user that nobody else can enter.
/// Only `dir` itself is checked: call it for every component you own,
/// parent first.
pub fn ensure_private_dir(dir: &Path) -> io::Result<()> {
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(e) => {
            return Err(io::Error::new(
                e.kind(),
                format!("create {}: {e}", dir.display()),
            ))
        }
    }
    let my_uid = unsafe { libc::getuid() };
    let mut meta = std::fs::symlink_metadata(dir)
        .map_err(|e| io::Error::new(e.kind(), format!("stat {}: {e}", dir.display())))?;
    if meta.file_type().is_symlink() {
        return Err(refused(dir, "it is a symlink"));
    }
    if !meta.is_dir() {
        return Err(refused(dir, "it is not a folder"));
    }
    if meta.uid() != my_uid {
        return Err(refused(
            dir,
            &format!("it belongs to uid {}, not {my_uid}", meta.uid()),
        ));
    }
    if meta.mode() & 0o077 != 0 {
        // Ours but too open (an older build, or the umask): tighten it and
        // look again, so a failed chmod cannot pass.
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| io::Error::new(e.kind(), format!("chmod {}: {e}", dir.display())))?;
        meta = std::fs::symlink_metadata(dir)?;
        if meta.file_type().is_symlink() || meta.uid() != my_uid || meta.mode() & 0o077 != 0 {
            return Err(refused(dir, "it stayed open to other users"));
        }
    }
    Ok(())
}

fn refused(dir: &Path, why: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        format!("refusing to use {}: {why}", dir.display()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mode_of(p: &Path) -> u32 {
        std::fs::symlink_metadata(p).unwrap().mode() & 0o777
    }

    #[test]
    fn creates_a_user_only_folder_and_tightens_an_open_one() {
        let tmp = tempfile::tempdir().unwrap();
        let fresh = tmp.path().join("fresh");
        ensure_private_dir(&fresh).unwrap();
        assert_eq!(mode_of(&fresh), 0o700);
        // Again: fine, unchanged.
        ensure_private_dir(&fresh).unwrap();

        let open = tmp.path().join("open");
        std::fs::create_dir(&open).unwrap();
        std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o755)).unwrap();
        ensure_private_dir(&open).unwrap();
        assert_eq!(mode_of(&open), 0o700, "an open folder of ours is tightened");
    }

    #[test]
    fn refuses_a_symlink_a_file_and_another_users_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("elsewhere");
        std::fs::create_dir(&target).unwrap();
        let link = tmp.path().join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let err = ensure_private_dir(&link).unwrap_err();
        assert!(err.to_string().contains("symlink"), "{err}");
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);

        let file = tmp.path().join("file");
        std::fs::write(&file, "x").unwrap();
        let err = ensure_private_dir(&file).unwrap_err();
        assert!(err.to_string().contains("not a folder"), "{err}");

        // `/` belongs to root: another uid unless the tests run as root.
        if unsafe { libc::getuid() } != 0 {
            let err = ensure_private_dir(Path::new("/")).unwrap_err();
            assert!(err.to_string().contains("belongs to uid 0"), "{err}");
        }
    }
}
