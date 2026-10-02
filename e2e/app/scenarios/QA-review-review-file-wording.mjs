#!/usr/bin/env node
// QA-review-review-file-wording (PLN-13): "Send my edits" while a phase
// waits at its gate. The person's edits are already in the file (the diff
// runs from what the agent handed over to what the person saved), so the
// review file never asks the agent to "apply" them, and the line never says
// "continue": the gate is still waiting, and the agent is told not to run
// `hi phase done` again (real Claude did, and was refused).
//
// Negative control: a build of main before the fix ends in RESULT: FAIL.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { featureDir, runScenario, sleep } from "../review-steps.mjs";

await runScenario("QA-review-review-file-wording", async (ctx) => {
  const { log, check } = ctx;
  const t = await ctx.setup("wording");
  const q = join(featureDir(t.wt), "questions.md");
  writeFileSync(q, "# Questions\n\n- [ ] Which file?\n");
  t.hi(["phase", "done"]);
  await t.bridge.waitFor("the gate to wait", `return e2e.first("[data-testid=track-panel]")?.getAttribute("data-gate") === "waiting";`);
  await sleep(1200);
  writeFileSync(q, "# Questions\n\n- [x] Which file? — math.js\n");
  await sleep(1500);
  await t.bridge.click(".track-send-edits");
  await sleep(2500);
  const review = readFileSync(join(featureDir(t.wt), "review-1.md"), "utf8");
  const line = (t.fake.records()[0]?.prompts ?? []).join("\n");
  log(`review-1.md:\n${review}`);
  log(`the line the agent got: ${line}`);
  check(!/Apply these edits/i.test(review), "review-1.md does not ask to apply edits already in the file");
  check(/do not run `hi phase done` again/.test(review), "review-1.md says the gate is still waiting and not to hand the phase over again");
  check(/hermes review/.test(line), "the agent got the line");
  check(!/then continue/i.test(line) && !/continue the phase/i.test(review), "while the gate waits, the agent is not told to continue");
});
