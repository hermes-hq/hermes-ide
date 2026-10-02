#!/usr/bin/env node
// QA-launcher-same-task-twice (SOLO-09): the same task again (picked from
// Recent) gets the next free branch by itself (hermes/fix-this-test-2) and
// Enter launches it, with no branch typed. A task with nothing to name a
// branch after (emoji) gets hermes/task-<id>, and German letters are spelled
// out (ä → ae, ß → ss), never dropped.
//
// Negative control: a build before the fix blocks the second launch with
// "Branch hermes/fix-this-test already exists".

import { join } from "node:path";
import { launcherState, openLauncher, pressKeyOnFocus, typeInto, waitLaunchEnabled, waitLauncherClosed } from "../launcher-steps.mjs";
import { launchedSince, runLauncherQa, sleep } from "../qa-launcher-steps.mjs";

await runLauncherQa("QA-launcher-same-task-twice", async ({ bridge, fx, log, check, evidenceDir }) => {
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "Fix this test");
  await waitLaunchEnabled(bridge);
  await bridge.click(".task-launcher-launch");
  await waitLauncherClosed(bridge);
  await fx.waitForRecords(1);

  await openLauncher(bridge);
  await bridge.waitFor("the Recent button", `return !!e2e.first(".task-launcher-recent");`);
  await bridge.click(".task-launcher-recent");
  await sleep(1500);
  let st = await launcherState(bridge);
  log(`  the same task again: where=${st.where} blocks=${JSON.stringify(st.blocks)} launchDisabled=${st.launchDisabled}`);
  check(/hermes\/fix-this-test-2/.test(st.where), "the made-up branch steps past the one that exists");
  check(!st.launchDisabled && st.blocks.length === 0, "the same task again is launchable without typing a branch name");
  const before = fx.records().length;
  await pressKeyOnFocus(bridge, "Enter");
  check(await launchedSince(fx, before), "Enter launches it");
  check(fx.worktrees().some((w) => w.branch === "hermes/fix-this-test-2"), "on hermes/fix-this-test-2");
  await bridge.screenshot(join(evidenceDir, "01-second.png"));

  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "🚀🚀");
  await sleep(600);
  st = await launcherState(bridge);
  log(`  an emoji task: where=${st.where}`);
  check(/hermes\/task-[0-9a-f]{6}/.test(st.where), "a task with nothing to name a branch after gets hermes/task-<id>");
  await typeInto(bridge, ".task-launcher-task", "Größe prüfen");
  await sleep(600);
  st = await launcherState(bridge);
  log(`  a German task: where=${st.where}`);
  check(/hermes\/groesse-pruefen/.test(st.where), "German letters are spelled out in the branch");
});
