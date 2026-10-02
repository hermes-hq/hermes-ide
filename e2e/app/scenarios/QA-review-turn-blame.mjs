#!/usr/bin/env node
// QA-review-turn-blame (PLN-11): the turn ledger never charges the person's
// edits (or Hermes's own track review files) to an agent turn.
//
//   1. turn 1: the agent writes agent1.txt during its turn
//   2. between turns the PERSON writes person.txt
//   3. turn 2: the agent writes agent2.txt
//
// Turn 2's diff holds agent2.txt and NOT person.txt, three times in a row
// (the bug failed 2 of 3 runs, and the run that passed split the person's
// edit into a turn of its own labelled as the agent's). The Review Desk's
// turn list shows the person's edit as a "Between turns · you" row, which
// has no Revert button; "Revert turn 2" never undoes person.txt. A review
// file Hermes writes under .hermes/features/*/review-*.md during a turn is
// not part of the agent's turn either.
//
// Negative control: a build of main before the fix ends in RESULT: FAIL.

import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { finishScenario } from "../harness.mjs";
import { agentTurn, invoke, openReviewDesk, scenarioContext, sleep, taskSetup } from "../review-steps.mjs";

const SCENARIO = "QA-review-turn-blame";
const { evidenceDir, log, failures, check, startedAt } = scenarioContext(SCENARIO);
const filesOf = (patch) => (patch.match(/^diff --git a\/(\S+)/gm) || []).map((l) => l.replace("diff --git a/", ""));

let t;
try {
  t = await taskSetup("blame", evidenceDir, log, { track: false });
  await sleep(1500);
  const turns = () => invoke(t.bridge, "list_turns", { sessionId: t.sid });
  for (let round = 1; round <= 3; round++) {
    log(`round ${round}: agent turn, the person's edit, agent turn`);
    await agentTurn(t.bridge, t.sid, () => writeFileSync(join(t.wt, `agent-${round}-a.txt`), "by the agent\n"));
    writeFileSync(join(t.wt, `person-${round}.txt`), "typed by the person between turns\n");
    await sleep(1200);
    await agentTurn(t.bridge, t.sid, () => {
      writeFileSync(join(t.wt, `agent-${round}-b.txt`), "by the agent\n");
      // Hermes's own review file, written while the agent works.
      mkdirSync(join(t.wt, ".hermes/features/demo"), { recursive: true });
      writeFileSync(join(t.wt, `.hermes/features/demo/review-${round}.md`), "# Review\n");
    });
    const list = await turns();
    const last = list[list.length - 1];
    const diff = await invoke(t.bridge, "get_turn_diff", { sessionId: t.sid, n: last.n });
    const files = filesOf(diff?.patch ?? "");
    log(`  turns: ${JSON.stringify(list.map((x) => ({ n: x.n, files: x.diffstat.files, kind: x.kind ?? "agent" })))}`);
    log(`  turn ${last.n} files: ${JSON.stringify(files)}`);
    const events = await t.bridge.eval(`return window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(t.sid)}).events.filter((e) => e.type.startsWith("turn")).map((e) => e.type + ":" + e.source + ":" + e.at).slice(-6);`).catch(() => null);
    log(`  turn events: ${JSON.stringify(events)}`);
    check(files.includes(`agent-${round}-b.txt`), `round ${round}: the last turn has the agent's own change`);
    check(!files.includes(`person-${round}.txt`), `round ${round}: the last turn does not claim the person's between-turn edit`);
    check(!files.some((f) => f.includes("/review-")), `round ${round}: the last turn does not claim Hermes's review file`);
    const agentTurns = list.filter((x) => (x.kind ?? "agent") === "agent");
    const blamed = [];
    for (const x of agentTurns) {
      const d = await invoke(t.bridge, "get_turn_diff", { sessionId: t.sid, n: x.n });
      if (filesOf(d?.patch ?? "").includes(`person-${round}.txt`)) blamed.push(x.n);
    }
    check(blamed.length === 0, `round ${round}: no agent turn holds person-${round}.txt (held by ${JSON.stringify(blamed)})`);
  }

  log("the Review Desk: the person's edits are a 'Between turns · you' row without Revert");
  await openReviewDesk(t.bridge);
  await t.bridge.eval(`e2e.click([...document.querySelectorAll(".review-desk button, .review-desk [role=radio]")].find((b) => b.innerText.trim() === "By turn")); return true;`);
  await sleep(800);
  const rows = await t.bridge.eval(`return e2e.all(".review-turn-row").map((r) => ({ kind: r.getAttribute("data-kind") || "agent", text: e2e.norm(r.innerText) }));`);
  log(`  turn rows: ${JSON.stringify(rows)}`);
  const between = rows.filter((r) => r.kind === "between");
  check(between.length >= 1 && between.every((r) => /Between turns · you/.test(r.text)), "the person's edits show as 'Between turns · you' rows");
  if (between.length) {
    await t.bridge.eval(`e2e.click(e2e.all(".review-turn-row").find((r) => r.getAttribute("data-kind") === "between")); return true;`);
    await sleep(500);
    const revert = await t.bridge.exists(".review-revert-btn");
    check(!revert, "a between-turns row offers no Revert");
  }
  await t.bridge.screenshot(join(evidenceDir, "turns.png"));
  check(existsSync(join(t.wt, "person-1.txt")), "the person's file is still there");
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
