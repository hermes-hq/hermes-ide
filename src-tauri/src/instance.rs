//! Which Hermes instance this process is, and where it keeps its data.
//!
//! An installed Hermes, a dev build, a beta and an e2e test build can all run
//! on the same machine at the same time. Each one must keep to its own data
//! folder and its own temp files:
//!
//! - The data folder is `<platform data dir>/<bundle identifier>`, or the
//!   absolute path in `HERMES_DATA_DIR` when that is set. A released app with
//!   the production identifier ignores `HERMES_DATA_DIR`, so a stray variable
//!   in a user's shell cannot start it on an empty data folder.
//! - Builds that must never touch the installed app's data (e2e builds, debug
//!   builds, and any build whose identifier is not the production one) refuse
//!   to start when their data folder resolves to the production folder.
//! - Shell-integration temp files live under a temp folder derived from the
//!   data folder, so startup cleanup only ever sees this instance's files.

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

/// Bundle identifier of the released app. Its data folder is off limits to
/// every other kind of build.
pub const PRODUCTION_IDENTIFIER: &str = "com.hermes-ide.terminal";

/// Absolute path that replaces the default data folder. Ignored by a release
/// build with the production identifier.
pub const DATA_DIR_ENV: &str = "HERMES_DATA_DIR";

/// `1` lets a debug build with the production identifier use the production
/// data folder. Has no effect on e2e builds or other identifiers.
pub const ALLOW_PRODUCTION_ENV: &str = "HERMES_ALLOW_PRODUCTION_DATA";

#[derive(Debug, Clone)]
pub struct Instance {
    pub identifier: String,
    pub data_dir: PathBuf,
    pub shell_temp_root: PathBuf,
    /// True for the installed app itself (and a debug build explicitly let
    /// into its data): the only instance that may clean up what older
    /// versions of the installed app left in the shared temp folder.
    pub owns_production_data: bool,
}

static INSTANCE: OnceLock<Instance> = OnceLock::new();

/// Whether this build must stay out of the production data folder.
pub fn must_avoid_production(
    identifier: &str,
    e2e_build: bool,
    debug_build: bool,
    allow_opt_in: bool,
) -> bool {
    if e2e_build || identifier != PRODUCTION_IDENTIFIER {
        return true;
    }
    debug_build && !allow_opt_in
}

/// Whether this build reads `HERMES_DATA_DIR`. Only the released app with the
/// production identifier does not: it always uses its own data folder.
pub fn honours_data_dir_override(identifier: &str, e2e_build: bool, debug_build: bool) -> bool {
    e2e_build || debug_build || identifier != PRODUCTION_IDENTIFIER
}

/// The data folder: the override when given, else `<base>/<identifier>`.
pub fn resolve_data_dir(
    identifier: &str,
    override_value: Option<OsString>,
    platform_data_dir: Option<PathBuf>,
) -> Result<PathBuf, String> {
    if let Some(value) = override_value.filter(|v| !v.is_empty()) {
        let path = PathBuf::from(value);
        if !path.is_absolute() {
            return Err(format!(
                "{} must be an absolute path, got {:?}",
                DATA_DIR_ENV, path
            ));
        }
        return Ok(path);
    }
    platform_data_dir
        .map(|base| base.join(identifier))
        .ok_or_else(|| "cannot determine the platform data folder".to_string())
}

/// Removes `.` and resolves `..` without touching the file system.
fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Resolves symlinks in the longest part of `path` that exists.
fn canonical_best_effort(path: &Path) -> PathBuf {
    let path = lexical_normalize(path);
    let mut existing = path.as_path();
    let mut rest: Vec<&std::ffi::OsStr> = Vec::new();
    loop {
        if let Ok(canonical) = std::fs::canonicalize(existing) {
            let mut out = canonical;
            for part in rest.iter().rev() {
                out.push(part);
            }
            return out;
        }
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name);
                existing = parent;
            }
            _ => return path,
        }
    }
}

fn has_production_component(path: &Path) -> bool {
    path.components().any(|c| {
        c.as_os_str()
            .to_str()
            .is_some_and(|s| s.eq_ignore_ascii_case(PRODUCTION_IDENTIFIER))
    })
}

