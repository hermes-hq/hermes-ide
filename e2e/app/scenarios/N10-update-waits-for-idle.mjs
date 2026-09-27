#!/usr/bin/env node
// Scenario (N10): an available update never relaunches the app while a
// session is working, installs normally once every session is idle, and the
// "Relaunch now" button still lets the user install on purpose.
//
// Runs against the REAL app, hands-free. The update *source* is faked
// through the e2e bridge (window.__HERMES_E2E__.forceUpdateReady) — there is
// no real update server in a test run — but everything downstream is the
// real code: the real useAutoUpdater state machine, the real <UpdateDialog>,
// and a REAL running terminal command to drive the "busy" signal.
//
// A terminal session counts as busy while it keeps printing (the session
// phase goes back to idle after ~2 s of output silence), so the command used
// here prints a line every half second until it finishes.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N10-update-waits-for-idle.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/N10-update-waits-for-idle.

import { platform } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "N10-update-waits-for-idle";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

/** A command that keeps the session busy (it prints every 0.5 s) for about
 *  ticks/2 seconds, then prints a marker so the scenario can tell it ended.
 *  Ends with \r, which is what the Enter key sends on every platform. */
function tickingCommand(ticks, marker) {
  if (platform() === "win32") {
    return `1..${ticks} | ForEach-Object { Write-Output "tick-$_"; Start-Sleep -Milliseconds 500 }; Write-Output ${marker}\r`;
  }
  return `i=0; while [ $i -lt ${ticks} ]; do i=$((i+1)); echo tick-$i; sleep 0.5; done; echo ${marker}\r`;
}

async function onboard(bridge) {
  await bridge.waitFor("the welcome dialog", `return !!e2e.first(".onboarding-dialog");`);
  for (const screen of ["welcome", "theme", "AI tools"]) {
    const clicked = await bridge.click(".onboarding-actions .onboarding-btn-primary");
    log(`  ${screen}: clicked "${clicked.clicked}"`);
    await sleep(150);
  }
  await bridge.waitFor("the privacy screen", `return e2e.all(".onboarding-privacy-checkbox input").length === 2;`);
  await bridge.clickWhenReady(`
    const [analytics, policy] = e2e.all(".onboarding-privacy-checkbox input");
    if (analytics.checked) e2e.click(analytics);
    if (!policy.checked) e2e.click(policy);
    return { analytics: analytics.checked, policy: policy.checked };
  `);
  await bridge.waitFor("the Finish button to become enabled", `
    const b = e2e.first(".onboarding-actions .onboarding-btn-primary");
    return !!b && !b.disabled;
  `);
  await bridge.click(".onboarding-actions .onboarding-btn-primary");
  await bridge.waitFor("the welcome dialog to close", `return !e2e.first(".onboarding-backdrop");`);
  await sleep(300);
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
    log("  dismissed the what's-new dialog");
  }
}

