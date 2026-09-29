#!/usr/bin/env node
// Scenario N20: sessions survive quit, update and crash.
//
// A fake agent that never stops talking (e2e/app/fixtures/streamer.mjs)
// runs in a plain terminal. It prints a numbered line every 250 ms and keeps
// its pid in a file, so the test can tell from outside whether it is alive
// and from the screen whether the app replayed what it missed.
//
//   run 0  fresh install, flag switched OFF (on by default since 2.0 on macOS
//          and Linux; the negative control): the streamer runs
//          in a terminal owned by the app, so killing the app (no exit
//          handler runs, like a crash) ends it; the relaunch shows a grey
//          snapshot and no new lines. Turn the `sessionHost` flag on in the
//          hidden Settings > Flags section and quit.
//   run 1  flag ON: the terminal lives in the session host, which runs from
//          a versioned copy under the app's data folder, never from the
//          install folder. Kill the app while the streamer streams.
//   run 2  relaunch: the streamer is still alive (same pid), the restored
//          terminal shows the early lines again (replay) and the numbers
//          keep climbing (live). Quit: "keep running or stop" asks; keep.
//   run 3  the "update": the same app pretends to be version 9.9.9. It
//          reattaches to the same host (same pid) and the same streamer.
//          Quit: the question again; stop. The streamer ends and the host,
//          having nothing left, exits on its own and takes its socket
//          folder with it.
//   run 4  the host cannot be used (the socket root is a file): the flag
//          falls back to a terminal owned by the app and says so in a
//          notice, so nobody trusts a terminal that will not survive.
//
// Run 2 quits through the window's close button and run 3 through the
// app's exit request (menu, Cmd+Q, the bridge): both front doors reach the
// same question.
//
// On Windows the host does not exist yet: with the flag on, the terminal
// stays in-process and the scenario proves only that fallback (a session
// still works, the status says unsupported), then ends.
//
// Negative control (must end in RESULT: FAIL): HERMES_E2E_N20_NEGATIVE=1
// leaves the flag off for the "survive" runs, and the assertions that the
// streamer outlives the app fail.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N20-session-host.mjs
//
// Evidence (log, screenshots, the host's log) goes to HERMES_E2E_EVIDENCE,
// or <out dir>/evidence/N20-session-host.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { REPO_ROOT, appBinaryPath, createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";
import { classifyProbe, commandLine, probeCommand, PROBE_OUTPUT } from "../shells.mjs";

const SCENARIO = "N20-session-host";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
mkdirSync(evidenceDir, { recursive: true });
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);
const onWindows = platform() === "win32";
const NEGATIVE = process.env.HERMES_E2E_N20_NEGATIVE === "1";
const STREAMER = join(REPO_ROOT, "e2e", "app", "fixtures", "streamer.mjs");
const FLAG_ID = "sessionHost";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

// ─── A home that survives relaunches, a folder for the streamer's state ──

const work = mkdtempSync(join(tmpdir(), "hermes-e2e-n20-"));
const privateHome = join(work, "home");
const stateDir = join(work, "state");
mkdirSync(privateHome, { recursive: true });
mkdirSync(stateDir, { recursive: true });

function launch(run, { first = false, env = {} } = {}) {
  const runDir = join(evidenceDir, `run-${run}`);
  const common = { runDir, log, env };
  return onWindows
    ? launchApp({ ...common, home: "real", resetData: first })
    : launchApp({ ...common, home: "private", homeDir: privateHome });
}

// ─── UI steps ────────────────────────────────────────────────────────

