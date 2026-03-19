use serde::Serialize;
use std::fs;
use std::io::Cursor;
use std::path::PathBuf;
use tauri::{Manager, State};

use crate::AppState;

/// Returns the plugins directory path inside the app data directory.
fn plugins_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    Ok(data_dir.join("plugins"))
}

#[derive(Debug, Serialize)]
pub struct InstalledPlugin {
    pub id: String,
    pub dir_name: String,
    pub manifest_json: String,
}

/// List all installed plugins by scanning the plugins directory.
/// Each plugin is a subdirectory containing a `hermes-plugin.json` manifest.
#[tauri::command]
pub fn list_installed_plugins(app: tauri::AppHandle) -> Result<Vec<InstalledPlugin>, String> {
    let dir = plugins_dir(&app)?;
    if !dir.exists() {
        return Ok(vec![]);
    }

    let mut plugins = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("Failed to read plugins dir: {}", e))?;

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let manifest_path = path.join("hermes-plugin.json");
        if !manifest_path.exists() {
            continue;
        }

        let manifest_json = match fs::read_to_string(&manifest_path) {
            Ok(json) => json,
            Err(e) => {
                log::warn!(
                    "Failed to read manifest at {}: {}",
                    manifest_path.display(),
                    e
                );
                continue;
            }
        };

        // Extract plugin ID from manifest
        let id = match serde_json::from_str::<serde_json::Value>(&manifest_json) {
            Ok(v) => v
                .get("id")
                .and_then(|id| id.as_str())
                .unwrap_or_default()
                .to_string(),
            Err(_) => continue,
        };

        let dir_name = entry.file_name().to_string_lossy().to_string();

        plugins.push(InstalledPlugin {
            id,
            dir_name,
            manifest_json,
        });
    }

    Ok(plugins)
}

/// Read the JavaScript bundle for a plugin.
#[tauri::command]
pub fn read_plugin_bundle(app: tauri::AppHandle, plugin_dir: String) -> Result<String, String> {
    let dir = plugins_dir(&app)?;
    let plugin_path = dir.join(&plugin_dir);

    // Security: ensure the resolved path is within the plugins directory
    let canonical_dir = dir
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize plugins dir: {}", e))?;
    let canonical_plugin = plugin_path
        .canonicalize()
        .map_err(|e| format!("Plugin directory not found: {}", e))?;
    if !canonical_plugin.starts_with(&canonical_dir) {
        return Err("Invalid plugin path: directory traversal detected".to_string());
    }

    // Read manifest to find the main entry point
    let manifest_path = canonical_plugin.join("hermes-plugin.json");
    let manifest_json = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("Failed to read manifest: {}", e))?;
    let manifest: serde_json::Value = serde_json::from_str(&manifest_json)
        .map_err(|e| format!("Invalid manifest JSON: {}", e))?;

    let main_file = manifest
        .get("main")
        .and_then(|m| m.as_str())
        .unwrap_or("dist/index.js");

    let bundle_path = canonical_plugin.join(main_file);

    // Verify bundle path is still within the plugin directory
    let canonical_bundle = bundle_path
        .canonicalize()
        .map_err(|e| format!("Bundle file not found at '{}': {}", main_file, e))?;
    if !canonical_bundle.starts_with(&canonical_plugin) {
        return Err("Invalid bundle path: directory traversal detected".to_string());
    }

    fs::read_to_string(&canonical_bundle)
        .map_err(|e| format!("Failed to read plugin bundle: {}", e))
}

/// Get the plugins directory path.
#[tauri::command]
pub fn get_plugins_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = plugins_dir(&app)?;

    // Create the directory if it doesn't exist
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create plugins dir: {}", e))?;
    }

    Ok(dir.to_string_lossy().to_string())
}

/// Uninstall a plugin by removing its directory.
#[tauri::command]
pub fn uninstall_plugin(app: tauri::AppHandle, plugin_dir: String) -> Result<(), String> {
    let dir = plugins_dir(&app)?;
    let plugin_path = dir.join(&plugin_dir);

    // Security: ensure the resolved path is within the plugins directory
    let canonical_dir = dir
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize plugins dir: {}", e))?;
    let canonical_plugin = plugin_path
        .canonicalize()
        .map_err(|e| format!("Plugin directory not found: {}", e))?;
    if !canonical_plugin.starts_with(&canonical_dir) {
        return Err("Invalid plugin path: directory traversal detected".to_string());
    }

    fs::remove_dir_all(&canonical_plugin)
        .map_err(|e| format!("Failed to remove plugin directory: {}", e))
}

