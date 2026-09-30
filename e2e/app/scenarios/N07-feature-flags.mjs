#!/usr/bin/env node
// Scenario: N07 — feature flags.
//
// Proves, on the REAL app, that the feature-flag mechanism actually gates a
// visible surface. The surface is a real flagged feature: the Custom agent
// card in the New Session agent step, shown only when the "agentCatalog"
// flag is on (see src/featureFlags/ and src/catalog/agentCatalog.ts).
//
// Since 2.0 every flag is on by default on the stable channel too; the
// hidden Settings > Flags section is the kill switch.
//
//   run 1  fresh install, stable channel, no override  -> card present
//          force the flag off in the hidden Settings > Flags section
//   run 2  relaunch                                    -> card absent
//          put the flag back to "Default for channel"; quit; switch this
//          install to the beta update channel (update_channel = beta)
//   run 3  relaunch, beta channel, no override          -> card present
//          force the flag off
//   run 4  relaunch, beta channel, forced off           -> card absent
//
// Flags are read once at startup, so every change is checked after a
// relaunch against the same data, and also checked NOT to apply in the
// session where it was made.
//
// The beta channel is the `update_channel` setting the updater reads. Until
// the Settings control for it ships, this scenario writes that setting into
// the app's database while the app is closed, exactly as the control would
// store it.
//
// Negative control: HERMES_E2E_N07_EXPECT_CARD_ID=<some other id> must end
// in RESULT: FAIL (the card check is real).
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N07-feature-flags.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/N07-feature-flags.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "N07-feature-flags";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

const FLAG_ID = "agentCatalog";
/** The card the flag gates. Overridable so the check can be shown to fail. */
const CARD_ID = process.env.HERMES_E2E_N07_EXPECT_CARD_ID || "custom";
const DB_FILE = "hermes_idea_v3.db";

// Windows keeps app data under %APPDATA%, which a private HOME does not
// move, so there the harness uses the real home and the test app's own data
// folder; relaunches then keep that folder instead of wiping it.
const onWindows = platform() === "win32";
const homeDir = onWindows ? undefined : mkdtempSync(join(tmpdir(), "hermes-e2e-n07-home-"));

function launch(run, { first = false } = {}) {
  const runDir = join(evidenceDir, `run-${run}`);
  return onWindows
    ? launchApp({ runDir, log, home: "real", resetData: first })
    : launchApp({ runDir, log, home: "private", homeDir });
}

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
  await dismissWhatsNew(bridge);
}

async function dismissWhatsNew(bridge) {
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
}

/** A relaunch with existing data: no onboarding, main UI up. */
async function waitForReturningLaunch(bridge) {
  await bridge.waitFor("the app UI to be ready (no onboarding this time)", `
    return !!e2e.first(".topbar-title, .topbar") && !e2e.first(".onboarding-backdrop");
  `);
  await dismissWhatsNew(bridge);
  assert(!(await bridge.exists(".onboarding-backdrop")), "onboarding is not shown again (same persisted data)");
}

/** Opens the New Session wizard in terminal mode and waits for the agent step. */
async function openAgentStep(bridge) {
  if (await bridge.exists("button.es-tile-primary")) await bridge.click("button.es-tile-primary");
  else await bridge.clickByName("New session");
  // With the task launcher on (every flag is on for beta), New Session opens
  // the launcher; its Advanced link opens the full creator.
  await bridge.waitFor("the New Session wizard or the task launcher", `return !!e2e.first(".session-creator, .task-launcher-sheet");`, { timeoutMs: 20_000 });
  if (await bridge.exists(".task-launcher-sheet")) await bridge.click(".task-launcher-advanced");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  // Terminal is the default for every agent (N09); an older wizard started
  // with a mode step, where terminal has to be picked first.
  if (await bridge.exists(".session-creator-mode-step")) {
    await bridge.click('.session-creator-mode-card[data-category="universal"]');
    await bridge.waitFor("terminal mode to be selected", `
      return e2e.first('.session-creator-mode-card[data-category="universal"]')?.getAttribute("aria-checked") === "true";
    `);
    await bridge.click(".session-creator-actions .session-creator-btn-primary");
  }
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`, { timeoutMs: 20_000 });
}

async function closeWizard(bridge) {
  await bridge.click(".session-creator .session-creator-close");
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`);
}

const cardIds = (bridge) =>
  bridge.eval(`return e2e.all(".session-creator-provider-card").map((c) => c.getAttribute("data-agent-id"));`);

/**
 * The flagged surface must stay in its state for a while, not just at one
 * instant: the agent step is read five times over a second.
 */
async function assertSurfaceStays(bridge, shown, message, shot) {
  await openAgentStep(bridge);
  let ids = [];
  for (let i = 0; i < 5; i++) {
    ids = await cardIds(bridge);
    if (ids.includes(CARD_ID) !== shown) {
      throw new Error(`ASSERTION FAILED: ${message} (cards after ${i * 200}ms: ${JSON.stringify(ids)})`);
    }
    await sleep(200);
  }
  log(`  ok — ${message}   (agent cards: ${JSON.stringify(ids)})`);
  if (shot) await bridge.screenshot(join(evidenceDir, shot));
  await closeWizard(bridge);
}

