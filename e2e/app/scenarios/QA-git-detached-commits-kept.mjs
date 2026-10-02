#!/usr/bin/env node
// QA-git (QAGIT-09): commits made on a detached HEAD in a task's worktree
// are never deleted without asking.
//
// The agent detaches HEAD and commits a fix there (the commit is on no
// branch). The working tree is clean. Closing the task asks: "1 commit is on
// no branch (detached HEAD)" with Save on hermes-archive/<task>-detached &
// close / Discard and close / Cancel. Save keeps the commit on that branch;
// the worktree folder goes.
//
// Negative control: a build from before the fix ends in RESULT: FAIL (no
// question; the commit was reachable from no branch afterwards).

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

const SCENARIO = "QA-git-detached-commits-kept";
const ctx = scenarioContext(SCENARIO);
const { evidenceDir, log, check } = ctx;
const fx = gitFixtures("detached", log);

let app;
let error;
try {
  app = await fx.launchFx(evidenceDir);
  const { bridge } = app;
  const project = await L.completeTaskWelcome(bridge, fx.repo);
  const r = await launchTask(bridge, { task: "Bisect the slow build", log });
  const label = await sessionLabel(bridge, r.sessionId);
  const wt = await worktreeInfo(bridge, r.sessionId, project.id);
  const stem = wt.branchName.replace(/^hermes\//, "");

  log("step 1: the agent detaches HEAD and commits a fix there");
  gitAs(wt.worktreePath, "checkout", "-q", "--detach");
  writeFileSync(join(wt.worktreePath, "FIX.md"), "the fix, found while detached\n");
  gitAs(wt.worktreePath, "add", "FIX.md");
  gitAs(wt.worktreePath, "commit", "-q", "-m", "fix found while bisecting");
  const sha = gitAs(wt.worktreePath, "rev-parse", "HEAD");

  log("step 2: close the task (working tree clean)");
  await closeSessionByLabel(bridge, label);
  await bridge.waitFor("the question", `return !!e2e.first(".dirty-wt-modal");`, { timeoutMs: 15_000 });
  const dlg = await dialogText(bridge);
  log(`  dialog: ${dlg}`);
  await bridge.screenshot(join(evidenceDir, "01-detached.png"));
  check(dlg.includes("1 commit is on no branch (detached HEAD)"), "the dialog says a commit is on no branch");
  check(dlg.includes(`Save on hermes-archive/${stem}-detached & close`), "it offers to save it on a hermes-archive/…-detached branch");
  check(/Discard and close/.test(dlg) && /Cancel/.test(dlg), "Discard and close, and Cancel, are offered too");

  log("step 3: Save");
  await bridge.click(".dirty-wt-modal .dirty-wt-btn--save-detached");
  await waitSessionGone(bridge, label);
  for (let i = 0; i < 100 && existsSync(wt.worktreePath); i++) await sleep(200);
  const refs = fx.git("for-each-ref", "--contains", sha, "--format=%(refname)").split("\n").filter(Boolean);
  log(`  refs holding the commit: ${JSON.stringify(refs)}`);
  check(refs.includes(`refs/heads/hermes-archive/${stem}-detached`), "the commit is on hermes-archive/<task>-detached");
  check(!existsSync(wt.worktreePath), "the worktree folder is gone");
} catch (e) {
  error = e;
}
await endScenario({ ctx, app, error, scenario: SCENARIO, cleanup: () => fx.cleanup() });
