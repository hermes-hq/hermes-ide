#!/usr/bin/env node
// Scenario F15 (launcher v2): the usual combination and presets, on the REAL
// app with fake `claude` and `codex` CLIs (tools/fake-agents). No real account.
//
//   run 1  fresh install: the welcome; the taskLauncher flag on; a project.
//   run 2  - the same combination (Claude, Plan first, sonnet) launched three
//            times: the third time the launcher asks, inline, "Save as
//            preset?". It is left unanswered and the sheet closed; ⌘N again
//            opens on that usual combination and a 4th identical launch does
//            not ask again (offered once). "Save as preset…" saves it.
//          - ⌘N again: the preset chip is there and selected, and the
//            launcher opens pre-set to that usual combination.
//          - "Save as preset…" saves a second one (Codex, its fake catalog's
//            gpt-fake-luna, max).
//          - ⌘2 applies preset 2 and keeps the task text; Enter launches it:
//            codex runs with that model and effort.
//          - a preset whose parts the agent no longer has (a retired model,
//            an effort and a mode Codex does not offer): ⌘3 shows the warning
//            and the fallback (default model, nearest effort, the safety
//            default), and what launches is the fallback, never the stale
//            choice.
//          - a preset cut from a branch this repository does not have
//            (release/gone): ⌘4 warns, the base falls back to the current
//            branch, and Enter starts the agent in a worktree cut from main.
//          - ⌘1 applies preset 1 again.
//          - Settings > Agents lists the presets, renames and deletes.
//
// Negative controls (each must end in RESULT: FAIL):
//   HERMES_E2E_LAUNCHER_FLAG=off         the taskLauncher flag stays off.
//   HERMES_E2E_CONTROL=new-combination   before the 4th launch, three launches
//                                        of a combination never offered: the
//                                        question legitimately comes back, so
//                                        "not asked again" must fail.
//   HERMES_E2E_CONTROL=base-exists       the base-branch preset uses develop,
//                                        which exists: "warns" must fail.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F15-launcher-presets.mjs

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLogger, finishScenario, outDir } from "../harness.mjs";
import {
  MOD,
  completeClassicOnboarding,
  invoke,
  launcherFixtures,
  launcherState,
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

const SCENARIO = "F15-launcher-presets";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);
const FLAG_ON = (process.env.HERMES_E2E_LAUNCHER_FLAG || "on") !== "off";
const CONTROL = process.env.HERMES_E2E_CONTROL || "";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}
const hasSeq = (argv, seq) => argv.some((_, i) => seq.every((w, j) => argv[i + j] === w));
/** Codex's effort setting, with or without the TOML quotes around the level. */
const codexEffort = (argv, level) => argv.some((a, i) => a === "-c" && new RegExp(`^model_reasoning_effort="?${level}"?$`).test(argv[i + 1] ?? ""));
const CODEX_MODEL = "gpt-fake-luna";

const fx = launcherFixtures("f15-presets", log);
if (onWindows && !fx.canEditRegistryPath) {
  log("this scenario needs the fake agents on a Windows terminal's PATH (the user's registry Path); that is only changed on a CI runner");
  log("RESULT: SKIP (Windows outside CI)");
  process.exit(0);
}

let app;
let failed = false;
let undoRegistryPath = null;

async function launchAndNext(bridge, task, count) {
  await typeInto(bridge, ".task-launcher-task", task);
  await waitLaunchEnabled(bridge);
  const n0 = fx.records().length;
  await pressKey(bridge, ".task-launcher-task", "Enter", MOD);
  await bridge.waitFor(`launch ${count}`, `return new RegExp("Launched ${count}\\\\b").test(e2e.first(".task-launcher-launched")?.innerText ?? "");`, { timeoutMs: 30_000 });
  return (await fx.waitForRecords(n0 + 1)).at(-1);
}

