#!/usr/bin/env node
// Scenario F15 (launcher v2): how the ⌘N launcher flows through a day, on
// the REAL app with fake `claude` CLIs (tools/fake-agents). No real account.
//
//   run 1  fresh install: the welcome; the taskLauncher flag on; two
//          projects registered (the other one first).
//   run 2  - Launch & next (⌘⏎): two tasks one after the other; the sheet
//            stays open with the same choice and an empty task; both agents
//            start with the chosen model.
//          - the draft survives a click outside the sheet (⌘N brings it
//            back); Esc cancels it.
//          - Recent: the last tasks, one click puts one back.
//          - the project list: the one used most comes first.
//          - the running-agents cap (Settings > Limits = 2): a third task
//            waits ("waits for a free slot"), nothing starts; when one
//            agent quits, the queued task starts on its own.
//
// Negative control (must end in RESULT: FAIL):
//   HERMES_E2E_LAUNCHER_CAP=off   no cap: the third task starts at once.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F15-launcher-flow.mjs

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLogger, finishScenario, outDir, sleep, skipScenario } from "../harness.mjs";
import { setCapInSettings } from "../fleet-steps.mjs";
import {
  MOD,
  completeClassicOnboarding,
  invoke,
  launcherFixtures,
  launcherState,
  newTerminals,
  onWindows,
  openChip,
  openLauncher,
  pickInMenu,

  pressKey,
  setRepo,
  typeInto,
  waitForReturningLaunch,
  waitLaunchEnabled,
} from "../launcher-steps.mjs";

const SCENARIO = "F15-launcher-flow";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);
const CAP_ON = (process.env.HERMES_E2E_LAUNCHER_CAP || "on") !== "off";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}
const hasSeq = (argv, seq) => argv.some((_, i) => seq.every((w, j) => argv[i + j] === w));

const fx = launcherFixtures("f15-flow", log);
if (onWindows && !fx.canEditRegistryPath) {
  log("this scenario needs the fake agents on a Windows terminal's PATH (the user's registry Path); that is only changed on a CI runner");
  skipScenario({ scenario: SCENARIO, evidenceDir, reason: "Windows outside CI", log });
}

let app;
let failed = false;
let undoRegistryPath = null;

