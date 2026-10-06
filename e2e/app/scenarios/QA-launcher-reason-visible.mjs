#!/usr/bin/env node
// QA-launcher-reason-visible (NEWCOMER-12): the launcher with "+ options"
// open, on a path with no folder at it (a folder that is no repository is
// fine now: the agent works in it directly). Launch is disabled, and the
// reason stays in view next to it (outside the part of the sheet that
// scrolls) and describes the Launch button; the project chip is red.
//
// Negative control: a build before the fix scrolls the reason out of view
// with the options open, and the disabled Launch says nothing.

import { join } from "node:path";
import { expandOptions, openChip, openLauncher, pressKey, typeInto } from "../launcher-steps.mjs";
import { runLauncherQa, sleep } from "../qa-launcher-steps.mjs";

await runLauncherQa("QA-launcher-reason-visible", async ({ bridge, fx, log, check, evidenceDir }) => {
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "Fix it");
  await openChip(bridge, "project");
  await typeInto(bridge, ".task-launcher-repo", join(fx.work, "no-such-folder"));
  await sleep(800);
  await pressKey(bridge, ".task-launcher-repo", "Enter");
  await expandOptions(bridge);
  await bridge.waitFor("a block", `return !!e2e.first(".task-launcher-block");`, { timeoutMs: 20_000 });
  await sleep(500);
  // Scroll the sheet to its top, as a person reading the options would be.
  await bridge.eval(`const s = e2e.first(".task-launcher"); s.scrollTop = 0; return s.scrollHeight > s.clientHeight;`);
  await sleep(300);
  const r = await bridge.eval(`
    const b = e2e.first(".task-launcher-block"); const rb = b.getBoundingClientRect();
    const sheet = e2e.first(".task-launcher"); const rs = sheet.getBoundingClientRect();
    const l = e2e.first(".task-launcher-launch");
    const desc = (l.getAttribute("aria-describedby") || "").split(/\\s+/).filter(Boolean).map((id) => document.getElementById(id)?.innerText || "").join(" ");
    return {
      reason: e2e.norm(b.innerText),
      launchDisabled: l.disabled,
      reasonVisible: rb.top >= rs.top - 1 && rb.bottom <= rs.bottom + 1,
      launchDescription: e2e.norm(desc),
      chipDanger: e2e.first('[data-chip="project"]').classList.contains("danger"),
    };`);
  log(`  ${JSON.stringify(r)}`);
  await bridge.screenshot(join(evidenceDir, "01-options-open.png"));
  check(r.launchDisabled, "Launch is disabled (precondition)");
  check(r.reasonVisible, "the reason Launch is disabled is in view with the options open");
  check(r.launchDescription.includes(r.reason), "and it describes the Launch button");
  check(r.chipDanger, "the project chip says it in the danger colour");
});
