// The build stamp: how the rig knows the binary it runs is the one it built.
//
// build.mjs compiles the test app in a cargo target folder that may be shared
// with other checkouts (a CI cache, a developer's shared target dir). Another
// build of the same package can replace `target/debug/hermes-ide` between our
// link step and our copy, and the rig would then test someone else's binary.
//
// So build.mjs passes a stamp to the compiler (HERMES_E2E_BUILD_STAMP, read
// with option_env! in src-tauri/src/e2e_bridge.rs), checks the bytes of the
// binary it stages for that stamp, writes the stamp next to the staged binary
// (bin/build.json), and the harness refuses to run an app whose /health
// reports a different stamp.
//
// The stamp is a hash of the checkout's location and the frontend bundle, so
// rebuilding the same checkout without changes keeps cargo's cache warm while
// two checkouts (or two frontends) can never share a stamp.

import { createHash } from "node:crypto";
import { existsSync, openSync, readdirSync, readFileSync, readSync, closeSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const STAMP_PREFIX = "hermes-e2e-build-";
export const STAMP_FILE = "build.json";

/** Content hash of every file under `dir` (paths and bytes), independent of walk order. */
export function hashTree(dir) {
  const files = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(dir);
  files.sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(dir, file).split(sep).join("/"));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * The stamp for a build of `repoRoot` with the frontend bundle `distHash`.
 * Same inputs, same stamp (cargo keeps its cache); any other checkout or
 * bundle, a different one.
 */
export function buildStamp({ repoRoot, distHash }) {
  const digest = createHash("sha256").update(`${repoRoot}\0${distHash}`).digest("hex");
  return STAMP_PREFIX + digest.slice(0, 32);
}

/** True when the file's bytes contain `stamp`. Streams the file; a debug binary is large. */
export function binaryHasStamp(file, stamp, { chunkSize = 8 * 1024 * 1024 } = {}) {
  if (!existsSync(file)) return false;
  const needle = Buffer.from(stamp, "utf8");
  if (needle.length === 0) throw new Error("empty stamp");
  const size = statSync(file).size;
  const fd = openSync(file, "r");
  try {
    // Keep the last needle.length-1 bytes of the previous chunk, so a stamp
    // that straddles two chunks is still found.
    let carry = Buffer.alloc(0);
    let offset = 0;
    const chunk = Buffer.alloc(chunkSize);
    while (offset < size) {
      const n = readSync(fd, chunk, 0, chunkSize, offset);
      if (n <= 0) break;
      offset += n;
      const window = Buffer.concat([carry, chunk.subarray(0, n)]);
      if (window.indexOf(needle) !== -1) return true;
      carry = Buffer.from(window.subarray(Math.max(0, window.length - (needle.length - 1))));
    }
    return false;
  } finally {
    closeSync(fd);
  }
}

/** The stamp build.mjs recorded next to the staged binary, or null when there is none. */
export function readBuildStamp(binDir) {
  const file = join(binDir, STAMP_FILE);
  if (!existsSync(file)) return null;
  const info = JSON.parse(readFileSync(file, "utf8"));
  return typeof info.stamp === "string" && info.stamp ? info : null;
}

/**
 * Why a running app is not the one build.mjs staged, or null when it is.
 * `expected` is what readBuildStamp returned (null: nothing recorded, so
 * nothing to compare — a binary that was not staged by build.mjs).
 */
export function buildStampMismatch(health, expected) {
  if (!expected) return null;
  const running = typeof health?.build === "string" ? health.build : null;
  if (running === expected.stamp) return null;
  return running
    ? `the running app was built with stamp ${running}, but build.mjs staged ${expected.stamp}`
    : `the running app carries no build stamp, but build.mjs staged ${expected.stamp}`;
}
