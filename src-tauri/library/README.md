# Bundled prompt library

`npm run prepare:library` (run by every `tauri build`) writes two files here:

- `catalog-v1.tar.zst` — the prompt library catalog pinned by
  `prompt-library.lock.json`: its manifest and every object (shard lists,
  shards, the vocab, one body per entry), each checked against its sha256.
- `catalog-v1.json` — the catalog version, row count and the archive's size
  and SHA-256.

The app imports the archive into `<app data>/library/library.db` the first
time the Library opens (never at startup), after checking the manifest
against the hash the binary was built with and every object against its own
hash. With it, every entry is searchable and usable with no network.

See `scripts/fetch-prompt-library.mjs` and `src-tauri/src/library/`.

Both files are generated and ignored by git.
