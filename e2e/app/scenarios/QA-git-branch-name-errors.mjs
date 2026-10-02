#!/usr/bin/env node
// QA-git (QAGIT-14, backend half): a branch name git refuses never leaves a
// branch behind, and the failure is said in words.
//
// The repository has release/2.3 and feature/inbox. A task is launched with
// branch names git refuses or cannot make a folder for: "release" (a folder
// of branches), "feature/inbox/sub", "hermes/.wip" and a 247-character name.
// Each is either flagged by the launcher before Launch, or — when it gets to
// the backend — fails with a sentence (no libgit2 class/code, no project id)
// and leaves no new branch.
//
// Negative control: a build from before the fix ends in RESULT: FAIL (the
// long name's branch stayed, and the toast showed libgit2 text and an id).

import { join } from "node:path";
import { L, endScenario, gitFixtures, scenarioContext, sleep, toasts } from "../qa-git-steps.mjs";

const SCENARIO = "QA-git-branch-name-errors";
const ctx = scenarioContext(SCENARIO);
const { evidenceDir, log, check } = ctx;
const fx = gitFixtures("branchnames", log);
fx.git("branch", "release/2.3", "main");
const LONG = "hermes/" + "x".repeat(240);

let app;
let error;
try {
  app = await fx.launchFx(evidenceDir);
  const { bridge } = app;
  await L.completeTaskWelcome(bridge, fx.repo);
  for (const [i, name] of ["release", "feature/inbox/sub", "hermes/.wip", LONG].entries()) {
    log(`case ${i + 1}: "${name.length > 40 ? `${name.slice(0, 40)}…(${name.length} chars)` : name}"`);
    await L.openLauncher(bridge);
    await L.typeInto(bridge, ".task-launcher-task", `Name check ${i + 1}`);
    await L.openChip(bridge, "where");
    await L.typeInto(bridge, ".task-launcher-menu .task-launcher-branch", name);
    await sleep(1500);
    const st = await L.launcherState(bridge);
    log(`  blocks ${JSON.stringify(st.blocks)}; launch disabled ${st.launchDisabled}`);
    if (st.launchDisabled) {
      check(st.blocks.length > 0, `the launcher flags "${name.slice(0, 40)}" before Launch`);
    } else {
      const branchesBefore = fx.git("branch", "--format=%(refname:short)");
      const toastsBefore = (await toasts(bridge)).length;
      await bridge.click(".task-launcher-launch");
      await sleep(4000);
      const shown = (await toasts(bridge)).slice(toastsBefore);
      log(`  after Launch: ${JSON.stringify(shown).slice(0, 600)}`);
      check(!shown.some((x) => /class=|code=|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/.test(x)), "the error is in words (no libgit2 class/code, no id)");
      const branchesAfter = fx.git("branch", "--format=%(refname:short)");
      const added = branchesAfter.split("\n").filter((b) => !branchesBefore.split("\n").includes(b));
      check(added.length === 0, `a failed launch leaves no new branch (${added.map((b) => b.slice(0, 30)).join(", ") || "none"})`);
      await bridge.screenshot(join(evidenceDir, `case-${i + 1}.png`));
    }
    for (let k = 0; k < 3 && (await bridge.exists(".task-launcher-sheet")); k++) {
      await bridge.eval(`(e2e.first(".task-launcher-task") || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); return true;`);
      await sleep(400);
    }
  }
} catch (e) {
  error = e;
}
await endScenario({ ctx, app, error, scenario: SCENARIO, cleanup: () => fx.cleanup() });
