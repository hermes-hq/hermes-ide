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
//! is written and ends at the first finished turn, the first tool the agent
//! ran, three seconds after the agent exited, or after `REJECT_WINDOW`).
//!
//! A false match stops a working agent, so what Hermes passed to the CLI
//! (the task, the context prompt) and what the person typed never counts
//! (`Signatures::find_excluding`), and a resumed conversation's replayed
//! history is not read at all. A resumed CLI asks its model nothing before
//! the person's first message, so on a resume the watch reads only what
//! follows the Enter that sent it. An Enter alone does not say that: it may
//! answer a prompt the CLI shows before it replays (a trust prompt, a
//! resume-from-summary choice). The message was sent when this launch's
//! prompt hook reports it (`message_sent`: Claude Code's `UserPromptSubmit`,
//! Gemini's `BeforeAgent`); the output since the last Enter before that is
//! the answer. A launch without such a hook (Codex today) is never read
//! after a resume, only after `hi`'s fresh start. Lines the replay showed
//! that look like a refusal are kept, and once the CLI repaints the screen
//! (a redraw after a resize replays them again) they no longer count; a
//! refusal worded exactly like one in the history is then missed, which
//! stops nothing.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::signatures::{self, squeeze, Rejection};
use super::types::SessionLaunch;

/// Output kept to find a line split across reads.
const TAIL_BYTES: usize = 16 * 1024;
/// How long output is still read after the agent exited (its last words
/// can be read after its exit is reported).
pub const AFTER_EXIT: Duration = Duration::from_secs(3);
/// How long a resumed agent may wait for the person's first message before
/// a refusal of it is no longer looked for (`hi` polls as long).
pub const RESUME_WAIT: Duration = Duration::from_secs(12 * 60 * 60);
/// Most typed lines kept as "the person's words" (each at most
/// `MAX_TYPED` characters).
const MAX_TYPED_LINES: usize = 32;
const MAX_TYPED: usize = 8 * 1024;
/// Most refusal-like lines of a replay kept.
const MAX_REPLAYED: usize = 64;
/// The vendor events that say this launch sent the person's message to its
/// model (Claude Code, Codex hooks; Gemini).
pub const PROMPT_SENT_EVENTS: &[&str] = &["UserPromptSubmit", "BeforeAgent"];

/// How one launch is watched.
#[derive(Debug, Clone, Default)]
pub struct WatchStart {
    /// The stop request `hi` polls for.
    pub stop_file: PathBuf,
    pub nonce: String,
    /// How long after the start (a resume: after the first Enter).
    pub window: Duration,
    /// What the launch asked for (the banner says which model or account).
    pub launch: SessionLaunch,
    /// Texts Hermes passed to the CLI (the task, the context prompt): their
    /// echo is never a refusal. A resume passes none of them (only `hi`'s
    /// fresh start after an unknown conversation does, see `fresh_start`).
    pub given: Vec<String>,
    /// The launch resumes a saved conversation (its history is replayed).
    pub resumes: bool,
}

struct Watch {
    agent: String,
    stop_file: PathBuf,
    nonce: String,
    window: Duration,
    until: Instant,
    /// Output before this launch's marker (see `launch_marker`) is not
    /// read: a repaint of the screen can replay an earlier refusal.
    armed: bool,
    /// A resume before its prompt hook reported the person's first
    /// message: the CLI is replaying the conversation, which is not read.
    replay: bool,
    /// While `replay`: an Enter was pressed; `tail` holds what followed the
    /// last one (the answer, if that Enter sent the message).
    entered: bool,
    /// Refusal-like lines the replay showed, squeezed.
    replayed: Vec<String>,
    /// The screen was repainted since the message: `replayed` lines no
    /// longer count.
    repainted: bool,
    tail: Vec<u8>,
    launch: SessionLaunch,
    /// Passed-in texts and the person's typed lines, squeezed.
    given: Vec<String>,
    /// A resume's passed-in texts, which only its fresh start passes.
    held: Vec<String>,
    typed: Typed,
}

/// The line the person is typing, read from their keys.
#[derive(Default)]
struct Typed {
    line: String,
    /// 0: text; 1: after ESC; 2: in a CSI sequence (its bytes so far).
    escape: u8,
    csi: String,
    pasting: bool,
}

