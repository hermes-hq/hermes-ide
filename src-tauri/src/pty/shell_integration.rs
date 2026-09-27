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

use std::path::{Path, PathBuf};

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

# Prevent space-prefixed commands from entering history.
# Hermes uses this to keep auto-injected commands out of the user's history.
setopt HIST_IGNORE_SPACE 2>/dev/null

export HERMES_TERMINAL=1
"#;

/// Appended to the zsh .zshrc when Hermes shows its own inline suggestions:
/// disables conflicting autosuggestion plugins so the two don't overlap.
const ZSH_DISABLE_NATIVE_SUGGESTIONS: &str = r#"
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

export HERMES_TERMINAL=1

# Force terminal size re-read (fixes SIGWINCH race during startup)
kill -WINCH $$ 2>/dev/null
"#;

/// Appended to the bash init script when Hermes shows its own inline
/// suggestions: disables ble.sh auto-complete so the two don't overlap.
const BASH_DISABLE_NATIVE_SUGGESTIONS: &str = r#"
# Disable ble.sh auto-complete if loaded
if type ble-bind &>/dev/null 2>&1; then
  ble-bind -m auto_complete -f '' auto_complete/cancel 2>/dev/null
fi
"#;

/// Fish init-command — passed via `fish -C "..."`.
/// Runs after config.fish, so built-in autosuggestions are already active.
const FISH_INIT_CMD: &str =
    "set -g fish_autosuggestion_enabled 0 2>/dev/null; set -gx HERMES_TERMINAL 1";

/// Fish init-command used when Hermes suggestions are off: leaves fish's
/// built-in autosuggestions alone.
const FISH_INIT_CMD_NATIVE: &str = "set -gx HERMES_TERMINAL 1";

// ─── Setup Functions ─────────────────────────────────────────────────

