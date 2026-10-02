#!/usr/bin/env node
// QA-review-donewhen-planning (PLN-09): the Done-When Stop hook leaves a
// Feature Track alone while it plans. A Full track with a failing check
// (`node -e "process.exit(3)"`): a turn that ends in the questions phase,
// at a waiting gate, is never sent back with "You are not done yet" (that
// pushed the agent to write code before the plan was approved). In the
// implement phase the same check does send it back.
//
// Negative control: a build of main before the fix ends in RESULT: FAIL.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { featureDir, runScenario, sleep } from "../review-steps.mjs";

const stopsOf = (fake) => (fake.records()[0]?.turns ?? []).map((turn) => (turn.stops ?? []).filter((s) => (s.codes ?? []).includes(2)).length);

await runScenario("QA-review-donewhen-planning", async (ctx) => {
  const { log, check } = ctx;
  const t = await ctx.setup("dw", { checks: ['node -e "process.exit(3)"'] });
  const dir = featureDir(t.wt);
  log(`feature.md:\n${readFileSync(join(dir, "feature.md"), "utf8")}`);
  writeFileSync(join(dir, "questions.md"), "# Questions\n\n- [ ] Which file?\n");
  log(t.hi(["phase", "done"]).trim());
  await t.bridge.typeInTerminal(t.sid, "work 300\n");
  await sleep(9000);
  const planning = stopsOf(t.fake);
  log(`blocked stops per turn while planning: ${JSON.stringify(planning)}`);
  check(planning.length >= 1, "the planning turn ran");
  check(planning.every((n) => n === 0), "a turn ending at the waiting questions gate is not sent back by the checks");

  log("the person moves the track to implement (approve, skip the rest)");
  const fm = join(dir, "feature.md");
  writeFileSync(fm, readFileSync(fm, "utf8").replace(/^phase: .*$/m, "phase: implement").replace(/^gate: .*$/m, "gate: none"));
  await sleep(1500);
  await t.bridge.typeInTerminal(t.sid, "work 300\n");
  await sleep(12000);
  const all = stopsOf(t.fake);
  log(`blocked stops per turn: ${JSON.stringify(all)}`);
  check(all.length >= 2 && all[all.length - 1] > 0, "in the implement phase a failing check sends the agent back");
});
