#!/usr/bin/env node
// Scenario F01: the Keyboard Shortcuts panel lists what the app binds today.
//
//   1. Open the panel from the status bar, the way a person would.
//   2. Mod+T reads "New Tab (shell)"; no stale "Timeline" row is left.
//   3. The Agent-view shortcuts (Mod+Shift+J, Mod+Alt+B) are listed in
//      their own group, and the platform's own rows are there (Send
//      Interrupt on macOS, F11 full screen elsewhere).
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F01-shortcuts-panel.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/F01-shortcuts-panel.

import { rmSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "F01-shortcuts-panel";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

async function passOnboarding(bridge) {
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
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
    log("  dismissed the what's-new dialog");
  }
}

let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}`);
  log("step 1: launch, then open Keyboard Shortcuts from the status bar");
  app = await launchApp({ runDir: join(evidenceDir, "run"), log });
  const { bridge } = app;
  await passOnboarding(bridge);
  await bridge.click(".status-shortcuts-btn");
  await bridge.waitFor("the Keyboard Shortcuts panel", `return e2e.all(".shortcuts-panel .shortcuts-row").length > 0;`);

  const panel = await bridge.eval(`
    return {
      text: e2e.first(".shortcuts-panel").innerText,
      groups: e2e.all(".shortcuts-group").map((g) => ({
        label: g.querySelector(".shortcuts-group-label")?.innerText.trim() ?? "",
        rows: [...g.querySelectorAll(".shortcuts-row")].map((r) => ({
          action: r.querySelector(".shortcuts-action")?.innerText.trim() ?? "",
          keys: r.querySelector(".shortcuts-kbd")?.innerText.trim() ?? "",
        })),
      })),
    };
  `);
  for (const g of panel.groups) log(`  ${g.label}: ${g.rows.map((r) => `${r.keys} = ${r.action}`).join("; ")}`);
  await bridge.screenshot(join(evidenceDir, "01-shortcuts-panel.png"));

  const rows = panel.groups.flatMap((g) => g.rows);
  const row = (action) => rows.find((r) => r.action === action);
  const mac = platform() === "darwin";
  const mod = mac ? "⌘" : "Ctrl+";

  log("step 2: the rows match what the app binds");
  assert(row("New Tab (shell)")?.keys === `${mod}T`, `${mod}T is "New Tab (shell)"`);
  assert(!/timeline/i.test(panel.text), 'no "Timeline" row is left');
  assert(row("New session")?.keys === `${mod}N`, `${mod}N is "New session"`);
  const agentGroup = panel.groups.find((g) => /agent view/i.test(g.label));
  assert(!!agentGroup, 'the Agent-view shortcuts have their own "Agent view" group');
  const agentActions = agentGroup.rows.map((r) => r.action);
  assert(agentActions.includes("Focus Composer") && agentActions.includes("Toggle Workbench"), "Focus Composer and Toggle Workbench are listed there");
  if (mac) {
    assert(!!row("Send Interrupt"), "Send Interrupt (Ctrl+C) is listed on macOS");
    assert(row("Toggle Fullscreen")?.keys !== "F11", "full screen is not listed as F11 on macOS");
  } else {
    assert(row("Toggle Fullscreen")?.keys === "F11", "full screen is F11");
    assert(!row("Send Interrupt"), "Send Interrupt is not listed (the terminal handles Ctrl+C itself)");
  }

  log("step 3: close the panel");
  await bridge.click(".shortcuts-close");
  await bridge.waitFor("the panel to close", `return !e2e.first(".shortcuts-panel");`);
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  if (app) {
    log("quit the app");
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
    if (!failed && (exit.forced || exit.code !== 0)) {
      failed = true;
      log("FAILED: the app did not quit cleanly");
    }
  }
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
