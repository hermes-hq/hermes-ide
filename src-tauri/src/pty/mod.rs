pub mod adapters;
pub mod analyzer;
pub mod commands;
pub mod models;
pub mod patterns;
pub mod spawn;

// ─── Re-exports ─────────────────────────────────────────────────────
// Maintain the existing public API so that `lib.rs`, `db/mod.rs`, and other
// files importing from `crate::pty::*` continue to work without changes.

pub use models::*;
// Re-export all commands including hidden Tauri `__cmd__*` items
// so that `lib.rs` can reference them as `pty::create_session` etc.
pub use commands::*;

use portable_pty::MasterPty;
use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex as StdMutex};

use crate::pty::analyzer::OutputAnalyzer;

// ─── PTY Session & Manager ──────────────────────────────────────────

pub(crate) struct PtySession {
    pub(crate) master: Box<dyn MasterPty + Send>,
    pub(crate) writer: Arc<StdMutex<Box<dyn Write + Send>>>,
    pub(crate) session: Arc<StdMutex<Session>>,
    pub(crate) analyzer: Arc<StdMutex<OutputAnalyzer>>,
    pub(crate) child: Box<dyn portable_pty::Child + Send>,
}

pub struct PtyManager {
    pub(crate) sessions: HashMap<String, PtySession>,
    pub(crate) session_counter: usize,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            session_counter: 0,
        }
    }

    /// Send a lightweight context nudge to a session's PTY if an AI agent is detected.
    /// Returns true if the nudge was sent.
    /// Send a versioned context nudge to a session's PTY.
    /// Deduplicates by tracking last_nudged_version on the Session.
    ///
    /// If the agent is busy (phase != NeedsInput), the nudge is stored as
    /// `pending_nudge` on the Session and delivered later by the reader loop
    /// when the phase transitions to NeedsInput.
    ///
    /// Returns (nudge_sent, error_message).
    pub fn send_versioned_nudge(
        &self,
        session_id: &str,
        version: i64,
        file_path: &str,
    ) -> (bool, Option<String>) {
        let pty = match self.sessions.get(session_id) {
            Some(p) => p,
            None => return (false, Some("Session not found in PTY manager".to_string())),
        };

        let mut session_guard = match pty.session.lock() {
            Ok(g) => g,
            Err(e) => return (false, Some(format!("Session lock failed: {}", e))),
        };

        // Only nudge if an AI agent has been detected — otherwise we'd send
        // a message to a raw shell which would try to execute it as a command.
        if session_guard.detected_agent.is_none() {
            return (false, Some("No AI agent detected in session".to_string()));
        }

        // Dedup: skip if already nudged for this version
        if session_guard.last_nudged_version >= version {
            return (true, None);
        }

        // Only send the nudge when the agent is waiting for input.
        // If the agent is busy, defer and deliver when it next becomes idle.
        if session_guard.phase != SessionPhase::NeedsInput {
            session_guard.pending_nudge = Some(PendingNudge {
                version,
                file_path: file_path.to_string(),
            });
            return (
                false,
                Some("Agent busy — nudge deferred until idle".to_string()),
            );
        }

        Self::write_nudge(pty, &mut session_guard, version, file_path)
    }

    /// Format and write a nudge message to the PTY.
    fn write_nudge(
        pty: &PtySession,
        session: &mut Session,
        version: i64,
        file_path: &str,
    ) -> (bool, Option<String>) {
        let provider_name = session
            .detected_agent
            .as_ref()
            .map(|a| a.name.clone())
            .unwrap_or_default();

        let nudge_msg = match provider_name.to_lowercase().as_str() {
            "aider" => format!("/read {}\r", file_path),
            "claude" | "claude code" | "claude-code" | "anthropic" => format!(
                "Read the file at {} — it contains updated project context (v{}).\r",
                file_path, version
            ),
            "copilot" | "github-copilot" => format!(
                "@workspace Context updated to v{}. The context file is at {}.\r",
                version, file_path
            ),
            _ => format!(
                "Context updated to v{}. Read the file at {} for project context.\r",
                version, file_path
            ),
        };

        match pty.writer.lock() {
            Ok(mut w) => match w.write_all(nudge_msg.as_bytes()) {
                Ok(_) => {
                    let _ = w.flush();
                    session.last_nudged_version = version;
                    (true, None)
                }
                Err(e) => (false, Some(format!("Write failed: {}", e))),
            },
            Err(e) => (false, Some(format!("Writer lock failed: {}", e))),
        }
    }

    /// Deliver a pending nudge using a standalone writer reference
    /// (for use inside the reader thread which doesn't have PtySession).
    pub(crate) fn deliver_pending_nudge_with_writer(
        writer: &Arc<StdMutex<Box<dyn Write + Send>>>,
        session: &mut Session,
    ) {
        if let Some(nudge) = session.pending_nudge.take() {
            if session.last_nudged_version >= nudge.version {
                return;
            }

            let provider_name = session
                .detected_agent
                .as_ref()
                .map(|a| a.name.clone())
                .unwrap_or_default();

            let nudge_msg = match provider_name.to_lowercase().as_str() {
                "aider" => format!("/read {}\r", nudge.file_path),
                "claude" | "claude code" | "claude-code" | "anthropic" => format!(
                    "Read the file at {} — it contains updated project context (v{}).\r",
                    nudge.file_path, nudge.version
                ),
                "copilot" | "github-copilot" => format!(
                    "@workspace Context updated to v{}. The context file is at {}.\r",
                    nudge.version, nudge.file_path
                ),
                _ => format!(
                    "Context updated to v{}. Read the file at {} for project context.\r",
                    nudge.version, nudge.file_path
                ),
            };

            if let Ok(mut w) = writer.lock() {
                if w.write_all(nudge_msg.as_bytes()).is_ok() {
                    let _ = w.flush();
                    session.last_nudged_version = nudge.version;
                }
            }
        }
    }
}

