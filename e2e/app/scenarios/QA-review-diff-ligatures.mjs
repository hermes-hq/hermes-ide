#!/usr/bin/env node
// QA-review-diff-ligatures (PLN-27): code review shows the exact characters.
// The Review Desk diff and the TURNS sheet diff drew "!==" as one "≢" glyph
// and "=>" as an arrow (font ligatures); both now render without them.
//
// Negative control: a build of main before the fix ends in RESULT: FAIL.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentTurn, openReviewDesk, runScenario, sleep } from "../review-steps.mjs";

const noLigatures = (s) => s.lig === "none" || (/"liga" 0/.test(s.feat) && /"calt" 0/.test(s.feat));

await runScenario("QA-review-diff-ligatures", async (ctx) => {
  const { log, check, evidenceDir } = ctx;
  const t = await ctx.setup("lig", { track: false });
  await sleep(1500);
  await agentTurn(t.bridge, t.sid, () => writeFileSync(join(t.wt, "math.js"), "export const add = (a, b) => a + b;\nif (add(1, 1) !== 2) throw new Error('x');\n"));
  await t.bridge.waitFor("the turn chip", `return e2e.all(".turn-bar-turn").length >= 1;`, { timeoutMs: 15_000 });
  await t.bridge.eval(`e2e.click(e2e.first(".turn-bar-turn")); return true;`);
  await t.bridge.waitFor("the turn diff", `return !!e2e.first(".turn-diff-text");`, { timeoutMs: 15_000 });
  const sheet = await t.bridge.eval(`const s = getComputedStyle(e2e.first(".turn-diff-text")); return { lig: s.fontVariantLigatures, feat: s.fontFeatureSettings };`);
  log(`TURNS sheet diff: ${JSON.stringify(sheet)}`);
  check(noLigatures(sheet), "the TURNS sheet diff renders without ligatures");
  await t.bridge.click(".turn-sheet-close");
  await openReviewDesk(t.bridge);
  await t.bridge.waitFor("the desk diff", `return e2e.all(".review-desk .review-line-text").some((e) => e.textContent.includes("!=="));`, { timeoutMs: 20_000 });
  const desk = await t.bridge.eval(`const el = e2e.all(".review-desk .review-line-text").find((e) => e.textContent.includes("!==")); const s = getComputedStyle(el); return { lig: s.fontVariantLigatures, feat: s.fontFeatureSettings };`);
  log(`Review Desk diff: ${JSON.stringify(desk)}`);
  check(noLigatures(desk), "the Review Desk diff renders without ligatures");
  await t.bridge.screenshot(join(evidenceDir, "desk.png"));
});