/// The marker `hi run` prints (an OSC sequence terminals ignore) right
/// before it starts the agent. Mirror of `launch_marker` in `hi`.
pub fn launch_marker(nonce: &str) -> String {
    format!("\x1b]777;hermes-launch;{nonce}\x07")
}

/// e2e builds only: `HERMES_E2E_REFUSAL_WATCH=off` never watches a launch,
/// `=unfiltered` reads passed-in text and a resume's replay too,
/// `=first-enter` ends a resume's replay at its first Enter (without the
/// prompt hook). The negative controls of the CAP scenarios, which prove
/// the watch and its filters are what the scenarios see.
fn e2e_mode() -> Option<String> {
    #[cfg(feature = "e2e")]
    if std::env::var("HERMES_E2E").ok().as_deref() == Some("1") {
        return std::env::var("HERMES_E2E_REFUSAL_WATCH").ok();
    }
    None
}

fn watches() -> &'static Mutex<HashMap<String, Watch>> {
    static W: OnceLock<Mutex<HashMap<String, Watch>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(HashMap::new()))
}

/// What each watched launch asked for, until the CLI takes it (`taken`) or
/// refuses it. Kept apart from the watch: the watch stops reading output
/// after its window, but a first turn that finishes later still proves the
/// model works (and forgets its earlier refusal).
fn untaken() -> &'static Mutex<HashMap<String, SessionLaunch>> {
    static U: OnceLock<Mutex<HashMap<String, SessionLaunch>>> = OnceLock::new();
    U.get_or_init(|| Mutex::new(HashMap::new()))
}

fn forget_untaken(session_id: &str) {
    if let Ok(mut u) = untaken().lock() {
        u.remove(session_id);
    }
}

/// Sessions whose current launch the CLI refused, until the next launch.
fn refused() -> &'static Mutex<HashSet<String>> {
    static R: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashSet::new()))
}

fn set_refused(session_id: &str, yes: bool) {
    if let Ok(mut r) = refused().lock() {
        if yes {
            r.insert(session_id.to_string());
        } else {
            r.remove(session_id);
        }
    }
}

/// Whether the CLI refused the session's current launch (its refusal was
/// found on screen): nothing it reports afterwards starts a turn.
pub fn was_refused(session_id: &str) -> bool {
    refused()
        .lock()
        .map(|r| r.contains(session_id))
        .unwrap_or(false)
}

pub fn start(session_id: &str, agent: &str, how: WatchStart) {
    set_refused(session_id, false);
    let mode = e2e_mode();
    if signatures::for_agent(agent).is_empty() || mode.as_deref() == Some("off") {
        end(session_id);
        return;
    }
    let unfiltered = mode.as_deref() == Some("unfiltered");
    let given = if unfiltered {
        Vec::new()
    } else {
        how.given
            .iter()
            .map(|t| squeeze(t))
            .filter(|t| !t.is_empty())
            .collect()
    };
    let replay = how.resumes && !unfiltered;
    // A resume does not pass the task: its words, said by the CLI, are the
    // CLI's (a resumed conversation refused at its first message says the
    // same words a task may quote).
    let (given, held) = if how.resumes {
        (Vec::new(), given)
    } else {
        (given, Vec::new())
    };
    if let Ok(mut u) = untaken().lock() {
        u.insert(session_id.to_string(), how.launch.clone());
    }
    if let Ok(mut w) = watches().lock() {
        w.insert(
            session_id.to_string(),
            Watch {
                agent: agent.to_string(),
                stop_file: how.stop_file,
                nonce: how.nonce,
                window: how.window,
                until: Instant::now() + if replay { RESUME_WAIT } else { how.window },
                armed: false,
                replay,
                entered: false,
                replayed: Vec::new(),
                repainted: false,
                tail: Vec::new(),
                launch: how.launch,
                given,
                held,
                typed: Typed::default(),
            },
        );
    }
}

