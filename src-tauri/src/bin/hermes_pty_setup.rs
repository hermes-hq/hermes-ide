//! Tiny trampoline that sets the controlling terminal and execs the real command.
//!
//! On macOS, `posix_spawn` file actions don't trigger the kernel's automatic
//! controlling terminal (CTT) assignment, which breaks `/dev/tty` access (needed
//! by sudo, ssh, gpg, etc.).  This binary is spawned by `posix_spawn_in_pty()`
//! as a trampoline: it calls `ioctl(TIOCSCTTY)` on stdin (the PTY slave) to
//! explicitly assign the controlling terminal, then execs the real shell.
//!
//! See issue #214.

fn main() -> ! {
    // Set the controlling terminal to stdin (the PTY slave fd set up by posix_spawn)
    #[cfg(target_os = "macos")]
    unsafe {
        libc::ioctl(0, libc::TIOCSCTTY as libc::c_ulong, 0);
    }

    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("hermes-pty-setup: no command specified");
        std::process::exit(1);
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = std::process::Command::new(&args[0]).args(&args[1..]).exec();
        eprintln!("hermes-pty-setup: exec failed: {}", err);
        std::process::exit(1);
    }

    #[cfg(not(unix))]
    {
        eprintln!("hermes-pty-setup: only supported on Unix");
        std::process::exit(1);
    }
}
