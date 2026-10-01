#!/usr/bin/env node
// Scenario FIX-launcher-draft: what was typed and chosen in the ⌘N launcher
// is never lost by opening configuration from it, or by closing it by
// accident, on the real app with fake `claude` and `codex` CLIs.
//
//   run 1  fresh install, the taskLauncher flag on, one project.
//   run 2  ⌘N: a task, Plan first, opus, effort high, a new worktree cut
//          from develop on a branch typed by hand, + options open with extra
//          arguments and Track as a feature. Then:
//          1. Manage accounts (agent menu) opens Settings > Agents and the
//             launcher goes away; closing Settings brings the launcher back
//             by itself, exactly as it was (task, every chip, the options).
//          2. Settings… from the app menu (⌘, / Ctrl+,) while the launcher is
//             open: the same.
//          3. Esc, then ⌘N: the same draft, marked "Your unsent task is back".
//          4. A click outside, then ⌘N: the same.
//          5. Sign in (the agent signed out): the launcher gives way to the
//             sign-in terminal and comes back as it was once that terminal
//             is closed.
//          6. Start over: a fresh sheet; a launch forgets the draft too.
//
// Negative control (must end in RESULT: FAIL): a build of main before this
// fix — step 1 finds no launcher after Settings closes (the draft was lost).
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/FIX-launcher-draft.mjs

