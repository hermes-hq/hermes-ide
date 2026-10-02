#!/usr/bin/env node
// QA-host-morning-view-keep-running (LEAD-01) — the 2.0 default path: the
// session host is on, two agents are blocked on the lead, the lead quits
// and picks "Keep running". Next morning Hermes reattaches both sessions
// and EXPECTS the morning view: "2 agents are waiting on you", badge 2.
// (F12-morning-view covers sessionHost OFF, where the agents restart with
// --resume and ask again.) It used to show both as idle, badge 0: the
// reattached agents' reports were never read again.
import { join } from "node:path";
import { skipScenario, sleep } from "../harness.mjs";
import { runScenario } from "../n11-steps.mjs";
import { block, claude, onWindows, quitAnswering, startApp } from "../qa-host-steps.mjs";

const SCENARIO = "QA-host-morning-view-keep-running";
await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  if (onWindows) skipScenario({ scenario: SCENARIO, evidenceDir, reason: "Windows has no session host", log });
  const { fx, app, bridge } = await startApp("qa-morning", evidenceDir, log, onCleanup, apps);
  const host = await bridge.eval(`return window.__HERMES_E2E__.featureFlags().flags.sessionHost.on;`);
  assert(host === true, "the session host is on (2.0 default)");
  const A = await claude(bridge, fx, fx.repo, "api: fix login", 1);
  const B = await claude(bridge, fx, fx.otherRepo, "web: dark mode", 2);
  await sleep(2500);
  await block(bridge, A);
  await block(bridge, B);
  await bridge.waitFor("badge 2", `return e2e.first(".attention-badge")?.dataset.count === "2";`);
  log("quit, keep running");
  await quitAnswering(bridge, "keep", log);
  await app.stop({ stopPrograms: false });
  await sleep(1500);

  log("relaunch: the next morning");
  const app2 = await fx.launch(evidenceDir, 2);
  apps.push(app2);
  const b2 = app2.bridge;
  await b2.waitFor("the app UI", `return !!e2e.first(".topbar") && !e2e.first(".onboarding-backdrop");`, { timeoutMs: 30_000 });
  const morning = await b2.waitFor("the morning view", `
    const d = e2e.first('.attention-inbox[data-morning="true"]');
    return d ? { title: e2e.norm(e2e.first(".attention-morning-title")?.innerText ?? ""), rows: e2e.all(".attention-option").length } : null;`, { timeoutMs: 45_000 }).catch((e) => ({ error: e.message }));
  const state = await b2.eval(`
    const H = window.__HERMES_E2E__;
    return { ids: H.terminalIds().length, badge: e2e.first(".attention-badge")?.dataset.count,
      statuses: H.terminalIds().map((id) => H.sessionStatus(id).kind + "/" + H.sessionStatus(id).confidence) };`);
  log(`  morning ${JSON.stringify(morning)}; ${JSON.stringify(state)}`);
  await b2.screenshot(join(evidenceDir, "01-next-morning.png"));
  assert(state.ids === 2, "both sessions are back");
  assert(state.statuses.every((s) => s === "needs_approval/exact"), "both still say needs approval, exact");
  assert(state.badge === "2", "the badge says 2 agents are blocked");
  assert(morning && !morning.error && /2 agents are waiting on you/.test(morning.title), "the morning view opened: 2 agents are waiting on you");
});