// ─── Helper Functions ───────────────────────────────────────────────

pub(crate) fn ai_launch_command(provider: &str, auto_approve: bool) -> Option<String> {
    let base = match provider {
        "claude" => "claude",
        "aider" => "aider",
        "codex" => "codex",
        "gemini" => "gemini",
        "copilot" => return Some("gh copilot".to_string()),
        _ => return None,
    };
    if auto_approve {
        let flag = match provider {
            "claude" => " --dangerously-skip-permissions",
            "aider" => " --yes",
            "codex" => " --full-auto",
            "gemini" => " --yolo",
            _ => "",
        };
        Some(format!("{}{}", base, flag))
    } else {
        Some(base.to_string())
    }
}

pub(crate) fn detect_shell() -> String {
    #[cfg(unix)]
    {
        std::env::var("SHELL").unwrap_or_else(|_| {
            // Prefer zsh on macOS, bash on Linux
            if cfg!(target_os = "macos") {
                "/bin/zsh".to_string()
            } else {
                "/bin/bash".to_string()
            }
        })
    }

    #[cfg(windows)]
    {
        // Try PowerShell first, then fall back to cmd.exe
        if crate::platform::command_exists("pwsh") {
            "pwsh".to_string()
        } else if crate::platform::command_exists("powershell") {
            "powershell".to_string()
        } else {
            std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
        }
    }
}

pub(crate) fn get_working_directory() -> String {
    crate::platform::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| {
            #[cfg(windows)]
            {
                std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".to_string())
            }
            #[cfg(not(windows))]
            {
                "/".to_string()
            }
        })
}

