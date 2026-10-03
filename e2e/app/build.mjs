#!/usr/bin/env node
// Builds the TEST app: the real frontend (plus the read-only test hooks) inside
// a debug build of the real Tauri binary with the `e2e` feature. It gets its
// own identifier (com.hermes-ide.terminal.e2e), so its data never mixes with
// an installed Hermes.
//
//   node e2e/app/build.mjs            # build everything
//   node e2e/app/build.mjs --rust     # skip the frontend build
//
// Output: <HERMES_E2E_OUT or $TMPDIR/hermes-e2e>/bin/hermes-ide-e2e
//
// The cargo target folder may be shared with other checkouts. The binary is
// compiled with a stamp (see build-stamp.mjs), checked for that stamp before
// and after it is staged, and the stamp is written to bin/build.json so the
// harness can refuse a binary that was built elsewhere.

import { spawnSync } from "node:child_process";
import { copyFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, appBinaryPath, outDir } from "./harness.mjs";
import { STAMP_FILE, binaryHasStamp, buildStamp, hashTree } from "./build-stamp.mjs";

const isWindows = platform() === "win32";
const rustOnly = process.argv.includes("--rust");

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: "inherit", shell: isWindows, ...opts });
  if (res.status !== 0) {
    console.error(`\n[e2e build] '${cmd}' failed with status ${res.status}`);
    process.exit(res.status ?? 1);
  }
}

function cargoTargetDir() {
  const res = spawnSync(
    "cargo",
    ["metadata", "--format-version", "1", "--no-deps", "--manifest-path", join(REPO_ROOT, "src-tauri", "Cargo.toml")],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: isWindows },
  );
  if (res.status !== 0) {
    console.error(res.stderr);
    process.exit(1);
  }
  return JSON.parse(res.stdout).target_directory;
}

const npx = isWindows ? "npx.cmd" : "npx";

// The bundled prompt library (src-tauri/library): fetched and verified once,
// then reused from the cache; the test app reads it from the checkout.
run("node", [join("scripts", "fetch-prompt-library.mjs")]);

if (!rustOnly) {
  run(npx, ["vite", "build"], { env: { ...process.env, VITE_HERMES_E2E: "1" } });
}

const dist = join(REPO_ROOT, "dist");
if (!existsSync(dist)) {
  console.error(`[e2e build] frontend bundle not found: ${dist} — run without --rust first`);
  process.exit(1);
}
const distHash = hashTree(dist);
const stamp = buildStamp({ repoRoot: REPO_ROOT, distHash });
console.log(`[e2e build] build stamp ${stamp} (frontend ${distHash.slice(0, 12)})`);

const targetDir = cargoTargetDir();

// Helpers that live next to the app binary: `hi` (agent launch and signals,
// every OS) and, on macOS, `hermes-pty-setup`. Built explicitly here into
// their own target folders and staged next to the binary below, so the rig
// never depends on where the app's build script managed to put them. Those
// folders are inside this checkout: a target folder shared with other
// checkouts could hand the rig another checkout's helper between the build
// and the copy (the helpers carry no stamp).
function buildHelper(crateDir, binName) {
  const helperTarget = join(REPO_ROOT, "src-tauri", "target", `${crateDir}-e2e-build`);
  run("cargo", [
    "build",
    "--manifest-path",
    join(REPO_ROOT, "src-tauri", crateDir, "Cargo.toml"),
    "--target-dir",
    helperTarget,
  ]);
  const built = join(helperTarget, "debug", isWindows ? `${binName}.exe` : binName);
  if (!existsSync(built)) {
    console.error(`[e2e build] helper not found after build: ${built}`);
    process.exit(1);
  }
  return built;
}
const helpers = [{ built: buildHelper("hi", "hi"), name: isWindows ? "hi.exe" : "hi" }];
if (platform() === "darwin") {
  helpers.push({ built: buildHelper("pty-setup", "hermes-pty-setup"), name: "hermes-pty-setup" });
}
// The session host (N20) keeps terminals alive while the app is closed;
// macOS and Linux for now.
if (!isWindows) {
  helpers.push({ built: buildHelper("pty-host", "hermes-pty-host"), name: "hermes-pty-host" });
}

run(npx, [
  "tauri",
  "build",
  "--debug",
  "--no-bundle",
  "--ignore-version-mismatches",
  "--features",
  "e2e",
  "--config",
  "src-tauri/tauri.e2e.conf.json",
], { env: { ...process.env, HERMES_E2E_BUILD_STAMP: stamp } });

const built = join(targetDir, "debug", isWindows ? "hermes-ide.exe" : "hermes-ide");
if (!existsSync(built)) {
  console.error(`[e2e build] expected binary not found: ${built}`);
  process.exit(1);
}

function mustCarryStamp(file, what) {
  if (binaryHasStamp(file, stamp)) return;
  console.error(
    `[e2e build] ${what} ${file} does not carry this build's stamp: another build in the shared target folder ` +
      `${targetDir} replaced it. Run the build again (or give this checkout its own CARGO_TARGET_DIR).`,
  );
  process.exit(1);
}

// Stage a private copy: another build in the same target directory must not
// be able to swap the binary under a running test. Check the stamp on both
// ends of the copy — the swap can happen between our link step and now.
mustCarryStamp(built, "the compiled binary");
const staged = appBinaryPath();
mkdirSync(join(outDir(), "bin"), { recursive: true });
copyFileSync(built, staged);
if (!isWindows) chmodSync(staged, 0o755);
mustCarryStamp(staged, "the staged binary");
writeFileSync(
  join(outDir(), "bin", STAMP_FILE),
  JSON.stringify({ stamp, distHash, builtAt: new Date().toISOString() }, null, 2) + "\n",
);
for (const { built: helperBin, name } of helpers) {
  const stagedHelper = join(outDir(), "bin", name);
  copyFileSync(helperBin, stagedHelper);
  if (!isWindows) chmodSync(stagedHelper, 0o755);
  console.log(`[e2e build] staged helper ${stagedHelper}`);
}

// The bundled prompt library, next to the binary as an installer's resource
// folder would be, so the staged app works wherever it is copied (CI shards).
mkdirSync(join(outDir(), "bin", "library"), { recursive: true });
for (const name of ["catalog-v1.tar.zst", "catalog-v1.json"]) {
  copyFileSync(join(REPO_ROOT, "src-tauri", "library", name), join(outDir(), "bin", "library", name));
}
console.log(`[e2e build] staged the bundled prompt library in ${join(outDir(), "bin", "library")}`);

console.log(`\n[e2e build] test app ready: ${staged} (stamp ${stamp})`);
