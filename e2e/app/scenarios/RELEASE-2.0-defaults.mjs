#!/usr/bin/env node
// Scenario: RELEASE-2.0-defaults — a fresh install on the stable channel
// gets the 2.0 experience with nothing switched on by hand.
//
// The test app starts with a fresh profile (a private home on macOS and
// Linux, a wiped data folder on Windows), on the stable channel (no
// update_channel setting, a version with no -beta tag) and with no flag
// override. Then:
//
//   1. the welcome is the three-step one (agents, repo, first task), which
//      asks for the Privacy Policy first;
//   2. every feature flag in src/featureFlags/registry.ts is on, with no
//      override, except sessionHost on Windows (off there: not ready yet);
//   3. what that looks like: the attention inbox badge in the title bar, New
//      Session opening the task launcher, whose Advanced link opens the full
//      creator on the agent step (terminal first, no mode step) with the
//      agents new in 2.0 and the Custom agent, and a terminal session's row
//      carrying its status (glyph + word, marked guessed);
//   4. a terminal session lives in the background session host on macOS and
//      Linux (not on Windows).
//
// The harness normally starts the test app with the task launcher off (most
// scenarios drive the classic welcome and wizard); this one starts it with
// the real defaults (flagDefaults: null).
//
// Negative control: HERMES_E2E_RELEASE_FLAG_OFF=<flag id> switches that flag
// off before the check (the kill switch), so the run must end in
// RESULT: FAIL.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/RELEASE-2.0-defaults.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/RELEASE-2.0-defaults.

import { mkdtempSync } from "node:fs";
import { readFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, launchApp, sleep } from "../harness.mjs";
import { dismissWhatsNew, finishWizard, runScenario } from "../n11-steps.mjs";
import { setFlagOverrides } from "../fleet-steps.mjs";

const SCENARIO = "RELEASE-2.0-defaults";
const FLAG_OFF = process.env.HERMES_E2E_RELEASE_FLAG_OFF || "";
const onWindows = platform() === "win32";

/** The flag ids the registry declares, read from the source the app is built from. */
function registryFlagIds() {
  const text = readFileSync(join(REPO_ROOT, "src", "featureFlags", "registry.ts"), "utf8");
  const list = text.slice(text.indexOf("export const FEATURE_FLAGS"));
  return [...list.matchAll(/^\s+id: "([A-Za-z0-9]+)",$/gm)].map((m) => m[1]);
}

