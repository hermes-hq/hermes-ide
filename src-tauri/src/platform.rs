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
        std::thread::spawn(move || { let _ = child.wait(); });
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
        std::thread::spawn(move || { let _ = child.wait(); });
    }

    #[cfg(target_os = "windows")]
    {
        // explorer expects: /select,"path with spaces"
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "explorer", &format!("/select,\"{}\"", path)])
            .spawn()
            .map_err(|e| format!("Failed to open Explorer: {}", e))?;
        std::thread::spawn(move || { let _ = child.wait(); });
    }

    Ok(())
}

/// Open a file with the system's default application.
/// - macOS: `open <path>`
/// - Linux: `xdg-open <path>`
/// - Windows: `cmd /C start "" <path>`
pub fn open_file(path: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut child = std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
        std::thread::spawn(move || { let _ = child.wait(); });
    }

    #[cfg(target_os = "linux")]
    {
        let mut child = std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
        std::thread::spawn(move || { let _ = child.wait(); });
    }

    #[cfg(target_os = "windows")]
    {
        // Quote the path to handle spaces and cmd metacharacters (& ( ) etc.)
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "start", "", &format!("\"{}\"", path)])
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
        std::thread::spawn(move || { let _ = child.wait(); });
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
