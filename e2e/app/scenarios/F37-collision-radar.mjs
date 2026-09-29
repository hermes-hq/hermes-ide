#!/usr/bin/env node
// Scenario: F37 — Collision Radar v0 on the REAL app.
//
// The radar reads what each session's latest turns changed from the turn
// ledger (the C0 seam listTurns / getTurnDiff) and badges the sessions whose
// latest turns touched the same file. F20 fills the real ledger; until then
// the scenario answers it from fake turns (the e2e hook setFakeTurnLedger),
// and ends each turn with a real `turn_end` SessionEvent pushed through the
// Rust side of the event channel — the same path F20/F11 will use.
//
//   run 1  fresh install: turn the fleetControls flag on; relaunch.
//   run 2  three terminal sessions A, B, C in the same folder.
//          - A's turn 1 changed src/login.ts (read from its diff), B's turn 1
//            changed src/login.ts and src/api.ts (the turn's own path list),
//            C's turn 1 changed docs/readme.md.
//          - Before any turn has ended: no badge.
//          - A ends its turn: still no badge (B has not).
//          - B ends its turn: A and B both show the overlap badge naming the
//            other session and src/login.ts; C has none.
//          - C ends its turn: C still has none.
//          - B ends three more turns elsewhere: turn 1 is no longer among its
//            latest turns, and both badges go away.
//
// Negative control: HERMES_E2E_F37_FLAG=off switches the flag off; the scenario
// must end in RESULT: FAIL (no badge ever appears).
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F37-collision-radar.mjs

import { platform } from "node:os";
import { join } from "node:path";
import { sleep } from "../harness.mjs";
import { completeOnboarding, createPlainTerminal, runScenario } from "../n11-steps.mjs";
import { emitFromRust, relauncher, rowState, setFlagOverrides, waitForReturningLaunch } from "../fleet-steps.mjs";

const SCENARIO = "F37-collision-radar";
const FLAG_ON = (process.env.HERMES_E2E_F37_FLAG || "on") !== "off";

const patchFor = (...files) =>
  files.map((f) => `diff --git a/${f} b/${f}\nindex 1111111..2222222 100644\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-old\n+new`).join("\n");

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps }) => {
  const launch = relauncher(evidenceDir, log, "f37");
  log(`scenario: ${SCENARIO}   platform: ${platform()}   flag: ${FLAG_ON ? "on" : "OFF (negative control)"}`);

  let app = await launch(1, { first: true });
  apps.push(app);
  await completeOnboarding(app.bridge, log);
  await setFlagOverrides(app.bridge, { fleetControls: FLAG_ON });
  const exit1 = await app.stop();
  assert(!exit1.forced && exit1.code === 0, "run 1 quit cleanly");

  app = await launch(2);
  apps.push(app);
  const { bridge } = app;
  await waitForReturningLaunch(bridge, log);

  log("step 1: three terminal sessions");
  const a = await createPlainTerminal(bridge, log);
  const b = await createPlainTerminal(bridge, log);
  const c = await createPlainTerminal(bridge, log);
  log(`  sessions: A=${a} B=${b} C=${c}`);

  const ledger = {
    [a]: [{ n: 1, patch: patchFor("src/login.ts") }],
    [b]: [{ n: 1, paths: ["src/login.ts", "src/api.ts"] }],
    [c]: [{ n: 1, patch: patchFor("docs/readme.md") }],
  };
  await bridge.eval(`window.__HERMES_E2E__.setFakeTurnLedger(${JSON.stringify(ledger)}); return true;`);
  const badges = async () => ({ a: (await rowState(bridge, a)).overlap, b: (await rowState(bridge, b)).overlap, c: (await rowState(bridge, c)).overlap });
  const turn = async (id, n) => {
    await emitFromRust(bridge, id, { type: "turn_start", at: Date.now(), source: "e2e", n });
    await emitFromRust(bridge, id, { type: "turn_end", at: Date.now(), source: "e2e", n });
  };

  log("step 2: before any turn has ended there is no badge");
  await sleep(800);
  let now = await badges();
  assert(!now.a && !now.b && !now.c, "no overlap badge on any row");

  log("step 3: A ends turn 1 (src/login.ts) — alone, still no badge");
  await turn(a, 1);
  await sleep(1000);
  now = await badges();
  assert(!now.a && !now.b, "no badge while only A has a turn");

  log("step 4: B ends turn 1 (src/login.ts, src/api.ts) — A and B are badged");
  await turn(b, 1);
  const both = await bridge.waitFor("the overlap badge on A and B", `
    const get = (id) => document.querySelector('.session-item[data-session-item-id="' + CSS.escape(id) + '"] .session-overlap-badge');
    const x = get(${JSON.stringify(a)});
    const y = get(${JSON.stringify(b)});
    return x && y ? { a: { text: e2e.norm(x.innerText), title: x.getAttribute("title"), with: x.getAttribute("data-overlap-with") }, b: { text: e2e.norm(y.innerText), title: y.getAttribute("title"), with: y.getAttribute("data-overlap-with") } } : null;
  `, { timeoutMs: 10_000 });
  log(`  A: ${JSON.stringify(both.a)}`);
  log(`  B: ${JSON.stringify(both.b)}`);
  assert(both.a.text === "overlap 1" && both.b.text === "overlap 1", `both rows say "overlap 1"`);
  assert(both.a.with === b && both.b.with === a, "each badge points at the other session");
  assert(both.a.title.includes("src/login.ts") && !both.a.title.includes("src/api.ts"), `A's badge names the shared file only ("${both.a.title}")`);
  assert(both.b.title.includes("src/login.ts"), `B's badge names the shared file ("${both.b.title}")`);
  assert(!(await rowState(bridge, c)).overlap, "C has no badge");
  await bridge.screenshot(join(evidenceDir, "01-overlap-badges.png"));

  log("step 5: C ends turn 1 (docs/readme.md) — C stays clear");
  await turn(c, 1);
  await sleep(1000);
  assert(!(await rowState(bridge, c)).overlap, "C still has no badge");
  assert(!!(await rowState(bridge, a)).overlap, "A keeps its badge");

  log("step 6: B works elsewhere for three more turns — turn 1 is no longer among its latest, the badges go");
  ledger[b].push({ n: 2, paths: ["src/b2.ts"] }, { n: 3, paths: ["src/b3.ts"] }, { n: 4, paths: ["src/b4.ts"] });
  await bridge.eval(`window.__HERMES_E2E__.setFakeTurnLedger(${JSON.stringify(ledger)}); return true;`);
  for (const n of [2, 3, 4]) await turn(b, n);
  await bridge.waitFor("both badges to go away", `
    const get = (id) => document.querySelector('.session-item[data-session-item-id="' + CSS.escape(id) + '"] .session-overlap-badge');
    return !get(${JSON.stringify(a)}) && !get(${JSON.stringify(b)});
  `, { timeoutMs: 10_000 });
  log("  ok — no badge once the overlap is older than the latest turns");
  await bridge.screenshot(join(evidenceDir, "02-overlap-gone.png"));
});