/** New Session: the task launcher; its Advanced link opens the full creator. */
async function openCreator(bridge, assert) {
  if (await bridge.exists("button.es-tile-primary")) await bridge.click("button.es-tile-primary");
  else await bridge.click(".activity-bar-left > .activity-bar-action");
  await bridge.waitFor("the task launcher", `return !!e2e.first(".task-launcher-sheet, .session-creator");`, { timeoutMs: 20_000 });
  assert(await bridge.exists(".task-launcher-sheet"), "New Session opens the task launcher");
  await bridge.click(".task-launcher-advanced");
  await bridge.waitFor("the full creator", `return !!e2e.first(".session-creator") && e2e.all(".session-creator-provider-card").length > 0;`, { timeoutMs: 20_000 });
}

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps }) => {
  const homeDir = onWindows ? undefined : mkdtempSync(join(tmpdir(), "hermes-e2e-release20-home-"));
  // The real defaults: no flag default from the harness.
  const launch = (run, { first = false } = {}) => {
    const runDir = join(evidenceDir, `run-${run}`);
    return onWindows
      ? launchApp({ runDir, log, home: "real", resetData: first, flagDefaults: null })
      : launchApp({ runDir, log, home: "private", homeDir, flagDefaults: null });
  };
  log(`scenario: ${SCENARIO}   platform: ${platform()}${FLAG_OFF ? `   NEGATIVE CONTROL (${FLAG_OFF} switched off)` : ""}`);

  let app = await launch(1, { first: true });
  apps.push(app);
  log("step 1: the three-step welcome, the Privacy Policy first");
  await app.bridge.waitFor("the first-launch welcome", `return !!e2e.first(".setup-dialog, .onboarding-dialog");`, { timeoutMs: 30_000 });
  assert(await app.bridge.exists(".setup-dialog"), "a fresh install gets the three-step welcome");
  assert(await app.bridge.eval(`return e2e.first("#setup-policy-accept")?.checked === false && e2e.first(".setup-continue").disabled;`), "it asks for the Privacy Policy before anything else");
  await app.bridge.screenshot(join(evidenceDir, "00-welcome.png"));
  await app.bridge.click("#setup-policy-accept");
  await app.bridge.waitFor("Continue", `return !e2e.first(".setup-continue").disabled;`);
  await app.bridge.click(".setup-continue");
  await app.bridge.waitFor("screen 2", `return e2e.first(".setup-dialog")?.getAttribute("data-step") === "repo";`);
  await app.bridge.click(".setup-skip");
  await app.bridge.waitFor("screen 3", `return e2e.first(".setup-dialog")?.getAttribute("data-step") === "task";`);
  await app.bridge.click(".setup-finish");
  await app.bridge.waitFor("the welcome to close", `return !e2e.first(".setup-backdrop");`);
  await dismissWhatsNew(app.bridge, log);
  if (FLAG_OFF) {
    await setFlagOverrides(app.bridge, { [FLAG_OFF]: false });
    const exit = await app.stop();
    assert(!exit.forced && exit.code === 0, "the app quit cleanly");
    app = await launch(2);
    apps.push(app);
    await app.bridge.waitFor("the app UI (no onboarding this time)", `return !!e2e.first(".topbar") && !e2e.first(".onboarding-backdrop");`);
    await dismissWhatsNew(app.bridge, log);
  }
  const { bridge } = app;

  log("step 2: every flag is on by default on the stable channel (sessionHost per platform)");
  const settings = await bridge.eval(`return await window.__TAURI_INTERNALS__.invoke("get_settings");`);
  assert(!settings.update_channel || settings.update_channel === "stable", `no beta update channel is set (${JSON.stringify(settings.update_channel ?? null)})`);
  const resolved = await bridge.eval(`return window.__HERMES_E2E__.featureFlags();`);
  log(`  flags as the app resolved them: ${JSON.stringify(resolved)}`);
  assert(resolved.channel === "stable", "the app runs on the stable channel");
  const ids = registryFlagIds();
  assert(ids.length > 0 && JSON.stringify(Object.keys(resolved.flags).sort()) === JSON.stringify([...ids].sort()), `the app knows exactly the registry's ${ids.length} flags (${ids.join(", ")})`);
  for (const id of ids) {
    const want = id === "sessionHost" ? !onWindows : true;
    const flag = resolved.flags[id];
    assert(flag.on === want, `${id} is ${want ? "on" : "off"} (${flag.on ? "on" : "off"})`);
    if (!FLAG_OFF) assert(flag.override === null, `${id} has no override: that is the default`);
  }

  log("step 3: what a new user sees");
  await bridge.waitFor("the attention inbox badge in the title bar", `return !!e2e.first(".topbar .attention-badge");`, { timeoutMs: 10_000 });
  log("  ok — the attention inbox badge is in the title bar");
  await openCreator(bridge, assert);
  const wizard = await bridge.eval(`
    return {
      modeStep: !!e2e.first(".session-creator-mode-step"),
      cards: e2e.all(".session-creator-provider-card").map((c) => c.getAttribute("data-agent-id")),
    };
  `);
  log(`  New Session wizard: ${JSON.stringify(wizard)}`);
  assert(!wizard.modeStep, "the wizard opens on the agent step: terminal first, no mode step");
  assert(wizard.cards.includes("custom"), "the Custom agent is offered");
  assert(wizard.cards.includes("antigravity") && wizard.cards.includes("opencode"), "the agents new in 2.0 are offered");
  await bridge.screenshot(join(evidenceDir, "01-new-session-wizard.png"));
  await bridge.click(".session-creator .settings-close");
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`);

  await openCreator(bridge, assert);
  await bridge.clickWhenReady(`
    const cards = e2e.all(".session-creator-provider-card");
    return e2e.click(e2e.must(cards.find((c) => c.getAttribute("data-agent-id") === "shell") ?? cards[cards.length - 1], "the plain shell card"));
  `);
  const before = await bridge.terminalIds();
  await finishWizard(bridge, log);
  const sid = await bridge.waitFor("the terminal", `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
    return ids.length === 1 ? ids[0] : null;
  `, { timeoutMs: 20_000 });
  await bridge.waitFor("the shell to print its prompt", `return (window.__HERMES_E2E__.readTerminal(${JSON.stringify(sid)}) || []).some((l) => l.trim().length > 0);`, { timeoutMs: 30_000 });
  const row = await bridge.waitFor("the session row's status", `
    const tag = e2e.first('.session-item[data-session-item-id=${JSON.stringify(sid)}] .agent-status-tag');
    return tag ? { status: tag.getAttribute("data-status"), confidence: tag.getAttribute("data-confidence"), word: e2e.norm(tag.innerText) } : null;
  `, { timeoutMs: 15_000 });
  assert(!!row.status && row.confidence === "guessed", `the terminal session's row shows its status ("${row.word}", ${row.confidence})`);

  log("step 4: the session host keeps terminals alive across a quit (macOS and Linux)");
  const data = await bridge.waitFor("the session's data", `
    const s = (await window.__TAURI_INTERNALS__.invoke("get_sessions")).find((x) => x.id === ${JSON.stringify(sid)});
    return s ?? null;
  `);
  assert(!!data.hosted === !onWindows, `the terminal ${data.hosted ? "lives in the background session host" : "is owned by the app"} (${onWindows ? "Windows: not yet" : "macOS and Linux"})`);
  await sleep(300);
  await bridge.screenshot(join(evidenceDir, "02-fresh-install-2.0.png"));
});
