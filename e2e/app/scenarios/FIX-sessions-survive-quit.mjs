#!/usr/bin/env node
// Scenario: sessions are never lost on quit, on the REAL app, with plain
// shell sessions (no agent account). Every quit goes through a path a person
// uses: the app menu's Quit item, closing the window, and AppHandle::exit
// (what the rig's /quit and the app's own exits use).
//
//   run 1  fresh install: welcome screens; create "Alpha"; wait until it is
//          saved; quit
//   run 2  "Alpha" is restored. Quit 500 ms after it shows (AppHandle::exit)
//   run 3  "Alpha" is back. Create "Beta" and choose Quit in the app menu
//          100 ms after it shows
//   run 4  "Alpha" and "Beta" are back. Create "Gamma" and close the window
//          100 ms after it shows
//   run 5  all three are back. Create "Delta" and quit (AppHandle::exit)
//          100 ms after it shows
//   run 6  all four are back. Close "Gamma" and choose Quit less than 1 s
//          later
//   run 7  "Alpha", "Beta" and "Delta" are back; "Gamma" stays closed.
//          Turn "Restore sessions" off (Settings) and quit
//   run 8  nothing is restored; 2 s later the saved workspace still holds
//          the three sessions. Close the window, relaunch (run 9): still
//          there. Turn restoring back on and choose Quit
//   run 10 "Alpha", "Beta" and "Delta" are back: a launch that restored
//          nothing never wrote an empty workspace over the saved one
//
// Each quit must end cleanly, and what the next launch shows is the proof a
// person sees. The app log line "[quit] workspace saved" is checked too: it
// is the only direct sign that the quit was held until the frontend wrote
// (rather than the write winning a race), and closing the window now has a
// single owner (the backend hold), so the line is deterministic.
//
// Negative controls (run by hand): a build of main before this fix ends in
// RESULT: FAIL at run 3 ("Alpha" is gone: the restore had emptied the saved
// workspace and the quit did not write it again). A build where quitting
// does not wait for the frontend (quit_flush::hold_for_flush returning false
// at once) ends in RESULT: FAIL at run 4 ("Beta" is gone: 100 ms is before
// the save that follows a new session). Neither build logs the quit-time
// save, so run the controls with HERMES_E2E_NEGATIVE_CONTROL=1, which skips
// only that log check and lets them fail on what a person would see.
// A third control puts back the frontend's own close-requested handler
// (save, then destroy the window): closing the window races the backend's
// hold again, and repeated runs end in RESULT: FAIL at run 4 ("app exited
// ~60 ms after the quit", no quit line). The controls carry the same build
// stamp as the fixed build (the stamp hashes the built frontend only), so
// the differing outcome is what shows which code ran.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/FIX-sessions-survive-quit.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/FIX-sessions-survive-quit.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "FIX-sessions-survive-quit";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

/** How long after the UI shows the restored session the app is quit. */
const QUIT_AFTER_RESTORE_MS = 500;
/** How long after a new session shows the app is quit. */
const QUIT_AFTER_CREATE_MS = 100;
/** A quit waits for the workspace at most 3 s; the exit must follow soon. */
const EXIT_WITHIN_MS = 8_000;
/** Negative-control runs skip the app-log check (see the header). */
const CHECK_QUIT_LOG = process.env.HERMES_E2E_NEGATIVE_CONTROL !== "1";
/** The id of the app menu's Quit item (src-tauri/src/menu/mod.rs). */
const QUIT_MENU_ID = "hermes.quit";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

