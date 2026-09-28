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
//   5. "Delete Session Data..." in the session's right-click menu asks for
//      confirmation (cancel keeps everything), then removes Hermes's caches
//      for the chosen session (saved terminal scrollback, context pins, the
//      context file, the agent-mode state folder) and leaves the session,
//      another session's caches and a repository folder alone. A path-like
//      session id is refused by the backend.
//   6. A profile that opted in turns analytics on by itself on the next
//      launch.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F04-private-by-default.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/F04-private-by-default.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { platform, tmpdir } from "node:os";
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
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, {
    timeoutMs: 20_000,
  });
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

/** Stands in for the native popup (a script cannot click one) and for
 *  window.confirm. Test builds hand the menu to window.__HERMES_E2E_MENU__
 *  when it is set; it records the items and stays open until the scenario
 *  picks an item. The pick travels the same "menu-action" event the native
 *  menu emits, so the app's own handler runs. */
async function installMenuAndConfirmStubs(bridge) {
  return bridge.eval(`
    window.__f04 = { menus: [], confirms: [], answer: false, release: null };
    window.__HERMES_E2E_MENU__ = (items) => {
      window.__f04.menus.push(items);
      return new Promise((resolve) => { window.__f04.release = resolve; });
    };
    window.confirm = (message) => { window.__f04.confirms.push(String(message)); return window.__f04.answer; };
    return true;
  `);
}

/** Right-clicks the session's card in the session list, then picks the menu
 *  item with the given id, answering the confirmation with `answer`. */
async function pickSessionMenuItem(bridge, sessionId, actionId, answer) {
  await bridge.eval(`window.__f04.answer = ${answer}; window.__f04.menus = []; return true;`);
  await bridge.clickWhenReady(`
    const card = e2e.must(e2e.first('[data-session-item-id="${sessionId}"]'), "the session card");
    const r = card.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, button: 2,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    }));
    return true;
  `);
  const items = await bridge.waitFor("the session context menu", `
    const m = window.__f04.menus[0];
    return m ? m : null;
  `);
  const item = items.find((i) => i.id === actionId);
  assert(!!item && item.enabled !== false, `the session menu offers "${item?.label}"`);
  const emitted = await rawInvoke(bridge, "plugin:event|emit", { event: "menu-action", payload: { action: actionId } });
  assert(emitted.ok, "the menu pick was delivered");
  await sleep(300);
  await bridge.eval(`window.__f04.release?.(); window.__f04.release = null; return true;`);
  return item;
}

