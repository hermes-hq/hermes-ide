//! Launch rejection: while a launch is in its first seconds, the terminal
//! output is matched against the agent's catalog `error_signatures`. On a
//! match Hermes writes the stop request `hi` polls for (the launch's nonce,
//! then the CLI's words), and the caller emits the `launch_rejected`
//! SessionEvent. `hi` stops the agent (and Codex's minute of reconnecting
//! with it), gives the terminal back and says so; nothing is retried
//! silently.
//!
//! Only complete lines count (a line still being drawn is matched once it
//! ends), only this launch's output (the watch starts when the launch line
//! is written and ends at the first finished turn, three seconds after the
//! agent exited, or after `REJECT_WINDOW`).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::signatures::{self, Rejection};
use super::types::SessionLaunch;

/// Output kept to find a line split across reads.
const TAIL_BYTES: usize = 16 * 1024;
/// How long output is still read after the agent exited (its last words
/// can be read after its exit is reported).
pub const AFTER_EXIT: Duration = Duration::from_secs(3);

struct Watch {
    agent: String,
    stop_file: PathBuf,
    nonce: String,
    until: Instant,
    /// Output before this launch's marker (see `launch_marker`) is not
    /// read: a repaint of the screen can replay an earlier refusal.
    armed: bool,
    tail: Vec<u8>,
    launch: SessionLaunch,
}

/// The marker `hi run` prints (an OSC sequence terminals ignore) right
/// before it starts the agent. Mirror of `launch_marker` in `hi`.
pub fn launch_marker(nonce: &str) -> String {
    format!("\x1b]777;hermes-launch;{nonce}\x07")
}

fn watches() -> &'static Mutex<HashMap<String, Watch>> {
    static W: OnceLock<Mutex<HashMap<String, Watch>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn start(
    session_id: &str,
    agent: &str,
    stop_file: PathBuf,
    nonce: &str,
    window: Duration,
    launch: SessionLaunch,
) {
    if signatures::for_agent(agent).is_empty() {
        end(session_id);
        return;
    }
    if let Ok(mut w) = watches().lock() {
        w.insert(
            session_id.to_string(),
            Watch {
                agent: agent.to_string(),
                stop_file,
                nonce: nonce.to_string(),
                until: Instant::now() + window,
                armed: false,
                tail: Vec::new(),
                launch,
            },
        );
    }
}

pub fn end(session_id: &str) {
    if let Ok(mut w) = watches().lock() {
        w.remove(session_id);
    }
}

/// The agent exited: read its last words for a moment longer, then stop.
pub fn end_soon(session_id: &str) {
    if let Ok(mut w) = watches().lock() {
        if let Some(watch) = w.get_mut(session_id) {
            watch.until = watch.until.min(Instant::now() + AFTER_EXIT);
        }
    }
}

pub fn is_watching(session_id: &str) -> bool {
    watches()
        .lock()
        .map(|w| w.contains_key(session_id))
        .unwrap_or(false)
}

/// A refused launch found in the output.
#[derive(Debug, Clone)]
pub struct Found {
    pub agent: String,
    pub rejection: Rejection,
    /// What the launch asked for (the banner says which model or account).
    pub launch: SessionLaunch,
}

