#!/usr/bin/env node
// QA-host-hook-turns (PLN-02) — a terminal agent's turns, from its real
// hooks (the UserPromptSubmit / Stop / StopFailure hooks Hermes installs),
// reach the session-event store as turn_start / turn_end / turn_failed.
// Everything that asks "was the agent in a turn?" reads those: the gate
// guard that reverts an agent's self-approval (F28), the turn ledger, the
// Done-When checks. A hook agent used to produce statuses only, so no turn
// ever ran and any self-approval stood (F28 passed only by injecting turns).
import { sleep } from "../harness.mjs";
import { runScenario } from "../n11-steps.mjs";
import { claude, startApp, write } from "../qa-host-steps.mjs";

const SCENARIO = "QA-host-hook-turns";
await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  const { fx, bridge } = await startApp("qa-turns", evidenceDir, log, onCleanup, apps);
  const id = await claude(bridge, fx, fx.repo, "api: fix login", 1);
  await sleep(2500);
  const snap = () =>
    bridge.eval(`const s = window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(id)}); return { turn: s.turn, types: s.events.map((e) => e.type + (e.n ? ":" + e.n : "") + (e.source ? "@" + e.source : "")) };`);

  log("the agent takes a prompt (UserPromptSubmit)");
  await write(bridge, id, "w");
  const started = await bridge.waitFor("a running turn", `const s = window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(id)}); return s.turn.current !== null ? s.turn : null;`, { timeoutMs: 15_000 }).catch(() => null);
  log(`  ${JSON.stringify(await snap())}`);
  assert(started && started.current === 1, "turn 1 is running, started by the agent's own hook");

  log("it works (a tool), then stops (Stop)");
  await write(bridge, id, "t");
  await sleep(800);
  assert((await snap()).turn.current === 1, "a tool inside the turn starts no new turn");
  await write(bridge, id, "s");
  const ended = await bridge.waitFor("the turn ended", `const s = window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(id)}); return s.turn.current === null && s.turn.completed === 1 ? s.turn : null;`, { timeoutMs: 15_000 }).catch(() => null);
  const after = await snap();
  log(`  ${JSON.stringify(after)}`);
  assert(ended !== null, "the turn ended at the agent's Stop");
  assert(after.types.some((t) => t.startsWith("turn_start:1@hook:claude")) && after.types.some((t) => t.startsWith("turn_end:1@hook:claude")), "turn_start and turn_end come from the agent's hooks");

  log("the next prompt fails (StopFailure)");
  await write(bridge, id, "w");
  await bridge.waitFor("turn 2", `return window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(id)}).turn.current === 2;`, { timeoutMs: 15_000 });
  await write(bridge, id, "e");
  await bridge.waitFor("turn 2 failed", `const s = window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(id)}); return s.turn.current === null && s.events.some((e) => e.type === "turn_failed" && e.n === 2);`, { timeoutMs: 15_000 });
  const last = await bridge.eval(`return window.__HERMES_E2E__.sessionStatus(${JSON.stringify(id)});`);
  log(`  status: ${JSON.stringify(last)}`);
  assert(last.kind === "error" && last.confidence === "exact", "the failed turn shows as an exact error");
});