/// The person typed into the session's terminal. Their lines are never a
/// refusal. On a resume an Enter closes what the replay showed so far; what
/// follows it is read if the prompt hook then says a message was sent
/// (`message_sent`).
pub fn user_input(session_id: &str, data: &[u8]) {
    let Ok(mut watches) = watches().lock() else {
        return;
    };
    let Some(watch) = watches.get_mut(session_id) else {
        return;
    };
    let mode = e2e_mode();
    let unfiltered = mode.as_deref() == Some("unfiltered");
    let first_enter = mode.as_deref() == Some("first-enter");
    for c in String::from_utf8_lossy(data).chars() {
        let t = &mut watch.typed;
        match t.escape {
            1 => {
                t.escape = if c == '[' { 2 } else { 0 };
                t.csi.clear();
                continue;
            }
            2 => {
                if ('\x40'..='\x7e').contains(&c) {
                    t.escape = 0;
                    if c == '~' {
                        match t.csi.as_str() {
                            "200" => t.pasting = true,
                            "201" => t.pasting = false,
                            _ => {}
                        }
                    }
                } else {
                    t.csi.push(c);
                }
                continue;
            }
            _ => {}
        }
        match c {
            '\x1b' => t.escape = 1,
            '\r' | '\n' => {
                let line = squeeze(&std::mem::take(&mut t.line));
                if !line.is_empty() && !unfiltered {
                    if watch.given.len() >= MAX_TYPED_LINES {
                        watch.given.remove(0);
                    }
                    watch.given.push(line);
                }
                if !t.pasting && watch.armed && watch.replay {
                    // Maybe the first message, maybe the answer to a prompt
                    // the CLI shows before it replays: what came before
                    // this Enter is the replay either way.
                    let text = String::from_utf8_lossy(&watch.tail).into_owned();
                    keep_replayed(watch, complete_part(&text));
                    watch.tail.clear();
                    watch.entered = true;
                    if first_enter {
                        // The negative control: the pre-fix behaviour.
                        watch.replay = false;
                        watch.until = Instant::now() + watch.window;
                    }
                }
            }
            '\x7f' | '\x08' => {
                t.line.pop();
            }
            '\x03' | '\x15' => t.line.clear(),
            c if !c.is_control() && t.line.len() < MAX_TYPED => t.line.push(c),
            _ => {}
        }
    }
}

/// Remember the refusal-like lines a replay showed (see `repainted`).
fn keep_replayed(watch: &mut Watch, text: &str) {
    for line in signatures::for_agent(&watch.agent).matching_lines(text) {
        if watch.replayed.len() >= MAX_REPLAYED {
            break;
        }
        if !watch.replayed.contains(&line) {
            watch.replayed.push(line);
        }
    }
}

/// Whether terminal output repaints the screen: erases it, or moves the
/// cursor to its top-left corner (how a TUI and the Windows console redraw
/// everything, a resumed transcript included).
fn repaints(data: &[u8]) -> bool {
    [
        &b"\x1b[2J"[..],
        b"\x1b[3J",
        b"\x1bc",
        b"\x1b[H",
        b"\x1b[1;1H",
    ]
    .iter()
    .any(|seq| find_bytes(data, seq).is_some())
}

/// This launch's prompt hook reported that the CLI sent the person's
/// message (see `PROMPT_SENT_EVENTS`): a resume's replay is over, and the
/// output since the Enter that sent it is read now (it may already hold
/// the CLI's refusal). Returns the refusal, like `observe`.
pub fn message_sent(session_id: &str) -> Option<Found> {
    let mut watches = watches().lock().ok()?;
    let watch = watches.get_mut(session_id)?;
    if !watch.replay || !watch.armed {
        return None;
    }
    if !watch.entered {
        // No Enter seen (the message came some other way): everything so
        // far is the replay.
        let text = String::from_utf8_lossy(&watch.tail).into_owned();
        keep_replayed(watch, complete_part(&text));
        watch.tail.clear();
    }
    watch.replay = false;
    watch.until = Instant::now() + watch.window;
    watch.repainted = repaints(&watch.tail);
    scan(&mut watches, session_id)
}

/// A resume the vendor did not know was replaced by a fresh start (`hi`'s
/// fallback): nothing is replayed any more.
pub fn fresh_start(session_id: &str) {
    if let Ok(mut w) = watches().lock() {
        if let Some(watch) = w.get_mut(session_id) {
            let held = std::mem::take(&mut watch.held);
            watch.given.extend(held);
            if watch.replay {
                watch.replay = false;
                watch.tail.clear();
                watch.until = Instant::now() + watch.window;
            }
        }
    }
}

