#!/usr/bin/env node
// Scenario FIX-launcher-safety: Skip all is never picked for the person, and
// plan mode is findable, on the real app with fake `claude` and `codex`.
//
//   run 1  fresh install (no launch history), the taskLauncher flag on.
//   run 2  1. ⌘N on a fresh profile: Claude starts in its safety default,
//             Accept edits; the approval chip says what that mode does.
//          2. The approval menu says Plan first is Claude's own plan mode
//             (and that Track as a feature is something else).
//          3. Skip all, chosen by hand, is said in red in the chip row itself
//             (menu closed, options closed); with Track as a feature it adds
//             that the gates then rely on the agent stopping.
//          4. + options: the row is "Feature track", and its note says it is
//             not Claude's plan mode.
//          5. A launch in Skip all runs with --permission-mode
//             bypassPermissions (the person chose it).
//          6. The next ⌘N: the usual combination comes back without Skip all
//             (Accept edits, and a note says Skip all is never picked for
//             you); nor does switching back to Claude bring it back; nor a
//             Settings default of Skip all.
//
// Negative control (must end in RESULT: FAIL): a build of main before this
// fix — step 3 finds no warning in the chip row.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/FIX-launcher-safety.mjs

import { mkdirSync, rmSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { createLogger, finishScenario, outDir, sleep, skipScenario } from "../harness.mjs";
import {
  completeClassicOnboarding,
  expandOptions,
  invoke,
  launcherFixtures,
  launcherState,
  newTerminals,
  onWindows,
  openChip,
  openLauncher,
  pickInMenu,
  setRepo,
  typeInto,
  waitForReturningLaunch,
  waitLaunchEnabled,
  waitLauncherClosed,
} from "../launcher-steps.mjs";

const SCENARIO = "FIX-launcher-safety";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}
const hasSeq = (argv, seq) => argv.some((_, i) => seq.every((w, j) => argv[i + j] === w));

const fx = launcherFixtures("fix-safety", log);
if (onWindows && !fx.canEditRegistryPath) {
  log("this scenario needs the fake agents on a Windows terminal's PATH (the user's registry Path); that is only changed on a CI runner");
  skipScenario({ scenario: SCENARIO, evidenceDir, reason: "Windows outside CI", log });
}

