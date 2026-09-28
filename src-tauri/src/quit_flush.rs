//! Every way of quitting lets the frontend write its latest workspace first.
//!
//! The saved workspace (sessions, layout, notes) is written by the frontend.
//! Quitting used to go straight to exit, so whatever changed since the last
//! write was lost: a session created a moment before the quit, or everything
//! restored at launch when the quit came before the next write.
//!
//! Now a quit through the app's Quit menu item, `AppHandle::exit`, or closing
//! the main window is held: the backend asks the frontend to write the
//! workspace (`FLUSH_EVENT`), waits for its answer at most `FLUSH_TIMEOUT`,
//! and then carries on with the quit. The wait runs off the main thread,
//! because the frontend's save needs the main thread to answer its calls.
//!
//! Not every quit can be held: a restart (the updater's relaunch) cannot be
//! prevented, so the updater writes the workspace itself before it relaunches,
//! and a quit the OS forces (logging out, the Dock's Quit on macOS) never
//! reaches this code. For those, the frontend's own writes on every session
//! change are what the next launch restores.

use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

/// Asks the frontend to write the saved workspace now. Payload: the flush id
/// to answer with `workspace_flush_done`.
pub const FLUSH_EVENT: &str = "workspace-flush-requested";

/// How long a quit waits for the frontend's answer.
pub const FLUSH_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// No quit yet.
    #[default]
    Running,
    /// A quit is held while the frontend writes the workspace.
    Flushing,
    /// The flush is over (or was skipped): quits go through.
    Released,
}

#[derive(Default)]
struct Inner {
    /// The frontend listens for `FLUSH_EVENT`.
    frontend_ready: bool,
    phase: Phase,
    last_id: u64,
    /// The highest flush id the frontend answered.
    answered: u64,
}

/// What a quit request should do.
#[derive(Debug, PartialEq, Eq)]
pub enum Begin {
    /// Quit now.
    Proceed,
    /// Hold this quit: a flush is already running and will finish it.
    Hold,
    /// Hold this quit, ask the frontend to write (with this id), then quit.
    Flush(u64),
}

/// Quit-time flush state, managed by Tauri.
#[derive(Default)]
pub struct QuitFlush {
    inner: Mutex<Inner>,
    answered: Condvar,
}

impl QuitFlush {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn frontend_ready(&self) {
        self.lock().frontend_ready = true;
    }

    /// Decide what a quit request does.
    pub fn begin(&self) -> Begin {
        let mut inner = self.lock();
        match inner.phase {
            Phase::Released => Begin::Proceed,
            Phase::Flushing => Begin::Hold,
            Phase::Running if !inner.frontend_ready => {
                inner.phase = Phase::Released;
                Begin::Proceed
            }
            Phase::Running => {
                inner.phase = Phase::Flushing;
                inner.last_id += 1;
                Begin::Flush(inner.last_id)
            }
        }
    }

    /// The frontend finished writing for flush `id`.
    pub fn answer(&self, id: u64) {
        let mut inner = self.lock();
        inner.answered = inner.answered.max(id);
        self.answered.notify_all();
    }

