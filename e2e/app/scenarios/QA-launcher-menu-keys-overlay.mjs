#!/usr/bin/env node
// QA-launcher-menu-keys-overlay (SOLO-04): with a session open, ⌘N, then
// the window keys. While the launcher is in front they act on it, never on
// the workspace hidden behind it:
//   ⌘W  closes the launcher (keeping what was typed), the pane stays;
//   ⌘D  (split) does nothing (no New Session dialog on top of the sheet);
//   ⌘T  (new tab) starts no session behind it.
//
// Negative control: a build before the fix closes the pane behind the
// launcher, stacks the old New Session dialog on it and starts a shell.

import { join } from "node:path";
import { launcherState, openLauncher, typeInto, waitLaunchEnabled, waitLauncherClosed } from "../launcher-steps.mjs";
import { menuAction, runLauncherQa, sleep } from "../qa-launcher-steps.mjs";

await runLauncherQa("QA-launcher-menu-keys-overlay", async ({ bridge, log, check, evidenceDir }) => {
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "Fix this test");
  await waitLaunchEnabled(bridge);
  await bridge.click(".task-launcher-launch");
  await waitLauncherClosed(bridge);
  await bridge.waitFor("a pane with the session", `return e2e.all(".split-pane").length === 1;`, { timeoutMs: 20_000 });
  const state = () => bridge.eval(`return { launcher: !!e2e.first(".task-launcher-sheet"), creator: !!e2e.first(".session-creator"), panes: e2e.all(".split-pane").length, sessions: e2e.all(".session-item").length };`);

  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "Explain this error");
  await menuAction(bridge, "file.close-pane");
  await sleep(800);
  let s = await state();
  log(`  ⌘W with the launcher open: ${JSON.stringify(s)}`);
  await bridge.screenshot(join(evidenceDir, "01-cmd-w.png"));
  check(s.panes === 1, "⌘W leaves the pane behind the launcher alone");
  check(!s.launcher, "⌘W closes the launcher");
  await openLauncher(bridge, { draft: "keep" });
  const back = await launcherState(bridge);
  check(back.task === "Explain this error", "and the launcher kept what was typed");

  const sessionsBefore = (await state()).sessions;
  await menuAction(bridge, "view.split-horizontal");
  await sleep(1200);
  s = await state();
  log(`  ⌘D with the launcher open: ${JSON.stringify(s)}`);
  check(s.launcher && !s.creator, "⌘D does not stack the old New Session dialog on the launcher");
  await menuAction(bridge, "file.new-session-tab");
  await sleep(1800);
  s = await state();
  log(`  ⌘T with the launcher open: ${JSON.stringify(s)} (sessions before: ${sessionsBefore})`);
  check(s.sessions === sessionsBefore, "⌘T starts no session behind the launcher");
  check(s.panes === 1, "and the panes are as they were");
  await bridge.screenshot(join(evidenceDir, "02-after-keys.png"));
});
