#!/usr/bin/env node
// Scenario F15 (launcher v2): every chip and option of the ⌘N launcher
// reaches the agent the real app starts, with fake `claude` and `codex`
// CLIs (tools/fake-agents) and a throwaway repository (main, develop one
// commit ahead, feature/inbox). No real account is ever used.
//
//   run 1  fresh install: the welcome; the taskLauncher flag on; a launch
//          prefix for claude in Settings (`env HERMES_PREFIX_PROOF=launcher`,
//          not on Windows); two projects registered.
//   run 2  - ⌘N with no session: the launcher opens pre-set (Claude, its
//            safety default Accept edits, default model) on a project.
//          - agent · account: every catalog agent and the Custom agent are
//            listed, with the doctor's version; the account is shown.
//          - approval: Claude's real modes; Skip all is red with its note
//            and flag; Plan first is picked.
//          - model: haiku has no effort levels, so the effort chip is off;
//            opus + effort high.
//          - where: a new worktree cut from develop.
//          - + options: the prefix from Settings is shown; extra args,
//            channels, an edited check, Track as a feature, and Also on
//            codex with its own approval (Skip all), model and effort.
//          - "Hermes will run" shows both command lines.
//          - Enter in the extra-args field launches: the fake claude was
//            started through the launch helper with exactly the permission
//            mode, the task, the channel, --model opus --effort high and the
//            extra argument (and through the prefix); codex with its own
//            flags on its own branch; both worktrees are cut from develop
//            and hold feature.md; the launch record has the edited check.
//          - an existing branch, then the current checkout: the agent runs
//            in a worktree of feature/inbox, then in the repository itself.
//          - ⌘N pressed while a launch is still finishing: once the sheet
//            has closed, a fresh launcher opens (the press used to be lost).
//          - the Custom agent: its typed command is what runs.
//
// Negative controls (must end in RESULT: FAIL):
//   HERMES_E2E_LAUNCHER_FLAG=off   the taskLauncher flag stays off: ⌘N opens
//                                  the old creator.
//   a build of main before the fix fails step 10b (no launcher comes up).
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F15-launcher-chips.mjs

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLogger, finishScenario, outDir, sleep, skipScenario } from "../harness.mjs";
import {
  MOD,
  chooseOption,
  completeClassicOnboarding,
  expandOptions,
  invoke,
  launchThenPressNewTask,
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
} from "../launcher-steps.mjs";

const SCENARIO = "F15-launcher-chips";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);
const FLAG_ON = (process.env.HERMES_E2E_LAUNCHER_FLAG || "on") !== "off";
const PREFIX = onWindows ? "" : "env HERMES_PREFIX_PROOF=launcher";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}
/** Whether `argv` holds `seq` as consecutive words. */
const hasSeq = (argv, seq) => argv.some((_, i) => seq.every((w, j) => argv[i + j] === w));
/** Codex's effort setting, with or without the TOML quotes around the level. */
const codexEffort = (argv, level) => argv.some((a, i) => a === "-c" && new RegExp(`^model_reasoning_effort="?${level}"?$`).test(argv[i + 1] ?? ""));
/** The codex model the capability backend lists first after "default" (the fake's catalog). */
const CODEX_MODEL = "gpt-fake-luna";

const fx = launcherFixtures("f15-chips", log);
if (onWindows && !fx.canEditRegistryPath) {
  log("this scenario needs the fake agents on a Windows terminal's PATH (the user's registry Path); that is only changed on a CI runner");
  skipScenario({ scenario: SCENARIO, evidenceDir, reason: "Windows outside CI", log });
}

let app;
let failed = false;
let undoRegistryPath = null;

