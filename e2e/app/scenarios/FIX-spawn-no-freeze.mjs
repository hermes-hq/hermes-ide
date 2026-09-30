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
//      Typing and a resize sent to it meanwhile are accepted, not refused
//      as "not found";
//   2. the terminal opens once the hold ends and is listed, and what was
//      typed meanwhile ran in it, at the size asked meanwhile (`stty size`
//      written to a file). Not on Windows: there the shell drops what was
//      typed before it started (seen on the CI runner, and the same on main,
//      where the keys waited for the PTY manager and were written at the
//      same moment), so only that the keys were accepted is checked;
//   2b. a terminal closed while it is being opened stays closed: opening it
//      fails, it is never listed, and typing into it is refused (before
//      this, the closed session came back to life once its spawn returned);
//   3. another terminal is being opened (held again): Quit still works, and
//      the app exits by itself.
//
// The same for the AI tools check (the onboarding's AI tools screen, the New
// Session wizard) and the shell list (Settings), which start a process per
// agent or shell (`where` on Windows) and took seconds on the Windows CI
// runner: on the main thread the window froze meanwhile (F02: "the webview
// did not answer"). The test build holds them (HERMES_E2E_SLOW_PROBE_MS):
//
//   0. while both are held, the app answers at once, three times over, and
//      both then return their answer (before step 1).
//
// Negative controls (must end in RESULT: FAIL): a build of main with only the
// test hook added (the PTY manager held across the spawn) — the app stops
// answering during step 1; this branch without the "closed while opening"
// check — step 2b finds the closed session listed again; and this branch with
// the AI tools check and the shell list synchronous again — step 0.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/FIX-spawn-no-freeze.mjs

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  const env = { HERMES_E2E_SLOW_SPAWN_MS: String(HOLD_MS), HERMES_E2E_SLOW_PROBE_MS: String(HOLD_MS) };
  app = onWindows
    ? await launchApp({ runDir: join(evidenceDir, "run-1"), log, home: "real", resetData: true, env })
    : await launchApp({ runDir: join(evidenceDir, "run-1"), log, home: "private", homeDir, env });
  const { bridge } = app;
  await completeOnboarding(bridge, log);

  log("step 0: while the AI tools check and the shell list run, the app keeps answering");
  const probing = Date.now();
  await bridge.eval(`
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__probeFreeze = Promise.all([
      invoke("check_ai_providers", { includeBeta: false }).then((r) => Object.keys(r).length, (e) => ({ error: String(e) })),
      invoke("get_available_shells").then((r) => r.length, (e) => ({ error: String(e) })),
    ]);
    return true;
  `);
  await sleep(1_000);
  const probeTimes = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const n = await bridge
      .eval(`return (await window.__TAURI_INTERNALS__.invoke("get_sessions")).length;`, { timeoutMs: 6_000 })
      .catch((e) => `no answer: ${e.message}`);
    probeTimes.push({ ms: Date.now() - t0, sessions: n, at: Date.now() - probing });
    await sleep(600);
  }
  log(`  answers while checking: ${JSON.stringify(probeTimes)}`);
  assert(probeTimes.every((t) => typeof t.sessions === "number" && t.ms < ANSWER_MS), `the app answered each time within ${ANSWER_MS} ms (${probeTimes.map((t) => t.ms).join(", ")} ms)`);
  const stillProbing = await bridge.eval(`return await Promise.race([window.__probeFreeze, new Promise((r) => setTimeout(() => r("checking"), 50))]);`);
  assert(stillProbing === "checking", "the AI tools check and the shell list were still running while the app was asked");
  const probed = await bridge.waitFor("the AI tools check and the shell list to answer", `
    return await Promise.race([window.__probeFreeze, new Promise((res) => setTimeout(() => res(null), 50))]);
  `, { timeoutMs: HOLD_MS + 20_000 });
  log(`  answered after ${Date.now() - probing} ms: ${JSON.stringify(probed)}`);
  assert(Array.isArray(probed) && probed[0] > 0 && probed[1] > 0, "both then answered (the agents looked for, the shells found)");

  log("step 1: while a terminal is being opened, the app keeps answering");
  const opening = Date.now();
  const FIRST = "spawnfreeze-first";
  await bridge.eval(`
    window.__spawnFreeze = window.__TAURI_INTERNALS__
      .invoke("create_session", { sessionId: ${JSON.stringify(FIRST)}, label: "slow terminal" })
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
  // Typing and a resize while it is being opened: kept for it, not refused.
  const marker = join(evidenceDir, "typed-while-opening.txt");
  rmSync(marker, { force: true });
  const line = onWindows ? `echo typed > "${marker}"\r` : `stty size > '${marker}'\r`;
  const sent = await bridge.eval(`
    const out = {};
    try { await window.__TAURI_INTERNALS__.invoke("resize_session", { sessionId: ${JSON.stringify(FIRST)}, rows: 33, cols: 111 }); out.resize = "ok"; } catch (e) { out.resize = String(e); }
    try { await window.__TAURI_INTERNALS__.invoke("write_to_session", { sessionId: ${JSON.stringify(FIRST)}, data: btoa(${JSON.stringify(line)}) }); out.write = "ok"; } catch (e) { out.write = String(e); }
    out.still = await Promise.race([window.__spawnFreeze, new Promise((r) => setTimeout(() => r("opening"), 50))]);
    return out;
  `);
  log(`  resize and typing while opening: ${JSON.stringify(sent)}`);
  assert(sent.resize === "ok" && sent.write === "ok", "a resize and typing sent while it is being opened are accepted");
  assert(sent.still === "opening", "(it was still being opened then)");
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
  let typed = null;
  for (let i = 0; i < (onWindows ? 25 : 100) && typed === null; i++) {
    if (existsSync(marker)) typed = readFileSync(marker, "utf8").replace(/\0/g, "").trim();
    if (!typed) {
      typed = null;
      await sleep(200);
    }
  }
  log(`  written by the line typed while opening: ${JSON.stringify(typed)}`);
  if (onWindows) {
    log(`  (Windows: not checked; the shell ${typed === null ? "dropped" : "ran"} the line typed before it started)`);
  } else {
    assert(typed !== null, "what was typed while it was being opened ran in it once it opened");
    assert(typed === "33 111", `at the size asked while it was being opened (stty size: ${typed})`);
  }

  log("step 2b: a terminal closed while it is being opened stays closed");
  const CLOSED = "spawnfreeze-closed";
  await bridge.eval(`
    window.__spawnClosed = window.__TAURI_INTERNALS__
      .invoke("create_session", { sessionId: ${JSON.stringify(CLOSED)}, label: "closed while opening" })
      .then((s) => ({ id: s.id }), (e) => ({ error: String(e) }));
    return true;
  `);
  await sleep(1_500);
  const closed = await bridge.eval(`
    try { await window.__TAURI_INTERNALS__.invoke("close_session", { sessionId: ${JSON.stringify(CLOSED)} }); return "closed"; } catch (e) { return String(e); }
  `, { timeoutMs: 6_000 });
  log(`  close_session during the opening: ${closed}`);
  assert(closed === "closed", "closing it while it is being opened answers at once");
  const outcome = await bridge.waitFor("the opening to end", `
    return await Promise.race([window.__spawnClosed, new Promise((res) => setTimeout(() => res(null), 50))]);
  `, { timeoutMs: HOLD_MS + 20_000 });
  log(`  create_session returned: ${JSON.stringify(outcome)}`);
  assert(outcome && !outcome.id && /closed while it was being opened/.test(outcome.error ?? ""), "opening it fails, saying it was closed meanwhile");
  const listedClosed = async () => bridge.eval(`return (await window.__TAURI_INTERNALS__.invoke("get_sessions")).filter((s) => s.id === ${JSON.stringify(CLOSED)}).map((s) => ({ id: s.id, phase: s.phase }));`);
  const nowListed = await listedClosed();
  await sleep(1_500);
  const laterListed = await listedClosed();
  log(`  get_sessions after the close: ${JSON.stringify(nowListed)}, 1.5 s later: ${JSON.stringify(laterListed)}`);
  assert(nowListed.length === 0 && laterListed.length === 0, "the closed session is not listed (it did not come back)");
  const typedClosed = await bridge.eval(`
    try { await window.__TAURI_INTERNALS__.invoke("write_to_session", { sessionId: ${JSON.stringify(CLOSED)}, data: btoa("echo hi\\r") }); return "accepted"; } catch (e) { return String(e); }
  `);
  log(`  typing into it: ${typedClosed}`);
  assert(/not found/.test(typedClosed), "typing into it is refused: it has no terminal");

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
