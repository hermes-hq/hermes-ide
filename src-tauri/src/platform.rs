//! Cross-platform utilities for file operations, home directory, and external commands.

/// Returns the user's home directory using the `dirs` crate (works on all platforms).
pub fn home_dir() -> Option<std::path::PathBuf> {
    dirs::home_dir()
}

/// Reveal a file in the native file manager.
/// - macOS: `open -R <path>`
/// - Linux: `xdg-open` on the parent directory
/// - Windows: `explorer /select,<path>`
pub fn reveal_in_file_manager(path: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut child = std::process::Command::new("open")
            .args(["-R", path])
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {}", e))?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }

    #[cfg(target_os = "linux")]
    {
        let parent = std::path::Path::new(path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string());
        let mut child = std::process::Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {}", e))?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // explorer.exe directly (never through a shell): `&` or `%` in the
        // path are just characters (XP-14). The path is quoted as one
        // argument after `/select,`, which explorer only parses unquoted.
        let mut child = std::process::Command::new("explorer")
            .raw_arg(explorer_arg(path, true))
            .spawn()
            .map_err(|e| format!("Failed to open Explorer: {}", e))?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }

    Ok(())
}

/// Open a file with the system's default application.
/// - macOS: `open <path>`
/// - Linux: `xdg-open <path>`
/// - Windows: `explorer <path>` (avoids cmd shell metacharacter injection)
pub fn open_file(path: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut child = std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }

    #[cfg(target_os = "linux")]
    {
        let mut child = std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // explorer.exe runs without a shell, so `&` and `%` in a path are
        // safe (XP-14: such paths used to be refused). Quoted, one argument.
        let mut child = std::process::Command::new("explorer")
            .raw_arg(explorer_arg(path, false))
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }

    Ok(())
}

/// The argument explorer.exe gets for `path`: the path quoted (a Windows
/// path cannot contain `"`), after `/select,` to reveal it.
#[cfg_attr(not(windows), allow(dead_code))]
fn explorer_arg(path: &str, select: bool) -> String {
    let quoted = format!("\"{}\"", path.replace('"', ""));
    if select {
        format!("/select,{quoted}")
    } else {
        quoted
    }
}