// ─── Tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::adapters::{is_input_needed_line, is_shell_prompt, LineAnalysis, PhaseHint};
    use super::analyzer::OutputAnalyzer;
    use super::models::SessionPhase;

    // ── is_input_needed_line ──

    #[test]
    fn detects_claude_permission_prompt() {
        assert!(is_input_needed_line("? Allow Bash(npm run build)"));
        assert!(is_input_needed_line("? Allow Read(src/main.rs)"));
        assert!(is_input_needed_line("? Do you want to proceed?"));
        assert!(is_input_needed_line("? Allow Write to package.json"));
    }

    #[test]
    fn detects_yn_prompts() {
        assert!(is_input_needed_line("Overwrite file? (y/n)"));
        assert!(is_input_needed_line("Continue? (Y/n)"));
        assert!(is_input_needed_line("Are you sure? [y/N]"));
        assert!(is_input_needed_line("Proceed? (Yes/No)"));
        assert!(is_input_needed_line("Apply changes? [yes/no]"));
    }

    #[test]
    fn detects_allow_deny_prompts() {
        assert!(is_input_needed_line("Allow access to /tmp? (yes/no)"));
        assert!(is_input_needed_line("[Allow] or [Deny]?"));
        assert!(is_input_needed_line("Approve this action? (y/n)"));
    }

    #[test]
    fn rejects_normal_output() {
        assert!(!is_input_needed_line(""));
        assert!(!is_input_needed_line("> "));
        assert!(!is_input_needed_line("$ "));
        assert!(!is_input_needed_line("Hello world"));
        assert!(!is_input_needed_line("Building project..."));
        assert!(!is_input_needed_line("const x = 42;"));
        // Don't match bare "?" in long code lines
        assert!(!is_input_needed_line(
            "const isAllowed = user.role === 'admin' ? true : false;"
        ));
    }

    #[test]
    fn rejects_short_question_mark_lines() {
        // "? " alone with nothing after should not match (too short)
        assert!(!is_input_needed_line("? "));
        assert!(!is_input_needed_line("?"));
    }

    #[test]
    fn rejects_help_hints() {
        // Claude Code help hints like "? for shortcuts" are not permission prompts
        assert!(!is_input_needed_line("? for shortcuts"));
        assert!(!is_input_needed_line("? for help"));
        assert!(!is_input_needed_line("? to see commands"));
    }

    #[test]
    fn detects_question_word_prompts() {
        assert!(is_input_needed_line("Do you want to proceed?"));
        assert!(is_input_needed_line("Are you sure you want to continue?"));
        assert!(is_input_needed_line("Would you like to allow this?"));
        assert!(is_input_needed_line("Should this file be overwritten?"));
        assert!(is_input_needed_line("Can we proceed with the changes?"));
        // Non-question words ending with ? should not match
        assert!(!is_input_needed_line("Building project?"));
        assert!(!is_input_needed_line("Error?"));
    }

    #[test]
    fn detects_interactive_menu_indicators() {
        // Selection cursors (Claude Code, Copilot)
        assert!(is_input_needed_line("› 1. Yes"));
        assert!(is_input_needed_line("❯ Allow"));
        // Interactive UI footers
        assert!(is_input_needed_line("Esc to cancel · Tab to amend"));
        assert!(is_input_needed_line("  Esc to cancel"));
        // But not bare selection chars
        assert!(!is_input_needed_line("›"));
    }

    // ── is_shell_prompt ──

    #[test]
    fn detects_standard_shell_prompts() {
        assert!(is_shell_prompt("$ "));
        assert!(is_shell_prompt("user@host:~$ "));
        assert!(is_shell_prompt("% "));
        assert!(is_shell_prompt("~ ❯"));
    }

    #[test]
    fn rejects_non_prompts() {
        assert!(!is_shell_prompt("Hello world"));
        assert!(!is_shell_prompt("const x = 42;"));
        assert!(!is_shell_prompt(""));
    }

    // ── SessionPhase ──

    #[test]
    fn needs_input_phase_accepts_input() {
        assert!(SessionPhase::NeedsInput.accepts_input());
        assert!(SessionPhase::Idle.accepts_input());
        assert!(SessionPhase::Busy.accepts_input());
        assert!(!SessionPhase::Closing.accepts_input());
        assert!(!SessionPhase::Destroyed.accepts_input());
    }

    #[test]
    fn needs_input_phase_str() {
        assert_eq!(SessionPhase::NeedsInput.as_str(), "needs_input");
        assert_eq!(SessionPhase::Idle.as_str(), "idle");
        assert_eq!(SessionPhase::Busy.as_str(), "busy");
    }

    // ── PhaseHint in apply_analysis ──

    #[test]
    fn analyzer_transitions_to_needs_input() {
        let mut analyzer = OutputAnalyzer::new();
        analyzer.shell_ready = true; // Simulate past shell ready

        let analysis = LineAnalysis {
            token_update: None,
            tool_call: None,
            action: None,
            phase_hint: Some(PhaseHint::InputNeeded),
            memory_fact: None,
        };
        analyzer.apply_analysis(analysis);
        assert!(!analyzer.is_busy);
        assert!(matches!(
            analyzer.pending_phase,
            Some(SessionPhase::NeedsInput)
        ));
    }

    #[test]
    fn analyzer_transitions_to_idle_on_prompt() {
        let mut analyzer = OutputAnalyzer::new();
        analyzer.shell_ready = true;

        let analysis = LineAnalysis {
            token_update: None,
            tool_call: None,
            action: None,
            phase_hint: Some(PhaseHint::PromptDetected),
            memory_fact: None,
        };
        analyzer.apply_analysis(analysis);
        assert!(!analyzer.is_busy);
        assert!(matches!(analyzer.pending_phase, Some(SessionPhase::Idle)));
    }

    #[test]
    fn analyzer_transitions_to_busy_on_work() {
        let mut analyzer = OutputAnalyzer::new();
        analyzer.shell_ready = true;

        let analysis = LineAnalysis {
            token_update: None,
            tool_call: None,
            action: None,
            phase_hint: Some(PhaseHint::WorkStarted),
            memory_fact: None,
        };
        analyzer.apply_analysis(analysis);
        assert!(analyzer.is_busy);
        assert!(matches!(analyzer.pending_phase, Some(SessionPhase::Busy)));
    }
}
