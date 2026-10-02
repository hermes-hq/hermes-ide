#!/usr/bin/env node
// QA-git (QAGIT-10): a post-checkout hook that fails (Git LFS not on the
// app's PATH) no longer breaks the launch or leaves litter behind.
//
// git makes the worktree, checks it out, then the hook exits 2. The task
// starts in that worktree with a warning that quotes the hook. Launching the
// same task again is not blocked by a leftover branch and never calls
// Hermes' own worktree "a checkout outside Hermes".
//
// Negative control: a build from before the fix ends in RESULT: FAIL (the
// launch failed and left the branch and the folder behind).

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  L,
  endScenario,
  fakeAgents,
  gitIn,
  launch,
  launchTask,
  makeRepo,
  rmrf,
  scenarioContext,
  sleep,
  tmpWork,
  toasts,
  worktreesOf,
  onWindows,
} from "../qa-git-steps.mjs";
import { skipScenario } from "../harness.mjs";

const SCENARIO = "QA-git-hook-failure-no-leftovers";
if (onWindows) skipScenario({ scenario: SCENARIO, reason: "the hook is a POSIX shell script" });
const ctx = scenarioContext(SCENARIO);
const { evidenceDir, log, check } = ctx;

const work = tmpWork("hook");
const fakes = fakeAgents(work);
const repo = makeRepo(join(work, "lfs-monorepo"), { files: { "README.md": "# lfs\n", ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n" } });
const hook = join(repo, ".git", "hooks", "post-checkout");
writeFileSync(hook, `#!/bin/sh\necho "This repository is configured for Git LFS but 'git-lfs' was not found on your path." >&2\nexit 2\n`);
chmodSync(hook, 0o755);
const homeDir = join(work, "home");

let app;
let error;
try {
  app = await launch({ evidenceDir, homeDir, log, fakes });
  const { bridge } = app;
  await L.completeTaskWelcome(bridge, repo);

  log("step 1: launch a task in a new worktree");
  const r = await launchTask(bridge, { task: "Update the assets", log });
  check(!!r.sessionId, "the task started");
  await sleep(1500);
  const shown = await toasts(bridge);
  log(`  toasts: ${JSON.stringify(shown)}`);
  await bridge.screenshot(join(evidenceDir, "01-after-launch.png"));
  check(shown.some((t) => /hook failed after the worktree was made/.test(t) && /git-lfs' was not found/.test(t)), "a warning quotes what the hook said");
  const wts = worktreesOf(repo).filter((w) => w.path.includes("hermes-worktrees"));
  check(wts.length === 1 && wts[0].branch?.startsWith("hermes/"), `the task works in its own worktree (${JSON.stringify(wts.map((w) => w.branch))})`);

  log("step 2: launch the same task again");
  const r2 = await launchTask(bridge, { task: "Update the assets", log, expectSession: false });
  await sleep(1500);
  const conflict = await bridge.eval(`return e2e.first(".branch-conflict-modal") ? e2e.norm(e2e.first(".branch-conflict-modal").innerText) : null;`);
  log(`  second launch: ${JSON.stringify(r2.blocked ? r2.blocked.blocks : "launched")}; Branch In Use: ${conflict}`);
  await bridge.screenshot(join(evidenceDir, "02-retry.png"));
  check(!conflict || !/outside Hermes/.test(conflict), "Hermes' own worktree is never called 'a checkout outside Hermes'");
  // Every hermes/ branch is a live task's: no branch or folder left over.
  const branches = gitIn(repo, "branch", "--list", "hermes/*", "--format=%(refname:short)").split("\n").filter(Boolean);
  const hermesWts = worktreesOf(repo).filter((w) => w.path.includes("hermes-worktrees"));
  log(`  hermes branches now: ${JSON.stringify(branches)}; worktrees: ${JSON.stringify(hermesWts.map((w) => w.branch))}`);
  check(branches.every((b) => hermesWts.some((w) => w.branch === b)), "every hermes/ branch is checked out by a task (nothing left over)");
} catch (e) {
  error = e;
}
await endScenario({ ctx, app, error, scenario: SCENARIO, cleanup: () => rmrf(work) });
