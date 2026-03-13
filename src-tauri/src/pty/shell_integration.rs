//! Shell integration scripts for Hermes IDE.
//!
//! At PTY creation time, Hermes injects lightweight shell-specific integration
//! that transparently disables conflicting autosuggestion plugins (zsh-autosuggestions,
//! zsh-autocomplete, fish built-in, ble.sh) and exports `HERMES_TERMINAL=1`.
//!
//! The mechanism varies by shell:
//! - **zsh**: `ZDOTDIR` is pointed at a temp directory whose rc files source
//!   the user's real config and then apply Hermes overrides.
//! - **bash**: `--rcfile` replaces `-l`; the init file sources the user's
//!   profile/rc files and then applies overrides.
//! - **fish**: `-C` (init-command) runs after config.fish loads.

use std::path::PathBuf;

// ─── Integration Result ──────────────────────────────────────────────

/// Describes what shell integration was set up for a session.
/// Stored on PtySession so `close_session` can clean up temp files.
pub enum ShellIntegration {
    /// ZDOTDIR was redirected to a temp directory.
    Zsh { zdotdir: PathBuf },
    /// An init script was written for `bash --rcfile`.
    Bash { rcfile: PathBuf },
    /// Fish init-command string (no temp files needed).
    Fish,
    /// No integration was set up (unknown shell, SSH, Windows, etc.).
    None,
}

impl ShellIntegration {
    /// Whether shell integration was successfully applied.
    pub fn is_active(&self) -> bool {
        !matches!(self, ShellIntegration::None)
    }
}

// ─── Script Content ──────────────────────────────────────────────────

/// Zsh .zshenv — sourced first, restores ZDOTDIR to the user's real value
/// so that .zprofile/.zshrc lookups find the right files.
const ZSH_ZSHENV: &str = r#"# Hermes IDE shell integration — do not edit
# Restore original ZDOTDIR so the user's config files are found
export ZDOTDIR="${HERMES_ORIGINAL_ZDOTDIR:-$HOME}"
unset HERMES_ORIGINAL_ZDOTDIR
# Source the user's .zshenv
[[ -f "$ZDOTDIR/.zshenv" ]] && source "$ZDOTDIR/.zshenv"
"#;

/// Zsh .zprofile — passthrough to user's .zprofile
const ZSH_ZPROFILE: &str = r#"# Hermes IDE shell integration — do not edit
[[ -f "$ZDOTDIR/.zprofile" ]] && source "$ZDOTDIR/.zprofile"
"#;