pub fn end(session_id: &str) {
    if let Ok(mut w) = watches().lock() {
        w.remove(session_id);
    }
    forget_untaken(session_id);
    set_refused(session_id, false);
}

/// The CLI took the launch (its first finished turn or tool call): the
/// watch ends. Returns what the launch asked for, once per launch, when no
/// refusal was seen (a refusal forgets it first), so the caller can forget
/// an earlier refusal of that model. The watch's window does not matter: a
/// first turn that finishes minutes after the start still counts.
pub fn taken(session_id: &str) -> Option<SessionLaunch> {
    if let Ok(mut w) = watches().lock() {
        w.remove(session_id);
    }
    untaken().lock().ok()?.remove(session_id)
}

/// Whether the session's launch may still be refused: neither taken by the
/// CLI (`taken`) nor refused (a refusal forgets it) yet.
pub fn is_untaken(session_id: &str) -> bool {
    untaken()
        .lock()
        .map(|u| u.contains_key(session_id))
        .unwrap_or(false)
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
    if watch.replay {
        // A resumed conversation's history: not this launch's words. What
        // follows an Enter is kept until the prompt hook says whether it
        // sent the message; a long replay is set aside line by line.
        if watch.tail.len() > TAIL_BYTES {
            let text = String::from_utf8_lossy(&watch.tail).into_owned();
            keep_replayed(watch, complete_part(&text));
            match watch.tail.iter().rposition(|b| matches!(b, b'\n' | b'\r')) {
                Some(at) => {
                    watch.tail.drain(..=at);
                }
                None => {
                    let cut = watch.tail.len() - TAIL_BYTES;
                    watch.tail.drain(..cut);
                }
            }
        }
        return None;
    }
    if !watch.repainted && !watch.replayed.is_empty() && repaints(data) {
        watch.repainted = true;
    }
    scan(&mut watches, session_id)
}

