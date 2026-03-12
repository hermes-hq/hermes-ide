//! macOS-safe PTY child spawning using posix_spawn.
//!
//! On macOS, portable-pty's `SlavePty::spawn_command` uses a `pre_exec` closure
//! which forces Rust's stdlib to use `fork()` + `exec()` instead of the safer
//! `posix_spawn()`. Calling `fork()` in a multi-threaded process (Tokio runtime,
//! Tauri webview, PTY reader threads) crashes on macOS with:
//!
//!   "multi-threaded process forked" / EXC_CRASH (SIGABRT)
//!
//! This module provides `posix_spawn_in_pty()` which uses `posix_spawnp()` with
//! macOS-specific attributes (`POSIX_SPAWN_SETSID`, `POSIX_SPAWN_CLOEXEC_DEFAULT`)
//! to atomically create the child process without the dangerous fork+exec
//! intermediate state. See issue #31.

#[cfg(target_os = "macos")]
mod macos {
    use portable_pty::{Child, ChildKiller, CommandBuilder, ExitStatus};
    use std::ffi::{CStr, CString};
    use std::io;
    use std::path::Path;

    // macOS-specific posix_spawn flags not available in the libc crate.
    // POSIX_SPAWN_SETSID: create a new session (equivalent to setsid() in pre_exec).
    // Available since macOS 10.12 Sierra.
    const POSIX_SPAWN_SETSID: libc::c_short = 0x0400;
    // POSIX_SPAWN_CLOEXEC_DEFAULT: close all file descriptors in the child except
    // those explicitly set up via file actions. Replaces close_random_fds().
    const POSIX_SPAWN_CLOEXEC_DEFAULT: libc::c_short = 0x4000;

    extern "C" {
        // posix_spawn_file_actions_addchdir_np: change the child's working directory.
        // Available since macOS 10.15 Catalina. Non-POSIX Apple extension.
        fn posix_spawn_file_actions_addchdir_np(
            file_actions: *mut libc::posix_spawn_file_actions_t,
            path: *const libc::c_char,
        ) -> libc::c_int;
    }

    /// A child process spawned via posix_spawn, implementing portable_pty's Child trait.
    #[derive(Debug)]
    pub struct PosixSpawnChild {
        pid: libc::pid_t,
        exited: bool,
        exit_status: Option<ExitStatus>,
    }

    impl Child for PosixSpawnChild {
        fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            if self.exited {
                return Ok(self.exit_status.clone());
            }
            let mut status: libc::c_int = 0;
            let result = unsafe { libc::waitpid(self.pid, &mut status, libc::WNOHANG) };
            if result == 0 {
                Ok(None)
            } else if result == self.pid {
                self.exited = true;
                let es = decode_exit_status(status);
                self.exit_status = Some(es.clone());
                Ok(Some(es))
            } else {
                Err(io::Error::last_os_error())
            }
        }

        fn wait(&mut self) -> io::Result<ExitStatus> {
            if self.exited {
                return Ok(self
                    .exit_status
                    .clone()
                    .unwrap_or(ExitStatus::with_exit_code(1)));
            }
            let mut status: libc::c_int = 0;
            let result = unsafe { libc::waitpid(self.pid, &mut status, 0) };
            if result > 0 {
                self.exited = true;
                let es = decode_exit_status(status);
                self.exit_status = Some(es.clone());
                Ok(es)
            } else {
                Err(io::Error::last_os_error())
            }
        }

