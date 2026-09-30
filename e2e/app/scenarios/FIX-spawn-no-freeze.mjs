#!/usr/bin/env node
// Scenario FIX-spawn-no-freeze: a terminal that takes long to open (a spawn
// stuck in the OS) never freezes the rest of the app, on the REAL app.
//
// Found on the macOS CI runner (N20-session-host): after a relaunch, opening
// a restored terminal never finished (the app log stops before "Spawned PTY
// child"), and from then on the webview answered nothing and Quit did not
// work. Opening a terminal held the PTY manager the whole time, and every
// command that needs it (listing sessions, typing, resizing, quitting) waits
// for it; most of them run on the main thread, so the whole window froze.
//
// The test build holds the opening of each terminal for a while
// (HERMES_E2E_SLOW_SPAWN_MS, e2e builds only), as a stuck spawn does:
//
//   1. a terminal is being opened (held for 8 s): meanwhile the app answers
//      at once, three times over (the sessions list, a command that needs
//      the PTY manager and runs on the main thread), and the window is
//      still drawn (a screenshot);
//   2. the terminal opens once the hold ends and is listed;
//   3. another terminal is being opened (held again): Quit still works, and
//      the app exits by itself.
//
// Negative control (must end in RESULT: FAIL): a build of main with only the
// test hook added (the PTY manager held across the spawn) — the app stops
// answering during step 1.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/FIX-spawn-no-freeze.mjs

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";
import { completeOnboarding } from "../n11-steps.mjs";

const SCENARIO = "FIX-spawn-no-freeze";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);
const HOLD_MS = 8_000;
/** How long one answer may take while a terminal is being opened. */
const ANSWER_MS = 2_500;

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

const onWindows = platform() === "win32";
const homeDir = onWindows ? undefined : mkdtempSync(join(tmpdir(), "hermes-e2e-spawnfreeze-home-"));
let app = null;
let failed = false;
try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   hold: ${HOLD_MS} ms`);
  const env = { HERMES_E2E_SLOW_SPAWN_MS: String(HOLD_MS) };
  app = onWindows
    ? await launchApp({ runDir: join(evidenceDir, "run-1"), log, home: "real", resetData: true, env })
    : await launchApp({ runDir: join(evidenceDir, "run-1"), log, home: "private", homeDir, env });
  const { bridge } = app;
  await completeOnboarding(bridge, log);

  log("step 1: while a terminal is being opened, the app keeps answering");
  const opening = Date.now();
  await bridge.eval(`
    window.__spawnFreeze = window.__TAURI_INTERNALS__
      .invoke("create_session", { label: "slow terminal" })
      .then((s) => ({ id: s.id }), (e) => ({ error: String(e) }));
    return true;
  `);
  await sleep(1_000);
  const times = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const n = await bridge
      .eval(`return (await window.__TAURI_INTERNALS__.invoke("get_sessions")).length;`, { timeoutMs: 6_000 })
      .catch((e) => `no answer: ${e.message}`);
    times.push({ ms: Date.now() - t0, sessions: n, at: Date.now() - opening });
    await sleep(600);
  }
  log(`  answers while opening: ${JSON.stringify(times)}`);
  assert(times.every((t) => typeof t.sessions === "number" && t.ms < ANSWER_MS), `the app answered each time within ${ANSWER_MS} ms (${times.map((t) => t.ms).join(", ")} ms)`);
  const stillOpening = await bridge.eval(`return await Promise.race([window.__spawnFreeze, new Promise((r) => setTimeout(() => r("opening"), 50))]);`);
  assert(stillOpening === "opening", "the terminal was still being opened while the app was asked");
  await bridge.screenshot(join(evidenceDir, "01-while-opening.png"));
  log("  ok — the window was still drawn (screenshot)");

  log("step 2: the terminal opens once the hold ends, and works");
  const created = await bridge.waitFor("the terminal to open", `
    const r = await Promise.race([window.__spawnFreeze, new Promise((res) => setTimeout(() => res(null), 50))]);
    return r;
  `, { timeoutMs: HOLD_MS + 20_000 });
  assert(created && created.id, `the terminal opened (${JSON.stringify(created)}) after ${Date.now() - opening} ms`);
  const listed = await bridge.eval(`return (await window.__TAURI_INTERNALS__.invoke("get_sessions")).some((s) => s.id === ${JSON.stringify(created.id)});`);
  assert(listed, "it is listed with the app's sessions");

  log("step 3: Quit works while another terminal is being opened");
  await bridge.eval(`window.__TAURI_INTERNALS__.invoke("create_session", { label: "slow terminal 2" }).catch(() => {}); return true;`);
  await sleep(1_000);
  const quitAt = Date.now();
  const exit = await app.stop();
  log(`  app exited: ${JSON.stringify(exit)} after ${Date.now() - quitAt} ms`);
  app = null;
  assert(!exit.forced && exit.code === 0, "the app quit by itself (not killed)");
} catch (err) {
  failed = true;
  log(`ERROR: ${err.stack || err.message || err}`);
  try {
    await app?.bridge.screenshot(join(evidenceDir, "failure.png"));
  } catch {
    /* none */
  }
} finally {
  if (app) {
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
  }
  if (homeDir) rmSync(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
