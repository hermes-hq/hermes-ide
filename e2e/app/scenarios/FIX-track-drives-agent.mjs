#!/usr/bin/env node
// Scenario FIX-track-drives-agent: "Track as a feature" drives the agent
// phase by phase, on the real app with a fake `claude` (CI-safe; the same
// with the real CLI is REAL-track-claude).
//
//   run 1  fresh install, the taskLauncher and featureTracks flags on.
//   run 2  1. ⌘N, a task, Track as a feature, Launch: the agent's first
//             prompt is the track's — the task, the phases, the questions
//             phase's instructions, where to write questions.md, and the
//             gate (`hi phase done`, then stop and wait) — not the bare task.
//             The worktree has feature.md (questions, no gate yet), the
//             phase prompts (.hermes/phases/) and the /hermes-phase command.
//          2. The Track panel says in plain words what happens: the agent is
//             to write questions.md and stop for the person's review.
//          3. The agent (played here with the bundled `hi`, as an agent runs
//             it) writes questions.md and runs `hi phase done`: the panel
//             says it is ready for review and what the person can do (read,
//             edit, send edits, approve ⌘⏎, skip), with the file's size.
//          4. Approve: feature.md moves to research (gate: approved), and the
//             agent — stopped at the gate — gets one line telling it to run
//             `hi phase` for research; the panel says it was told.
//          5. The agent runs `hi phase`: research starts (gate: none).
//
// Negative control (must end in RESULT: FAIL): a build of main before this
// fix — step 1 finds the bare task as the agent's first prompt.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/FIX-track-drives-agent.mjs

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { appBinaryPath, createLogger, finishScenario, outDir, sleep, skipScenario } from "../harness.mjs";
import {
  completeClassicOnboarding,
  expandOptions,
  invoke,
  launcherFixtures,
  newTerminals,
  onWindows,
  openLauncher,
  setRepo,
  typeInto,
  waitForReturningLaunch,
  waitLaunchEnabled,
  waitLauncherClosed,
} from "../launcher-steps.mjs";

const SCENARIO = "FIX-track-drives-agent";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);
const HI = join(dirname(appBinaryPath()), onWindows ? "hi.exe" : "hi");

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}
const frontMatter = (text) => Object.fromEntries([...text.matchAll(/^(phase|gate|track|slug): *(\S+)/gm)].map((m) => [m[1], m[2]]));

const fx = launcherFixtures("fix-track", log);
if (onWindows && !fx.canEditRegistryPath) {
  log("this scenario needs the fake agents on a Windows terminal's PATH (the user's registry Path); that is only changed on a CI runner");
  skipScenario({ scenario: SCENARIO, evidenceDir, reason: "Windows outside CI", log });
}
// Typed lines are prompts (what a real agent does with a line Hermes types).
writeFileSync(join(fx.recordDir, "mode"), "prompts\n");

const TASK = "Build the failure notification";

/** `hi` in the worktree, as the agent runs it (HERMES_AGENT set). */
function hiAsAgent(cwd, ...args) {
  const r = spawnSync(HI, args, { cwd, encoding: "utf8", env: { ...process.env, HERMES_AGENT: "claude" } });
  log(`  $ hi ${args.join(" ")} → exit ${r.status}: ${(r.stdout + r.stderr).trim().split("\n")[0]}`);
  return r;
}
const explain = (bridge) => bridge.eval(`return e2e.norm(e2e.first('[data-testid="track-explain"]')?.innerText ?? "");`);
const panel = (bridge) => bridge.eval(`const p = e2e.first('[data-testid="track-panel"]'); return p ? { phase: p.dataset.phase, gate: p.dataset.gate, role: p.dataset.role } : null;`);

