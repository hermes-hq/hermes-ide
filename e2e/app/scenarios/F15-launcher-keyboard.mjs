#!/usr/bin/env node
// Scenario F15 (launcher v2): the keyboard alone, from a cold start with no
// session, launches four tasks in under 60 seconds. REAL app, fake `claude`
// (tools/fake-agents), no real account.
//
//   run 1  fresh install: the welcome; the taskLauncher flag on; a project;
//          then the app quits (no session is left).
//   run 2  the clock starts before the app does.
//          - ⌘N (the File menu's key on macOS, Ctrl+Shift+N elsewhere): the
//            launcher opens on the project with the task field focused.
//          - the chips by key: the focus moves along them with the arrow
//            keys, Enter opens the approval chip, → and Enter pick Plan
//            first, Esc closes the menu and leaves the focus on the chip.
//          - three tasks with Launch & next (⌘⏎ / Ctrl+Enter): the focus is
//            back in the empty task field each time, and stays there once the
//            new session's terminal has attached behind the sheet (a terminal
//            asked to take the keyboard while the sheet is open does not);
//            the fourth with Enter, which closes the sheet.
//          - four agents started, each on its own branch with its task and
//            Plan first, all within 60 s of the app being started.
//
// Keys are key events in the app's web view (see harness.mjs); moving the
// focus to the first chip stands in for Tab, which a synthetic key event
// cannot do.
//
// Negative control (must end in RESULT: FAIL):
//   HERMES_E2E_LAUNCHER_BUDGET_MS=1   a one-millisecond budget.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F15-launcher-keyboard.mjs

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLogger, finishScenario, outDir } from "../harness.mjs";
import {
  MOD,
  completeClassicOnboarding,
  invoke,
  launcherFixtures,
  onWindows,
  openLauncher,
  pressKeyOnFocus,
  typeInto,
  waitForReturningLaunch,
  waitLaunchEnabled,
} from "../launcher-steps.mjs";

const SCENARIO = "F15-launcher-keyboard";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);
const BUDGET_MS = Number(process.env.HERMES_E2E_LAUNCHER_BUDGET_MS || 60_000);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}
const hasSeq = (argv, seq) => argv.some((_, i) => seq.every((w, j) => argv[i + j] === w));

const fx = launcherFixtures("f15-keys", log);
if (onWindows && !fx.canEditRegistryPath) {
  log("this scenario needs the fake agents on a Windows terminal's PATH (the user's registry Path); that is only changed on a CI runner");
  log("RESULT: SKIP (Windows outside CI)");
  process.exit(0);
}

let app;
let failed = false;
let undoRegistryPath = null;
const focusIsTask = (bridge) => bridge.eval(`return document.activeElement === e2e.first(".task-launcher-task");`);

