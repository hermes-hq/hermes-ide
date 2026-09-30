#!/usr/bin/env node
// Scenario F12 (morning view): agents that are already waiting on the person
// when Hermes starts open the attention inbox by itself; ⌘I says where in the
// line an agent is; the status strip says how Hermes knows. REAL app, fake
// `claude` CLIs (tools/fake-agents), no real account.
//
//   run 1  fresh install: the welcome; the taskLauncher flag on (and the
//          session host off, so a restart restores and resumes the agents);
//          two tasks launched from ⌘N; then the fakes are told to ask for a
//          permission as soon as they start again, and the app quits.
//   run 2  - Hermes restores both sessions and resumes both agents, which
//            ask at once: the inbox opens by itself as the morning view,
//            "2 agents are waiting on you", oldest first, each with "n of 2
//            waiting" and "exact" (the agent reported it).
//          - "Start today's tasks" opens the task launcher.
//          - ⌘I jumps to the agent waiting longest and says "1 of 2
//            waiting"; again: "2 of 2 waiting".
//          - the status strip of the session in front: needs approval,
//            "exact · reported by Claude Code".
//          - a task started now that asks at once does not open it again.
//
// Negative control (must end in RESULT: FAIL):
//   HERMES_E2E_MORNING_MODE=normal   the agents do not ask at start: no
//                                    morning view.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F12-morning-view.mjs

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLogger, finishScenario, outDir, sleep } from "../harness.mjs";
import {
  MOD,
  completeClassicOnboarding,
  invoke,
  launcherFixtures,
  onMac,
  onWindows,
  openLauncher,
  pressKey,
  setRepo,
  typeInto,
  waitForReturningLaunch,
  waitLaunchEnabled,
} from "../launcher-steps.mjs";

const SCENARIO = "F12-morning-view";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);
const RESTART_MODE = process.env.HERMES_E2E_MORNING_MODE || "ask-at-start";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

const fx = launcherFixtures("f12-morning", log);
if (onWindows && !fx.canEditRegistryPath) {
  log("this scenario needs the fake agents on a Windows terminal's PATH (the user's registry Path); that is only changed on a CI runner");
  log("RESULT: SKIP (Windows outside CI)");
  process.exit(0);
}

let app;
let failed = false;
let undoRegistryPath = null;

/** ⌘I (macOS) / Ctrl+Shift+I: jump to the next waiting agent. */
const pressNextWaiting = (bridge) =>
  bridge.eval(`
    const ev = new KeyboardEvent("keydown", { key: ${JSON.stringify(onMac ? "i" : "I")}, code: "KeyI", bubbles: true, cancelable: true, ${onMac ? "metaKey: true" : "ctrlKey: true, shiftKey: true"} });
    (document.activeElement || document.body).dispatchEvent(ev);
    return true;
  `);

