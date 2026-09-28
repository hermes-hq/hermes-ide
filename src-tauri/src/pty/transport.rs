//! Where a session's terminal lives: in this process (`InProcessPty`, the
//! way it always was) or in the background session host (`HostedPty`, the
//! `sessionHost` feature flag), which keeps the terminal and its program
//! alive while the app is closed. Everything above this seam — the output
//! analyzer, the frontend events, the commands — reads and writes the same
//! bytes either way.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{self, Read, Write};

pub trait PtyTransport: Send {
    /// The terminal's output. Ends (`Ok(0)`) when the program ends.
    fn take_reader(&mut self) -> io::Result<Box<dyn Read + Send>>;
    /// Input to the program.
    fn take_writer(&mut self) -> io::Result<Box<dyn Write + Send>>;
    fn resize(&self, rows: u16, cols: u16) -> io::Result<()>;
    /// Ends the program (hang-up, then force).
    fn kill(&mut self) -> io::Result<()>;
    /// Reaps the program after `kill`; may block briefly.
    fn wait(&mut self);
    /// The pid of the program the terminal was opened for (the shell).
    fn pid(&self) -> Option<u32>;
    /// Whether `shell_pid`'s process group owns the terminal's foreground,
    /// when the terminal can say (`None` when it cannot).
    fn shell_owns_terminal(&self, shell_pid: u32) -> Option<bool>;
    /// The terminal survives this process (it lives in the session host).
    fn hosted(&self) -> bool;
    /// Leaves a hosted program running and drops the connection to it.
    fn detach(&mut self) {}
}

/// A PTY opened and owned by this process.
pub struct InProcessPty {
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send>,
}

impl InProcessPty {
    /// Opens a PTY of `size` and starts `cmd` in it.
    pub fn spawn(cmd: CommandBuilder, size: PtySize) -> Result<Self, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(size)
            .map_err(|e| format!("Failed to open PTY: {}", e))?;
        // Workaround: portable-pty's openpty() does not apply the initial
        // window size on macOS — get_size() returns (0, 0) right after
        // creation. Explicitly resize to ensure the PTY starts with the
        // correct dimensions.
        let _ = pair.master.resize(size);

        // On macOS, portable-pty's spawn_command() uses fork() + pre_exec
        // which crashes in multi-threaded processes ("multi-threaded process
        // forked"). Use posix_spawn() instead which atomically creates the
        // child process. See issue #31 and issue-31-investigation.md.
        #[cfg(target_os = "macos")]
        let child: Box<dyn Child + Send> = {
            let tty_path = pair
                .master
                .tty_name()
                .ok_or_else(|| "Failed to get PTY device path for posix_spawn".to_string())?;
            // Drop the slave end — the child opens the TTY by path via
            // posix_spawn file actions. CTT assignment is handled by the
            // --pty-setup trampoline.
            drop(pair.slave);
            crate::pty::spawn::posix_spawn_in_pty(&cmd, &tty_path)
                .map_err(|e| format!("Failed to spawn shell: {}", e))?
        };

        #[cfg(not(target_os = "macos"))]
        let child: Box<dyn Child + Send> = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell: {}", e))?;

        Ok(Self {
            master: pair.master,
            child,
        })
    }
}

impl PtyTransport for InProcessPty {
    fn take_reader(&mut self) -> io::Result<Box<dyn Read + Send>> {
        self.master
            .try_clone_reader()
            .map_err(|e| io::Error::other(format!("Failed to clone reader: {}", e)))
    }

    fn take_writer(&mut self) -> io::Result<Box<dyn Write + Send>> {
        self.master
            .take_writer()
            .map_err(|e| io::Error::other(format!("Failed to get PTY writer: {}", e)))
    }

