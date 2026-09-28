#!/usr/bin/env node
// Scenario: F07 — Agent view: respawn lock and clear errors.
//
// Drives the REAL app with a fake Claude bridge (e2e/app/fixtures/
// fake-claude-bridge.mjs, started through HERMES_BRIDGE_PATH exactly like the
// real one). No network, no account: the Sign in step runs a fake `claude`
// placed first on PATH, and every directory holding a real `claude` is taken
// off the app's PATH. (Windows terminals read PATH from the registry, so on a
// Windows CI runner the fake is also added to the user's registry Path for
// the Sign in step and removed again.)
//
//   run 1  fresh install: onboarding; turn on the "agentViewErrors" flag
//   run 2  (flag on, normal build)
//          a. new Agent view session; the agent crashes on the first message
//             -> panel "Claude stopped (exit code 3)" with Retry
//          b. Retry clicked twice at once -> exactly ONE new agent process
//             (counted from the app's own spawn log and from the fake's log),
//             and it answers the next message
//          c. the agent answers "Not logged in" -> panel "Claude is signed out"
//             with Sign in; Sign in opens the agent in a terminal session
//          d. after signing in, the next message works; the agent crashes again
//             and the bridge file is gone on Retry -> "Couldn't start Claude";
//             restore it, Retry -> running again
//          e. the agent prints a line that is not JSON -> "Claude sent output
//             Hermes couldn't read"; Retry clears it
//   run 3  steps a–b with only the backend's merging turned off: the page's
//          lock alone must still give one process.
//          NEGATIVE CONTROL (same launch, a new session): steps a–b with the
//          lock off in both halves, the backend's (HERMES_E2E_NO_RESPAWN_LOCK=1)
//          and the page's (window.__HERMES_E2E_NO_RESPAWN_LOCK__), both honoured
//          only by test builds. The double Retry must now show TWO new
//          processes; if it does not, this scenario cannot tell a locked build
//          from an unlocked one and fails.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F07-agent-view-respawn.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/F07-agent-view-respawn.

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { REPO_ROOT, createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "F07-agent-view-respawn";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

const onWindows = platform() === "win32";
// Windows keeps app data under %APPDATA%, which a private HOME does not move
// (see N07-feature-flags.mjs); there the test app's own data folder is used.
const homeDir = onWindows ? undefined : mkdtempSync(join(tmpdir(), "hermes-e2e-f07-home-"));
const work = mkdtempSync(join(tmpdir(), "hermes-e2e-f07-"));

// ── Fake agent plumbing ─────────────────────────────────────────────
const bridgeCopy = join(work, "fake-claude-bridge.mjs");
const bridgeSource = join(REPO_ROOT, "e2e", "app", "fixtures", "fake-claude-bridge.mjs");
copyFileSync(bridgeSource, bridgeCopy);
const planFile = join(work, "plan.json");
const fakeLog = join(work, "fake-bridge.ndjson");
const setPlan = (mode) => {
  writeFileSync(planFile, JSON.stringify({ mode }));
  log(`  (fake bridge plan: ${mode})`);
};

/** A fake `claude` for the Sign in step: leaves a marker file (proof it ran,
 *  whatever the terminal shows), prints a line and waits. */
const fakeBin = join(work, "bin");
mkdirSync(fakeBin);
const SIGN_IN_MARK = "fake-claude-sign-in-screen";
const signInRanFile = join(work, "fake-claude-ran.txt");
if (onWindows) {
  writeFileSync(
    join(fakeBin, "claude.cmd"),
    `@echo ${SIGN_IN_MARK}> "${signInRanFile}"\r\n@echo ${SIGN_IN_MARK}\r\n@pause >nul\r\n`,
  );
} else {
  writeFileSync(
    join(fakeBin, "claude"),
    `#!/bin/sh\necho ${SIGN_IN_MARK} > '${signInRanFile}'\necho ${SIGN_IN_MARK}\nexec sleep 600\n`,
  );
  chmodSync(join(fakeBin, "claude"), 0o755);
}

/**
 * Windows terminals do not inherit the app's PATH: the terminal library
 * rebuilds PATH from the registry (machine Path, then the user's
 * HKCU\Environment Path) for every new terminal. So on Windows the fake
 * `claude` has to be on the user's registry Path. That is a machine setting,
 * so it is only changed on a throwaway CI runner, and restored afterwards.
 * Returns an undo function, or null when the change was not made.
 */
const canEditRegistryPath = onWindows && process.env.GITHUB_ACTIONS === "true";
function addFakeBinToRegistryPath() {
  if (!canEditRegistryPath) return null;
  let old = null;
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Environment", "/v", "Path"], { encoding: "utf8" });
    const m = out.match(/^\s*Path\s+REG_\w+\s+(.*)$/im);
    old = m ? m[1].trim() : "";
  } catch {
    old = null; // no user Path yet
  }
  const next = old ? `${old};${fakeBin}` : fakeBin;
  execFileSync("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", next, "/f"]);
  log(`  (CI runner: added the fake claude folder to the user's registry Path)`);
  return () => {
    if (old === null) {
      execFileSync("reg", ["delete", "HKCU\\Environment", "/v", "Path", "/f"]);
    } else {
      execFileSync("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", old, "/f"]);
    }
    log("  (CI runner: restored the user's registry Path)");
  };
}
let undoRegistryPath = null;

