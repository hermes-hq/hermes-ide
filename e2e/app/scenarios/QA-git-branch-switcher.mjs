#!/usr/bin/env node
// QA-git (QAGIT-05, QAGIT-07, QAGIT-08): the branch switcher of a task never
// loses commits or moves the task's worktree without asking, and closing
// commits to the branch the dialog names.
//
//   (a) × on hermes/old-task (one commit no other branch has) → "Yes": the
//       switcher says "hermes/old-task has 1 commit not on main." with Keep /
//       Delete anyway; Keep keeps it, and no text mentions an option the
//       switcher lacks.
//   (b) one click on feature/inbox asks "Switch this task's worktree from
//       hermes/… to feature/inbox? …"; Cancel stays; Switch switches.
//   (c) uncommitted work, close: the dialog says the worktree was switched
//       and its button is "Commit to feature/inbox & close"; the commit lands
//       on feature/inbox and the task's own branch does not move.
//
// Negative control: a build from before the fix ends in RESULT: FAIL.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  L,
  closeSessionByLabel,
  dialogText,
  endScenario,
  gitAs,
  gitFixtures,
  launchTask,
  openReviewDesk,
  scenarioContext,
  sessionLabel,
  sleep,
  waitSessionGone,
  worktreeInfo,
} from "../qa-git-steps.mjs";

const SCENARIO = "QA-git-branch-switcher";
const ctx = scenarioContext(SCENARIO);
const { evidenceDir, log, check } = ctx;

const fx = gitFixtures("switcher", log);
// A branch with work nobody merged (what an earlier session left behind).
fx.git("branch", "hermes/old-task", "main");
const tmpWt = join(fx.work, "old-wt");
fx.git("worktree", "add", "-q", tmpWt, "hermes/old-task");
writeFileSync(join(tmpWt, "OLD-WORK.md"), "a day of work\n");
gitAs(tmpWt, "add", ".");
gitAs(tmpWt, "commit", "-q", "-m", "old task work");
const oldSha = gitAs(tmpWt, "rev-parse", "HEAD");
fx.git("worktree", "remove", tmpWt);

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
  const r = await launchTask(bridge, { task: "Tidy the branches", log });
  const label = await sessionLabel(bridge, r.sessionId);
  const wt = await worktreeInfo(bridge, r.sessionId, project.id);
  log(`  task "${label}" on ${wt.branchName}`);

  log("(a) delete hermes/old-task, which has 1 unmerged commit");
  await openSwitcher(bridge, label);
  await clickRow(bridge, "hermes/old-task", ".git-branch-delete");
  await bridge.click(".git-branch-delete-yes");
  const ask = await bridge.waitFor("the unmerged question", `const d = e2e.first(".git-branch-unmerged"); return d ? e2e.norm(d.innerText) : null;`, { timeoutMs: 10_000 });
  log(`  switcher says: ${ask}`);
  await bridge.screenshot(join(evidenceDir, "01-unmerged.png"));
  check(ask.includes("hermes/old-task has 1 commit not on main."), "the switcher says how many commits only that branch has");
  check(!/force/i.test(ask), "no text mentions a force option the switcher does not have");
  await bridge.click(".git-branch-unmerged .git-branch-unmerged-keep");
  await sleep(500);
  check(fx.git("branch", "--list", "hermes/old-task") !== "", "Keep keeps the branch");
  check(fx.git("for-each-ref", "--contains", oldSha, "--format=%(refname)") !== "", "its commit is still on a ref");

  log("(b) one click on feature/inbox asks first");
  await openSwitcher(bridge, label);
  await clickRow(bridge, "feature/inbox", ".git-branch-item-name");
  const sw = await bridge.waitFor("the switch question", `const d = e2e.first(".git-branch-switch-confirm"); return d ? e2e.norm(d.innerText) : null;`, { timeoutMs: 10_000 });
  log(`  asks: ${sw}`);
  check(sw.includes(`Switch this task's worktree from ${wt.branchName} to feature/inbox? The agent's next commits and Land will use feature/inbox.`), "the question names both branches and what follows the switch");
  await bridge.click(".git-branch-switch-confirm .git-branch-switch-cancel");
  await sleep(500);
  check(gitAs(wt.worktreePath, "branch", "--show-current") === wt.branchName, "Cancel leaves the worktree on its branch");
  await openSwitcher(bridge, label);
  await clickRow(bridge, "feature/inbox", ".git-branch-item-name");
  await bridge.waitFor("the switch question", `return !!e2e.first(".git-branch-switch-confirm");`, { timeoutMs: 10_000 });
  await bridge.click(".git-branch-switch-confirm .git-branch-switch-yes");
  await bridge.waitFor("the switch", `return !e2e.first(".git-branch-selector");`, { timeoutMs: 15_000 }).catch(() => {});
  await sleep(800);
  check(gitAs(wt.worktreePath, "branch", "--show-current") === "feature/inbox", "Switch moves the worktree to feature/inbox");

  log("(c) uncommitted work, close the task");
  writeFileSync(join(wt.worktreePath, "AGENT-WORK.md"), "agent work\n");
  const inboxBefore = fx.git("rev-parse", "feature/inbox");
  const taskBefore = fx.git("rev-parse", wt.branchName);
  await bridge.clickWhenReady(`const d = e2e.first(".review-desk"); if (!d) return true; const b = e2e.all("button", d).find((x) => /^close/i.test(e2e.nameOf(x)) || x.className.includes("close")); return e2e.click(e2e.must(b, "Review Desk close"));`);
  await bridge.waitFor("the Review Desk to close", `return !e2e.first(".review-desk");`);
  await closeSessionByLabel(bridge, label);
  await bridge.waitFor("the Uncommitted Changes dialog", `return !!e2e.first(".dirty-wt-modal");`, { timeoutMs: 15_000 });
  const dlg = await dialogText(bridge);
  log(`  dialog: ${dlg}`);
  await bridge.screenshot(join(evidenceDir, "02-dirty-dialog.png"));
  check(dlg.includes(`This task's worktree was switched from ${wt.branchName} to feature/inbox.`), "the dialog says the worktree was switched");
  check(dlg.includes("Commit to feature/inbox & close"), "the commit button names the branch the commit goes to");
  await bridge.clickByName("Commit to feature/inbox & close", { within: ".dirty-wt-actions" });
  await waitSessionGone(bridge, label);
  await sleep(1500);
  const inboxAfter = fx.git("rev-parse", "feature/inbox");
  check(inboxAfter !== inboxBefore && fx.git("show", "--name-only", "--format=", "feature/inbox").includes("AGENT-WORK.md"), "the work is committed on feature/inbox, the branch the dialog named");
  check(fx.git("rev-parse", wt.branchName) === taskBefore, `${wt.branchName} did not move`);
} catch (e) {
  error = e;
}
await endScenario({ ctx, app, error, scenario: SCENARIO, cleanup: () => fx.cleanup() });
