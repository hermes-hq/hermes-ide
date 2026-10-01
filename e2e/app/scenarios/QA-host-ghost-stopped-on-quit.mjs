#!/usr/bin/env node
// QA-host-ghost-stopped-on-quit (CHAOS-04, the quit part) — the app crashes
// right after a new session was created, before the workspace was saved.
// The session host keeps that session's program running, but no window
// shows it again, and quitting with Stop used to leave it (and the host)
// running for good. EXPECT: quitting with Stop ends every program the host
// runs for this app, the unlisted one included, and the host exits.
import { execSync } from "node:child_process";
import { join } from "node:path";
import { skipScenario, sleep } from "../harness.mjs";
import { openWizard, runScenario } from "../n11-steps.mjs";
import { newTerminal, onWindows, startApp } from "../qa-host-steps.mjs";

const SCENARIO = "QA-host-ghost-stopped-on-quit";
const PRIMARY = ".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary";

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  if (onWindows) skipScenario({ scenario: SCENARIO, evidenceDir, reason: "Windows has no session host", log });
  const { fx, app, bridge } = await startApp("qa-ghost", evidenceDir, log, onCleanup, apps);
  const hostPids = async (b) => (await b.eval(`return (await window.__TAURI_INTERNALS__.invoke("session_host_status")).sessions.filter((s) => s.alive).map((s) => s.pid);`)) ?? [];
  const hostPid = async (b) => b.eval(`return (await window.__TAURI_INTERNALS__.invoke("session_host_status")).pid;`);
  await newTerminal(bridge, "listed");
  await sleep(2000);
  await openWizard(bridge);
  await bridge.clickWhenReady(`const cards = e2e.all(".session-creator-provider-card"); return e2e.click(cards[cards.length - 1]);`);
  for (let i = 0; i < 5; i++) {
    const label = await bridge.eval(`const b = e2e.first(${JSON.stringify(PRIMARY)}); return b ? b.innerText : null;`);
    if (!label || /create/i.test(label)) break;
    await bridge.click(PRIMARY);
    await sleep(400);
  }
  await bridge.eval(`
    e2e.click(e2e.first(${JSON.stringify(PRIMARY)}));
    const t0 = performance.now();
    while (window.__HERMES_E2E__.terminalIds().length < 2 && performance.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 5));
    return true;`, { timeoutMs: 20_000 });
  const programs = await hostPids(bridge);
  const host = await hostPid(bridge);
  app.child.kill("SIGKILL");
  log(`  the app was killed right after the second session showed; host ${host}, programs ${JSON.stringify(programs)}`);
  await sleep(1500);

  const app2 = await fx.launch(evidenceDir, 2);
  apps.push(app2);
  const b2 = app2.bridge;
  await b2.waitFor("the app UI", `return !!e2e.first(".topbar") && !e2e.first(".onboarding-backdrop");`, { timeoutMs: 30_000 });
  await sleep(4000);
  const rows = await b2.eval(`return e2e.all(".session-item").length;`);
  const running = await hostPids(b2);
  log(`  after the relaunch: ${rows} session(s) listed; the host runs ${running.length} program(s)`);
  await b2.screenshot(join(evidenceDir, "01-relaunch.png"));

  log("quit, answering Stop if asked");
  await app2.stop();
  const alive = (pid) => {
    try {
      execSync(`kill -0 ${pid}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  let left = [];
  for (let i = 0; i < 20; i++) {
    left = [host, ...running].filter((p) => p && alive(p));
    if (left.length === 0) break;
    await sleep(1000);
  }
  log(`  still running after the quit: ${JSON.stringify(left)}`);
  onCleanup(() => {
    for (const p of left) {
      try {
        process.kill(p, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  });
  assert(left.length === 0, "no program of this app (nor the host) is left running after quitting with Stop");
});