let app;
let failed = false;
let undoRegistryPath = null;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}`);
  assert(existsSync(HI), `the bundled hi helper is next to the test app (${HI})`);
  undoRegistryPath = fx.addFakeBinToRegistryPath();

  log("run 1: fresh install; the launcher and Feature Tracks flags; one project");
  app = await fx.launch(evidenceDir, 1, { first: true });
  await completeClassicOnboarding(app.bridge);
  await invoke(app.bridge, "set_setting", { key: "feature_flag_overrides", value: JSON.stringify({ taskLauncher: true, featureTracks: true }) });
  await invoke(app.bridge, "create_project", { path: fx.repo, name: null });
  await app.stop();

  app = await fx.launch(evidenceDir, 2);
  const { bridge } = app;
  await waitForReturningLaunch(bridge);

  log("step 1: a task tracked as a feature starts the agent on the questions phase");
  await openLauncher(bridge);
  await setRepo(bridge, fx.repo);
  await typeInto(bridge, ".task-launcher-task", TASK);
  await expandOptions(bridge);
  await bridge.click(".task-launcher-feature-box");
  await waitLaunchEnabled(bridge);
  const t0 = await bridge.terminalIds();
  const n0 = fx.records().length;
  await bridge.click(".task-launcher-launch");
  const [sessionId] = await newTerminals(bridge, t0, 1, "the agent's terminal");
  await waitLauncherClosed(bridge);
  const rec = (await fx.waitForRecords(n0 + 1)).at(-1);
  // Windows hands a prompt to the agent on one line (its line breaks become
  // spaces); the words are what matters.
  const prompt = String(rec.prompt ?? "");
  const flat = prompt.replace(/\s+/g, " ");
  log(`  first prompt (${prompt.length} chars): ${JSON.stringify(prompt.slice(0, 400))}…`);
  assert(prompt.startsWith("Hermes Feature Track (Full)"), "the first prompt is the feature track's, not the bare task");
  assert(flat.includes(`: ${TASK} Phases:`) && /Phases: questions → research → design → structure → plan → implement\./.test(flat), "it carries the task and the phases");
  assert(/Current phase: questions \(1 of 6\)/.test(flat) && flat.includes("# Phase: questions"), "and the questions phase's own instructions");
  const qPath = flat.match(/Write (\.hermes\/features\/[a-z0-9-]+\/questions\.md) \(at most 40 lines\)/)?.[1];
  assert(!!qPath, `where to write the questions (${qPath})`);
  assert(/run `hi phase done`, then STOP: end your turn and wait\./.test(flat), "and the gate: hand over with hi phase done, then stop and wait");
  const wt = rec.cwd;
  const slug = qPath.split("/")[2];
  const featureMd = join(wt, ".hermes", "features", slug, "feature.md");
  for (let i = 0; i < 50 && !existsSync(featureMd); i++) await sleep(100);
  const fm = frontMatter(readFileSync(featureMd, "utf8"));
  assert(fm.track === "Full" && fm.phase === "questions" && fm.gate === "none", `feature.md: Full, questions, no gate yet (${JSON.stringify(fm)})`);
  assert(existsSync(join(wt, ".hermes", "phases", "questions.md")) && existsSync(join(wt, ".claude", "commands", "hermes-phase.md")), "the phase prompts and the /hermes-phase command are there for the next phases");

  log("step 2: the Track panel says what happens");
  await bridge.clickWhenReady(`
    const tab = e2e.all(".activity-bar-tab").find((el) => e2e.nameOf(el) === "Track");
    return e2e.click(e2e.must(tab, "the Track tab"));
  `);
  await bridge.waitFor("the Track panel on the feature", `const p = e2e.first('[data-testid="track-panel"]'); return p && p.dataset.phase === "questions";`, { timeoutMs: 20_000 });
  let said = await explain(bridge);
  assert(said === "Waiting for the agent to start questions: it writes questions.md, then stops for your review.", `"${said}"`);
  await bridge.screenshot(join(evidenceDir, "02-track-waiting-for-agent.png"));

  log("step 3: the agent writes questions.md and hands it over");
  writeFileSync(join(wt, qPath), "# Questions\n\n## Open\n- [ ] Which channel carries the notification?\n- [ ] Who receives it?\n");
  const done = hiAsAgent(wt, "phase", "done");
  assert(done.status === 0 && /Stop here and end your turn/.test(done.stdout), "hi phase done tells the agent to stop here");
  await bridge.waitFor("the gate in the panel", `const p = e2e.first('[data-testid="track-panel"]'); return p && p.dataset.gate === "waiting";`, { timeoutMs: 20_000 });
  said = await explain(bridge);
  assert(/^questions is ready for your review\. Read questions\.md \(o\) or edit it \(⇧O\)\. Then send your edits back \(r\), approve to start research \(.+⏎\), or skip \(⇧S\)\.$/.test(said), `"${said}"`);
  const size = await bridge.text('.track-phase[data-phase="questions"] .track-phase-lines');
  assert(size.trim() === "5/40", `the file's size against its cap (${size.trim()})`);
  await bridge.screenshot(join(evidenceDir, "03-ready-for-review.png"));

  log("step 4: approve — the file moves on and the agent is told to go on");
  await bridge.click(".track-approve");
  await bridge.waitFor("research, approved", `const p = e2e.first('[data-testid="track-panel"]'); return p && p.dataset.phase === "research" && p.dataset.gate === "approved";`, { timeoutMs: 20_000 });
  const after = frontMatter(readFileSync(featureMd, "utf8"));
  assert(after.phase === "research" && after.gate === "approved", `feature.md: research, gate approved (${JSON.stringify(after)})`);
  let told = null;
  for (let i = 0; i < 100 && !told; i++) {
    const r = JSON.parse(readFileSync(join(fx.recordDir, readdirSync(fx.recordDir).filter((f) => f.startsWith("launch-")).sort().at(-1)), "utf8"));
    told = (r.prompts ?? []).find((p) => p.startsWith("hermes track:")) ?? null;
    if (!told) await sleep(150);
  }
  assert(told === `hermes track: ${slug}: questions approved by the person. Run \`hi phase\` now and do the research phase the same way: write its file, run \`hi phase done\`, then stop and wait for the person's review.`, `the agent got one line telling it to run hi phase ("${told}")`);
  said = await explain(bridge);
  assert(said === "Approved. The agent was told to start research: it writes the next file and stops again for your review.", `"${said}"`);
  log(`  session ${sessionId.slice(0, 8)} was the writer: ${JSON.stringify(await panel(bridge))}`);

  log("step 5: the agent runs hi phase; research starts");
  const next = hiAsAgent(wt, "phase");
  assert(next.status === 0 && next.stdout.startsWith("# Phase: research") && /Then stop and wait: a person approves the phase/.test(next.stdout), "hi phase prints the research instructions, ending at the gate");
  await bridge.waitFor("research in progress", `const p = e2e.first('[data-testid="track-panel"]'); return p && p.dataset.phase === "research" && p.dataset.gate === "none";`, { timeoutMs: 20_000 });
  said = await explain(bridge);
  assert(/^The agent is writing research\.md for research \(\d+\/80 lines so far\)\./.test(said), `"${said}"`);
  await bridge.screenshot(join(evidenceDir, "05-research.png"));

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