/// Case-insensitive prefix test on file systems that are usually
/// case-insensitive (macOS, Windows); exact elsewhere.
fn starts_with_path(path: &Path, prefix: &Path) -> bool {
    if cfg!(any(target_os = "macos", windows)) {
        let lower = |p: &Path| PathBuf::from(p.to_string_lossy().to_lowercase());
        lower(path).starts_with(lower(prefix))
    } else {
        path.starts_with(prefix)
    }
}

#[cfg(unix)]
fn same_dir(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
        _ => false,
    }
}

#[cfg(not(unix))]
fn same_dir(_a: &Path, _b: &Path) -> bool {
    false
}

/// True when `candidate` is the production data folder or anything inside it,
/// however it is spelled (`..`, symlinks, letter case).
pub fn touches_production(candidate: &Path, production_dirs: &[PathBuf]) -> bool {
    let lexical = lexical_normalize(candidate);
    let canonical = canonical_best_effort(candidate);
    if has_production_component(&lexical) || has_production_component(&canonical) {
        return true;
    }
    for prod in production_dirs {
        let prod_lexical = lexical_normalize(prod);
        let prod_canonical = canonical_best_effort(prod);
        if starts_with_path(&lexical, &prod_lexical)
            || starts_with_path(&canonical, &prod_canonical)
        {
            return true;
        }
        if canonical.ancestors().any(|a| same_dir(a, &prod_canonical)) {
            return true;
        }
    }
    false
}

/// Deterministic FNV-1a hash, used to name the per-instance temp folder.
pub(crate) fn fnv1a_hash(input: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// A stable hash of an instance's data folder (symlinks resolved), the key
/// every per-instance folder outside app data is named by.
pub(crate) fn instance_hash(data_dir: &Path) -> u64 {
    let canonical = canonical_best_effort(data_dir);
    fnv1a_hash(canonical.to_string_lossy().as_bytes())
}

/// `<temp>/hermes-shell-<hash of the data folder>`: one folder per instance.
pub fn shell_temp_root_for(temp_dir: &Path, data_dir: &Path) -> PathBuf {
    temp_dir.join(format!("hermes-shell-{:016x}", instance_hash(data_dir)))
}

/// Works out this process's instance. Must run first thing in `run()`, before
/// anything reads or writes app data. An `Err` means the process must exit.
pub fn init(identifier: &str) -> Result<&'static Instance, String> {
    if let Some(existing) = INSTANCE.get() {
        return Ok(existing);
    }
    let e2e_build = cfg!(feature = "e2e");
    let debug_build = cfg!(debug_assertions);
    let mut override_value = std::env::var_os(DATA_DIR_ENV).filter(|v| !v.is_empty());
    if !honours_data_dir_override(identifier, e2e_build, debug_build) {
        if let Some(ignored) = override_value.take() {
            log::warn!(
                "[instance] ignoring {}={:?}: the released app always uses its own data folder",
                DATA_DIR_ENV,
                ignored
            );
        }
    }
    let allow = std::env::var(ALLOW_PRODUCTION_ENV).as_deref() == Ok("1");
    let strict = must_avoid_production(identifier, e2e_build, debug_build, allow);
    let platform_data_dir = dirs::data_dir();
    let data_dir = resolve_data_dir(identifier, override_value, platform_data_dir.clone())?;

    if strict {
        let production: Vec<PathBuf> = platform_data_dir
            .map(|base| vec![base.join(PRODUCTION_IDENTIFIER)])
            .unwrap_or_default();
        if touches_production(&data_dir, &production) {
            let kind = if cfg!(feature = "e2e") {
                "test (e2e)"
            } else if identifier != PRODUCTION_IDENTIFIER {
                "non-production"
            } else {
                "debug"
            };
            return Err(refusal_message(kind, identifier, &data_dir));
        }
    }

    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("cannot create data folder {:?}: {}", data_dir, e))?;
    let shell_temp_root = shell_temp_root_for(&std::env::temp_dir(), &data_dir);

    // Terminals started by this instance must not pass the override on to a
    // Hermes launched from inside them.
    std::env::remove_var(DATA_DIR_ENV);
    std::env::remove_var(ALLOW_PRODUCTION_ENV);

    Ok(INSTANCE.get_or_init(|| Instance {
        identifier: identifier.to_string(),
        data_dir,
        shell_temp_root,
        owns_production_data: !strict,
    }))
}