/// The text up to the end of its last complete line: a line break, or an
/// escape sequence that moves the cursor or erases (how a full-screen TUI
/// ends a row).
pub fn complete_part(text: &str) -> &str {
    let bytes = text.as_bytes();
    let mut end = 0;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\n' | b'\r' => end = i + 1,
            0x1b if bytes.get(i + 1) == Some(&b'[') => {
                let mut j = i + 2;
                while j < bytes.len() && !(0x40..=0x7e).contains(&bytes[j]) {
                    j += 1;
                }
                if j < bytes.len() {
                    if matches!(
                        bytes[j],
                        b'H' | b'f' | b'A' | b'B' | b'E' | b'F' | b'd' | b'J' | b'K'
                    ) {
                        end = j + 1;
                    }
                    i = j;
                }
            }
            _ => {}
        }
        i += 1;
    }
    &text[..end]
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Feed a session's terminal output. Returns the refusal the first time one
/// shows, after writing the stop request for `hi`; the watch then ends.
pub fn observe(session_id: &str, data: &[u8]) -> Option<Found> {
    let mut watches = watches().lock().ok()?;
    if watches.is_empty() {
        return None;
    }
    let watch = watches.get_mut(session_id)?;
    if Instant::now() > watch.until {
        watches.remove(session_id);
        return None;
    }
    watch.tail.extend_from_slice(data);
    if !watch.armed {
        // Keep only what follows this launch's marker (a marker split
        // across reads is found once its rest arrives).
        let marker = launch_marker(&watch.nonce);
        match find_bytes(&watch.tail, marker.as_bytes()) {
            Some(at) => {
                watch.tail.drain(..at + marker.len());
                watch.armed = true;
            }
            None => {
                let keep = marker.len().saturating_sub(1);
                if watch.tail.len() > keep {
                    let cut = watch.tail.len() - keep;
                    watch.tail.drain(..cut);
                }
                return None;
            }
        }
    }
    if watch.tail.len() > TAIL_BYTES {
        let cut = watch.tail.len() - TAIL_BYTES;
        watch.tail.drain(..cut);
    }
    let text = String::from_utf8_lossy(&watch.tail).into_owned();
    let rejection = signatures::for_agent(&watch.agent).find(complete_part(&text))?;
    let request = format!(
        "{}\n{}\n",
        watch.nonce,
        rejection.vendor_message.replace(['\r', '\n'], " ")
    );
    if let Err(e) = std::fs::write(&watch.stop_file, request) {
        log::warn!("[CAPS] {session_id}: could not ask hi to stop the refused launch: {e}");
    }
    let found = Found {
        agent: watch.agent.clone(),
        rejection,
        launch: watch.launch.clone(),
    };
    watches.remove(session_id);
    Some(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::RejectReason;

    #[test]
    fn only_complete_lines_are_matched() {
        assert_eq!(complete_part("abc"), "");
        assert_eq!(complete_part("abc\r\ndef"), "abc\r\n");
        assert_eq!(complete_part("row one\x1b[2;1Hrow two"), "row one\x1b[2;1H");
        assert_eq!(complete_part("text\x1b[K"), "text\x1b[K");
        assert_eq!(complete_part("text\x1b[0m"), "");
        assert_eq!(complete_part("half\x1b["), "");
    }

    #[test]
    fn a_refusal_writes_the_stop_request_once_with_the_nonce_and_the_words() {
        let dir = tempfile::tempdir().unwrap();
        let stop = dir.path().join("launch-stop");
        let launch = SessionLaunch {
            model_id: Some("not-a-model".into()),
            ..Default::default()
        };
        start(
            "cap-w1",
            "claude",
            stop.clone(),
            "n0",
            Duration::from_secs(30),
            launch,
        );
        // A repaint of an earlier launch's refusal, before this launch began.
        assert!(observe(
            "cap-w1",
            b"There's an issue with the selected model (old). It may not exist.\r\n"
        )
        .is_none());
        assert!(!stop.exists());
        // The marker, split across two reads.
        assert!(observe("cap-w1", b"hi run cap-w1\r\n\x1b]777;hermes-la").is_none());
        assert!(observe("cap-w1", b"unch;n0\x07\x1b[1;1HWelcome to Claude Code\r\n").is_none());
        // Split across reads, and not finished: nothing yet.
        assert!(observe(
            "cap-w1",
            b"There's an issue with the selected model (not-a-mo"
        )
        .is_none());
        assert!(!stop.exists());
        let found = observe("cap-w1", b"del). It may not exist or you may not have access to it. Run --model to pick a different model.\r\n").unwrap();
        assert_eq!(found.rejection.reason, RejectReason::Model);
        assert_eq!(found.launch.model_id.as_deref(), Some("not-a-model"));
        assert_eq!(
            std::fs::read_to_string(&stop).unwrap(),
            "n0\nThere's an issue with the selected model (not-a-model). It may not exist or you may not have access to it. Run --model to pick a different model.\n"
        );
        assert!(!is_watching("cap-w1"), "one refusal per launch");
        assert!(observe("cap-w1", b"Not logged in\r\n").is_none());
    }

    #[test]
    fn no_match_after_the_window_or_for_another_session_or_an_agent_without_signatures() {
        let dir = tempfile::tempdir().unwrap();
        start(
            "cap-w2",
            "codex",
            dir.path().join("s2"),
            "n",
            Duration::from_millis(0),
            SessionLaunch::default(),
        );
        std::thread::sleep(Duration::from_millis(5));
        assert!(observe(
            "cap-w2",
            b"\x1b]777;hermes-launch;n\x07ERROR: unexpected status 401 Unauthorized\r\n"
        )
        .is_none());
        assert!(!dir.path().join("s2").exists());
        start(
            "cap-w3",
            "codex",
            dir.path().join("s3"),
            "n",
            Duration::from_secs(30),
            SessionLaunch::default(),
        );
        assert!(observe(
            "cap-other",
            b"\x1b]777;hermes-launch;n\x07Not logged in\r\n"
        )
        .is_none());
        // Another launch's marker does not arm this one.
        assert!(observe(
            "cap-w3",
            b"\x1b]777;hermes-launch;other\x07Not logged in\r\n"
        )
        .is_none());
        assert!(is_watching("cap-w3"));
        end("cap-w3");
        start(
            "cap-w4",
            "custom",
            dir.path().join("s4"),
            "n",
            Duration::from_secs(30),
            SessionLaunch::default(),
        );
        assert!(!is_watching("cap-w4"));
    }

    #[test]
    fn after_an_exit_the_watch_reads_only_a_moment_longer() {
        let dir = tempfile::tempdir().unwrap();
        start(
            "cap-w5",
            "codex",
            dir.path().join("s5"),
            "n",
            Duration::from_secs(60),
            SessionLaunch::default(),
        );
        end_soon("cap-w5");
        assert!(
            observe("cap-w5", b"\x1b]777;hermes-launch;n\x07Not logged in\n").is_some(),
            "words right after the exit still count"
        );
    }
}