/// Set up shell integration for a session. Returns the integration type
/// and (for zsh/bash) the temp path that was created.
///
/// The caller must apply the returned integration to the `CommandBuilder`:
/// - `Zsh`: set `HERMES_ORIGINAL_ZDOTDIR` and `ZDOTDIR` env vars
/// - `Bash`: replace `-l` with `--rcfile <path>`
/// - `Fish`: add `-C <command>` argument
///
/// When `disable_native_suggestions` is false (the user turned Hermes's own
/// suggestions off), the user's shell autosuggestion plugins are left alone.
pub fn setup(shell: &str, session_id: &str, disable_native_suggestions: bool) -> ShellIntegration {
    log::info!(
        "[SHELL-INTEGRATION] setup called: shell={:?}, session={}, disable_native_suggestions={}",
        shell,
        session_id,
        disable_native_suggestions
    );
    let result = if shell.contains("zsh") {
        setup_zsh(session_id, disable_native_suggestions)
    } else if shell.contains("bash") {
        setup_bash(session_id, disable_native_suggestions)
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

/// Whether Hermes shows its own inline suggestions, given the raw
/// `shell_suggestions` setting. `"native"` turns them off; anything else
/// (including unset) keeps the default of Hermes suggestions on.
pub fn hermes_suggestions_enabled(setting: Option<&str>) -> bool {
    setting != Some("native")
}

/// Get the fish init-command string.
pub fn fish_init_command(disable_native_suggestions: bool) -> &'static str {
    if disable_native_suggestions {
        FISH_INIT_CMD
    } else {
        FISH_INIT_CMD_NATIVE
    }
}

fn zsh_zshrc(disable_native_suggestions: bool) -> String {
    if disable_native_suggestions {
        format!("{}{}", ZSH_ZSHRC, ZSH_DISABLE_NATIVE_SUGGESTIONS)
    } else {
        ZSH_ZSHRC.to_string()
    }
}

fn bash_init(disable_native_suggestions: bool) -> String {
    if disable_native_suggestions {
        format!("{}{}", BASH_INIT, BASH_DISABLE_NATIVE_SUGGESTIONS)
    } else {
        BASH_INIT.to_string()
    }
}

fn setup_zsh(session_id: &str, disable_native_suggestions: bool) -> ShellIntegration {
    let dir = crate::instance::shell_temp_root().join(format!(
        "zsh-{}-{}",
        std::process::id(),
        session_id
    ));
    log::info!("[SHELL-INTEGRATION] Creating ZDOTDIR at {:?}", dir);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::warn!("Failed to create ZDOTDIR for session {}: {}", session_id, e);
        return ShellIntegration::None;
    }

    let zshrc = zsh_zshrc(disable_native_suggestions);
    let files: &[(&str, &str)] = &[
        (".zshenv", ZSH_ZSHENV),
        (".zprofile", ZSH_ZPROFILE),
        (".zshrc", &zshrc),
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

fn setup_bash(session_id: &str, disable_native_suggestions: bool) -> ShellIntegration {
    let root = crate::instance::shell_temp_root();
    let path = root.join(format!("bash-{}-{}.sh", std::process::id(), session_id));
    let written = std::fs::create_dir_all(&root)
        .and_then(|_| std::fs::write(&path, bash_init(disable_native_suggestions)));
    if let Err(e) = written {
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

/// Clean up shell integration temp files left behind by an earlier run of
/// this same instance (e.g. after a crash).
///
/// Only this instance's temp folder is looked at, so another Hermes on the
/// same machine (installed app, dev, beta or test build) keeps its files. An
/// entry is removed only when the process that created it is gone.
pub fn cleanup_stale() {
    let root = crate::instance::shell_temp_root();
    let mut sys = sysinfo::System::new();
    let removed = cleanup_stale_in(&root, std::process::id(), |pid| {
        let pid = sysinfo::Pid::from_u32(pid);
        sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
        sys.process(pid).is_some()
    });
    if removed > 0 {
        log::info!(
            "[SHELL-INTEGRATION] Removed {} stale temp entries from {:?}",
            removed,
            root
        );
    }
}

/// Process id that created a temp entry, from its name: `zsh-<pid>-<session>`
/// (folder) or `bash-<pid>-<session>.sh` (file). `None` for anything else.
fn owner_pid(name: &str, is_dir: bool) -> Option<u32> {
    let rest = if is_dir {
        name.strip_prefix("zsh-")?
    } else {
        name.strip_prefix("bash-")?.strip_suffix(".sh")?
    };
    let (pid, session) = rest.split_once('-')?;
    if session.is_empty() {
        return None;
    }
    pid.parse().ok()
}

/// Removes entries in `root` whose creating process is neither `own_pid` nor
/// alive. Entries it does not recognise are left alone. Returns how many
/// entries were removed.
fn cleanup_stale_in(root: &Path, own_pid: u32, mut is_alive: impl FnMut(u32) -> bool) -> usize {
    let Ok(entries) = std::fs::read_dir(root) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let Some(pid) = owner_pid(&entry.file_name().to_string_lossy(), file_type.is_dir()) else {
            continue;
        };
        if pid == own_pid || is_alive(pid) {
            continue;
        }
        let path = entry.path();
        let result = if file_type.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        if result.is_ok() {
            removed += 1;
        }
    }
    removed
}

// ─── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_files_live_in_this_instances_folder_and_name_their_owner() {
        let root = crate::instance::shell_temp_root();
        let pid = std::process::id();
        let zsh = setup_zsh("owner-zsh", true);
        let bash = setup_bash("owner-bash", true);
        match (&zsh, &bash) {
            (ShellIntegration::Zsh { zdotdir }, ShellIntegration::Bash { rcfile }) => {
                assert_eq!(zdotdir.parent(), Some(root.as_path()));
                assert_eq!(rcfile.parent(), Some(root.as_path()));
                let zname = zdotdir.file_name().unwrap().to_string_lossy().to_string();
                let bname = rcfile.file_name().unwrap().to_string_lossy().to_string();
                assert_eq!(zname, format!("zsh-{}-owner-zsh", pid));
                assert_eq!(bname, format!("bash-{}-owner-bash.sh", pid));
                assert_eq!(owner_pid(&zname, true), Some(pid));
                assert_eq!(owner_pid(&bname, false), Some(pid));
            }
            _ => panic!("expected zsh and bash integrations"),
        }
        cleanup(&zsh);
        cleanup(&bash);
    }

    #[test]
    fn stale_cleanup_removes_only_dead_owners_in_its_own_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("hermes-shell-mine");
        std::fs::create_dir_all(&root).unwrap();
        let mk_dir = |p: &Path| {
            std::fs::create_dir_all(p).unwrap();
            std::fs::write(p.join(".zshrc"), "x").unwrap();
        };
        // Leftovers of this instance: pid 111 is dead, 222 is alive, 333 is us.
        mk_dir(&root.join("zsh-111-dead"));
        std::fs::write(root.join("bash-111-dead.sh"), "x").unwrap();
        mk_dir(&root.join("zsh-222-live"));
        std::fs::write(root.join("bash-222-live.sh"), "x").unwrap();
        mk_dir(&root.join("zsh-333-own"));
        // Things it does not recognise stay.
        mk_dir(&root.join("zsh-notapid-x"));
        std::fs::write(root.join("notes.txt"), "x").unwrap();
        std::fs::write(root.join("zsh-111-file-not-dir"), "x").unwrap();
        // Another Hermes's files next to our folder: legacy names from an
        // older installed app and another instance's folder.
        mk_dir(&tmp.path().join("hermes-zsh-installed-app"));
        std::fs::write(tmp.path().join("hermes-bash-installed-app.sh"), "x").unwrap();
        mk_dir(&tmp.path().join("hermes-shell-other").join("zsh-111-other"));

        let mut asked = Vec::new();
        let removed = cleanup_stale_in(&root, 333, |pid| {
            asked.push(pid);
            pid == 222
        });

        assert_eq!(removed, 2);
        assert!(!root.join("zsh-111-dead").exists());
        assert!(!root.join("bash-111-dead.sh").exists());
        assert!(root.join("zsh-222-live").exists());
        assert!(root.join("bash-222-live.sh").exists());
        assert!(root.join("zsh-333-own").exists());
        assert!(root.join("zsh-notapid-x").exists());
        assert!(root.join("notes.txt").exists());
        assert!(root.join("zsh-111-file-not-dir").exists());
        assert!(tmp.path().join("hermes-zsh-installed-app/.zshrc").exists());
        assert!(tmp.path().join("hermes-bash-installed-app.sh").exists());
        assert!(tmp
            .path()
            .join("hermes-shell-other/zsh-111-other/.zshrc")
            .exists());
        assert!(!asked.contains(&333), "never asks about its own pid");
    }

    #[test]
    fn stale_cleanup_of_a_missing_folder_is_a_no_op() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            cleanup_stale_in(&tmp.path().join("absent"), 1, |_| false),
            0
        );
    }

    #[test]
    fn setup_zsh_creates_all_rc_files() {
        let integration = setup_zsh("test-zsh-001", true);
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
        let integration = setup_bash("test-bash-001", true);
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
        let integration = setup("fish", "test-fish-001", true);
        assert!(matches!(integration, ShellIntegration::Fish));
        assert!(integration.is_active());
    }

    #[test]
    fn setup_unknown_shell_returns_none() {
        let integration = setup("powershell", "test-ps-001", true);
        assert!(matches!(integration, ShellIntegration::None));
        assert!(!integration.is_active());
    }

    #[test]
    fn cleanup_removes_zsh_directory() {
        let integration = setup_zsh("test-cleanup-zsh", true);
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
        let integration = setup_bash("test-cleanup-bash", true);
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
        let cmd = fish_init_command(true);
        assert!(cmd.contains("fish_autosuggestion_enabled"));
        assert!(cmd.contains("HERMES_TERMINAL"));
    }

    #[test]
    fn hermes_suggestions_setting_defaults_on() {
        assert!(hermes_suggestions_enabled(None));
        assert!(hermes_suggestions_enabled(Some("hermes")));
        assert!(!hermes_suggestions_enabled(Some("native")));
    }

    #[test]
    fn native_suggestions_left_alone_when_hermes_suggestions_off() {
        // zsh
        let read_zshrc = |integration: &ShellIntegration| match integration {
            ShellIntegration::Zsh { zdotdir } => {
                std::fs::read_to_string(zdotdir.join(".zshrc")).unwrap()
            }
            _ => panic!("Expected Zsh"),
        };
        let on_integration = setup_zsh("test-native-zsh-on", true);
        let off_integration = setup_zsh("test-native-zsh-off", false);
        let on = read_zshrc(&on_integration);
        let off = read_zshrc(&off_integration);
        cleanup(&on_integration);
        cleanup(&off_integration);
        assert!(on.contains("ZSH_AUTOSUGGEST_STRATEGY"));
        assert!(on.contains("min-input 9999"));
        assert!(!off.contains("ZSH_AUTOSUGGEST_STRATEGY"));
        assert!(!off.contains("min-input 9999"));
        assert!(off.contains("HERMES_TERMINAL=1"));
        assert!(off.contains("HIST_IGNORE_SPACE"));

        // bash
        let bash_off = setup_bash("test-native-bash-off", false);
        let script = match &bash_off {
            ShellIntegration::Bash { rcfile } => std::fs::read_to_string(rcfile).unwrap(),
            _ => panic!("Expected Bash"),
        };
        assert!(!script.contains("ble-bind"));
        assert!(script.contains("HERMES_TERMINAL=1"));
        cleanup(&bash_off);

        // fish
        assert!(!fish_init_command(false).contains("fish_autosuggestion_enabled"));
        assert!(fish_init_command(false).contains("HERMES_TERMINAL"));
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
        let zshrc = zsh_zshrc(true);
        let lines: Vec<&str> = zshrc.lines().collect();
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
