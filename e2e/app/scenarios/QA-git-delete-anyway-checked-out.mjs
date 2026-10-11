#!/usr/bin/env node
// QA-git-delete-anyway-checked-out — the branch switcher's "Delete anyway"
// on another task's branch (one commit no other branch has, checked out in
// that task's worktree) removed the branch ref anyway, leaving that task on
// a branch with no commits.
//
// EXPECT: two tasks, each in its own worktree; the first has a commit of its
// own. From the second task's branch switcher: × on the first task's branch →
// Yes → "has 1 commit not on main" → Delete anyway is refused with a plain
// message (no library codes), and the branch, its commit and the first task's
// worktree on it all still exist.
//
// Negative control: a build without the fix ends in RESULT: FAIL (the branch
// is gone).

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  L,
  endScenario,
  gitAs,
  gitFixtures,
  launchTask,
  openReviewDesk,
  scenarioContext,
  sessionLabel,
  sleep,
  tryGit,
  worktreeInfo,
  worktreesOf,
} from "../qa-git-steps.mjs";

const SCENARIO = "QA-git-delete-anyway-checked-out";
const ctx = scenarioContext(SCENARIO);
const { evidenceDir, log, check } = ctx;

const fx = gitFixtures("delete-checked-out", log);

async function openSwitcher(bridge, label) {
  if (!(await bridge.exists(".review-desk"))) await openReviewDesk(bridge, label);
  await bridge.waitFor("the Review Desk's branch", `return !!e2e.first(".review-desk .git-project-branch-clickable");`, { timeoutMs: 20_000 });
  if (!(await bridge.exists(".git-branch-selector"))) await bridge.click(".review-desk .git-project-branch-clickable");
  await bridge.waitFor("the branch switcher", `return e2e.all(".git-branch-item").length > 1;`, { timeoutMs: 15_000 });
}
const clickRow = (bridge, name, inner) =>
  bridge.clickWhenReady(`
    const row = e2e.all(".git-branch-item").find((el) => e2e.norm(el.querySelector(".git-branch-item-name")?.innerText) === ${JSON.stringify(name)});
    return e2e.click(e2e.must(row && row.querySelector(${JSON.stringify(inner)}), ${JSON.stringify(`${inner} on ${name}`)}));
  `);

let app;
let error;
try {
  app = await fx.launchFx(evidenceDir);
  const { bridge } = app;
  const project = await L.completeTaskWelcome(bridge, fx.repo);

  log("step 1: a first task with a commit of its own");
  const first = await launchTask(bridge, { task: "Write the parser", log });
  const firstLabel = await sessionLabel(bridge, first.sessionId);
  const firstWt = await worktreeInfo(bridge, first.sessionId, project.id);
  writeFileSync(join(firstWt.worktreePath, "PARSER.md"), "the parser\n");
  gitAs(firstWt.worktreePath, "add", ".");
  gitAs(firstWt.worktreePath, "commit", "-q", "-m", "parser work");
  const firstSha = gitAs(firstWt.worktreePath, "rev-parse", "HEAD");
  log(`  task "${firstLabel}" on ${firstWt.branchName} in ${firstWt.worktreePath}, at ${firstSha}`);

  log("step 2: a second task");
  const second = await launchTask(bridge, { task: "Write the printer", log });
  const secondLabel = await sessionLabel(bridge, second.sessionId);
  const secondWt = await worktreeInfo(bridge, second.sessionId, project.id);
  log(`  task "${secondLabel}" on ${secondWt.branchName}`);

  log(`step 3: from the second task's switcher, delete ${firstWt.branchName}`);
  await openSwitcher(bridge, secondLabel);
  await clickRow(bridge, firstWt.branchName, ".git-branch-delete");
  await bridge.click(".git-branch-delete-yes");
  const ask = await bridge.waitFor("the unmerged question", `const d = e2e.first(".git-branch-unmerged"); return d ? e2e.norm(d.innerText) : null;`, { timeoutMs: 10_000 });
  log(`  switcher says: ${ask}`);
  check(ask.includes(`${firstWt.branchName} has 1 commit not on main.`), "the switcher asks first: the branch has a commit no other branch has");

  log("step 4: Delete anyway");
  await bridge.click(".git-branch-unmerged .git-branch-unmerged-delete");
  const outcome = await bridge.waitFor(
    "the switcher to answer",
    `
    const err = e2e.first(".git-branch-selector .git-error");
    if (err) return { error: e2e.norm(err.innerText) };
    if (!e2e.first(".git-branch-unmerged")) {
      const names = e2e.all(".git-branch-item .git-branch-item-name").map((el) => e2e.norm(el.innerText));
      if (!names.includes(${JSON.stringify(firstWt.branchName)})) return { deleted: true };
    }
    return null;`,
    { timeoutMs: 15_000 },
  );
  log(`  outcome: ${JSON.stringify(outcome)}`);
  await sleep(500);
  await bridge.screenshot(join(evidenceDir, "01-delete-anyway.png"));
  check(!!outcome.error, "Delete anyway is refused");
  if (outcome.error) {
    check(outcome.error.includes(`Could not delete ${firstWt.branchName}`), `the message names the branch it kept ("${outcome.error}")`);
    check(!/class=|error code|git2|libgit/i.test(outcome.error), "the message is plain words, without library codes");
  }

  log("step 5: the branch, its commit and the first task's worktree are untouched");
  const branch = tryGit(fx.repo, "rev-parse", "--verify", "-q", `refs/heads/${firstWt.branchName}`);
  log(`  ${firstWt.branchName}: ${branch.ok ? branch.out : "missing"}`);
  check(branch.ok && branch.out === firstSha, `${firstWt.branchName} still exists, at its commit`);
  const linked = worktreesOf(fx.repo).find((w) => w.branch === firstWt.branchName);
  log(`  worktree on it: ${JSON.stringify(linked ?? null)}`);
  check(!!linked, "the first task's worktree still has the branch checked out");
  const head = tryGit(firstWt.worktreePath, "log", "-1", "--format=%H %s");
  log(`  first task's HEAD: ${head.out}`);
  check(head.ok && head.out.startsWith(firstSha), "the first task's worktree still shows its commit");
  const shown = await bridge.eval(`return e2e.all(".session-item").some((el) => el.innerText.includes(${JSON.stringify(firstLabel)}));`);
  check(shown, `"${firstLabel}" is still in the session list`);
} catch (e) {
  error = e;
}
await endScenario({ ctx, app, error, scenario: SCENARIO, cleanup: () => fx.cleanup() });
