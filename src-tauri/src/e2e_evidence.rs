//! Checks on the evidence the test-only bridge produces (see `e2e_bridge.rs`).
//!
//! A screenshot proves nothing when it is one flat colour: that is what the
//! window server hands out for a window behind a locked screen, and what a
//! webview shows before its first paint. The bridge refuses to report such a
//! capture as a screenshot. Kept free of Tauri so `cargo test --lib` covers it.

use std::path::Path;

/// The one colour a PNG consists of — `None` when it shows more than one.
pub fn flat_colour(png: &Path) -> Result<Option<[u8; 4]>, String> {
    let image = image::open(png)
        .map_err(|e| format!("read {:?}: {}", png, e))?
        .into_rgba8();
    let mut pixels = image.pixels();
    let Some(first) = pixels.next() else {
        return Err(format!("{:?} has no pixels", png));
    };
    Ok(pixels.all(|p| p == first).then_some(first.0))
}

/// `#rrggbb` for log lines and error messages.
pub fn hex(colour: [u8; 4]) -> String {
    format!("#{:02x}{:02x}{:02x}", colour[0], colour[1], colour[2])
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    fn write(name: &str, image: &RgbaImage) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join(name);
        image.save(&file).expect("write png");
        (dir, file)
    }

    #[test]
    fn an_all_black_capture_is_flat() {
        let (_dir, file) = write(
            "black.png",
            &RgbaImage::from_pixel(64, 48, Rgba([0, 0, 0, 255])),
        );
        assert_eq!(flat_colour(&file).unwrap(), Some([0, 0, 0, 255]));
    }

    #[test]
    fn an_all_white_capture_is_flat_whatever_the_colour() {
        let (_dir, file) = write(
            "white.png",
            &RgbaImage::from_pixel(10, 10, Rgba([255, 255, 255, 255])),
        );
        let colour = flat_colour(&file).unwrap().expect("flat");
        assert_eq!(hex(colour), "#ffffff");
    }

    #[test]
    fn one_different_pixel_makes_it_a_real_picture() {
        let mut image = RgbaImage::from_pixel(64, 48, Rgba([0, 0, 0, 255]));
        image.put_pixel(63, 47, Rgba([0, 0, 1, 255]));
        let (_dir, file) = write("almost.png", &image);
        assert_eq!(flat_colour(&file).unwrap(), None);
    }

    #[test]
    fn a_rendered_window_is_not_flat() {
        let image = RgbaImage::from_fn(120, 80, |x, y| {
            Rgba([(x % 256) as u8, (y % 256) as u8, 40, 255])
        });
        let (_dir, file) = write("window.png", &image);
        assert_eq!(flat_colour(&file).unwrap(), None);
    }

    #[test]
    fn a_missing_or_broken_file_is_an_error_not_a_pass() {
        let dir = tempfile::tempdir().unwrap();
        assert!(flat_colour(&dir.path().join("missing.png")).is_err());
        let junk = dir.path().join("junk.png");
        std::fs::write(&junk, b"not a png").unwrap();
        assert!(flat_colour(&junk).is_err());
    }
}
