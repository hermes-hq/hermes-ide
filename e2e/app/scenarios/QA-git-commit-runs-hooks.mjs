#!/usr/bin/env node
// QA-git (QAGIT-13): Hermes' commits run the repository's hooks.
//
// The repository's pre-commit hook blocks secrets. The agent leaves a file
// with a key in the task's worktree. "Commit to session branch & close" is
// made with `git commit`, so the hook refuses: the dialog shows
// "pre-commit refused: pre-commit: secret detected" with Archive instead and
// Cancel, and the task branch does not move. "Archive instead" keeps the
// work on a hermes-archive/ branch (a snapshot, like a stash) and the
// worktree goes.
//
// macOS and Linux only (the hook is a POSIX shell script).
// Negative control: a build from before the fix ends in RESULT: FAIL (the
// secret was committed: libgit2 ran no hook).

import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { skipScenario } from "../harness.mjs";
import {
  L,
  closeSessionByLabel,
  dialogText,
  endScenario,
  gitFixtures,
  launchTask,
  onWindows,
  scenarioContext,
  sessionLabel,
  sleep,
  worktreeInfo,
} from "../qa-git-steps.mjs";

const SCENARIO = "QA-git-commit-runs-hooks";
if (onWindows) skipScenario({ scenario: SCENARIO, reason: "the hook is a POSIX shell script" });
const ctx = scenarioContext(SCENARIO);
const { evidenceDir, log, check } = ctx;
const fx = gitFixtures("hooks", log);
const hook = join(fx.repo, ".git", "hooks", "pre-commit");
writeFileSync(hook, `#!/bin/sh\nif git diff --cached | grep -q SECRET_ACCESS_KEY; then echo "pre-commit: secret detected" >&2; exit 1; fi\n`);
chmodSync(hook, 0o755);

let app;
let error;
try {
  app = await fx.launchFx(evidenceDir);
  const { bridge } = app;
  const project = await L.completeTaskWelcome(bridge, fx.repo);
  const r = await launchTask(bridge, { task: "Wire the storage client", log });
  const label = await sessionLabel(bridge, r.sessionId);
  const wt = await worktreeInfo(bridge, r.sessionId, project.id);
  writeFileSync(join(wt.worktreePath, "storage.env"), "AWS_SECRET_ACCESS_KEY=AKIAEXAMPLEEXAMPLE\n");
  const before = fx.git("rev-parse", wt.branchName);

  log("step 1: Commit to session branch & close");
  await closeSessionByLabel(bridge, label);
  await bridge.waitFor("the Uncommitted Changes dialog", `return !!e2e.first(".dirty-wt-modal");`, { timeoutMs: 15_000 });
  await bridge.clickByName("Commit to session branch & close", { within: ".dirty-wt-actions" });
  await bridge.waitFor("the hook's refusal", `return !!e2e.first(".dirty-wt-hook-refused");`, { timeoutMs: 30_000 });
  const dlg = await dialogText(bridge);
  log(`  dialog: ${dlg.slice(-400)}`);
  await bridge.screenshot(join(evidenceDir, "01-hook-refused.png"));
  check(dlg.includes("pre-commit refused: pre-commit: secret detected"), "the dialog shows what the pre-commit hook said");
  check(/Archive instead/.test(dlg) && /Cancel/.test(dlg), "it offers Archive instead and Cancel");
  check(fx.git("rev-parse", wt.branchName) === before, "the task branch did not move (the secret is not committed)");
  check(existsSync(join(wt.worktreePath, "storage.env")), "the work is still in the worktree");

  log("step 2: Archive instead");
  await bridge.click(".dirty-wt-modal .dirty-wt-btn--archive-instead");
  await bridge.waitFor("the dialog to close", `return !e2e.first(".dirty-wt-modal");`, { timeoutMs: 30_000 });
  for (let i = 0; i < 100 && existsSync(wt.worktreePath); i++) await sleep(200);
  const stem = wt.branchName.replace(/^hermes\//, "");
  const archived = fx.git("branch", "--list", `hermes-archive/${stem}*`, "--format=%(refname:short)");
  log(`  archive branches: ${JSON.stringify(archived)}`);
  check(archived !== "" && fx.git("show", "--name-only", "--format=", archived.split("\n")[0]).includes("storage.env"), "the work is kept on a hermes-archive/ branch");
  check(fx.git("rev-parse", wt.branchName) === before, "the task branch still did not move");
  check(!existsSync(wt.worktreePath), "the worktree folder is gone");
} catch (e) {
  error = e;
}
await endScenario({ ctx, app, error, scenario: SCENARIO, cleanup: () => fx.cleanup() });
