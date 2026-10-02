#!/usr/bin/env node
// QA-launcher-start-project (SOLO-07, ACC-12): the active session is a plain
// shell (⌘T) in the home folder, as a sign-in terminal is too. ⌘N starts on
// the project the person uses (launcher-repo), not on a folder that is no
// repository with Launch disabled; from a session inside the repository it
// starts there as before.
//
// Negative control: a build before the fix opens on the home folder with
// "This folder is not a git repository." and Launch disabled.

import { join } from "node:path";
import { launcherState, openLauncher, typeInto, waitLaunchEnabled, waitLauncherClosed } from "../launcher-steps.mjs";
import { menuAction, runLauncherQa, sleep } from "../qa-launcher-steps.mjs";

await runLauncherQa("QA-launcher-start-project", async ({ bridge, log, check, evidenceDir }) => {
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "Fix this test");
  await waitLaunchEnabled(bridge);
  await bridge.click(".task-launcher-launch");
  await waitLauncherClosed(bridge);
  await bridge.waitFor("the task's session", `return e2e.all(".session-item").length === 1;`, { timeoutMs: 20_000 });

  await menuAction(bridge, "file.new-session-tab");
  await bridge.waitFor("the plain shell", `return e2e.all(".session-item").length === 2;`, { timeoutMs: 20_000 });
  await sleep(1500);
  await openLauncher(bridge);
  await sleep(1200);
  const st = await launcherState(bridge);
  log(`  ⌘N from the plain shell: project=${st.project} blocks=${JSON.stringify(st.blocks)}`);
  await bridge.screenshot(join(evidenceDir, "01-from-plain-shell.png"));
  check(st.project === "launcher-repo", "⌘N from a plain shell starts on the project");
  check(!st.blocks.some((b) => b.kind === "not-git"), "with no 'not a git repository' row");
  await typeInto(bridge, ".task-launcher-task", "Second task");
  await waitLaunchEnabled(bridge);
  check(true, "and Launch is enabled");
});
