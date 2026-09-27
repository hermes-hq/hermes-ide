#!/usr/bin/env node
// Scenario N05: a user switches the update channel in Settings.
//
// A fresh install checks the stable manifest. In Settings → General the user
// picks "Beta"; from then on the app checks the beta manifest, the choice is
// stored, and it is still selected after closing and reopening Settings.
// Switching back restores the stable manifest.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N05-update-channel.mjs

import { rmSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "N05-update-channel";
const startedAt = Date.now();

const STABLE_ENDPOINT = "https://github.com/hermes-hq/hermes-ide/releases/latest/download/latest.json";
const BETA_ENDPOINT = "https://raw.githubusercontent.com/hermes-hq/hermes-ide/channels/beta.json";

const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", "N05-update-channel");
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

/** Ask the app (through its own IPC, inside the webview) what the updater will read. */
const channelInfo = (bridge) => bridge.eval(`return await window.__TAURI_INTERNALS__.invoke("get_update_channel_info");`);
const storedChannel = (bridge) =>
  bridge.eval(`const s = await window.__TAURI_INTERNALS__.invoke("get_settings"); return s.update_channel ?? null;`);

async function finishOnboarding(bridge) {
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
  await bridge.waitFor("the Finish button", `const b = e2e.first(".onboarding-actions .onboarding-btn-primary"); return !!b && !b.disabled;`);
  await bridge.click(".onboarding-actions .onboarding-btn-primary");
  await bridge.waitFor("the welcome dialog to close", `return !e2e.first(".onboarding-backdrop");`);
  await sleep(300);
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
}

async function openSettings(bridge) {
  await bridge.clickByName("Settings");
  await bridge.waitFor("the Settings panel", `return !!e2e.first("#settings-update-channel");`);
}

/** Pick an option the way a person does: the select changes and fires change. */
async function pickChannel(bridge, value) {
  return bridge.eval(`
    const select = e2e.must(e2e.first("#settings-update-channel"), "update channel select");
    select.focus();
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return select.value;
  `);
}

let app;
let failed = false;
try {
  log(`scenario: N05-update-channel   platform: ${platform()}`);

  // ── 1. Fresh install: stable ─────────────────────────────────────
  log("step 1: launch with a first-launch data folder and finish onboarding");
  app = await launchApp({ runDir: join(evidenceDir, "run"), log, home: process.env.HERMES_E2E_HOME || undefined });
  const { bridge } = app;
  await finishOnboarding(bridge);
  const before = await channelInfo(bridge);
  log(`  updater before: ${JSON.stringify(before)}`);
  assert(before.channel === "stable", "a fresh install is on the stable channel");
  assert(before.endpoint === STABLE_ENDPOINT, `stable reads the latest-release manifest (${before.endpoint})`);
  assert(before.disabled === false, "update checks are on for a normal launch");
  assert((await storedChannel(bridge)) === null, "nothing is stored until the user chooses");

  // ── 2. Switch to beta in Settings ────────────────────────────────
  log("step 2: open Settings and pick the beta channel");
  await openSettings(bridge);
  const shown = await bridge.eval(`return e2e.first("#settings-update-channel").value;`);
  assert(shown === "stable", "the Update channel control shows Stable");
  await bridge.screenshot(join(evidenceDir, "01-settings-stable.png"));

  const picked = await pickChannel(bridge, "beta");
  assert(picked === "beta", "the control now shows Beta");
  await bridge.waitFor("the choice to be stored", `
    const s = await window.__TAURI_INTERNALS__.invoke("get_settings");
    return s.update_channel === "beta";
  `);
  assert((await storedChannel(bridge)) === "beta", "update_channel = beta is stored in the app database");
  const afterBeta = await channelInfo(bridge);
  log(`  updater after: ${JSON.stringify(afterBeta)}`);
  assert(afterBeta.channel === "beta", "the updater is on the beta channel");
  assert(afterBeta.endpoint === BETA_ENDPOINT, `beta reads channels/beta.json (${afterBeta.endpoint})`);
  await sleep(200);
  await bridge.screenshot(join(evidenceDir, "02-settings-beta.png"));

  // ── 3. Close and reopen Settings: still beta ─────────────────────
  log("step 3: close Settings, reopen it, the choice is still Beta");
  await bridge.click(".settings-close");
  await bridge.waitFor("Settings to close", `return !e2e.first(".settings-panel");`);
  await openSettings(bridge);
  const reopened = await bridge.waitFor("the control to load the stored value", `
    const v = e2e.first("#settings-update-channel").value; return v === "beta" ? v : null;
  `);
  assert(reopened === "beta", "reopened Settings shows Beta");

  // ── 4. Back to stable ────────────────────────────────────────────
  log("step 4: switch back to stable");
  assert((await pickChannel(bridge, "stable")) === "stable", "the control shows Stable again");
  await bridge.waitFor("the choice to be stored", `
    const s = await window.__TAURI_INTERNALS__.invoke("get_settings");
    return s.update_channel === "stable";
  `);
  const afterStable = await channelInfo(bridge);
  assert(afterStable.channel === "stable" && afterStable.endpoint === STABLE_ENDPOINT, "the updater reads the stable manifest again");
  await bridge.screenshot(join(evidenceDir, "03-settings-back-to-stable.png"));
  await bridge.click(".settings-close");
  await bridge.waitFor("Settings to close", `return !e2e.first(".settings-panel");`);
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
    log(`  app exited: ${JSON.stringify(exit)}`);
    if (!failed && (exit.forced || exit.code !== 0)) {
      failed = true;
      log("FAILED: the app did not quit cleanly");
    }
  }
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
