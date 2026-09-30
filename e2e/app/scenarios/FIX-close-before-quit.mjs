#!/usr/bin/env node
// Scenario: a session closed just before quitting stays closed after a
// relaunch, on the REAL app, with plain shell sessions (no agent account).
//
//   run 1  fresh install: welcome screens; create "Keep me" and "Close me";
//          wait until the saved workspace holds both (the state an older
//          build would restore); close "Close me" through its close button
//          and quit less than 1 s later
//   run 2  only "Keep me" comes back. Then create "Close me too", wait until
//          it is saved, close it, and (without quitting) the saved workspace
//          drops it within 2 s. Quit right away.
//   run 3  still only "Keep me". Create "Crash me", wait until it is saved,
//          close it and kill the app less than 1 s later (no exit handler
//          runs, like a crash or a force quit).
//   run 4  still only "Keep me".
//
// Negative control: run it against a build without the fix (the frontend
// saved the workspace every 10 s and quitting did not rewrite it), or with
// only the frontend's save-after-close and not the backend's pruning. Run 2
// then shows "Close me" again and the scenario ends in RESULT: FAIL.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/FIX-close-before-quit.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/FIX-close-before-quit.

import { mkdtempSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { E2E_FLAG_DEFAULTS, createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

// This scenario is about the app's own workspace save racing a quit. The
// session host (on by default on macOS and Linux) asks before quitting
// while a terminal is busy, which a shell drawing its prompt can be at the
// moment of a quick quit; N20 covers the host, so it stays off here.
const FLAG_DEFAULTS = { ...E2E_FLAG_DEFAULTS, sessionHost: false };

const SCENARIO = "FIX-close-before-quit";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

/** How soon after the close the app is told to quit. */
const QUIT_WITHIN_MS = 1_000;

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

// Windows keeps app data under %APPDATA%, which a private HOME does not move.
const onWindows = platform() === "win32";
const homeDir = onWindows ? undefined : mkdtempSync(join(tmpdir(), "hermes-e2e-close-home-"));
function launch(run, { first = false } = {}) {
  const runDir = join(evidenceDir, `run-${run}`);
  return onWindows
    ? launchApp({ runDir, log, home: "real", resetData: first, flagDefaults: FLAG_DEFAULTS })
    : launchApp({ runDir, log, home: "private", homeDir, flagDefaults: FLAG_DEFAULTS });
}

async function dismissWhatsNew(bridge) {
  await sleep(300);
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
}

async function completeOnboarding(bridge) {
  await bridge.waitFor("the welcome dialog", `return !!e2e.first(".onboarding-dialog");`);
  for (const _screen of ["welcome", "theme", "AI tools"]) {
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
  await bridge.waitFor("the Finish button", `const b = e2e.first(".onboarding-actions .onboarding-btn-primary"); return !!b && !b.disabled;`);
  await bridge.click(".onboarding-actions .onboarding-btn-primary");
  await bridge.waitFor("the welcome dialog to close", `return !e2e.first(".onboarding-backdrop");`);
  await dismissWhatsNew(bridge);
}

async function waitForReturningLaunch(bridge) {
  await bridge.waitFor("the app UI (returning launch)", `return !!e2e.first(".topbar") && !e2e.first(".onboarding-backdrop");`);
  await dismissWhatsNew(bridge);
}

async function quit(current) {
  const exit = await current.stop({ keepFiles: false });
  log(`  app exited: ${JSON.stringify(exit)}`);
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");
}

/** Set a controlled input's value the way typing does (React sees `input`). */
const setInput = (selector, value) => `
  const el = e2e.must(e2e.first(${JSON.stringify(selector)}), ${JSON.stringify(selector)});
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  el.focus();
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return el.value;
`;

/** The session list is a sidebar tab; open it when it is not showing. */
async function showSessionList(bridge) {
  if (await bridge.exists(".session-list")) return;
  await bridge.eval(`
    const tab = e2e.all(".activity-bar-tab").find((el) => e2e.norm(el.innerText + " " + (el.getAttribute("aria-label") || "") + " " + (el.title || "")).toLowerCase().includes("session"))
      || e2e.all(".activity-bar-tab")[0];
    if (tab) e2e.click(tab);
    return true;
  `);
  await bridge.waitFor("the session list", `return !!e2e.first(".session-list");`, { timeoutMs: 5_000 });
}

async function sessionLabels(bridge) {
  await showSessionList(bridge);
  return bridge.eval(`return e2e.all(".session-item").map((el) => e2e.norm(el.innerText));`);
}

const has = (labels, label) => labels.some((t) => t.includes(label));

/** The primary button of whatever wizard step is showing. */
const PRIMARY = ".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary";
const NAME_INPUT = 'input.session-creator-name[placeholder="Session name (optional)"]';

/** Create a plain shell session named `label` through the New Session wizard; returns its id. */
async function createPlainSession(bridge, label) {
  const before = await bridge.terminalIds();
  await bridge.eval(`return e2e.click(e2e.must(e2e.first("button.es-tile-primary") || e2e.first(".activity-bar-action"), "new session button"));`);
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`);
  await bridge.clickWhenReady(`
    const cards = e2e.all(".session-creator-provider-card");
    return e2e.click(e2e.must(cards[cards.length - 1], "plain shell card"));
  `);
  // The remaining steps (folder, confirm) only need their primary button;
  // name the session on the confirm step.
  for (let i = 0; i < 8; i++) {
    if (!(await bridge.exists(".session-creator"))) break;
    if (await bridge.exists(NAME_INPUT)) await bridge.eval(setInput(NAME_INPUT, label));
    await bridge
      .clickWhenReady(`
        if (!e2e.first(".session-creator")) return null;
        return e2e.click(e2e.must(e2e.first(${JSON.stringify(PRIMARY)}), "the wizard's primary button"));
      `)
      .catch(() => null);
    await sleep(400);
  }
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  const id = await bridge.waitFor(`the terminal of "${label}"`, `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
    return ids.length === 1 ? ids[0] : null;
  `, { timeoutMs: 20_000 });
  await showSessionList(bridge);
  await bridge.waitFor(`"${label}" in the session list`, `
    return e2e.all(".session-item").some((el) => el.innerText.includes(${JSON.stringify(label)}));
  `);
  log(`  created "${label}" (${id})`);
  return id;
}

/** Close a session through its close button (and the confirm dialog, if shown). */
async function closeSession(bridge, label) {
  await showSessionList(bridge);
  await bridge.clickWhenReady(`
    const item = e2e.all(".session-item").find((el) => el.innerText.includes(${JSON.stringify(label)}));
    return e2e.click(e2e.must(item && item.querySelector(".session-item-close"), "close button of ${label}"));
  `);
  await bridge.waitFor(`"${label}" to close (or its confirm dialog)`, `
    return !!e2e.first(".close-dialog") || !e2e.all(".session-item").some((el) => el.innerText.includes(${JSON.stringify(label)}));
  `, { timeoutMs: 10_000 });
  const confirmShown = await bridge.exists(".close-dialog");
  log(`  close confirm dialog shown: ${confirmShown ? "yes, confirmed" : "no"}`);
  if (confirmShown) await bridge.click(".close-dialog .close-dialog-btn-confirm");
  await bridge.waitFor(`"${label}" to leave the session list`, `
    return !e2e.all(".session-item").some((el) => el.innerText.includes(${JSON.stringify(label)}));
  `, { timeoutMs: 20_000, intervalMs: 50 });
}

/** The session ids in the saved workspace, or null when nothing is saved. */
async function savedIds(bridge) {
  return bridge.eval(`
    const s = await window.__TAURI_INTERNALS__.invoke("get_settings");
    if (!s.saved_workspace) return null;
    const ws = JSON.parse(s.saved_workspace);
    return (ws.sessions || []).map((x) => x.id);
  `);
}

async function waitSavedWith(bridge, ids, what) {
  await bridge.waitFor(what, `
    const s = await window.__TAURI_INTERNALS__.invoke("get_settings");
    return !!s.saved_workspace && ${JSON.stringify(ids)}.every((id) => s.saved_workspace.includes(id));
  `, { timeoutMs: 40_000, intervalMs: 250 });
}

/** After a relaunch: the session list shows "Keep me" and nothing else. */
async function expectOnlyKept(bridge, screenshot) {
  await waitForReturningLaunch(bridge);
  await showSessionList(bridge).catch(() => {});
  await bridge.waitFor('"Keep me" to be restored', `
    return e2e.all(".session-item").some((el) => el.innerText.includes("Keep me"));
  `, { timeoutMs: 30_000 }).catch(() => {});
  // Give a late restore time to show up before judging the list.
  await sleep(2_000);
  const labels = await sessionLabels(bridge);
  log(`  session list after relaunch: ${JSON.stringify(labels)}`);
  await bridge.screenshot(join(evidenceDir, screenshot));
  assert(!has(labels, "Close me") && !has(labels, "Crash me"), "no closed session came back");
  assert(has(labels, "Keep me"), "the kept session came back");
  assert(labels.length === 1, "exactly one session was restored");
}

let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}`);

  // ── run 1: close a session and quit less than a second later ─────
  log("step 1: fresh launch, welcome screens");
  app = await launch(1, { first: true });
  await completeOnboarding(app.bridge);

  log('step 2: create "Keep me" and "Close me"');
  const keepId = await createPlainSession(app.bridge, "Keep me");
  const goneId = await createPlainSession(app.bridge, "Close me");
  await waitSavedWith(app.bridge, [keepId, goneId], "the saved workspace to hold both sessions");
  log(`  saved workspace: ${JSON.stringify(await savedIds(app.bridge))}`);
  await app.bridge.screenshot(join(evidenceDir, "01-two-sessions.png"));

  log('step 3: close "Close me" and quit within 1 s');
  await closeSession(app.bridge, "Close me");
  const closedAt = Date.now();
  const stopping = app.stop({ keepFiles: false });
  const quitAfterMs = Date.now() - closedAt;
  const exit = await stopping;
  log(`  quit asked ${quitAfterMs} ms after the close; app exited: ${JSON.stringify(exit)}`);
  assert(quitAfterMs < QUIT_WITHIN_MS, `the quit started ${quitAfterMs} ms after the close (< ${QUIT_WITHIN_MS} ms)`);
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");

  // ── run 2: only the kept session comes back ──────────────────────
  log('step 4: relaunch — only "Keep me" comes back');
  app = await launch(2);
  await expectOnlyKept(app.bridge, "02-after-relaunch.png");

  log('step 5: create "Close me too", close it — the saved workspace drops it within 2 s');
  const tooId = await createPlainSession(app.bridge, "Close me too");
  await waitSavedWith(app.bridge, [keepId, tooId], "the saved workspace to hold both sessions");
  await closeSession(app.bridge, "Close me too");
  const droppedAt = Date.now();
  await app.bridge.waitFor("the saved workspace to drop the closed session", `
    const s = await window.__TAURI_INTERNALS__.invoke("get_settings");
    return !!s.saved_workspace && !s.saved_workspace.includes(${JSON.stringify(tooId)}) && s.saved_workspace.includes(${JSON.stringify(keepId)});
  `, { timeoutMs: 2_000, intervalMs: 50 });
  // This is not the frontend's delayed save: get_settings waits on the
  // database while close_session finishes its cleanup, so the figure is
  // mostly that wait. The kill in step 7 is what proves the backend drops
  // the session before close_session returns.
  log(`  saved workspace read back without the session ${Date.now() - droppedAt} ms after the session left the list: ${JSON.stringify(await savedIds(app.bridge))}`);
  await quit(app);

  // ── run 3: still only the kept session; then close and crash ─────
  log('step 6: relaunch — still only "Keep me"');
  app = await launch(3);
  await expectOnlyKept(app.bridge, "03-after-second-relaunch.png");

  log('step 7: create "Crash me", close it and kill the app within 1 s (no exit handler runs)');
  const crashId = await createPlainSession(app.bridge, "Crash me");
  await waitSavedWith(app.bridge, [keepId, crashId], "the saved workspace to hold both sessions");
  await closeSession(app.bridge, "Crash me");
  const crashClosedAt = Date.now();
  app.child.kill("SIGKILL");
  const killedAfterMs = Date.now() - crashClosedAt;
  const killDeadline = Date.now() + 10_000;
  while (app.isRunning() && Date.now() < killDeadline) await sleep(50);
  assert(!app.isRunning(), "the app is gone");
  assert(killedAfterMs < QUIT_WITHIN_MS, `the app was killed ${killedAfterMs} ms after the close (< ${QUIT_WITHIN_MS} ms)`);
  app.cleanup();

  // ── run 4: the crash did not bring it back either ────────────────
  log('step 8: relaunch after the kill — still only "Keep me"');
  app = await launch(4);
  await expectOnlyKept(app.bridge, "04-after-kill-relaunch.png");
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  if (app?.isRunning()) {
    log("finally: quit the app");
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
    if (!failed && (exit.forced || exit.code !== 0)) {
      failed = true;
      log("FAILED: the app did not quit cleanly");
    }
  }
  if (homeDir) rmSync(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