try {
  log(`scenario: ${SCENARIO}   flag: ${FLAG_ON ? "on" : "OFF (negative control)"}`);
  undoRegistryPath = fx.addFakeBinToRegistryPath();

  // ── run 1 ─────────────────────────────────────────────────────────
  log("run 1: fresh install; flags, a Settings prefix for claude, two projects");
  app = await fx.launch(evidenceDir, 1, { first: true });
  await completeClassicOnboarding(app.bridge);
  await invoke(app.bridge, "set_setting", { key: "feature_flag_overrides", value: JSON.stringify(FLAG_ON ? { taskLauncher: true } : {}) });
  if (PREFIX) await invoke(app.bridge, "set_setting", { key: "ai_agent_prefixes", value: JSON.stringify({ claude: PREFIX }) });
  await invoke(app.bridge, "create_project", { path: fx.otherRepo, name: null });
  await invoke(app.bridge, "create_project", { path: fx.repo, name: null });
  await app.stop();

  // ── run 2 ─────────────────────────────────────────────────────────
  app = await fx.launch(evidenceDir, 2);
  const { bridge } = app;
  await waitForReturningLaunch(bridge);

  log("step 1: ⌘N with no session opens the launcher pre-set");
  await openLauncher(bridge);
  let st = await launcherState(bridge);
  log(`  launcher: ${JSON.stringify(st)}`);
  assert(/^Claude Code · default profile/.test(st.agent), `the agent chip: ${st.agent}`);
  assert(/^Accept edits/.test(st.approval), `Claude starts in its safety default: ${st.approval}`);
  assert(/model: default/.test(st.model), `the default model: ${st.model}`);
  assert(/-repo/.test(st.project), `a project is chosen without an active session: ${st.project}`);
  await bridge.screenshot(join(evidenceDir, "01-launcher.png"));

  log("step 2: agent · account lists every agent and the Custom agent");
  await openChip(bridge, "agent");
  const agentMenu = await bridge.eval(`return e2e.all('.task-launcher-menu [data-agent-id]').map((b) => ({ id: b.getAttribute("data-agent-id"), text: e2e.norm(b.innerText) }));`);
  log(`  agents: ${JSON.stringify(agentMenu)}`);
  for (const id of ["claude", "codex", "gemini", "custom"]) assert(agentMenu.some((a) => a.id === id), `${id} is listed`);
  await bridge.waitFor("the doctor's version for claude", `return /2\\.1\\.300/.test(e2e.first('.task-launcher-menu [data-agent-id="claude"]')?.innerText ?? "");`, { timeoutMs: 30_000 });
  assert(await bridge.eval(`return /Account for Claude Code/.test(e2e.first(".task-launcher-menu").innerText) && !!e2e.first('.task-launcher-menu [data-account-id="default"]');`), "the account list for Claude Code is shown");
  await bridge.screenshot(join(evidenceDir, "02-agent-menu.png"));
  await bridge.click('.task-launcher-menu [data-agent-id="claude"]');

  log("step 3: the repository and the task");
  await setRepo(bridge, fx.repo);
  const TASK = "Fix the flaky login test";
  await typeInto(bridge, ".task-launcher-task", TASK);

  log("step 4: approval — Claude's real modes, Skip all in red with its note");
  await openChip(bridge, "approval");
  const modes = await bridge.eval(`return e2e.all('.task-launcher-approval-modes [data-mode]').map((b) => ({ id: b.getAttribute("data-mode"), text: e2e.norm(b.innerText), danger: b.classList.contains("danger") }));`);
  log(`  modes: ${JSON.stringify(modes)}`);
  assert(JSON.stringify(modes.map((m) => m.id)) === JSON.stringify(["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]), "Claude's modes, in order");
  assert(modes.find((m) => m.id === "bypassPermissions")?.danger && /Skip all/.test(modes.find((m) => m.id === "bypassPermissions").text), "Skip all is marked dangerous");
  await bridge.click('.task-launcher-approval-modes [data-mode="bypassPermissions"]');
  // A pick closes the menu; open again to read the chosen mode's note.
  await openChip(bridge, "approval");
  const skip = await bridge.eval(`return { note: e2e.norm(e2e.first(".task-launcher-approval-note")?.innerText ?? ""), red: !!e2e.first(".task-launcher-approval-note.danger"), flag: e2e.first(".task-launcher-approval code")?.textContent };`);
  assert(skip.red && /Never asks, for anything/.test(skip.note), `its note, in red: "${skip.note}"`);
  assert(skip.flag === "--permission-mode bypassPermissions", `and its flag: ${skip.flag}`);
  assert((await launcherState(bridge)).approvalDanger, "the approval chip turns red");
  await bridge.screenshot(join(evidenceDir, "03-skip-all.png"));
  await bridge.click('.task-launcher-approval-modes [data-mode="plan"]');
  assert(/^Plan first/.test((await launcherState(bridge)).approval), "Plan first is chosen");

  log("step 5: model and effort");
  await pickInMenu(bridge, "model", '[data-model-id="haiku"]');
  st = await launcherState(bridge);
  assert(st.effortDisabled && /n\/a for haiku/.test(st.effort), `haiku has no effort levels: "${st.effort}" (disabled)`);
  await pickInMenu(bridge, "model", '[data-model-id="opus"]');
  await pickInMenu(bridge, "effort", '[data-effort="high"]');
  st = await launcherState(bridge);
  assert(/model: opus/.test(st.model) && /effort: high/.test(st.effort), `opus, effort high (${st.model}, ${st.effort})`);

  log("step 6: where — a new worktree cut from develop");
  await openChip(bridge, "where");
  await chooseOption(bridge, ".task-launcher-menu .task-launcher-base", "develop");

  log("step 7: + options — prefix, extra args, channels, checks, feature, also on");
  await expandOptions(bridge);
  const prefixNote = await bridge.text(".task-launcher-prefix-note");
  assert(PREFIX ? prefixNote.includes(PREFIX) : /no prefix in Settings/.test(prefixNote), `the prefix from Settings is shown: "${prefixNote}"`);
  await typeInto(bridge, ".task-launcher-extra-args", "--extra-proof");
  await typeInto(bridge, ".task-launcher-channels", "plugin:proof");
  await bridge.waitFor("the check from worktree.toml", `return e2e.first(".task-launcher-check-input")?.value === "npm test";`, { timeoutMs: 20_000 });
  await typeInto(bridge, ".task-launcher-check-input", "npm run check");
  assert(!(await bridge.eval(`return /\\bSize\\b/.test(e2e.first(".task-launcher-options").innerText);`)), "there is no Size choice any more");
  const featureNote = await bridge.eval(`return e2e.norm(e2e.first(".task-launcher-feature").innerText);`);
  assert(/Questions → research → design → structure → plan → implement, before any code/.test(featureNote) && /Not the same as Claude Code's own plan mode \(Approval › Plan first\)/.test(featureNote), `Track as a feature explains itself, and that it is not Claude's plan mode ("${featureNote}")`);
  assert((await bridge.eval(`return e2e.all(".task-launcher-opt-label").map((l) => e2e.norm(l.innerText));`)).includes("Feature track"), "its row is called Feature track (not Planning)");
  await bridge.click(".task-launcher-feature-box");
  await bridge.click(".task-launcher-also-toggle");
  await bridge.waitFor("the second agent's choices", `return !!e2e.first(".task-launcher-also-agent");`);
  await chooseOption(bridge, ".task-launcher-also-agent", "codex");
  await chooseOption(bridge, ".task-launcher-also-approval", "bypassPermissions");
  await chooseOption(bridge, ".task-launcher-also-model", CODEX_MODEL);
  await chooseOption(bridge, ".task-launcher-also-effort", "high");
  await sleep(300);
  st = await launcherState(bridge);
  log(`  preview: ${st.preview}`);
  const [claudeLine, codexLine] = st.preview.split(" + ");
  const inOrder = (line, words) => words.every((w, i) => line.indexOf(w) >= 0 && (i === 0 || line.indexOf(w) > line.indexOf(words[i - 1])));
  assert(
    inOrder(claudeLine, [...(PREFIX ? [PREFIX] : []), "claude", "--permission-mode plan", "--model opus", "--effort high", `'${TASK}'`, "--channels plugin:proof", "--extra-proof"]),
    `Hermes will run: the claude line with every choice (${claudeLine})`,
  );
  assert(
    inOrder(codexLine ?? "", ["codex", "--dangerously-bypass-approvals-and-sandbox", `-m ${CODEX_MODEL}`, "model_reasoning_effort", `'${TASK}'`]) && /model_reasoning_effort=\\?"?high/.test(codexLine),
    `and the codex line with its own (${codexLine})`,
  );
  assert(/in worktree hermes\/fix-the-flaky-login-test from develop/.test(st.preview), "and where: a new worktree from develop");
  await bridge.screenshot(join(evidenceDir, "04-options.png"));

  log("step 8: Enter in the extra-args field launches both");
  await waitLaunchEnabled(bridge);
  let before = await bridge.terminalIds();
  const n0 = fx.records().length;
  await pressKey(bridge, ".task-launcher-extra-args", "Enter");
  await bridge.waitFor("the launcher to close", `return !e2e.first(".task-launcher-sheet");`, { timeoutMs: 30_000 });
  await newTerminals(bridge, before, 2, "two new terminals");
  const recs = (await fx.waitForRecords(n0 + 2)).slice(n0);
  for (const r of recs) log(`  record: ${JSON.stringify({ agent: r.env.HERMES_AGENT, argv: r.argv, cwd: r.cwd, prefix: r.env.HERMES_PREFIX_PROOF })}`);
  const rc = recs.find((r) => r.env.HERMES_AGENT === "claude");
  const rx = recs.find((r) => r.env.HERMES_AGENT === "codex");
  assert(rc && rx, "claude and codex both started");
  assert(rc.sessionIdArg && rc.settingsFile, "claude was started by the launch helper");
  assert(hasSeq(rc.argv, ["--permission-mode", "plan"]), "claude: --permission-mode plan");
  // Tracked as a feature: the first prompt is the track's (the task, the
  // questions phase, the gate), not the bare task.
  const trackPrompt = (argv) => argv.find((a) => String(a).startsWith("Hermes Feature Track (Full)")) ?? "";
  assert(trackPrompt(rc.argv).includes(TASK) && /Current phase: questions \(1 of 6\)/.test(trackPrompt(rc.argv)) && /hi phase done`, then STOP/.test(trackPrompt(rc.argv)), "claude: its first prompt is the feature track's, with the task");
  assert(hasSeq(rc.argv, ["--channels", "plugin:proof"]), "claude: --channels plugin:proof");
  assert(hasSeq(rc.argv, ["--model", "opus"]) && hasSeq(rc.argv, ["--effort", "high"]) && rc.argv.at(-1) === "--extra-proof", "claude: --model opus --effort high, and --extra-proof last");
  if (PREFIX) assert(rc.env.HERMES_PREFIX_PROOF === "launcher", "claude ran through the Settings prefix");
  assert(rx.argv.includes("--dangerously-bypass-approvals-and-sandbox"), "codex: its own approval (Skip all)");
  assert(hasSeq(rx.argv, ["-m", CODEX_MODEL]) && codexEffort(rx.argv, "high"), "codex: its own model and effort");
  assert(trackPrompt(rx.argv).includes(TASK), "codex: the same task, in the same track prompt");
  const develop = fx.git("rev-parse", "develop");
  const wts = fx.worktrees();
  const wtClaude = wts.find((w) => w.branch === "hermes/fix-the-flaky-login-test");
  const wtCodex = wts.find((w) => w.branch === "hermes/fix-the-flaky-login-test-codex");
  assert(wtClaude && fx.samePath(rc.cwd, wtClaude.path), "claude runs in its own worktree on hermes/fix-the-flaky-login-test");
  assert(wtCodex && fx.samePath(rx.cwd, wtCodex.path), "codex runs in its own worktree on hermes/fix-the-flaky-login-test-codex");
  assert(wtClaude.head === develop && wtCodex.head === develop, "both are cut from develop");
  for (const w of [wtClaude, wtCodex]) {
    const file = join(w.path, ".hermes", "features", "fix-the-flaky-login-test", "feature.md");
    assert(existsSync(file) && /track: Full/.test(readFileSync(file, "utf8")), "Track as a feature wrote feature.md in each worktree");
  }
  const launches = JSON.parse((await invoke(bridge, "get_settings")).task_launches || "[]");
  assert(launches.length === 2 && launches.every((l) => l.doneWhen.join("|") === "npm run check"), "the edited check is what the launch recorded");
  await bridge.screenshot(join(evidenceDir, "05-launched.png"));

  log("step 9: an existing branch");
  await openLauncher(bridge);
  st = await launcherState(bridge);
  assert(/Plan first/.test(st.approval) && /model: opus/.test(st.model), "⌘N opens on the combination just used (the usual)");
  await typeInto(bridge, ".task-launcher-task", "Polish the inbox badge");
  await expandOptions(bridge);
  await bridge.clickWhenReady(`
    const also = e2e.first(".task-launcher-also-toggle");
    if (also?.getAttribute("aria-pressed") === "true") e2e.click(also);
    const box = e2e.first(".task-launcher-feature-box");
    if (box?.checked) e2e.click(box);
    return e2e.first(".task-launcher-also-toggle")?.getAttribute("aria-pressed") === "false" && !e2e.first(".task-launcher-feature-box").checked;
  `);
  await bridge.click('.task-launcher-options [data-where="existing-branch"]');
  await chooseOption(bridge, ".task-launcher-options .task-launcher-existing", "feature/inbox");
  await waitLaunchEnabled(bridge);
  before = await bridge.terminalIds();
  let n1 = fx.records().length;
  await bridge.click(".task-launcher-launch");
  await newTerminals(bridge, before, 1, "the existing-branch terminal");
  await waitLauncherClosed(bridge);
  const onExisting = (await fx.waitForRecords(n1 + 1)).at(-1);
  const wtInbox = fx.worktrees().find((w) => w.branch === "feature/inbox");
  assert(wtInbox && fx.samePath(onExisting.cwd, wtInbox.path), "the agent runs in a worktree of feature/inbox (no new branch)");
  assert(!fx.worktrees().some((w) => /polish/.test(w.branch ?? "")), "no hermes/ branch was made");

  log("step 10: the current checkout");
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "Update the README");
  await pickInMenu(bridge, "where", '[data-where="current-checkout"]');
  // The preview can catch up after the chip (Linux CI): wait for both.
  await bridge.waitFor("the repository's branch in the where chip and the preview", `
    const where = e2e.norm(e2e.first('[data-chip="where"]')?.innerText ?? "");
    const preview = e2e.norm(e2e.first(".task-launcher-command")?.textContent ?? "");
    return /current checkout · main/.test(where) && /in launcher-repo \\(main\\)/.test(preview);
  `, { timeoutMs: 20_000 });
  st = await launcherState(bridge);
  assert(/current checkout · main/.test(st.where) && /in launcher-repo \(main\)/.test(st.preview), `the where chip and the preview say so (${st.where}; ${st.preview})`);
  await waitLaunchEnabled(bridge);
  before = await bridge.terminalIds();
  n1 = fx.records().length;
  await bridge.click(".task-launcher-launch");
  await newTerminals(bridge, before, 1, "the current-checkout terminal");
  const onCurrent = (await fx.waitForRecords(n1 + 1)).at(-1);
  assert(fx.samePath(onCurrent.cwd, fx.repo), "the agent runs in the repository's own checkout");
  // The sheet closes itself once the launch is recorded; ⌘N on the closing
  // sheet used to be lost (step 11 then found no launcher, on Linux CI).
  await waitLauncherClosed(bridge);

  log("step 10b: ⌘N pressed while a launch is still finishing opens a fresh launcher once it is done");
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "Tidy the changelog");
  await pickInMenu(bridge, "where", '[data-where="new-worktree"]');
  await waitLaunchEnabled(bridge);
  before = await bridge.terminalIds();
  n1 = fx.records().length;
  const pressed = await launchThenPressNewTask(bridge);
  log(`  pressed ⌘N with the launch running: ${JSON.stringify(pressed)}`);
  assert(pressed.sheetOpen, "⌘N came while the launching sheet was still open");
  await newTerminals(bridge, before, 1, "the launched task's terminal");
  await fx.waitForRecords(n1 + 1);
  const fresh = await bridge
    .waitFor("a fresh launcher", `
      const l = e2e.first(".task-launcher-sheet .task-launcher");
      const task = e2e.first(".task-launcher-task");
      return l && l.getAttribute("data-ready") === "true" && task && task.value === "" ? { task: task.value } : false;
    `, { timeoutMs: 30_000 })
    .catch(async (err) => {
      log(`  launcher now: ${JSON.stringify(await launcherState(bridge))}`);
      throw err;
    });
  assert(!!fresh, "the ⌘N was not lost: a fresh, empty launcher is open, ready for the next task");
  assert(fx.worktrees().some((w) => w.branch === "hermes/tidy-the-changelog"), "and the task launched before it");
  await bridge.screenshot(join(evidenceDir, "05b-fresh-after-launch.png"));
  await pressKey(bridge, ".task-launcher-task", "Escape");
  await waitLauncherClosed(bridge);

  log("step 11: the Custom agent runs the command typed for it");
  await openLauncher(bridge);
  await pickInMenu(bridge, "agent", '[data-agent-id="custom"]');
  await typeInto(bridge, ".task-launcher-task", "Summarise the logs");
  await bridge.waitFor("the custom-command row", `return !!e2e.first('.task-launcher-block[data-kind="custom-command"]');`);
  await typeInto(bridge, ".task-launcher-custom-command", "codex --custom-proof");
  await waitLaunchEnabled(bridge);
  before = await bridge.terminalIds();
  n1 = fx.records().length;
  await pressKey(bridge, ".task-launcher-custom-command", "Enter");
  await newTerminals(bridge, before, 1, "the custom agent's terminal");
  const custom = (await fx.waitForRecords(n1 + 1, 40_000)).at(-1);
  log(`  custom record: ${JSON.stringify({ argv: custom.argv })}`);
  assert(custom.argv.includes("--custom-proof"), "the typed command is what ran");
  await bridge.screenshot(join(evidenceDir, "06-custom.png"));
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
