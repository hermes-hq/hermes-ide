#!/usr/bin/env node
// QA-launcher-track-current-checkout (PLN-04): in the launcher, Where =
// Current checkout with "Track as a feature" ticked. The launch creates the
// feature in the repository's own folder (.hermes/features/<slug>/
// feature.md), as the option promises; it never silently creates nothing.
//
// Negative control: a build before the fix writes feature.md only into a
// worktree, so a current-checkout task gets none, without a word.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expandOptions, newTerminals, openLauncher, typeInto, waitLaunchEnabled, waitLauncherClosed } from "../launcher-steps.mjs";
import { runLauncherQa, sleep } from "../qa-launcher-steps.mjs";

await runLauncherQa("QA-launcher-track-current-checkout", async ({ bridge, fx, log, check, evidenceDir }) => {
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "Add an add function");
  await expandOptions(bridge);
  await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.first('.task-launcher-options [data-where="current-checkout"]'), "current checkout"));`);
  await bridge.clickWhenReady(`const box = e2e.must(e2e.first(".task-launcher-feature-box"), "Track as a feature"); return box.checked ? true : e2e.click(box);`);
  await waitLaunchEnabled(bridge);
  const before = await bridge.terminalIds();
  await bridge.click(".task-launcher-launch");
  await waitLauncherClosed(bridge);
  await newTerminals(bridge, before, 1, "the agent's terminal");
  await fx.waitForRecords(1);
  await sleep(2500);
  const file = join(fx.repo, ".hermes", "features", "add-an-add-function", "feature.md");
  log(`  ${file}: ${existsSync(file)}`);
  check(existsSync(file) && /track: Full/.test(readFileSync(file, "utf8")), "Track as a feature creates the feature in the project folder for a current-checkout task");
  const toasts = await bridge.eval(`return e2e.all(".toast").map((x) => e2e.norm(x.innerText));`);
  check(!toasts.some((t) => /Couldn't create the feature track/.test(t)), `no failure is reported (${JSON.stringify(toasts)})`);
  await bridge.screenshot(join(evidenceDir, "01-after-launch.png"));
});
