#!/usr/bin/env node
// QA-review-revert-twice (PLN-25): after "Revert turn 1" went through, the
// turn row says "T1 · reverted" and a second Revert says "Turn 1 is already
// reverted — nothing to undo" with the button disabled. Before, it warned
// "Does not apply cleanly … conflict markers may be left" and then silently
// did nothing.
//
// Negative control: a build of main before the fix ends in RESULT: FAIL.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentTurn, byTurn, openReviewDesk, runScenario, sleep } from "../review-steps.mjs";

const openRevert = async (bridge) => {
  await bridge.click(".review-revert-btn");
  await bridge.waitFor("the revert preview", `return !!e2e.first(".review-revert-clean");`, { timeoutMs: 15_000 });
  return bridge.eval(`const p = e2e.first(".review-revert-clean"); return { text: e2e.norm(p.innerText), already: p.getAttribute("data-already"), disabled: !!e2e.first(".review-revert-confirm")?.disabled };`);
};

await runScenario("QA-review-revert-twice", async (ctx) => {
  const { log, check, evidenceDir } = ctx;
  const t = await ctx.setup("revert2", { track: false });
  await sleep(1500);
  await agentTurn(t.bridge, t.sid, () => writeFileSync(join(t.wt, "math.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n"));
  await openReviewDesk(t.bridge);
  await byTurn(t.bridge);
  await t.bridge.eval(`e2e.click(e2e.first('.review-turn-row[data-kind="agent"]') ?? e2e.first(".review-turn-row")); return true;`);
  await sleep(500);
  const first = await openRevert(t.bridge);
  log(`first preview: ${JSON.stringify(first)}`);
  check(first.already === "0" && !first.disabled, "the first revert is offered");
  await t.bridge.click(".review-revert-confirm");
  await t.bridge.waitFor("the revert notice", `return /Turn 1 reverted/.test(e2e.first(".review-notice")?.innerText ?? "");`, { timeoutMs: 15_000 });
  log(`math.js after the revert: ${JSON.stringify(readFileSync(join(t.wt, "math.js"), "utf8"))}`);
  await t.bridge.waitFor("the desk to reload", `return e2e.first(".review-desk")?.getAttribute("data-loading") === "0";`);
  await t.bridge.eval(`e2e.click(e2e.first('.review-turn-row[data-kind="agent"]') ?? e2e.first(".review-turn-row")); return true;`);
  await sleep(500);
  const row = await t.bridge.eval(`const r = e2e.first('.review-turn-row[data-kind="agent"]'); return r ? { text: e2e.norm(r.innerText), reverted: r.getAttribute("data-reverted") } : null;`);
  log(`turn row: ${JSON.stringify(row)}`);
  check(row?.reverted === "1" && /reverted/.test(row.text), "the turn row says it was reverted");
  const second = await openRevert(t.bridge);
  log(`second preview: ${JSON.stringify(second)}`);
  await t.bridge.screenshot(join(evidenceDir, "second-revert.png"));
  check(!/Does not apply cleanly|conflict markers/.test(second.text), "no conflict warning for a turn already reverted");
  check(/Turn 1 is already reverted — nothing to undo/.test(second.text) && second.disabled, "it says the turn is already reverted, and Revert is disabled");
});