    fn resize(&self, rows: u16, cols: u16) -> io::Result<()> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| io::Error::other(format!("Resize failed: {}", e)))
    }

    fn kill(&mut self) -> io::Result<()> {
        self.child.kill()
    }

    fn wait(&mut self) {
        let _ = self.child.wait();
    }

    fn pid(&self) -> Option<u32> {
        self.child.process_id()
    }

    fn shell_owns_terminal(&self, shell_pid: u32) -> Option<bool> {
        #[cfg(unix)]
        {
            let foreground = self.master.process_group_leader()?;
            let shell_pgid = unsafe { libc::getpgid(shell_pid as i32) };
            if shell_pgid <= 0 {
                return None;
            }
            Some(foreground == shell_pgid)
        }
        #[cfg(not(unix))]
        {
            let _ = shell_pid;
            None
        }
    }

    fn hosted(&self) -> bool {
        false
    }
}

/// A PTY owned by the session host (macOS and Linux). The program keeps
/// running when this process ends; the host replays its output on the next
/// attach.
#[cfg(unix)]
pub struct HostedPty {
    attached: hermes_pty_host::client::Attached,
    /// The program had already ended when the app attached.
    pub ended_before_attach: Option<Option<i32>>,
    /// Bytes the host replayed at the start of the stream.
    pub replayed_bytes: u64,
}

#[cfg(unix)]
impl HostedPty {
    pub fn new(attached: hermes_pty_host::client::Attached) -> Self {
        let ended_before_attach = if attached.alive {
            None
        } else {
            Some(attached.exit_code)
        };
        let replayed_bytes = attached.replay_bytes;
        Self {
            attached,
            ended_before_attach,
            replayed_bytes,
        }
    }
}

#[cfg(unix)]
impl PtyTransport for HostedPty {
    fn take_reader(&mut self) -> io::Result<Box<dyn Read + Send>> {
        self.attached
            .take_reader()
            .ok_or_else(|| io::Error::other("the host stream was already taken"))
    }

    fn take_writer(&mut self) -> io::Result<Box<dyn Write + Send>> {
        Ok(self.attached.writer())
    }

    fn resize(&self, rows: u16, cols: u16) -> io::Result<()> {
        self.attached.resize(rows, cols)
    }

    fn kill(&mut self) -> io::Result<()> {
        self.attached.kill()
    }

    fn wait(&mut self) {}

    fn pid(&self) -> Option<u32> {
        (self.attached.pid > 0).then_some(self.attached.pid)
    }

    fn shell_owns_terminal(&self, _shell_pid: u32) -> Option<bool> {
        // The master lives in the host; the process table answers instead.
        None
    }

    fn hosted(&self) -> bool {
        true
    }

    fn detach(&mut self) {
        self.attached.detach();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real PTY in this process: the bytes go both ways, the size is what
    /// was asked for, and kill ends the stream.
    #[cfg(unix)]
    #[test]
    fn in_process_pty_round_trips_bytes_and_reports_its_size() {
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "stty size; cat"]);
        cmd.env("PATH", "/usr/bin:/bin");
        let size = PtySize {
            rows: 31,
            cols: 97,
            pixel_width: 0,
            pixel_height: 0,
        };
        let mut pty = match InProcessPty::spawn(cmd, size) {
            Ok(p) => p,
            // The macOS trampoline helper is not built in every test run.
            Err(e) if cfg!(target_os = "macos") => {
                eprintln!("skipping: {e}");
                return;
            }
            Err(e) => panic!("{e}"),
        };
        assert!(!pty.hosted());
        assert!(pty.pid().is_some());
        let mut reader = pty.take_reader().unwrap();
        let mut writer = pty.take_writer().unwrap();
        writer.write_all(b"ping\n").unwrap();
        let mut text = String::new();
        let mut buf = [0u8; 1024];
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !(text.contains("31 97") && text.matches("ping").count() >= 2) {
            assert!(std::time::Instant::now() < deadline, "got: {text}");
            let n = reader.read(&mut buf).unwrap();
            assert!(n > 0, "stream ended early: {text}");
            text.push_str(&String::from_utf8_lossy(&buf[..n]));
        }
        pty.kill().unwrap();
        pty.wait();
    }
}