        fn process_id(&self) -> Option<u32> {
            Some(self.pid as u32)
        }
    }

    impl ChildKiller for PosixSpawnChild {
        fn kill(&mut self) -> io::Result<()> {
            if self.exited {
                return Ok(());
            }
            // Send SIGHUP first, matching portable-pty's behavior
            let result = unsafe { libc::kill(self.pid, libc::SIGHUP) };
            if result != 0 {
                return Err(io::Error::last_os_error());
            }
            // Grace period for SIGHUP handling
            for attempt in 0..5 {
                if attempt > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                if let Ok(Some(_)) = self.try_wait() {
                    return Ok(());
                }
            }
            // Force kill if still alive
            unsafe {
                libc::kill(self.pid, libc::SIGKILL);
            }
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(PosixSpawnKiller { pid: self.pid })
        }
    }

    #[derive(Debug)]
    struct PosixSpawnKiller {
        pid: libc::pid_t,
    }

    impl ChildKiller for PosixSpawnKiller {
        fn kill(&mut self) -> io::Result<()> {
            let result = unsafe { libc::kill(self.pid, libc::SIGHUP) };
            if result != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(PosixSpawnKiller { pid: self.pid })
        }
    }

    fn decode_exit_status(status: libc::c_int) -> ExitStatus {
        if libc::WIFEXITED(status) {
            ExitStatus::with_exit_code(libc::WEXITSTATUS(status) as u32)
        } else if libc::WIFSIGNALED(status) {
            let sig = libc::WTERMSIG(status);
            let signame = unsafe { libc::strsignal(sig) };
            let signal = if signame.is_null() {
                format!("Signal {}", sig)
            } else {
                let cstr = unsafe { CStr::from_ptr(signame) };
                cstr.to_string_lossy().to_string()
            };
            ExitStatus::with_signal(&signal)
        } else {
            ExitStatus::with_exit_code(1)
        }
    }

    /// RAII guard for posix_spawn attributes and file actions cleanup.
    struct SpawnResources {
        attrs: libc::posix_spawnattr_t,
        file_actions: libc::posix_spawn_file_actions_t,
    }

    impl Drop for SpawnResources {
        fn drop(&mut self) {
            unsafe {
                libc::posix_spawnattr_destroy(&mut self.attrs);
                libc::posix_spawn_file_actions_destroy(&mut self.file_actions);
            }
        }
    }

    /// Spawn a child process in a PTY using posix_spawn (macOS-safe).
    ///
    /// `tty_path` is the path to the slave PTY device (e.g., `/dev/ttys042`),
    /// obtained from `MasterPty::tty_name()`.
    ///
    /// The child process:
    /// - Becomes a session leader (POSIX_SPAWN_SETSID)
    /// - Has the PTY set as its controlling terminal (auto-assigned on macOS
    ///   when a session leader opens a terminal device)
    /// - Has all inherited file descriptors closed (POSIX_SPAWN_CLOEXEC_DEFAULT)
    /// - Has all signal handlers reset to defaults
    /// - Has an empty signal mask
    pub fn posix_spawn_in_pty(
        cmd: &CommandBuilder,
        tty_path: &Path,
    ) -> anyhow::Result<Box<dyn Child + Send + Sync>> {
        let argv = cmd.get_argv();
        if argv.is_empty() {
            anyhow::bail!("empty command");
        }

        // Build argv as null-terminated CString array
        let argv_cstrs: Vec<CString> = argv
            .iter()
            .map(|arg| {
                let s = arg
                    .to_str()
                    .ok_or_else(|| anyhow::anyhow!("argument {:?} is not valid UTF-8", arg))?;
                CString::new(s).map_err(|e| anyhow::anyhow!("invalid argument: {}", e))
            })
            .collect::<anyhow::Result<Vec<_>>>()?;

        let mut argv_ptrs: Vec<*mut libc::c_char> = argv_cstrs
            .iter()
            .map(|s| s.as_ptr() as *mut libc::c_char)
            .collect();
        argv_ptrs.push(std::ptr::null_mut());

        // Build envp as null-terminated "KEY=VALUE" CString array
        let env_cstrs: Vec<CString> = cmd
            .iter_full_env_as_str()
            .map(|(k, v)| {
                CString::new(format!("{}={}", k, v))
                    .map_err(|e| anyhow::anyhow!("invalid env var: {}", e))
            })
            .collect::<anyhow::Result<Vec<_>>>()?;

        let mut envp_ptrs: Vec<*mut libc::c_char> = env_cstrs
            .iter()
            .map(|s| s.as_ptr() as *mut libc::c_char)
            .collect();
        envp_ptrs.push(std::ptr::null_mut());

        // Initialize spawn attributes and file actions with RAII cleanup
        let mut res = SpawnResources {
            attrs: unsafe { std::mem::zeroed() },
            file_actions: unsafe { std::mem::zeroed() },
        };

        check_spawn_err(
            unsafe { libc::posix_spawnattr_init(&mut res.attrs) },
            "posix_spawnattr_init",
        )?;
        check_spawn_err(
            unsafe { libc::posix_spawn_file_actions_init(&mut res.file_actions) },
            "posix_spawn_file_actions_init",
        )?;

        // Flags:
        // - POSIX_SPAWN_SETSID: new session (replaces setsid() in pre_exec)
        // - POSIX_SPAWN_CLOEXEC_DEFAULT: close all fds (replaces close_random_fds())
        // - POSIX_SPAWN_SETSIGDEF: reset signal handlers to SIG_DFL
        // - POSIX_SPAWN_SETSIGMASK: set signal mask
        let flags: libc::c_short = POSIX_SPAWN_SETSID
            | POSIX_SPAWN_CLOEXEC_DEFAULT
            | libc::POSIX_SPAWN_SETSIGDEF as libc::c_short
            | libc::POSIX_SPAWN_SETSIGMASK as libc::c_short;

        check_spawn_err(
            unsafe { libc::posix_spawnattr_setflags(&mut res.attrs, flags) },
            "posix_spawnattr_setflags",
        )?;

        // Reset all catchable signals to default disposition
        let mut all_signals: libc::sigset_t = unsafe { std::mem::zeroed() };
        unsafe { libc::sigfillset(&mut all_signals) };
        check_spawn_err(
            unsafe { libc::posix_spawnattr_setsigdefault(&mut res.attrs, &all_signals) },
            "posix_spawnattr_setsigdefault",
        )?;

        // Clear signal mask
        let mut empty_signals: libc::sigset_t = unsafe { std::mem::zeroed() };
        unsafe { libc::sigemptyset(&mut empty_signals) };
        check_spawn_err(
            unsafe { libc::posix_spawnattr_setsigmask(&mut res.attrs, &empty_signals) },
            "posix_spawnattr_setsigmask",
        )?;

        // File actions: open slave TTY as stdin, dup to stdout/stderr.
        // Since the child is a session leader (POSIX_SPAWN_SETSID) with no
        // controlling terminal, opening the TTY device automatically makes it
        // the controlling terminal on macOS/BSD.
        let tty_cstr = CString::new(
            tty_path
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("TTY path is not valid UTF-8"))?,
        )?;

        check_spawn_err(
            unsafe {
                libc::posix_spawn_file_actions_addopen(
                    &mut res.file_actions,
                    0, // fd 0 = stdin
                    tty_cstr.as_ptr(),
                    libc::O_RDWR,
                    0,
                )
            },
            "addopen(stdin)",
        )?;

        // stdout = dup2(stdin)
        check_spawn_err(
            unsafe { libc::posix_spawn_file_actions_adddup2(&mut res.file_actions, 0, 1) },
            "adddup2(stdout)",
        )?;

        // stderr = dup2(stdin)
        check_spawn_err(
            unsafe { libc::posix_spawn_file_actions_adddup2(&mut res.file_actions, 0, 2) },
            "adddup2(stderr)",
        )?;

        // Set working directory (macOS 10.15+ non-POSIX extension)
        if let Some(cwd) = cmd.get_cwd() {
            let cwd_cstr = CString::new(
                cwd.to_str()
                    .ok_or_else(|| anyhow::anyhow!("CWD is not valid UTF-8"))?,
            )?;
            check_spawn_err(
                unsafe {
                    posix_spawn_file_actions_addchdir_np(&mut res.file_actions, cwd_cstr.as_ptr())
                },
                "addchdir_np",
            )?;
        }

        // Resolve and spawn using posix_spawnp (searches PATH)
        let program_cstr = CString::new(
            argv[0]
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("program name is not valid UTF-8"))?,
        )?;

        let mut pid: libc::pid_t = 0;
        let ret = unsafe {
            libc::posix_spawnp(
                &mut pid,
                program_cstr.as_ptr(),
                &res.file_actions,
                &res.attrs,
                argv_ptrs.as_ptr(),
                envp_ptrs.as_ptr(),
            )
        };

        // SpawnResources dropped here via RAII, cleaning up attrs and file_actions

        if ret != 0 {
            anyhow::bail!(
                "posix_spawnp failed to spawn {:?}: {}",
                argv[0],
                io::Error::from_raw_os_error(ret)
            );
        }

        log::info!(
            "Spawned PTY child via posix_spawn (pid={}, tty={:?})",
            pid,
            tty_path
        );

        Ok(Box::new(PosixSpawnChild {
            pid,
            exited: false,
            exit_status: None,
        }))
    }

    fn check_spawn_err(ret: libc::c_int, context: &str) -> anyhow::Result<()> {
        if ret != 0 {
            anyhow::bail!("{} failed: {}", context, io::Error::from_raw_os_error(ret));
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub use macos::posix_spawn_in_pty;

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    use super::*;

    /// Read all available output from a PTY master reader in a background thread.
    /// Must be called *before* the child exits, since the master returns EIO once
    /// the slave side is fully closed — at that point no data can be retrieved.
    #[cfg(target_os = "macos")]
    fn read_pty_output(reader: Box<dyn std::io::Read + Send>) -> std::thread::JoinHandle<String> {
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 4096];
            let mut output = String::new();
            loop {
                match std::io::Read::read(&mut reader, &mut buf) {
                    Ok(0) => break,
                    Ok(n) => output.push_str(&String::from_utf8_lossy(&buf[..n])),
                    Err(_) => break, // EIO when slave closes — expected
                }
            }
            output
        })
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn posix_spawn_runs_simple_command() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize, PtySystem};

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let tty_path = pair
            .master
            .tty_name()
            .expect("tty_name should be available on macOS");

        let mut cmd = CommandBuilder::new("echo");
        cmd.arg("hello_posix_spawn");

        let mut child =
            posix_spawn_in_pty(&cmd, &tty_path).expect("posix_spawn_in_pty should succeed");

        // Start reading *before* the child exits to avoid EIO race
        let reader = pair.master.try_clone_reader().expect("reader");
        let output_handle = read_pty_output(reader);

        drop(pair.slave);

        let status = child.wait().expect("wait should succeed");
        assert!(status.success(), "echo should exit 0");
        assert!(child.process_id().is_some());

        let output = output_handle.join().expect("reader thread");
        assert!(
            output.contains("hello_posix_spawn"),
            "output should contain our string: {:?}",
            output
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn posix_spawn_sets_environment() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize, PtySystem};

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let tty_path = pair.master.tty_name().expect("tty_name");

        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg("echo $TEST_SPAWN_VAR");
        cmd.env("TEST_SPAWN_VAR", "spawn_works_42");

        let mut child = posix_spawn_in_pty(&cmd, &tty_path).expect("spawn");

        let reader = pair.master.try_clone_reader().expect("reader");
        let output_handle = read_pty_output(reader);

        drop(pair.slave);

        let status = child.wait().expect("wait");
        assert!(status.success());

        let output = output_handle.join().expect("reader thread");
        assert!(
            output.contains("spawn_works_42"),
            "env var should be set: {:?}",
            output
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn posix_spawn_sets_working_directory() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize, PtySystem};

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let tty_path = pair.master.tty_name().expect("tty_name");

        let mut cmd = CommandBuilder::new("pwd");
        cmd.cwd("/tmp");

        let mut child = posix_spawn_in_pty(&cmd, &tty_path).expect("spawn");

        let reader = pair.master.try_clone_reader().expect("reader");
        let output_handle = read_pty_output(reader);

        drop(pair.slave);

        let status = child.wait().expect("wait");
        assert!(status.success());

        let output = output_handle.join().expect("reader thread");
        // macOS resolves /tmp to /private/tmp
        assert!(
            output.contains("/tmp") || output.contains("/private/tmp"),
            "cwd should be /tmp: {:?}",
            output
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn posix_spawn_child_kill() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize, PtySystem};

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let tty_path = pair.master.tty_name().expect("tty_name");

        let mut cmd = CommandBuilder::new("sleep");
        cmd.arg("60");

        let mut child = posix_spawn_in_pty(&cmd, &tty_path).expect("spawn");
        drop(pair.slave);

        // Should be running
        let status = child.try_wait().expect("try_wait");
        assert!(status.is_none(), "child should still be running");

        // Kill it
        child.kill().expect("kill should succeed");

        // Should be done now
        let status = child.wait().expect("wait after kill");
        assert!(!status.success(), "killed process should not be success");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn posix_spawn_clone_killer() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize, PtySystem};

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let tty_path = pair.master.tty_name().expect("tty_name");

        let mut cmd = CommandBuilder::new("sleep");
        cmd.arg("60");

        let mut child = posix_spawn_in_pty(&cmd, &tty_path).expect("spawn");
        drop(pair.slave);

        // Clone the killer and use it from a different context
        let mut killer = child.clone_killer();
        killer.kill().expect("clone_killer kill should succeed");

        let status = child.wait().expect("wait after clone_killer kill");
        assert!(!status.success());
    }

    /// Definitive test: writing \x03 to PTY master generates SIGINT
    /// and interrupts the running process.
    #[cfg(target_os = "macos")]
    #[test]
    fn posix_spawn_ctrl_c_interrupts_sleep() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize, PtySystem};
        use std::io::Write;

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let tty_path = pair.master.tty_name().expect("tty_name");

        let mut cmd = CommandBuilder::new("sleep");
        cmd.arg("60");

        let mut child = posix_spawn_in_pty(&cmd, &tty_path).expect("spawn");

        // Get the writer BEFORE dropping slave
        let mut writer = pair.master.take_writer().expect("writer");

        // Start reader to drain output (prevents blocking)
        let reader = pair.master.try_clone_reader().expect("reader");
        let _output_handle = read_pty_output(reader);

        drop(pair.slave);

        // Verify sleep is running
        std::thread::sleep(std::time::Duration::from_millis(200));
        let status = child.try_wait().expect("try_wait");
        assert!(status.is_none(), "sleep should still be running");

        // Write \x03 (Ctrl+C) to PTY master — this should trigger SIGINT
        writer.write_all(b"\x03").expect("write \\x03");
        writer.flush().expect("flush");

        // Wait for sleep to be interrupted (with timeout)
        let start = std::time::Instant::now();
        loop {
            if let Ok(Some(status)) = child.try_wait() {
                // sleep was interrupted — it should NOT be a success exit
                assert!(
                    !status.success(),
                    "sleep should have been killed by SIGINT, got success"
                );
                return;
            }
            if start.elapsed() > std::time::Duration::from_secs(5) {
                panic!("FAIL: sleep was NOT interrupted by \\x03 within 5 seconds — SIGINT is NOT being generated by PTY line discipline");
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    /// Test that \x03 interrupts a shell running a long command.
    /// This more closely simulates the real-world scenario (shell → child process).
    #[cfg(target_os = "macos")]
    #[test]
    fn posix_spawn_ctrl_c_interrupts_shell_child() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize, PtySystem};
        use std::io::Write;

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let tty_path = pair.master.tty_name().expect("tty_name");

        // Spawn a shell that runs sleep
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        // Trap SIGINT in the shell to print a marker, then exit
        cmd.arg("trap 'echo INTERRUPTED; exit 130' INT; sleep 60");

        let mut child = posix_spawn_in_pty(&cmd, &tty_path).expect("spawn");

        let mut writer = pair.master.take_writer().expect("writer");
        let reader = pair.master.try_clone_reader().expect("reader");
        let output_handle = read_pty_output(reader);

        drop(pair.slave);

        // Let the shell start and set up the trap
        std::thread::sleep(std::time::Duration::from_millis(500));
        let status = child.try_wait().expect("try_wait");
        assert!(status.is_none(), "shell should still be running");

        // Write \x03 to interrupt
        writer.write_all(b"\x03").expect("write \\x03");
        writer.flush().expect("flush");

        // Wait for shell to exit
        let start = std::time::Instant::now();
        loop {
            if let Ok(Some(_status)) = child.try_wait() {
                let output = output_handle.join().expect("reader thread");
                assert!(
                    output.contains("INTERRUPTED"),
                    "shell trap should have printed INTERRUPTED, got: {:?}",
                    output
                );
                return;
            }
            if start.elapsed() > std::time::Duration::from_secs(5) {
                panic!("FAIL: shell child was NOT interrupted by \\x03 within 5 seconds");
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    /// Test direct SIGINT delivery via tcgetpgrp() + kill()
    /// This mimics what the app does: spawn shell, run command, send SIGINT
    #[cfg(target_os = "macos")]
    #[test]
    fn posix_spawn_direct_sigint_via_tcgetpgrp() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize, PtySystem};
        use std::io::Write;

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let tty_path = pair.master.tty_name().expect("tty_name");

        // Spawn exactly what the app does: env -u ... /bin/zsh -l
        let mut cmd = CommandBuilder::new("env");
        cmd.arg("-u");
        cmd.arg("CLAUDECODE");
        cmd.arg("-u");
        cmd.arg("CLAUDE_CODE");
        cmd.arg("/bin/zsh");
        cmd.arg("-l");

        let mut child = posix_spawn_in_pty(&cmd, &tty_path).expect("spawn");

        let mut writer = pair.master.take_writer().expect("writer");
        let reader = pair.master.try_clone_reader().expect("reader");
        let output_handle = read_pty_output(reader);

        drop(pair.slave);

        // Wait for shell to start
        std::thread::sleep(std::time::Duration::from_millis(500));

        // Run sleep in the shell
        writer.write_all(b"sleep 60\n").expect("write sleep cmd");
        writer.flush().expect("flush");

        // Wait for sleep to actually start
        std::thread::sleep(std::time::Duration::from_millis(500));

        // Now test: write \x03 to PTY master (standard approach)
        writer.write_all(b"\x03").expect("write \\x03");
        writer.flush().expect("flush \\x03");

        // Wait and check if sleep was interrupted
        std::thread::sleep(std::time::Duration::from_millis(500));

        // ALSO try direct SIGINT via tcgetpgrp + kill (our new approach)
        let tty_cstr = std::ffi::CString::new(tty_path.to_str().unwrap()).unwrap();
        unsafe {
            let fd = libc::open(tty_cstr.as_ptr(), libc::O_RDONLY | libc::O_NOCTTY);
            if fd >= 0 {
                let fgpg = libc::tcgetpgrp(fd);
                libc::close(fd);

                if fgpg > 0 {
                    libc::kill(-fgpg, libc::SIGINT);
                }
            }
        }

        // Now type 'echo CTRL_C_WORKED' and check the output
        std::thread::sleep(std::time::Duration::from_millis(500));
        writer.write_all(b"echo CTRL_C_WORKED\n").expect("write echo");
        writer.flush().expect("flush echo");

        // Wait for output
        std::thread::sleep(std::time::Duration::from_millis(500));

        // Exit the shell
        writer.write_all(b"exit\n").expect("write exit");
        writer.flush().expect("flush exit");

        let status = child.wait().expect("wait");
        let output = output_handle.join().expect("reader thread");

        assert!(
            output.contains("CTRL_C_WORKED"),
            "sleep should have been interrupted, allowing echo to run. Output: {:?}",
            output
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn posix_spawn_rejects_empty_command() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize, PtySystem};

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let tty_path = pair.master.tty_name().expect("tty_name");

        let cmd = CommandBuilder::new_default_prog();
        let result = posix_spawn_in_pty(&cmd, &tty_path);
        assert!(result.is_err(), "empty command should fail");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn posix_spawn_in_multithreaded_context() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize, PtySystem};
        use std::sync::{Arc, Mutex};

        // Simulate the multi-threaded environment that causes the fork crash.
        // Spawn several threads holding locks, then spawn a PTY child.
        let shared_lock = Arc::new(Mutex::new(0u64));
        let mut handles = vec![];

        for i in 0..4 {
            let lock = Arc::clone(&shared_lock);
            handles.push(std::thread::spawn(move || {
                for _ in 0..100 {
                    let mut val = lock.lock().unwrap();
                    *val += 1;
                    // Hold the lock briefly to create contention
                    std::thread::sleep(std::time::Duration::from_micros(100));
                    drop(val);
                }
                i
            }));
        }

        // While threads are running and contending on locks, spawn PTY children
        for _ in 0..3 {
            let pty_system = native_pty_system();
            let pair = pty_system
                .openpty(PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .expect("openpty");

            let tty_path = pair.master.tty_name().expect("tty_name");

            let mut cmd = CommandBuilder::new("echo");
            cmd.arg("thread_safe");

            let mut child = posix_spawn_in_pty(&cmd, &tty_path)
                .expect("posix_spawn should succeed even with multiple threads holding locks");

            let reader = pair.master.try_clone_reader().expect("reader");
            let output_handle = read_pty_output(reader);

            drop(pair.slave);

            let status = child.wait().expect("wait");
            assert!(status.success());

            let output = output_handle.join().expect("reader thread");
            assert!(output.contains("thread_safe"));
        }

        // Wait for background threads
        for h in handles {
            h.join().unwrap();
        }
    }
}