/**
 * Opens Settings, unlocks the hidden "Flags" tab (7 clicks on the panel
 * title, the real gesture — see Settings.tsx handleTitleClick), sets the
 * agentCatalog override ("default" | "on" | "off"), waits for it to land
 * in the app's settings, then closes Settings.
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
  const selector = `select[data-flag-id="${FLAG_ID}"]`;
  await bridge.waitFor("the flag override select", `return !!e2e.first(${JSON.stringify(selector)});`);

  const result = await bridge.eval(`
    const sel = e2e.must(e2e.first(${JSON.stringify(selector)}), "flag override select");
    const label = e2e.norm(sel.closest(".settings-group")?.querySelector(".settings-label")?.innerText);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
    setter.call(sel, ${JSON.stringify(value)});
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return { value: sel.value, label };
  `);
  assert(result.value === value, `flag "${result.label}" override select now shows "${value}"`);

  const expected = value === "default" ? "undefined" : value === "on" ? "true" : "false";
  // updateSetting fires the write without awaiting it: wait until it lands.
  await bridge.waitFor("the override to be saved", `
    const raw = await window.__TAURI_INTERNALS__.invoke("get_settings");
    const overrides = raw.feature_flag_overrides ? JSON.parse(raw.feature_flag_overrides) : {};
    return overrides[${JSON.stringify(FLAG_ID)}] === ${expected};
  `);

  await bridge.click(".settings-close");
  await bridge.waitFor("the Settings dialog to close", `return !e2e.first(".settings-title");`);
}

/** Quit and require a clean exit (so the database is closed and flushed). */
async function quit(current) {
  const exit = await current.stop();
  log(`  app exited: ${JSON.stringify(exit)}`);
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");
}

/** Store update_channel in the closed app's database, as the Settings control would. */
function setUpdateChannel(dataDir, channel) {
  const file = join(dataDir, DB_FILE);
  assert(existsSync(file), `the app database exists (${DB_FILE})`);
  const db = new DatabaseSync(file);
  try {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('update_channel', ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    ).run(channel);
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'update_channel'`).get();
    assert(row?.value === channel, `update_channel = ${channel} is stored`);
  } finally {
    db.close();
  }
}

let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   flag: ${FLAG_ID}   card: ${CARD_ID}`);

  // ── run 1: fresh install, stable, no override -> ON (2.0) ─────────
  log("step 1: fresh launch — stable channel, no override: the flagged card is offered (on by default since 2.0)");
  app = await launch(1, { first: true });
  await completeOnboarding(app.bridge);
  assert((await app.bridge.eval(`return e2e.all(".session-item").length;`)) === 0, "a fresh install (no sessions)");
  await assertSurfaceStays(app.bridge, true, "the flagged card IS offered on a fresh stable install", "01-stable-default.png");

  log("step 2: force the flag OFF in the hidden Settings > Flags section (the kill switch)");
  await setFlagOverride(app.bridge, "off");
  await assertSurfaceStays(app.bridge, true, "still offered in this session (flags are read once, at startup)");
  await quit(app);

  // ── run 2: stable, forced off -> OFF ─────────────────────────────
  log("step 3: relaunch — the forced-off override takes effect");
  app = await launch(2);
  await waitForReturningLaunch(app.bridge);
  await assertSurfaceStays(app.bridge, false, "the flagged card is NOT offered with the override forced off", "02-stable-forced-off.png");

  log("step 4: clear the override (Default for channel), quit, switch this install to the beta channel");
  await setFlagOverride(app.bridge, "default");
  await quit(app);
  setUpdateChannel(app.dataDir, "beta");

  // ── run 3: beta, no override -> ON ───────────────────────────────
  log("step 5: relaunch on the beta channel with no override — the card is offered");
  app = await launch(3);
  await waitForReturningLaunch(app.bridge);
  const stored = await app.bridge.eval(`
    const raw = await window.__TAURI_INTERNALS__.invoke("get_settings");
    return { channel: raw.update_channel ?? null, overrides: raw.feature_flag_overrides ?? null };
  `);
  log(`  settings seen by the app: ${JSON.stringify(stored)}`);
  assert(stored.channel === "beta", "the app sees update_channel = beta");
  assert(!stored.overrides || !(FLAG_ID in JSON.parse(stored.overrides)), "no override is set");
  await assertSurfaceStays(app.bridge, true, "the flagged card IS offered on beta with no override", "03-beta-default.png");

  log("step 6: force the flag OFF");
  await setFlagOverride(app.bridge, "off");
  await assertSurfaceStays(app.bridge, true, "still offered in this session (flags are read once, at startup)");
  await quit(app);

  // ── run 4: beta, forced off -> OFF ───────────────────────────────
  log("step 7: relaunch — turning the flag off hides the feature on next launch");
  app = await launch(4);
  await waitForReturningLaunch(app.bridge);
  await sleep(500);
  await assertSurfaceStays(app.bridge, false, "the flagged card is hidden on beta after forcing the flag off and relaunching", "04-beta-forced-off.png");
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
  if (app?.isRunning()) {
    log("step 8: quit the app");
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
