#!/usr/bin/env node
// QA-git (QAGIT-11): when Hermes cannot read a task worktree's git status,
// closing the task never deletes the worktree without asking.
//
// The worktree's index is damaged (what a crash mid-write or a full disk can
// leave) and the agent wrote a file. Closing says "Could not check <project>
// for uncommitted changes: <reason>" with Keep the worktree and close (the
// primary), Delete anyway and Cancel. Keep leaves the folder and the file.
//
// Negative control: a build from before the fix ends in RESULT: FAIL (the
// check failed silently and the close deleted the worktree).

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  L,
  closeSessionByLabel,
  dialogText,
  endScenario,
  gitAs,
  gitFixtures,
  launchTask,
  scenarioContext,
  sessionLabel,
  sleep,
  waitSessionGone,
  worktreeInfo,
} from "../qa-git-steps.mjs";

const SCENARIO = "QA-git-close-check-fails";
const ctx = scenarioContext(SCENARIO);
const { evidenceDir, log, check } = ctx;
const fx = gitFixtures("checkfails", log);

let app;
let error;
try {
  app = await fx.launchFx(evidenceDir);
  const { bridge } = app;
  const project = await L.completeTaskWelcome(bridge, fx.repo);
  const r = await launchTask(bridge, { task: "Draft the migration", log });
  const label = await sessionLabel(bridge, r.sessionId);
  const wt = await worktreeInfo(bridge, r.sessionId, project.id);
  const work = join(wt.worktreePath, "MIGRATION-PLAN.md");
  writeFileSync(work, "two hours of agent work\n");
  const gitDir = gitAs(wt.worktreePath, "rev-parse", "--absolute-git-dir");
  writeFileSync(join(gitDir, "index"), "damaged");

  await closeSessionByLabel(bridge, label);
  await bridge.waitFor("the question", `return !!e2e.first(".dirty-wt-modal") || !!e2e.first(".close-dialog");`, { timeoutMs: 15_000 });
  const dlg = await dialogText(bridge);
  log(`  shown on close: ${dlg}`);
  await bridge.screenshot(join(evidenceDir, "01-check-failed.png"));
  check(!!dlg && dlg.includes(`Could not check ${project.name} for uncommitted changes:`), "closing says it could not check the worktree, and why");
  const primary = await bridge.eval(`return e2e.nameOf(e2e.first(".dirty-wt-modal .h-btn--primary") ?? document.body);`);
  check(primary === "Keep the worktree and close", `the primary choice keeps the worktree (${primary})`);
  check(/Delete anyway/.test(dlg ?? "") && /Cancel/.test(dlg ?? ""), "Delete anyway and Cancel are offered too");
  await bridge.click(".dirty-wt-modal .dirty-wt-btn--keep");
  await waitSessionGone(bridge, label);
  await sleep(1500);
  check(existsSync(work), "the agent's file is still on disk after the close");
} catch (e) {
  error = e;
}
await endScenario({ ctx, app, error, scenario: SCENARIO, cleanup: () => fx.cleanup() });
