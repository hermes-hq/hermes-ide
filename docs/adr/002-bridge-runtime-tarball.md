# ADR 002 — Bridge runtime as a first-launch tarball (v1.2 candidate)

**Status:** Accepted — implemented (F25); see "As built" at the end
**Date:** 2026-05-09
**Deciders:** TBD
**Supersedes:** the "ship `bridge/node_modules` raw" approach in v1.1.3

## Context

In v1.1.3 we shipped the Claude Agent SDK runtime inside the Tauri bundle as `Resources/bridge/node_modules/` (≈ 210 MB on disk: ~6 MB of ESM JS plus a 200 MB platform-native `claude` binary the SDK shells out to). This unblocked the Agent-mode crash that v1.1.0–v1.1.2 shipped with, but introduced two follow-on problems:

1. **AppImage broken on Linux.** `linuxdeploy` fails to bundle the resulting tree on both x86_64 and aarch64 (the issue is the file count + nested `node_modules` layout, not raw size). v1.1.3 ships `.deb` only; we paused AppImage temporarily.
2. **Updater regression for Linux AppImage users.** Without an AppImage in v1.1.3, `latest.json` has no Linux platform entries — anyone on a v1.1.2 AppImage stops receiving auto-updates until we ship one again.
3. **Bundle size bloat.** Every install — macOS, Windows, Linux — is ~210 MB heavier than v1.1.2. Larger downloads, slower update cycles, more wasted disk on user machines.

The v1.1.3 patch was the right call for shipping the Agent-mode fix urgently. This ADR is about the proper architectural fix that should land in v1.2 (or v1.1.4 if we move quickly).

## Goal

- Restore AppImage on Linux.
- Cut installer/update size back to roughly the v1.1.2 baseline (~15 MB excluding the SDK runtime).
- Keep "Agent mode works out of the box" — no user-visible setup, no PATH dependency, no required network on every launch.
- Survive offline first launch (or fail gracefully with a clear message).

## Options considered

### A. Ship the SDK runtime as a tarball, extract on first launch — **recommended**

At build time, package `node_modules/@anthropic-ai/claude-agent-sdk` + transitive deps + the host-platform native binary into a single compressed tarball (`bridge-runtime-${platform}-${arch}.tar.zst`). Bundle that tarball as a Tauri resource (one ~70 MB file instead of 100 k+ files).

At first launch (or whenever the bundled tarball's version differs from what's on disk), Rust extracts it to `~/.hermes-ide/runtime/v0.2.132/` and points the bridge spawn at that path's `node_modules`.

**Pros**

- One file → linuxdeploy is happy, `cp` is faster, signing is cheaper.
- Compressed: 200 MB native binary → ~70 MB on disk.
- Update flow: when we bump the SDK, the new tarball ships in the new release, the old extracted runtime gets garbage-collected after a grace period.
- AppImage works again.

**Cons**

- First launch latency: ~2-5 s extra on a cold start to decompress + write 100 k files. Mitigation: extract during the splash screen / background task before the user creates an Agent session.
- Disk write requires write permission to the user's home dir. Already required for sessions/state; not a new concern.
- New failure mode: corrupted extracted runtime. Mitigation: verify with a manifest hash, re-extract on mismatch.

### B. Bundle ESM JS, download native binary on first launch

Inline the SDK's JS layer with esbuild (~6 MB), but download `@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude` from npm (or a CDN we control) on first launch. Stash under `~/.hermes-ide/runtime/`.

**Pros**

- Smallest possible installer (~10 MB bigger than v1.1.2, just for the JS).
- Easy to update the SDK independently of the app — fetch latest at runtime.

**Cons**

- **First launch requires network.** Hard fail without it. Awful UX for offline users (which most IDE users hit eventually).
- Adds a "what if npm is down" failure mode that doesn't exist today.
- More moving parts: signature verification of the downloaded binary, retry logic, version-pinning across the SDK library + native package.
- We become a binary distributor, with all the supply-chain concerns that entails.

### C. Embed everything as raw `node_modules` (current state)

Keep v1.1.3's approach, fix linuxdeploy directly (e.g., `--appimage-extract-and-run`, OOM workarounds, custom AppImage tooling).

**Pros**

- No app-side changes.

**Cons**