let app;
let failed = false;
// Step 7 relaunches against the same profile. A private home is kept here
// (the harness never deletes a home it was handed); on Windows the app's data
// lives under %APPDATA%, so the relaunch keeps the test data folder instead.
const onWindows = platform() === "win32";
const homeDir = onWindows ? undefined : mkdtempSync(join(tmpdir(), "hermes-e2e-f04-home-"));
const launchOptions = (resetData) =>
  onWindows ? { home: "real", resetData } : { home: "private", homeDir };

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   analytics stand-in: ${sinkHost}`);

  // ── 1. Launch with a fresh profile ────────────────────────────────
  log("step 1: launch the test app with a clean, first-launch data folder");
  app = await launchApp({
    runDir: join(evidenceDir, "run"),
    log,
    env: { HERMES_E2E_ANALYTICS_HOST: sinkHost },
    ...launchOptions(true),
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
  log("step 6: seed caches for sessions A and B, then delete session data for A from its menu");
  const marks = {};
  for (const sid of [sessionA, sessionB]) {
    marks[sid] = `F04-SCROLLBACK-${sid.slice(0, 8)}`;
    await bridge.click(`[data-session-item-id="${sid}"]`); // bring the session to the front
    await sleep(300);
    await bridge.typeInTerminal(sid, `echo ${marks[sid]}\n`);
    await bridge.waitForTerminal(sid, new RegExp(`^${marks[sid]}\\s*$`), { timeoutMs: 20_000 });
  }
  const saved = await rawInvoke(bridge, "save_all_snapshots");
  assert(saved.ok, `saved the terminal scrollback of the open sessions: ${JSON.stringify(saved)}`);
  for (const sid of [sessionA, sessionB]) {
    const snap = await rawInvoke(bridge, "get_session_snapshot", { sessionId: sid });
    assert(
      snap.ok && typeof snap.value === "string" && snap.value.includes(marks[sid]),
      `session ${sid.slice(0, 8)} has saved scrollback holding its output`,
    );
  }
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
  const appHome = onWindows ? process.env.HOME : homeDir;
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

  assert(await installMenuAndConfirmStubs(bridge), "stood in for the native popup menu and the confirm dialog");

  // Cancel first: nothing may change.
  await pickSessionMenuItem(bridge, sessionA, "session.delete-data", false);
  const asked = await bridge.eval(`return window.__f04.confirms.slice();`);
  assert(asked.length === 1 && /delete/i.test(asked[0]), `the user was asked to confirm: ${JSON.stringify(asked[0])}`);
  await sleep(800);
  const pinsKept = await rawInvoke(bridge, "get_context_pins", { sessionId: sessionA, projectId: null });
  assert(pinsKept.ok && pinsKept.value.length === 1, "cancelling keeps session A's pin");
  const snapKept = await rawInvoke(bridge, "get_session_snapshot", { sessionId: sessionA });
  assert(snapKept.ok && snapKept.value?.includes(marks[sessionA]), "cancelling keeps session A's scrollback");

  // Confirm: session A's caches go.
  await pickSessionMenuItem(bridge, sessionA, "session.delete-data", true);
  await bridge.screenshot(join(evidenceDir, "05-delete-session-data-confirmed.png"));
  const pinsA = await bridge.waitFor("session A's pins to be deleted", `
    const pins = await window.__TAURI_INTERNALS__.invoke("get_context_pins", { sessionId: ${JSON.stringify(sessionA)}, projectId: null });
    return pins.length === 0 ? pins : null;
  `);
  assert(pinsA.length === 0, "session A's pins are gone");
  const snapA = await rawInvoke(bridge, "get_session_snapshot", { sessionId: sessionA });
  // The session is still open: the periodic workspace save may run after the
  // delete and store its (now empty) output, so empty counts as gone too.
  assert(snapA.ok && (snapA.value === null || snapA.value === ""), `session A's saved scrollback is gone (got ${JSON.stringify(snapA)})`);
  const snapB = await rawInvoke(bridge, "get_session_snapshot", { sessionId: sessionB });
  assert(snapB.ok && snapB.value?.includes(marks[sessionB]), "session B's saved scrollback is untouched");
  assert(!existsSync(contextFileA), "session A's context file is gone");
  if (stateRoot) assert(!existsSync(join(stateRoot, sessionA)), "session A's agent-mode state folder is gone");

  const pinsB = await rawInvoke(bridge, "get_context_pins", { sessionId: sessionB, projectId: null });
  assert(pinsB.ok && pinsB.value.length === 1, "session B's pin is untouched");
  if (stateRoot) assert(existsSync(join(stateRoot, sessionB, "state.json")), "session B's state folder is untouched");
  assert(existsSync(join(repo, "README.md")) && existsSync(join(repo, ".git")), "the repository folder is untouched");
  assert((await bridge.terminalIds()).includes(sessionA), "session A is still open");
  await bridge.screenshot(join(evidenceDir, "06-after-delete-session-data.png"));

  if (stateRoot) rmSync(join(stateRoot, sessionB), { recursive: true, force: true });

  // ── 7. Relaunch while opted in: analytics starts with the app ─────
  log("step 7: opt in, quit, and relaunch on the same profile");
  await setAnalyticsInSettings(bridge, true, null);
  const firstExit = await app.stop();
  assert(!firstExit.forced && firstExit.code === 0, `the app quit cleanly before the relaunch (${JSON.stringify(firstExit)})`);
  app = null;
  const countBeforeRelaunch = received.length;
  app = await launchApp({
    runDir: join(evidenceDir, "run-relaunch"),
    log,
    env: { HERMES_E2E_ANALYTICS_HOST: sinkHost },
    ...launchOptions(false),
  });
  const relaunched = app.bridge;
  const afterRelaunch = () => received.slice(countBeforeRelaunch).map((e) => e.eventName);
  const relaunchDeadline = Date.now() + 20_000;
  while (!afterRelaunch().includes("app_started") && Date.now() < relaunchDeadline) await sleep(200);
  assert(
    afterRelaunch().includes("app_started"),
    `the opted-in profile sent app_started on the next launch (${JSON.stringify(afterRelaunch())})`,
  );
  assert(
    readFileSync(app.appLog, "utf8").includes("[analytics] opted in: analytics turned on"),
    "the app turned analytics on from the stored opt-in",
  );
  await relaunched.screenshot(join(evidenceDir, "07-relaunched-opted-in.png"));
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
    log("step 8: quit the app");
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
    if (!failed && (exit.forced || exit.code !== 0)) {
      failed = true;
      log("FAILED: the app did not quit cleanly");
    }
  }
  sink.close();
  // A helper process of the app can still be writing into the throwaway
  // home for a moment after the app exits (seen on Linux: ENOTEMPTY).
  // Cleanup retries and never decides the result.
  if (homeDir) {
    try {
      rmSync(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (err) {
      log(`  (could not remove the throwaway home ${homeDir}: ${err.message})`);
    }
  }
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log, details: { analyticsEvents: eventNames() } });
