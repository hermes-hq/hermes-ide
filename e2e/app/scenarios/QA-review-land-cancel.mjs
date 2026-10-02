#!/usr/bin/env node
// QA-review-land-cancel (PLN-24): "Land…" in the Review Desk opens the Land
// sheet OVER the desk. Cancel (or Esc) brings the person back to the desk
// they were in the middle of — same tab, same selection; the desk used to
// close before the sheet opened, so a cancel left the bare terminal.
//
// Negative control: a build of main before the fix ends in RESULT: FAIL.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { byTurn, openReviewDesk, runScenario, sleep } from "../review-steps.mjs";

const openLand = async (bridge) => {
  await bridge.eval(`e2e.click(e2e.all(".review-desk button").find((b) => b.classList.contains("review-land-btn"))); return true;`);
  await bridge.waitFor("the Land sheet", `return !!e2e.first(".land-sheet");`, { timeoutMs: 30_000 });
};

await runScenario("QA-review-land-cancel", async (ctx) => {
  const { log, check, evidenceDir } = ctx;
  const t = await ctx.setup("landcancel", { track: false });
  writeFileSync(join(t.wt, "math.js"), "export const add = (a, b) => a + b;\n");
  await openReviewDesk(t.bridge);
  await t.bridge.waitFor("the Land button", `return !!e2e.first(".review-desk .review-land-btn");`, { timeoutMs: 20_000 });
  await byTurn(t.bridge);
  await openLand(t.bridge);
  check(await t.bridge.exists(".review-desk"), "the desk stays under the Land sheet");
  await t.bridge.click(".land-sheet-cancel");
  await sleep(800);
  const desk = await t.bridge.eval(`const d = e2e.first(".review-desk"); return d ? { group: d.getAttribute("data-group") } : null;`);
  log(`after Cancel: ${JSON.stringify(desk)}`);
  check(!!desk, "after Cancel the person is back in the Review Desk");
  check(desk?.group === "turn", "...in the view they were in (by turn)");

  log("Esc closes the sheet, not the desk under it");
  await openLand(t.bridge);
  await t.bridge.eval(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); return true;`);
  await sleep(800);
  check(!(await t.bridge.exists(".land-sheet")), "Esc closed the Land sheet");
  check(await t.bridge.exists(".review-desk"), "the desk is still open after Esc");
  await t.bridge.screenshot(join(evidenceDir, "after-cancel.png"));
});
