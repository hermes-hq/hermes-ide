//! Regression tests for Tauri configuration correctness.
//!
//! Issue #235: the title bar showed "Tauri App" on Linux/Windows because the
//! per-platform override files (`tauri.linux.conf.json`, `tauri.windows.conf.json`)
//! redefine the `app.windows` array without carrying over the `title` field from
//! the base `tauri.conf.json`. Tauri's merger treats those arrays as replace,
//! not deep-merge by index — so the base `title: "HERMES-IDE"` is lost and the
//! OS falls back to the Tauri default window title.
//!
//! This test locks in the fix: any per-platform override file that defines
//! `app.windows` must explicitly set a non-empty `title` on every entry.

use std::path::Path;

const BASE_CONFIG: &str = "tauri.conf.json";
const OVERRIDE_CONFIGS: &[&str] = &["tauri.linux.conf.json", "tauri.windows.conf.json"];

fn read_config(file: &str) -> serde_json::Value {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let path = Path::new(manifest_dir).join(file);
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read {}: {}", path.display(), e));
    serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("failed to parse {} as JSON: {}", path.display(), e))
}

fn base_title() -> String {
    let base = read_config(BASE_CONFIG);
    base.pointer("/app/windows/0/title")
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| {
            panic!(
                "base config {} must define app.windows[0].title",
                BASE_CONFIG
            )
        })
        .to_string()
}

/// Every per-platform override that declares `app.windows` must also set a
/// non-empty `title` on each entry. The base title is the source of truth;
/// overrides must either match it or consciously opt out — but never leave
/// the field missing.
#[test]
fn platform_config_overrides_preserve_window_title() {
    let expected = base_title();
    assert!(!expected.is_empty(), "base config title must be non-empty");

    for file in OVERRIDE_CONFIGS {
        let cfg = read_config(file);
        let Some(windows) = cfg.pointer("/app/windows") else {
            continue; // override doesn't touch app.windows — unaffected
        };
        let arr = windows
            .as_array()
            .unwrap_or_else(|| panic!("{}: app.windows must be an array", file));

        for (idx, window) in arr.iter().enumerate() {
            let title = window
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or_else(|| {
                    panic!(
                        "{}: app.windows[{}] is missing `title` — Tauri's array merge \
                         replaces the whole item, so the base title isn't inherited. \
                         Declare `title` explicitly in the override (see issue #235).",
                        file, idx
                    )
                });

            assert!(
                !title.is_empty(),
                "{}: app.windows[{}].title must be non-empty",
                file,
                idx
            );

            assert_eq!(
                title, expected,
                "{}: app.windows[{}].title = {:?} but base config has {:?}. \
                 Mismatched titles between platforms are almost never intentional.",
                file, idx, title, expected
            );
        }
    }
}

/// Defensive sanity: every override with a window entry must also specify
/// `titleBarStyle` and `hiddenTitle` (the fields these overrides exist for).
/// Catches accidental deletion of the file's original purpose.
#[test]
fn platform_config_overrides_keep_titlebar_fields() {
    for file in OVERRIDE_CONFIGS {
        let cfg = read_config(file);
        let Some(windows) = cfg.pointer("/app/windows") else {
            continue;
        };
        for (idx, window) in windows.as_array().unwrap().iter().enumerate() {
            assert!(
                window.get("titleBarStyle").is_some(),
                "{}: app.windows[{}] should declare titleBarStyle",
                file,
                idx
            );
            assert!(
                window.get("hiddenTitle").is_some(),
                "{}: app.windows[{}] should declare hiddenTitle",
                file,
                idx
            );
        }
    }
}
