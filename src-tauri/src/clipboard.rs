use image::GenericImageView;

/// Copy an image file to the system clipboard as image data,
/// and also set a text representation (the file path) so that
/// terminal paste events have text content to deliver through the PTY.
///
/// Uses arboard on all platforms (NSPasteboard on macOS, WinAPI on Windows,
/// X11/Wayland on Linux) — no shell commands are spawned.
#[tauri::command]
pub fn copy_image_to_clipboard(path: String) -> Result<(), String> {
    let img = image::open(&path).map_err(|e| format!("Failed to open image '{}': {}", path, e))?;
    let rgba = img.to_rgba8();
    let (width, height) = img.dimensions();

    set_clipboard_image_and_text(&rgba, width, height, &path)
}

/// Read an image file and return it as a base64 data URI for display in the webview.
#[tauri::command]
pub fn read_image_base64(path: String) -> Result<String, String> {
    let data =
        std::fs::read(&path).map_err(|e| format!("Failed to read '{}': {}", path, e))?;

    let mime = match path.to_lowercase() {
        p if p.ends_with(".png") => "image/png",
        p if p.ends_with(".jpg") || p.ends_with(".jpeg") => "image/jpeg",
        p if p.ends_with(".gif") => "image/gif",
        p if p.ends_with(".webp") => "image/webp",
        p if p.ends_with(".bmp") => "image/bmp",
        p if p.ends_with(".ico") => "image/x-icon",
        p if p.ends_with(".tiff") || p.ends_with(".tif") => "image/tiff",
        _ => "application/octet-stream",
    };

    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
    Ok(format!("data:{};base64,{}", mime, b64))
}

/// Set clipboard image and text using arboard (safe, no shell injection risk).
/// arboard uses native platform APIs (NSPasteboard on macOS, WinAPI on Windows,
/// X11/Wayland on Linux) without spawning shell commands.
fn set_clipboard_image_and_text(
    rgba: &[u8],
    width: u32,
    height: u32,
    text: &str,
) -> Result<(), String> {
    use arboard::{Clipboard, ImageData};
    use std::borrow::Cow;

    let img_data = ImageData {
        width: width as usize,
        height: height as usize,
        bytes: Cow::from(rgba.to_vec()),
    };

    let mut clipboard =
        Clipboard::new().map_err(|e| format!("Failed to access clipboard: {}", e))?;

    // arboard clears previous data on set, so image takes priority.
    // Set image first, then try to also set text (may replace image on some platforms).
    clipboard
        .set_image(img_data)
        .map_err(|e| format!("Failed to set clipboard image: {}", e))?;

    // Setting text after image may clear the image on some platforms.
    // If that happens, the file path in the terminal is still useful.
    let _ = clipboard.set_text(text);

    Ok(())
}
