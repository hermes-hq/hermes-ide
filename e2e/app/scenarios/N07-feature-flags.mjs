#!/usr/bin/env node
// Scenario: N07 — feature flags.
//
// Proves, on the REAL app, that the feature-flag mechanism actually gates a
// visible surface (the "FLAG" badge in the top bar, gated on the
// "dummyProofSurface" flag — see src/featureFlags/ and
// src/components/FeatureFlagDummyBanner.tsx):
//
//   1. Fresh install, stable channel, no override -> badge is OFF.
//   2. Force the flag on from the hidden Settings > Flags section, relaunch
//      -> badge is ON (flags are read once at startup, on purpose).
//   3. Force the flag off again, relaunch -> badge is OFF again.
//
// This proves both acceptance criteria end to end using the real override
// path a beta build would also use (the code has no separate "beta" branch
// to click through in this rig — see channelFromVersion, unit-tested in
// src/__tests__/feature-flags.test.ts for the stable/beta split itself).
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N07-feature-flags.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/N07-feature-flags.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, launchApp, outDir, sleep } from "../harness.mjs";

const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", "N07-feature-flags");
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

const BADGE = ".topbar-flag-badge";

/** First-launch welcome flow, same steps as the terminal-echo scenario. */
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
  }
}

/**
 * Opens Settings, unlocks the hidden "Flags" tab (7 clicks on the panel
 * title, like the real gesture — see Settings.tsx handleTitleClick), sets
 * the dummyProofSurface override, waits for it to actually land on disk,
 * then closes Settings. The unlock does not persist across a Settings
 * re-open by design, so this runs in full every time Settings is opened.
 */
async function setFlagOverride(bridge, value) {
  await bridge.clickByName("Settings");
  await bridge.waitFor("the Settings dialog", `return !!e2e.first('[role="dialog"] .settings-title');`);

  await bridge.eval(`
    const title = e2e.must(e2e.first(".settings-title"), "settings title");
    for (let i = 0; i < 7; i++) e2e.click(title);
    return { clicked: 7 };
  `);
  await bridge.waitFor("the hidden Flags tab to appear", `
    return e2e.all(".settings-tab").some((el) => e2e.norm(el.innerText) === "Flags");
  `);
  await bridge.eval(`
    const tab = e2e.all(".settings-tab").find((el) => e2e.norm(el.innerText) === "Flags");
    return e2e.click(e2e.must(tab, "Flags tab"));
  `);
  await bridge.waitFor("the flag override select", `return !!e2e.first("select.settings-select");`);

  const result = await bridge.eval(`
    const sel = e2e.must(e2e.first("select.settings-select"), "flag override select");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
    setter.call(sel, ${JSON.stringify(value)});
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return { value: sel.value };
  `);
  assert(result.value === value, `flag override select now shows "${value}"`);

  // Wait for the write to actually reach the settings table (updateSetting
  // fires the invoke without awaiting it) before we quit the app.
  await bridge.waitFor("the override to persist to disk", `
    const raw = await window.__TAURI_INTERNALS__.invoke("get_settings");
    const overrides = raw.feature_flag_overrides ? JSON.parse(raw.feature_flag_overrides) : {};
    return overrides.dummyProofSurface === ${value === "on" ? "true" : "false"};
  `);

  await bridge.click(".settings-close");
  await bridge.waitFor("the Settings dialog to close", `return !e2e.first(".settings-title");`);
}

const homeDir = mkdtempSync(join(tmpdir(), "hermes-e2e-n07-home-"));
let app;
let failed = false;

try {
  // ── 1. Fresh launch: stable channel, no override -> flag off ─────
  log("step 1: fresh launch — stable channel, no override, flag should be OFF");
  app = await launchApp({ runDir: join(evidenceDir, "run-1"), log, home: "private", homeDir });
  await completeOnboarding(app.bridge);
  assert((await app.bridge.eval(`return e2e.all(".session-item").length;`)) === 0, "session list starts empty");
  assert(!(await app.bridge.exists(BADGE)), "the flag badge is NOT shown on a fresh stable install");
  await app.bridge.screenshot(join(evidenceDir, "01-stable-no-override.png"));

  // ── 2. Force the flag on, relaunch -> flag should be ON ──────────
  log("step 2: force the flag ON via the hidden Settings > Flags section");
  await setFlagOverride(app.bridge, "on");
  assert(!(await app.bridge.exists(BADGE)), "the badge is still OFF in the same session (flags read once, at startup)");
  const exit1 = await app.stop();
  log(`  app exited: ${JSON.stringify(exit1)}`);
  assert(!exit1.forced && exit1.code === 0, "the app quit cleanly");

  log("step 3: relaunch with the same data — the override should now take effect");
  app = await launchApp({ runDir: join(evidenceDir, "run-2"), log, home: "private", homeDir });
  await app.bridge.waitFor("the app UI to be ready (no onboarding this time)", `
    return e2e.all(".session-item").length === 0 && !e2e.first(".onboarding-backdrop");
  `);
  assert(!(await app.bridge.exists(".onboarding-backdrop")), "onboarding is not shown again (same persisted data)");
  await app.bridge.waitFor("the flag badge to appear", `return !!e2e.first(${JSON.stringify(BADGE)});`);
  assert(await app.bridge.exists(BADGE), "the flag badge IS shown after relaunch with the override forced on");
  await app.bridge.screenshot(join(evidenceDir, "02-override-on.png"));

  // ── 4. Force the flag off, relaunch -> flag should be OFF again ──
  log("step 4: force the flag OFF via the hidden Settings > Flags section");
  await setFlagOverride(app.bridge, "off");
  assert(await app.bridge.exists(BADGE), "the badge is still ON in the same session (flags read once, at startup)");
  const exit2 = await app.stop();
  log(`  app exited: ${JSON.stringify(exit2)}`);
  assert(!exit2.forced && exit2.code === 0, "the app quit cleanly");

  log("step 5: relaunch with the same data — turning the flag off should hide it on next launch");
  app = await launchApp({ runDir: join(evidenceDir, "run-3"), log, home: "private", homeDir });
  await app.bridge.waitFor("the app UI to be ready", `return e2e.all(".session-item").length === 0;`);
  await sleep(300);
  assert(!(await app.bridge.exists(BADGE)), "the flag badge is hidden again after forcing it off and relaunching");
  await app.bridge.screenshot(join(evidenceDir, "03-override-off.png"));
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
        };
      `);
      log(`  what the app showed: ${JSON.stringify(dump)}`);
    }
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  if (app) {
    log("step 6: quit the app");
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
    if (!failed && (exit.forced || exit.code !== 0)) {
      failed = true;
      log("FAILED: the app did not quit cleanly");
    }
  }
  rmSync(homeDir, { recursive: true, force: true });
}

log(failed ? "RESULT: FAIL" : "RESULT: PASS");
process.exit(failed ? 1 : 0);
