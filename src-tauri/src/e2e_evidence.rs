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

/// How many pictures the bridge takes before it reports a flat capture.
pub const PAINT_ATTEMPTS: u32 = 5;

/// A capture that showed more than one colour.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Painted {
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    /// Which attempt produced it (1 = the first picture was already painted).
    pub attempt: u32,
    /// The colour of the flat pictures thrown away before it, if any.
    pub flat_before: Option<[u8; 4]>,
}

/// Take pictures into `file` until one is not a single flat colour.
///
/// `capture(n)` takes attempt `n` (1-based) and writes it to `file`; it is
/// where a platform brings the window forward, asks it to repaint and waits
/// between attempts. Every picture goes through the same `flat_colour` check:
/// a flat one is deleted and taken again, and when all `attempts` are flat the
/// result is an error. A capture that fails outright is returned at once — a
/// retry only covers a window that has not repainted yet.
pub fn capture_until_painted(
    file: &Path,
    attempts: u32,
    mut capture: impl FnMut(u32) -> Result<(u32, u32), String>,
) -> Result<Painted, String> {
    let attempts = attempts.max(1);
    let mut flat_before = None;
    for attempt in 1..=attempts {
        let (width, height) = capture(attempt)?;
        let bytes = std::fs::metadata(file).map(|m| m.len()).unwrap_or(0);
        if bytes == 0 {
            return Err(format!("screenshot file {:?} is empty", file));
        }
        match flat_colour(file)? {
            None => {
                return Ok(Painted {
                    width,
                    height,
                    bytes,
                    attempt,
                    flat_before,
                })
            }
            Some(colour) => {
                let _ = std::fs::remove_file(file);
                flat_before = Some(colour);
            }
        }
    }
    let colour = flat_before.map(hex).unwrap_or_default();
    Err(format!(
        "the capture is one flat colour ({}) in all {} attempts: the window has not painted yet, or the screen is locked",
        colour, attempts
    ))
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

    fn black() -> RgbaImage {
        RgbaImage::from_pixel(64, 48, Rgba([0, 0, 0, 255]))
    }

    fn painted() -> RgbaImage {
        RgbaImage::from_fn(64, 48, |x, y| Rgba([x as u8, y as u8, 40, 255]))
    }

    #[test]
    fn a_painted_first_picture_is_taken_once() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("shot.png");
        let mut calls = 0;
        let got = capture_until_painted(&file, PAINT_ATTEMPTS, |_| {
            calls += 1;
            painted().save(&file).unwrap();
            Ok((64, 48))
        })
        .expect("painted");
        assert_eq!(calls, 1);
        assert_eq!(got.attempt, 1);
        assert_eq!(got.flat_before, None);
        assert_eq!((got.width, got.height), (64, 48));
        assert!(got.bytes > 0);
        assert!(file.exists());
    }

    #[test]
    fn flat_pictures_are_retaken_until_the_window_has_repainted() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("shot.png");
        let mut seen = Vec::new();
        let got = capture_until_painted(&file, PAINT_ATTEMPTS, |n| {
            // Each attempt starts from a clean slate: the flat picture of the
            // previous attempt was deleted, not kept as evidence.
            assert!(!file.exists(), "attempt {} found a stale picture", n);
            seen.push(n);
            if n < 3 { black() } else { painted() }.save(&file).unwrap();
            Ok((64, 48))
        })
        .expect("painted on the third attempt");
        assert_eq!(seen, vec![1, 2, 3]);
        assert_eq!(got.attempt, 3);
        assert_eq!(got.flat_before, Some([0, 0, 0, 255]));
        assert_eq!(flat_colour(&file).unwrap(), None);
    }

    #[test]
    fn a_window_that_never_paints_is_still_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("shot.png");
        let mut calls = 0;
        let err = capture_until_painted(&file, PAINT_ATTEMPTS, |_| {
            calls += 1;
            black().save(&file).unwrap();
            Ok((64, 48))
        })
        .expect_err("all flat");
        assert_eq!(calls, PAINT_ATTEMPTS);
        assert!(err.contains("one flat colour (#000000)"), "{}", err);
        assert!(err.contains("all 5 attempts"), "{}", err);
        assert!(
            !file.exists(),
            "a flat picture must not be left as evidence"
        );
    }

    #[test]
    fn a_failed_capture_is_not_retried() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("shot.png");
        let mut calls = 0;
        let err = capture_until_painted(&file, PAINT_ATTEMPTS, |_| {
            calls += 1;
            Err("the window is not realised yet".to_string())
        })
        .expect_err("capture failed");
        assert_eq!(calls, 1);
        assert_eq!(err, "the window is not realised yet");
    }

    #[test]
    fn an_empty_picture_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("shot.png");
        let err = capture_until_painted(&file, PAINT_ATTEMPTS, |_| {
            std::fs::write(&file, b"").unwrap();
            Ok((1, 1))
        })
        .expect_err("empty");
        assert!(err.contains("is empty"), "{}", err);
    }

    #[test]
    fn zero_attempts_still_takes_one_picture() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("shot.png");
        let err = capture_until_painted(&file, 0, |_| {
            black().save(&file).unwrap();
            Ok((64, 48))
        })
        .expect_err("flat");
        assert!(err.contains("all 1 attempts"), "{}", err);
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
