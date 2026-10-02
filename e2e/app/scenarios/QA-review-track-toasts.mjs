#!/usr/bin/env node
// QA-review-track-toasts (PLN-08): what the Track panel says reaches the
// person. Its toasts (skip, approve, send edits, errors) went to a private
// list nobody rendered; now there is one toast list for the window.
//
//   1. Skip (confirmed) → a toast says the phase was skipped
//   2. the agent hands research over; Approve → a toast confirms it
//
// Negative control: a build of main before the fix ends in RESULT: FAIL.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { featureDir, runScenario, sleep, toastTexts } from "../review-steps.mjs";

const toastsMatching = (bridge, re) =>
  bridge.waitFor(`a toast matching ${re}`, `const t = e2e.all(".toast-message").map((x) => x.innerText); return t.some((m) => ${re}.test(m)) ? t : null;`, { timeoutMs: 4000 }).catch(() => null);

await runScenario("QA-review-track-toasts", async (ctx) => {
  const { log, check, evidenceDir } = ctx;
  const t = await ctx.setup("toasts");
  log("1) Skip, confirmed");
  await t.bridge.click(".track-skip");
  await sleep(400);
  if (await t.bridge.exists(".track-skip-confirm")) await t.bridge.click(".track-skip-confirm");
  await t.bridge.waitFor("research", `return e2e.first("[data-testid=track-panel]")?.getAttribute("data-phase") === "research";`);
  const afterSkip = await toastsMatching(t.bridge, /skipped/i);
  log(`  toasts: ${JSON.stringify(afterSkip ?? (await toastTexts(t.bridge)))}`);
  check(!!afterSkip, "a toast says the phase was skipped");

  log("2) Approve a waiting gate");
  writeFileSync(join(featureDir(t.wt), "research.md"), "# Research\n\n- math.js exports sub\n");
  t.hi(["phase", "done"]);
  await t.bridge.waitFor("the gate to wait", `return e2e.first("[data-testid=track-panel]")?.getAttribute("data-gate") === "waiting";`);
  await t.bridge.click(".track-approve");
  await t.bridge.waitFor("design", `return e2e.first("[data-testid=track-panel]")?.getAttribute("data-phase") === "design";`);
  const afterApprove = await toastsMatching(t.bridge, /approved/i);
  log(`  toasts: ${JSON.stringify(afterApprove ?? (await toastTexts(t.bridge)))}`);
  check(!!afterApprove, "a toast confirms the approval");
  await t.bridge.screenshot(join(evidenceDir, "after-approve.png"));
});