async function completeOnboarding(bridge) {
  await bridge.waitFor("the welcome dialog", `return !!e2e.first(".onboarding-dialog");`);
  for (let i = 0; i < 3; i++) {
    await bridge.click(".onboarding-actions .onboarding-btn-primary");
    await sleep(150);
  }
  await bridge.waitFor("the privacy screen", `return e2e.all(".onboarding-privacy-checkbox input").length === 2;`);
  await bridge.clickWhenReady(`
    const [analytics, policy] = e2e.all(".onboarding-privacy-checkbox input");
    if (analytics.checked) e2e.click(analytics);
    if (!policy.checked) e2e.click(policy);
    return true;
  `);
  await bridge.waitFor("the Finish button to become enabled", `
    const b = e2e.first(".onboarding-actions .onboarding-btn-primary");
    return !!b && !b.disabled;
  `);
  await bridge.click(".onboarding-actions .onboarding-btn-primary");
  await bridge.waitFor("the welcome dialog to close", `return !e2e.first(".onboarding-backdrop");`);
  await sleep(300);
  await dismissWhatsNew(bridge);
}

async function dismissWhatsNew(bridge) {
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
}

async function waitForReturningLaunch(bridge) {
  await bridge.waitFor("the app UI to be ready (no onboarding this time)", `
    return !!e2e.first(".topbar-title, .topbar") && !e2e.first(".onboarding-backdrop");
  `);
  await dismissWhatsNew(bridge);
}

/** Settings > (7 clicks on the title) > Flags: set the sessionHost override. */
async function setFlagOverride(bridge, value) {
  await bridge.clickByName("Settings");
  await bridge.waitFor("the Settings dialog", `return !!e2e.first('[role="dialog"] .settings-title');`);
  await bridge.eval(`
    const title = e2e.must(e2e.first(".settings-title"), "settings title");
    for (let i = 0; i < 7; i++) e2e.click(title);
    return true;
  `);
  await bridge.waitFor("the hidden Flags tab", `return e2e.all(".settings-tab").some((el) => e2e.norm(el.innerText) === "Flags");`);
  await bridge.eval(`
    const tab = e2e.all(".settings-tab").find((el) => e2e.norm(el.innerText) === "Flags");
    return e2e.click(e2e.must(tab, "Flags tab"));
  `);
  const selector = `select.settings-select[data-flag-id="${FLAG_ID}"]`;
  await bridge.waitFor("the sessionHost flag control", `return !!e2e.first(${JSON.stringify(selector)});`);
  const result = await bridge.eval(`
    const sel = e2e.must(e2e.first(${JSON.stringify(selector)}), "sessionHost select");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
    setter.call(sel, ${JSON.stringify(value)});
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return sel.value;
  `);
  assert(result === value, `flag "${FLAG_ID}" set to "${value}"`);
  await bridge.waitFor("the override to be saved", `
    const raw = await window.__TAURI_INTERNALS__.invoke("get_settings");
    const overrides = raw.feature_flag_overrides ? JSON.parse(raw.feature_flag_overrides) : {};
    return overrides.${FLAG_ID} === ${value === "on" ? "true" : "false"};
  `);
  await bridge.click(".settings-close");
  await bridge.waitFor("the Settings dialog to close", `return !e2e.first(".settings-title");`);
}

