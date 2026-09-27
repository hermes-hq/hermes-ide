#!/usr/bin/env node
// Scenario N05: the built-in self-test the release train runs on every
// installed artifact.
//
//   hermes-ide --self-test=<report.json>
//
// Starts the REAL app, which opens its database, checks the bundled bridge
// runtime, waits for the UI to render, runs an echo through a real shell in
// a PTY, writes a JSON report and exits 0. A broken install (here: the
// bridge runtime pointed at a missing file) must exit 1 with the reason in
// the report.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N05-self-test.mjs

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge, E2E_IDENTIFIER, appBinaryPath, createLogger, outDir, sleep } from "../harness.mjs";

const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", "N05-self-test");
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

/** Environment without anything a surrounding Hermes or coding agent put there. */
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(_?HERMES_|CLAUDE_|CLAUDECODE$|ZDOTDIR$|TERM_PROGRAM)/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

/**
 * Run `hermes-ide --self-test=<report>` with a throwaway home folder.
 * Returns { code, report, dataDir, screenshot }.
 */
async function runSelfTest(name, extraEnv = {}, { screenshot = false } = {}) {
  const binary = appBinaryPath();
  if (!existsSync(binary)) throw new Error(`test app not built: ${binary} — run node e2e/app/build.mjs`);
  const runDir = join(evidenceDir, name);
  mkdirSync(runDir, { recursive: true });
  const privateTmp = mkdtempSync(join(tmpdir(), "hermes-e2e-"));
  const home = join(privateTmp, "home");
  mkdirSync(home, { recursive: true });
  const dataDir =
    platform() === "darwin"
      ? join(home, "Library", "Application Support", E2E_IDENTIFIER)
      : join(home, ".local", "share", E2E_IDENTIFIER);
  const report = join(runDir, "self-test.json");
  const bridgeFile = join(runDir, "bridge.json");
  const appLog = join(runDir, "app.log");
  const { openSync, closeSync } = await import("node:fs");
  const fd = openSync(appLog, "w");
  const started = Date.now();
  const child = spawn(binary, [`--self-test=${report}`], {
    cwd: runDir,
    env: {
      ...cleanEnv(),
      HOME: home,
      CFFIXED_USER_HOME: home,
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      TMPDIR: privateTmp,
      TMP: privateTmp,
      TEMP: privateTmp,
      // The bridge only serves the screenshot; the self-test does not need it.
      HERMES_E2E: "1",
      HERMES_E2E_BRIDGE_FILE: bridgeFile,
      RUST_LOG: "info",
      ...extraEnv,
    },
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  let exit = null;
  child.on("exit", (code, signal) => {
    exit = { code, signal };
  });
  log(`  launched ${binary} --self-test=${report} (pid ${child.pid})`);

  let shot = null;
  if (screenshot && platform() === "darwin") {
    // Best effort: a picture of the app while the self-test is running.
    const until = Date.now() + 30_000;
    while (!exit && Date.now() < until && !existsSync(bridgeFile)) await sleep(100);
    // The self-test is quick (about a second), so grab the picture as soon
    // as the bridge answers; retry while the file is still being written.
    let lastError = null;
    for (let i = 0; i < 20 && !exit && !shot; i++) {
      try {
        const bridge = Bridge.fromFile(bridgeFile);
        await sleep(250);
        shot = await bridge.screenshot(join(evidenceDir, `${name}.png`));
        log(`  screenshot saved: ${shot.file} (${shot.bytes} bytes)`);
      } catch (e) {
        lastError = e;
        await sleep(50);
      }
    }
    if (!shot) log(`  (no screenshot: ${lastError?.message ?? "the app exited first"})`);
  }

  const deadline = Date.now() + 120_000;
  while (!exit && Date.now() < deadline) await sleep(100);
  if (!exit) {
    child.kill("SIGKILL");
    throw new Error(`the app did not exit within 120 s — see ${appLog}`);
  }
  log(`  exited after ${Date.now() - started} ms: ${JSON.stringify(exit)}`);
  const json = existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : null;
  rmSync(privateTmp, { recursive: true, force: true });
  return { code: exit.code, report: json, dataDir, appLog, screenshot: shot };
}

let failed = false;
try {
  log(`scenario: N05-self-test   platform: ${platform()}`);

  // ── 1. A healthy install passes ──────────────────────────────────
  log("step 1: run the self-test on a healthy build with a first-launch data folder");
  const good = await runSelfTest("healthy", {}, { screenshot: true });
  log(`  report: ${JSON.stringify(good.report)}`);
  assert(good.report !== null, "a JSON report was written");
  assert(good.code === 0, `exit code is 0 (got ${good.code})`);
  assert(good.report.ok === true, "report.ok is true");
  const checks = good.report.checks ?? {};
  for (const name of ["database", "bridge_resources", "webview", "pty_echo"]) {
    assert(checks[name]?.ok === true, `check "${name}" passed (${JSON.stringify(checks[name])})`);
  }
  assert(typeof checks.pty_echo.shell === "string" && checks.pty_echo.shell.length > 0, `the shell that answered: ${checks.pty_echo.shell}`);
  assert(checks.pty_echo.answered_ms >= checks.pty_echo.typed_ms, "the shell answered after the command was typed");
  assert(good.report.identifier === E2E_IDENTIFIER, `the test app identified itself (${good.report.identifier})`);
  assert(good.report.version.length > 0, `version reported: ${good.report.version}`);
  assert(good.screenshot !== null || platform() !== "darwin", "a screenshot of the running app was taken");

  // ── 2. A broken install fails, with the reason ───────────────────
  log("step 2: run the self-test with the bridge runtime pointed at a missing file");
  const bad = await runSelfTest("broken-bridge", { HERMES_BRIDGE_PATH: "/nonexistent/hermes-claude-bridge.mjs" });
  log(`  report: ${JSON.stringify(bad.report)}`);
  assert(bad.report !== null, "a JSON report was written even though the check failed");
  assert(bad.code === 1, `exit code is 1 (got ${bad.code})`);
  assert(bad.report.ok === false, "report.ok is false");
  assert(bad.report.checks.bridge_resources.ok === false, "the bridge check is the one that failed");
  assert(String(bad.report.checks.bridge_resources.error).includes("non-existent"), `the reason is in the report: ${bad.report.checks.bridge_resources.error}`);
  assert(bad.report.checks.pty_echo.ok === true, "the other checks still ran (pty_echo passed)");
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
}

log(failed ? "RESULT: FAIL" : "RESULT: PASS");
process.exit(failed ? 1 : 0);
