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

/// Zsh .zshenv — sourced first.
/// CRITICAL: ZDOTDIR must stay pointing at our temp dir so zsh finds
/// our .zprofile/.zshrc/.zlogin next.  We only swap ZDOTDIR temporarily
/// when sourcing the user's file.
const ZSH_ZSHENV: &str = r#"# Hermes IDE shell integration — do not edit
_hermes_user="${HERMES_ORIGINAL_ZDOTDIR:-$HOME}"
# Temporarily point ZDOTDIR at the user's dir while sourcing their .zshenv
ZDOTDIR="$_hermes_user"
[[ -f "$_hermes_user/.zshenv" ]] && source "$_hermes_user/.zshenv"
# Re-point ZDOTDIR to Hermes temp dir so zsh finds our .zprofile next
ZDOTDIR="$_HERMES_ZDOTDIR"
"#;

/// Zsh .zprofile — sources user's .zprofile, keeps ZDOTDIR as temp dir.
const ZSH_ZPROFILE: &str = r#"# Hermes IDE shell integration — do not edit
_hermes_user="${HERMES_ORIGINAL_ZDOTDIR:-$HOME}"
ZDOTDIR="$_hermes_user"
[[ -f "$_hermes_user/.zprofile" ]] && source "$_hermes_user/.zprofile"
ZDOTDIR="$_HERMES_ZDOTDIR"
"#;

/// Zsh .zshrc — sources user's .zshrc then applies Hermes overrides.
/// Runs AFTER user config, so all plugins are loaded when we disable them.
/// ZDOTDIR is swapped to temp dir between user files so zsh finds .zlogin.
const ZSH_ZSHRC: &str = r#"# Hermes IDE shell integration — do not edit
_hermes_user="${HERMES_ORIGINAL_ZDOTDIR:-$HOME}"
ZDOTDIR="$_hermes_user"
[[ -f "$_hermes_user/.zshrc" ]] && source "$_hermes_user/.zshrc"
# Re-point so zsh finds our .zlogin next
ZDOTDIR="$_HERMES_ZDOTDIR"

# ── Hermes overrides (run after all user plugins have loaded) ──

# Disable zsh-autosuggestions — nuclear approach.
# The plugin may be loaded now or deferred (zinit, zsh-defer, etc.),
# so we use multiple layers:
_hermes_nuke_autosuggest() {
  (( $+functions[_zsh_autosuggest_disable] )) && _zsh_autosuggest_disable
  # Override the core suggest function to be a no-op
  _zsh_autosuggest_suggest() { unset POSTDISPLAY 2>/dev/null; }
  _zsh_autosuggest_fetch() { :; }
  _zsh_autosuggest_async_request() { :; }
  ZSH_AUTOSUGGEST_STRATEGY=()
  export ZSH_AUTOSUGGEST_BUFFER_MAX_SIZE=0
  unset POSTDISPLAY 2>/dev/null
}
# Run immediately (works if plugin is already loaded)
_hermes_nuke_autosuggest
# Precmd hook catches deferred loading
_hermes_autosuggest_precmd() {
  if (( $+functions[_zsh_autosuggest_start] )); then
    _hermes_nuke_autosuggest
    add-zsh-hook -d precmd _hermes_autosuggest_precmd
  fi
}
autoload -Uz add-zsh-hook
add-zsh-hook precmd _hermes_autosuggest_precmd

# Disable zsh-autocomplete real-time completion menu
zstyle ':autocomplete:*' min-input 9999 2>/dev/null

# Prevent space-prefixed commands from entering history.
# Hermes uses this to keep auto-injected commands out of the user's history.
setopt HIST_IGNORE_SPACE 2>/dev/null

export HERMES_TERMINAL=1
"#;

/// Zsh .zlogin — last startup file.  Sources user's .zlogin then
/// permanently restores ZDOTDIR, cleans up internal env vars, and
/// forces a terminal size re-read (fixes SIGWINCH race on startup).
const ZSH_ZLOGIN: &str = r#"# Hermes IDE shell integration — do not edit
_hermes_user="${HERMES_ORIGINAL_ZDOTDIR:-$HOME}"
ZDOTDIR="$_hermes_user"
[[ -f "$_hermes_user/.zlogin" ]] && source "$_hermes_user/.zlogin"
# Startup complete — permanently restore ZDOTDIR for interactive use
export ZDOTDIR="$_hermes_user"
unset _HERMES_ZDOTDIR HERMES_ORIGINAL_ZDOTDIR _hermes_user 2>/dev/null
# Force zsh to re-read actual terminal dimensions from the PTY.
# During startup the PTY resize (SIGWINCH) can arrive before zsh's
# signal handler is installed, leaving COLUMNS/LINES stale at 80x24.
kill -WINCH $$ 2>/dev/null
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

