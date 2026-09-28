//! The Blocked on you count on the app icon (F12).
//!
//!   macOS    the dock badge (`NSDockTile` badge label), cleared at 0
//!   Windows  a taskbar overlay icon with the count (9+ above nine)
//!   Linux    the window's urgency hint, raised when the count goes up and
//!            cleared at 0 (plus the launcher badge where the desktop has one)

use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Applied {
    count: u32,
}

static LAST: Mutex<Option<Applied>> = Mutex::new(None);

/// The count last applied (for the test build's read-back).
#[cfg_attr(not(feature = "e2e"), allow(dead_code))]
pub fn last_count() -> Option<u32> {
    LAST.lock()
        .unwrap_or_else(|e| e.into_inner())
        .map(|a| a.count)
}

/// What this platform does with the count.
pub fn mechanism() -> &'static str {
    if cfg!(target_os = "macos") {
        "dock-badge"
    } else if cfg!(windows) {
        "taskbar-overlay"
    } else {
        "urgency-hint"
    }
}

pub fn apply(app: &AppHandle, count: u32) -> Result<&'static str, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "no main window".to_string())?;
    let previous = {
        let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
        let prev = last.map(|a| a.count);
        *last = Some(Applied { count });
        prev
    };
    #[cfg(target_os = "macos")]
    {
        let _ = previous;
        window
            .set_badge_count(if count == 0 {
                None
            } else {
                Some(i64::from(count))
            })
            .map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    {
        let _ = previous;
        let icon = if count == 0 {
            None
        } else {
            Some(tauri::image::Image::new_owned(
                overlay_rgba(count),
                OVERLAY_SIZE,
                OVERLAY_SIZE,
            ))
        };
        window.set_overlay_icon(icon).map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if count == 0 {
            window
                .request_user_attention(None)
                .map_err(|e| e.to_string())?;
        } else if previous.is_none_or(|p| count > p) {
            window
                .request_user_attention(Some(tauri::UserAttentionType::Informational))
                .map_err(|e| e.to_string())?;
        }
        // Desktops with a launcher badge (Unity/KDE/Dash to Dock) show the
        // number too; elsewhere this does nothing.
        let _ = window.set_badge_count(if count == 0 {
            None
        } else {
            Some(i64::from(count))
        });
    }
    Ok(mechanism())
}

// The overlay is drawn only on Windows; its tests run everywhere.
#[cfg_attr(not(windows), allow(dead_code))]
pub const OVERLAY_SIZE: u32 = 16;

#[cfg_attr(not(windows), allow(dead_code))]
/// 3x5 pixel digits, one row per entry, bit 2 = left column.
const DIGITS: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111],
    [0b010, 0b110, 0b010, 0b010, 0b111],
    [0b111, 0b001, 0b111, 0b100, 0b111],
    [0b111, 0b001, 0b111, 0b001, 0b111],
    [0b101, 0b101, 0b111, 0b001, 0b001],
    [0b111, 0b100, 0b111, 0b001, 0b111],
    [0b111, 0b100, 0b111, 0b101, 0b111],
    [0b111, 0b001, 0b010, 0b010, 0b010],
    [0b111, 0b101, 0b111, 0b101, 0b111],
    [0b111, 0b101, 0b111, 0b001, 0b111],
];

#[cfg_attr(not(windows), allow(dead_code))]
const PLUS: [u8; 5] = [0b000, 0b010, 0b111, 0b010, 0b000];

#[cfg_attr(not(windows), allow(dead_code))]
/// A 16x16 RGBA overlay: a red disc with the count in white (1..9, then "+").
pub fn overlay_rgba(count: u32) -> Vec<u8> {
    let size = OVERLAY_SIZE as usize;
    let mut px = vec![0u8; size * size * 4];
    let c = (size as f32 - 1.0) / 2.0;
    for y in 0..size {
        for x in 0..size {
            let d = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
            if d <= c + 0.5 {
                let i = (y * size + x) * 4;
                px[i..i + 4].copy_from_slice(&[0xD9, 0x2D, 0x20, 0xFF]);
            }
        }
    }
    let glyph = if count <= 9 {
        DIGITS[count as usize]
    } else {
        PLUS
    };
    // Each glyph pixel is 2x2, the glyph 6x10, centred.
    let (ox, oy) = (5usize, 3usize);
    for (row, bits) in glyph.iter().enumerate() {
        for col in 0..3 {
            if bits & (0b100 >> col) == 0 {
                continue;
            }
            for dy in 0..2 {
                for dx in 0..2 {
                    let (x, y) = (ox + col * 2 + dx, oy + row * 2 + dy);
                    let i = (y * size + x) * 4;
                    px[i..i + 4].copy_from_slice(&[0xFF, 0xFF, 0xFF, 0xFF]);
                }
            }
        }
    }
    px
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixel(px: &[u8], x: usize, y: usize) -> [u8; 4] {
        let i = (y * OVERLAY_SIZE as usize + x) * 4;
        [px[i], px[i + 1], px[i + 2], px[i + 3]]
    }

    #[test]
    fn the_overlay_is_a_red_disc_with_a_white_count() {
        let px = overlay_rgba(3);
        assert_eq!(px.len(), 16 * 16 * 4);
        assert_eq!(pixel(&px, 0, 0)[3], 0, "corners are transparent");
        assert_eq!(
            pixel(&px, 1, 8),
            [0xD9, 0x2D, 0x20, 0xFF],
            "the disc is red"
        );
        // Top bar of the "3": glyph row 0, all three columns lit.
        assert_eq!(pixel(&px, 5, 3), [0xFF; 4]);
        assert_eq!(pixel(&px, 10, 3), [0xFF; 4]);
    }

    #[test]
    fn different_counts_draw_different_glyphs_and_ten_plus_is_a_plus() {
        assert_ne!(overlay_rgba(1), overlay_rgba(7));
        assert_eq!(overlay_rgba(10), overlay_rgba(42));
        assert_ne!(overlay_rgba(9), overlay_rgba(10));
    }
}
