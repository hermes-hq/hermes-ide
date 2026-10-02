#!/usr/bin/env node
// QA-launcher-current-checkout-not-sticky (QAGIT-16): a quick task is run
// once on the current checkout. The next ⌘N starts a new worktree again
// (the current checkout is never carried over from the last launch; a
// preset can still hold it), and while the current checkout is chosen the
// launcher says it in red: "Not isolated: edits your project folder on main."
//
// Negative control: a build before the fix keeps "current checkout · main"
// for the next task, in the same grey as everything else.

import { join } from "node:path";
import { invoke, launcherState, newTerminals, openLauncher, pickInMenu, typeInto, waitLaunchEnabled, waitLauncherClosed } from "../launcher-steps.mjs";
import { runLauncherQa, sleep } from "../qa-launcher-steps.mjs";

await runLauncherQa("QA-launcher-current-checkout-not-sticky", async ({ bridge, fx, log, check, evidenceDir }) => {
  const project = (await invoke(bridge, "get_projects_ordered")).find((p) => fx.samePath(p.path, fx.repo));
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "Check why the build is red");
  await pickInMenu(bridge, "where", '[data-where="current-checkout"]');
  await sleep(400);
  const marked = await bridge.eval(`return { danger: e2e.first('[data-chip="where"]').classList.contains("danger"), note: e2e.norm(e2e.first(".task-launcher-unisolated")?.innerText ?? "") };`);
  log(`  current checkout chosen: ${JSON.stringify(marked)}`);
  check(marked.danger, "the where chip is red");
  check(marked.note === "Not isolated: edits your project folder on main.", "and the launcher says the task edits the project folder");
  await bridge.screenshot(join(evidenceDir, "01-current-checkout.png"));
  await waitLaunchEnabled(bridge);
  await bridge.click(".task-launcher-launch");
  await waitLauncherClosed(bridge);
  await fx.waitForRecords(1);

  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "Refactor the payment module");
  await sleep(1200);
  const st = await launcherState(bridge);
  log(`  the next task: where="${st.where}"`);
  check(/new worktree/.test(st.where), "the next task starts on a new worktree");
  check(!(await bridge.exists(".task-launcher-unisolated")), "with no 'Not isolated' note");
  const before = await bridge.terminalIds();
  await bridge.click(".task-launcher-launch");
  const ids = await newTerminals(bridge, before, 1, "the task", 30_000);
  const wt = await invoke(bridge, "git_session_worktree_info", { sessionId: ids[0], projectId: project.id });
  log(`  runs in: ${wt ? wt.worktreePath + " (" + wt.branchName + ")" : "the project folder"}`);
  check(!!wt && !wt.isMainWorktree, "and it runs isolated");
});