- Doesn't address the bundle-size bloat (210 MB stays).
- linuxdeploy fixes are fragile — every Linux runner / Tauri bump risks regressing.
- Doesn't unblock future SDK upgrades from getting larger.

### D. Don't ship the SDK at all — require user-installed `claude`

Detect a user-installed `claude` CLI on PATH; bridge defers to it.

**Pros**

- Zero bundle bloat.

**Cons**

- "Agent mode just works" is gone — every user has to install Node + the SDK. We deliberately abandoned this in v1.1.3.

## Decision (proposed)

Go with **Option A** (tarball extract on first launch). Best size reduction, restores AppImage, preserves out-of-the-box UX, no new failure modes that don't already exist (we already write to `~/.hermes-ide/`).

## Implementation sketch

### Build pipeline

- Add `scripts/pack-bridge-runtime.mjs`: produces `src-tauri/bridge/runtime/bridge-runtime.tar.zst` from `src-tauri/bridge/node_modules/`. Includes a `manifest.json` with `{ sdkVersion, files: [{path, sha256}], builtAt }` for integrity.
- `npm run prepare:bridge` extends to call this packer after staging.
- `tauri.conf.json` `bundle.resources` swaps `bridge/node_modules` → `bridge/runtime/bridge-runtime.tar.zst` + `bridge/runtime/manifest.json`. The `bridge/package.json` resource is dropped (no longer relevant on disk after extract).
- `tauri-bundle-resources.test.ts` updated accordingly.

### Runtime layout (Rust side)

- New module: `src-tauri/src/agent/runtime.rs`.
  - `ensure_runtime_extracted(app: &AppHandle) -> Result<PathBuf>`:
    1. Read the bundled `manifest.json` to get the expected SDK version.
    2. Target dir: `${data_dir}/hermes-ide/runtime/${sdkVersion}/`.
    3. If target exists and `manifest.json` inside matches, return the path.
    4. Otherwise extract the bundled `.tar.zst` to a temp dir, atomically rename into place.
    5. (Optional) GC older runtime versions, keeping the latest two.
  - Returns the path to use for the bridge spawn: `${target}/node_modules`.

- `agent::mod::resolve_bridge_path` and the spawn pipeline get a new sibling: `resolve_bridge_runtime_dir`. The spawn cwd / NODE_PATH points at the extracted dir.

### First-launch UX

- During app startup (after `setup()` but before window show), call `ensure_runtime_extracted` in a background task. Most users will never see this — extraction completes while they pick a project.
- If the user opens an Agent session before extraction finishes, show "Preparing agent runtime…" inline in the session. The existing `agentSpawnFailure` formatter already handles "spawn failed: not ready" cleanly; we add a new failure mode for `runtime extraction in progress`.

### Migration

- v1.1.3 → v1.2: on first launch of v1.2, the tarball is extracted alongside (not replacing) the legacy in-bundle runtime. The bridge spawn just points at the new location. Users of the v1.1.3 install can update without rolling back.
- Rolling back: if v1.2 has a fatal bug and we ship a v1.2.1 that reverts to in-bundle, the extracted `~/.hermes-ide/runtime/` becomes dead weight. Add a `cargo run --bin gc-runtime` for diagnostics.

### Tests

- Unit (Rust): tarball extract is atomic; manifest-mismatch triggers re-extract; corrupt tarball reports a clear error.
- Unit (TS / vitest): bridge spawn picks up the extracted location via `resolve_bridge_runtime_dir`.
- Integration: end-to-end Agent session works on a clean `~/.hermes-ide/` (no extracted runtime).
- Bundle smoke: `tauri build` produces an AppImage on Linux x86_64 and aarch64.

### Estimated effort

- Build pipeline + Tauri resource swap: 0.5 day.
- Rust extract module + integration: 1 day.
- First-launch UX + agent-spawn-failure routing: 0.5 day.
- Test coverage: 0.5 day.
- Cross-platform verification (6 builds): 0.5 day.

**Total: ~3 days of focused work.** Ship as v1.2 (not v1.1.4) since this is meaningful behaviour change.

## Open questions

