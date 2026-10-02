#!/usr/bin/env node
// QA-host-reattached-agent-reports (LEAD-01) — after "Keep running" and a
// relaunch, a reattached agent's own reports (its hooks, the signal spool)
// are read again: what it said while the app was away comes back, and a NEW
// permission request reaches the badge as needs approval (exact). It used to
// stay "idle · guessed" with the badge at 0: the spool was never read again.
//
//   1. session host on (2.0 default); a fake Claude Code agent is running
//   2. it asks for permission and gets an answer (run 1)
//   3. quit, Keep running; relaunch on the same data: the session reattaches
//   4. EXPECT its status is back from its own reports (not idle · guessed)
//   5. it asks again: EXPECT needs approval (exact), badge 1
import { join } from "node:path";
import { skipScenario, sleep } from "../harness.mjs";
import { runScenario } from "../n11-steps.mjs";
import { claude, onWindows, quitAnswering, startApp, write } from "../qa-host-steps.mjs";

const SCENARIO = "QA-host-reattached-agent-reports";
await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  if (onWindows) skipScenario({ scenario: SCENARIO, evidenceDir, reason: "Windows has no session host", log });
  const { fx, app, bridge } = await startApp("qa-deaf", evidenceDir, log, onCleanup, apps);
  const A = await claude(bridge, fx, fx.repo, "api: fix login", 1);
  await sleep(2500);
  log("run 1: the hook path works");
  await write(bridge, A, "p");
  await bridge.waitFor("needs approval in run 1", `return window.__HERMES_E2E__.sessionStatus(${JSON.stringify(A)}).kind === "needs_approval";`, { timeoutMs: 15_000 });
  await write(bridge, A, "y");
  await bridge.waitFor("back to work in run 1", `return window.__HERMES_E2E__.sessionStatus(${JSON.stringify(A)}).kind !== "needs_approval";`, { timeoutMs: 15_000 });
  const before = await bridge.eval(`return window.__HERMES_E2E__.sessionStatus(${JSON.stringify(A)});`);
  log(`  status before the quit: ${JSON.stringify(before)}`);
  await quitAnswering(bridge, "keep", log);
  await app.stop({ stopPrograms: false });
  await sleep(1500);

  log("run 2: reattach");
  const app2 = await fx.launch(evidenceDir, 2);
  apps.push(app2);
  const b2 = app2.bridge;
  await b2.waitFor("the session back", `return window.__HERMES_E2E__.terminalIds().length === 1;`, { timeoutMs: 30_000 });
  const [id2] = await b2.terminalIds();
  assert(id2 === A, "the same session came back");
  const back = await b2.waitFor(
    "its status from its own reports",
    `const s = window.__HERMES_E2E__.sessionStatus(${JSON.stringify(id2)}); return s.source && s.source.startsWith("hook:") ? s : null;`,
    { timeoutMs: 15_000 },
  ).catch(() => null);
  log(`  status after the reattach: ${JSON.stringify(back)}`);
  assert(back !== null && back.confidence === "exact", "the status is rebuilt from the agent's own reports, exact (not idle · guessed)");

  log("the agent asks again");
  await write(b2, id2, "p");
  const got = await b2.waitFor("needs approval after the reattach", `const s = window.__HERMES_E2E__.sessionStatus(${JSON.stringify(id2)}); return s.kind === "needs_approval" ? s : null;`, { timeoutMs: 15_000 }).catch(() => null);
  const seen = await b2.eval(`const H = window.__HERMES_E2E__; return { status: H.sessionStatus(${JSON.stringify(id2)}), badge: e2e.first(".attention-badge")?.dataset.count };`);
  log(`  after the new request: ${JSON.stringify(seen)}`);
  await b2.screenshot(join(evidenceDir, "01-reattached-asks.png"));
  assert(got !== null && got.confidence === "exact", "Hermes shows it as needs approval, exact");
  assert(seen.badge === "1", "the badge counts it");
  await write(b2, id2, "y");
});
