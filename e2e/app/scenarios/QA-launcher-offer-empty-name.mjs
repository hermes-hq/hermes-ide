#!/usr/bin/env node
// QA-launcher-offer-empty-name (SOLO-18): after the third identical launch
// the launcher offers "Save it as a preset?". Clearing the suggested name
// and pressing Enter saves nothing and keeps the offer (like the Save
// button, disabled for an empty name); only "No, don't ask again" stops the
// offer for good, and the offer is not recorded as answered before that.
//
// Negative control: a build before the fix drops the offer on that Enter,
// for good, with nothing saved.

import { join } from "node:path";
import { invoke, MOD, openLauncher, pressKeyOnFocus, typeInto, waitLaunchEnabled, waitLauncherClosed } from "../launcher-steps.mjs";
import { runLauncherQa, sleep } from "../qa-launcher-steps.mjs";

await runLauncherQa("QA-launcher-offer-empty-name", async ({ bridge, log, check, evidenceDir }) => {
  for (const t of ["one", "two", "three"]) {
    await openLauncher(bridge);
    await typeInto(bridge, ".task-launcher-task", `Offer task ${t}`);
    await waitLaunchEnabled(bridge);
    if (t === "three") {
      await pressKeyOnFocus(bridge, "Enter", MOD);
      break;
    }
    await bridge.click(".task-launcher-launch");
    await waitLauncherClosed(bridge);
  }
  await bridge.waitFor("the offer", `return !!e2e.first(".task-launcher-suggest-name");`, { timeoutMs: 30_000 });
  await typeInto(bridge, ".task-launcher-suggest-name", "");
  const saveDisabled = await bridge.eval(`return e2e.first(".task-launcher-suggest-save").disabled;`);
  await pressKeyOnFocus(bridge, "Enter");
  await sleep(600);
  const s = await bridge.eval(`return { offer: !!e2e.first(".task-launcher-suggest"), presets: e2e.all(".task-launcher-preset").length };`);
  log(`  Save disabled for an empty name: ${saveDisabled}; after Enter: ${JSON.stringify(s)}`);
  check(saveDisabled, "Save is disabled for an empty name");
  check(s.offer && s.presets === 0, "Enter with an empty name keeps the offer and saves nothing");
  await bridge.screenshot(join(evidenceDir, "01-offer-kept.png"));
  await typeInto(bridge, ".task-launcher-suggest-name", "My usual");
  await pressKeyOnFocus(bridge, "Enter");
  await sleep(800);
  const saved = (await invoke(bridge, "list_launch_presets")).map((p) => p.name);
  check(saved.includes("My usual"), `a name typed then saves it (${JSON.stringify(saved)})`);
  check(!(await bridge.exists(".task-launcher-suggest")), "and the offer goes away");
});
