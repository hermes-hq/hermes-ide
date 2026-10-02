#!/usr/bin/env node
// QA-git (QAGIT-02, QAGIT-19): work inside a git submodule of a task's
// worktree is never destroyed by closing the task.
//
//   A. The agent initialises the submodule in the task's worktree and commits
//      a fix inside it (that commit lives only in the worktree's private
//      module store). "Commit to session branch & close" records the
//      submodule commit on the task branch, and the commit itself is kept in
//      a store that stays (the project's .git/modules/vendor/lib) under
//      refs/hermes/archive/<session>/vendor/lib/….
//   B. An uncommitted edit inside the submodule only: the dialog says Hermes
//      cannot commit that and offers "Keep the worktree" (never "There are no
//      changes to commit"); keeping leaves the folder and the edit on disk.
//
// Negative control: a build from before the fix ends in RESULT: FAIL (the
// close deleted the only copy of the submodule commit).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  L,
  closeSessionByLabel,
  dialogText,
  endScenario,
  fakeAgents,
  gitIn,
  launch,
  launchTask,
  makeRepo,
  rmrf,
  scenarioContext,
  sessionLabel,
  sleep,
  tmpWork,
  waitSessionGone,
  worktreeInfo,
  onWindows,
} from "../qa-git-steps.mjs";
import { skipScenario } from "../harness.mjs";

const SCENARIO = "QA-git-submodule-work-kept";
if (onWindows) skipScenario({ scenario: SCENARIO, reason: "file-protocol submodules and their worktree stores are checked on macOS and Linux" });
const ctx = scenarioContext(SCENARIO);
const { evidenceDir, log, check } = ctx;

const work = tmpWork("submodule");
const fakes = fakeAgents(work);
const lib = makeRepo(join(work, "vendor-lib"), { files: { "lib.txt": "v1\n" } });
const sup = makeRepo(join(work, "monorepo"), { files: { "README.md": "# monorepo\n" } });
gitIn(sup, "submodule", "add", "-q", lib, "vendor/lib");
gitIn(sup, "commit", "-q", "-m", "vendor lib");
const homeDir = join(work, "home");
const hasCommit = (dir, sha) => {
  try {
    gitIn(dir, "cat-file", "-e", `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
};

let app;
let error;
try {
  app = await launch({ evidenceDir, homeDir, log, fakes });
  const { bridge } = app;
  const project = await L.completeTaskWelcome(bridge, sup);

  log("A1: a task in a new worktree; the agent commits inside the submodule");
  const r = await launchTask(bridge, { task: "Fix the vendored lib", log });
  const label = await sessionLabel(bridge, r.sessionId);
  const wt = await worktreeInfo(bridge, r.sessionId, project.id);
  gitIn(wt.worktreePath, "submodule", "update", "--init", "-q");
  const subDir = join(wt.worktreePath, "vendor", "lib");
  writeFileSync(join(subDir, "lib.txt"), "v2 — the fix\n");
  gitIn(subDir, "commit", "-q", "-am", "fix in vendored lib");
  const subSha = gitIn(subDir, "rev-parse", "HEAD");
  log(`  submodule commit ${subSha.slice(0, 10)}`);

  log("A2: close → Commit to session branch & close");
  await closeSessionByLabel(bridge, label);
  await bridge.waitFor("the Uncommitted Changes dialog", `return !!e2e.first(".dirty-wt-modal");`, { timeoutMs: 15_000 });
  log(`  dialog: ${(await dialogText(bridge)).slice(0, 400)}`);
  await bridge.screenshot(join(evidenceDir, "01-dialog.png"));
  await bridge.clickByName("Commit to session branch & close", { within: ".dirty-wt-actions" });
  check(!(await bridge.exists(".close-dialog")), "no second 'Close session?' follows the choice");
  await waitSessionGone(bridge, label);
  for (let i = 0; i < 100 && existsSync(wt.worktreePath); i++) await sleep(200);
  check(!existsSync(wt.worktreePath), "the worktree folder is gone once its work is saved");
  check(gitIn(sup, "ls-tree", wt.branchName, "vendor/lib").includes(subSha), "the task branch records the submodule commit");
  const store = join(sup, ".git", "modules", "vendor", "lib");
  check(hasCommit(store, subSha), `the submodule commit ${subSha.slice(0, 8)} still exists in the project's module store`);
  const refs = gitIn(store, "for-each-ref", "--format=%(refname)", "refs/hermes/archive/");
  log(`  archive refs: ${JSON.stringify(refs)}`);
  check(/refs\/hermes\/archive\/.+\/vendor\/lib\//.test(refs), "a refs/hermes/archive/<session>/vendor/lib ref keeps it reachable");

  log("B1: second task; an uncommitted edit inside the submodule only");
  const r2 = await launchTask(bridge, { task: "Tweak the vendored lib", log });
  const label2 = await sessionLabel(bridge, r2.sessionId);
  const wt2 = await worktreeInfo(bridge, r2.sessionId, project.id);
  gitIn(wt2.worktreePath, "submodule", "update", "--init", "-q");
  const edited = join(wt2.worktreePath, "vendor", "lib", "lib.txt");
  writeFileSync(edited, "v3 — uncommitted\n");
  await closeSessionByLabel(bridge, label2);
  await bridge.waitFor("the Uncommitted Changes dialog", `return !!e2e.first(".dirty-wt-modal");`, { timeoutMs: 15_000 });
  const dlg = await dialogText(bridge);
  log(`  dialog: ${dlg.slice(0, 500)}`);
  await bridge.screenshot(join(evidenceDir, "02-submodule-edit.png"));
  check(dlg.includes("vendor/lib has uncommitted changes inside the submodule; Hermes cannot commit those"), "the dialog says Hermes cannot commit edits inside the submodule");
  check(!/no changes to commit/i.test(dlg), "never 'There are no changes to commit'");
  await bridge.clickWhenReady(`const b = e2e.first(".dirty-wt-modal .dirty-wt-btn--keep"); return b ? e2e.click(b) : false;`);
  await waitSessionGone(bridge, label2);
  await sleep(1000);
  check(existsSync(edited) && readFileSync(edited, "utf8") === "v3 — uncommitted\n", "Keep the worktree leaves the folder and the edit inside the submodule on disk");
  const toasts = await bridge.eval(`return e2e.all(".toast").map((t) => e2e.norm(t.innerText));`);
  log(`  toasts: ${JSON.stringify(toasts)}`);
  check(toasts.some((t) => t.includes("Kept the worktree at")), "a notice says where the worktree was kept");
} catch (e) {
  error = e;
}
await endScenario({ ctx, app, error, scenario: SCENARIO, cleanup: () => rmrf(work) });