try {
  log(`scenario: ${SCENARIO}   agents at restart: ${RESTART_MODE}`);
  undoRegistryPath = fx.addFakeBinToRegistryPath();
  const flags = { taskLauncher: true, sessionHost: false };

  log("run 1: two tasks; then the agents will ask as soon as they start again");
  app = await fx.launch(evidenceDir, 1, { first: true });
  await completeClassicOnboarding(app.bridge);
  await invoke(app.bridge, "set_setting", { key: "feature_flag_overrides", value: JSON.stringify(flags) });
  await invoke(app.bridge, "create_project", { path: fx.repo, name: null });
  await app.stop();
  app = await fx.launch(evidenceDir, 2);
  await waitForReturningLaunch(app.bridge);
  await openLauncher(app.bridge);
  await setRepo(app.bridge, fx.repo);
  for (const [i, task] of ["Books export to EPUB", "Fix the flaky login test"].entries()) {
    await typeInto(app.bridge, ".task-launcher-task", task);
    await waitLaunchEnabled(app.bridge);
    await pressKey(app.bridge, ".task-launcher-task", "Enter", i === 0 ? MOD : {});
    await fx.waitForRecords(i + 1);
    await sleep(400);
  }
  await app.bridge.waitFor("both agents started", `return window.__HERMES_E2E__.terminalIds().length === 2;`, { timeoutMs: 30_000 });
  await sleep(2500);
  fx.setFake("mode", RESTART_MODE);
  await app.stop();

  log("run 3: Hermes restarts; the restored agents ask at once");
  app = await fx.launch(evidenceDir, 3);
  const { bridge } = app;
  await waitForReturningLaunch(bridge);
  const morning = await bridge.waitFor("the morning view", `
    const d = e2e.first('.attention-inbox[data-morning="true"]');
    if (!d) return null;
    const rows = e2e.all(".attention-inbox .attention-option");
    if (rows.length < 2) return null;
    return {
      title: e2e.norm(e2e.first(".attention-morning-title")?.innerText ?? ""),
      why: e2e.norm(e2e.first(".attention-morning-why")?.innerText ?? ""),
      rows: rows.map((r) => ({
        task: e2e.norm(r.querySelector(".attention-option-task")?.innerText ?? ""),
        place: e2e.norm(r.querySelector(".attention-option-place")?.innerText ?? ""),
        confidence: r.querySelector(".attention-option-confidence")?.getAttribute("data-confidence") ?? null,
      })),
    };
  `, { timeoutMs: 60_000 });
  log(`  morning view: ${JSON.stringify(morning)}`);
  assert(morning.title === "2 agents are waiting on you", `the title: "${morning.title}"`);
  assert(/blocked when Hermes started/.test(morning.why), "it says why it opened");
  assert(JSON.stringify(morning.rows.map((r) => r.place)) === JSON.stringify(["1 of 2 waiting", "2 of 2 waiting"]), "each row has its place in the line");
  assert(morning.rows.every((r) => r.confidence === "exact"), "each status is exact (reported by the agent)");
  await bridge.screenshot(join(evidenceDir, "01-morning-view.png"));

  log("Start today's tasks opens the launcher");
  await bridge.click(".attention-morning-start");
  await bridge.waitFor("the launcher", `return !!e2e.first(".task-launcher-sheet") && !e2e.first(".attention-inbox");`, { timeoutMs: 20_000 });
  await pressKey(bridge, ".task-launcher-task", "Escape");
  await bridge.waitFor("the launcher to close", `return !e2e.first(".task-launcher-sheet");`);

  log("⌘I says where in the line the agent is");
  const seen = [];
  for (let i = 0; i < 2; i++) {
    await pressNextWaiting(bridge);
    const note = await bridge.waitFor("the position note", `return e2e.norm(e2e.first(".attention-position")?.innerText ?? "") || null;`, { timeoutMs: 5_000 });
    seen.push(note);
    await sleep(300);
  }
  log(`  notes: ${JSON.stringify(seen)}`);
  // ⌘I goes to the waiting agent after the one in front (the oldest when the
  // one in front is not waiting): which one is in front after the restore
  // decides where it starts, so both orders visit both.
  assert(
    JSON.stringify([...seen].sort()) === JSON.stringify(["1 of 2 waiting", "2 of 2 waiting"]),
    `⌘I twice visits both waiting agents and says where each is in the line (${seen.join(", ")})`,
  );

  log("the status strip says how Hermes knows");
  const strip = await bridge.waitFor("the strip of the session in front", `
    const s = e2e.first(".session-status-strip");
    return s ? { kind: s.getAttribute("data-status-kind"), source: e2e.norm(s.querySelector(".session-status-strip-source")?.innerText ?? "") } : null;
  `);
  log(`  strip: ${JSON.stringify(strip)}`);
  assert(strip.kind === "needs_approval" && strip.source === "exact · reported by Claude Code", `"${strip.source}"`);
  await bridge.screenshot(join(evidenceDir, "02-position-and-strip.png"));

  log("a task started now that asks at once does not open the morning view again");
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "A new task that asks");
  await waitLaunchEnabled(bridge);
  const n0 = fx.records().length;
  await pressKey(bridge, ".task-launcher-task", "Enter");
  await fx.waitForRecords(n0 + 1);
  await bridge.waitFor("three agents waiting", `return window.__HERMES_E2E__.attentionSummary?.().blocked === 3 || e2e.first(".attention-badge")?.getAttribute("data-count") === "3";`, { timeoutMs: 30_000 });
  await sleep(1000);
  assert(!(await bridge.exists(".attention-inbox")), "the inbox stays closed");
  await app.stop();
  app = null;
} catch (err) {
  failed = true;
  log(`ERROR: ${err.stack || err.message || err}`);
  if (app) {
    try {
      const shown = await app.bridge.eval(`
        const h = window.__HERMES_E2E__;
        return {
          inbox: h.inboxItems(),
          terminals: h.terminalIds().map((id) => ({ id, tail: (h.readTerminal(id) || []).slice(-6), events: h.sessionEventSnapshot(id).events.slice(-8) })),
        };
      `);
      log(`what the app showed: ${JSON.stringify(shown)}`);
    } catch {
      /* the app is gone */
    }
    try {
      await app.bridge.screenshot(join(evidenceDir, "failure.png"));
    } catch {
      /* no screenshot */
    }
  }
} finally {
  if (app) {
    try {
      await app.stop();
    } catch {
      /* already gone */
    }
  }
  if (undoRegistryPath) {
    try {
      undoRegistryPath();
    } catch (e) {
      log(`could not restore the registry Path: ${e.message}`);
    }
  }
  if (!failed) fx.cleanup();
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
