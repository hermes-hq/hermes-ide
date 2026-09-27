#!/usr/bin/env node
// Scenario: F04 — private by default.
//
// Proves, against the REAL compiled app:
//   1. A fresh profile that clicks through onboarding without touching the
//      analytics checkbox ends up with telemetry_enabled=false (the
//      checkbox itself starts unchecked — it used to default to checked).
//   2. With telemetry off, the Aptabase plugin was never registered at
//      startup, so invoking its command directly fails: there is no
//      network client sitting there that a bug could still fire.
//   3. Flipping the persisted setting to "true" at runtime does not bring
//      the plugin back — the env switch that e2e/CI runs use
//      (`HERMES_E2E=1`) wins over a fixture profile's own setting, so
//      e2e/CI runs never send analytics no matter what a stored setting
//      says.
//   4. "Delete session data" is wired end-to-end: the real IPC command
//      resolves for a real session.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/f04-private-by-default.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/f04-private-by-default.

import { rmSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { createLogger, launchApp, outDir, sleep } from "../harness.mjs";

const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", "f04-private-by-default");
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

/** Invokes a raw Tauri command from inside the app's own webview, the same
 *  path `@tauri-apps/api/core`'s `invoke()` uses. Returns { ok, value }
 *  instead of throwing, so both a successful call and a rejected one (e.g.
 *  a plugin command that was never registered) can be asserted on. */
async function rawInvoke(bridge, cmd, args = {}) {
  return bridge.eval(`
    try {
      const value = await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)});
      return { ok: true, value };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  `);
}

let app;
let failed = false;

try {
  log(`scenario: f04-private-by-default   platform: ${platform()}`);

  // ── 1. Launch with a fresh, private profile ───────────────────────
  log("step 1: launch the test app with a clean, first-launch data folder");
  app = await launchApp({ runDir: join(evidenceDir, "run"), log });
  const { bridge } = app;

  // ── 2. Onboarding: reach the privacy step without touching analytics ──
  log("step 2: walk onboarding up to the privacy step, leaving the analytics checkbox alone");
  await bridge.waitFor("the welcome dialog", `return !!e2e.first(".onboarding-dialog");`);
  await bridge.screenshot(join(evidenceDir, "01-welcome.png"));
  await bridge.click(".onboarding-actions .onboarding-btn-primary"); // welcome -> theme
  await sleep(150);
  await bridge.click(".onboarding-actions .onboarding-btn-primary"); // theme -> ai_setup
  await sleep(150);
  await bridge.click(".onboarding-actions .onboarding-btn-primary"); // ai_setup -> privacy
  await bridge.waitFor("the privacy screen", `return e2e.all(".onboarding-privacy-checkbox input").length === 2;`);

  const privacyDefaults = await bridge.eval(`
    const [analytics, policy] = e2e.all(".onboarding-privacy-checkbox input");
    return { analyticsChecked: analytics.checked, policyChecked: policy.checked };
  `);
  assert(privacyDefaults.analyticsChecked === false, "analytics checkbox starts UNCHECKED on a fresh profile");
  await bridge.screenshot(join(evidenceDir, "02-privacy-step-default.png"));

  // Accept the policy (required to enable Finish) — analytics checkbox is
  // deliberately left untouched, exactly like a user who just clicks through.
  await bridge.clickWhenReady(`
    const [, policy] = e2e.all(".onboarding-privacy-checkbox input");
    return e2e.click(policy);
  `);
  await bridge.waitFor("the Finish button to become enabled", `
    const b = e2e.first(".onboarding-actions .onboarding-btn-primary");
    return !!b && !b.disabled;
  `);
  await bridge.click(".onboarding-actions .onboarding-btn-primary"); // Finish
  await bridge.waitFor("the onboarding dialog to close", `return !e2e.first(".onboarding-backdrop");`);
  await sleep(300);
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }

  // ── 3. Acceptance criterion: fresh profile -> telemetry_enabled=false ──
  log("step 3: read persisted settings straight from the database via get_settings");
  const settingsAfterOnboarding = await rawInvoke(bridge, "get_settings");
  assert(settingsAfterOnboarding.ok, `get_settings resolved: ${JSON.stringify(settingsAfterOnboarding)}`);
  assert(
    settingsAfterOnboarding.value.telemetry_enabled === "false",
    `telemetry_enabled is persisted as "false" (got ${JSON.stringify(settingsAfterOnboarding.value.telemetry_enabled)})`,
  );

  // ── 4. No Aptabase network client exists while telemetry is off ───────
  log("step 4: invoke the Aptabase plugin's own command directly — it must not exist");
  const trackWhileOff = await rawInvoke(bridge, "plugin:aptabase|track_event", { name: "e2e-probe", props: null });
  assert(
    trackWhileOff.ok === false,
    `plugin:aptabase|track_event is rejected (${trackWhileOff.error}) — the plugin, and the reqwest ` +
      `client its setup() would build, was never registered`,
  );

  // ── 5. The env switch beats a fixture profile's own opt-in ────────────
  log("step 5: flip telemetry_enabled=true at runtime — the plugin still isn't there (HERMES_E2E=1 wins)");
  const setTrue = await rawInvoke(bridge, "set_setting", { key: "telemetry_enabled", value: "true" });
  assert(setTrue.ok, "set_setting(telemetry_enabled, true) resolved");
  const trackAfterOptIn = await rawInvoke(bridge, "plugin:aptabase|track_event", { name: "e2e-probe", props: null });
  assert(
    trackAfterOptIn.ok === false,
    `still rejected after opting in (${trackAfterOptIn.error}) — plugin registration is fixed at process ` +
      `start, so an e2e/CI run can never end up sending analytics`,
  );
  // Restore, so the rest of this run behaves like a normal off profile.
  await rawInvoke(bridge, "set_setting", { key: "telemetry_enabled", value: "false" });

  // ── 6. "Delete session data" is wired end-to-end ───────────────────────
  log("step 6: create a plain terminal session, then call delete_session_data on it");
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
      const b = e2e.must(
        e2e.first(".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary"),
        "the wizard's primary button",
      );
      return e2e.click(b);
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

  const deleteResult = await rawInvoke(bridge, "delete_session_data", { sessionId });
  assert(deleteResult.ok, `delete_session_data resolved for a real session: ${JSON.stringify(deleteResult)}`);
  // The session itself must still be there — this clears caches, not the session.
  assert(
    (await bridge.terminalIds()).includes(sessionId),
    "the session is still open after deleting its cached data",
  );
  await bridge.screenshot(join(evidenceDir, "03-after-delete-session-data.png"));
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
    log("step 7: quit the app");
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
    if (!failed && (exit.forced || exit.code !== 0)) {
      failed = true;
      log("FAILED: the app did not quit cleanly");
    }
  }
}

log(failed ? "RESULT: FAIL" : "RESULT: PASS");
process.exit(failed ? 1 : 0);
