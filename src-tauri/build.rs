fn main() {
    // Helpers that ship next to the app binary. Each is its own tiny crate
    // built into a separate target folder (a build script cannot build into
    // the target folder cargo is already using) and copied next to the
    // binary being built. `hi` starts and observes agents on every OS
    // (src-tauri/hi); `hermes-pty-setup` is the macOS controlling-terminal
    // trampoline (src-tauri/pty-setup).
    build_helper("hi", "hi", "hi");
    #[cfg(target_os = "macos")]
    build_helper("pty-setup", "hermes-pty-setup", "pty-setup");
    tauri_build::build()
}

/// The folder the main binary is built into, from OUT_DIR
/// (`<target>[/<triple>]/<profile>/build/<pkg>-<hash>/out`).
fn profile_dir() -> Option<std::path::PathBuf> {
    let out_dir = std::path::PathBuf::from(std::env::var("OUT_DIR").ok()?);
    let dir = out_dir.ancestors().nth(3)?;
    if dir.parent().is_some() && dir.file_name().is_some() {
        Some(dir.to_path_buf())
    } else {
        None
    }
}

fn build_helper(crate_dir: &str, bin_name: &str, build_dir: &str) {
    let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let helper_dir = manifest_dir.join(crate_dir);
    if !helper_dir.join("Cargo.toml").exists() {
        return;
    }
    println!(
        "cargo:rerun-if-changed={}",
        helper_dir.join("src").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        helper_dir.join("Cargo.toml").display()
    );

    let Some(profile_dir) = profile_dir() else {
        return;
    };
    let release = std::env::var("PROFILE")
        .map(|p| p == "release")
        .unwrap_or(false);
    let helper_target_dir = manifest_dir
        .join("target")
        .join(format!("{build_dir}-build"));
    let mut cmd =
        std::process::Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()));
    cmd.args([
        "build",
        "--manifest-path",
        helper_dir.join("Cargo.toml").to_str().unwrap(),
        "--target-dir",
        helper_target_dir.to_str().unwrap(),
    ]);
    if release {
        cmd.arg("--release");
    }
    // A cross-compile (`--target <triple>`) must build the helper for the
    // same triple; cargo passes it to build scripts as TARGET.
    let mut built = helper_target_dir.clone();
    if let (Ok(target), Ok(host)) = (std::env::var("TARGET"), std::env::var("HOST")) {
        if target != host {
            cmd.args(["--target", &target]);
            built = built.join(&target);
        }
    }
    let exe = if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        format!("{bin_name}.exe")
    } else {
        bin_name.to_string()
    };
    built = built
        .join(if release { "release" } else { "debug" })
        .join(&exe);

    match cmd.status() {
        Ok(s) if s.success() => {
            if built.exists() {
                if let Err(e) = std::fs::copy(&built, profile_dir.join(&exe)) {
                    println!("cargo:warning=Failed to copy {bin_name}: {e}");
                }
                // The Windows and Linux bundles pick `hi` up as a resource
                // (tauri.windows.conf.json, tauri.linux.conf.json list
                // helpers/hi); the macOS release copies it into
                // Contents/MacOS and signs it (release.yml). Copied before
                // tauri_build::build() checks that the resource exists.
                if bin_name == "hi" {
                    let helpers = manifest_dir.join("helpers");
                    if let Err(e) = std::fs::create_dir_all(&helpers)
                        .and_then(|_| std::fs::copy(&built, helpers.join(&exe)))
                    {
                        println!("cargo:warning=Failed to stage {bin_name} for the bundle: {e}");
                    }
                }
            } else {
                println!(
                    "cargo:warning={bin_name} was built but not found at {}",
                    built.display()
                );
            }
        }
        Ok(s) => println!(
            "cargo:warning=Failed to build {bin_name} (exit code: {:?})",
            s.code()
        ),
        Err(e) => println!("cargo:warning=Failed to build {bin_name}: {e}"),
    }
}
