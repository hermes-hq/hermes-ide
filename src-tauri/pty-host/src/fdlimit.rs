//! The open-files limit terminals hand to their programs.
//!
//! macOS gives an app started from the Dock or Finder a soft limit of 256
//! open files (the hard limit is unlimited), and every shell and agent a
//! terminal starts inherits it. Tools built on Bun or Node can fail at
//! startup under it, or later when they watch many files. Terminals such as
//! iTerm and editors such as VS Code raise their own soft limit at startup so
//! the programs they start have room; Hermes does the same, in the app and in
//! the session host, before either starts anything.

/// The soft limit Hermes asks for at most: enough for any agent, small
/// enough for programs that walk every possible descriptor (or use
/// `select`) to stay fast.
pub const SOFT_LIMIT_CAP: u64 = 10_240;

/// The soft limit to set, or None to leave it: raised towards
/// [`SOFT_LIMIT_CAP`], never past the hard limit or the system's per-process
/// maximum (`per_process_max`, macOS's `kern.maxfilesperproc`), and never
/// lowered.
pub fn target_soft_limit(soft: u64, hard: u64, per_process_max: Option<u64>) -> Option<u64> {
    let mut target = SOFT_LIMIT_CAP.min(hard);
    if let Some(max) = per_process_max {
        target = target.min(max);
    }
    (target > soft).then_some(target)
}

/// Raise this process's soft open-files limit (see the module doc). Returns
/// the (old, new) soft limit when it changed. Children started afterwards
/// inherit the new limit.
#[cfg(unix)]
#[allow(clippy::unnecessary_cast)] // rlim_t is not u64 on every target
pub fn raise_open_files_limit() -> Option<(u64, u64)> {
    let mut lim = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: getrlimit only writes the struct it is given.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) } != 0 {
        return None;
    }
    let soft = lim.rlim_cur as u64;
    let hard = if lim.rlim_max == libc::RLIM_INFINITY {
        u64::MAX
    } else {
        lim.rlim_max as u64
    };
    let target = target_soft_limit(soft, hard, per_process_max())?;
    lim.rlim_cur = target as libc::rlim_t;
    // SAFETY: setrlimit only reads the struct it is given.
    if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &lim) } != 0 {
        return None;
    }
    Some((soft, target))
}

#[cfg(target_os = "macos")]
fn per_process_max() -> Option<u64> {
    let mut value: libc::c_int = 0;
    let mut size = std::mem::size_of::<libc::c_int>();
    let name = c"kern.maxfilesperproc";
    // SAFETY: a NUL-terminated name, and an int-sized buffer with its size.
    let rc = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            (&mut value as *mut libc::c_int).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    (rc == 0 && value > 0).then_some(value as u64)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn per_process_max() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_macos_gui_default_is_raised_to_the_cap() {
        // launchd: soft 256, hard unlimited, kern.maxfilesperproc 245760.
        assert_eq!(
            target_soft_limit(256, u64::MAX, Some(245_760)),
            Some(10_240)
        );
    }

    #[test]
    fn never_past_the_hard_limit_or_the_per_process_maximum() {
        assert_eq!(target_soft_limit(256, 4096, None), Some(4096));
        assert_eq!(target_soft_limit(256, u64::MAX, Some(2048)), Some(2048));
        // Linux's usual soft 1024 / hard 524288.
        assert_eq!(target_soft_limit(1024, 524_288, None), Some(10_240));
    }

    #[test]
    fn a_limit_already_high_enough_is_left_alone() {
        assert_eq!(target_soft_limit(10_240, u64::MAX, None), None);
        assert_eq!(target_soft_limit(1_048_576, u64::MAX, None), None);
        assert_eq!(
            target_soft_limit(256, 256, None),
            None,
            "the hard limit is the soft one"
        );
    }

    #[cfg(unix)]
    #[test]
    #[allow(clippy::unnecessary_cast)]
    fn raising_leaves_at_least_the_cap_or_the_hard_limit() {
        raise_open_files_limit();
        let mut lim = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) }, 0);
        let hard = if lim.rlim_max == libc::RLIM_INFINITY {
            u64::MAX
        } else {
            lim.rlim_max as u64
        };
        let floor = SOFT_LIMIT_CAP
            .min(hard)
            .min(per_process_max().unwrap_or(u64::MAX));
        assert!(
            lim.rlim_cur as u64 >= floor,
            "soft {} < {floor}",
            lim.rlim_cur
        );
    }
}
