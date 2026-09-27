#!/usr/bin/env node
// Scenario: F04 — private by default.
//
// Proves, against the REAL compiled app, with a local HTTP server standing in
// for the analytics service (HERMES_E2E_ANALYTICS_HOST, test builds only):
//   1. A fresh profile that clicks through onboarding without touching the
//      analytics checkbox (which starts unchecked) ends up with
//      telemetry_enabled=false.
//   2. With analytics off, the analytics plugin does not exist in the app and
//      nothing reaches the analytics server, even while the user creates a
//      session (an event the app would track).
//   3. Turning analytics on in Settings > Privacy takes effect right away:
//      the next session the user creates reaches the analytics server.
//   4. Turning it off again stops it right away.
//   5. "Delete session data" removes Hermes's caches for the chosen session
//      (context pins, the context file, the agent-mode state folder) and
//      leaves the session, another session's caches and a repository folder
//      alone. A path-like session id is refused.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F04-private-by-default.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/F04-private-by-default.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { platform } from "node:os";
import { join } from "node:path";
import { createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "F04-private-by-default";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

// ── A local stand-in for the analytics service ──────────────────────
const received = []; // every event the app posted, in order
const sink = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    try {
      const events = JSON.parse(body);
      for (const ev of Array.isArray(events) ? events : [events]) {
        received.push({ path: req.url, eventName: ev?.eventName });
      }
    } catch {
      received.push({ path: req.url, eventName: "(unparsable body)" });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});
await new Promise((resolve) => sink.listen(0, "127.0.0.1", resolve));
const sinkHost = `http://127.0.0.1:${sink.address().port}`;
const eventNames = () => received.map((e) => e.eventName);

/** Invokes a Tauri command from inside the app's webview. Returns
 *  { ok, value } or { ok: false, error } instead of throwing. */
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

/** Creates a plain terminal session through the New Session wizard, the way
 *  a person would, and returns its id. */
async function createPlainSession(bridge) {
  const before = await bridge.terminalIds();
  if (await bridge.exists("button.es-tile-primary")) {
    await bridge.click("button.es-tile-primary");
  } else {
    await bridge.clickWhenReady(`
      const btn = e2e.all(".activity-bar-action").find((b) =>
        e2e.norm(b.querySelector(".activity-bar-label")?.textContent).toLowerCase().startsWith("new session"));
      return e2e.click(e2e.must(btn, "the New session button"));
    `);
  }
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
  return bridge.waitFor(
    "a new terminal to appear",
    `const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
     return ids.length === 1 ? ids[0] : null;`,
    { timeoutMs: 20_000 },
  );
}

/** Opens Settings > Privacy from the activity bar, sets the analytics
 *  checkbox to `on` with a real click, and closes Settings again. */
async function setAnalyticsInSettings(bridge, on, shot) {
  await bridge.clickWhenReady(`
    const btn = e2e.all(".activity-bar-action").find((b) =>
      e2e.norm(b.querySelector(".activity-bar-label")?.textContent).toLowerCase() === "settings");
    return e2e.click(e2e.must(btn, "the Settings button"));
  `);
  await bridge.waitFor("the Settings panel", `return !!e2e.first(".settings-panel");`);
  await bridge.clickByName("Privacy", { within: ".settings-tabs" });
  await bridge.waitFor("the Privacy tab", `
    return e2e.all(".settings-content label").some((l) => /usage analytics/i.test(l.innerText));
  `);
  const before = await bridge.eval(`
    const label = e2e.all(".settings-content label").find((l) => /usage analytics/i.test(l.innerText));
    return label.querySelector("input[type=checkbox]").checked;
  `);
  if (before !== on) {
    await bridge.clickWhenReady(`
      const label = e2e.all(".settings-content label").find((l) => /usage analytics/i.test(l.innerText));
      return e2e.click(e2e.must(label.querySelector("input[type=checkbox]"), "the analytics checkbox"));
    `);
  }
  await bridge.waitFor(`the analytics checkbox to be ${on ? "checked" : "unchecked"}`, `
    const label = e2e.all(".settings-content label").find((l) => /usage analytics/i.test(l.innerText));
    return label.querySelector("input[type=checkbox]").checked === ${on};
  `);
  if (shot) await bridge.screenshot(shot);
  await bridge.click(".settings-close");
  await bridge.waitFor("the Settings panel to close", `return !e2e.first(".settings-panel");`);
}

