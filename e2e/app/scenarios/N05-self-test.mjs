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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, platform, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { Bridge, E2E_IDENTIFIER, appBinaryPath, createLogger, finishScenario, outDir, pngFlatColour, sleep } from "../harness.mjs";

const SCENARIO = "N05-self-test";
const startedAt = Date.now();

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
 * Returns { code, report, dataDir, home, screenshot }.
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
    // The capture is requested directly (no paint-settle wait: the app
    // would be gone by then); the app itself refuses a capture that is one
    // flat colour, and the file is checked again here.
    let lastError = null;
    for (let i = 0; i < 20 && !exit && !shot; i++) {
      try {
        const bridge = Bridge.fromFile(bridgeFile);
        await sleep(100);
        const file = join(evidenceDir, `${name}.png`);
        const res = await bridge.request("POST", "/screenshot", { file }, { timeoutMs: 10_000 });
        const flat = pngFlatColour(file);
        if (flat) throw new Error(`the screenshot is one flat colour (${flat})`);
        shot = { file, bytes: statSync(file).size, width: res.width, height: res.height };
        log(`  screenshot saved: ${shot.file} (${shot.bytes} bytes, ${shot.width}x${shot.height})`);
      } catch (e) {
        lastError = e;
        await sleep(50);
      }
    }
    if (!shot) {
      // A capture the app was still writing when it exited is not evidence.
      rmSync(join(evidenceDir, `${name}.png`), { force: true });
      log(`  (no screenshot: ${lastError?.message ?? "the app exited first"})`);
    }
  }

  const deadline = Date.now() + 120_000;
  while (!exit && Date.now() < deadline) await sleep(100);
  if (!exit) {
    child.kill("SIGKILL");
    throw new Error(`the app did not exit within 120 s — see ${appLog}`);
  }
  log(`  exited after ${Date.now() - started} ms: ${JSON.stringify(exit)}`);
  const json = existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : null;
  rmSync(privateTmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  return { code: exit.code, report: json, dataDir, home, appLog, screenshot: shot };
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
  // The report leaves the machine (CI artifact, sent in by users): the shell
  // prompt must not travel with it.
  const kept = String(checks.pty_echo.transcript_tail ?? "");
  const me = userInfo().username;
  const host = hostname().split(".")[0];
  assert(kept.includes(checks.pty_echo.marker) && kept.length < checks.pty_echo.marker.length + 40, `only the shell's answer line is kept from the transcript (${JSON.stringify(kept)})`);
  assert(!kept.includes("@") && (me.length < 2 || !kept.includes(me)) && (host.length < 2 || !kept.includes(host)), "no user or host name in the kept transcript");
  // Neither do the paths in the report: the home folder is written as "~".
  const dbPath = String(checks.database.path ?? "");
  assert(!dbPath.includes(good.home), `the database path does not carry the home folder (${dbPath})`);
  if (platform() !== "win32") assert(dbPath.startsWith("~/"), `the database path starts with ~ (${dbPath})`);
  for (const [field, value] of Object.entries({ bridge: checks.bridge_resources.bridge, node: checks.bridge_resources.node })) {
    if (typeof value === "string") assert(!value.includes(good.home), `the ${field} path does not carry the home folder (${value})`);
  }
  assert(good.report.identifier === E2E_IDENTIFIER, `the test app identified itself (${good.report.identifier})`);
  assert(good.report.version.length > 0, `version reported: ${good.report.version}`);
  // A picture of the app during the self-test is best effort: the run is
  // over in well under a second, and the paint-complete capture can take
  // longer than the app stays up. The JSON report and the app log are the
  // evidence this scenario is about.
  log(good.screenshot ? `  screenshot: ${good.screenshot.file}` : "  (no screenshot of the self-test window: the app exited before a paint-complete capture)");

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

  // ── 3. A failed PTY check reports a transcript with no user or host name ──
  // The self-test starts $SHELL on Unix. A "shell" that prints a prompt with
  // this machine's user and host names and then never answers makes the
  // check fail; the transcript it reports must not carry those names.
  if (platform() !== "win32") {
    log("step 3: run the self-test with a shell that shows a prompt and never answers");
    const muteShell = join(evidenceDir, "mute-shell.sh");
    writeFileSync(
      muteShell,
      '#!/bin/sh\nprintf "%s@%s ~ %% " "$(id -un)" "$(uname -n)"\nprintf "\\nuser=%s\\n" "$(id -un)"\nsleep 60\n',
      { mode: 0o755 },
    );
    const mute = await runSelfTest("mute-shell", { SHELL: muteShell });
    log(`  report: ${JSON.stringify(mute.report)}`);
    assert(mute.report !== null, "a JSON report was written");
    assert(mute.code === 1, `exit code is 1 (got ${mute.code})`);
    assert(mute.report.checks.pty_echo.ok === false, "the PTY check failed");
    const tail = String(mute.report.checks.pty_echo.transcript_tail ?? "");
    assert(tail.includes("<user@host>"), `the prompt was blanked in the failure transcript (${JSON.stringify(tail)})`);
    assert(!/\S+@\S+/.test(tail.replace(/<user@host>/g, "")), "no user@host token in the failure transcript");
    assert(me.length < 2 || !tail.includes(me), "the user name is not in the failure transcript");
    assert(host.length < 2 || !tail.includes(host), "the host name is not in the failure transcript");
    assert(tail.includes("user=<redacted>"), "a bare user name is blanked too");
  } else {
    log("step 3: skipped on Windows (the self-test does not read $SHELL there)");
  }
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