/// Zsh .zshrc — sources user's .zshrc then applies Hermes overrides.
/// Runs AFTER user config, so all plugins are loaded when we disable them.
const ZSH_ZSHRC: &str = r#"# Hermes IDE shell integration — do not edit
[[ -f "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"

# ── Hermes overrides (run after all user plugins have loaded) ──

# Disable zsh-autosuggestions (Oh My Zsh default plugin)
if (( $+ZSH_AUTOSUGGEST_STRATEGY )); then
  ZSH_AUTOSUGGEST_STRATEGY=()
fi

# Disable zsh-autocomplete real-time completion menu
zstyle ':autocomplete:*' min-input 9999 2>/dev/null

export HERMES_TERMINAL=1
"#;

/// Zsh .zlogin — passthrough to user's .zlogin
const ZSH_ZLOGIN: &str = r#"# Hermes IDE shell integration — do not edit
[[ -f "$ZDOTDIR/.zlogin" ]] && source "$ZDOTDIR/.zlogin"
"#;

/// Bash init script — used with `bash --rcfile`.
/// Sources the user's profile/rc files manually (since --rcfile replaces the
/// default sourcing of .bashrc), then applies Hermes overrides.
const BASH_INIT: &str = r#"# Hermes IDE shell integration — do not edit
# Source system profile
[ -f /etc/profile ] && source /etc/profile

# Source the user's login profile (bash sources the first one it finds)
if [ -f "$HOME/.bash_profile" ]; then
  source "$HOME/.bash_profile"
elif [ -f "$HOME/.bash_login" ]; then
  source "$HOME/.bash_login"
elif [ -f "$HOME/.profile" ]; then
  source "$HOME/.profile"
fi

# Source .bashrc (many .bash_profile files do this, but not all)
[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"

# ── Hermes overrides ──

# Disable ble.sh auto-complete if loaded
if type ble-bind &>/dev/null 2>&1; then
  ble-bind -m auto_complete -f '' auto_complete/cancel 2>/dev/null
fi

export HERMES_TERMINAL=1
"#;

/// Fish init-command — passed via `fish -C "..."`.
/// Runs after config.fish, so built-in autosuggestions are already active.
const FISH_INIT_CMD: &str =
    "set -g fish_autosuggestion_enabled 0 2>/dev/null; set -gx HERMES_TERMINAL 1";

// ─── Setup Functions ─────────────────────────────────────────────────

/// Set up shell integration for a session. Returns the integration type
/// and (for zsh/bash) the temp path that was created.
///
/// The caller must apply the returned integration to the `CommandBuilder`:
/// - `Zsh`: set `HERMES_ORIGINAL_ZDOTDIR` and `ZDOTDIR` env vars
/// - `Bash`: replace `-l` with `--rcfile <path>`
/// - `Fish`: add `-C <command>` argument
pub fn setup(shell: &str, session_id: &str) -> ShellIntegration {
    if shell.contains("zsh") {
        setup_zsh(session_id)
    } else if shell.contains("bash") {
        setup_bash(session_id)
    } else if shell.contains("fish") {
        ShellIntegration::Fish
    } else {
        ShellIntegration::None
    }
}

/// Get the fish init-command string.
pub fn fish_init_command() -> &'static str {
    FISH_INIT_CMD
}

fn setup_zsh(session_id: &str) -> ShellIntegration {
    let dir = std::env::temp_dir().join(format!("hermes-zsh-{}", session_id));
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::warn!("Failed to create ZDOTDIR for session {}: {}", session_id, e);
        return ShellIntegration::None;
    }

    let files: &[(&str, &str)] = &[
        (".zshenv", ZSH_ZSHENV),
        (".zprofile", ZSH_ZPROFILE),
        (".zshrc", ZSH_ZSHRC),
        (".zlogin", ZSH_ZLOGIN),
    ];

    for (name, content) in files {
        if let Err(e) = std::fs::write(dir.join(name), content) {
            log::warn!(
                "Failed to write {} for session {}: {}",
                name,
                session_id,
                e
            );
            // Clean up partial directory
            std::fs::remove_dir_all(&dir).ok();
            return ShellIntegration::None;
        }
    }

    ShellIntegration::Zsh { zdotdir: dir }
}

fn setup_bash(session_id: &str) -> ShellIntegration {
    let path = std::env::temp_dir().join(format!("hermes-bash-{}.sh", session_id));
    if let Err(e) = std::fs::write(&path, BASH_INIT) {
        log::warn!(
            "Failed to write bash init for session {}: {}",
            session_id,
            e
        );
        return ShellIntegration::None;
    }

    ShellIntegration::Bash { rcfile: path }
}

// ─── Cleanup ─────────────────────────────────────────────────────────

/// Remove temp files/directories created by shell integration.
pub fn cleanup(integration: &ShellIntegration) {
    match integration {
        ShellIntegration::Zsh { zdotdir } => {
            if let Err(e) = std::fs::remove_dir_all(zdotdir) {
                log::warn!("Failed to clean up ZDOTDIR {:?}: {}", zdotdir, e);
            }
        }
        ShellIntegration::Bash { rcfile } => {
            if let Err(e) = std::fs::remove_file(rcfile) {
                log::warn!("Failed to clean up bash rcfile {:?}: {}", rcfile, e);
            }
        }
        ShellIntegration::Fish | ShellIntegration::None => {}
    }
}

/// Clean up any stale shell integration temp files from previous sessions
/// that weren't properly cleaned up (e.g., app crash).
pub fn cleanup_stale() {
    let tmp = std::env::temp_dir();

    // Clean up hermes-zsh-* directories
    if let Ok(entries) = std::fs::read_dir(&tmp) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if (name_str.starts_with("hermes-zsh-") && entry.path().is_dir())
                || (name_str.starts_with("hermes-bash-") && name_str.ends_with(".sh"))
            {
                if entry.path().is_dir() {
                    std::fs::remove_dir_all(entry.path()).ok();
                } else {
                    std::fs::remove_file(entry.path()).ok();
                }
            }
        }
    }
}

