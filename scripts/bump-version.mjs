#!/usr/bin/env node
/**
 * Bump the version across all project files, commit, and create a git tag.
 *
 * Usage:  node scripts/bump-version.mjs 0.4.0
 *         npm run bump -- 0.4.0
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("Usage: node scripts/bump-version.mjs <X.Y.Z>");
  process.exit(1);
}

const files = [
  {
    path: "package.json",
    replace: (src) => src.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`),
  },
  {
    path: "src-tauri/tauri.conf.json",
    replace: (src) => src.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`),
  },
  {
    path: "src-tauri/Cargo.toml",
    replace: (src) => src.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`),
  },
];

for (const file of files) {
  const content = readFileSync(file.path, "utf-8");
  const updated = file.replace(content);
  if (content === updated) {
    console.error(`  WARNING: No change in ${file.path}`);
  } else {
    writeFileSync(file.path, updated);
    console.log(`  Updated ${file.path}`);
  }
}

// Update Cargo.lock
console.log("  Updating Cargo.lock...");
execSync("cargo generate-lockfile", { cwd: "src-tauri", stdio: "inherit" });

// Stage, commit, tag
execSync(`git add package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock RELEASE_NOTES.md`, { stdio: "inherit" });
execSync(`git commit -m "Bump v${version}"`, { stdio: "inherit" });
execSync(`git tag v${version}`, { stdio: "inherit" });

console.log(`\n  Bumped to v${version} and tagged v${version}.`);
console.log(`  Push with:  git push && git push --tags\n`);
