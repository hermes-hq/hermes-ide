#!/usr/bin/env node
// QA-launcher-queued-task-setup (LEAD-03): a task that waited in the queue
// (N22) starts exactly like one that started at once (F15): its Full-track
// feature.md in its worktree, its checks next to the worktree, and its
// launch recorded (task_launches, the launcher's Recent).
//   1. at most 1 running agent; "First running task" holds the slot;
//   2. "Second queued feature" with Track as a feature is queued;
//   3. the first agent ends its turn: the queued task starts;
//   4. its worktree has .hermes/features/second-queued-feature/feature.md,
//      and task_launches has its record (Full track).
//
// Negative control: a build before the fix starts it with a bare
// createSession: no feature.md, no record.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setCapInSettings } from "../fleet-steps.mjs";
import { expandOptions, invoke, openLauncher, typeInto, waitLaunchEnabled, waitLauncherClosed } from "../launcher-steps.mjs";
import { runLauncherQa, sleep } from "../qa-launcher-steps.mjs";

const write = (bridge, sessionId, data) =>
  bridge.eval(`await window.__TAURI_INTERNALS__.invoke("write_to_session", { sessionId: ${JSON.stringify(sessionId)}, data: btoa(${JSON.stringify(data)}) }); return true;`);

await runLauncherQa("QA-launcher-queued-task-setup", async ({ bridge, fx, log, check, assert, evidenceDir }) => {
  const projects = await invoke(bridge, "get_projects_ordered");
  const project = projects.find((p) => fx.samePath(p.path, fx.repo));
  await setCapInSettings(bridge, log, "maxRunning", 1);

  log("the first task starts and holds the only slot");
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "First running task");
  await waitLaunchEnabled(bridge);
  await bridge.click(".task-launcher-launch");
  await waitLauncherClosed(bridge);
  await fx.waitForRecords(1);
  const [first] = await bridge.waitFor("the first session", `const ids = window.__HERMES_E2E__.terminalIds(); return ids.length === 1 ? ids : null;`, { timeoutMs: 20_000 });
  await sleep(2500);
  await write(bridge, first, "w");
  await bridge.waitFor("the slot to be held", `return window.__HERMES_E2E__.fleetState().occupancy.sessionIds.length === 1;`, { timeoutMs: 20_000 });

  log("a Full-track task is queued");
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "Second queued feature");
  await expandOptions(bridge);
  await bridge.clickWhenReady(`const box = e2e.must(e2e.first(".task-launcher-feature-box"), "Track as a feature"); return box.checked ? true : e2e.click(box);`);
  await waitLaunchEnabled(bridge);
  await bridge.click(".task-launcher-launch");
  await waitLauncherClosed(bridge);
  await bridge.waitFor("the task in the queue", `return window.__HERMES_E2E__.fleetState().queue.length === 1;`, { timeoutMs: 10_000 });
  await bridge.screenshot(join(evidenceDir, "01-queued.png"));

  log("the first agent ends its turn; the queued task starts");
  await write(bridge, first, "s");
  const second = await bridge.waitFor("the queued task to start", `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => id !== ${JSON.stringify(first)});
    return ids.length === 1 && window.__HERMES_E2E__.fleetState().queue.length === 0 ? ids[0] : null;`, { timeoutMs: 30_000 });
  await fx.waitForRecords(2);
  await sleep(3000);
  const wt = await invoke(bridge, "git_session_worktree_info", { sessionId: second, projectId: project.id });
  log(`  the queued task's worktree: ${JSON.stringify({ branch: wt?.branchName, main: wt?.isMainWorktree })}`);
  assert(wt && !wt.isMainWorktree, "the queued task got its own worktree");
  const feature = join(wt.worktreePath, ".hermes", "features", "second-queued-feature", "feature.md");
  const launches = JSON.parse((await invoke(bridge, "get_settings")).task_launches || "[]");
  log(`  task_launches: ${JSON.stringify(launches.map((l) => ({ task: l.task, track: l.track })))}`);
  await bridge.screenshot(join(evidenceDir, "02-started-from-queue.png"));
  check(launches.some((l) => l.sessionId === second && l.track === "Full"), "the queued task's launch is recorded (Full track)");
  check(existsSync(feature) && /track: Full/.test(readFileSync(feature, "utf8")), "the queued Full-track task got its feature.md");
});
