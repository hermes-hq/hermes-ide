#!/usr/bin/env node
// QA-launcher-queue-kept-on-quit (LEAD-02): tasks waiting in the queue (N22)
// are kept when Hermes quits, and the quit question says so.
//   1. at most 1 running agent (Settings > Limits); "First running task"
//      works and holds the slot; two more tasks are queued;
//   2. quit: the question says "2 tasks are waiting in the queue — they
//      will start next time Hermes opens";
//   3. relaunch on the same data: both tasks are back (waiting, or started).
//
// Negative control: a build before the fix keeps the queue in memory only;
// the quit question lists the working session alone and the tasks are gone.

import { join } from "node:path";
import { setCapInSettings } from "../fleet-steps.mjs";
import { openLauncher, typeInto, waitForReturningLaunch, waitLaunchEnabled, waitLauncherClosed } from "../launcher-steps.mjs";
import { runLauncherQa, sleep } from "../qa-launcher-steps.mjs";

const write = (bridge, sessionId, data) =>
  bridge.eval(`await window.__TAURI_INTERNALS__.invoke("write_to_session", { sessionId: ${JSON.stringify(sessionId)}, data: btoa(${JSON.stringify(data)}) }); return true;`);

async function launchTaskText(bridge, text) {
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", text);
  await waitLaunchEnabled(bridge);
  await bridge.click(".task-launcher-launch");
  await waitLauncherClosed(bridge);
}

await runLauncherQa("QA-launcher-queue-kept-on-quit", async ({ bridge, fx, log, check, evidenceDir, relaunch, current }) => {
  await setCapInSettings(bridge, log, "maxRunning", 1);
  await launchTaskText(bridge, "First running task");
  await fx.waitForRecords(1);
  const [first] = await bridge.waitFor("the first session", `const ids = window.__HERMES_E2E__.terminalIds(); return ids.length === 1 ? ids : null;`, { timeoutMs: 20_000 });
  await sleep(2500);
  await write(bridge, first, "w");
  await bridge.waitFor("the slot to be held", `return window.__HERMES_E2E__.fleetState().occupancy.sessionIds.length === 1;`, { timeoutMs: 20_000 });
  await launchTaskText(bridge, "Waiting task one");
  await launchTaskText(bridge, "Waiting task two");
  await bridge.waitFor("two tasks queued", `return window.__HERMES_E2E__.fleetState().queue.length === 2;`);
  const stored = await bridge.waitFor("the queue kept in its setting", `
    const raw = (await window.__TAURI_INTERNALS__.invoke("get_settings")).task_queue ?? "";
    try { const list = JSON.parse(raw); return list.length === 2 ? list.map((t) => t.label) : null; } catch { return null; }`, { timeoutMs: 10_000 }).catch(() => null);
  check(JSON.stringify(stored) === JSON.stringify(["Waiting task one", "Waiting task two"]), `the queue is kept in its setting, in order (${JSON.stringify(stored)})`);

  log("quit");
  await bridge.quit();
  const dialog = await bridge
    .waitFor("the quit question", `const d = e2e.first('[data-testid="quit-with-agents-dialog"]'); return d ? e2e.norm(d.innerText) : null;`, { timeoutMs: 10_000 })
    .catch(() => null);
  log(`  quit question: ${JSON.stringify(dialog)}`);
  if (dialog) await bridge.screenshot(join(evidenceDir, "01-quit-question.png"));
  check(!!dialog && /2 tasks are waiting in the queue — they will start next time Hermes opens/.test(dialog), "the quit question says the 2 queued tasks wait for the next start");
  await current().stop();

  log("relaunch on the same data");
  const app = await relaunch(2);
  await waitForReturningLaunch(app.bridge);
  // A queued task that starts on the relaunch leaves the queue a moment
  // before its session shows in the sidebar, so poll instead of one look.
  const snapshot = `
    const H = window.__HERMES_E2E__;
    return { queue: H.fleetState().queue.map((t) => t.label), sessions: e2e.all(".session-item").map((el) => e2e.norm(el.innerText).slice(0, 60)) };`;
  const keptIn = (s, name) => s.queue.includes(name) || s.sessions.some((x) => x.includes(name));
  const bothKept = (s) => keptIn(s, "Waiting task one") && keptIn(s, "Waiting task two");
  let after = await app.bridge.eval(snapshot);
  for (const deadline = Date.now() + 20_000; !bothKept(after) && Date.now() < deadline; ) {
    await sleep(250);
    after = await app.bridge.eval(snapshot);
  }
  log(`  after the relaunch: ${JSON.stringify(after)}`);
  await app.bridge.screenshot(join(evidenceDir, "02-after-relaunch.png"));
  check(bothKept(after), "both queued tasks are back after the relaunch (waiting or started)");
});
