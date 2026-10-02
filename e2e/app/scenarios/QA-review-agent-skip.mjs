#!/usr/bin/env node
// QA-review-agent-skip (PLN-01): an agent can never skip a Feature Track
// phase. Once the person approved questions, the agent (HERMES_AGENT set)
// runs `hi phase skip` five times: every one is refused with exit 3 (people
// only), the refusal never suggests skipping, the track stays at research
// and the Track panel shows research as the current phase. Starting the next
// phase early is refused with "finish research first, then run `hi phase
// done`" (no mention of skip). A person's skip from Hermes still works.
//
// Negative control: a build of main before the fix ends in RESULT: FAIL
// (the agent's skips succeed and the track reaches done).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finishScenario } from "../harness.mjs";
import { HI, featureDir, scenarioContext, sleep, taskSetup, trackPanelAttr } from "../review-steps.mjs";

const SCENARIO = "QA-review-agent-skip";
const { evidenceDir, log, failures, check, startedAt } = scenarioContext(SCENARIO);
let t;
try {
  t = await taskSetup("skip", evidenceDir, log);
  const dir = featureDir(t.wt);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "questions.md"), "# Questions\n\n- [x] Which file? — math.js\n");
  t.hi(["phase", "done"]);
  await t.bridge.waitFor("gate waiting", `return e2e.first("[data-testid=track-panel]")?.getAttribute("data-gate") === "waiting";`);
  await t.bridge.click(".track-approve");
  await t.bridge.waitFor("research", `return e2e.first("[data-testid=track-panel]")?.getAttribute("data-phase") === "research";`);

  log("the AGENT runs `hi phase skip` five times");
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const r = spawnSync(HI, ["phase", "skip"], { cwd: t.wt, env: { ...process.env, HERMES_AGENT: "claude" }, encoding: "utf8" });
    runs.push(r);
    log(`  exit ${r.status}: ${(r.stdout + r.stderr).trim()}`);
  }
  check(runs.every((r) => r.status === 3), "every `hi phase skip` by an agent exits 3 (people only)");
  await sleep(1500);
  const fm = readFileSync(join(dir, "feature.md"), "utf8");
  check(/^phase: research$/m.test(fm), "feature.md still says phase: research");
  check((await trackPanelAttr(t.bridge, "data-phase")) === "research", "the Track panel still shows research");

  log("the agent tries to start design before research is done");
  const early = spawnSync(HI, ["phase", "design"], { cwd: t.wt, env: { ...process.env, HERMES_AGENT: "claude" }, encoding: "utf8" });
  const text = (early.stdout + early.stderr).trim();
  log(`  exit ${early.status}: ${text}`);
  check(early.status !== 0 && /finish research first, then run `hi phase done`/.test(text), "starting design early says to finish research first");
  check(!/skip/i.test(text), "the refusal does not suggest skipping");

  log("the person skips research from Hermes (still allowed)");
  await t.bridge.eval(`const p = e2e.first("[data-testid=track-panel]"); p.focus(); return true;`);
  await t.bridge.click(".track-skip");
  await sleep(500);
  if (await t.bridge.exists(".track-skip-confirm")) await t.bridge.click(".track-skip-confirm");
  await t.bridge.waitFor("design", `return e2e.first("[data-testid=track-panel]")?.getAttribute("data-phase") === "design";`, { timeoutMs: 10_000 }).catch(() => null);
  check((await trackPanelAttr(t.bridge, "data-phase")) === "design", "a person's skip from the Track panel moves the track on");
  await t.bridge.screenshot(join(evidenceDir, "after.png"));
} catch (e) {
  failures.push(String(e?.stack ?? e));
  log(`ERROR ${e?.stack ?? e}`);
  try {
    await t?.bridge.screenshot(join(evidenceDir, "99-failure.png"));
  } catch {
    /* best effort */
  }
} finally {
  await t?.cleanup();
}
finishScenario({ scenario: SCENARIO, evidenceDir, failed: failures.length > 0, startedAt, log, details: { failures } });
