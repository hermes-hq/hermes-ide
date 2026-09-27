#!/usr/bin/env node
// Scenario: a release build with the automation bridge compiled in must not
// exist. `cargo check --release --features e2e` has to fail with the guard's
// message, while the same check in a debug profile succeeds (so the failure
// is the guard, not a broken crate).
//
// Needs the Rust toolchain and the app's build dependencies; on CI it runs
// on Linux only (see e2e/acceptance.yml).
//
//   node e2e/app/scenarios/N01-release-refuses-e2e.mjs

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, createLogger, finishScenario, outDir } from "../harness.mjs";

const SCENARIO = "N01-release-refuses-e2e";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);
const GUARD = "must never be compiled into a release build";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

function cargoCheck(extra) {
  // Plain text, whatever the environment says (CI exports CARGO_TERM_COLOR=always):
  // the assertions below read cargo's messages.
  const args = ["check", "--lib", "--features", "e2e", "--color", "never", "--manifest-path", join(REPO_ROOT, "src-tauri", "Cargo.toml"), ...extra];
  log(`  $ cargo ${args.join(" ")}`);
  const res = spawnSync("cargo", args, {
    cwd: REPO_ROOT,
    env: { ...process.env, CARGO_TERM_COLOR: "never" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: platform() === "win32",
    timeout: 20 * 60_000,
  });
  const tail = (res.stderr ?? "").trim().split("\n").slice(-6).join("\n    ");
  log(`  exit ${res.status}${res.signal ? ` (signal ${res.signal})` : ""}; stderr tail:\n    ${tail}`);
  return res;
}

let failed = false;
try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}`);

  log("step 1: a release profile with the e2e feature refuses to compile");
  const release = cargoCheck(["--release"]);
  assert(release.status !== 0, `cargo check --release --features e2e failed (exit ${release.status})`);
  assert((release.stderr ?? "").includes(GUARD), `the failure is the guard: "${GUARD}"`);
  assert(/error: could not compile `hermes-ide`/.test(release.stderr ?? ""), "and it is the app crate that refuses, not a dependency");

  log("step 2: the same check in the debug profile compiles (control)");
  const debug = cargoCheck([]);
  assert(debug.status === 0, "cargo check --features e2e succeeds in the debug profile");
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
