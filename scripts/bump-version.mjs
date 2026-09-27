#!/usr/bin/env node
/**
 * Bump the version across the project files. Nothing else: no commit, no
 * tag. The release train tags the merged commit itself, so a locally created
 * tag would only get in the way.
 *
 * Usage:  node scripts/bump-version.mjs 1.4.1
 *         npm run bump -- 1.4.1
 *
 * Touches: package.json, package-lock.json (root entry only),
 *          src-tauri/tauri.conf.json, src-tauri/Cargo.toml,
 *          src-tauri/Cargo.lock (this package's entry only).
 *
 * Refuses when RELEASE_NOTES.md does not name the new version on its first
 * line, because the release workflow refuses the same way — write the notes
 * first. `--allow-stale-notes` skips that check for local experiments.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** True when the first line of the notes names `version` (e.g. "# Hermes IDE 1.4.1"). */
export function notesNameVersion(notesText, version) {
  const first = String(notesText ?? "").split(/\r?\n/, 1)[0] ?? "";
  return new RegExp(`(^|[^0-9.])${version.replace(/\./g, "\\.")}([^0-9.]|$)`).test(first);
}

/** Replace only this package's `version` in Cargo.lock, leaving every dependency alone. */
export function bumpCargoLock(lockText, packageName, version) {
  const re = new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${packageName}"\\r?\\nversion = ")[^"]+(")`);
  if (!re.test(lockText)) return null;
  return lockText.replace(re, `$1${version}$2`);
}

/** Replace the root package version in package-lock.json (two places). */
export function bumpPackageLock(lockText, version) {
  const lock = JSON.parse(lockText);
  lock.version = version;
  if (lock.packages && lock.packages[""]) lock.packages[""].version = version;
  return JSON.stringify(lock, null, 2) + "\n";
}

/**
 * Work out what applying `version` under `root` would write, without writing
 * it. Returns `[{ path, after }]` for every file whose text would change.
 * Throws when the notes are stale (unless allowStaleNotes).
 */
export function planVersion(root, version, { allowStaleNotes = false } = {}) {
  if (!VERSION_RE.test(version)) throw new Error(`version must be X.Y.Z, got ${JSON.stringify(version)}`);

  const notesPath = join(root, "RELEASE_NOTES.md");
  if (!allowStaleNotes) {
    const notes = existsSync(notesPath) ? readFileSync(notesPath, "utf8") : "";
    if (!notesNameVersion(notes, version)) {
      throw new Error(
        `RELEASE_NOTES.md does not name ${version} on its first line. ` +
          `Write the release notes first (the release fails without them), or pass --allow-stale-notes.`,
      );
    }
  }

  const cargoToml = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8");
  const packageName = /^name\s*=\s*"([^"]+)"/m.exec(cargoToml)?.[1] ?? "hermes-ide";

  const edits = [
    { path: "package.json", edit: (src) => src.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`) },
    { path: "package-lock.json", edit: (src) => bumpPackageLock(src, version), optional: true },
    { path: join("src-tauri", "tauri.conf.json"), edit: (src) => src.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`) },
    { path: join("src-tauri", "Cargo.toml"), edit: (src) => src.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`) },
    { path: join("src-tauri", "Cargo.lock"), edit: (src) => bumpCargoLock(src, packageName, version), optional: true },
  ];

  const plan = [];
  for (const { path, edit, optional } of edits) {
    const full = join(root, path);
    if (!existsSync(full)) {
      if (optional) continue;
      throw new Error(`missing ${path}`);
    }
    const before = readFileSync(full, "utf8");
    const after = edit(before);
    if (after === null) throw new Error(`could not find the version to replace in ${path}`);
    if (after !== before) plan.push({ path, after });
  }
  return plan;
}

/**
 * Apply `version` to every file under `root`. Returns the list of files
 * changed. Throws when the notes are stale (unless allowStaleNotes).
 */
export function applyVersion(root, version, opts = {}) {
  const plan = planVersion(root, version, opts);
  for (const { path, after } of plan) writeFileSync(join(root, path), after);
  return plan.map((p) => p.path);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const allowStaleNotes = args.includes("--allow-stale-notes");
  const version = args.find((a) => !a.startsWith("--"));
  if (!version || !VERSION_RE.test(version)) {
    console.error("Usage: node scripts/bump-version.mjs <X.Y.Z> [--allow-stale-notes]");
    process.exit(1);
  }
  const root = fileURLToPath(new URL("..", import.meta.url));
  try {
    const changed = applyVersion(root, version, { allowStaleNotes });
    for (const f of changed) console.log(`  updated ${f}`);
    if (changed.length === 0) console.log("  nothing to change — already at that version");
    console.log(`
  Version is now ${version}. Next:
    git switch -c release/${version}
    git commit -am "Release ${version}"
    open a PR to main; when it merges, the release workflow builds, tests,
    tags v${version} on the merged commit and publishes to the beta channel.
`);
  } catch (e) {
    console.error(`  ${e.message}`);
    process.exit(1);
  }
}