import { mkdirSync, rmSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { createLogger, finishScenario, outDir, sleep, skipScenario } from "../harness.mjs";
import {
  chooseOption,
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
  pressKey,
  setRepo,
  typeInto,
  waitForReturningLaunch,
  waitLaunchEnabled,
  waitLauncherClosed,
  waitLauncherReady,
} from "../launcher-steps.mjs";

const SCENARIO = "FIX-launcher-draft";
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

const fx = launcherFixtures("fix-draft", log);
if (onWindows && !fx.canEditRegistryPath) {
  log("this scenario needs the fake agents on a Windows terminal's PATH (the user's registry Path); that is only changed on a CI runner");
  skipScenario({ scenario: SCENARIO, evidenceDir, reason: "Windows outside CI", log });
}

const TASK = "Build the failure notification";
const BRANCH = "hermes/failure-notice-by-hand";

/** Everything the draft is: the task, every chip, the options and their fields. */
const fullState = async (bridge) => {
  // "Hermes will run" is worked out after the sheet opens: wait for it.
  await bridge.waitFor("the launcher's command line", `return e2e.norm(e2e.first(".task-launcher-command")?.textContent ?? "") !== "";`, { timeoutMs: 20_000 });
  const st = await launcherState(bridge);
  const opts = await bridge.eval(`
    const o = e2e.first(".task-launcher-options");
    return {
      expanded: !!o,
      extraArgs: e2e.first(".task-launcher-extra-args")?.value ?? null,
      track: !!e2e.first(".task-launcher-feature-box")?.checked,
      branch: e2e.first(".task-launcher-branch")?.value ?? null,
    };
  `);
  return { task: st.task, agent: st.agent, project: st.project, where: st.where, approval: st.approval, model: st.model, effort: st.effort, preview: st.preview, ...opts };
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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

  log("step 0: a task and its choices");
  await openLauncher(bridge);
  await setRepo(bridge, fx.repo);
  await typeInto(bridge, ".task-launcher-task", TASK);
  await pickInMenu(bridge, "approval", '[data-mode="plan"]');
  await pickInMenu(bridge, "model", '[data-model-id="opus"]');
  await pickInMenu(bridge, "effort", '[data-effort="high"]');
  await openChip(bridge, "where");
  await chooseOption(bridge, ".task-launcher-menu .task-launcher-base", "develop");
  await expandOptions(bridge);
  await typeInto(bridge, ".task-launcher-extra-args", "--draft-proof");
  await bridge.click(".task-launcher-feature-box");
  await typeInto(bridge, ".task-launcher-branch", BRANCH);
  await sleep(400);
  const draft = await fullState(bridge);
  log(`  draft: ${JSON.stringify(draft)}`);
  assert(draft.task === TASK && /^Plan first/.test(draft.approval) && /model: opus/.test(draft.model) && /effort: high/.test(draft.effort), "the task and its chips are set");
  assert(draft.expanded && draft.extraArgs === "--draft-proof" && draft.track && draft.branch === BRANCH && /from develop/.test(draft.preview), "and the options: extra arguments, Track as a feature, a hand-typed branch from develop");
  await bridge.screenshot(join(evidenceDir, "00-draft.png"));

  log("step 1: Manage accounts opens Settings > Agents; closing it brings the launcher back as it was");
  await openChip(bridge, "agent");
  await bridge.click(".task-launcher-manage-accounts");
  await bridge.waitFor("Settings > Agents, with the launcher gone", `
    const tab = e2e.all('.settings-tab[aria-selected="true"], .settings-tab.active').map((t) => e2e.norm(t.innerText));
    return !!e2e.first(".settings-title") && !e2e.first(".task-launcher-sheet") && tab.includes("Agents");
  `, { timeoutMs: 20_000 });
  await bridge.screenshot(join(evidenceDir, "01-settings-agents.png"));
  await bridge.click(".settings-close");
  await bridge.waitFor("Settings to close", `return !e2e.first(".settings-title");`);
  await waitLauncherReady(bridge);
  let back = await fullState(bridge);
  log(`  back: ${JSON.stringify(back)}`);
  assert(same(back, draft), "the launcher came back by itself, exactly as it was");
  assert(await bridge.exists(".task-launcher-restored"), "and says the unsent task is back");
  await bridge.screenshot(join(evidenceDir, "01b-back-after-settings.png"));

  log("step 2: Settings… from the app menu (⌘, / Ctrl+,) while the launcher is open");
  await bridge.chooseMenuItem("hermes.settings");
  await bridge.waitFor("Settings from the app menu, with the launcher gone", `return !!e2e.first(".settings-title") && !e2e.first(".task-launcher-sheet");`, { timeoutMs: 20_000 });
  await bridge.click(".settings-close");
  await waitLauncherReady(bridge);
  assert(same(await fullState(bridge), draft), "the app menu's Settings…: the launcher comes back as it was");

  log("step 3: Esc closes it; ⌘N brings the draft back");
  await pressKey(bridge, ".task-launcher-task", "Escape");
  await waitLauncherClosed(bridge);
  await openLauncher(bridge, { draft: "keep" });
  back = await fullState(bridge);
  assert(same(back, draft), `after Esc, ⌘N brings back the same draft (${JSON.stringify(back)})`);
  assert(await bridge.exists(".task-launcher-restored .task-launcher-start-over"), "with Start over offered");

  log("step 4: a click outside; ⌘N brings it back");
  await bridge.eval(`
    const overlay = e2e.must(e2e.first(".task-launcher-overlay"), "overlay");
    overlay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    return true;
  `);
  await waitLauncherClosed(bridge);
  await openLauncher(bridge, { draft: "keep" });
  assert(same(await fullState(bridge), draft), "after a click outside, the same draft");
  await bridge.screenshot(join(evidenceDir, "04-restored.png"));

  log("step 5: Sign in gives way to the sign-in terminal; closing it brings the launcher back");
  fx.setFake("auth-claude", "out");
  await pressKey(bridge, ".task-launcher-task", "Escape");
  await waitLauncherClosed(bridge);
  await openLauncher(bridge, { draft: "keep" });
  await bridge.waitFor("the signed-out row with Sign in", `return !!e2e.first('.task-launcher-block[data-kind="signed-out"] .task-launcher-sign-in');`, { timeoutMs: 40_000 });
  const before = await bridge.terminalIds();
  await bridge.click('.task-launcher-block[data-kind="signed-out"] .task-launcher-sign-in');
  const [signInId] = await newTerminals(bridge, before, 1, "the sign-in terminal");
  await waitLauncherClosed(bridge);
  assert(true, `the launcher gave way to the sign-in terminal ${signInId.slice(0, 8)}`);
  // The person closes it once it is up (the agent's CLI is running in it).
  await bridge.waitForTerminal(signInId, /fake-cli|logged in|log in/i, { timeoutMs: 60_000 });
  fx.setFake("auth-claude", "in");
  await invoke(bridge, "close_session", { sessionId: signInId });
  await waitLauncherReady(bridge);
  back = await fullState(bridge);
  assert(same(back, draft), `the sign-in terminal closed: the launcher is back as it was (${JSON.stringify(back)})`);

  log("step 6: Start over; a launch forgets the draft too");
  await bridge.click(".task-launcher-start-over");
  await bridge.waitFor("a fresh launcher", `return !e2e.first(".task-launcher-restored") && e2e.first(".task-launcher")?.getAttribute("data-ready") === "true";`, { timeoutMs: 30_000 });
  const fresh = await launcherState(bridge);
  assert(fresh.task === "" && /^Accept edits/.test(fresh.approval) && /model: default/.test(fresh.model), `Start over: an empty task and the starting choice (${fresh.approval}, ${fresh.model})`);
  await setRepo(bridge, fx.repo);
  await typeInto(bridge, ".task-launcher-task", "A task that launches");
  await waitLaunchEnabled(bridge);
  const t0 = await bridge.terminalIds();
  await bridge.click(".task-launcher-launch");
  await newTerminals(bridge, t0, 1, "the launched agent");
  await waitLauncherClosed(bridge);
  await openLauncher(bridge, { draft: "keep" });
  const after = await launcherState(bridge);
  assert(after.task === "" && !(await bridge.exists(".task-launcher-restored")), "after a launch ⌘N opens a fresh launcher");

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
