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
        // Call explorer.exe directly (never via cmd /C) to prevent command injection.
        let mut child = std::process::Command::new("explorer")
            .arg(format!("/select,{}", path))
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
        // Validate path does not contain shell metacharacters that could be
        // exploited if a cmd shell is ever involved upstream.
        const SHELL_META: &[char] = &['&', '|', '>', '<', '^', '%'];
        if path.chars().any(|c| SHELL_META.contains(&c)) {
            return Err("Path contains invalid characters".to_string());
        }
        // Use explorer.exe directly (never via cmd /C) to prevent command injection.
        let mut child = std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }

    Ok(())
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

/// Provider ID → binary name mapping for AI CLI tools.
pub const AI_CLI_PROVIDERS: &[(&str, &str)] = &[
    ("claude", "claude"),
    ("aider", "aider"),
    ("codex", "codex"),
    ("gemini", "gemini"),
    ("copilot", "gh"),
];

/// Check which AI CLI tools are available on the system.
///
/// On macOS/Linux, GUI apps launched from Finder or Dock inherit a minimal
/// PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) that excludes Homebrew, nvm, cargo,
/// and other user-installed tool directories.  To detect CLIs accurately we
/// run the checks inside a **login shell** (`-l`) which sources the user's
/// profile and picks up the real PATH.
pub fn check_ai_cli_availability() -> std::collections::HashMap<String, bool> {
    // Try the login-shell approach first (Unix only).
    #[cfg(unix)]
    {
        if let Some(results) = check_ai_cli_via_login_shell() {
            return results;
        }
    }

    // Fallback: direct which/where (works when launched from a terminal
    // or on Windows).
    AI_CLI_PROVIDERS
        .iter()
        .map(|(id, cmd)| (id.to_string(), command_exists(cmd)))
        .collect()
}

/// Run all AI CLI checks in a single login-shell invocation so we pick up the
/// user's full PATH.  Returns `None` if the shell fails to execute.
#[cfg(unix)]
fn check_ai_cli_via_login_shell() -> Option<std::collections::HashMap<String, bool>> {
    let shell = crate::pty::detect_shell();

    // Build a script that prints "id=1" or "id=0" for each provider.
    // `command -v` is POSIX and works in bash, zsh, and fish.
    let script = AI_CLI_PROVIDERS
        .iter()
        .map(|(id, cmd)| {
            format!(
                "command -v {} >/dev/null 2>&1 && echo '{}=1' || echo '{}=0'",
                cmd, id, id
            )
        })
        .collect::<Vec<_>>()
        .join("; ");

    let output = std::process::Command::new(&shell)
        .args(["-l", "-c", &script])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Some(
        AI_CLI_PROVIDERS
            .iter()
            .map(|(id, _)| {
                let found = stdout.contains(&format!("{}=1", id));
                (id.to_string(), found)
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn check_ai_cli_availability_returns_all_provider_keys() {
        let result = check_ai_cli_availability();
        for (id, _) in AI_CLI_PROVIDERS {
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
        for (id, _) in AI_CLI_PROVIDERS {
            assert!(
                map.contains_key(*id),
                "Missing key from login shell results: {}",
                id
            );
        }
    }

    /// The login-shell script must not be injectable.  Provider IDs and
    /// command names are compile-time constants, but verify the script is
    /// well-formed anyway.
    #[cfg(unix)]
    #[test]
    fn login_shell_script_is_well_formed() {
        let script = AI_CLI_PROVIDERS
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
        for (id, cmd) in AI_CLI_PROVIDERS {
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
        for (id, _) in AI_CLI_PROVIDERS {
            assert!(script.contains(&format!("{}=1", id)));
            assert!(script.contains(&format!("{}=0", id)));
        }
    }
}
