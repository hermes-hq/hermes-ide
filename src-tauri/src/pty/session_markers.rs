//! The environment variables an agent session sets in the processes it
//! starts, which a session Hermes starts must never inherit.
//!
//! Hermes is often started from inside an agent session (a developer runs
//! it from a Claude Code terminal, or an agent builds and starts it). The
//! parent session marks its children — `CLAUDECODE=1`,
//! `CLAUDE_CODE_CHILD_SESSION=1`, its session id, its messaging socket —
//! and an agent that finds those marks in its own environment believes it
//! is nested: Claude Code, for one, then stops saving its transcript
//! ("Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION
//! marker"), so the conversation cannot be resumed. Every session Hermes
//! starts (a terminal's shell, the Agent view's runtime) is scrubbed of
//! these on every OS.

/// Whether `name` is a marker a parent agent session leaves for its
/// children. Exact names and the `CLAUDE_CODE_` family; a user's own
/// configuration (`ANTHROPIC_*`, `CLAUDE_CONFIG_DIR`) is not a marker.
pub fn is_session_marker(name: &str) -> bool {
    matches!(
        name,
        // Claude Code: the nesting flags, the parent's pid and effort.
        "CLAUDECODE" | "CLAUDE_CODE" | "CLAUDE_PID" | "CLAUDE_EFFORT"
        // Codex: the sandbox it runs its commands in.
        | "CODEX_SANDBOX" | "CODEX_SANDBOX_NETWORK_DISABLED"
    ) || name.starts_with("CLAUDE_CODE_")
}

/// The markers present in this process's environment, sorted, so the
/// caller can drop exactly those (`env -u NAME ...`, `env_remove`).
pub fn session_markers_present() -> Vec<String> {
    let mut names: Vec<String> = std::env::vars_os()
        .filter_map(|(k, _)| k.into_string().ok())
        .filter(|k| is_session_marker(k))
        .collect();
    names.sort();
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_parent_sessions_marks_are_markers() {
        for name in [
            "CLAUDECODE",
            "CLAUDE_CODE",
            "CLAUDE_CODE_CHILD_SESSION",
            "CLAUDE_CODE_SESSION_ID",
            "CLAUDE_CODE_MESSAGING_SOCKET",
            "CLAUDE_CODE_MESSAGING_TOKEN",
            "CLAUDE_CODE_ENTRYPOINT",
            "CLAUDE_CODE_EXECPATH",
            "CLAUDE_CODE_SESSION_ATTENDED",
            "CLAUDE_PID",
            "CLAUDE_EFFORT",
            "CODEX_SANDBOX",
            "CODEX_SANDBOX_NETWORK_DISABLED",
        ] {
            assert!(is_session_marker(name), "{name} marks a nested session");
        }
    }

    #[test]
    fn a_users_own_configuration_is_kept() {
        for name in [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_MODEL",
            "CLAUDE_CONFIG_DIR",
            "CLAUDE",
            "OPENAI_API_KEY",
            "CODEX_HOME",
            "HOME",
            "PATH",
            "HERMES_SESSION_ID",
        ] {
            assert!(!is_session_marker(name), "{name} is not a marker");
        }
    }

    #[test]
    fn only_markers_in_this_environment_are_listed() {
        // Set from the parent session on a developer's machine, or not at
        // all in CI: either way the list is exactly the markers present.
        let listed = session_markers_present();
        for name in &listed {
            assert!(is_session_marker(name));
            assert!(std::env::var_os(name).is_some());
        }
        assert!(listed.windows(2).all(|w| w[0] < w[1]), "sorted, unique");
    }
}
