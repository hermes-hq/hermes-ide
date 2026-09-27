#!/usr/bin/env node
// Scenario: the Shortcuts panel (opened from the status bar) shows exactly
// what the native menu bar defines — nothing stale, nothing missing — because
// it's generated from src-tauri/src/menu/mod.rs (scripts/generate-shortcuts.mjs)
// instead of hand-maintained.
//
// Runs against the REAL app, hands-free.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N23-shortcuts-panel.mjs

import { platform } from "node:os";
import { join } from "node:path";
import { createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "N23-shortcuts-panel";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}`);

  // ── 1. Launch and get through first-launch onboarding ────────────
  log("step 1: launch the test app and dismiss onboarding");
  app = await launchApp({ runDir: join(evidenceDir, "run"), log });
  const { bridge } = app;
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
  }

  // ── 2. Open the Shortcuts panel from the status bar ───────────────
  log("step 2: open the Shortcuts panel");
  await bridge.click(".status-shortcuts-btn");
  await bridge.waitFor("the Shortcuts panel", `return !!e2e.first(".shortcuts-panel");`);
  await bridge.screenshot(join(evidenceDir, "01-shortcuts-panel.png"));

  const rows = await bridge.eval(`
    return e2e.all(".shortcuts-row").map((row) => ({
      action: e2e.norm(e2e.first(".shortcuts-action", row)?.innerText),
      keys: e2e.norm(e2e.first(".shortcuts-kbd", row)?.innerText),
    }));
  `);
  // The group label is styled with CSS text-transform: uppercase, which
  // `innerText` reflects (unlike `textContent`) — compare case-insensitively.
  const groups = await bridge.eval(`return e2e.all(".shortcuts-group-label").map((el) => e2e.norm(el.innerText));`);
  log(`  groups shown: ${groups.join(", ")}`);
  log(`  ${rows.length} shortcut row(s): ${JSON.stringify(rows)}`);

  // ── 3. It matches the real menu, not a hand-written guess ─────────
  log("step 3: check the panel against src-tauri/src/menu/mod.rs's actual accelerators");
  assert(
    groups.some((g) => g.toLowerCase() === "file"),
    'the "File" menu group is shown (grouped like the native menu, not a made-up category)',
  );
  const find = (action) => rows.find((r) => r.action === action);

  const newSession = find("New Session");
  assert(!!newSession, '"New Session" (file.new-session, CmdOrCtrl+N in the menu) is listed');
  const newTab = find("New Tab");
  assert(!!newTab, '"New Tab" (file.new-session-tab, CmdOrCtrl+T) is listed with its real label');
  if (platform() === "darwin") {
    assert(newSession.keys === "⌘N", `New Session shows the mac accelerator (got "${newSession.keys}")`);
    assert(newTab.keys === "⌘T", `New Tab shows the mac accelerator (got "${newTab.keys}")`);
  } else {
    assert(newSession.keys === "Ctrl+N", `New Session shows the PC accelerator (got "${newSession.keys}")`);
    assert(newTab.keys === "Ctrl+T", `New Tab shows the PC accelerator (got "${newTab.keys}")`);
  }

  // CmdOrCtrl+T is really "New Tab" in the menu — a hand-maintained panel
  // once labelled it "Toggle Timeline", a feature that doesn't exist. The
  // generated panel can't make that mistake: it has no "Toggle Timeline"
  // entry, and CmdOrCtrl+T's real label ("New Tab") is checked above.
  assert(!find("Toggle Timeline"), 'no stale "Toggle Timeline" entry (that feature does not exist)');

  const allActions = rows.map((r) => r.action);
  assert(new Set(allActions).size === allActions.length, "no two rows show the same action label");
  const allKeys = rows.map((r) => r.keys);
  assert(new Set(allKeys).size === allKeys.length, "no two rows show the same key combo");

  // ── 4. Close it ────────────────────────────────────────────────────
  log("step 4: close the panel");
  await bridge.click(".shortcuts-close");
  await bridge.waitFor("the panel to close", `return !e2e.first(".shortcuts-panel");`);
  assert(!(await bridge.exists(".shortcuts-panel")), "the Shortcuts panel is gone");
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
    log("step 5: quit the app");
    const exit = await app.stop();
    if (!failed && (exit.forced || exit.code !== 0)) {
      failed = true;
      log("FAILED: the app did not quit cleanly");
    }
  }
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
