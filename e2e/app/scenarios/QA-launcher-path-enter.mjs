#!/usr/bin/env node
// QA-launcher-path-enter (SOLO-11, NEWCOMER-06): the project chip's "or type
// a path" field. Enter there confirms the folder (the menu closes, the task
// field has the keyboard); it never launches. The next Enter launches in
// that folder. A path typed with "~" is read as the home folder and shown
// resolved under the field.
//
// Negative control: a build before the fix launches the task on Enter in
// the path field, and reads "~/…" as "not a git repository".

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { invoke, launcherState, onWindows, openChip, openLauncher, pressKey, pressKeyOnFocus, typeInto } from "../launcher-steps.mjs";
import { focusState, launchedSince, runLauncherQa, sleep } from "../qa-launcher-steps.mjs";

await runLauncherQa("QA-launcher-path-enter", async ({ bridge, fx, log, check, evidenceDir }) => {
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "Rename foo to bar");
  await openChip(bridge, "project");
  await typeInto(bridge, ".task-launcher-repo", fx.otherRepo);
  await sleep(1000);
  const before = fx.records().length;
  await pressKey(bridge, ".task-launcher-repo", "Enter");
  await sleep(2500);
  const s = await bridge.eval(`return { sheet: !!e2e.first(".task-launcher-sheet"), menu: e2e.first(".task-launcher-menu")?.getAttribute("data-menu") ?? null };`);
  log(`  after Enter in the path field: ${JSON.stringify(s)}; agents started: ${fx.records().length - before}`);
  check(fx.records().length === before, "Enter in the path field does not launch the task");
  check(s.sheet && !s.menu && (await focusState(bridge)).task, "the folder is confirmed: the menu closed, the keyboard is in the task field");
  check((await launcherState(bridge)).project === "other-repo", "the project chip says other-repo");
  await pressKeyOnFocus(bridge, "Enter");
  check(await launchedSince(fx, before), "the next Enter launches the task");

  if (!onWindows) {
    // "~" is the home folder (the app's private one in this test): asked of the app itself.
    const home = (await invoke(bridge, "task_repo_probe", { path: "~", branch: null })).resolved;
    const demo = join(home, "code", "demo-tilde");
    mkdirSync(demo, { recursive: true });
    execFileSync("git", ["init", "-q", demo]);
    log(`  a repository at ~/code/demo-tilde (${demo})`);
    await openLauncher(bridge);
    await openChip(bridge, "project");
    await typeInto(bridge, ".task-launcher-repo", "~/code/demo-tilde");
    await sleep(1200);
    const state = await bridge.eval(`return { note: e2e.norm(e2e.first(".task-launcher-repo-state")?.innerText ?? ""), blocks: e2e.all(".task-launcher-block").map((b) => b.getAttribute("data-kind")) };`);
    log(`  ~/code/demo-tilde: ${JSON.stringify(state)}`);
    check(/→ .*code[\\/]demo-tilde/.test(state.note), "the path is shown resolved under the field");
    check(!state.blocks.includes("not-git"), "and it is read as the git repository in the home folder");
    await bridge.screenshot(join(evidenceDir, "01-tilde.png"));
  }
});