/// Why a build refuses to start on `data_dir`. The check is deliberately
/// broad (any folder named after the production identifier counts), so the
/// message does not claim the folder is the installed app's.
fn refusal_message(kind: &str, identifier: &str, data_dir: &Path) -> String {
    format!(
        "refusing to start: this {} build ({}) would use {:?}, which is, is inside, or is named like \
         the installed Hermes app's data folder ({}). Point {} at a separate folder \
         (`npm run tauri dev` uses its own identifier).",
        kind, identifier, data_dir, PRODUCTION_IDENTIFIER, DATA_DIR_ENV
    )
}

/// Whether this process is the installed app (see `Instance::owns_production_data`).
/// False in unit tests, which never call `init`.
pub fn owns_production_data() -> bool {
    INSTANCE.get().is_some_and(|i| i.owns_production_data)
}

/// This instance's data folder. Use instead of `app.path().app_data_dir()`.
pub fn app_data_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    if let Some(instance) = INSTANCE.get() {
        return Ok(instance.data_dir.clone());
    }
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))
}

/// Folder for this instance's shell-integration temp files.
pub fn shell_temp_root() -> PathBuf {
    match INSTANCE.get() {
        Some(instance) => instance.shell_temp_root.clone(),
        // Only reached in unit tests, which never call `init`. One shared
        // folder: entry names already carry the creating process id.
        None => std::env::temp_dir().join("hermes-shell-unscoped"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prod_under(base: &Path) -> PathBuf {
        base.join(PRODUCTION_IDENTIFIER)
    }

    #[test]
    fn e2e_and_non_production_builds_always_avoid_production() {
        assert!(must_avoid_production(
            PRODUCTION_IDENTIFIER,
            true,
            false,
            true
        ));
        assert!(must_avoid_production(
            "com.hermes-ide.terminal.dev",
            false,
            false,
            true
        ));
        assert!(must_avoid_production(
            "com.hermes-ide.terminal.beta",
            false,
            false,
            false
        ));
    }

    #[test]
    fn debug_production_build_avoids_production_unless_opted_in() {
        assert!(must_avoid_production(
            PRODUCTION_IDENTIFIER,
            false,
            true,
            false
        ));
        assert!(!must_avoid_production(
            PRODUCTION_IDENTIFIER,
            false,
            true,
            true
        ));
    }

    #[test]
    fn release_production_build_may_use_production() {
        assert!(!must_avoid_production(
            PRODUCTION_IDENTIFIER,
            false,
            false,
            false
        ));
    }

    #[test]
    fn released_production_app_ignores_the_data_dir_override() {
        assert!(!honours_data_dir_override(
            PRODUCTION_IDENTIFIER,
            false,
            false
        ));
    }

    #[test]
    fn dev_test_and_other_builds_honour_the_data_dir_override() {
        assert!(honours_data_dir_override(
            PRODUCTION_IDENTIFIER,
            true,
            false
        ));
        assert!(honours_data_dir_override(
            PRODUCTION_IDENTIFIER,
            false,
            true
        ));
        assert!(honours_data_dir_override(
            "com.hermes-ide.terminal.beta",
            false,
            false
        ));
        assert!(honours_data_dir_override(
            "com.hermes-ide.terminal.e2e",
            true,
            false
        ));
    }

    #[test]
    fn default_data_dir_is_base_plus_identifier() {
        let dir = resolve_data_dir("com.x.dev", None, Some(PathBuf::from("/base"))).unwrap();
        assert_eq!(dir, PathBuf::from("/base/com.x.dev"));
    }

    #[test]
    fn override_wins_and_empty_override_is_ignored() {
        // Absolute on every OS ("/elsewhere" is not absolute on Windows).
        let elsewhere = std::env::temp_dir().join("elsewhere").join("data");
        let dir = resolve_data_dir(
            "com.x.dev",
            Some(elsewhere.clone().into_os_string()),
            Some(PathBuf::from("/base")),
        )
        .unwrap();
        assert_eq!(dir, elsewhere);
        let dir = resolve_data_dir(
            "com.x.dev",
            Some(OsString::new()),
            Some(PathBuf::from("/b")),
        )
        .unwrap();
        assert_eq!(dir, PathBuf::from("/b/com.x.dev"));
    }

    #[test]
    fn relative_override_is_rejected() {
        let err = resolve_data_dir("com.x", Some(OsString::from("rel/dir")), None).unwrap_err();
        assert!(err.contains(DATA_DIR_ENV));
    }

    #[test]
    fn production_folder_is_detected_directly_and_inside() {
        let base = tempfile::tempdir().unwrap();
        let prod = prod_under(base.path());
        std::fs::create_dir_all(&prod).unwrap();
        let prods = [prod.clone()];
        assert!(touches_production(&prod, &prods));
        assert!(touches_production(&prod.join("sub"), &prods));
        assert!(touches_production(
            &base
                .path()
                .join("com.hermes-ide.terminal.e2e/../com.hermes-ide.terminal"),
            &prods
        ));
    }

    #[test]
    fn sibling_identifiers_are_not_production() {
        let base = tempfile::tempdir().unwrap();
        let prods = [prod_under(base.path())];
        std::fs::create_dir_all(&prods[0]).unwrap();
        for id in [
            "com.hermes-ide.terminal.e2e",
            "com.hermes-ide.terminal.dev",
            "com.hermes-ide.terminal.beta",
            "com.hermes-ide.terminal-other",
        ] {
            assert!(
                !touches_production(&base.path().join(id), &prods),
                "{} flagged as production",
                id
            );
        }
        assert!(!touches_production(
            &base.path().join("some-test-dir"),
            &prods
        ));
    }

    #[test]
    fn production_folder_is_detected_under_any_letter_case() {
        // Even when the production folder lives somewhere else entirely, a
        // path whose folder is named like it is refused.
        assert!(touches_production(
            Path::new("/somewhere/COM.Hermes-IDE.Terminal"),
            &[]
        ));
    }

    #[cfg(unix)]
    #[test]
    fn production_folder_is_detected_through_a_symlink() {
        let base = tempfile::tempdir().unwrap();
        let prod = prod_under(base.path());
        std::fs::create_dir_all(&prod).unwrap();
        let alias = base.path().join("innocent-name");
        std::os::unix::fs::symlink(&prod, &alias).unwrap();
        // Also detected with no production list at all, by name after
        // resolving the link.
        assert!(touches_production(&alias, &[]));
        assert!(touches_production(
            &alias.join("nested"),
            std::slice::from_ref(&prod)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn renamed_production_folder_is_detected_by_identity() {
        // The production list points at a folder by a path whose last part is
        // not the identifier (e.g. a symlinked home); the candidate reaches it
        // by another route. Identity (same inode) still matches.
        let base = tempfile::tempdir().unwrap();
        let real = base.path().join("real-data");
        std::fs::create_dir_all(&real).unwrap();
        let link = base.path().join("link-to-data");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(touches_production(&real.join("x"), &[link]));
    }

    #[test]
    fn refusal_names_the_folder_the_fix_and_does_not_overclaim() {
        let msg = refusal_message(
            "test (e2e)",
            PRODUCTION_IDENTIFIER,
            Path::new("/tmp/com.hermes-ide.terminal/scratch"),
        );
        assert!(msg.starts_with("refusing to start"));
        assert!(msg.contains("\"/tmp/com.hermes-ide.terminal/scratch\""));
        assert!(msg.contains("named like"));
        assert!(msg.contains(DATA_DIR_ENV));
    }

    #[test]
    fn temp_root_depends_on_data_dir_only() {
        let tmp = Path::new("/tmp-root");
        let a1 = shell_temp_root_for(tmp, Path::new("/data/a"));
        let a2 = shell_temp_root_for(tmp, Path::new("/data/a"));
        let b = shell_temp_root_for(tmp, Path::new("/data/b"));
        assert_eq!(a1, a2);
        assert_ne!(a1, b);
        assert!(a1.starts_with(tmp));
        let name = a1.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with("hermes-shell-"), "{}", name);
        // Never the legacy names an older Hermes sweeps at startup.
        assert!(!name.starts_with("hermes-zsh-") && !name.starts_with("hermes-bash-"));
    }
}
