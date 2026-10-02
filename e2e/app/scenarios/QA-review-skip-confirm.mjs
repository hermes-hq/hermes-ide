#!/usr/bin/env node
// QA-review-skip-confirm (PLN-14): skipping a phase is never one stray key,
// and a skipped phase never looks approved.
//
//   1. questions approved properly (✓)
//   2. a stray `s` with the Track panel focused: nothing happens
//   3. ⇧S asks "Skip research? The agent will start design without it.";
//      Cancel keeps research; ⇧S + Skip moves on
//   4. research is drawn "– research · skipped" (not ✓), its title says who
//      and when, and feature.md records `skipped: [research (…)]`
//
// Negative control: a build of main before the fix ends in RESULT: FAIL.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { featureDir, runScenario, sleep, trackPanelAttr } from "../review-steps.mjs";

const press = (bridge, key, shiftKey = false) =>
  bridge.eval(`const p = e2e.first("[data-testid=track-panel]"); p.focus(); p.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, shiftKey: ${shiftKey}, bubbles: true, cancelable: true })); return true;`);

await runScenario("QA-review-skip-confirm", async (ctx) => {
  const { log, check, evidenceDir } = ctx;
  const t = await ctx.setup("skip");
  writeFileSync(join(featureDir(t.wt), "questions.md"), "# Questions\n\n- [x] Which file? — math.js\n");
  t.hi(["phase", "done"]);
  await t.bridge.waitFor("the gate to wait", `return e2e.first("[data-testid=track-panel]")?.getAttribute("data-gate") === "waiting";`);
  await t.bridge.click(".track-approve");
  await t.bridge.waitFor("research", `return e2e.first("[data-testid=track-panel]")?.getAttribute("data-phase") === "research";`);

  log("a stray `s`");
  await press(t.bridge, "s");
  await sleep(1000);
  check((await trackPanelAttr(t.bridge, "data-phase")) === "research", "a single `s` does not skip");
  check(!(await t.bridge.exists("[data-testid=track-skip-confirm]")), "a single `s` asks nothing either");

  log("⇧S asks first; Cancel keeps the phase");
  await press(t.bridge, "S", true);
  await t.bridge.waitFor("the skip question", `return !!e2e.first("[data-testid=track-skip-confirm]");`, { timeoutMs: 5000 });
  const question = await t.bridge.eval(`return e2e.norm(e2e.first("[data-testid=track-skip-confirm]")?.innerText ?? "")`);
  log(`  ${question}`);
  check(/Skip research\? The agent will start design without it\./.test(question), "the question names the phase and what comes next");
  await t.bridge.click(".track-skip-cancel");
  await sleep(500);
  check((await trackPanelAttr(t.bridge, "data-phase")) === "research", "Cancel keeps research");

  log("⇧S + Skip");
  await press(t.bridge, "S", true);
  await t.bridge.waitFor("the skip question", `return !!e2e.first("[data-testid=track-skip-confirm]");`, { timeoutMs: 5000 });
  await t.bridge.click(".track-skip-confirm");
  await t.bridge.waitFor("design", `return e2e.first("[data-testid=track-panel]")?.getAttribute("data-phase") === "design";`);
  const rows = await t.bridge.eval(`return e2e.all(".track-phase").map((li) => ({ phase: li.dataset.phase, state: li.dataset.state, mark: li.querySelector(".track-phase-mark")?.textContent, text: e2e.norm(li.innerText), title: li.title }));`);
  log(`  rows: ${JSON.stringify(rows)}`);
  const q = rows.find((r) => r.phase === "questions");
  const r = rows.find((x) => x.phase === "research");
  check(q?.state === "done" && q.mark === "✓", "the approved phase keeps its ✓");
  check(r?.state === "skipped" && r.mark === "–" && /research · skipped/.test(r.text), "the skipped phase reads '– research · skipped'");
  check(/Skipped by a person on \d{4}-\d\d-\d\d \d\d:\d\d UTC/.test(r?.title ?? ""), "its title says who skipped it and when");
  const fm = readFileSync(join(featureDir(t.wt), "feature.md"), "utf8");
  log(`feature.md:\n${fm}`);
  check(/^skipped: \[research \(\d{4}-\d\d-\d\d \d\d:\d\d UTC\)\]$/m.test(fm), "feature.md records that research was skipped, and when");
  await t.bridge.screenshot(join(evidenceDir, "skipped.png"));
});