try {
  log(`scenario: ${SCENARIO}   cap: ${CAP_ON ? "2" : "OFF (negative control)"}`);
  undoRegistryPath = fx.addFakeBinToRegistryPath();

  log("run 1: fresh install; the taskLauncher flag; two projects (the other one first)");
  app = await fx.launch(evidenceDir, 1, { first: true });
  await completeClassicOnboarding(app.bridge);
  await invoke(app.bridge, "set_setting", { key: "feature_flag_overrides", value: JSON.stringify({ taskLauncher: true }) });
  await invoke(app.bridge, "create_project", { path: fx.otherRepo, name: null });
  await invoke(app.bridge, "create_project", { path: fx.repo, name: null });
  await app.stop();

  app = await fx.launch(evidenceDir, 2);
  const { bridge } = app;
  await waitForReturningLaunch(bridge);

  log("step 1: Launch & next keeps the sheet open, same choice, empty task");
  await openLauncher(bridge);
  await setRepo(bridge, fx.repo);
  await pickInMenu(bridge, "model", '[data-model-id="sonnet"]');
  const before = await bridge.terminalIds();
  for (const [i, task] of ["Task one", "Task two"].entries()) {
    await typeInto(bridge, ".task-launcher-task", task);
    await waitLaunchEnabled(bridge);
    await pressKey(bridge, ".task-launcher-task", "Enter", MOD);
    await bridge.waitFor(`launch ${i + 1} to be counted`, `return new RegExp("Launched ${i + 1}\\\\b").test(e2e.first(".task-launcher-launched")?.innerText ?? "");`, { timeoutMs: 30_000 });
    const st = await launcherState(bridge);
    assert(st.open && st.task === "" && /model: sonnet/.test(st.model), `after launch ${i + 1} the sheet is still open, the task is empty, sonnet is kept`);
  }
  const started = await newTerminals(bridge, before, 2, "two agents");
  const recs = await fx.waitForRecords(2);
  assert(recs.every((r) => hasSeq(r.argv, ["--model", "sonnet"])), "both agents started with --model sonnet");
  assert(recs.some((r) => r.argv.some((a) => String(a).startsWith("Task one"))) && recs.some((r) => r.argv.some((a) => String(a).startsWith("Task two"))), "each with its own task");
  await bridge.screenshot(join(evidenceDir, "01-launch-and-next.png"));

  log("step 2: a click outside keeps the draft; Esc cancels it");
  await typeInto(bridge, ".task-launcher-task", "Half-written task");
  await bridge.eval(`
    const overlay = e2e.must(e2e.first(".task-launcher-overlay"), "overlay");
    overlay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    return true;
  `);
  await bridge.waitFor("the sheet to close", `return !e2e.first(".task-launcher-sheet");`);
  await openLauncher(bridge);
  let st = await launcherState(bridge);
  assert(st.task === "Half-written task" && /model: sonnet/.test(st.model), "⌘N brings the draft back");
  await pressKey(bridge, ".task-launcher-task", "Escape");
  await bridge.waitFor("the sheet to close", `return !e2e.first(".task-launcher-sheet");`);
  await openLauncher(bridge);
  st = await launcherState(bridge);
  assert(st.task === "", "after Esc the draft is gone");

  log("step 3: Recent");
  const recents = await bridge.eval(`return e2e.all(".task-launcher-recent").map((b) => e2e.norm(b.innerText));`);
  assert(JSON.stringify(recents) === JSON.stringify(["Task two", "Task one"]), `Recent: ${JSON.stringify(recents)}`);
  await bridge.eval(`return e2e.click(e2e.all(".task-launcher-recent").find((b) => e2e.norm(b.innerText) === "Task one"));`);
  assert((await launcherState(bridge)).task === "Task one", "a click on it puts the task back");

  log("step 4: projects, most used first");
  await openChip(bridge, "project");
  const order = await bridge.eval(`return e2e.all(".task-launcher-menu [data-project-path]").map((b) => b.getAttribute("data-project-path"));`);
  log(`  projects: ${JSON.stringify(order)}`);
  assert(order.length >= 2 && fx.samePath(order[0], fx.repo), "the repository used twice comes before the one registered first");
  await pressKey(bridge, ".task-launcher-task", "Escape");
  await pressKey(bridge, ".task-launcher-task", "Escape");
  await bridge.waitFor("the sheet to close", `return !e2e.first(".task-launcher-sheet");`);

  log(`step 5: the running-agents cap (${CAP_ON ? "2" : "none"})`);
  if (CAP_ON) await setCapInSettings(bridge, log, "maxRunning", 2);
  await bridge.eval(`document.querySelector('[role="dialog"] .settings-close, .settings-close')?.click(); return true;`);
  // Both agents get to work (an idle agent does not hold a slot).
  /** Shows a session (its terminal) by clicking it in the session list. */
  const show = async (label, id) => {
    await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.all(".session-item").find((el) => el.innerText.includes(${JSON.stringify(label)})), ${JSON.stringify(label)}));`);
    await bridge.waitFor(`the terminal of "${label}"`, `return !!document.querySelector('div[data-session-id="${id}"] textarea.xterm-helper-textarea');`, { timeoutMs: 20_000 });
  };
  const labelOf = async (id) => bridge.eval(`return (await window.__TAURI_INTERNALS__.invoke("get_sessions")).find((s) => s.id === ${JSON.stringify(id)})?.label ?? null;`);
  for (const id of started) {
    await show(await labelOf(id), id);
    await bridge.typeInTerminal(id, "w");
  }
  await bridge.waitFor("both agents working", `
    const kinds = ${JSON.stringify(started)}.map((id) => window.__HERMES_E2E__.sessionEventSnapshot(id).status.kind);
    return kinds.every((k) => k === "working") ? kinds : null;
  `, { timeoutMs: 20_000 });
  // The queue counts what the agents themselves report (their hooks), not
  // the terminal's guess above, which can come first: until both hold their
  // slot, a third task would still start.
  await bridge.waitFor("both agents holding a slot", `
    const held = window.__HERMES_E2E__.fleetState().occupancy.sessionIds;
    return ${JSON.stringify(started)}.every((id) => held.includes(id)) ? held : null;
  `, { timeoutMs: 20_000 });
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "Queued task");
  await waitLaunchEnabled(bridge);
  const n0 = fx.records().length;
  await pressKey(bridge, ".task-launcher-task", "Enter", MOD);
  await bridge.waitFor("the launch to be counted", `return /Launched 1\\b/.test(e2e.first(".task-launcher-launched")?.innerText ?? "");`, { timeoutMs: 30_000 });
  const note = await bridge.eval(`return e2e.norm(e2e.first(".task-launcher-queued")?.innerText ?? "");`);
  assert(/waits for a free slot/.test(note), `the launcher says it waits: "${note}"`);
  await sleep(3000);
  assert(fx.records().length === n0, "nothing started while no slot is free");
  await pressKey(bridge, ".task-launcher-task", "Escape");
  await bridge.screenshot(join(evidenceDir, "02-queued.png"));
  log("  one agent quits");
  await show(await labelOf(started[0]), started[0]);
  await bridge.typeInTerminal(started[0], "q");
  const next = (await fx.waitForRecords(n0 + 1, 45_000)).at(-1);
  assert(next.argv.some((a) => String(a).startsWith("Queued task")) && hasSeq(next.argv, ["--model", "sonnet"]), "the queued task started on its own when the slot freed, with its choice");
  await bridge.screenshot(join(evidenceDir, "03-queued-started.png"));
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