// Windows keeps app data under %APPDATA%, which a private HOME does not move.
const onWindows = platform() === "win32";
const homeDir = onWindows ? undefined : mkdtempSync(join(tmpdir(), "hermes-e2e-persist-home-"));
function launch(run, { first = false } = {}) {
  const runDir = join(evidenceDir, `run-${run}`);
  return onWindows
    ? launchApp({ runDir, log, home: "real", resetData: first })
    : launchApp({ runDir, log, home: "private", homeDir });
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
const NAME_INPUT = 'input.command-palette-input[placeholder="Session name (optional)"]';

/**
 * Create a plain shell session named `label` through the New Session wizard;
 * returns its id. With `returnAfterMs`, the wizard's last click and the wait
 * for the session to show in the list run inside the page, and the call
 * returns `returnAfterMs` after the session showed (plus the bridge's own
 * round trip): the caller quits right then.
 */
async function createPlainSession(bridge, label, { returnAfterMs = null } = {}) {
  const before = await bridge.terminalIds();
  await showSessionList(bridge).catch(() => {});
  await bridge.eval(`return e2e.click(e2e.must(e2e.first("button.es-tile-primary") || e2e.first(".activity-bar-action"), "new session button"));`);
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`);
  await bridge.clickWhenReady(`
    const cards = e2e.all(".session-creator-provider-card");
    return e2e.click(e2e.must(cards[cards.length - 1], "plain shell card"));
  `);
  // The remaining steps (folder, confirm) only need their primary button;
  // the session is named on the confirm step, whose button creates it.
  let timing = null;
  for (let i = 0; i < 8; i++) {
    if (!(await bridge.exists(".session-creator"))) break;
    if (await bridge.exists(NAME_INPUT)) {
      await bridge.eval(setInput(NAME_INPUT, label));
      timing = await bridge.eval(`
        const listed = () => [...document.querySelectorAll(".session-item")].some((el) => el.textContent.includes(${JSON.stringify(label)}));
        e2e.click(e2e.must(e2e.first(${JSON.stringify(PRIMARY)}), "the wizard's create button"));
        const clickedAt = performance.now();
        while (!listed()) {
          if (performance.now() - clickedAt > 20000) throw new Error("the new session never showed in the list");
          if (!document.querySelector(".session-list")) {
            const tab = e2e.all(".activity-bar-tab").find((el) => (el.getAttribute("aria-label") || el.title || el.innerText || "").toLowerCase().includes("session"));
            if (tab) tab.click();
          }
          await new Promise((r) => setTimeout(r, 5));
        }
        const shownAfterMs = Math.round(performance.now() - clickedAt);
        await new Promise((r) => setTimeout(r, ${returnAfterMs ?? 0}));
        return { shownAfterMs };
      `, { timeoutMs: 30_000 });
      break;
    }
    await bridge
      .clickWhenReady(`
        if (!e2e.first(".session-creator")) return null;
        return e2e.click(e2e.must(e2e.first(${JSON.stringify(PRIMARY)}), "the wizard's primary button"));
      `)
      .catch(() => null);
    await sleep(400);
  }
  if (!timing) throw new Error("the wizard never showed its confirm step");
  if (returnAfterMs !== null) {
    log(`  "${label}" showed in the list ${timing.shownAfterMs} ms after the create click; quitting ${returnAfterMs} ms after that`);
    return null;
  }
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  const id = await bridge.waitFor(`the terminal of "${label}"`, `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
    return ids.length === 1 ? ids[0] : null;
  `, { timeoutMs: 20_000 });
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

/** Change a setting the way the Settings panel does. */
async function setSettingValue(bridge, key, value) {
  await bridge.eval(`
    await window.__TAURI_INTERNALS__.invoke("set_setting", { key: ${JSON.stringify(key)}, value: ${JSON.stringify(value)} });
    return true;
  `);
  log(`  setting ${key} = ${JSON.stringify(value)}`);
}

/** A launch with restoring turned off: no session shows, and 2 s later the saved workspace is untouched. */
async function expectNothingRestoredAndKept(bridge, labels) {
  await bridge.waitFor("the app UI (returning launch)", `return !!e2e.first(".topbar") && !e2e.first(".onboarding-backdrop");`);
  await dismissWhatsNew(bridge);
  // Longer than the save that follows a load (300 ms) and a late restore.
  await sleep(2_000);
  const shown = await bridge.eval(`return e2e.all(".session-item").map((el) => e2e.norm(el.innerText));`);
  log(`  session list: ${JSON.stringify(shown)}`);
  assert(shown.length === 0, "no session was restored (restoring is off)");
  const saved = await savedLabels(bridge);
  log(`  saved workspace 2 s after the launch: ${JSON.stringify(saved)}`);
  assert(Array.isArray(saved) && labels.every((l) => saved.includes(l)) && saved.length === labels.length,
    `the saved workspace still holds ${JSON.stringify(labels)}`);
}

/** The session labels in the saved workspace ("" when it is empty). */
async function savedLabels(bridge) {
  return bridge.eval(`
    const s = await window.__TAURI_INTERNALS__.invoke("get_settings");
    if (!s.saved_workspace) return "";
    return (JSON.parse(s.saved_workspace).sessions || []).map((x) => x.label);
  `);
}

/** After a relaunch: exactly `labels` come back. */
async function expectRestored(bridge, labels, screenshot) {
  await bridge.waitFor("the app UI (returning launch)", `return !!e2e.first(".topbar") && !e2e.first(".onboarding-backdrop");`);
  await dismissWhatsNew(bridge);
  await showSessionList(bridge).catch(() => {});
  await bridge.waitFor(`${JSON.stringify(labels)} to be restored`, `
    const items = e2e.all(".session-item").map((el) => el.innerText);
    return ${JSON.stringify(labels)}.every((l) => items.some((t) => t.includes(l)));
  `, { timeoutMs: 30_000 }).catch(() => {});
  // Give a late restore time to show up before judging the list.
  await sleep(1_500);
  const shown = await sessionLabels(bridge);
  log(`  session list after relaunch: ${JSON.stringify(shown)}`);
  await bridge.screenshot(join(evidenceDir, screenshot));
  for (const l of labels) assert(has(shown, l), `"${l}" came back`);
  assert(shown.length === labels.length, `exactly ${labels.length} session(s) came back`);
  return shown;
}

/**
 * Wait for the app to exit after a quit was asked for, then check it exited
 * cleanly and that the frontend wrote the workspace before the exit.
 */
async function expectCleanExit(current, how, askedAt) {
  const until = askedAt + EXIT_WITHIN_MS + 5_000;
  while (current.isRunning() && Date.now() < until) await sleep(50);
  const tookMs = Date.now() - askedAt;
  const exit = await current.stop({ keepFiles: true });
  // A shell of the app may still be writing its private temp folder for a
  // moment after the app is gone.
  for (let i = 0; ; i++) {
    try {
      current.cleanup();
      break;
    } catch (e) {
      if (i >= 20) throw e;
      await sleep(250);
    }
  }
  log(`  ${how}: app exited ${tookMs} ms after the quit: ${JSON.stringify(exit)}`);
  assert(!exit.forced && exit.code === 0, `the app quit cleanly (${how})`);
  assert(tookMs < EXIT_WITHIN_MS, `the quit took ${tookMs} ms (< ${EXIT_WITHIN_MS} ms)`);
  const appLog = readFileSync(current.appLog, "utf8");
  const line = appLog.split(/\r?\n/).find((l) => l.includes("[quit] workspace"));
  log(`  app log: ${line ? line.trim() : "(no quit line)"}`);
  if (CHECK_QUIT_LOG) {
    assert(!!line && line.includes("[quit] workspace saved"), `the frontend wrote the workspace before the exit (${how})`);
  }
}

/** Ask the app to quit in one of the ways a person or the app does. */
async function quitVia(current, how) {
  const askedAt = Date.now();
  if (how === "menu Quit") {
    await current.bridge.chooseMenuItem(QUIT_MENU_ID);
  } else if (how === "window close") {
    await current.bridge
      .eval(`window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: "main" }); return true;`)
      .catch(() => {});
  } else {
    await current.bridge.quit();
  }
  return askedAt;
}

let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}`);

  // ── run 1: one saved session ─────────────────────────────────────
  log("step 1: fresh launch, welcome screens; create \"Alpha\" and wait until it is saved");
  app = await launch(1, { first: true });
  await completeOnboarding(app.bridge);
  const alphaId = await createPlainSession(app.bridge, "Alpha");
  await app.bridge.waitFor("the saved workspace to hold \"Alpha\"", `
    const s = await window.__TAURI_INTERNALS__.invoke("get_settings");
    return !!s.saved_workspace && s.saved_workspace.includes(${JSON.stringify(alphaId)});
  `, { timeoutMs: 40_000, intervalMs: 250 });
  await app.bridge.screenshot(join(evidenceDir, "01-alpha.png"));
  await expectCleanExit(app, "AppHandle::exit", await quitVia(app, "exit"));

  // ── run 2 (a): quit 500 ms after the restored session shows ──────
  log(`step 2: relaunch; quit ${QUIT_AFTER_RESTORE_MS} ms after "Alpha" is restored`);
  app = await launch(2);
  await app.bridge.waitFor('"Alpha" in the session list', `
    const list = e2e.first(".session-list");
    if (!list) {
      const tab = e2e.all(".activity-bar-tab").find((el) => (el.getAttribute("aria-label") || el.title || el.innerText || "").toLowerCase().includes("session"));
      if (tab) e2e.click(tab);
      return false;
    }
    return e2e.all(".session-item").some((el) => el.innerText.includes("Alpha"));
  `, { timeoutMs: 60_000, intervalMs: 25 });
  const shownAt = Date.now();
  await sleep(Math.max(0, QUIT_AFTER_RESTORE_MS - 150 - (Date.now() - shownAt)));
  // What a quit right now would leave behind (a build before the fix had
  // already emptied it here).
  log(`  saved workspace ${Date.now() - shownAt} ms after the restore showed: ${JSON.stringify(await savedLabels(app.bridge))}`);
  await sleep(Math.max(0, QUIT_AFTER_RESTORE_MS - (Date.now() - shownAt)));
  const quitAfterMs = Date.now() - shownAt;
  assert(quitAfterMs < QUIT_AFTER_RESTORE_MS + 400, `the quit is asked ${quitAfterMs} ms after the restore showed`);
  await expectCleanExit(app, "AppHandle::exit", await quitVia(app, "exit"));

  // ── run 3 (b, menu Quit) ─────────────────────────────────────────
  log('step 3: relaunch — "Alpha" is back; create "Beta" and choose Quit in the app menu 100 ms later');
  app = await launch(3);
  await expectRestored(app.bridge, ["Alpha"], "03-after-quick-quit.png");
  await createPlainSession(app.bridge, "Beta", { returnAfterMs: QUIT_AFTER_CREATE_MS });
  await expectCleanExit(app, "menu Quit", await quitVia(app, "menu Quit"));

  // ── run 4 (b, window close) ──────────────────────────────────────
  log('step 4: relaunch — "Alpha" and "Beta" are back; create "Gamma" and close the window 100 ms later');
  app = await launch(4);
  await expectRestored(app.bridge, ["Alpha", "Beta"], "04-after-menu-quit.png");
  await createPlainSession(app.bridge, "Gamma", { returnAfterMs: QUIT_AFTER_CREATE_MS });
  await expectCleanExit(app, "window close", await quitVia(app, "window close"));

  // ── run 5 (b, AppHandle::exit) ───────────────────────────────────
  log('step 5: relaunch — all three are back; create "Delta" and quit 100 ms later');
  app = await launch(5);
  await expectRestored(app.bridge, ["Alpha", "Beta", "Gamma"], "05-after-window-close.png");
  await createPlainSession(app.bridge, "Delta", { returnAfterMs: QUIT_AFTER_CREATE_MS });
  await expectCleanExit(app, "AppHandle::exit", await quitVia(app, "exit"));

  // ── run 6 (c): close a session, then quit within 1 s ─────────────
  log('step 6: relaunch — all four are back; close "Gamma" and choose Quit less than 1 s later');
  app = await launch(6);
  await expectRestored(app.bridge, ["Alpha", "Beta", "Gamma", "Delta"], "06-after-exit.png");
  await closeSession(app.bridge, "Gamma");
  const closedAt = Date.now();
  const askedAt = await quitVia(app, "menu Quit");
  assert(askedAt - closedAt < 1_000, `the quit was asked ${askedAt - closedAt} ms after the close (< 1000 ms)`);
  await expectCleanExit(app, "menu Quit", askedAt);

  // ── run 7: the closed session stays closed ───────────────────────
  log('step 7: relaunch — "Alpha", "Beta" and "Delta" are back; "Gamma" stays closed');
  app = await launch(7);
  const finalLabels = await expectRestored(app.bridge, ["Alpha", "Beta", "Delta"], "07-closed-stays-closed.png");
  assert(!has(finalLabels, "Gamma"), '"Gamma" did not come back');
  await setSettingValue(app.bridge, "restore_sessions", "never");
  await expectCleanExit(app, "AppHandle::exit", await quitVia(app, "exit"));

  // ── runs 8-10: a launch that restores nothing keeps the saved workspace ──
  const kept = ["Alpha", "Beta", "Delta"];
  log("step 8: relaunch with restoring off — nothing shows, the saved workspace is kept; close the window");
  app = await launch(8);
  await expectNothingRestoredAndKept(app.bridge, kept);
  await app.bridge.screenshot(join(evidenceDir, "08-restore-off.png"));
  await expectCleanExit(app, "window close", await quitVia(app, "window close"));

  log("step 9: relaunch with restoring off — still kept; turn restoring on and choose Quit");
  app = await launch(9);
  await expectNothingRestoredAndKept(app.bridge, kept);
  await setSettingValue(app.bridge, "restore_sessions", "always");
  await expectCleanExit(app, "menu Quit", await quitVia(app, "menu Quit"));

  log('step 10: relaunch with restoring on — "Alpha", "Beta" and "Delta" are back');
  app = await launch(10);
  await expectRestored(app.bridge, kept, "10-restored-again.png");
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
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