    /// Wait until flush `id` is answered or `timeout` passes. Returns whether
    /// it was answered.
    pub fn wait(&self, id: u64, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut inner = self.lock();
        while inner.answered < id {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            inner = self
                .answered
                .wait_timeout(inner, deadline - now)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        true
    }

    /// Let every quit from now on go through.
    ///
    /// This is permanent on purpose: the quit carried out after a flush
    /// (closing the window, then the exit that follows the last window) must
    /// not be held again. It relies on nothing cancelling that close, which is
    /// why the frontend has no close-requested listener of its own. Anything
    /// that starts cancelling it must put the phase back to `Running`, or
    /// later quits would skip the flush.
    pub fn release(&self) {
        self.lock().phase = Phase::Released;
    }
}

/// What to do once the frontend has written the workspace.
#[derive(Debug, Clone)]
pub enum After {
    Exit(i32),
    CloseWindow(String),
}

/// Called for a quit request. Returns true when the caller must prevent it:
/// the workspace is being written and the quit is carried out afterwards.
pub fn hold_for_flush(app: &AppHandle, after: After) -> bool {
    let Some(state) = app.try_state::<QuitFlush>() else {
        return false;
    };
    let id = match state.begin() {
        Begin::Proceed => return false,
        Begin::Hold => return true,
        Begin::Flush(id) => id,
    };
    if let Err(e) = app.emit(FLUSH_EVENT, id) {
        log::warn!("[quit] could not ask the frontend to save the workspace: {e}");
        state.release();
        return false;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.state::<QuitFlush>();
        let started = Instant::now();
        let answered = state.wait(id, FLUSH_TIMEOUT);
        log::info!(
            "[quit] workspace {} after {} ms; now {:?}",
            if answered { "saved" } else { "save timed out" },
            started.elapsed().as_millis(),
            after
        );
        state.release();
        match after {
            After::Exit(code) => app.exit(code),
            After::CloseWindow(label) => match app.get_webview_window(&label) {
                Some(window) => {
                    if let Err(e) = window.close() {
                        log::warn!("[quit] could not close window '{label}': {e}");
                    }
                }
                None => app.exit(0),
            },
        }
    });
    true
}

/// The quit menu item: save the workspace, then exit.
pub fn quit(app: &AppHandle) {
    if !hold_for_flush(app, After::Exit(0)) {
        app.exit(0);
    }
}

/// The frontend listens for `FLUSH_EVENT` from now on.
#[tauri::command]
pub fn workspace_flush_ready(state: tauri::State<'_, QuitFlush>) {
    state.frontend_ready();
}

/// The frontend wrote the workspace for flush `id`.
#[tauri::command]
pub fn workspace_flush_done(state: tauri::State<'_, QuitFlush>, id: u64) {
    state.answer(id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn quits_at_once_while_no_frontend_listens() {
        let flush = QuitFlush::default();
        assert_eq!(flush.begin(), Begin::Proceed);
        // Once decided, a later listener does not hold the exit that follows.
        flush.frontend_ready();
        assert_eq!(flush.begin(), Begin::Proceed);
    }

    #[test]
    fn holds_the_first_quit_and_every_quit_during_the_flush() {
        let flush = QuitFlush::default();
        flush.frontend_ready();
        assert_eq!(flush.begin(), Begin::Flush(1));
        assert_eq!(flush.begin(), Begin::Hold);
        assert_eq!(flush.begin(), Begin::Hold);
        flush.release();
        assert_eq!(flush.begin(), Begin::Proceed);
    }

    #[test]
    fn wait_returns_once_the_frontend_answers() {
        let flush = Arc::new(QuitFlush::default());
        flush.frontend_ready();
        let Begin::Flush(id) = flush.begin() else {
            panic!("expected a flush")
        };
        let answering = Arc::clone(&flush);
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            answering.answer(id);
        });
        let started = Instant::now();
        assert!(flush.wait(id, Duration::from_secs(5)));
        assert!(started.elapsed() < Duration::from_secs(2));
        t.join().unwrap();
    }

    #[test]
    fn wait_gives_up_after_the_timeout() {
        let flush = QuitFlush::default();
        flush.frontend_ready();
        let Begin::Flush(id) = flush.begin() else {
            panic!("expected a flush")
        };
        let started = Instant::now();
        assert!(!flush.wait(id, Duration::from_millis(80)));
        let waited = started.elapsed();
        assert!(waited >= Duration::from_millis(80), "{waited:?}");
        assert!(waited < Duration::from_secs(2), "{waited:?}");
    }

    #[test]
    fn an_old_answer_does_not_count_for_a_newer_flush() {
        let flush = QuitFlush::default();
        flush.answer(0);
        assert!(!flush.wait(1, Duration::from_millis(10)));
        flush.answer(3);
        assert!(flush.wait(2, Duration::from_millis(10)));
    }
}