/** PATH for the app: the fake `claude` first, no directory with a real one. */
function testPath() {
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") || "PATH";
  const names = onWindows ? ["claude.exe", "claude.cmd", "claude.ps1", "claude"] : ["claude"];
  const kept = (process.env[pathKey] || "").split(delimiter).filter((dir) => {
    if (!dir) return false;
    try {
      return !names.some((n) => existsSync(join(dir, n)));
    } catch {
      return true;
    }
  });
  return { key: pathKey, value: [fakeBin, ...kept].join(delimiter) };
}

function appEnv(extra = {}) {
  const p = testPath();
  return {
    HERMES_BRIDGE_PATH: bridgeCopy,
    HERMES_FAKE_BRIDGE_PLAN: planFile,
    HERMES_FAKE_BRIDGE_LOG: fakeLog,
    [p.key]: p.value,
    ...extra,
  };
}

function fakeEvents() {
  if (!existsSync(fakeLog)) return [];
  return readFileSync(fakeLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Agent session id the fake bridge was started for (from its argv). */
const argvSession = (e) => {
  const a = e.argv || [];
  const i = a.indexOf("--session-id") >= 0 ? a.indexOf("--session-id") : a.indexOf("--resume");
  return i >= 0 ? a[i + 1] : null;
};

/** Processes the app started for Hermes session `sid`, from its own log. */
function appSpawns(runDir, sid) {
  const file = join(runDir, "app.log");
  if (!existsSync(file)) return 0;
  const needle = `[agent spawned] sid=${sid} `;
  return readFileSync(file, "utf8").split("\n").filter((l) => l.includes(needle)).length;
}

/** Fake bridge processes that started and never exited. */
function liveFakePids(pids) {
  const events = fakeEvents();
  const exited = new Set(events.filter((e) => e.event === "exit").map((e) => e.pid));
  return pids.filter((pid) => {
    if (exited.has(pid)) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
}

// ── App steps ───────────────────────────────────────────────────────
function launch(run, { first = false, env = appEnv() } = {}) {
  const runDir = join(evidenceDir, `run-${run}`);
  const started = onWindows
    ? launchApp({ runDir, log, home: "real", resetData: first, env })
    : launchApp({ runDir, log, home: "private", homeDir, env });
  return started.then((app) => ({ ...app, runDir }));
}

async function dismissWhatsNew(bridge) {
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
}

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
    return true;
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

async function waitForReturningLaunch(bridge) {
  await bridge.waitFor("the app UI to be ready", `
    return !!e2e.first(".topbar-title, .topbar") && !e2e.first(".onboarding-backdrop");
  `);
  await dismissWhatsNew(bridge);
}

async function quit(app) {
  const exit = await app.stop();
  log(`  app exited: ${JSON.stringify(exit)}`);
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");
}

/** New Agent view session through the New Session wizard; returns its id. */
async function createAgentSession(bridge) {
  const before = await bridge.eval(`return e2e.all(".agent-session-view").map((e) => e.dataset.sessionId);`);
  await bridge.clickWhenReady(`
    const b = e2e.first("button.es-tile-primary") || e2e.byName("New Session");
    return e2e.click(e2e.must(b, "a New Session button"));
  `);
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, {
    timeoutMs: 20_000,
  });
  // The wizard opens on the agent step: pick Claude, then tick "Agent view for Claude".
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`);
  await bridge.clickWhenReady(`
    const claude = e2e.all(".session-creator-provider-card").find((c) => c.innerText.trim().startsWith("Claude"));
    return e2e.click(e2e.must(claude, "the Claude card"));
  `);
  const agentViewBox = `e2e.first(".session-creator-agent-view input[type=checkbox]")`;
  await bridge.waitFor("the Agent view option", `return !!${agentViewBox};`);
  if (!(await bridge.eval(`return ${agentViewBox}.checked;`))) {
    await bridge.clickWhenReady(`return e2e.click(e2e.must(${agentViewBox}, "the Agent view checkbox"));`);
  }
  await bridge.waitFor("Agent view to be selected", `return ${agentViewBox}?.checked === true;`);
  for (let i = 0; i < 8; i++) {
    if (!(await bridge.exists(".session-creator"))) break;
    const clicked = await bridge.clickWhenReady(`
      if (!e2e.first(".session-creator")) return null;
      const b = e2e.must(
        e2e.first(".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary"),
        "the wizard's primary button",
      );
      const step = e2e.first(".session-creator-step")?.innerText ?? "";
      return { step, ...e2e.click(b) };
    `);
    if (clicked) log(`  wizard ${clicked.step}: clicked "${clicked.clicked}"`);
    await sleep(400);
  }
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  const sid = await bridge.waitFor("the Agent view to open", `
    const ids = e2e.all(".agent-session-view").map((e) => e.dataset.sessionId).filter(Boolean);
    const fresh = ids.filter((id) => !${JSON.stringify(before)}.includes(id));
    return fresh.length === 1 ? fresh[0] : null;
  `, { timeoutMs: 20_000 });
  log(`  Agent view session: ${sid}`);
  return sid;
}

/** Type into the Agent view composer and press Send. */
async function sendMessage(bridge, text) {
  await bridge.clickWhenReady(`
    const ta = e2e.must(e2e.first(".session-composer-input"), "the composer");
    ta.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  `);
  await bridge.waitFor("the composer to hold the message", `
    return e2e.first(".session-composer-input")?.value === ${JSON.stringify(text)};
  `);
  await bridge.click(".session-composer-send-btn");
  log(`  sent: "${text}"`);
}

const panelScript = `
  const b = e2e.first(".agent-error-banner");
  if (!b) return null;
  return {
    kind: b.dataset.kind,
    text: e2e.norm(b.innerText),
    actions: e2e.all(".agent-error-banner-action", b).map((a) => a.dataset.action),
  };
`;

async function waitForPanel(bridge, kind, timeoutMs = 20_000) {
  const panel = await bridge.waitFor(`the "${kind}" error panel`, `
    const p = (() => { ${panelScript} })();
    return p && p.kind === ${JSON.stringify(kind)} ? p : null;
  `, { timeoutMs });
  log(`  panel: ${JSON.stringify(panel)}`);
  return panel;
}

/** Crash the agent, then click Retry twice in the same instant. */
async function crashThenDoubleRetry(app, sid, { expectPanelToClear }) {
  const { bridge, runDir } = app;
  setPlan("crash");
  await sendMessage(bridge, "hello");
  const crash = await waitForPanel(bridge, "exited");
  const spawnsBefore = appSpawns(runDir, sid);
  const fakeBefore = fakeEvents().filter((e) => e.event === "start").length;

  setPlan("ok");
  const clicks = await bridge.eval(`
    const retry = () => e2e.must(e2e.first('.agent-error-banner-action[data-action="retry"]'), "Retry");
    const first = e2e.click(retry());
    const second = e2e.click(retry());
    return [first.clicked, second.clicked];
  `);
  log(`  clicked Retry twice in one go: ${JSON.stringify(clicks)}`);
  if (expectPanelToClear) {
    await bridge.waitFor("the error panel to clear", `return !e2e.first(".agent-error-banner");`, { timeoutMs: 20_000 });
  }
  // Let any second start land (the unlocked build starts it right away).
  await sleep(2_000);
  const newSpawns = appSpawns(runDir, sid) - spawnsBefore;
  const newFake = fakeEvents().filter((e) => e.event === "start").slice(fakeBefore);
  return { crash, newSpawns, newFake };
}

let app;
let failed = false;
const details = {};

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}`);
  log(`  fake bridge: ${bridgeCopy}; fake claude: ${fakeBin}`);

  // ── run 1 ──────────────────────────────────────────────────────────
  log("step 1: fresh launch, onboarding, turn on the agentViewErrors flag (read at next launch)");
  app = await launch(1, { first: true });
  await completeOnboarding(app.bridge);
  await app.bridge.eval(`
    await window.__TAURI_INTERNALS__.invoke("set_setting", {
      key: "feature_flag_overrides",
      value: JSON.stringify({ agentViewErrors: true }),
    });
    return true;
  `);
  await quit(app);

  // ── run 2 ──────────────────────────────────────────────────────────
  log("step 2: relaunch with the flag on; open an Agent view session");
  setPlan("ok");
  app = await launch(2);
  await waitForReturningLaunch(app.bridge);
  const sid = await createAgentSession(app.bridge);
  const firstStart = Date.now();
  while (appSpawns(app.runDir, sid) < 1 && Date.now() - firstStart < 20_000) await sleep(100);
  assert(appSpawns(app.runDir, sid) === 1, "opening the session started one agent process");

  log("step 3: the agent crashes -> typed 'exited' panel with Retry; then Retry twice at once");
  const r = await crashThenDoubleRetry(app, sid, { expectPanelToClear: true });
  assert(r.crash.text.includes("Claude stopped") && r.crash.text.includes("exit code 3"), `the panel says "Claude stopped … exit code 3"`);
  assert(r.crash.actions.length === 1 && r.crash.actions[0] === "retry", "the panel offers Retry");
  assert(!(await app.bridge.exists(".agent-exit-notice")), "the old one-line exit notice is not shown");
  await app.bridge.screenshot(join(evidenceDir, "02-crash-exited-panel.png")).catch((e) => log(`  (screenshot: ${e.message})`));
  details.lockedNewProcesses = r.newSpawns;
  assert(r.newSpawns === 1, `two concurrent restarts started exactly one agent process (app log: ${r.newSpawns})`);
  assert(r.newFake.length === 1, `the fake bridge saw exactly one new start (${r.newFake.length})`);
  const live = liveFakePids(r.newFake.map((e) => e.pid));
  assert(live.length === 1, `exactly one agent process is running for the session (pids ${JSON.stringify(live)})`);
  assert(argvSession(r.newFake[0]) !== null, `the restart resumed the conversation (${(r.newFake[0].argv || []).join(" ")})`);

  log("step 4: the restarted agent answers");
  await sendMessage(app.bridge, "after retry");
  await app.bridge.waitFor("the agent's reply", `
    return e2e.norm(e2e.first(".agent-session-view")?.innerText).includes("fake reply: after retry");
  `, { timeoutMs: 20_000 });
  assert(
    fakeEvents().some((e) => e.event === "input" && e.type === "user" && e.pid === live[0]),
    "the message went to that one process",
  );
  await app.bridge.screenshot(join(evidenceDir, "03-after-retry-reply.png")).catch((e) => log(`  (screenshot: ${e.message})`));

  log("step 5: the agent is signed out -> 'signed out' panel with Sign in");
  setPlan("signed-out");
  await sendMessage(app.bridge, "who am i");
  const so = await waitForPanel(app.bridge, "signed_out");
  assert(/signed out/i.test(so.text), `the panel says "signed out" ("${so.text.slice(0, 80)}")`);
  assert(so.actions.length === 1 && so.actions[0] === "sign-in", "the panel offers Sign in (and no Retry)");
  assert(!(await app.bridge.exists(".agent-result-error")), "the generic 'couldn't continue' banner is not repeated");
  await app.bridge.screenshot(join(evidenceDir, "04-signed-out-panel.png")).catch((e) => log(`  (screenshot: ${e.message})`));

  undoRegistryPath = addFakeBinToRegistryPath();
  const sessionsBefore = await app.bridge.eval(`return e2e.all(".session-item").length;`);
  const termsBefore = await app.bridge.terminalIds();
  await app.bridge.click('.agent-error-banner-action[data-action="sign-in"]');
  const signInSid = await app.bridge.waitFor("Sign in to open a terminal session", `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(termsBefore)}.includes(id));
    return e2e.all(".session-item").length === ${sessionsBefore + 1} && ids.length > 0 ? ids[ids.length - 1] : null;
  `, { timeoutMs: 20_000 });
  assert(!!signInSid, `Sign in opened a new terminal session (${signInSid})`);
  // The fake `claude` leaves a file when it runs: proof that the new
  // terminal session started the agent itself (nothing else runs it).
  if (onWindows && !canEditRegistryPath) {
    // Outside CI the fake cannot reach a Windows terminal's PATH without
    // changing the person's registry, so this one check is CI-only there.
    log("  (Windows outside CI: the fake `claude` cannot be put on the terminal's PATH; not checked)");
  } else {
    const ranBy = Date.now() + 45_000;
    while (!existsSync(signInRanFile) && Date.now() < ranBy) await sleep(250);
    log(`  terminal: ${JSON.stringify((await app.bridge.readTerminal(signInSid))?.slice(-6))}`);
    assert(existsSync(signInRanFile), "the terminal session ran the agent's own sign-in (the fake `claude` started)");
  }
  if (undoRegistryPath) {
    undoRegistryPath();
    undoRegistryPath = null;
  }
  if (!onWindows) {
    await app.bridge.waitForTerminal(signInSid, new RegExp(SIGN_IN_MARK), { timeoutMs: 30_000 });
    assert(true, "its sign-in screen shows in the terminal (the fake `claude` printed it)");
  }
  await app.bridge.screenshot(join(evidenceDir, "05-sign-in-terminal.png")).catch((e) => log(`  (screenshot: ${e.message})`));

  log("step 6: back to the Agent view; after signing in, the next message works and the panel goes");
  await app.bridge.clickWhenReady(`
    const item = e2e.all(".session-item").find((el) => !(el.getAttribute("title") || "").startsWith("Sign in to Claude"));
    return e2e.click(e2e.must(item, "the Agent view session in the list"));
  `);
  await app.bridge.waitFor("the Agent view to show again", `
    return !!e2e.first('.agent-session-view[data-session-id=${JSON.stringify(sid)}]');
  `);
  setPlan("ok");
  await sendMessage(app.bridge, "signed in now");
  await app.bridge.waitFor("the agent's reply", `
    return e2e.norm(e2e.first(".agent-session-view")?.innerText).includes("fake reply: signed in now");
  `, { timeoutMs: 20_000 });
  await app.bridge.waitFor("the signed-out panel to go", `return !e2e.first(".agent-error-banner");`);
  assert(true, "a successful turn after signing in clears the signed-out panel");

  log("step 7: crash again, and the bridge file is missing on Retry -> 'Couldn't start Claude'");
  // The view ignores an exit that lands within 300 ms of the agent's start
  // event (it assumes the exit belongs to the previous process), so wait
  // like a person would before the next message.
  await sleep(1_000);
  setPlan("crash");
  await sendMessage(app.bridge, "crash again");
  await waitForPanel(app.bridge, "exited");
  rmSync(bridgeCopy);
  await app.bridge.click('.agent-error-banner-action[data-action="retry"]');
  const sf = await waitForPanel(app.bridge, "spawn_failed");
  assert(sf.text.includes("Couldn't start Claude"), `the panel says "Couldn't start Claude"`);
  assert(sf.actions[0] === "retry", "the panel offers Retry");
  const sfDetail = await app.bridge.eval(`return document.querySelector(".agent-error-banner-detail")?.textContent ?? "";`);
  assert(/non-existent file/.test(sfDetail), `Details name the missing file ("${sfDetail.split("\n").pop()?.slice(0, 60)}…")`);
  await app.bridge.screenshot(join(evidenceDir, "06-spawn-failed-panel.png")).catch((e) => log(`  (screenshot: ${e.message})`));
  copyFileSync(bridgeSource, bridgeCopy);
  setPlan("ok");
  const beforeRecover = appSpawns(app.runDir, sid);
  await app.bridge.click('.agent-error-banner-action[data-action="retry"]');
  await app.bridge.waitFor("the error panel to clear", `return !e2e.first(".agent-error-banner");`, { timeoutMs: 20_000 });
  assert(appSpawns(app.runDir, sid) === beforeRecover + 1, "Retry started the agent again once the file was back");

  log("step 8: the agent prints a line that is not JSON -> 'protocol' panel; Retry clears it");
  setPlan("garbage");
  await sendMessage(app.bridge, "say something odd");
  const pr = await waitForPanel(app.bridge, "protocol");
  assert(pr.text.includes("couldn't read"), `the panel says Hermes couldn't read the output`);
  await app.bridge.screenshot(join(evidenceDir, "07-protocol-panel.png")).catch((e) => log(`  (screenshot: ${e.message})`));
  setPlan("ok");
  await app.bridge.click('.agent-error-banner-action[data-action="retry"]');
  await app.bridge.waitFor("the error panel to clear", `return !e2e.first(".agent-error-banner");`, { timeoutMs: 20_000 });
  await quit(app);

  // ── run 3: only the page's lock ────────────────────────────────────
  // The backend can only merge restarts that reach it at the same time; on a
  // slow runner the second click's request can arrive after the first
  // restart finished. With the backend's merging off, the page's lock alone
  // must still give one process.
  log("step 9: backend lock OFF, page lock on — still exactly one process");
  app = await launch(3, { env: appEnv({ HERMES_E2E_NO_RESPAWN_LOCK: "1" }) });
  await waitForReturningLaunch(app.bridge);
  const sid3 = await createAgentSession(app.bridge);
  let t0 = Date.now();
  while (appSpawns(app.runDir, sid3) < 1 && Date.now() - t0 < 20_000) await sleep(100);
  const p3 = await crashThenDoubleRetry(app, sid3, { expectPanelToClear: true });
  details.pageLockOnlyNewProcesses = p3.newSpawns;
  assert(p3.newSpawns === 1, `the page's lock alone started exactly one process (${p3.newSpawns})`);

  // ── run 4: negative control ────────────────────────────────────────
  log("step 10: NEGATIVE CONTROL — both halves of the lock off");
  await app.bridge.eval(`window.__HERMES_E2E_NO_RESPAWN_LOCK__ = true; return true;`);
  const sid2 = await createAgentSession(app.bridge);
  t0 = Date.now();
  while (appSpawns(app.runDir, sid2) < 1 && Date.now() - t0 < 20_000) await sleep(100);
  const n = await crashThenDoubleRetry(app, sid2, { expectPanelToClear: false });
  details.unlockedNewProcesses = n.newSpawns;
  log(`  without the lock the double Retry started ${n.newSpawns} processes (fake saw ${n.newFake.length})`);
  assert(n.newSpawns >= 2, "without the lock the same check sees a second process, so the check can fail");
  await app.bridge.screenshot(join(evidenceDir, "08-negative-control.png")).catch((e) => log(`  (screenshot: ${e.message})`));
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      const dump = await app.bridge.eval(`
        return {
          buttons: e2e.all("button").map(e2e.nameOf).slice(0, 40),
          panel: (() => { ${panelScript} })(),
          dialogs: [...document.querySelectorAll('[class*="backdrop"],[class*="overlay"]')].map((e) => e.className),
        };
      `);
      log(`  what the app showed: ${JSON.stringify(dump)}`);
    }
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
  log(`  fake bridge log: ${existsSync(fakeLog) ? readFileSync(fakeLog, "utf8").split("\n").slice(-20).join("\n    ") : "(none)"}`);
} finally {
  if (undoRegistryPath) {
    try { undoRegistryPath(); } catch (e) { log(`  (could not restore the registry Path: ${e.message})`); }
  }
  if (app?.isRunning()) {
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
  }
  if (homeDir) rmSync(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log, details });
