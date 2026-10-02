#!/usr/bin/env node
// QA-review-desk-agent-labels (PLN-18): the Review Desk names the agent as
// people know it — "Claude Code" — never by the session's task text, and
// counts read right ("1 comment", "1 file").
//
//   "last changed by Claude Code in turn 1", "Send to Claude Code",
//   "to Claude Code · T1" on a comment, "1 comment to send to Claude Code",
//   and a turn row "T1 · Claude Code · <time> · 1 file" (not the task text).
//
// Negative control: a build of main before the fix ends in RESULT: FAIL.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentTurn, byTurn, openReviewDesk, runScenario, sleep } from "../review-steps.mjs";

const TASK = "Please add an add function to math.js";

await runScenario("QA-review-desk-agent-labels", async (ctx) => {
  const { log, check, evidenceDir } = ctx;
  const t = await ctx.setup("labels", { track: false, task: TASK });
  await sleep(1500);
  await agentTurn(t.bridge, t.sid, () => writeFileSync(join(t.wt, "math.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n"));
  await openReviewDesk(t.bridge);
  await t.bridge.waitFor("a file row", `return e2e.all(".review-file-row").length >= 1;`, { timeoutMs: 20_000 });
  await sleep(800);
  await t.bridge.clickWhenReady(`const line = e2e.all(".review-line.review-line-add")[0]; return e2e.click(e2e.must(line, "an added line"));`);
  await t.bridge.waitFor("the comment editor", `return !!e2e.first(".review-comment-editor textarea");`);
  await t.bridge.eval(`const ta = e2e.first(".review-comment-editor textarea"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, "use a function declaration"); ta.dispatchEvent(new Event("input", { bubbles: true })); return true;`);
  await t.bridge.click(".review-comment-save");
  await sleep(600);
  const texts = await t.bridge.eval(`return {
    owner: e2e.norm(e2e.first(".review-main-owner")?.innerText ?? ""),
    send: e2e.norm(e2e.first(".review-send-btn")?.innerText ?? ""),
    pending: e2e.norm(e2e.first(".review-send-label")?.innerText ?? ""),
    route: e2e.norm(e2e.first(".review-comment-route")?.innerText ?? ""),
  };`);
  log(`texts: ${JSON.stringify(texts)}`);
  check(texts.owner === "last changed by Claude Code in turn 1", `'last changed by' names the agent (${texts.owner})`);
  check(texts.send === "Send to Claude Code", `the Send button names the agent (${texts.send})`);
  check(texts.pending === "1 comment to send to Claude Code", `one comment is singular (${texts.pending})`);
  check(texts.route.startsWith("to Claude Code · T1"), `the comment is routed to the agent (${texts.route})`);
  await byTurn(t.bridge);
  const row = await t.bridge.eval(`return e2e.norm(e2e.first('.review-turn-row[data-kind="agent"]')?.innerText ?? "")`);
  log(`turn row: ${row}`);
  check(!row.includes("Please add"), "the turn row does not repeat the task text");
  check(/Claude Code/.test(row) && /\b1 file\b/.test(row) && !/\b1 files\b/.test(row), "the turn row names the agent and says 1 file");
  await t.bridge.screenshot(join(evidenceDir, "labels.png"));
});
