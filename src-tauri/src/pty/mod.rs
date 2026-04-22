pub mod adapters;
pub mod analyzer;
pub mod commands;
pub mod models;
pub mod patterns;
pub mod shell_integration;
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
    /// Path to the PTY slave device (e.g., /dev/ttys042).
    /// Used on macOS to send SIGINT directly to the foreground process group
    /// when the PTY line discipline fails to convert \x03 into a signal.
    #[cfg(target_os = "macos")]
    pub(crate) tty_path: Option<std::path::PathBuf>,
    /// Shell integration state — tracks temp files for cleanup on session close.
    pub(crate) shell_integration: shell_integration::ShellIntegration,
}

pub struct PtyManager {
    pub(crate) sessions: HashMap<String, PtySession>,
    pub(crate) session_counter: usize,
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
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

pub(crate) fn ai_launch_command(
    provider: &str,
    permission_mode: &str,
    custom_prefix: &str,
    custom_suffix: &str,
) -> Option<String> {
    let base = match provider {
        "claude" => "claude",
        "aider" => "aider",
        "codex" => "codex",
        "gemini" => "gemini",
        "kiro" => "kiro-cli",
        "copilot" => {
            return Some(wrap_prefix_suffix(
                "gh copilot",
                custom_prefix,
                custom_suffix,
            ))
        }
        _ => return None,
    };
    let mut cmd = base.to_string();
    let flag = match (provider, permission_mode) {
        ("claude", "acceptEdits") => " --permission-mode acceptEdits",
        ("claude", "plan") => " --permission-mode plan",
        ("claude", "auto") => " --permission-mode auto",
        ("claude", "dontAsk") => " --permission-mode dontAsk",
        ("claude", "bypassPermissions") => " --permission-mode bypassPermissions",
        ("aider", "auto") => " --yes",
        ("aider", "bypassPermissions") => " --yes-always",
        ("codex", "auto") => " --full-auto",
        ("codex", "bypassPermissions") => " --dangerously-bypass-approvals-and-sandbox",
        ("gemini", "bypassPermissions") => " --yolo",
        ("kiro", "auto") => " --trust-tools",
        _ => "",
    };
    cmd.push_str(flag);
    Some(wrap_prefix_suffix(&cmd, custom_prefix, custom_suffix))
}

/// Sanitize a user-supplied prefix/suffix: strip newlines (defense against
/// pasted multi-line commands) and trim surrounding whitespace. Embedded shell
/// metacharacters (`&&`, `|`, backticks, `$(…)`) are intentionally allowed —
/// same trust model as a command typed at the shell prompt.
fn sanitize_wrap(fragment: &str) -> String {
    fragment.replace(['\n', '\r'], " ").trim().to_string()
}

fn wrap_prefix_suffix(cmd: &str, custom_prefix: &str, custom_suffix: &str) -> String {
    let prefix = sanitize_wrap(custom_prefix);
    let suffix = sanitize_wrap(custom_suffix);
    let mut out = String::new();
    if !prefix.is_empty() {
        out.push_str(&prefix);
        out.push(' ');
    }
    out.push_str(cmd);
    if !suffix.is_empty() {
        out.push(' ');
        out.push_str(&suffix);
    }
    out
}

/// Build the `--channels` suffix for Claude sessions.
/// Returned separately so it can be appended AFTER the prompt argument
/// (Claude CLI treats positional args after --channels as channel entries).
pub(crate) fn channels_suffix(channels: &[String]) -> String {
    let mut suffix = String::new();
    for ch in channels {
        suffix.push_str(&format!(" --channels {}", ch));
    }
    suffix
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

    // ── Prompt detection: start-of-line custom chars ──

    #[test]
    fn detects_prompt_chars_at_start_of_line() {
        // oh-my-zsh robbyrussell theme
        assert!(is_shell_prompt("➜  my-project git:(main) "));
        assert!(is_shell_prompt("➜  ~ "));
        // powerlevel10k / starship with leading indicator
        assert!(is_shell_prompt("❯ "));
        assert!(is_shell_prompt("❯ ~/code"));
    }

    #[test]
    fn detects_custom_prompt_formats() {
        // Bare prompt chars
        assert!(is_shell_prompt("➜ "));
        assert!(is_shell_prompt("❯"));
        // Path context with prompt char at end
        assert!(is_shell_prompt("~/projects ❯"));
        assert!(is_shell_prompt("user@host ~/code ➜"));
        // PS1 variants ending with $
        assert!(is_shell_prompt("user@host:~/code$ "));
    }

    // ── Auto-launch lifecycle ──

    #[test]
    fn pending_ai_launch_set_on_first_prompt() {
        let mut analyzer = OutputAnalyzer::new();
        // Simulate an AI session: set ai_provider info
        analyzer.pending_ai_launch = false;
        analyzer.shell_ready = false;

        // Feed a shell prompt line
        let analysis = LineAnalysis {
            token_update: None,
            tool_call: None,
            action: None,
            phase_hint: Some(PhaseHint::PromptDetected),
            memory_fact: None,
        };
        analyzer.apply_analysis(analysis);
        // First prompt should set shell_ready and pending_ai_launch
        assert!(analyzer.shell_ready);
        assert!(analyzer.pending_ai_launch);
    }

    #[test]
    fn pending_ai_launch_not_set_without_prompt() {
        let mut analyzer = OutputAnalyzer::new();
        analyzer.pending_ai_launch = false;
        analyzer.shell_ready = false;

        // Feed a work-started hint (not a prompt)
        let analysis = LineAnalysis {
            token_update: None,
            tool_call: None,
            action: None,
            phase_hint: Some(PhaseHint::WorkStarted),
            memory_fact: None,
        };
        analyzer.apply_analysis(analysis);
        assert!(!analyzer.shell_ready);
        assert!(!analyzer.pending_ai_launch);
    }

    #[test]
    fn pending_ai_launch_not_set_on_subsequent_prompts() {
        let mut analyzer = OutputAnalyzer::new();
        analyzer.shell_ready = false;

        // First prompt
        let analysis = LineAnalysis {
            token_update: None,
            tool_call: None,
            action: None,
            phase_hint: Some(PhaseHint::PromptDetected),
            memory_fact: None,
        };
        analyzer.apply_analysis(analysis);
        assert!(analyzer.pending_ai_launch);

        // Consume the flag
        analyzer.pending_ai_launch = false;

        // Second prompt should NOT re-set pending_ai_launch
        let analysis2 = LineAnalysis {
            token_update: None,
            tool_call: None,
            action: None,
            phase_hint: Some(PhaseHint::PromptDetected),
            memory_fact: None,
        };
        analyzer.apply_analysis(analysis2);
        assert!(!analyzer.pending_ai_launch);
    }

    #[test]
    fn pending_ai_launch_from_ohmyzsh_prompt() {
        // Verify the prompt detection works for oh-my-zsh
        assert!(is_shell_prompt("➜  my-project git:(main) "));
    }

    #[test]
    fn pending_ai_launch_from_starship_prompt() {
        // Verify the prompt detection works for starship
        assert!(is_shell_prompt("~/code ❯"));
        assert!(is_shell_prompt("~/projects ➤"));
    }

    // ── Silence fallback ──

    #[test]
    fn silence_fallback_triggers_ai_launch() {
        let mut analyzer = OutputAnalyzer::new();
        analyzer.is_busy = true;
        analyzer.shell_ready = false;

        analyzer.check_silence();

        assert!(analyzer.shell_ready);
        assert!(analyzer.pending_ai_launch);
        assert!(!analyzer.is_busy);
        assert!(matches!(
            analyzer.pending_phase,
            Some(SessionPhase::ShellReady)
        ));
    }

    #[test]
    fn silence_fallback_does_not_retrigger() {
        let mut analyzer = OutputAnalyzer::new();
        analyzer.is_busy = true;
        analyzer.shell_ready = false;

        // First silence → triggers fallback
        analyzer.check_silence();
        assert!(analyzer.pending_ai_launch);

        // Consume flag, make busy again
        analyzer.pending_ai_launch = false;
        analyzer.is_busy = true;

        // Second silence — shell_ready is already true, so fallback should NOT fire
        analyzer.check_silence();
        assert!(!analyzer.pending_ai_launch);
    }

    #[test]
    fn rapid_output_before_prompt_no_premature_launch() {
        let mut analyzer = OutputAnalyzer::new();
        analyzer.shell_ready = false;

        // Simulate rapid output (work started, not a prompt)
        for _ in 0..10 {
            let analysis = LineAnalysis {
                token_update: None,
                tool_call: None,
                action: None,
                phase_hint: Some(PhaseHint::WorkStarted),
                memory_fact: None,
            };
            analyzer.apply_analysis(analysis);
        }
        // No prompt seen → no auto-launch
        assert!(!analyzer.shell_ready);
        assert!(!analyzer.pending_ai_launch);
    }

    // ── AI launch command coverage ──

    #[test]
    fn ai_launch_command_default_mode() {
        use super::ai_launch_command;

        assert_eq!(
            ai_launch_command("claude", "default", "", ""),
            Some("claude".into())
        );
        assert_eq!(
            ai_launch_command("aider", "default", "", ""),
            Some("aider".into())
        );
        assert_eq!(
            ai_launch_command("codex", "default", "", ""),
            Some("codex".into())
        );
        assert_eq!(
            ai_launch_command("gemini", "default", "", ""),
            Some("gemini".into())
        );
        assert_eq!(
            ai_launch_command("copilot", "default", "", ""),
            Some("gh copilot".into())
        );
        assert_eq!(
            ai_launch_command("kiro", "default", "", ""),
            Some("kiro-cli".into())
        );
        assert_eq!(ai_launch_command("unknown", "default", "", ""), None);
    }

    #[test]
    fn ai_launch_command_permission_modes() {
        use super::ai_launch_command;

        // Claude supports all modes
        assert_eq!(
            ai_launch_command("claude", "acceptEdits", "", ""),
            Some("claude --permission-mode acceptEdits".into())
        );
        assert_eq!(
            ai_launch_command("claude", "plan", "", ""),
            Some("claude --permission-mode plan".into())
        );
        assert_eq!(
            ai_launch_command("claude", "auto", "", ""),
            Some("claude --permission-mode auto".into())
        );
        assert_eq!(
            ai_launch_command("claude", "bypassPermissions", "", ""),
            Some("claude --permission-mode bypassPermissions".into())
        );

        // Claude dontAsk mode
        assert_eq!(
            ai_launch_command("claude", "dontAsk", "", ""),
            Some("claude --permission-mode dontAsk".into())
        );

        // Other providers: auto and bypass modes
        assert_eq!(
            ai_launch_command("aider", "auto", "", ""),
            Some("aider --yes".into())
        );
        assert_eq!(
            ai_launch_command("aider", "bypassPermissions", "", ""),
            Some("aider --yes-always".into())
        );
        assert_eq!(
            ai_launch_command("codex", "auto", "", ""),
            Some("codex --full-auto".into())
        );
        assert_eq!(
            ai_launch_command("codex", "bypassPermissions", "", ""),
            Some("codex --dangerously-bypass-approvals-and-sandbox".into())
        );
        assert_eq!(
            ai_launch_command("gemini", "bypassPermissions", "", ""),
            Some("gemini --yolo".into())
        );

        // Kiro: auto mode uses --trust-tools
        assert_eq!(
            ai_launch_command("kiro", "auto", "", ""),
            Some("kiro-cli --trust-tools".into())
        );

        // Unsupported modes fall back to no flag
        assert_eq!(
            ai_launch_command("aider", "plan", "", ""),
            Some("aider".into())
        );
        assert_eq!(
            ai_launch_command("copilot", "bypassPermissions", "", ""),
            Some("gh copilot".into())
        );
    }

    #[test]
    fn ai_launch_command_custom_suffix() {
        use super::ai_launch_command;

        assert_eq!(
            ai_launch_command("claude", "default", "", "--model opus"),
            Some("claude --model opus".into())
        );
        assert_eq!(
            ai_launch_command("claude", "plan", "", "--verbose"),
            Some("claude --permission-mode plan --verbose".into())
        );
        // Suffix is trimmed
        assert_eq!(
            ai_launch_command("aider", "default", "", "  --dark-mode  "),
            Some("aider --dark-mode".into())
        );
        // Empty suffix
        assert_eq!(
            ai_launch_command("claude", "default", "", "   "),
            Some("claude".into())
        );
    }

    #[test]
    fn ai_launch_command_custom_prefix() {
        use super::ai_launch_command;

        // macOS: caffeinate wrapper
        assert_eq!(
            ai_launch_command("claude", "default", "caffeinate -i", ""),
            Some("caffeinate -i claude".into())
        );
        // Prefix + permission flag
        assert_eq!(
            ai_launch_command("claude", "acceptEdits", "caffeinate -i", ""),
            Some("caffeinate -i claude --permission-mode acceptEdits".into())
        );
        // Windows: wsl wrapper
        assert_eq!(
            ai_launch_command("claude", "default", "wsl", ""),
            Some("wsl claude".into())
        );
        // Linux: nice wrapper
        assert_eq!(
            ai_launch_command("gemini", "default", "nice -n 10", ""),
            Some("nice -n 10 gemini".into())
        );
        // Copilot (has special wrapping) supports prefix
        assert_eq!(
            ai_launch_command("copilot", "default", "caffeinate -i", ""),
            Some("caffeinate -i gh copilot".into())
        );
        // Prefix is trimmed
        assert_eq!(
            ai_launch_command("claude", "default", "  caffeinate -i  ", ""),
            Some("caffeinate -i claude".into())
        );
        // Embedded newlines/CR are stripped (defense against paste-a-second-command)
        assert_eq!(
            ai_launch_command("claude", "default", "caffeinate -i\nrm -rf /", ""),
            Some("caffeinate -i rm -rf / claude".into())
        );
        // Empty prefix ⇒ byte-identical to no-prefix case
        assert_eq!(
            ai_launch_command("claude", "default", "   ", ""),
            ai_launch_command("claude", "default", "", "")
        );
    }

    #[test]
    fn ai_launch_command_prefix_and_suffix() {
        use super::ai_launch_command;

        // Both prefix and suffix: prefix wraps the binary, suffix appends flags
        assert_eq!(
            ai_launch_command("claude", "acceptEdits", "caffeinate -i", "--model opus"),
            Some("caffeinate -i claude --permission-mode acceptEdits --model opus".into())
        );
        // Only suffix, no prefix
        assert_eq!(
            ai_launch_command("claude", "default", "", "--model opus"),
            Some("claude --model opus".into())
        );
        // Only prefix, no suffix
        assert_eq!(
            ai_launch_command("claude", "default", "caffeinate -i", ""),
            Some("caffeinate -i claude".into())
        );
        // Both trimmed
        assert_eq!(
            ai_launch_command("aider", "default", "  nice -n 10  ", "  --dark-mode  "),
            Some("nice -n 10 aider --dark-mode".into())
        );
        // Copilot with both
        assert_eq!(
            ai_launch_command("copilot", "default", "wsl", "--debug"),
            Some("wsl gh copilot --debug".into())
        );
    }

    // ── Consistency guard: every registered provider must have a launch command ──

    #[test]
    fn every_ai_cli_provider_has_launch_command() {
        use super::ai_launch_command;
        use crate::platform::AI_CLI_PROVIDERS;

        for (provider_id, binary_name) in AI_CLI_PROVIDERS {
            let result = ai_launch_command(provider_id, "default", "", "");
            assert!(
                result.is_some(),
                "AI_CLI_PROVIDERS has '{}' (binary '{}') but ai_launch_command returns None for it. \
                 Add '\"{}\"' to the match in ai_launch_command().",
                provider_id,
                binary_name,
                provider_id
            );
        }
    }

    #[test]
    fn every_ai_cli_provider_has_adapter_in_registry() {
        use super::adapters::ProviderRegistry;
        use crate::platform::AI_CLI_PROVIDERS;

        let registry = ProviderRegistry::new();

        // Realistic detection strings for each provider — these mimic actual CLI output.
        let detection_lines: std::collections::HashMap<&str, &str> = [
            ("claude", "╭ Claude Code v2.1.0"),
            ("aider", "Aider v0.86.0"),
            ("codex", "OpenAI Codex v0.98.0"),
            ("gemini", "Gemini CLI v1.0.0"),
            ("copilot", "GitHub Copilot CLI"),
            ("kiro", "kiro-cli chat"),
        ]
        .into_iter()
        .collect();

        for (provider_id, _) in AI_CLI_PROVIDERS {
            let test_line = detection_lines.get(provider_id).unwrap_or_else(|| {
                panic!(
                    "No detection test line defined for provider '{}'. \
                     Add an entry to the detection_lines map in this test.",
                    provider_id
                )
            });
            let detected = registry.detect_agent(test_line);
            assert!(
                detected.is_some(),
                "No adapter in ProviderRegistry detects '{}' for provider '{}'. \
                 Add an adapter to ProviderRegistry::new().",
                test_line,
                provider_id
            );
        }
    }

    // ── channels_suffix ────────────────────────────────────────────────

    #[test]
    fn test_channels_suffix_empty() {
        use super::channels_suffix;
        assert_eq!(channels_suffix(&[]), "");
    }

    #[test]
    fn test_channels_suffix_single() {
        use super::channels_suffix;
        let s = channels_suffix(&["plugin:telegram@claude-plugins-official".to_string()]);
        assert_eq!(s, " --channels plugin:telegram@claude-plugins-official");
    }

    #[test]
    fn test_channels_suffix_multiple() {
        use super::channels_suffix;
        let channels = vec![
            "plugin:telegram@foo".to_string(),
            "plugin:slack@bar".to_string(),
        ];
        assert_eq!(
            channels_suffix(&channels),
            " --channels plugin:telegram@foo --channels plugin:slack@bar"
        );
    }

    #[test]
    fn test_full_claude_command_with_prompt_and_channels() {
        use super::{ai_launch_command, channels_suffix};
        // Simulate the call-site pattern: base + prompt + channels
        let base = ai_launch_command("claude", "bypassPermissions", "", "").unwrap();
        let prompt = format!("{} \"Read context\"", base);
        let channels = vec!["plugin:telegram@claude-plugins-official".to_string()];
        let full = format!("{}{}", prompt, channels_suffix(&channels));
        assert_eq!(full, "claude --permission-mode bypassPermissions \"Read context\" --channels plugin:telegram@claude-plugins-official");
    }

    // ── Prompt detection after column fix ──

    #[test]
    fn prompt_detection_after_column_fix() {
        // With PROMPT_EOL_MARK="" set, the "%" partial-line marker is gone.
        // Verify that actual prompts are still detected.
        assert!(is_shell_prompt("user@host:~$ "));
        assert!(is_shell_prompt("% "));
        assert!(is_shell_prompt("➜  project git:(main) "));
        assert!(is_shell_prompt("~/code ❯"));

        // "%" alone is a valid bare zsh prompt — it should still match.
        assert!(is_shell_prompt("%"));
    }
}
