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

/// Check which AI CLI tools are available on the system.
pub fn check_ai_cli_availability() -> std::collections::HashMap<String, bool> {
    let providers = [
        ("claude", "claude"),
        ("aider", "aider"),
        ("codex", "codex"),
        ("gemini", "gemini"),
        ("copilot", "gh"),
    ];
    providers
        .iter()
        .map(|(id, cmd)| (id.to_string(), command_exists(cmd)))
        .collect()
}