/// Install a plugin from a .tgz archive (raw bytes from frontend fetch).
/// Extracts to plugins directory under the plugin's ID.
#[tauri::command]
pub fn install_plugin(app: tauri::AppHandle, data: Vec<u8>) -> Result<String, String> {
    let dir = plugins_dir(&app)?;
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create plugins dir: {}", e))?;
    }

    // Create temp dir for extraction
    let temp_dir = dir.join(format!(".install-tmp-{}", std::process::id()));
    if temp_dir.exists() {
        fs::remove_dir_all(&temp_dir).map_err(|e| format!("Failed to clean temp dir: {}", e))?;
    }
    fs::create_dir_all(&temp_dir).map_err(|e| format!("Failed to create temp dir: {}", e))?;

    // Decompress and extract
    let cursor = Cursor::new(data);
    let gz = flate2::read::GzDecoder::new(cursor);
    let mut archive = tar::Archive::new(gz);

    if let Err(e) = archive.unpack(&temp_dir) {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err(format!("Failed to extract archive: {}", e));
    }

    // Find hermes-plugin.json (may be at root or in a single subdirectory like "package/")
    let (manifest_root, manifest_json) = find_manifest_in_dir(&temp_dir).inspect_err(|_| {
        let _ = fs::remove_dir_all(&temp_dir);
    })?;

    let manifest: serde_json::Value = serde_json::from_str(&manifest_json).map_err(|e| {
        let _ = fs::remove_dir_all(&temp_dir);
        format!("Invalid manifest: {}", e)
    })?;

    let plugin_id = manifest
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            let _ = fs::remove_dir_all(&temp_dir);
            "Manifest missing 'id' field".to_string()
        })?
        .to_string();

    // Validate plugin_id doesn't contain path traversal
    if plugin_id.contains("..") || plugin_id.contains('/') || plugin_id.contains('\\') {
        let _ = fs::remove_dir_all(&temp_dir);
        return Err("Invalid plugin ID".to_string());
    }

    let final_dir = dir.join(&plugin_id);

    // Remove old version if exists
    if final_dir.exists() {
        fs::remove_dir_all(&final_dir).map_err(|e| {
            let _ = fs::remove_dir_all(&temp_dir);
            format!("Failed to remove old: {}", e)
        })?;
    }

    // Move manifest root to final location
    fs::rename(&manifest_root, &final_dir)
        .or_else(|_| {
            // rename can fail across filesystems, fall back to copy
            copy_dir_all(&manifest_root, &final_dir)
        })
        .map_err(|e| {
            let _ = fs::remove_dir_all(&temp_dir);
            format!("Failed to install: {}", e)
        })?;

    // Clean up temp dir
    let _ = fs::remove_dir_all(&temp_dir);

    Ok(plugin_id)
}

/// Fetch the plugin registry JSON from a URL.
/// Done in Rust to bypass WebView CSP restrictions.
#[tauri::command]
pub async fn fetch_plugin_registry(url: String) -> Result<String, String> {
    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("Registry fetch failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Registry fetch failed: HTTP {}", response.status()));
    }

    response
        .text()
        .await
        .map_err(|e| format!("Failed to read registry: {}", e))
}

/// Download a plugin .tgz from a URL and install it.
/// The download happens in Rust to bypass WebView CSP restrictions.
#[tauri::command]
pub async fn download_and_install_plugin(
    app: tauri::AppHandle,
    url: String,
) -> Result<String, String> {
    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Download failed: HTTP {}", response.status()));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    install_plugin(app, bytes.to_vec())
}

fn find_manifest_in_dir(dir: &std::path::Path) -> Result<(PathBuf, String), String> {
    // Check root
    let root_manifest = dir.join("hermes-plugin.json");
    if root_manifest.exists() {
        let json = fs::read_to_string(&root_manifest)
            .map_err(|e| format!("Failed to read manifest: {}", e))?;
        return Ok((dir.to_path_buf(), json));
    }

    // Check single subdirectory
    let entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| format!("Failed to read dir: {}", e))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .collect();

    if entries.len() == 1 {
        let sub = entries[0].path();
        let sub_manifest = sub.join("hermes-plugin.json");
        if sub_manifest.exists() {
            let json = fs::read_to_string(&sub_manifest)
                .map_err(|e| format!("Failed to read manifest: {}", e))?;
            return Ok((sub, json));
        }
    }

    Err("Archive does not contain hermes-plugin.json".to_string())
}

/// Fetch a URL and return the response body as a string.
/// Used by plugins with the "network" permission.
#[tauri::command]
pub async fn plugin_fetch_url(
    url: String,
    plugin_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        if !db.has_plugin_permission(&plugin_id, "network")? {
            return Err(format!(
                "Plugin \"{}\" does not have \"network\" permission",
                plugin_id
            ));
        }
    }
    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("Failed to fetch URL: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP error: {}", response.status()));
    }

    response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))
}

/// Execute a shell command and return its output.
/// Used by plugins with the "shell.exec" permission.
#[tauri::command]
pub async fn plugin_exec_command(
    command: String,
    args: Vec<String>,
    plugin_id: String,
    state: State<'_, AppState>,
) -> Result<PluginExecResult, String> {
    {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        if !db.has_plugin_permission(&plugin_id, "shell.exec")? {
            return Err(format!(
                "Plugin \"{}\" does not have \"shell.exec\" permission",
                plugin_id
            ));
        }
    }

    let output = std::process::Command::new(&command)
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to execute command: {}", e))?;

    Ok(PluginExecResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("mkdir failed: {}", e))?;
    for entry in fs::read_dir(src).map_err(|e| format!("readdir failed: {}", e))? {
        let entry = entry.map_err(|e| format!("entry failed: {}", e))?;
        let ty = entry
            .file_type()
            .map_err(|e| format!("filetype failed: {}", e))?;
        let dst_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dst_path)?;
        } else {
            fs::copy(entry.path(), &dst_path).map_err(|e| format!("copy failed: {}", e))?;
        }
    }
    Ok(())
}
