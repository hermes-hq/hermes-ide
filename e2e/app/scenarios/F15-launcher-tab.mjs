#!/usr/bin/env node
// Scenario F15 (launcher v2): the keyboard alone with REAL key presses — the
// Tab path the DOM-event scenario (F15-launcher-keyboard) cannot take. REAL
// app, fake `claude` (tools/fake-agents), no real account.
//
//   run 1  fresh install: the welcome; the taskLauncher flag on; a project.
//   run 2  - ⌘N / Ctrl+Shift+N opens the launcher with the task field focused
//            (nothing is focused by the script).
//          - a real mouse click puts the OS focus in the task field; then,
//            with real key presses only: Tab reaches the agent chip, Tab Tab
//            Tab the approval chip; Return opens its menu on the current mode;
//            Tab moves to Plan first and Return picks it, which closes the
//            menu and gives the task field the keyboard; Return launches.
//          - the agent started with Plan first and the task.
//
// Real OS key presses (xdotool under Xvfb on Linux, SendInput on Windows) run
// on CI runners only and never on macOS: the ledger lists this scenario for
// linux and win32, where CI runs it in the "keys" set with
// HERMES_E2E_OS_KEYS=1. Anywhere else it refuses to run.
//
// Negative control (must end in RESULT: FAIL):
//   HERMES_E2E_CONTROL=one-tab-short   one Tab fewer on the way to the
//                                      approval chip: Return opens the where
//                                      menu instead.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLogger, finishScenario, outDir } from "../harness.mjs";
import { osKeysAvailable, pressChords } from "../os-keys.mjs";
import { completeClassicOnboarding, invoke, launcherFixtures, openLauncher, typeInto, waitForReturningLaunch, waitLaunchEnabled } from "../launcher-steps.mjs";

const SCENARIO = "F15-launcher-tab";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);
const CONTROL = process.env.HERMES_E2E_CONTROL || "";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}
const hasSeq = (argv, seq) => argv.some((_, i) => seq.every((w, j) => argv[i + j] === w));

if (process.env.HERMES_E2E_OS_KEYS !== "1" || !osKeysAvailable()) {
  log("this scenario presses REAL keys: set HERMES_E2E_OS_KEYS=1 on a Linux or Windows CI runner (never on macOS)");
  finishScenario({ scenario: SCENARIO, evidenceDir, failed: true, startedAt, log, details: { reason: "needs real OS key presses (CI, Linux or Windows)" } });
}

const fx = launcherFixtures("f15-tab", log);
let app;
let failed = false;
let undoRegistryPath = null;

/** What has the focus: a chip, a mode option, the task field, or something else. */
const focusNow = (bridge) =>
  bridge.eval(`
    const el = document.activeElement;
    if (!el) return "none";
    if (el.classList.contains("task-launcher-task")) return "task";
    if (el.getAttribute("data-chip")) return "chip:" + el.getAttribute("data-chip");
    if (el.getAttribute("data-mode")) return "mode:" + el.getAttribute("data-mode");
    return el.tagName.toLowerCase() + "." + String(el.className).split(" ")[0];
  `);
const taskFieldCenter = (bridge) =>
  bridge.eval(`
    const r = e2e.first(".task-launcher-task").getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio || 1 };
  `);

async function press(pid, chord, clickAt = null) {
  const diag = await pressChords(pid, [chord], clickAt ? { clickAt } : {});
  if (clickAt) log(`  real key presses go to: ${JSON.stringify(diag)}`);
}
async function expectFocus(bridge, want, what) {
  const got = await bridge
    .waitFor(`focus on ${want}`, `
      const el = document.activeElement;
      const now = !el ? "none" : el.classList.contains("task-launcher-task") ? "task" : el.getAttribute("data-chip") ? "chip:" + el.getAttribute("data-chip") : el.getAttribute("data-mode") ? "mode:" + el.getAttribute("data-mode") : "other";
      return now === ${JSON.stringify(want)} ? now : false;
    `, { timeoutMs: 3_000 })
    .catch(async () => focusNow(bridge));
  assert(got === want, `${what} (focus: ${got})`);
}

try {
  log(`scenario: ${SCENARIO}   input: REAL OS key presses${CONTROL ? `   control: ${CONTROL}` : ""}`);
  undoRegistryPath = fx.addFakeBinToRegistryPath();

  log("run 1: fresh install; the taskLauncher flag; a project");
  app = await fx.launch(evidenceDir, 1, { first: true });
  await completeClassicOnboarding(app.bridge);
  await invoke(app.bridge, "set_setting", { key: "feature_flag_overrides", value: JSON.stringify({ taskLauncher: true }) });
  await invoke(app.bridge, "create_project", { path: fx.repo, name: null });
  await app.stop();

  app = await fx.launch(evidenceDir, 2);
  const { bridge } = app;
  const pid = app.child.pid;
  await waitForReturningLaunch(bridge);
  await openLauncher(bridge);
  assert((await focusNow(bridge)) === "task", "the launcher opens with the task field focused");
  await typeInto(bridge, ".task-launcher-task", "Tab to the chips");
  await waitLaunchEnabled(bridge);

  log("real keys: Tab to the chips, Return, Tab, Return, Escape, Shift+Tab back, Return");
  await press(pid, "tab", await taskFieldCenter(bridge));
  await expectFocus(bridge, "chip:agent", "Tab from the task field reaches the first chip");
  const tabs = CONTROL === "one-tab-short" ? 2 : 3;
  for (let i = 0; i < tabs; i++) await press(pid, "tab");
  await expectFocus(bridge, "chip:approval", `Tab ×${tabs} more reaches the approval chip`);
  await press(pid, "return");
  await bridge.waitFor("the approval menu", `return !!e2e.first('.task-launcher-menu[data-menu="approval"]');`, { timeoutMs: 3_000 });
  await expectFocus(bridge, "mode:acceptEdits", "Return opens the menu on the current mode");
  await press(pid, "tab");
  await expectFocus(bridge, "mode:plan", "Tab moves to Plan first");
  await press(pid, "return");
  await bridge.waitFor("Plan first chosen", `return /^Plan first/.test(e2e.norm(e2e.first('[data-chip="approval"]')?.innerText ?? ""));`, { timeoutMs: 3_000 });
  // A pick closes the menu and gives the task field the keyboard, so the
  // next Return launches (QA SOLO-10).
  await bridge.waitFor("the menu to close", `return !e2e.first(".task-launcher-menu");`, { timeoutMs: 3_000 });
  await expectFocus(bridge, "task", "the pick closes the menu and the task field has the keyboard");
  assert(await bridge.eval(`return !!e2e.first(".task-launcher-sheet");`), "the sheet stays open");
  const n0 = fx.records().length;
  await press(pid, "return");
  await bridge.waitFor("the sheet to close", `return !e2e.first(".task-launcher-sheet");`, { timeoutMs: 30_000 });
  const run = (await fx.waitForRecords(n0 + 1)).at(-1);
  log(`  claude argv: ${JSON.stringify(run.argv.slice(0, 4))}`);
  assert(hasSeq(run.argv, ["--permission-mode", "plan"]) && run.argv.some((a) => String(a).startsWith("Tab to the chips")), "Return launched the task with Plan first");
  await bridge.screenshot(join(evidenceDir, "01-launched.png"));
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

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log, details: { input: "os-keys" } });
