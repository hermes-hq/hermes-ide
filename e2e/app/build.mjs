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

import { spawnSync } from "node:child_process";
import { copyFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, appBinaryPath, outDir } from "./harness.mjs";

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

if (!rustOnly) {
  run(npx, ["vite", "build"], { env: { ...process.env, VITE_HERMES_E2E: "1" } });
}

const targetDir = cargoTargetDir();

// macOS terminals need the small `hermes-pty-setup` helper next to the binary.
// Build it explicitly: the app's build script only finds its output folder
// when the cargo target directory is literally named `target`.
let helper = null;
if (platform() === "darwin") {
  const helperTarget = join(targetDir, "pty-setup-build");
  run("cargo", [
    "build",
    "--manifest-path",
    join(REPO_ROOT, "src-tauri", "pty-setup", "Cargo.toml"),
    "--target-dir",
    helperTarget,
  ]);
  helper = join(helperTarget, "debug", "hermes-pty-setup");
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
]);

const built = join(targetDir, "debug", isWindows ? "hermes-ide.exe" : "hermes-ide");
if (!existsSync(built)) {
  console.error(`[e2e build] expected binary not found: ${built}`);
  process.exit(1);
}

// Stage a private copy: another build in the same target directory must not
// be able to swap the binary under a running test.
const staged = appBinaryPath();
mkdirSync(join(outDir(), "bin"), { recursive: true });
copyFileSync(built, staged);
if (!isWindows) chmodSync(staged, 0o755);
if (helper) {
  const stagedHelper = join(outDir(), "bin", "hermes-pty-setup");
  copyFileSync(helper, stagedHelper);
  chmodSync(stagedHelper, 0o755);
}

console.log(`\n[e2e build] test app ready: ${staged}`);