/// Match the watch's output so far; on a refusal, write the stop request
/// for `hi` and end the watch.
fn scan(watches: &mut HashMap<String, Watch>, session_id: &str) -> Option<Found> {
    let watch = watches.get_mut(session_id)?;
    if watch.tail.len() > TAIL_BYTES {
        let cut = watch.tail.len() - TAIL_BYTES;
        watch.tail.drain(..cut);
    }
    let text = String::from_utf8_lossy(&watch.tail).into_owned();
    let excluded: Vec<String>;
    let given = if watch.repainted && !watch.replayed.is_empty() {
        excluded = watch
            .given
            .iter()
            .chain(watch.replayed.iter())
            .cloned()
            .collect();
        &excluded
    } else {
        &watch.given
    };
    let rejection =
        signatures::for_agent(&watch.agent).find_excluding(complete_part(&text), given)?;
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
    forget_untaken(session_id);
    set_refused(session_id, true);
    Some(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::RejectReason;

    fn how(stop_file: PathBuf, nonce: &str, window: Duration, launch: SessionLaunch) -> WatchStart {
        WatchStart {
            stop_file,
            nonce: nonce.to_string(),
            window,
            launch,
            ..Default::default()
        }
    }

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
            how(stop.clone(), "n0", Duration::from_secs(30), launch),
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
        // The refused launch's turn ending later is not "taken".
        assert!(taken("cap-w1").is_none());
        // What it reports afterwards starts no turn, until the next launch.
        assert!(was_refused("cap-w1") && !is_untaken("cap-w1"));
        start(
            "cap-w1",
            "claude",
            how(
                stop.clone(),
                "n1",
                Duration::from_secs(30),
                SessionLaunch::default(),
            ),
        );
        assert!(!was_refused("cap-w1") && is_untaken("cap-w1"));
        end("cap-w1");
    }

    #[test]
    fn a_launch_taken_without_a_refusal_hands_back_what_it_asked_for_once() {
        let dir = tempfile::tempdir().unwrap();
        let launch = SessionLaunch {
            model_id: Some("opus".into()),
            account_id: Some("work".into()),
            ..Default::default()
        };
        start(
            "cap-taken",
            "claude",
            how(dir.path().join("st"), "n", Duration::from_secs(30), launch),
        );
        let got = taken("cap-taken").expect("the launch was still watched");
        assert_eq!(got.model_id.as_deref(), Some("opus"));
        assert_eq!(got.account_id.as_deref(), Some("work"));
        assert!(!is_watching("cap-taken"));
        assert!(taken("cap-taken").is_none(), "once per launch");
    }

    #[test]
    fn a_first_turn_after_the_window_still_takes_the_launch() {
        let dir = tempfile::tempdir().unwrap();
        let launch = SessionLaunch {
            model_id: Some("gpt-5.5".into()),
            ..Default::default()
        };
        start(
            "cap-late",
            "codex",
            how(dir.path().join("st"), "n", Duration::from_millis(1), launch),
        );
        std::thread::sleep(Duration::from_millis(20));
        // Output after the window drops the watch...
        assert!(observe("cap-late", b"thinking...\r\n").is_none());
        assert!(!is_watching("cap-late"));
        // ...but the turn that finishes later still says the model works.
        let got = taken("cap-late").expect("taken after the window");
        assert_eq!(got.model_id.as_deref(), Some("gpt-5.5"));
        assert!(taken("cap-late").is_none(), "once per launch");
        // A launch Hermes stopped (end) is never taken.
        start(
            "cap-ended",
            "codex",
            how(
                dir.path().join("st2"),
                "n",
                Duration::from_secs(30),
                SessionLaunch::default(),
            ),
        );
        end("cap-ended");
        assert!(taken("cap-ended").is_none());
    }

    #[test]
    fn no_match_after_the_window_or_for_another_session_or_an_agent_without_signatures() {
        let dir = tempfile::tempdir().unwrap();
        start(
            "cap-w2",
            "codex",
            how(
                dir.path().join("s2"),
                "n",
                Duration::from_millis(0),
                SessionLaunch::default(),
            ),
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
            how(
                dir.path().join("s3"),
                "n",
                Duration::from_secs(30),
                SessionLaunch::default(),
            ),
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
            how(
                dir.path().join("s4"),
                "n",
                Duration::from_secs(30),
                SessionLaunch::default(),
            ),
        );
        assert!(!is_watching("cap-w4"));
    }

    #[test]
    fn after_an_exit_the_watch_reads_only_a_moment_longer() {
        let dir = tempfile::tempdir().unwrap();
        start(
            "cap-w5",
            "codex",
            how(
                dir.path().join("s5"),
                "n",
                Duration::from_secs(60),
                SessionLaunch::default(),
            ),
        );
        end_soon("cap-w5");
        assert!(
            observe("cap-w5", b"\x1b]777;hermes-launch;n\x07Not logged in\n").is_some(),
            "words right after the exit still count"
        );
    }

    fn launched(sid: &str, agent: &str, stop: PathBuf, given: &[&str], resumes: bool) {
        start(
            sid,
            agent,
            WatchStart {
                given: given.iter().map(|g| g.to_string()).collect(),
                resumes,
                ..how(stop, "n", Duration::from_secs(30), SessionLaunch::default())
            },
        );
        assert!(observe(sid, b"\x1b]777;hermes-launch;n\x07").is_none());
    }

    #[test]
    fn the_task_hermes_passed_is_never_a_refusal_even_when_it_quotes_one() {
        let dir = tempfile::tempdir().unwrap();
        let stop = dir.path().join("t1");
        // The reviewer's case: the words, not the CLI's error shape.
        let task = "Fix the 401 Unauthorized error on the login page";
        launched("cap-t1", "codex", stop.clone(), &[task], false);
        assert!(observe(
            "cap-t1",
            format!("prompt: {task}\r\n> {task}\r\n{task}\r\n").as_bytes()
        )
        .is_none());
        // A task that carries the CLI's own error line (a pasted log),
        // echoed line by line, wrapped and framed by the TUI.
        end("cap-t1");
        let pasted = "Users see this after SSO:\nERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header\nNot logged in\nFix the login flow.";
        launched("cap-t2", "codex", stop.clone(), &[pasted], false);
        let echo = "\x1b[2;1H\u{2502} Users see this after SSO:          \u{2502}\r\n\u{2502} ERROR: unexpected status 401 Unauthorized: Missing\r\n\u{2502} bearer or basic authentication in header \u{2502}\r\n\u{2502} Not logged in \u{2502}\r\n";
        assert!(observe("cap-t2", echo.as_bytes()).is_none());
        assert!(!stop.exists(), "nothing asked hi to stop");
        assert!(is_watching("cap-t2"));
        // The CLI's own error, in its own words, still counts.
        let found = observe("cap-t2", b"\x1b[2K\rReconnecting... 2/5\r\nERROR: unexpected status 401 Unauthorized: token expired\r\n").unwrap();
        assert_eq!(found.rejection.reason, RejectReason::SignedOut);
        assert!(stop.exists());
    }

    #[test]
    fn what_the_person_types_is_never_a_refusal() {
        let dir = tempfile::tempdir().unwrap();
        let stop = dir.path().join("u1");
        launched("cap-u1", "claude", stop.clone(), &[], false);
        user_input("cap-u1", b"Not logged in \xc2\xb7 Please run /loginX\x7f");
        user_input("cap-u1", b"\x1b[D\r");
        assert!(observe(
            "cap-u1",
            "> Not logged in · Please run /login\r\nNot logged in · Please run /login\r\n"
                .as_bytes()
        )
        .is_none());
        assert!(!stop.exists());
        end("cap-u1");
    }

    #[test]
    fn a_resumed_conversation_is_read_only_after_its_prompt_hook() {
        let dir = tempfile::tempdir().unwrap();
        let stop = dir.path().join("r1");
        launched("cap-r1", "codex", stop.clone(), &[], true);
        // The replayed history holds an earlier refusal.
        assert!(observe(
            "cap-r1",
            b"earlier:\r\nERROR: unexpected status 401 Unauthorized: Missing bearer\r\n"
        )
        .is_none());
        // A paste with a line break is not an Enter; typing is not either.
        user_input("cap-r1", b"\x1b[200~line one\nline two\x1b[201~hello");
        assert!(observe(
            "cap-r1",
            b"ERROR: unexpected status 401 Unauthorized: Missing bearer\r\n"
        )
        .is_none());
        // An Enter alone does not say the message was sent: nothing is read.
        user_input("cap-r1", b"\r");
        assert!(observe(
            "cap-r1",
            b"Reconnecting... 1/5\r\nERROR: unexpected status 401 Unauthorized: Missing bearer\r\n",
        )
        .is_none());
        assert!(!stop.exists(), "the replay stopped nothing");
        // The prompt hook: the output since that Enter is the answer, read
        // at once (it arrived before the hook's record was read).
        let found = message_sent("cap-r1").unwrap();
        assert_eq!(found.rejection.reason, RejectReason::SignedOut);
        assert!(stop.exists());

        // hi fell back to a fresh start: it is read at once, and it passed
        // the task, whose echo does not count.
        launched(
            "cap-r2",
            "codex",
            dir.path().join("r2"),
            &["see: Not logged in"],
            true,
        );
        fresh_start("cap-r2");
        assert!(observe("cap-r2", b"prompt: see:\r\nNot logged in\r\n").is_none());
        assert!(observe(
            "cap-r2",
            b"ERROR: unexpected status 401 Unauthorized: x\r\n"
        )
        .is_some());

        // A resume passes no task: the CLI saying the words a task quoted is
        // the CLI.
        launched(
            "cap-r4",
            "claude",
            dir.path().join("r4"),
            &["Not logged in · Please run /login appears"],
            true,
        );
        user_input("cap-r4", b"hello\r");
        assert!(message_sent("cap-r4").is_none());
        assert!(observe(
            "cap-r4",
            "hello\r\nNot logged in · Please run /login\r\n".as_bytes()
        )
        .is_some());

        // An Enter and a prompt hook before this launch's marker (while `hi`
        // starts) do not end the replay.
        start(
            "cap-r3",
            "codex",
            WatchStart {
                resumes: true,
                ..how(
                    dir.path().join("r3"),
                    "n",
                    Duration::from_secs(30),
                    SessionLaunch::default(),
                )
            },
        );
        user_input("cap-r3", b"\r");
        assert!(message_sent("cap-r3").is_none());
        assert!(observe("cap-r3", b"\x1b]777;hermes-launch;n\x07Not logged in\r\n").is_none());
        end("cap-r3");
    }

    const TRUST: &str = "\x1b[?25l\r\n\u{250c}\u{2500}\u{2500}\u{2510}\r\n\u{2502} Do you trust the files in this folder? \u{2502}\r\n\u{2502} [y] Yes, proceed    [n] No, exit \u{2502}\r\n\u{2514}\u{2500}\u{2500}\u{2518}\r\n";
    const REPLAY: &str = "Trusted. Starting\u{2026}\r\n\r\nfake-cli 0.1 \u{b7} session c1 (resumed from c1)\r\nfake-cli: earlier in this conversation:\r\nprompt: Say hello\r\nNot logged in \u{b7} Please run /login\r\nfake-cli: type q to quit\r\nfake-cli: ready\r\n";

    #[test]
    fn an_enter_at_a_prompt_shown_before_the_replay_does_not_end_it() {
        // The re-review's case: a signed-in resume whose history holds the
        // refusal line; the person accepts the trust prompt with Enter, and
        // the replay follows that Enter.
        let dir = tempfile::tempdir().unwrap();
        let stop = dir.path().join("p1");
        launched("cap-p1", "claude", stop.clone(), &[], true);
        assert!(observe("cap-p1", TRUST.as_bytes()).is_none());
        user_input("cap-p1", b"\r");
        assert!(observe("cap-p1", REPLAY.as_bytes()).is_none());
        assert!(
            !stop.exists(),
            "the replay after the trust prompt stopped nothing"
        );
        assert!(is_watching("cap-p1"));
        // The first message, answered.
        user_input("cap-p1", b"hello\r");
        assert!(observe("cap-p1", "> hello\r\n".as_bytes()).is_none());
        assert!(message_sent("cap-p1").is_none());
        assert!(observe("cap-p1", "\u{23fa} Hi! What shall we do?\r\n".as_bytes()).is_none());
        // A redraw of the whole transcript (a resize) replays the old line:
        // not a refusal once the screen was repainted.
        let redraw = format!("\x1b[2J\x1b[3J\x1b[H{REPLAY}> hello\r\n");
        assert!(observe("cap-p1", redraw.as_bytes()).is_none());
        assert!(!stop.exists(), "the redraw stopped nothing");
        // A refusal the history never showed still counts.
        let found = observe(
            "cap-p1",
            b"There's an issue with the selected model (x). It may not exist or you may not have access to it.\r\n",
        )
        .unwrap();
        assert_eq!(found.rejection.reason, RejectReason::Model);

        // Signed out behind the same trust prompt: the refusal of the first
        // message is caught once its prompt hook is read, even when its
        // words are the history's (no repaint in between).
        let stop2 = dir.path().join("p2");
        launched("cap-p2", "claude", stop2.clone(), &[], true);
        assert!(observe("cap-p2", TRUST.as_bytes()).is_none());
        user_input("cap-p2", b"\r");
        assert!(observe("cap-p2", REPLAY.as_bytes()).is_none());
        user_input("cap-p2", b"hello\r");
        assert!(observe(
            "cap-p2",
            "> hello\r\n  \u{23bf}  Not logged in \u{b7} Please run /login\r\n".as_bytes()
        )
        .is_none());
        assert!(!stop2.exists(), "nothing before the prompt hook");
        let found = message_sent("cap-p2").unwrap();
        assert_eq!(found.rejection.reason, RejectReason::SignedOut);
        assert_eq!(
            found.rejection.vendor_message,
            "Not logged in \u{b7} Please run /login"
        );
        assert!(stop2.exists());
    }

    #[test]
    fn a_long_replay_is_set_aside_line_by_line() {
        let dir = tempfile::tempdir().unwrap();
        let stop = dir.path().join("l1");
        launched("cap-l1", "claude", stop.clone(), &[], true);
        let mut history = String::from("Not logged in \u{b7} Please run /login\r\n");
        while history.len() < 3 * TAIL_BYTES {
            history.push_str("an earlier answer, long enough to fill the tail\r\n");
        }
        assert!(observe("cap-l1", history.as_bytes()).is_none());
        user_input("cap-l1", b"hi\r");
        assert!(message_sent("cap-l1").is_none());
        // Its refusal line was kept: a repaint drawing it again is not read.
        assert!(observe(
            "cap-l1",
            "\x1b[H\x1b[2JNot logged in \u{b7} Please run /login\r\n".as_bytes()
        )
        .is_none());
        assert!(!stop.exists());
        end("cap-l1");
    }
}
