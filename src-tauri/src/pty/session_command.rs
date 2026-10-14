//! One of the agent's own commands, run from the session action bar.
//!
//! The person clicks a chip ("Compact", "Review") or picks a command in the
//! Commands list; the frontend asks here to type that one visible line at
//! the agent's prompt and press Enter (DESIGN_PRINCIPLES: the only allowed
//! write is one visible line the person triggers). It goes out only when it
//! cannot hurt:
//!
//! - an agent holds the terminal (not the shell: it would run as a shell
//!   command once the agent has exited),
//! - the agent waits (not mid-turn: the line would be queued or lost):
//!   the agent itself said so (its turn-end hook, as the frontend's status
//!   reads it, `reported_waiting`), or its output has been quiet long enough
//!   for the terminal's own guess to say it waits,
//! - the person has no text on the line (`typed_line`): the old quick
//!   actions erased a draft with Backspaces and typed over it; nothing here
//!   ever sends Backspace, so a draft is never touched.
//!
//! Otherwise nothing is written and the answer says why, so the bar can tell
//! the person ("Finish or clear your message first"). The line goes out the
//! way the attach nudge does (`PtyManager::submit_line`): a bracketed paste
//! then Enter when the agent turned bracketed paste on, else the text and
//! then Enter as a write of its own.

use serde::Serialize;
use tauri::State;

use crate::pty::{PtyManager, SessionPhase};
use crate::AppState;

/// What became of a command the person asked to run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandOutcome {
    /// Typed at the agent's prompt with Enter.
    Sent,
    /// The agent is working: nothing was typed.
    Busy,
    /// The person has text on the line: nothing was typed.
    Draft,
    /// No agent holds the terminal (none started, or it exited).
    NoAgent,
}

/// What the gate needs to know about a session at the moment of the click.
#[derive(Debug, Clone, Copy)]
pub(crate) struct CommandGate {
    /// The session runs an agent (started by Hermes or recognised).
    pub agent: bool,
    /// The shell holds the terminal: the agent is not there to read a line.
    pub shell_at_prompt: bool,
    /// The agent reported that it waits (an exact or signalled status), or
    /// its output is quiet and its phase is waiting or idle.
    pub waiting: bool,
    /// The person has typed text on the line and not entered it.
    pub line_pending: bool,
}

impl CommandGate {
    /// Why the line must not be typed now, or None when it may.
    pub(crate) fn refusal(self) -> Option<CommandOutcome> {
        if !self.agent || self.shell_at_prompt {
            return Some(CommandOutcome::NoAgent);
        }
        if !self.waiting {
            return Some(CommandOutcome::Busy);
        }
        if self.line_pending {
            return Some(CommandOutcome::Draft);
        }
        None
    }
}

/// The longest command line accepted (catalog ids are at most 64; a
/// discovered command's name and a namespace stay well under this).
const MAX_LINE: usize = 200;

/// One command line: a slash command or a `$skill`, no control characters
/// (no Enter, no escape sequence, no Backspace), not too long.
pub(crate) fn is_command_line(line: &str) -> bool {
    let first = line.chars().next();
    matches!(first, Some('/') | Some('$'))
        && line.len() > 1
        && line.len() <= MAX_LINE
        && line.trim() == line
        && !line.chars().any(char::is_control)
}

impl PtyManager {
    /// Type `line` at the agent's prompt with Enter, when it is safe (see
    /// the module docs); otherwise write nothing and say why.
    pub fn run_session_command(
        &self,
        session_id: &str,
        line: &str,
        reported_waiting: bool,
    ) -> Result<CommandOutcome, String> {
        if !is_command_line(line) {
            return Err("Not a command line".to_string());
        }
        let Some(pty) = self.sessions.get(session_id) else {
            return Ok(CommandOutcome::NoAgent);
        };
        // The analyzer first, then the session: the reader thread takes them
        // in that order.
        let (quiet, line_pending, bracketed_paste) = pty
            .analyzer
            .lock()
            .map(|a| (!a.is_busy, a.typed_line.pending(), a.bracketed_paste))
            .map_err(|e| e.to_string())?;
        let (agent, waiting_phase) = {
            let s = pty.session.lock().map_err(|e| e.to_string())?;
            (
                s.detected_agent.is_some() || s.ai_provider.is_some(),
                matches!(s.phase, SessionPhase::NeedsInput | SessionPhase::Idle),
            )
        };
        let gate = CommandGate {
            agent,
            // Asked only for an agent session (it reads the process table).
            shell_at_prompt: agent && Self::shell_has_terminal(pty),
            waiting: reported_waiting || (quiet && waiting_phase),
            line_pending,
        };
        if let Some(refusal) = gate.refusal() {
            return Ok(refusal);
        }
        Self::submit_line(&pty.writer, line, bracketed_paste).map_err(|e| e.to_string())?;
        Ok(CommandOutcome::Sent)
    }
}

/// Run one of the agent's commands in a terminal session (the session
/// action bar, the Commands list, the command palette). `reported_waiting`:
/// the agent's own report (not a guess) says it waits at its prompt.
#[tauri::command]
pub fn run_session_command(
    state: State<'_, AppState>,
    session_id: String,
    line: String,
    reported_waiting: Option<bool>,
) -> Result<CommandOutcome, String> {
    let mgr = state.pty_manager.lock().unwrap_or_else(|e| e.into_inner());
    mgr.run_session_command(&session_id, &line, reported_waiting.unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate(agent: bool, shell: bool, waiting: bool, pending: bool) -> Option<CommandOutcome> {
        CommandGate {
            agent,
            shell_at_prompt: shell,
            waiting,
            line_pending: pending,
        }
        .refusal()
    }

    #[test]
    fn only_a_waiting_agent_with_an_empty_line_gets_the_command() {
        assert_eq!(gate(true, false, true, false), None);
        assert_eq!(gate(true, false, true, true), Some(CommandOutcome::Draft));
        assert_eq!(gate(true, false, false, false), Some(CommandOutcome::Busy));
        // Busy and a draft typed ahead: busy (the chip is disabled anyway).
        assert_eq!(gate(true, false, false, true), Some(CommandOutcome::Busy));
        // The agent exited: the shell would run it.
        assert_eq!(gate(true, true, true, false), Some(CommandOutcome::NoAgent));
        assert_eq!(
            gate(false, false, true, false),
            Some(CommandOutcome::NoAgent)
        );
    }

    #[test]
    fn a_command_line_is_one_line_with_no_keys_in_it() {
        for ok in [
            "/compact",
            "/context show",
            "$review-pr",
            "/frontend:component",
        ] {
            assert!(is_command_line(ok), "{ok}");
        }
        for bad in [
            "",
            "/",
            "compact",
            "/compact\r",
            "/compact\n",
            "\x7f\x7f/compact",
            "/compact\x1b[201~",
            " /compact",
            "/compact ",
            &format!("/{}", "a".repeat(MAX_LINE)),
        ] {
            assert!(!is_command_line(bad), "{bad:?}");
        }
    }
}