try {
  log(`scenario: ${SCENARIO}   budget: ${BUDGET_MS} ms`);
  undoRegistryPath = fx.addFakeBinToRegistryPath();

  log("run 1: fresh install; the taskLauncher flag; a project; quit");
  app = await fx.launch(evidenceDir, 1, { first: true });
  await completeClassicOnboarding(app.bridge);
  await invoke(app.bridge, "set_setting", { key: "feature_flag_overrides", value: JSON.stringify({ taskLauncher: true }) });
  await invoke(app.bridge, "create_project", { path: fx.repo, name: null });
  await app.stop();

  log("run 2: cold start, the clock is running");
  const t0 = Date.now();
  app = await fx.launch(evidenceDir, 2);
  const { bridge } = app;
  await waitForReturningLaunch(bridge);
  assert((await bridge.terminalIds()).length === 0, "no session is open");
  log(`  app ready after ${Date.now() - t0} ms`);

  await openLauncher(bridge);
  assert(await focusIsTask(bridge), "the launcher opens with the task field focused");

  log("the chips by key");
  await bridge.eval(`e2e.first('[data-chip="agent"]').focus(); return true;`);
  let at = await pressKeyOnFocus(bridge, "ArrowRight");
  assert(at?.chip === "project", "→ moves to the project chip");
  at = await pressKeyOnFocus(bridge, "ArrowRight");
  at = await pressKeyOnFocus(bridge, "ArrowRight");
  assert(at?.chip === "approval", "→ → reaches the approval chip");
  await pressKeyOnFocus(bridge, "Enter");
  await bridge.waitFor("the approval menu with the current mode focused", `return !!e2e.first('.task-launcher-menu[data-menu="approval"]') && document.activeElement?.getAttribute("data-mode") === "acceptEdits";`);
  at = await pressKeyOnFocus(bridge, "ArrowRight");
  assert(at?.mode === "plan", "→ moves to Plan first");
  await pressKeyOnFocus(bridge, "Enter");
  await bridge.waitFor("Plan first chosen", `return /^Plan first/.test(e2e.norm(e2e.first('[data-chip="approval"]')?.innerText ?? ""));`);
  await pressKeyOnFocus(bridge, "Escape");
  await bridge.waitFor("the menu to close, focus back on its chip", `return !e2e.first(".task-launcher-menu") && document.activeElement?.getAttribute("data-chip") === "approval";`);
  assert(true, "Esc closes the menu and the focus is back on the chip; the sheet stays");
  await bridge.eval(`e2e.first(".task-launcher-task").focus(); return true;`);

  const tasks = ["Add the ru locale", "Bump tauri to 2.9", "Write tests for the badge", "Fix the flaky login test"];
  for (const [i, task] of tasks.entries()) {
    await typeInto(bridge, ".task-launcher-task", task);
    await waitLaunchEnabled(bridge);
    const last = i === tasks.length - 1;
    await pressKeyOnFocus(bridge, "Enter", last ? {} : MOD);
    if (last) {
      await bridge.waitFor("the sheet to close", `return !e2e.first(".task-launcher-sheet");`, { timeoutMs: 30_000 });
    } else {
      await bridge.waitFor(`launch ${i + 1}`, `return new RegExp("Launched ${i + 1}\\\\b").test(e2e.first(".task-launcher-launched")?.innerText ?? "");`, { timeoutMs: 30_000 });
      // The new session's terminal attaches behind the sheet (a pane it
      // gives the keyboard to): once it has, and a few frames later, the
      // keyboard is still in the launcher's task field.
      await bridge.waitFor(`session ${i + 1}'s terminal`, `return window.__HERMES_E2E__.terminalIds().length >= ${i + 1};`, { timeoutMs: 30_000 });
      await bridge.waitFor(`the focus back in the task field after task ${i + 1}`, `return document.activeElement === e2e.first(".task-launcher-task");`, { timeoutMs: 2_000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
      if (!(await focusIsTask(bridge))) {
        const on = await bridge.eval(`const a = document.activeElement; return a ? a.tagName + "." + String(a.className) : "none";`);
        log(`  (after task ${i + 1} the keyboard is on ${on})`);
      }
      assert((await focusIsTask(bridge)) && (await bridge.eval(`return e2e.first(".task-launcher-task").value;`)) === "", `after task ${i + 1} the focus is back in the empty task field`);
      if (i === 0) {
        // A pane that becomes focused or attaches asks its terminal to take
        // the keyboard (the path that pulled it out of the open sheet):
        // with the launcher open, the terminal does not get it.
        const [sid] = await bridge.terminalIds();
        await bridge.eval(`window.__HERMES_E2E__.focusTerminal(${JSON.stringify(sid)}); return true;`);
        await new Promise((r) => setTimeout(r, 100));
        assert(await focusIsTask(bridge), "a terminal asked to take the keyboard while the launcher is open does not take it");
      }
    }
  }
  const recs = await fx.waitForRecords(4, Math.max(1, BUDGET_MS - (Date.now() - t0)));
  const elapsed = Date.now() - t0;
  log(`  four agents started ${elapsed} ms after the app was started`);
  assert(elapsed < BUDGET_MS, `four tasks launched by keyboard in under ${BUDGET_MS / 1000} s from a cold start (${(elapsed / 1000).toFixed(1)} s)`);
  for (const task of tasks) {
    const r = recs.find((x) => x.argv.some((a) => String(a).startsWith(task)));
    assert(r && hasSeq(r.argv, ["--permission-mode", "plan"]), `"${task}" started with its task and Plan first`);
  }
  const branches = fx.worktrees().map((w) => w.branch).filter((b) => b?.startsWith("hermes/"));
  assert(new Set(branches).size === 4, `each on its own branch (${branches.join(", ")})`);
  await bridge.screenshot(join(evidenceDir, "01-four-tasks.png"));
  await app.stop();
  app = null;
} catch (err) {
  failed = true;
  log(`ERROR: ${err.stack || err.message || err}`);
  if (app) {
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
