#!/usr/bin/env node
// QA-launcher-queued-feedback (SOLO-16, LEAD-13): at most 1 running agent,
// one at work. A task launched now is queued and the sheet closes:
//   - with the sidebar hidden, a toast says "Queued — starts when the
//     running agent finishes", with Start now, which starts it;
//   - with two running, the next one says "one of the 2 running agents";
//     its queue row says which task it is (the whole task on hover) and
//     where it runs ("Claude Code · launcher-repo"), its buttons are named
//     for the task ("Start “…” now", "Remove “…” from the queue"), and the
//     header says how many slots are in use ("2 of 1 slots in use").
//
// Negative control: a build before the fix closes the sheet without a word,
// and the queue row shows a cut label and a generic tooltip only.

import { join } from "node:path";
import { setCapInSettings } from "../fleet-steps.mjs";
import { openLauncher, typeInto, waitLaunchEnabled, waitLauncherClosed } from "../launcher-steps.mjs";
import { menuAction, runLauncherQa, sleep } from "../qa-launcher-steps.mjs";

const QUEUED = "Third task, which waits for a free slot because one agent is already at work";
const write = (bridge, sessionId, data) =>
  bridge.eval(`await window.__TAURI_INTERNALS__.invoke("write_to_session", { sessionId: ${JSON.stringify(sessionId)}, data: btoa(${JSON.stringify(data)}) }); return true;`);

await runLauncherQa("QA-launcher-queued-feedback", async ({ bridge, fx, log, check, evidenceDir }) => {
  await setCapInSettings(bridge, log, "maxRunning", 1);
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "First task");
  await waitLaunchEnabled(bridge);
  await bridge.click(".task-launcher-launch");
  await waitLauncherClosed(bridge);
  await fx.waitForRecords(1);
  const [first] = await bridge.waitFor("the first session", `const ids = window.__HERMES_E2E__.terminalIds(); return ids.length === 1 ? ids : null;`, { timeoutMs: 20_000 });
  await sleep(2500);
  await write(bridge, first, "w");
  await bridge.waitFor("the slot to be held", `return window.__HERMES_E2E__.fleetState().occupancy.sessionIds.length === 1;`, { timeoutMs: 20_000 });

  await menuAction(bridge, "view.toggle-sidebar");
  await sleep(500);
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", QUEUED);
  await waitLaunchEnabled(bridge);
  await bridge.click(".task-launcher-launch");
  await waitLauncherClosed(bridge);
  await bridge.waitFor("the task in the queue", `return window.__HERMES_E2E__.fleetState().queue.length === 1;`, { timeoutMs: 10_000 });
  const toast = await bridge.waitFor("the queued toast", `const t = e2e.all(".toast").map((x) => e2e.norm(x.innerText)).find((x) => /Queued/.test(x)); return t ?? null;`, { timeoutMs: 5_000 }).catch(() => null);
  log(`  toast: ${JSON.stringify(toast)}`);
  check(!!toast && /Queued — starts when the running agent finishes/.test(toast), "a queued launch says so on screen with the sidebar hidden");
  check(!!toast && /Start now/.test(toast), "with Start now");
  const pressed = await bridge.eval(`
    const t = e2e.all(".toast").find((x) => /Queued/.test(x.innerText));
    const b = t && [...t.querySelectorAll("button")].find((x) => /Start now/.test(x.innerText));
    if (!b) return false;
    e2e.click(b);
    return true;`);
  check(pressed, "the toast's Start now can be pressed");
  await bridge.screenshot(join(evidenceDir, "01-queued-sidebar-hidden.png"));
  await bridge.waitFor("the queued task to start", `return window.__HERMES_E2E__.fleetState().queue.length === 0;`, { timeoutMs: 20_000 });
  await fx.waitForRecords(2);
  check(true, "Start now starts it");
  const second = await bridge.waitFor("the second session", `const ids = window.__HERMES_E2E__.terminalIds().filter((id) => id !== ${JSON.stringify(first)}); return ids.length === 1 ? ids[0] : null;`, { timeoutMs: 20_000 });
  await sleep(2500);
  await write(bridge, second, "w");
  await bridge.waitFor("both slots to be held", `return window.__HERMES_E2E__.fleetState().occupancy.sessionIds.length === 2;`, { timeoutMs: 20_000 });

  // Another one, with two agents running now: the queue row says which task and where.
  await menuAction(bridge, "view.toggle-sidebar");
  await sleep(600);
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", QUEUED);
  await waitLaunchEnabled(bridge);
  await bridge.click(".task-launcher-launch");
  await waitLauncherClosed(bridge);
  await bridge.waitFor("the task in the queue", `return window.__HERMES_E2E__.fleetState().queue.length === 1;`, { timeoutMs: 10_000 });
  const toast2 = await bridge.waitFor("the queued toast", `const t = e2e.all(".toast").map((x) => e2e.norm(x.innerText)).find((x) => /Queued — starts when one of/.test(x)); return t ?? null;`, { timeoutMs: 5_000 }).catch(() => null);
  log(`  toast with two running: ${JSON.stringify(toast2)}`);
  check(!!toast2 && /Queued — starts when one of the 2 running agents finishes/.test(toast2), "with two agents running it says one of the 2");
  const row = await bridge.eval(`
    const li = e2e.first(".task-queue-item");
    if (!li) return null;
    return {
      title: li.querySelector(".task-queue-text")?.getAttribute("title") ?? "",
      where: e2e.norm(li.querySelector(".task-queue-where")?.innerText ?? ""),
      start: li.querySelector(".task-queue-start")?.getAttribute("aria-label") ?? "",
      remove: li.querySelector(".task-queue-remove")?.getAttribute("aria-label") ?? "",
      slots: e2e.norm(e2e.first(".task-queue-slots")?.innerText ?? ""),
    };`);
  log(`  queue row: ${JSON.stringify(row)}`);
  await bridge.screenshot(join(evidenceDir, "02-queue-row.png"));
  check(row?.title === QUEUED, "the row's tooltip is the whole task");
  check(row?.where === "Claude Code · launcher-repo", "line 2 says the agent and the project");
  check(/^Start “.+” now$/.test(row?.start ?? "") && /^Remove “.+” from the queue$/.test(row?.remove ?? ""), "the buttons are named for the task");
  check(/^\d+ of 1 slots in use$/.test(row?.slots ?? ""), `the header says how many slots are in use ("${row?.slots}")`);
});