/** New Session wizard: a plain terminal (the last agent card). */
async function createPlainTerminal(bridge) {
  const before = await bridge.terminalIds();
  if (await bridge.exists("button.es-tile-primary")) await bridge.click("button.es-tile-primary");
  else await bridge.clickByName("New session");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`, { timeoutMs: 20_000 });
  await bridge.clickWhenReady(`
    const cards = e2e.all(".session-creator-provider-card");
    return e2e.click(e2e.must(cards[cards.length - 1], "plain shell card"));
  `);
  for (let i = 0; i < 8; i++) {
    if (!(await bridge.exists(".session-creator"))) break;
    await bridge.clickWhenReady(`
      if (!e2e.first(".session-creator")) return null;
      return e2e.click(e2e.must(
        e2e.first(".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary"),
        "the wizard's primary button",
      ));
    `);
    await sleep(400);
  }
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  return bridge.waitFor(
    "a terminal to appear",
    `const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
     return ids.length === 1 ? ids[0] : null;`,
    { timeoutMs: 20_000 },
  );
}

async function detectShell(bridge, sessionId) {
  await bridge.typeInTerminal(sessionId, `${probeCommand()}\n`);
  const { line } = await bridge.waitForTerminal(sessionId, PROBE_OUTPUT, { timeoutMs: 30_000 });
  return classifyProbe(line);
}

const hostStatus = (bridge) => bridge.eval(`return await window.__TAURI_INTERNALS__.invoke("session_host_status");`);
const sessionData = async (bridge, id) => {
  const all = await bridge.eval(`return await window.__TAURI_INTERNALS__.invoke("get_sessions");`);
  return all.find((s) => s.id === id) ?? null;
};

/** The highest "tick N" on the terminal's screen. */
async function lastTickOnScreen(bridge, sessionId) {
  const lines = (await bridge.readTerminal(sessionId)) ?? [];
  let max = 0;
  for (const l of lines) {
    const m = /^tick (\d+)\s*$/.exec(l.trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}
async function waitForTick(bridge, sessionId, atLeast, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    last = await lastTickOnScreen(bridge, sessionId);
    if (last >= atLeast) return last;
    await sleep(200);
  }
  throw new Error(`the terminal never showed tick ${atLeast} (last ${last})`);
}
const screenHasTick = async (bridge, sessionId, n) => ((await bridge.readTerminal(sessionId)) ?? []).some((l) => l.trim() === `tick ${n}`);

const readState = (file) => JSON.parse(readFileSync(file, "utf8"));
async function waitForState(file, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const s = readState(file);
      if (s.pid && s.tick >= 3) return s;
    } catch {
      /* not written yet */
    }
    if (Date.now() > deadline) throw new Error(`the streamer never wrote ${file}`);
    await sleep(200);
  }
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
async function waitForPid(pid, alive, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid) !== alive && Date.now() < deadline) await sleep(100);
  return pidAlive(pid) === alive;
}
// How a program in an app-owned terminal ends when the app is SIGKILLed:
// normally it is gone within a second ("exited"). On macOS the orphaned
// shell can wedge in the kernel while it closes a terminal whose reader
// died with output still queued, and the program hangs with it: alive as
// a pid, blocked in a write or an open, never working again ("cut off").
// Both mean the app took the program down; a hosted program keeps ticking.
async function waitForEnd(pid, stateFile, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = { tick: -1, at: Date.now() };
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return "exited";
    let tick = last.tick;
    try {
      tick = readState(stateFile).tick;
    } catch {
      /* the state file is written by the program; it may be mid-write */
    }
    if (tick !== last.tick) last = { tick, at: Date.now() };
    else if (Date.now() - last.at >= 2_000) return "cut off";
    await sleep(100);
  }
  return null;
}

async function waitForSavedWorkspace(bridge, sessionId) {
  // The frontend saves the workspace every 10 s once something changed.
  await bridge.waitFor("the session to be in the saved workspace", `
    const raw = await window.__TAURI_INTERNALS__.invoke("get_settings");
    if (!raw.saved_workspace) return null;
    const ws = JSON.parse(raw.saved_workspace);
    return ws.sessions.some((x) => x.id === ${JSON.stringify(sessionId)}) ? true : null;
  `, { timeoutMs: 25_000 });
}

/** No exit handler runs: like a crash or a force quit. */
async function killApp(current) {
  current.child.kill("SIGKILL");
  const until = Date.now() + 10_000;
  while (current.isRunning() && Date.now() < until) await sleep(100);
  assert(!current.isRunning(), "the app was killed");
  current.cleanup();
}

async function waitForExit(current, { timeoutMs = 15_000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (current.isRunning() && Date.now() < until) await sleep(100);
  const running = current.isRunning();
  if (running) current.child.kill("SIGKILL");
  current.cleanup();
  return !running;
}

/**
 * Quit and answer the keep-or-stop question. `via` is the front door: the
 * window's close button ("window-close", asked by the frontend before the
 * window goes) or the app's exit request ("app-quit": menu, Cmd+Q, the
 * bridge; held by the backend until the dialog answers).
 */
async function quitAndAnswer(current, answer, via = "app-quit") {
  if (via === "window-close") {
    await current.bridge.eval(`
      const label = window.__TAURI_INTERNALS__.metadata.currentWindow.label;
      await window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label });
      return true;
    `);
  } else {
    await current.bridge.quit();
  }
  await current.bridge.waitFor("the keep-or-stop question", `return !!e2e.first('[data-testid="quit-with-agents-dialog"]');`, { timeoutMs: 15_000 });
  const names = await current.bridge.eval(`
    return e2e.all('[data-testid="quit-with-agents-dialog"] .quit-dialog-session').map((el) => e2e.norm(el.innerText));
  `);
  log(`  the question names: ${JSON.stringify(names)}`);
  await current.bridge.screenshot(join(evidenceDir, `quit-asks-${answer.replace(/\s+/g, "-")}.png`));
  await current.bridge.clickByName(answer, { within: '[data-testid="quit-with-agents-dialog"]' });
  return names;
}

function saveHostLog(dataDir, name) {
  const file = join(dataDir, "host", "host.log");
  if (existsSync(file)) copyFileSync(file, join(evidenceDir, name));
}

const installDir = resolve(dirname(appBinaryPath()));
let app;
let failed = false;
let dataDir = null;
let streamerPid = null;
let hostPid = null;
let legacyPid = null;
/** Windows: the flag fell back to an in-process terminal; that is all that was proven. */
let fallbackOnly = false;

async function run() {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   negative control: ${NEGATIVE}`);

  // ── run 0: flag OFF — the terminal dies with the app (negative control) ──
  log("run 0: fresh install, flag switched OFF: killing the app ends the program in its terminal");
  app = await launch(0, { first: true });
  dataDir = app.dataDir;
  await completeOnboarding(app.bridge);
  // On by default since 2.0 (macOS and Linux): switch it off (the kill
  // switch) and relaunch.
  await setFlagOverride(app.bridge, "off");
  const exitOff = await app.stop();
  assert(!exitOff.forced && exitOff.code === 0, "the app quit cleanly");
  app = await launch(0.25);
  await waitForReturningLaunch(app.bridge);
  const legacyId = await createPlainTerminal(app.bridge);
  const shell = await detectShell(app.bridge, legacyId);
  log(`  shell: ${shell}`);
  const legacyState = join(stateDir, "legacy.json");
  await app.bridge.typeInTerminal(legacyId, `${commandLine(shell, process.execPath, [STREAMER, legacyState])}\n`);
  const legacy = await waitForState(legacyState);
  await waitForTick(app.bridge, legacyId, 3);
  const legacyData = await sessionData(app.bridge, legacyId);
  assert(legacyData && !legacyData.hosted, "with the flag off the terminal is owned by the app (not hosted)");
  const off = await hostStatus(app.bridge);
  assert(!off.running && off.hosted_session_ids.length === 0, "with the flag off no session host runs");
  await waitForSavedWorkspace(app.bridge, legacyId);
  await app.bridge.screenshot(join(evidenceDir, "run0-streaming-flag-off.png"));
  await killApp(app);
  const legacyEnd = await waitForEnd(legacy.pid, legacyState);
  assert(
    legacyEnd !== null,
    `flag off: the program (pid ${legacy.pid}) ${legacyEnd ?? "kept working after the app was killed; it should have ended"} with the app`,
  );
  legacyPid = legacy.pid;

  app = await launch(0.5);
  await waitForReturningLaunch(app.bridge);
  const restoredLegacy = await app.bridge.waitFor("the restored terminal", `
    const ids = window.__HERMES_E2E__.terminalIds();
    return ids.includes(${JSON.stringify(legacyId)}) ? ${JSON.stringify(legacyId)} : null;
  `, { timeoutMs: 30_000 });
  await sleep(1500);
  const legacyAfter = await lastTickOnScreen(app.bridge, restoredLegacy);
  const legacyLines = (await app.bridge.readTerminal(restoredLegacy)) ?? [];
  if (process.platform === "win32") {
    // ConPTY repaints the whole screen when the new shell starts, which
    // erases the restored snapshot on Windows; that is the app's existing
    // restore, not the session host, so it is only logged here.
    log(`  flag off: the relaunch ${legacyLines.some((l) => l.includes("session restored")) ? "shows" : "does not keep (ConPTY repaint)"} the grey snapshot`);
  } else {
    assert(legacyLines.some((l) => l.includes("session restored")), "flag off: the relaunch shows a grey snapshot of the old output");
  }
  await sleep(1000);
  assert((await lastTickOnScreen(app.bridge, restoredLegacy)) === legacyAfter, "flag off: no new lines arrive after the relaunch (the program is gone)");
  await app.bridge.screenshot(join(evidenceDir, "run0-restored-flag-off.png"));
  const legacyRestored = await sessionData(app.bridge, restoredLegacy);
  assert(legacyRestored && !legacyRestored.hosted, "flag off: the restore started a new in-process shell");
  await app.bridge.eval(`return await window.__TAURI_INTERNALS__.invoke("close_session", { sessionId: ${JSON.stringify(restoredLegacy)} });`);
  if (!NEGATIVE) await setFlagOverride(app.bridge, "on");
  else log("  negative control: keeping the flag switched OFF");
  const exit0 = await app.stop();
  assert(!exit0.forced && exit0.code === 0, "the app quit cleanly");

  // ── run 1: flag ON — the terminal lives in the host ─────────────────
  log("run 1: flag ON: the terminal lives in the session host; kill the app while it streams");
  app = await launch(1);
  dataDir = app.dataDir;
  await waitForReturningLaunch(app.bridge);
  const sessionId = await createPlainTerminal(app.bridge);
  const status1 = await hostStatus(app.bridge);
  log(`  host status: ${JSON.stringify({ ...status1, sessions: status1.sessions.length })}`);
  await app.bridge.screenshot(join(evidenceDir, "run1-hosted-terminal.png"));

  if (!status1.supported) {
    // Windows: no host yet. The flag must not break anything.
    assert(onWindows, "only Windows is without a session host");
    const s = await sessionData(app.bridge, sessionId);
    assert(s && !s.hosted && !status1.running, "unsupported platform: the terminal stays in-process and no host is started");
    const winState = join(stateDir, "win.json");
    await app.bridge.typeInTerminal(sessionId, `${commandLine(shell, process.execPath, [STREAMER, winState])}\n`);
    await waitForState(winState);
    await waitForTick(app.bridge, sessionId, 3);
    assert(true, "unsupported platform: a terminal with the flag on still works");
    await app.bridge.typeInTerminal(sessionId, "q");
    const exitWin = await app.stop();
    assert(!exitWin.forced && exitWin.code === 0, "the app quit cleanly");
    log("host unsupported on this platform; the in-process fallback is what was proven");
    fallbackOnly = true;
    return;
  }

  const data1 = await sessionData(app.bridge, sessionId);
  assert(data1 && data1.hosted === true, "with the flag on the session reports itself as hosted");
  assert(status1.running && status1.hosted_session_ids.includes(sessionId), "the session host runs and lists the session");
  hostPid = status1.pid;
  assert(status1.exe && status1.exe.startsWith(status1.bin_dir), `the host runs from a versioned copy under app data (${status1.exe})`);
  assert(!status1.exe.startsWith(installDir), `...and not from the install folder (${installDir})`);
  assert(status1.exe.includes(`/${status1.app_version}-`), `the copy is keyed by the app version ${status1.app_version}`);
  assert(existsSync(status1.socket), "the host socket exists");
  assert(!status1.socket.startsWith(dataDir), "the socket lives in a short user-only folder, not under app data");

  const stateFile = join(stateDir, "hosted.json");
  await app.bridge.typeInTerminal(sessionId, `${commandLine(shell, process.execPath, [STREAMER, stateFile])}\n`);
  const st1 = await waitForState(stateFile);
  streamerPid = st1.pid;
  const tickBeforeKill = await waitForTick(app.bridge, sessionId, 4);
  log(`  streamer pid ${streamerPid}, tick ${tickBeforeKill} on screen`);
  await waitForSavedWorkspace(app.bridge, sessionId);
  const working = await hostStatus(app.bridge);
  assert(working.working_session_ids.includes(sessionId), "a streaming terminal counts as working");
  await app.bridge.screenshot(join(evidenceDir, "run1-streaming-before-kill.png"));
  await killApp(app);
  await sleep(2000);
  assert(pidAlive(streamerPid), `the streamer (pid ${streamerPid}) is still alive 2 s after the app was killed`);
  const stAfterKill = readState(stateFile);
  await sleep(1000);
  assert(readState(stateFile).tick > stAfterKill.tick, "...and it keeps working while no app is open");

  // ── run 2: relaunch — reattach, replay, continue ────────────────────
  log("run 2: relaunch: the restored terminal reattaches, replays and continues");
  app = await launch(2);
  await waitForReturningLaunch(app.bridge);
  const restored = await app.bridge.waitFor("the restored terminal", `
    const ids = window.__HERMES_E2E__.terminalIds();
    return ids.includes(${JSON.stringify(sessionId)}) ? ${JSON.stringify(sessionId)} : null;
  `, { timeoutMs: 30_000 });
  const data2 = await app.bridge.waitFor("the session to be reattached", `
    const all = await window.__TAURI_INTERNALS__.invoke("get_sessions");
    const s = all.find((x) => x.id === ${JSON.stringify(sessionId)});
    return s && s.hosted ? s : null;
  `, { timeoutMs: 30_000 });
  assert(data2.hosted === true, "the restored session is hosted");
  const status2 = await hostStatus(app.bridge);
  assert(status2.pid === hostPid, `the same host is still running (pid ${hostPid})`);
  const sessionInHost = status2.sessions.find((s) => s.id === sessionId);
  assert(sessionInHost && sessionInHost.alive && sessionInHost.attached, "the host reports the session alive and attached");
  const tickAfterRelaunch = await waitForTick(app.bridge, restored, tickBeforeKill + 8);
  assert(tickAfterRelaunch > tickBeforeKill, `the output continued: tick ${tickAfterRelaunch} > ${tickBeforeKill} seen before the kill`);
  assert(await screenHasTick(app.bridge, restored, 1), "the replay shows the early output again (tick 1)");
  assert(await screenHasTick(app.bridge, restored, tickBeforeKill), `...through what was on screen before the kill (tick ${tickBeforeKill})`);
  const lines2 = (await app.bridge.readTerminal(restored)) ?? [];
  assert(!lines2.some((l) => l.includes("session restored")), "no grey snapshot is written over a replayed terminal");
  assert(readState(stateFile).pid === streamerPid && pidAlive(streamerPid), "the same streamer process is still running");
  // The UI must not stay at the create result's "initializing": the
  // replayed, still-streaming program is busy.
  await app.bridge.waitFor("the restored session to show as busy", `
    return window.__HERMES_E2E__.terminalInfo(${JSON.stringify(restored)})?.phase === "busy" ? true : null;
  `, { timeoutMs: 10_000 });
  assert(true, "the restored session shows as busy, not initializing");
  await app.bridge.screenshot(join(evidenceDir, "run2-reattached.png"));

  // Close the window with a working agent: the app asks; keep it running.
  const asked = await quitAndAnswer(app, "Keep running", "window-close");
  assert(asked.length >= 1, "closing the window with a working agent asks keep running or stop");
  assert(await waitForExit(app), "the app quit after \"Keep running\"");
  await sleep(1000);
  assert(pidAlive(streamerPid), "after \"Keep running\" the streamer is still alive");
  assert(pidAlive(hostPid), "...and so is the host");

  // ── run 3: the update — a newer app version reattaches ──────────────
  log("run 3: the app comes back as version 9.9.9 (an update) and reattaches to the same host");
  app = await launch(3, { env: { HERMES_E2E_APP_VERSION: "9.9.9" } });
  await waitForReturningLaunch(app.bridge);
  const restored3 = await app.bridge.waitFor("the restored terminal", `
    const ids = window.__HERMES_E2E__.terminalIds();
    return ids.includes(${JSON.stringify(sessionId)}) ? ${JSON.stringify(sessionId)} : null;
  `, { timeoutMs: 30_000 });
  const status3 = await hostStatus(app.bridge);
  assert(status3.app_version === "9.9.9", "the app reports the new version");
  assert(status3.pid === hostPid, "the updated app talks to the host the old version started");
  assert(status3.hosted_session_ids.includes(sessionId), "...and has the session back");
  const before3 = readState(stateFile).tick;
  await waitForTick(app.bridge, restored3, before3 + 4);
  assert(readState(stateFile).pid === streamerPid && pidAlive(streamerPid), "the streamer survived the update");
  await app.bridge.screenshot(join(evidenceDir, "run3-after-update.png"));

  // Quit again (the app's exit request this time): stop. The streamer
  // ends; the host exits on its own.
  const asked3 = await quitAndAnswer(app, "Stop and quit", "app-quit");
  assert(asked3.length >= 1, "an app quit with a working agent asks too");
  assert(await waitForExit(app), "the app quit after \"Stop and quit\"");
  assert(await waitForPid(streamerPid, false), "after \"Stop and quit\" the streamer is gone");
  assert(await waitForPid(hostPid, false, { timeoutMs: 20_000 }), "the host exits once it has no sessions");
  assert(!existsSync(status3.socket), "...and removes its socket");
  assert(!existsSync(dirname(status3.socket)), "...and its now-empty socket folder");
  saveHostLog(dataDir, "host.log");

  // ── run 4: the host cannot be used — the fallback says so ───────────
  log("run 4: the socket root is unusable: the flag falls back in-process and says so");
  const badRoot = join(work, "not-a-folder");
  writeFileSync(badRoot, "a file where the socket root should be\n");
  app = await launch(4, { env: { HERMES_HOST_SOCKET_ROOT: badRoot } });
  await waitForReturningLaunch(app.bridge);
  // Run 3's session is saved (the programs stop after the save) and comes
  // back first: let it, so the new terminal is told apart from it.
  await app.bridge.waitFor("run 3's session to be restored", `return window.__HERMES_E2E__.terminalIds().includes(${JSON.stringify(sessionId)});`, { timeoutMs: 30_000 });
  const fallbackId = await createPlainTerminal(app.bridge);
  const notice = await app.bridge.waitFor("the fallback notice", `
    return e2e.all(".toast-message").map((el) => e2e.norm(el.innerText)).find((s) => s.includes("will not survive")) ?? null;
  `, { timeoutMs: 20_000 });
  log(`  notice: ${notice}`);
  const fallbackData = await sessionData(app.bridge, fallbackId);
  assert(fallbackData && !fallbackData.hosted, "with no usable host the terminal is owned by the app");
  const status4 = await hostStatus(app.bridge);
  assert(!status4.running && status4.hosted_session_ids.length === 0, "no host was started");
  await app.bridge.typeInTerminal(fallbackId, "echo fallback-works\n");
  await app.bridge.waitForTerminal(fallbackId, /^fallback-works\s*$/, { timeoutMs: 30_000 });
  assert(true, "the fallback terminal works");
  await app.bridge.screenshot(join(evidenceDir, "run4-fallback-notice.png"));
  const exit4 = await app.stop();
  assert(!exit4.forced && exit4.code === 0, "the app quit cleanly (nothing hosted, no question)");
}

try {
  await run();
} catch (err) {
  failed = true;
  log(`RESULT: FAIL — ${err?.stack || err}`);
} finally {
  try {
    if (app && app.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "at-failure.png")).catch(() => {});
      await app.stop();
    }
  } catch {
    /* already gone */
  }
  if (dataDir) saveHostLog(dataDir, "host.log");
  // Never leave a streamer or a host behind.
  for (const pid of [streamerPid, hostPid, legacyPid]) {
    if (pid && pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  finishScenario({
    scenario: SCENARIO,
    evidenceDir,
    failed,
    startedAt,
    log,
    details: { platform: platform(), negative: NEGATIVE, hostSupported: !fallbackOnly },
  });
}
