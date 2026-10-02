#!/usr/bin/env node
// QA-host-app-kill-reattach (LEAD-01) — the app is killed (crash, force
// quit, kill -9) while two agents work. EXPECT on relaunch: both sessions
// reattach to the same still-running programs (the session host outlives
// the app) and are still shown working, exact, from their own reports.
import { join } from "node:path";
import { skipScenario, sleep } from "../harness.mjs";
import { runScenario } from "../n11-steps.mjs";
import { claude, onWindows, pidAlive, startApp, write } from "../qa-host-steps.mjs";

const SCENARIO = "QA-host-app-kill-reattach";
await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  if (onWindows) skipScenario({ scenario: SCENARIO, evidenceDir, reason: "Windows has no session host", log });
  const { fx, app, bridge } = await startApp("qa-kill", evidenceDir, log, onCleanup, apps);
  const A = await claude(bridge, fx, fx.repo, "api: fix login", 1);
  const B = await claude(bridge, fx, fx.otherRepo, "web: dark mode", 2);
  await sleep(2500);
  // `w`: the fake agent reports a prompt and works (no turn end yet).
  await write(bridge, A, "w");
  await write(bridge, B, "w");
  await bridge.waitFor("both working", `return [${JSON.stringify(A)}, ${JSON.stringify(B)}].every((id) => window.__HERMES_E2E__.sessionStatus(id).kind === "working");`, { timeoutMs: 15_000 });
  const pids = await bridge.eval(`return (await window.__TAURI_INTERNALS__.invoke("session_host_status")).sessions.map((s) => s.pid);`);
  log(`  host pids before the kill: ${JSON.stringify(pids)}`);
  log("kill -9 the app");
  app.child.kill("SIGKILL");
  await sleep(2000);
  const alive = pids.map(pidAlive);
  log(`  programs alive after the kill: ${JSON.stringify(alive)}`);
  const app2 = await fx.launch(evidenceDir, 2);
  apps.push(app2);
  const b2 = app2.bridge;
  await b2.waitFor("the app UI", `return !!e2e.first(".topbar") && !e2e.first(".onboarding-backdrop");`, { timeoutMs: 30_000 });
  await b2.waitFor("both sessions back", `return window.__HERMES_E2E__.terminalIds().length === 2;`, { timeoutMs: 30_000 });
  await b2.waitFor("their reports read again", `
    const H = window.__HERMES_E2E__;
    return H.terminalIds().every((id) => (H.sessionStatus(id).source || "").startsWith("hook:"));`, { timeoutMs: 15_000 }).catch(() => null);
  const after = await b2.eval(`
    const H = window.__HERMES_E2E__;
    const host = await window.__TAURI_INTERNALS__.invoke("session_host_status");
    return { ids: H.terminalIds(), host: host.sessions.map((s) => ({ pid: s.pid, alive: s.alive, attached: s.attached })),
      statuses: H.terminalIds().map((id) => H.sessionStatus(id).kind + "/" + H.sessionStatus(id).confidence),
      turns: H.terminalIds().map((id) => window.__HERMES_E2E__.sessionEventSnapshot(id).turn) };`);
  log(`  after relaunch: ${JSON.stringify(after)}`);
  await b2.screenshot(join(evidenceDir, "01-after-kill.png"));
  assert(alive.every(Boolean), "the agents kept running when the app was killed");
  assert(after.ids.length === 2 && after.host.filter((s) => s.attached).length === 2, "both sessions reattached");
  assert(after.host.map((s) => s.pid).sort().join() === [...pids].sort().join(), "to the same programs");
  assert(after.statuses.every((s) => s === "working/exact"), "and they are still shown working, exact");
  assert(after.turns.every((t) => t.current !== null), "each is in a running turn (PLN-02)");
});