// ─── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_zsh_creates_all_rc_files() {
        let integration = setup_zsh("test-zsh-001");
        match &integration {
            ShellIntegration::Zsh { zdotdir } => {
                assert!(zdotdir.join(".zshenv").exists());
                assert!(zdotdir.join(".zprofile").exists());
                assert!(zdotdir.join(".zshrc").exists());
                assert!(zdotdir.join(".zlogin").exists());

                // Verify content
                let zshrc = std::fs::read_to_string(zdotdir.join(".zshrc")).unwrap();
                assert!(zshrc.contains("ZSH_AUTOSUGGEST_STRATEGY"));
                assert!(zshrc.contains("zsh-autocomplete"));
                assert!(zshrc.contains("HERMES_TERMINAL=1"));

                let zshenv = std::fs::read_to_string(zdotdir.join(".zshenv")).unwrap();
                assert!(zshenv.contains("HERMES_ORIGINAL_ZDOTDIR"));
                assert!(zshenv.contains("source"));
            }
            _ => panic!("Expected Zsh integration"),
        }
        cleanup(&integration);
    }

    #[test]
    fn setup_bash_creates_rcfile() {
        let integration = setup_bash("test-bash-001");
        match &integration {
            ShellIntegration::Bash { rcfile } => {
                assert!(rcfile.exists());
                let content = std::fs::read_to_string(rcfile).unwrap();
                assert!(content.contains("HERMES_TERMINAL=1"));
                assert!(content.contains(".bash_profile"));
                assert!(content.contains(".bashrc"));
                assert!(content.contains("ble-bind"));
            }
            _ => panic!("Expected Bash integration"),
        }
        cleanup(&integration);
    }

    #[test]
    fn setup_fish_returns_fish_variant() {
        let integration = setup("fish", "test-fish-001");
        assert!(matches!(integration, ShellIntegration::Fish));
        assert!(integration.is_active());
    }

    #[test]
    fn setup_unknown_shell_returns_none() {
        let integration = setup("powershell", "test-ps-001");
        assert!(matches!(integration, ShellIntegration::None));
        assert!(!integration.is_active());
    }

    #[test]
    fn cleanup_removes_zsh_directory() {
        let integration = setup_zsh("test-cleanup-zsh");
        let path = match &integration {
            ShellIntegration::Zsh { zdotdir } => zdotdir.clone(),
            _ => panic!("Expected Zsh"),
        };
        assert!(path.exists());
        cleanup(&integration);
        assert!(!path.exists());
    }

    #[test]
    fn cleanup_removes_bash_file() {
        let integration = setup_bash("test-cleanup-bash");
        let path = match &integration {
            ShellIntegration::Bash { rcfile } => rcfile.clone(),
            _ => panic!("Expected Bash"),
        };
        assert!(path.exists());
        cleanup(&integration);
        assert!(!path.exists());
    }

    #[test]
    fn fish_init_command_content() {
        let cmd = fish_init_command();
        assert!(cmd.contains("fish_autosuggestion_enabled"));
        assert!(cmd.contains("HERMES_TERMINAL"));
    }

    #[test]
    fn is_active_returns_correct_value() {
        assert!(ShellIntegration::Zsh { zdotdir: PathBuf::from("/tmp/test") }.is_active());
        assert!(ShellIntegration::Bash { rcfile: PathBuf::from("/tmp/test.sh") }.is_active());
        assert!(ShellIntegration::Fish.is_active());
        assert!(!ShellIntegration::None.is_active());
    }

    #[test]
    fn zsh_zshenv_restores_zdotdir_before_sourcing() {
        // The .zshenv must restore ZDOTDIR BEFORE sourcing the user's .zshenv,
        // otherwise the user's .zshenv would look for files in the temp dir.
        let lines: Vec<&str> = ZSH_ZSHENV.lines().collect();
        let restore_line = lines.iter().position(|l| l.contains("export ZDOTDIR="));
        let source_line = lines.iter().position(|l| l.contains("source"));
        assert!(
            restore_line.is_some() && source_line.is_some(),
            "Both restore and source must exist"
        );
        assert!(
            restore_line.unwrap() < source_line.unwrap(),
            "ZDOTDIR must be restored before sourcing user's .zshenv"
        );
    }

    #[test]
    fn zsh_zshrc_sources_user_before_overrides() {
        // User's .zshrc must load BEFORE our overrides, so plugins are
        // already loaded when we disable them.
        let lines: Vec<&str> = ZSH_ZSHRC.lines().collect();
        let source_line = lines.iter().position(|l| l.contains("source \"$ZDOTDIR/.zshrc\""));
        let override_line = lines.iter().position(|l| l.contains("ZSH_AUTOSUGGEST_STRATEGY"));
        assert!(
            source_line.is_some() && override_line.is_some(),
            "Both source and override must exist"
        );
        assert!(
            source_line.unwrap() < override_line.unwrap(),
            "User's .zshrc must be sourced before overrides"
        );
    }
}
