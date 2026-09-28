# Packed bridge runtime

`npm run prepare:bridge` (run by every `tauri build`) writes two files here:

- `bridge-runtime.tar.zst` — the bridge scripts and their `node_modules`
  (the Claude Agent SDK and its native `claude` binary), in one archive.
- `manifest.json` — its id, size and SHA-256.

This folder is the only bridge resource in the installer. The app unpacks the
archive into its data folder the first time an Agent-view session needs the
bridge, and reuses it after that. See `docs/adr/002-bridge-runtime-tarball.md`,
`scripts/pack-bridge-runtime.mjs` and `src-tauri/src/agent/runtime.rs`.

Both files are generated and ignored by git.