/// The clipboard's text, for a terminal paste (XP-11): the web views'
/// own paste either hangs (macOS) or does nothing (WebView2, WebKitGTK).
/// Empty when the clipboard holds no text. Test builds can be handed the
/// clipboard in `HERMES_E2E_CLIPBOARD`, so a test never reads the real one.
#[tauri::command]
pub fn read_clipboard_text() -> Result<String, String> {
    #[cfg(feature = "e2e")]
    if let Ok(text) = std::env::var("HERMES_E2E_CLIPBOARD") {
        return Ok(text);
    }
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    match clipboard.get_text() {
        Ok(text) => Ok(text),
        Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Check if a command exists on the system PATH.
/// - Unix (macOS/Linux): `which <name>`
/// - Windows: `where <name>`
pub fn command_exists(name: &str) -> bool {
    #[cfg(unix)]
    {
        std::process::Command::new("which")
            .arg(name)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[cfg(windows)]
    {
        std::process::Command::new("where")
            .arg(name)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

/// Agent id → binary name for every agent CLI Hermes looks for, from the
/// agent catalog (`src/catalog/agents.json`, the `detect` command of each
/// entry).
pub fn ai_cli_providers() -> Vec<(&'static str, &'static str)> {
    crate::agent_catalog::detect_binaries()
}

/// Check which AI CLI tools are available on the system.
///
/// On macOS/Linux, GUI apps launched from Finder or Dock inherit a minimal
/// PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) that excludes Homebrew, nvm, cargo,
/// and other user-installed tool directories.
///
/// Detection layers (Unix), most accurate first:
///
///   1. **Interactive login shell** (`-l -i -c`). Sources both login files
///      (`.zprofile` / `.bash_profile`) AND the interactive rc files
///      (`.zshrc` / `.bashrc`) where most users put their PATH additions
///      (nvm, volta, pnpm, npm-global). See issue #239 — a bare `-l -c`
///      misses `.zshrc`, which is where `claude` gets added by the npm
///      global install.
///   2. **Well-known install directories**. If the shell check reports a
///      provider as missing, scan common locations (`/opt/homebrew/bin`,
///      `/usr/local/bin`, `~/.npm-global/bin`, `~/.volta/bin`,
///      `~/.nvm/versions/node/*/bin`, `~/.local/bin`, `~/.cargo/bin`) as a
///      last resort for users whose profile is misconfigured.
///   3. **Bare `which`** on Windows or as a last fallback on Unix.
///
/// `include_beta` is whether the UI shows the beta-channel agents (the
/// agentCatalog flag). The fallback spawns one `which`/`where` per agent, so
/// without the flag the beta agents are reported missing without a spawn.
/// The Unix login-shell check is one script for every agent either way.
pub fn check_ai_cli_availability(include_beta: bool) -> std::collections::HashMap<String, bool> {
    #[cfg(unix)]
    {
        if let Some(mut results) = check_ai_cli_via_login_shell() {
            // Layer 2: upgrade any still-false entry if we find the binary
            // sitting in a well-known install directory. Never downgrades a
            // true hit — an empty/misconfigured profile can't mask a real
            // install, but a correct profile can always find the binary.
            for (id, cmd) in ai_cli_providers().iter() {
                if results.get(*id).copied() == Some(false) && find_binary_in_well_known_dirs(cmd) {
                    results.insert((*id).to_string(), true);
                }
            }
            return results;
        }
    }

    // Fallback: direct which/where (works when launched from a terminal
    // or on Windows).
    let probed = fallback_probe_list(include_beta);
    ai_cli_providers()
        .iter()
        .map(|(id, cmd)| {
            (
                id.to_string(),
                probed.contains(&(*id, *cmd)) && command_exists(cmd),
            )
        })
        .collect()
}

/// The agents the which/where fallback spawns a check for.
fn fallback_probe_list(include_beta: bool) -> Vec<(&'static str, &'static str)> {
    ai_cli_providers()
        .into_iter()
        .filter(|(id, _)| include_beta || !crate::agent_catalog::is_beta(id))
        .collect()
}

/// Build the per-provider detection script fed to the login shell. Pure —
/// extracted so tests can invoke it with a handcrafted shell environment.
#[cfg(unix)]
fn build_detection_script() -> String {
    // `command -v` is POSIX and works in bash, zsh, and fish. Each provider
    // prints `id=1` or `id=0` on its own line. The parser only scans stdout
    // for those markers, so prompt/banner noise from interactive init files
    // doesn't affect the result.
    ai_cli_providers()
        .iter()
        .map(|(id, cmd)| {
            format!(
                "command -v {} >/dev/null 2>&1 && echo '{}=1' || echo '{}=0'",
                cmd, id, id
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// Parse the login-shell stdout into a provider-id → available map.
#[cfg(unix)]
fn parse_detection_output(stdout: &str) -> std::collections::HashMap<String, bool> {
    ai_cli_providers()
        .iter()
        .map(|(id, _)| {
            let found = stdout.contains(&format!("{}=1", id));
            ((*id).to_string(), found)
        })
        .collect()
}

/// Run all AI CLI checks in a single login+interactive shell invocation so
/// we pick up the user's full PATH.  Returns `None` if the shell fails to
/// execute. `-i` (interactive) is the critical flag — it's what forces the
/// shell to read `.zshrc` / `.bashrc`, where most tool-manager PATH exports
/// live on macOS.
#[cfg(unix)]
fn check_ai_cli_via_login_shell() -> Option<std::collections::HashMap<String, bool>> {
    let shell = crate::pty::detect_shell();
    let script = build_detection_script();

    let output = std::process::Command::new(&shell)
        .args(["-l", "-i", "-c", &script])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        // Defensive env overrides: keep interactive shells from touching
        // terminal state or writing to history during a headless invocation.
        .env("PS1", "")
        .env("PROMPT", "")
        .env("RPROMPT", "")
        .env("HISTFILE", "/dev/null")
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Some(parse_detection_output(&stdout))
}

/// Directories to probe as the last-resort fallback. Covers the common
/// macOS/Linux install locations for CLIs managed by Homebrew, nvm, volta,
/// pnpm, pip user installs, cargo, and npm global.
#[cfg(unix)]
pub(crate) fn well_known_path_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = vec![
        std::path::PathBuf::from("/opt/homebrew/bin"),
        std::path::PathBuf::from("/usr/local/bin"),
        std::path::PathBuf::from("/usr/bin"),
        std::path::PathBuf::from("/bin"),
    ];
    if let Some(home) = home_dir() {
        dirs.push(home.join(".npm-global").join("bin"));
        dirs.push(home.join(".volta").join("bin"));
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join(".cargo").join("bin"));
        dirs.push(home.join("Library").join("pnpm"));
        // Expand `~/.nvm/versions/node/*/bin` — node version directories are
        // per-install, so we enumerate rather than guess.
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm").join("versions").join("node")) {
            for entry in entries.flatten() {
                let bin = entry.path().join("bin");
                if bin.is_dir() {
                    dirs.push(bin);
                }
            }
        }
    }
    dirs
}

/// True if an executable file named `name` exists in any well-known dir.
#[cfg(unix)]
fn find_binary_in_well_known_dirs(name: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    for dir in well_known_path_dirs() {
        let candidate = dir.join(name);
        if let Ok(meta) = std::fs::metadata(&candidate) {
            // is_file() with any execute bit set — mirrors what `which`
            // accepts, excludes broken symlinks and non-executable shims.
            if meta.is_file() && meta.permissions().mode() & 0o111 != 0 {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explorer_gets_the_path_quoted_as_one_argument_whatever_it_contains() {
        assert_eq!(
            explorer_arg(r"C:\Work\R&D %TEMP%\notes.txt", false),
            r#""C:\Work\R&D %TEMP%\notes.txt""#
        );
        assert_eq!(
            explorer_arg(r"C:\Work\a,b & c", true),
            r#"/select,"C:\Work\a,b & c""#
        );
        // A quote cannot be in a Windows path; one never ends the argument.
        assert_eq!(explorer_arg(r#"C:\x" & calc"#, false), r#""C:\x & calc""#);
    }

    #[test]
    fn command_exists_finds_system_commands() {
        // `ls` is always present in /bin on Unix and Windows
        #[cfg(unix)]
        assert!(command_exists("ls"));
        #[cfg(windows)]
        assert!(command_exists("cmd"));
    }

    #[test]
    fn command_exists_returns_false_for_nonexistent() {
        assert!(!command_exists("__nonexistent_binary_abc123__"));
    }

    #[test]
    fn fallback_probes_beta_agents_only_with_the_flag() {
        let ids = |v: Vec<(&'static str, &'static str)>| {
            v.into_iter().map(|(id, _)| id).collect::<Vec<_>>()
        };
        let stable = ids(fallback_probe_list(false));
        let all = ids(fallback_probe_list(true));
        assert_eq!(
            stable,
            vec!["claude", "codex", "gemini", "copilot", "aider", "kiro"]
        );
        assert_eq!(all.len(), ai_cli_providers().len());
        for beta in ["antigravity", "opencode", "goose", "hermes-agent"] {
            assert!(all.contains(&beta) && !stable.contains(&beta), "{beta}");
        }
        // Keys are always complete, so the UI never sees a missing entry.
        let result = check_ai_cli_availability(false);
        for (id, _) in ai_cli_providers().iter() {
            assert!(result.contains_key(*id), "Missing provider key: {}", id);
        }
    }

    #[test]
    fn check_ai_cli_availability_returns_all_provider_keys() {
        let result = check_ai_cli_availability(true);
        for (id, _) in ai_cli_providers().iter() {
            assert!(result.contains_key(*id), "Missing provider key: {}", id);
        }
    }

    /// Regression test for the GUI-app PATH bug.
    ///
    /// macOS/Linux GUI apps launched from Finder/Dock inherit a minimal PATH
    /// that excludes directories like `/usr/local/bin` and `/opt/homebrew/bin`.
    /// `command_exists` uses bare `which` which inherits the process PATH —
    /// so it fails to find CLIs in a GUI context.
    ///
    /// `check_ai_cli_availability` must use a **login shell** instead, which
    /// sources the user's profile and gets the full PATH.
    #[cfg(unix)]
    #[test]
    fn bare_which_fails_with_minimal_path() {
        // Simulate the PATH a macOS GUI app gets: only /usr/bin and /bin.
        // A command like `node` (typically in /usr/local/bin or nvm) won't
        // be found, but `ls` (in /bin) will.
        let minimal_path = "/usr/bin:/bin:/usr/sbin:/sbin";

        let ls_found = std::process::Command::new("which")
            .arg("ls")
            .env("PATH", minimal_path)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(ls_found, "ls should be found even with minimal PATH");

        // A binary that lives outside the minimal PATH should NOT be found.
        // We create a temp script to prove this.
        let tmp = std::env::temp_dir().join("hermes_test_cli_detect");
        std::fs::create_dir_all(&tmp).unwrap();
        let fake_bin = tmp.join("__hermes_fake_cli__");
        std::fs::write(&fake_bin, "#!/bin/sh\necho ok").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake_bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        // With the temp dir in PATH, `which` finds it.
        let full_path = format!("{}:{}", tmp.display(), minimal_path);
        let found_with_full = std::process::Command::new("which")
            .arg("__hermes_fake_cli__")
            .env("PATH", &full_path)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(
            found_with_full,
            "fake CLI should be found with extended PATH"
        );

        // With only the minimal PATH, `which` does NOT find it — this is
        // exactly the bug that affected the production GUI app.
        let found_with_minimal = std::process::Command::new("which")
            .arg("__hermes_fake_cli__")
            .env("PATH", minimal_path)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(
            !found_with_minimal,
            "fake CLI must NOT be found with minimal PATH — \
             this proves bare `which` is insufficient for GUI apps"
        );

        // Cleanup
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Verify that the login-shell detection finds commands the user has
    /// installed, even when the process PATH is minimal.
    #[cfg(unix)]
    #[test]
    fn login_shell_detection_finds_commands() {
        // The login-shell approach should find `ls` (a basic sanity check).
        let results = check_ai_cli_via_login_shell();
        assert!(results.is_some(), "login shell detection should succeed");
        let map = results.unwrap();
        // We can't assert specific AI CLIs are installed, but all keys must
        // be present.
        for (id, _) in ai_cli_providers().iter() {
            assert!(
                map.contains_key(*id),
                "Missing key from login shell results: {}",
                id
            );
        }
    }

    // ── Interactive-rc regression (issue #239) ─────────────────────────

    /// Directly validates the flag-selection fix for issue #239.
    ///
    /// Zsh (the default shell on macOS since Catalina) only sources
    /// `.zshrc` when it's invoked as an **interactive** shell. `zsh -l -c`
    /// is login-but-non-interactive: it reads `.zprofile` / `.zlogin` but
    /// *not* `.zshrc`. Most macOS users put their tool-manager PATH
    /// exports (nvm, volta, pnpm, npm-global — which is where `claude`
    /// lives) in `.zshrc`, so the old detection path silently misses
    /// them. Adding `-i` forces interactive mode and `.zshrc` is read.
    ///
    /// The test stages an isolated HOME and asserts the observable
    /// behavior shift: old flags miss, new flags find.
    #[cfg(unix)]
    #[test]
    fn interactive_login_shell_sources_zshrc_for_path_exports() {
        if !command_exists("zsh") {
            // Ubuntu CI runners don't ship zsh by default. Skip rather
            // than silently pass — the eprintln makes it visible in logs
            // when developers/CI want to confirm zsh coverage.
            eprintln!(
                "zsh not available — skipping .zshrc rc-sourcing regression test. \
                 Install zsh to exercise the issue #239 fix locally."
            );
            return;
        }

        use std::os::unix::fs::PermissionsExt;

        let tmp = std::env::temp_dir().join(format!(
            "hermes_rc_regression_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let bin_dir = tmp.join("mybin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let fake_name = "hermes_rc_sentinel_bin";
        let fake_bin = bin_dir.join(fake_name);
        std::fs::write(&fake_bin, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&fake_bin, std::fs::Permissions::from_mode(0o755)).unwrap();

        // `.zshrc` (interactive-only rc) adds the binary dir to PATH.
        // `.zprofile` (login-only rc) is intentionally empty — mirrors
        // the real-world config that triggers #239.
        std::fs::write(
            tmp.join(".zshrc"),
            format!("export PATH=\"{}:$PATH\"\n", bin_dir.display()),
        )
        .unwrap();
        std::fs::write(tmp.join(".zprofile"), "# intentionally empty\n").unwrap();

        let script = format!(
            "command -v {} >/dev/null 2>&1 && echo FOUND || echo MISSING",
            fake_name
        );

        let invoke = |flags: &[&str]| -> String {
            let output = std::process::Command::new("zsh")
                .args(flags)
                .arg("-c")
                .arg(&script)
                .env_clear()
                .env("HOME", &tmp)
                // Override ZDOTDIR so zsh looks in our staged HOME for rc
                // files rather than the developer/CI user's real ones.
                .env("ZDOTDIR", &tmp)
                .env("PATH", "/usr/bin:/bin")
                .env("PS1", "")
                .env("PROMPT", "")
                .stdin(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .output()
                .expect("zsh invocation failed");
            String::from_utf8_lossy(&output.stdout).to_string()
        };

        // Old behavior (`-l` only) MUST miss the .zshrc export. If this
        // ever passes, the fixture has drifted and the test no longer
        // reproduces #239.
        let old = invoke(&["-l"]);
        assert!(
            old.contains("MISSING"),
            "fixture broken: `zsh -l -c` unexpectedly found the binary. stdout={:?}",
            old
        );

        // New behavior (`-l -i`) MUST find it — this is the fix.
        let new = invoke(&["-l", "-i"]);
        assert!(
            new.contains("FOUND"),
            "regression: `zsh -l -i -c` failed to source .zshrc PATH export. stdout={:?}",
            new
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// The well-known-paths fallback must find an executable we drop into
    /// one of the scanned directories (via HOME override). Locks in the
    /// secondary hardening layer described in issue #239.
    #[cfg(unix)]
    #[test]
    fn well_known_paths_fallback_finds_binary_by_home() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = std::env::temp_dir().join(format!(
            "hermes_wkp_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&tmp);

        let target_dir = tmp.join(".npm-global").join("bin");
        std::fs::create_dir_all(&target_dir).unwrap();
        let fake_name = "hermes_wkp_sentinel_bin";
        let fake_bin = target_dir.join(fake_name);
        std::fs::write(&fake_bin, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&fake_bin, std::fs::Permissions::from_mode(0o755)).unwrap();

        // The public `home_dir()` is backed by the `dirs` crate, which on
        // Unix honors $HOME. Temporarily overriding it scopes the fallback
        // to our staged directory tree.
        //
        // Using `unsafe` to set env vars at runtime is required by Rust
        // 2024 edition and acceptable here: the test is serial w.r.t. this
        // env key, and we restore the prior value below.
        let prev_home = std::env::var_os("HOME");
        unsafe {
            std::env::set_var("HOME", &tmp);
        }

        let found = find_binary_in_well_known_dirs(fake_name);

        unsafe {
            match prev_home {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
        }

        assert!(
            found,
            "well-known-paths fallback should have found `{}` in ~/.npm-global/bin",
            fake_name
        );

        // Non-existent binary name must still return false — verifies the
        // fallback does not spuriously report every provider as installed.
        let prev_home = std::env::var_os("HOME");
        unsafe {
            std::env::set_var("HOME", &tmp);
        }
        let not_found = find_binary_in_well_known_dirs("__hermes_wkp_nonexistent__");
        unsafe {
            match prev_home {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
        }
        assert!(!not_found);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// The well-known-paths layer must never DOWNGRADE a true hit. Probes
    /// the contract documented at the call site: the secondary layer only
    /// upgrades `false → true`, never the other way.
    #[cfg(unix)]
    #[test]
    fn check_availability_does_not_downgrade_true_hits() {
        // Indirect: we can only observe the combined result. Build a map
        // mirroring what `check_ai_cli_via_login_shell` returns, hand-set
        // one entry to true for a guaranteed-missing binary name, and
        // verify that running the well-known-paths upgrade pass against an
        // inert HOME leaves the true value intact.
        let mut results: std::collections::HashMap<String, bool> = ai_cli_providers()
            .iter()
            .map(|(id, _)| ((*id).to_string(), false))
            .collect();
        // Force one provider to pretend-true.
        results.insert("claude".to_string(), true);

        for (id, cmd) in ai_cli_providers().iter() {
            if results.get(*id).copied() == Some(false) && find_binary_in_well_known_dirs(cmd) {
                results.insert((*id).to_string(), true);
            }
        }

        assert_eq!(
            results.get("claude").copied(),
            Some(true),
            "well-known-paths upgrade pass must not clobber an existing true"
        );
    }

    /// Copilot is detected by the standalone `copilot` binary (what the install
    /// hint installs and what Hermes launches), not by `gh`, whose retired
    /// `gh copilot` extension no longer works.
    #[cfg(unix)]
    #[test]
    fn copilot_is_detected_by_the_copilot_binary_not_gh() {
        use std::os::unix::fs::PermissionsExt;

        fn run_with_bins(bins: &[&str]) -> std::collections::HashMap<String, bool> {
            let dir = std::env::temp_dir().join(format!(
                "hermes-detect-{}-{}",
                std::process::id(),
                bins.join("-")
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            for b in bins {
                let p = dir.join(b);
                std::fs::write(&p, "#!/bin/sh\nexit 0\n").unwrap();
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            let out = std::process::Command::new("/bin/sh")
                .args(["-c", &build_detection_script()])
                .env("PATH", &dir)
                .output()
                .unwrap();
            let _ = std::fs::remove_dir_all(&dir);
            parse_detection_output(&String::from_utf8_lossy(&out.stdout))
        }

        let only_gh = run_with_bins(&["gh"]);
        assert_eq!(only_gh.get("copilot").copied(), Some(false));

        let with_copilot = run_with_bins(&["copilot"]);
        assert_eq!(with_copilot.get("copilot").copied(), Some(true));
        assert_eq!(with_copilot.get("gemini").copied(), Some(false));
    }

    // ── Script generation & parsing ────────────────────────────────────

    /// The login-shell script must not be injectable.  Provider IDs and
    /// command names are compile-time constants, but verify the script is
    /// well-formed anyway.
    #[cfg(unix)]
    #[test]
    fn login_shell_script_is_well_formed() {
        let script = ai_cli_providers()
            .iter()
            .map(|(id, cmd)| {
                format!(
                    "command -v {} >/dev/null 2>&1 && echo '{}=1' || echo '{}=0'",
                    cmd, id, id
                )
            })
            .collect::<Vec<_>>()
            .join("; ");

        // No shell metacharacters from provider data
        for (id, cmd) in ai_cli_providers().iter() {
            assert!(
                !id.contains('\'') && !id.contains(';') && !id.contains('|'),
                "Provider ID contains unsafe chars: {}",
                id
            );
            assert!(
                !cmd.contains('\'') && !cmd.contains(';') && !cmd.contains('|'),
                "Command name contains unsafe chars: {}",
                cmd
            );
        }

        // Script should contain one check per provider
        for (id, _) in ai_cli_providers().iter() {
            assert!(script.contains(&format!("{}=1", id)));
            assert!(script.contains(&format!("{}=0", id)));
        }
    }
}