// Done before faking an update: the update dialog is a full-screen overlay
// and would block the New Session wizard underneath it.
async function createTerminal(bridge) {
  await bridge.click("button.es-tile-primary");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, {
    timeoutMs: 20_000,
  });
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`);
  await bridge.clickWhenReady(`
    const cards = e2e.all(".session-creator-provider-card");
    return e2e.click(e2e.must(cards[cards.length - 1], "plain shell card"));
  `);
  const before = await bridge.terminalIds();
  for (let i = 0; i < 6; i++) {
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
  const sessionId = await bridge.waitFor(
    "a terminal to appear",
    `const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
     return ids.length === 1 ? ids[0] : null;`,
    { timeoutMs: 20_000 },
  );
  log(`  session created: ${sessionId}`);
  await bridge.waitFor("the shell to print its prompt", `
    const lines = window.__HERMES_E2E__.readTerminal(${JSON.stringify(sessionId)}) || [];
    const info = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(sessionId)});
    return info && info.opened && lines.some((l) => l.trim().length > 0);
  `, { timeoutMs: 30_000 });
  await sleep(1000);
  return sessionId;
}

async function startBusyCommand(bridge, sessionId, ticks, marker) {
  await bridge.typeInTerminal(sessionId, tickingCommand(ticks, marker));
  log(`  started a command printing ${ticks} lines over ~${ticks / 2}s, ending with "${marker}"`);
  await bridge.waitFor("the session to go busy", `
    const info = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(sessionId)});
    return info && info.phase === "busy";
  `, { timeoutMs: 10_000 });
  log("  session phase: busy");
}

/** Did the command finish? (Its marker is printed on a line of its own — the
 *  echoed command line contains it too, but never alone.) */
function markerPrinted(bridge, sessionId, marker) {
  return bridge.eval(`
    const lines = window.__HERMES_E2E__.readTerminal(${JSON.stringify(sessionId)}) || [];
    return lines.some((l) => l.trim() === ${JSON.stringify(marker)});
  `);
}

// The status-bar version chip's "check for updates" click calls the same
// manualCheck() a real user would use — no need to wait out the 5 s
// auto-check or the 4 h retry interval.
async function openReadyUpdate(bridge) {
  await bridge.eval(`window.__HERMES_E2E__.forceUpdateReady("99.0.0", "N10 test update");`);
  await bridge.click(".status-version-chip");
  await bridge.waitFor("the update dialog", `return !!e2e.first(".update-dialog");`, { timeoutMs: 10_000 });
  assert(
    (await bridge.text(".update-dialog-title")) === "Update Available",
    "dialog shows 'Update Available' before download",
  );
  await bridge.click(".update-dialog-actions .update-dialog-btn-primary"); // "Update Now"
  await bridge.waitFor("the download to complete", `return !!e2e.first(".update-dialog-ready");`, {
    timeoutMs: 10_000,
  });
}

async function assertWaiting(bridge) {
  await bridge.waitFor("the 'waiting for agents' message", `return !!e2e.first(".update-dialog-waiting");`, {
    timeoutMs: 5_000,
  });
  const waitingText = await bridge.text(".update-dialog-waiting");
  assert(/waiting for 1 working agent/.test(waitingText), `waiting message names the busy count: "${waitingText}"`);
  assert(
    (await bridge.text(".update-dialog-actions .update-dialog-btn-primary")) === "Relaunch now",
    "busy: the primary button becomes the explicit 'Relaunch now' override",
  );
}

async function captureFailure(app) {
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      const dump = await app.bridge.eval(`
        return {
          buttons: e2e.all("button").map(e2e.nameOf).slice(0, 40),
          dialogs: [...document.querySelectorAll('[class*="backdrop"],[class*="overlay"]')].map((e) => e.className),
          updateState: window.__HERMES_E2E__.updateTestState ? window.__HERMES_E2E__.updateTestState() : null,
        };
      `);
      log(`  what the app showed: ${JSON.stringify(dump)}`);
    }
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
}

// This run deliberately leaves the (faked) installer mid-flight, so the app
// not quitting on its own quickly is expected — a forced stop is fine.
async function quit(app, label) {
  log(`${label}: quit the app`);
  const exit = await app.stop();
  log(`  app exited: ${JSON.stringify(exit)}`);
}

let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}`);

  // ═══ Part A — N10-1 and N10-2 ═════════════════════════════════════
  log("step 1: launch the test app");
  app = await launchApp({ runDir: join(evidenceDir, "run-a"), log });
  let { bridge } = app;

  log("step 2: go through the first-launch welcome screens");
  await onboard(bridge);

  log("step 3: create a terminal and start a command that keeps it busy for ~10s");
  let sessionId = await createTerminal(bridge);
  await startBusyCommand(bridge, sessionId, 20, "N10-A-DONE");
  await bridge.screenshot(join(evidenceDir, "01-session-busy.png"));

  log("step 4: an update becomes ready while the session is busy");
  await openReadyUpdate(bridge);

  log("step 5: the update dialog waits instead of installing");
  await assertWaiting(bridge);
  await bridge.screenshot(join(evidenceDir, "02-waiting-for-busy-session.png"));
  await sleep(1500); // give a would-be automatic installer time to (wrongly) fire
  let updateState = await bridge.eval(`return window.__HERMES_E2E__.updateTestState();`);
  assert(updateState.installCalls === 0, "nothing installed while the session is busy");
  assert(updateState.relaunchCalls === 0, "no relaunch attempt while the session is busy");
  assert(!(await markerPrinted(bridge, sessionId, "N10-A-DONE")), "the command was still running during that check");

  log("step 6: the command finishes and the session goes idle");
  await bridge.waitFor("the session to go idle again", `
    const info = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(sessionId)});
    return info && info.phase !== "busy";
  `, { timeoutMs: 30_000 });
  assert(await markerPrinted(bridge, sessionId, "N10-A-DONE"), "the command had printed its last line before idle");
  await bridge.waitFor("the waiting message to clear", `return !e2e.first(".update-dialog-waiting");`, {
    timeoutMs: 5_000,
  });
  assert(
    (await bridge.text(".update-dialog-actions .update-dialog-btn-primary")) === "Install & Relaunch",
    "idle again: the primary button is back to the ordinary 'Install & Relaunch'",
  );
  updateState = await bridge.eval(`return window.__HERMES_E2E__.updateTestState();`);
  assert(updateState.installCalls === 0, "going idle alone does not install behind the user's back");
  await bridge.screenshot(join(evidenceDir, "03-idle-again.png"));

  log("step 7: idle — clicking 'Install & Relaunch' installs as before");
  await bridge.click(".update-dialog-actions .update-dialog-btn-primary");
  await bridge.waitFor("the install pipeline to run", `
    const s = window.__HERMES_E2E__.updateTestState();
    return s && s.installCalls === 1 && s.relaunchCalls === 1;
  `, { timeoutMs: 10_000 });
  updateState = await bridge.eval(`return window.__HERMES_E2E__.updateTestState();`);
  assert(updateState.installCalls === 1, "install ran exactly once, now that the session is idle");
  assert(updateState.relaunchCalls === 1, "relaunch ran exactly once, now that the session is idle");
  await bridge.screenshot(join(evidenceDir, "04-installed-idle.png"));
  await quit(app, "step 8");
  app = null;

  // ═══ Part B — the "Relaunch now" override ═════════════════════════
  log("step 9: launch a fresh test app");
  app = await launchApp({ runDir: join(evidenceDir, "run-b"), log });
  ({ bridge } = app);
  await onboard(bridge);

  log("step 10: start a long command, then an update becomes ready");
  sessionId = await createTerminal(bridge);
  await startBusyCommand(bridge, sessionId, 60, "N10-B-DONE");
  await openReadyUpdate(bridge);
  await assertWaiting(bridge);

  log("step 11: the user clicks 'Relaunch now' while the session is still busy");
  await bridge.click(".update-dialog-actions .update-dialog-btn-primary");
  await bridge.waitFor("the install pipeline to run", `
    const s = window.__HERMES_E2E__.updateTestState();
    return s && s.installCalls === 1 && s.relaunchCalls === 1;
  `, { timeoutMs: 10_000 });
  const info = await bridge.eval(`return window.__HERMES_E2E__.terminalInfo(${JSON.stringify(sessionId)});`);
  assert(info?.phase === "busy", "the session was still busy when the override installed");
  assert(!(await markerPrinted(bridge, sessionId, "N10-B-DONE")), "the command was still running");
  updateState = await bridge.eval(`return window.__HERMES_E2E__.updateTestState();`);
  assert(
    updateState.installCalls === 1 && updateState.relaunchCalls === 1,
    "'Relaunch now' installs and relaunches exactly once",
  );
  await bridge.screenshot(join(evidenceDir, "05-relaunch-now-override.png"));
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  await captureFailure(app);
} finally {
  if (app) await quit(app, "last step");
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
