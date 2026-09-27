#!/usr/bin/env node
// Scenario (N10): an available update never relaunches the app while a
// session is working, and installs normally once every session is idle.
//
// Runs against the REAL app, hands-free. The update *source* is faked
// through the e2e bridge (window.__HERMES_E2E__.forceUpdateReady) — there is
// no real update server in a test run — but everything downstream is the
// real code: the real useAutoUpdater state machine, the real <UpdateDialog>,
// and a REAL running terminal command to drive the "busy" signal.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/n10-update-waits-for-idle.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/n10-update-waits-for-idle.

import { platform } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createLogger, launchApp, outDir, sleep } from "../harness.mjs";

const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", "n10-update-waits-for-idle");
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

let app;
let failed = false;

try {
  log(`scenario: n10-update-waits-for-idle   platform: ${platform()}`);

  // ── 1. Launch ──────────────────────────────────────────────────────
  log("step 1: launch the test app");
  app = await launchApp({ runDir: join(evidenceDir, "run"), log });
  const { bridge } = app;

  // ── 2. First-launch welcome ──────────────────────────────────────
  log("step 2: go through the first-launch welcome screens");
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

  // ── 3. Create a terminal and start a long-running command ─────────
  // (Done before faking an update: the update dialog is a full-screen
  // overlay and would block the New Session wizard underneath it.)
  log("step 3: create a terminal and start a long-running command");
  await bridge.click("button.es-tile-primary");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator .session-creator-mode-step");`, {
    timeoutMs: 20_000,
  });
  await bridge.click('.session-creator-mode-card[data-category="universal"]');
  await bridge.waitFor("terminal mode to be selected", `
    return e2e.first('.session-creator-mode-card[data-category="universal"]')?.getAttribute("aria-checked") === "true";
  `);
  await bridge.click(".session-creator-actions .session-creator-btn-primary");
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
  await bridge.typeInTerminal(sessionId, "sleep 6\n");
  log("  typed: sleep 6");

  await bridge.waitFor("the session to go busy", `
    const info = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(sessionId)});
    return info && info.phase === "busy";
  `, { timeoutMs: 10_000 });
  log("  session phase: busy");
  await bridge.screenshot(join(evidenceDir, "01-session-busy.png"));

  // ── 4. Fake the update source, then trigger a check on demand ──────
  // (The status-bar version chip's "check for updates" click calls the
  // same manualCheck() a real user would use — no need to wait out the
  // 5s auto-check or the 4h retry interval.)
  log("step 4: force a fake update ready, then trigger a manual check while busy");
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

  // ── 5. Still busy: the dialog waits, nothing installs ──────────────
  log("step 5: while the session is busy, the update dialog waits instead of installing");
  await bridge.waitFor("the 'waiting for agents' message", `return !!e2e.first(".update-dialog-waiting");`, {
    timeoutMs: 5_000,
  });
  const waitingText = await bridge.text(".update-dialog-waiting");
  assert(/waiting for 1 working agent/.test(waitingText), `waiting message names the busy count: "${waitingText}"`);
  assert(
    (await bridge.text(".update-dialog-actions .update-dialog-btn-primary")) === "Relaunch now",
    "busy: the primary button becomes the explicit 'Relaunch now' override",
  );
  await bridge.screenshot(join(evidenceDir, "03-waiting-for-busy-session.png"));
  await sleep(1500); // give a would-be automatic installer time to (wrongly) fire
  let updateState = await bridge.eval(`return window.__HERMES_E2E__.updateTestState();`);
  assert(updateState.installCalls === 0, "still nothing installed while the session is busy");
  assert(updateState.relaunchCalls === 0, "still no relaunch attempt while the session is busy");

  // ── 6. Session goes idle again — the dialog reverts ───────────────
  log("step 6: wait for the command to finish and the session to go idle");
  await bridge.waitFor("the session to go idle again", `
    const info = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(sessionId)});
    return info && info.phase !== "busy";
  `, { timeoutMs: 15_000 });
  await bridge.waitFor("the waiting message to clear", `return !e2e.first(".update-dialog-waiting");`, {
    timeoutMs: 5_000,
  });
  assert(
    (await bridge.text(".update-dialog-actions .update-dialog-btn-primary")) === "Install & Relaunch",
    "idle again: the primary button is back to the ordinary 'Install & Relaunch'",
  );
  await bridge.screenshot(join(evidenceDir, "04-idle-again.png"));

  // ── 7. Idle: installing works exactly as before this feature ──────
  log("step 7: idle — clicking 'Install & Relaunch' installs normally");
  await bridge.click(".update-dialog-actions .update-dialog-btn-primary");
  await bridge.waitFor("the install pipeline to run", `
    const s = window.__HERMES_E2E__.updateTestState();
    return s && s.installCalls === 1 && s.relaunchCalls === 1;
  `, { timeoutMs: 10_000 });
  updateState = await bridge.eval(`return window.__HERMES_E2E__.updateTestState();`);
  assert(updateState.installCalls === 1, "install ran exactly once, now that the session is idle");
  assert(updateState.relaunchCalls === 1, "relaunch ran exactly once, now that the session is idle");
  await bridge.screenshot(join(evidenceDir, "05-installed-idle.png"));
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
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
} finally {
  if (app) {
    log("step 8: quit the app");
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
    // This run deliberately leaves the (faked) installer mid-flight, so the
    // app not exiting on its own quickly is expected — a forced stop is fine.
  }
}

log(failed ? "RESULT: FAIL" : "RESULT: PASS");
process.exit(failed ? 1 : 0);