try {
  log(`scenario: ${SCENARIO}   flag: ${FLAG_ON ? "on" : "OFF (negative control)"}${CONTROL ? `   control: ${CONTROL}` : ""}`);
  undoRegistryPath = fx.addFakeBinToRegistryPath();

  log("run 1: fresh install; the taskLauncher flag; a project");
  app = await fx.launch(evidenceDir, 1, { first: true });
  await completeClassicOnboarding(app.bridge);
  await invoke(app.bridge, "set_setting", { key: "feature_flag_overrides", value: JSON.stringify(FLAG_ON ? { taskLauncher: true } : {}) });
  await invoke(app.bridge, "create_project", { path: fx.repo, name: null });
  await app.stop();

  app = await fx.launch(evidenceDir, 2);
  const { bridge } = app;
  await waitForReturningLaunch(bridge);

  log("step 1: the same combination three times; the third asks to save it, once");
  await openLauncher(bridge);
  await setRepo(bridge, fx.repo);
  await openChip(bridge, "approval");
  await bridge.click('.task-launcher-approval-modes [data-mode="plan"]');
  await pickInMenu(bridge, "model", '[data-model-id="sonnet"]');
  for (const [i, task] of ["First of three", "Second of three"].entries()) {
    await launchAndNext(bridge, task, i + 1);
    assert((await launcherState(bridge)).suggest === "", `no suggestion after ${i + 1} launch${i ? "es" : ""}`);
  }
  const third = await launchAndNext(bridge, "Third of three", 3);
  assert(hasSeq(third.argv, ["--permission-mode", "plan"]) && hasSeq(third.argv, ["--model", "sonnet"]), "the third launch has the same combination");
  let st = await launcherState(bridge);
  log(`  suggestion: "${st.suggest}"`);
  assert(/You launched this combination 3 times/.test(st.suggest), "Save as preset? is offered, inline");
  await bridge.screenshot(join(evidenceDir, "01-save-as-preset.png"));

  log("step 1b: left unanswered; the sheet closed and opened again; a 4th identical launch does not ask again");
  await pressKey(bridge, ".task-launcher-task", "Escape");
  await bridge.waitFor("the sheet to close", `return !e2e.first(".task-launcher-sheet");`);
  await openLauncher(bridge);
  st = await launcherState(bridge);
  assert(st.suggest === "", "reopening does not ask");
  assert(/^Plan first/.test(st.approval) && /model: sonnet/.test(st.model), `the usual combination is preselected (${st.approval} | ${st.model})`);
  if (CONTROL === "new-combination") {
    log("  CONTROL new-combination: three launches of a combination never offered (effort high)");
    await pickInMenu(bridge, "effort", '[data-effort="high"]');
    for (const [i, task] of ["Control one", "Control two", "Control three"].entries()) await launchAndNext(bridge, task, i + 1);
  }
  const fourth = await launchAndNext(bridge, "Fourth of the same", CONTROL === "new-combination" ? 4 : 1);
  assert(hasSeq(fourth.argv, ["--permission-mode", "plan"]) && hasSeq(fourth.argv, ["--model", "sonnet"]), "the 4th launch is the same combination");
  st = await launcherState(bridge);
  log(`  suggestion after the 4th launch: "${st.suggest}"`);
  assert(st.suggest === "", "the question is not asked again");
  await bridge.click(".task-launcher-save-preset");
  await bridge.waitFor("the preset name field", `return !!e2e.first(".task-launcher-preset-name");`);
  await typeInto(bridge, ".task-launcher-preset-name", "Sonnet plan");
  await pressKey(bridge, ".task-launcher-preset-name", "Enter");
  await bridge.waitFor("the preset chip", `return e2e.all(".task-launcher-preset").some((b) => /Sonnet plan/.test(b.innerText));`);
  await pressKey(bridge, ".task-launcher-task", "Escape");
  await bridge.waitFor("the sheet to close", `return !e2e.first(".task-launcher-sheet");`);

  log("step 2: ⌘N opens on the usual combination, with the preset chip selected");
  await openLauncher(bridge);
  st = await launcherState(bridge);
  log(`  launcher: ${JSON.stringify({ presets: st.presets, agent: st.agent, approval: st.approval, model: st.model })}`);
  assert(st.presets.length === 1 && /Sonnet plan/.test(st.presets[0].name) && st.presets[0].selected, "the preset chip is there and selected");
  assert(/^Claude Code/.test(st.agent) && /^Plan first/.test(st.approval) && /model: sonnet/.test(st.model), "the usual combination is preselected");
  await bridge.screenshot(join(evidenceDir, "02-usual-and-preset.png"));

  log("step 3: Save as preset… a second one");
  await pickInMenu(bridge, "agent", '[data-agent-id="codex"]');
  await pickInMenu(bridge, "model", `[data-model-id="${CODEX_MODEL}"]`);
  await pickInMenu(bridge, "effort", '[data-effort="max"]');
  await bridge.click(".task-launcher-save-preset");
  await bridge.waitFor("the preset name field", `return !!e2e.first(".task-launcher-preset-name");`);
  await typeInto(bridge, ".task-launcher-preset-name", "Codex luna");
  await pressKey(bridge, ".task-launcher-preset-name", "Enter");
  await bridge.waitFor("two presets", `return e2e.all(".task-launcher-preset").length === 2;`);

  log("step 4: ⌘2 applies preset 2 and keeps the task");
  await pickInMenu(bridge, "agent", '[data-agent-id="claude"]');
  await pickInMenu(bridge, "model", '[data-model-id="haiku"]');
  await typeInto(bridge, ".task-launcher-task", "Keep this task text");
  await pressKey(bridge, ".task-launcher-task", "2", MOD);
  await bridge.waitFor("preset 2 applied", `return e2e.first('[data-chip="model"]')?.innerText.includes(${JSON.stringify(CODEX_MODEL)});`);
  st = await launcherState(bridge);
  assert(/^Codex/.test(st.agent) && /effort: max/.test(st.effort) && st.task === "Keep this task text", `Codex · luna · max, and the task is kept (${st.agent}, ${st.model}, ${st.effort})`);
  await waitLaunchEnabled(bridge);
  let n0 = fx.records().length;
  await pressKey(bridge, ".task-launcher-task", "Enter");
  const codexRun = (await fx.waitForRecords(n0 + 1)).at(-1);
  log(`  codex argv: ${JSON.stringify(codexRun.argv)}`);
  assert(hasSeq(codexRun.argv, ["-m", CODEX_MODEL]) && codexEffort(codexRun.argv, "max"), "codex ran with preset 2's model and effort");

  log("step 5: a preset the agent can no longer run falls back, with a warning");
  // What a CLI update leaves behind: a preset of a model that is gone, with
  // an effort and a mode Codex does not offer (stored as it was saved).
  const saved = await invoke(bridge, "list_launch_presets");
  await invoke(bridge, "save_launch_preset", {
    name: "Old codex",
    choice: { ...saved[1].choice, approvalModeId: "plan", modelId: "gpt-4-retired", effort: "ultra" },
  });
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "Run the stale preset");
  await pressKey(bridge, ".task-launcher-task", "3", MOD);
  await bridge.waitFor("the warning", `return !!e2e.first(".task-launcher-fallback");`);
  st = await launcherState(bridge);
  log(`  fallback: ${JSON.stringify(st.fallback)}; chips: ${st.agent} | ${st.approval} | ${st.model} | ${st.effort}`);
  const fields = st.fallback.map((f) => f.field);
  assert(fields.includes("model") && fields.includes("approval"), `the warning names what is gone: ${JSON.stringify(fields)}`);
  assert(/model: default/.test(st.model) && /^Auto/.test(st.approval), "and shows the fallback: the default model, the safety default");
  const shownEffort = (st.effort.match(/effort: (\S+)/) ?? [])[1] ?? null;
  log(`  effort after the fallback: ${st.effort}`);
  await bridge.screenshot(join(evidenceDir, "03-stale-preset.png"));
  await waitLaunchEnabled(bridge);
  n0 = fx.records().length;
  await pressKey(bridge, ".task-launcher-task", "Enter");
  const staleRun = (await fx.waitForRecords(n0 + 1)).at(-1);
  log(`  codex argv: ${JSON.stringify(staleRun.argv)}`);
  assert(!staleRun.argv.includes("gpt-4-retired") && !staleRun.argv.includes("-m"), "the retired model was never passed");
  assert(
    shownEffort && shownEffort !== "default" ? codexEffort(staleRun.argv, shownEffort) : !staleRun.argv.some((a) => /model_reasoning_effort/.test(String(a))),
    `the effort the launcher showed is the one passed (${shownEffort})`,
  );
  assert(hasSeq(staleRun.argv, ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"]), "and Codex's own Auto mode");

  log("step 5b: a preset cut from a branch this repository does not have");
  const staleBase = CONTROL === "base-exists" ? "develop" : "release/gone";
  if (CONTROL === "base-exists") log("  CONTROL base-exists: the preset's base is develop, which exists");
  const presetsNow = await invoke(bridge, "list_launch_presets");
  await invoke(bridge, "save_launch_preset", {
    name: "Release fix",
    choice: { ...presetsNow[0].choice, where: { kind: "new-worktree", baseBranch: staleBase, branch: "" } },
  });
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "Fix the release");
  await pressKey(bridge, ".task-launcher-task", "4", MOD);
  await bridge.waitFor("preset 4 applied", `return e2e.all(".task-launcher-preset").some((b) => /Release fix/.test(b.innerText) && b.classList.contains("selected"));`);
  // The warning comes once the repository's branches are known (its probe is debounced).
  await bridge
    .waitFor("the base-branch warning", `return e2e.all(".task-launcher-fallback li").some((l) => l.getAttribute("data-field") === "where");`, { timeoutMs: 10_000 })
    .catch(() => log("  (no base-branch warning within 10 s)"));
  // "Hermes will run" is asked of the backend again after the fallback: it may trail the warning.
  await bridge
    .waitFor("the preview without the missing base", `return !/release\\/gone/.test(e2e.first(".task-launcher-command")?.textContent ?? "release/gone");`, { timeoutMs: 5_000 })
    .catch(() => log("  (the preview still names the missing base after 5 s)"));
  st = await launcherState(bridge);
  log(`  fallback: ${JSON.stringify(st.fallback)}; preview: ${st.preview}; blocks: ${JSON.stringify(st.blocks)}`);
  assert(!!st.fallback && st.fallback.some((f) => f.field === "where" && f.text.includes("release/gone")), "the warning names the missing base branch");
  assert(/in worktree hermes\/fix-the-release from main/.test(st.preview) && !st.preview.includes("release/gone"), "Hermes will run: from the current branch");
  await openChip(bridge, "where");
  // The control set's Select carries its value in data-value (a native select's .value).
  const baseValue = await bridge.eval(`const el = e2e.first(".task-launcher-menu .task-launcher-base"); return el ? el.getAttribute("data-value") ?? el.value ?? null : null;`);
  assert(baseValue === "", `the base select shows the current branch and holds it (${JSON.stringify(baseValue)})`);
  await bridge.click('[data-chip="where"]');
  await bridge.waitFor("the where menu to close", `return !e2e.first(".task-launcher-menu");`);
  await bridge.screenshot(join(evidenceDir, "04-stale-base.png"));
  await waitLaunchEnabled(bridge);
  n0 = fx.records().length;
  await pressKey(bridge, ".task-launcher-task", "Enter");
  const baseRun = (await fx.waitForRecords(n0 + 1)).at(-1);
  const tree = fx.worktrees().find((w) => w.branch === "hermes/fix-the-release");
  log(`  worktree: ${JSON.stringify(tree)}; agent cwd: ${baseRun.cwd}`);
  assert(!!tree && fx.samePath(tree.path, baseRun.cwd), "the agent started in its new worktree");
  assert(tree.head === fx.git("rev-parse", "main"), "cut from main (the current branch), not develop");

  log("step 6: ⌘1 applies preset 1");
  await openLauncher(bridge);
  await pickInMenu(bridge, "agent", '[data-agent-id="codex"]');
  await pressKey(bridge, ".task-launcher-task", "1", MOD);
  await bridge.waitFor("preset 1 applied", `return /model: sonnet/.test(e2e.first('[data-chip="model"]')?.innerText ?? "");`);
  st = await launcherState(bridge);
  assert(/^Claude Code/.test(st.agent) && /^Plan first/.test(st.approval), "Claude · Plan first · sonnet");
  await pressKey(bridge, ".task-launcher-task", "Escape");
  await bridge.waitFor("the sheet to close", `return !e2e.first(".task-launcher-sheet");`);

  log("step 7: Settings > Agents lists the presets; rename one, delete the stale one");
  await bridge.clickByName("Settings");
  await bridge.waitFor("the Settings dialog", `return !!e2e.first('[role="dialog"] .settings-title');`);
  await bridge.clickWhenReady(`
    const tab = e2e.all(".settings-tab").find((el) => e2e.norm(el.innerText) === "Agents");
    return e2e.click(e2e.must(tab, "Agents tab"));
  `);
  const listed = await bridge.waitFor("the presets in Settings", `
    const rows = e2e.all(".agents-settings-preset");
    return rows.length === 4 ? rows.map((r) => ({ id: r.getAttribute("data-preset-id"), name: e2e.norm(r.querySelector(".agents-settings-preset-name")?.innerText ?? ""), stale: !!r.querySelector(".agents-settings-preset-issues") })) : null;
  `, { timeoutMs: 30_000 });
  log(`  presets: ${JSON.stringify(listed)}`);
  assert(JSON.stringify(listed.map((p) => p.name)) === JSON.stringify(["Sonnet plan", "Codex luna", "Old codex", "Release fix"]), "all four, in order");
  assert(listed[2].stale && !listed[0].stale && !listed[1].stale, "the stale one is marked");
  await bridge.click(`.agents-settings-preset[data-preset-id="${listed[1].id}"] .agents-settings-preset-rename`);
  await typeInto(bridge, ".agents-settings-preset-name-input", "Codex max");
  await pressKey(bridge, ".agents-settings-preset-name-input", "Enter");
  await bridge.click(`.agents-settings-preset[data-preset-id="${listed[2].id}"] .agents-settings-preset-delete`);
  await bridge.waitFor("the list to update", `
    const names = e2e.all(".agents-settings-preset-name").map((el) => e2e.norm(el.innerText));
    return names.length === 3 && names[1] === "Codex max";
  `);
  await bridge.click(".settings-close");
  await bridge.waitFor("Settings to close", `return !e2e.first(".settings-title");`);
  await openLauncher(bridge);
  st = await launcherState(bridge);
  assert(JSON.stringify(st.presets.map((p) => p.name.replace(/^(⌘|Ctrl\+)\d\s*/, ""))) === JSON.stringify(["Sonnet plan", "Codex max", "Release fix"]), `the launcher shows the renamed preset and not the deleted one (${JSON.stringify(st.presets)})`);
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