let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   analytics stand-in: ${sinkHost}`);

  // ── 1. Launch with a fresh profile ────────────────────────────────
  log("step 1: launch the test app with a clean, first-launch data folder");
  app = await launchApp({
    runDir: join(evidenceDir, "run"),
    log,
    env: { HERMES_E2E_ANALYTICS_HOST: sinkHost },
  });
  const { bridge } = app;

  // ── 2. Onboarding: leave the analytics checkbox alone ─────────────
  log("step 2: walk onboarding to the privacy step and finish without touching analytics");
  await bridge.waitFor("the welcome dialog", `return !!e2e.first(".onboarding-dialog");`);
  await bridge.screenshot(join(evidenceDir, "01-welcome.png"));
  for (let i = 0; i < 3; i++) {
    await bridge.click(".onboarding-actions .onboarding-btn-primary"); // welcome -> theme -> ai_setup -> privacy
    await sleep(150);
  }
  await bridge.waitFor("the privacy screen", `return e2e.all(".onboarding-privacy-checkbox input").length === 2;`);
  const analyticsChecked = await bridge.eval(`return e2e.all(".onboarding-privacy-checkbox input")[0].checked;`);
  assert(analyticsChecked === false, "the analytics checkbox starts unchecked on a fresh profile");
  await bridge.screenshot(join(evidenceDir, "02-privacy-step-default.png"));
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

  const settings = await rawInvoke(bridge, "get_settings");
  assert(settings.ok, "get_settings resolved");
  assert(
    settings.value.telemetry_enabled === "false",
    `telemetry_enabled is stored as "false" (got ${JSON.stringify(settings.value.telemetry_enabled)})`,
  );

  // ── 3. Analytics off: no plugin, nothing sent ─────────────────────
  log("step 3: with analytics off, create a session and watch the analytics stand-in");
  const probe = await rawInvoke(bridge, "plugin:aptabase|track_event", { name: "e2e-probe", props: null });
  assert(probe.ok === false, `the analytics plugin is not registered (${probe.error})`);
  const sessionA = await createPlainSession(bridge);
  log(`  session A: ${sessionA}`);
  await sleep(2500); // several flush intervals of the analytics client
  assert(received.length === 0, `nothing reached the analytics stand-in while off (${JSON.stringify(eventNames())})`);

  // ── 4. Opt in from Settings > Privacy: takes effect right away ────
  log("step 4: turn analytics on in Settings > Privacy, then create a session");
  await setAnalyticsInSettings(bridge, true, join(evidenceDir, "03-settings-privacy-on.png"));
  const stored = await rawInvoke(bridge, "get_settings");
  assert(
    stored.ok && stored.value.telemetry_enabled === "true",
    `telemetry_enabled is stored as "true" (got ${JSON.stringify(stored.value?.telemetry_enabled)})`,
  );
  const sessionB = await createPlainSession(bridge);
  log(`  session B: ${sessionB}`);
  const deadline = Date.now() + 15_000;
  while (!eventNames().includes("session_created") && Date.now() < deadline) await sleep(200);
  assert(
    eventNames().includes("session_created"),
    `opting in took effect without a restart: the stand-in received ${JSON.stringify(eventNames())}`,
  );
  assert(
    received.every((e) => e.path === "/api/v0/events"),
    "every request went to the analytics events endpoint of the stand-in",
  );

  // ── 5. Opt out again: stops right away ────────────────────────────
  log("step 5: turn analytics off again, then create a session");
  await setAnalyticsInSettings(bridge, false, join(evidenceDir, "04-settings-privacy-off.png"));
  await sleep(1500); // let anything tracked before the switch flush
  const countBefore = received.length;
  const sessionC = await createPlainSession(bridge);
  log(`  session C: ${sessionC}`);
  await sleep(2500);
  assert(
    received.length === countBefore,
    `nothing more reached the stand-in after opting out (${received.length - countBefore} new events)`,
  );

  // ── 6. Delete session data ────────────────────────────────────────
  log("step 6: seed caches for sessions A and B, then delete session data for A");
  for (const sid of [sessionA, sessionB]) {
    const pin = await rawInvoke(bridge, "add_context_pin", {
      sessionId: sid,
      projectId: null,
      kind: "file",
      target: `notes-${sid.slice(0, 8)}.md`,
      label: null,
      priority: null,
    });
    assert(pin.ok, `pinned a file to session ${sid.slice(0, 8)}`);
  }
  const applied = await rawInvoke(bridge, "apply_context", { sessionId: sessionA, executionMode: null });
  assert(applied.ok && existsSync(applied.value.file_path), `session A's context file exists: ${applied.ok}`);
  const contextFileA = applied.value.file_path;

  // Agent-mode sessions keep a state folder in the app's home. A plain shell
  // session has none, so write the same shape a Claude session would.
  const appHome = platform() === "win32" ? process.env.HOME : join(app.tmpDir, "home");
  const stateRoot = appHome ? join(appHome, ".hermes-ide", "sessions") : null;
  if (stateRoot) {
    for (const sid of [sessionA, sessionB]) {
      mkdirSync(join(stateRoot, sid), { recursive: true });
      writeFileSync(join(stateRoot, sid, "state.json"), JSON.stringify({ cwd: "/tmp", attachedPaths: [] }));
    }
  } else {
    log("  (no HOME for the app on this runner: agent-mode state folder not checked)");
  }
  // A repository folder the session could be working in.
  const repo = join(app.tmpDir, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "hello\n");

  const pinsBefore = await rawInvoke(bridge, "get_context_pins", { sessionId: sessionA, projectId: null });
  assert(pinsBefore.ok && pinsBefore.value.length === 1, "session A has one pin before the delete");

  const refused = await rawInvoke(bridge, "delete_session_data", { sessionId: "../escape" });
  assert(refused.ok === false, `a path-like session id is refused (${refused.error})`);

  const del = await rawInvoke(bridge, "delete_session_data", { sessionId: sessionA });
  assert(del.ok, `delete_session_data resolved: ${JSON.stringify(del)}`);

  const pinsA = await rawInvoke(bridge, "get_context_pins", { sessionId: sessionA, projectId: null });
  assert(pinsA.ok && pinsA.value.length === 0, "session A's pins are gone");
  assert(!existsSync(contextFileA), "session A's context file is gone");
  if (stateRoot) assert(!existsSync(join(stateRoot, sessionA)), "session A's agent-mode state folder is gone");

  const pinsB = await rawInvoke(bridge, "get_context_pins", { sessionId: sessionB, projectId: null });
  assert(pinsB.ok && pinsB.value.length === 1, "session B's pin is untouched");
  if (stateRoot) assert(existsSync(join(stateRoot, sessionB, "state.json")), "session B's state folder is untouched");
  assert(existsSync(join(repo, "README.md")) && existsSync(join(repo, ".git")), "the repository folder is untouched");
  assert((await bridge.terminalIds()).includes(sessionA), "session A is still open");
  await bridge.screenshot(join(evidenceDir, "05-after-delete-session-data.png"));

  if (stateRoot) rmSync(join(stateRoot, sessionB), { recursive: true, force: true });
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
  sink.close();
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log, details: { analyticsEvents: eventNames() } });
