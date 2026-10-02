#!/usr/bin/env node
// QA-review-comment-anchor (PLN-19): a Review Desk comment stays on the line
// it was written on. It used to be pinned to a line NUMBER, so after the
// agent inserted a line above it (the JSDoc the comment asked for) it was
// drawn under "export function add" instead of "return a + b;". It is now
// anchored by the line's text and two lines around it; when its line is
// gone it shows on top of the file, marked "outdated".
//
// Negative control: a build of main before the fix ends in RESULT: FAIL.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentTurn, openReviewDesk, runScenario, sleep } from "../review-steps.mjs";

const lineAbove = (bridge) =>
  bridge.eval(`const c = e2e.first(".review-comment"); if (!c) return null; let p = c.previousElementSibling; while (p && !p.classList.contains("review-line")) p = p.previousElementSibling; return p ? p.querySelector(".review-line-text")?.textContent ?? "" : "(top of the file)";`);
const refresh = (bridge) => bridge.click(".review-refresh");

await runScenario("QA-review-comment-anchor", async (ctx) => {
  const { log, check, evidenceDir } = ctx;
  const t = await ctx.setup("anchor", { track: false });
  await sleep(1500);
  await agentTurn(t.bridge, t.sid, () => writeFileSync(join(t.wt, "math.js"), "export function add(a, b) {\n  return a + b;\n}\nexport const sub = (a, b) => a - b;\n"));
  await openReviewDesk(t.bridge);
  await t.bridge.waitFor("the diff", `return e2e.all(".review-line").length > 0;`, { timeoutMs: 20_000 });
  await t.bridge.clickWhenReady(`const l = e2e.all(".review-line.review-line-add").find((l) => l.innerText.includes("return a + b")); return e2e.click(e2e.must(l, "the return line"));`);
  await t.bridge.waitFor("the comment editor", `return !!e2e.first(".review-comment-editor textarea");`);
  await t.bridge.eval(`const ta = e2e.first(".review-comment-editor textarea"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, "add a JSDoc above"); ta.dispatchEvent(new Event("input", { bubbles: true })); return true;`);
  await t.bridge.click(".review-comment-save");
  await sleep(600);
  log(`comment under (turn 1): ${JSON.stringify(await lineAbove(t.bridge))}`);

  await agentTurn(t.bridge, t.sid, () => writeFileSync(join(t.wt, "math.js"), "/** Adds. */\nexport function add(a, b) {\n  return a + b;\n}\nexport const sub = (a, b) => a - b;\n"));
  await refresh(t.bridge);
  await sleep(1500);
  const after = await lineAbove(t.bridge);
  log(`comment under (after turn 2): ${JSON.stringify(after)}`);
  await t.bridge.screenshot(join(evidenceDir, "after-turn-2.png"));
  check(/return a \+ b/.test(after ?? ""), "the comment stays on the line it was written on");

  await agentTurn(t.bridge, t.sid, () => writeFileSync(join(t.wt, "math.js"), "/** Adds. */\nexport const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n"));
  await refresh(t.bridge);
  await sleep(1500);
  const state = await t.bridge.eval(`const c = e2e.first(".review-comment"); return c ? { outdated: c.getAttribute("data-outdated"), text: e2e.norm(c.innerText) } : null;`);
  log(`after the line is gone: ${JSON.stringify(state)}`);
  check(state?.outdated === "1" && /outdated/.test(state.text), "once its line is gone the comment is marked outdated (not moved onto another line)");
});
