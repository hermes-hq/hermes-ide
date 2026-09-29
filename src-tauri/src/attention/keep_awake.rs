//! Keep the machine awake while an agent works (F12).
//!
//! One hold for the whole app, taken when the first session starts working
//! and released when none is. Replaces the per-agent `caffeinate -i` prefix
//! (macOS only) with the OS's own mechanism on every platform:
//!
//!   macOS    `caffeinate -i -w <hermes pid>`: an idle-sleep assertion that
//!            also ends if Hermes dies (`pmset -g assertions` lists it).
//!   Linux    `systemd-inhibit --what=idle:sleep --mode=block` holding
//!            `tail --pid=<hermes pid>`, so it ends if Hermes dies
//!            (`systemd-inhibit --list` lists it). Outside the active
//!            desktop session logind only allows blocking idle, so a refused
//!            `idle:sleep` falls back to `--what=idle`.
//!   Windows  a power request (`PowerSetRequest(PowerRequestSystemRequired)`)
//!            with a reason (`powercfg /requests` lists it).
//!
//! When the mechanism is missing (no systemd) the hold is reported as
//! "none" and nothing else changes: keeping awake is a courtesy, never a
//! reason to fail.

use serde::Serialize;
use std::sync::Mutex;

/// Shown by the OS tools that list who keeps the machine awake (caffeinate
/// on macOS takes no reason).
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub const REASON: &str = "Hermes: an agent is working";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepAwakeStatus {
    pub active: bool,
    /// "caffeinate", "systemd-inhibit", "power-request" or "none".
    pub mechanism: String,
    /// The helper process holding it (macOS, Linux).
    pub pid: Option<u32>,
    /// What the hold blocks, where the OS lets that vary (Linux: "idle:sleep",
    /// or "idle" when logind refuses to block sleep).
    pub what: Option<String>,
    /// Why the last attempt could not hold the machine awake.
    pub error: Option<String>,
}

enum Hold {
    #[cfg(unix)]
    Process(std::process::Child),
    #[cfg(windows)]
    PowerRequest(isize),
}

struct State {
    hold: Option<Hold>,
    status: KeepAwakeStatus,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

fn inactive(mechanism: &str, error: Option<String>) -> KeepAwakeStatus {
    KeepAwakeStatus {
        active: false,
        mechanism: mechanism.to_string(),
        pid: None,
        what: None,
        error,
    }
}

/// Take (`true`) or release (`false`) the hold. Idempotent. Blocking for up
/// to a few hundred milliseconds on Linux (it waits to see the inhibitor
/// really started), so callers run it off the main thread.
pub fn set(active: bool) -> KeepAwakeStatus {
    let mut guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let state = guard.get_or_insert_with(|| State {
        hold: None,
        status: inactive("none", None),
    });
    if active == state.hold.is_some() {
        return state.status.clone();
    }
    if let Some(hold) = state.hold.take() {
        release(hold);
        state.status = inactive(&state.status.mechanism, None);
        log::info!("[keep-awake] released");
        return state.status.clone();
    }
    match acquire() {
        Ok((hold, status)) => {
            log::info!("[keep-awake] holding via {}", status.mechanism);
            state.hold = Some(hold);
            state.status = status;
        }
        Err((mechanism, error)) => {
            log::warn!("[keep-awake] not held ({mechanism}): {error}");
            state.status = inactive(mechanism, Some(error));
        }
    }
    state.status.clone()
}

/// The current hold (the test build's read-back; the unit tests).
#[cfg_attr(not(any(test, feature = "e2e")), allow(dead_code))]
pub fn status() -> KeepAwakeStatus {
    let guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .as_ref()
        .map(|s| s.status.clone())
        .unwrap_or_else(|| inactive("none", None))
}

#[cfg(target_os = "macos")]
fn acquire() -> Result<(Hold, KeepAwakeStatus), (&'static str, String)> {
    let pid = std::process::id().to_string();
    let child = std::process::Command::new("/usr/bin/caffeinate")
        .args(["-i", "-w", &pid])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| ("caffeinate", e.to_string()))?;
    let status = KeepAwakeStatus {
        active: true,
        mechanism: "caffeinate".into(),
        pid: Some(child.id()),
        what: None,
        error: None,
    };
    Ok((Hold::Process(child), status))
}