let app;
let failed = false;
let undoRegistryPath = null;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}`);
  undoRegistryPath = fx.addFakeBinToRegistryPath();

  log("run 1: fresh install; the launcher flag; one project");
  app = await fx.launch(evidenceDir, 1, { first: true });
  await completeClassicOnboarding(app.bridge);
  await invoke(app.bridge, "set_setting", { key: "feature_flag_overrides", value: JSON.stringify({ taskLauncher: true }) });
  await invoke(app.bridge, "create_project", { path: fx.repo, name: null });
  await app.stop();

  app = await fx.launch(evidenceDir, 2);
  const { bridge } = app;
  await waitForReturningLaunch(bridge);

  log("step 1: a fresh profile starts in Claude's safety default");
  await openLauncher(bridge);
  await setRepo(bridge, fx.repo);
  let st = await launcherState(bridge);
  log(`  launcher: ${JSON.stringify({ agent: st.agent, approval: st.approval, danger: st.approvalDanger })}`);
  assert(/^Claude Code/.test(st.agent) && /^Accept edits/.test(st.approval) && !st.approvalDanger, `Claude, Accept edits, not Skip all (${st.approval})`);
  assert(!(await bridge.exists(".task-launcher-danger-warning")), "no warning");
  const title = await bridge.eval(`return e2e.first('[data-chip="approval"]')?.getAttribute("title") ?? "";`);
  assert(/^Approval: Accept edits\. Edits inside the worktree run/.test(title), `the approval chip says what its mode does ("${title}")`);

  log("step 2: the approval menu says where Claude's plan mode is");
  await openChip(bridge, "approval");
  const hint = await bridge.text(".task-launcher-plan-hint");
  assert(/^Plan first is Claude Code's own plan mode: it plans and changes nothing until you approve\. For Hermes's phased workflow, use Track as a feature/.test(hint.trim()), `Plan first is named as Claude's plan mode ("${hint.trim()}")`);
  await bridge.screenshot(join(evidenceDir, "02-plan-hint.png"));

  log("step 3: Skip all, chosen by hand, is said in red in the chip row");
  await bridge.click('.task-launcher-approval-modes [data-mode="bypassPermissions"]');
  // A pick closes the menu (QA-launcher-10); Esc closes it if it is still open.
  await bridge.eval(`e2e.first(".task-launcher-menu")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); return true;`);
  await bridge.waitFor("the menu to close", `return !e2e.first(".task-launcher-menu");`);
  const warning = await bridge.eval(`
    const w = e2e.first(".task-launcher-danger-warning");
    return w ? { text: e2e.norm(w.innerText), afterChips: !!w.previousElementSibling?.classList.contains("task-launcher-chips"), color: getComputedStyle(w).color, options: !!e2e.first(".task-launcher-options") } : null;
  `);
  log(`  warning: ${JSON.stringify(warning)}`);
  assert(warning && /Skip all/.test(warning.text) && /will run every command and edit without asking you/.test(warning.text), "a warning says what Skip all does");
  assert(warning.afterChips && !warning.options, "right under the chips, with no menu and no options open");
  await bridge.screenshot(join(evidenceDir, "03-skip-all-warning.png"));

  log("step 4: + options — Feature track, not Claude's plan mode");
  await expandOptions(bridge);
  const labels = await bridge.eval(`return e2e.all(".task-launcher-opt-label").map((l) => e2e.norm(l.innerText));`);
  assert(labels.includes("Feature track") && !labels.includes("Planning"), `the row is called Feature track (${JSON.stringify(labels)})`);
  const note = await bridge.eval(`return e2e.norm(e2e.first(".task-launcher-feature").innerText);`);
  assert(/Not the same as Claude Code's own plan mode \(Approval › Plan first\)/.test(note), `and says it is not Claude's plan mode ("${note}")`);
  await bridge.click(".task-launcher-feature-box");
  await sleep(200);
  const withTrack = await bridge.text(".task-launcher-danger-warning");
  assert(/gates then rely on the agent stopping by itself/.test(withTrack), `with Track as a feature, the warning says the gates rely on the agent ("${withTrack.trim()}")`);
  await bridge.click(".task-launcher-feature-box");
  await bridge.screenshot(join(evidenceDir, "04-feature-track.png"));

  log("step 5: a launch in Skip all (the person's choice)");
  await typeInto(bridge, ".task-launcher-task", "Tidy the logs");
  await waitLaunchEnabled(bridge);
  const t0 = await bridge.terminalIds();
  const n0 = fx.records().length;
  await bridge.click(".task-launcher-launch");
  await newTerminals(bridge, t0, 1, "the launched agent");
  await waitLauncherClosed(bridge);
  const rec = (await fx.waitForRecords(n0 + 1)).at(-1);
  assert(hasSeq(rec.argv, ["--permission-mode", "bypassPermissions"]), "claude ran with --permission-mode bypassPermissions");

  log("step 6: the next ⌘N does not bring Skip all back by itself");
  await openLauncher(bridge);
  st = await launcherState(bridge);
  const dropped = await bridge.eval(`return e2e.norm(e2e.first(".task-launcher-danger-dropped")?.innerText ?? "");`);
  log(`  launcher: ${JSON.stringify({ approval: st.approval, danger: st.approvalDanger, dropped })}`);
  assert(/^Accept edits/.test(st.approval) && !st.approvalDanger, `the usual combination comes back in Accept edits, not Skip all (${st.approval})`);
  assert(/is never picked for you: choose it in Approval if this task needs it/.test(dropped), `and says why ("${dropped}")`);
  await bridge.screenshot(join(evidenceDir, "06-not-carried.png"));
  await pickInMenu(bridge, "agent", '[data-agent-id="codex"]');
  await sleep(500);
  await pickInMenu(bridge, "agent", '[data-agent-id="claude"]');
  await sleep(800);
  st = await launcherState(bridge);
  assert(!st.approvalDanger && !/Skip all/.test(st.approval), `switching back to Claude does not bring its last Skip all (${st.approval})`);
  await invoke(bridge, "set_setting", { key: "default_permission_mode", value: "bypassPermissions" });
  // Esc closes the agent menu first, then the sheet.
  for (let i = 0; i < 2; i++) await bridge.eval(`e2e.first(".task-launcher-task")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); return true;`);
  await waitLauncherClosed(bridge);
  await openLauncher(bridge);
  st = await launcherState(bridge);
  assert(/^Accept edits/.test(st.approval) && !st.approvalDanger, `nor a Settings default of Skip all (${st.approval})`);

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