- **Compression format:** zstd is fastest and smallest, but Node's built-in `zlib` doesn't decode it. Rust side handles extraction so this is fine; just noting the format choice can stay flexible.
- **Plugin SDK upgrades mid-runtime:** if we ever support hot-swapping the SDK without restarting the app, the runtime path needs to be versioned (already designed for this — `${sdkVersion}/` segment).
- **Updater bundle for AppImage on Linux:** once AppImage is back, do we re-add Linux to `latest.json`? Probably yes, but coordinate with the website's download page.
- **GC policy:** keep the latest 2 runtime versions, or clean up everything except the current one? The latter is simpler and saves 70 MB+ per orphan. Probably correct.

## What v1.1.3 leaves behind

These are tracked as part of #1/#2 of the punch list (post-v1.1.3 follow-up notes):

- `bridge/node_modules` resource entry in `tauri.conf.json` → swap for tarball.
- `--bundles deb` workaround in `release.yml` → revert to default targets.
- `appimage` block in `tauri.conf.json` linux config → still there, just ignored; no change needed.
- `downloads.json` in release.yml → re-add the `linux/x86_64/appimage` and `linux/aarch64/appimage` entries on the same retag.
- "AppImage builds are temporarily paused" line in RELEASE_NOTES.md → drop.

## As built (F25)

Option A, with these differences from the sketch above:

- **Archive.** `scripts/pack-bridge-runtime.mjs` packs the bridge `.mjs`
  files, `package.json` and `node_modules` (minus npm's `.bin` links) into a
  deterministic tar (sorted entries, fixed timestamps, pax headers for long
  names), compressed with zstd level 19 on several threads: 256 MB in 5 944
  files becomes one 79 MB file. `manifest.json` records the archive's size and
  SHA-256, the file count, the SDK version and an id (from the tar's hash).
  The only bundle resource is the `bridge/runtime` folder.
- **Unpacking.** `src-tauri/src/agent/runtime.rs`, pure Rust (`ruzstd` +
  `tar`, no C toolchain). The archive is checked against the manifest before
  anything is written, unpacked into a temporary folder, counted, marked
  complete and renamed into `<data folder>/runtime/<id>/` (the instance's own
  data folder, not `~/.hermes-ide`). Entries outside the folder, links and
  special files are refused. A runtime missing its marker or a key file is
  unpacked again; other runtimes are removed once the new one is ready.
- **When.** Hermes is terminal-first (ADR 003), so nothing is unpacked at
  startup: the first bridge lookup (the Agent-view warm-up or a session
  spawn) unpacks, on the blocking pool, in about 2 seconds.
- **Self-test.** `--self-test` unpacks the runtime and imports the SDK from it
  with node, so the release smoke proves the archive on every installer.
- **Size** (1.4.0 against a release dry run of this change). macOS DMG
  122 -> 98 MB, macOS update archive 120 -> 96 MB, `.deb` 133 -> 107 MB,
  installed macOS app 310 -> 118 MB. The Windows NSIS installer grows
  94 -> 103 MB: its LZMA compressed the raw runtime better than zstd does.
  Downloads shrink far less than the 210 MB this ADR hoped for: installers
  were already compressed, and the runtime is still shipped.
- **Windows compression, measured.** NSIS compresses the whole installer
  with solid LZMA (8 MB dictionary), which cannot shrink an archive that is
  already compressed. Measured on the runtime tar (260 MB) with the same
  LZMA settings: the raw tar packs to 71.1 MB, the zstd-19 archive to
  79.7 MB, a zstd-1 archive to 109.4 MB; zstd 22 alone reaches 75.6 MB
  (7x slower to pack, and a window over the 100 MB the unpacker allows).
  Shipping an uncompressed tar on Windows would bring the installer back to
  about 95 MB, but leave a 260 MB file in the install folder instead of
  79 MB, on top of the unpacked copy. We keep zstd 19 everywhere: 8 MB more
  download on Windows against 180 MB less disk, one archive format.
- **Disk footprint.** An Agent-view user now keeps both the 79 MB archive
  (in the app bundle) and the unpacked runtime (256 MB, in the data folder):
  about 335 MB, more than the old raw tree (256 MB) on every platform. The
  unpacked copy is per instance (each instance has its own data folder), so
  running several instances that use the Agent view means one 256 MB copy
  each. Users who never open the Agent view (the default, terminal first)
  never unpack it and keep only the 79 MB archive.
- **AppImage and updates.** AppImages are built again, and each Linux
  installer is its own updater bundle: `linux-*-deb` for `.deb` installs,
  `linux-*-appimage` and the plain `linux-*` keys for AppImages.