/// What the Linux hold blocks, strongest first. logind lets a process in the
/// active desktop session block sleep; one outside it (a service, an SSH
/// login, a CI runner) may only block idle, so that is the fallback.
#[cfg(all(unix, not(target_os = "macos")))]
const LINUX_WHAT: [&str; 2] = ["idle:sleep", "idle"];

#[cfg(all(unix, not(target_os = "macos")))]
fn acquire() -> Result<(Hold, KeepAwakeStatus), (&'static str, String)> {
    let mut errors = Vec::new();
    for what in LINUX_WHAT {
        match inhibit(what) {
            Ok(held) => {
                if !errors.is_empty() {
                    log::info!("[keep-awake] {}", errors.join("; "));
                }
                return Ok(held);
            }
            Err((mechanism, error)) if mechanism == "none" => return Err((mechanism, error)),
            Err((_, error)) => errors.push(format!("{what}: {error}")),
        }
    }
    Err(("systemd-inhibit", errors.join("; ")))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn inhibit(what: &str) -> Result<(Hold, KeepAwakeStatus), (&'static str, String)> {
    use std::os::unix::process::CommandExt;
    let pid = std::process::id();
    let what_arg = format!("--what={what}");
    let mut child = std::process::Command::new("systemd-inhibit")
        .args([
            what_arg.as_str(),
            "--who=Hermes",
            &format!("--why={REASON}"),
            "--mode=block",
            "tail",
            &format!("--pid={pid}"),
            "-f",
            "/dev/null",
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        // Its own process group, so releasing ends the inhibitor and tail together.
        .process_group(0)
        .spawn()
        .map_err(|e| ("none", format!("systemd-inhibit is not available: {e}")))?;
    // systemd-inhibit exits at once when logind refuses the lock, and takes
    // a moment to register it when it accepts: the hold is active only once
    // logind lists it (what `systemd-inhibit --list` shows people).
    let deadline = std::time::Instant::now() + INHIBIT_CONFIRM_TIMEOUT;
    loop {
        if let Ok(Some(exit)) = child.try_wait() {
            let mut err = String::new();
            if let Some(mut stderr) = child.stderr.take() {
                use std::io::Read;
                let _ = stderr.read_to_string(&mut err);
            }
            return Err((
                "systemd-inhibit",
                format!("systemd-inhibit exited ({exit}): {}", err.trim()),
            ));
        }
        match inhibitor_listing() {
            // logind lists it: the hold is real.
            Some(listing) if listing_has_hold(&listing) => break,
            // The list cannot be read here: the running inhibitor is all
            // there is to go by.
            None => break,
            Some(_) if std::time::Instant::now() >= deadline => {
                release(Hold::Process(child));
                return Err((
                    "systemd-inhibit",
                    format!(
                        "logind did not list the lock within {} ms",
                        INHIBIT_CONFIRM_TIMEOUT.as_millis()
                    ),
                ));
            }
            Some(_) => std::thread::sleep(std::time::Duration::from_millis(100)),
        }
    }
    let status = KeepAwakeStatus {
        active: true,
        mechanism: "systemd-inhibit".into(),
        pid: Some(child.id()),
        what: Some(what.to_string()),
        error: None,
    };
    Ok((Hold::Process(child), status))
}

/// How long inhibit() waits for logind to list a lock it did not refuse.
#[cfg(all(unix, not(target_os = "macos")))]
const INHIBIT_CONFIRM_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// `systemd-inhibit --list`, or None when it cannot be run or read.
#[cfg(all(unix, not(target_os = "macos")))]
fn inhibitor_listing() -> Option<String> {
    let out = std::process::Command::new("systemd-inhibit")
        .args(["--list", "--no-pager"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Whether a `systemd-inhibit --list` output shows Hermes's hold.
#[cfg(any(test, all(unix, not(target_os = "macos"))))]
fn listing_has_hold(listing: &str) -> bool {
    listing.lines().any(|l| l.contains(REASON))
}

#[cfg(windows)]
fn acquire() -> Result<(Hold, KeepAwakeStatus), (&'static str, String)> {
    use windows_sys::Win32::System::Power::{
        PowerCreateRequest, PowerRequestSystemRequired, PowerSetRequest,
    };
    use windows_sys::Win32::System::Threading::{
        POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0,
    };
    let mut reason: Vec<u16> = REASON.encode_utf16().chain(std::iter::once(0)).collect();
    let context = REASON_CONTEXT {
        Version: 0, // POWER_REQUEST_CONTEXT_VERSION
        Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
        Reason: REASON_CONTEXT_0 {
            SimpleReasonString: reason.as_mut_ptr(),
        },
    };
    // SAFETY: `context` and the string it points to outlive the call, which
    // copies the reason.
    let handle = unsafe { PowerCreateRequest(&context) };
    if handle.is_null() || handle as isize == -1 {
        return Err((
            "power-request",
            format!(
                "PowerCreateRequest failed: {}",
                std::io::Error::last_os_error()
            ),
        ));
    }
    // SAFETY: a valid power request handle from above.
    if unsafe { PowerSetRequest(handle, PowerRequestSystemRequired) } == 0 {
        let err = std::io::Error::last_os_error();
        release(Hold::PowerRequest(handle as isize));
        return Err(("power-request", format!("PowerSetRequest failed: {err}")));
    }
    let status = KeepAwakeStatus {
        active: true,
        mechanism: "power-request".into(),
        pid: None,
        what: None,
        error: None,
    };
    Ok((Hold::PowerRequest(handle as isize), status))
}

fn release(hold: Hold) {
    match hold {
        #[cfg(unix)]
        Hold::Process(mut child) => {
            #[cfg(not(target_os = "macos"))]
            // SAFETY: signalling the process group created for this child.
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGTERM);
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        #[cfg(windows)]
        Hold::PowerRequest(handle) => {
            use windows_sys::Win32::Foundation::CloseHandle;
            use windows_sys::Win32::System::Power::{
                PowerClearRequest, PowerRequestSystemRequired,
            };
            let handle = handle as windows_sys::Win32::Foundation::HANDLE;
            // SAFETY: the handle came from PowerCreateRequest and is closed once.
            unsafe {
                PowerClearRequest(handle, PowerRequestSystemRequired);
                CloseHandle(handle);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hold_counts_only_once_logind_lists_it() {
        let listed = format!(
            "WHO    UID  USER   PID   COMM            WHAT       WHY                          MODE\nHermes 1000 runner 4242  systemd-inhibit idle:sleep {REASON} block\n\n1 inhibitors listed.\n"
        );
        assert!(listing_has_hold(&listed));
        let other = "WHO  UID USER PID COMM WHAT WHY MODE\nModemManager 0 root 700 ModemManager sleep ModemManager needs to reset devices delay\n\n1 inhibitors listed.\n";
        assert!(!listing_has_hold(other));
        assert!(!listing_has_hold(""));
    }

    /// Takes and releases a real hold on this machine (macOS: caffeinate;
    /// Linux: systemd-inhibit when it is allowed; Windows: a power request).
    #[test]
    fn take_and_release_is_idempotent() {
        let first = set(true);
        let again = set(true);
        assert_eq!(first, again, "a second take changes nothing");
        if first.active {
            assert_ne!(first.mechanism, "none");
            #[cfg(all(unix, not(target_os = "macos")))]
            assert!(
                LINUX_WHAT.contains(&first.what.as_deref().unwrap_or_default()),
                "the hold says what it blocks: {first:?}"
            );
            #[cfg(target_os = "macos")]
            {
                let pid = first.pid.expect("caffeinate pid");
                let alive = std::process::Command::new("kill")
                    .args(["-0", &pid.to_string()])
                    .stderr(std::process::Stdio::null())
                    .status()
                    .unwrap();
                assert!(alive.success(), "caffeinate is running while held");
            }
        } else {
            assert!(first.error.is_some(), "an inactive hold says why");
        }
        let released = set(false);
        assert!(!released.active);
        assert!(!status().active);
        #[cfg(target_os = "macos")]
        if let Some(pid) = first.pid {
            let alive = std::process::Command::new("kill")
                .args(["-0", &pid.to_string()])
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap();
            assert!(!alive.success(), "caffeinate is gone after the release");
        }
        assert_eq!(set(false), released, "a second release changes nothing");
    }
}