# Force terminal size re-read (fixes SIGWINCH race during startup)
kill -WINCH $$ 2>/dev/null
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
    log::info!(
        "[SHELL-INTEGRATION] setup called: shell={:?}, session={}",
        shell,
        session_id
    );
    let result = if shell.contains("zsh") {
        setup_zsh(session_id)
    } else if shell.contains("bash") {
        setup_bash(session_id)
    } else if shell.contains("fish") {
        ShellIntegration::Fish
    } else {
        ShellIntegration::None
    };
    log::info!(
        "[SHELL-INTEGRATION] result: is_active={}",
        result.is_active()
    );
    result
}

/// Get the fish init-command string.
pub fn fish_init_command() -> &'static str {
    FISH_INIT_CMD
}

fn setup_zsh(session_id: &str) -> ShellIntegration {
    let dir = std::env::temp_dir().join(format!("hermes-zsh-{}", session_id));
    log::info!("[SHELL-INTEGRATION] Creating ZDOTDIR at {:?}", dir);
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
            log::warn!("Failed to write {} for session {}: {}", name, session_id, e);
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
        assert!(ShellIntegration::Zsh {
            zdotdir: PathBuf::from("/tmp/test")
        }
        .is_active());
        assert!(ShellIntegration::Bash {
            rcfile: PathBuf::from("/tmp/test.sh")
        }
        .is_active());
        assert!(ShellIntegration::Fish.is_active());
        assert!(!ShellIntegration::None.is_active());
    }

    #[test]
    fn zsh_zshenv_swaps_zdotdir_and_restores_temp() {
        // .zshenv must: swap ZDOTDIR to user's dir, source user's .zshenv,
        // then re-point ZDOTDIR to our temp dir so zsh finds .zprofile next.
        let lines: Vec<&str> = ZSH_ZSHENV.lines().collect();
        let swap_line = lines
            .iter()
            .position(|l| l.contains("ZDOTDIR=\"$_hermes_user\""));
        let source_line = lines.iter().position(|l| l.contains("source"));
        let restore_line = lines.iter().position(|l| l.contains("_HERMES_ZDOTDIR"));
        assert!(
            swap_line.is_some() && source_line.is_some() && restore_line.is_some(),
            "Must swap ZDOTDIR, source user file, and restore temp dir"
        );
        assert!(
            swap_line.unwrap() < source_line.unwrap(),
            "ZDOTDIR must be swapped before sourcing"
        );
        assert!(
            source_line.unwrap() < restore_line.unwrap(),
            "ZDOTDIR must be restored to temp dir after sourcing"
        );
    }

    #[test]
    fn zsh_zshrc_sources_user_before_overrides() {
        // User's .zshrc must load BEFORE our overrides, so plugins are
        // already loaded when we disable them.
        let lines: Vec<&str> = ZSH_ZSHRC.lines().collect();
        let source_line = lines
            .iter()
            .position(|l| l.contains("source \"$_hermes_user/.zshrc\""));
        let override_line = lines
            .iter()
            .position(|l| l.contains("ZSH_AUTOSUGGEST_STRATEGY"));
        assert!(
            source_line.is_some() && override_line.is_some(),
            "Both source and override must exist"
        );
        assert!(
            source_line.unwrap() < override_line.unwrap(),
            "User's .zshrc must be sourced before overrides"
        );
    }

    #[test]
    fn zsh_zlogin_restores_zdotdir_permanently() {
        // .zlogin is the last startup file — it must permanently restore
        // ZDOTDIR and clean up internal env vars.
        assert!(ZSH_ZLOGIN.contains("export ZDOTDIR="));
        assert!(ZSH_ZLOGIN.contains("unset _HERMES_ZDOTDIR"));
        assert!(ZSH_ZLOGIN.contains("unset") && ZSH_ZLOGIN.contains("HERMES_ORIGINAL_ZDOTDIR"));
    }

    #[test]
    fn all_zsh_scripts_repoint_zdotdir_to_temp() {
        // Every file except .zlogin must re-point ZDOTDIR to the temp dir
        // so zsh finds the NEXT Hermes wrapper file.
        assert!(ZSH_ZSHENV.contains("ZDOTDIR=\"$_HERMES_ZDOTDIR\""));
        assert!(ZSH_ZPROFILE.contains("ZDOTDIR=\"$_HERMES_ZDOTDIR\""));
        assert!(ZSH_ZSHRC.contains("ZDOTDIR=\"$_HERMES_ZDOTDIR\""));
    }
}
