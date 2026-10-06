//! `hermes-pty-host --dir <folder> --socket <path>`
//!
//! Started by Hermes (from a versioned copy under its app data, never from
//! the install folder) when the first session needs it. Reads the shared
//! token from `<folder>/token`, listens on the socket, and exits on its own
//! once it has no sessions. `--version` prints the host version.

#[cfg(unix)]
fn main() {
    use std::path::PathBuf;
    use std::time::Duration;

    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version") {
        println!("hermes-pty-host {}", hermes_pty_host::HOST_VERSION);
        return;
    }
    let mut dir: Option<PathBuf> = None;
    let mut socket: Option<PathBuf> = None;
    let mut ring_bytes: Option<usize> = None;
    let mut empty_exit_ms: Option<u64> = None;
    let mut startup_grace_ms: Option<u64> = None;
    let mut exited_keep_ms: Option<u64> = None;
    let mut i = 1;
    while i < args.len() {
        let value = || args.get(i + 1).cloned();
        match args[i].as_str() {
            "--dir" => dir = value().map(PathBuf::from),
            "--socket" => socket = value().map(PathBuf::from),
            "--ring-bytes" => ring_bytes = value().and_then(|v| v.parse().ok()),
            "--empty-exit-ms" => empty_exit_ms = value().and_then(|v| v.parse().ok()),
            "--startup-grace-ms" => startup_grace_ms = value().and_then(|v| v.parse().ok()),
            "--exited-keep-ms" => exited_keep_ms = value().and_then(|v| v.parse().ok()),
            other => {
                eprintln!("hermes-pty-host: unknown argument {other}");
                std::process::exit(2);
            }
        }
        i += 2;
    }
    let (Some(dir), Some(socket)) = (dir, socket) else {
        eprintln!("usage: hermes-pty-host --dir <folder> --socket <path>");
        std::process::exit(2);
    };
    let token = match std::fs::read_to_string(dir.join("token")) {
        Ok(t) if !t.trim().is_empty() => t.trim().to_string(),
        _ => {
            eprintln!("hermes-pty-host: no token in {}", dir.display());
            std::process::exit(2);
        }
    };
    // Room for the shells and agents it starts: launchd gives a soft limit
    // of 256 open files, which some agent CLIs cannot start under.
    hermes_pty_host::fdlimit::raise_open_files_limit();
    // Own session: the app's terminal or death must never take the host
    // with it. Fails only when this process already leads a group, which is
    // harmless.
    unsafe {
        libc::setsid();
    }
    let mut cfg = hermes_pty_host::server::Config::new(dir, socket, token);
    if let Some(n) = ring_bytes {
        cfg.ring_bytes = n.max(4096);
    }
    if let Some(ms) = empty_exit_ms {
        cfg.empty_exit_after = Duration::from_millis(ms);
    }
    if let Some(ms) = startup_grace_ms {
        cfg.startup_grace = Duration::from_millis(ms);
    }
    if let Some(ms) = exited_keep_ms {
        cfg.exited_keep = Duration::from_millis(ms);
    }
    if let Err(e) = hermes_pty_host::server::run(cfg) {
        eprintln!("hermes-pty-host: {e}");
        std::process::exit(1);
    }
}

#[cfg(not(unix))]
fn main() {
    if std::env::args().any(|a| a == "--version") {
        println!("hermes-pty-host {}", hermes_pty_host::HOST_VERSION);
        return;
    }
    eprintln!("hermes-pty-host: not supported on this platform yet");
    std::process::exit(2);
}
