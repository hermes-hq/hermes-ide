#!/usr/bin/env node
// Scenario: N22 — task queue and concurrency cap, on the REAL app with fake
// agents (a tiny Node program started as a Custom agent; no real agent).
//
//   run 1  fresh install: turn the fleetControls and agentCatalog (Custom
//          agent) flags on; relaunch.
//   run 2  - Settings > Limits: "Agents running at once" = 3.
//          - Launch five agent tasks from the New Session wizard. Tasks 1-3
//            start (their agent prints its banner); tasks 4 and 5 do not: the
//            session list shows them queued, "3 of 3 running".
//          - Task 2's agent finishes (it is told to quit): task 4 starts on
//            its own; task 5 still waits.
//          - Task 1's agent finishes: task 5 starts; the queue is gone.
//          - Memory: the count cap off, "Memory for running agents" = 1 MB.
//            The three running agents use more than that, so a sixth task
//            waits ("MB" in the queue header); when they finish, it starts.
//
// Negative control: HERMES_E2E_N22_CAP=off leaves the cap unset; all five
// start at once and the scenario must end in RESULT: FAIL.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N22-task-queue.mjs

import { mkdtempSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { sleep } from "../harness.mjs";
import { completeOnboarding, finishWizard, openWizard, runScenario } from "../n11-steps.mjs";
import { relauncher, setCapInSettings, setFlagOverrides, setInput, waitForReturningLaunch } from "../fleet-steps.mjs";

const SCENARIO = "N22-task-queue";
const CAP_ON = (process.env.HERMES_E2E_N22_CAP || "on") !== "off";

// ── The fake agent: prints a banner, exits on "quit". ────────────────
const fakeDir = mkdtempSync(join(tmpdir(), "hermes-e2e-n22-"));
const fakeScript = join(fakeDir, "fake-task-agent.mjs");
writeFileSync(
  fakeScript,
  `const n = process.argv[2] ?? "?";
process.stdout.write("FAKE-TASK READY " + n + "\\r\\n");
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.search(/[\\r\\n]/)) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line === "quit") { process.stdout.write("FAKE-TASK DONE " + n + "\\r\\n"); process.exit(0); }
  }
});
`,
);
// Typed into the session's shell exactly as written: it must not need quoting.
const commandFor = (n) => `${process.execPath} ${fakeScript} ${n}`;
if (/\s/.test(process.execPath) || /\s/.test(fakeScript)) throw new Error(`the fake agent command would need quoting: ${commandFor(1)}`);

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps }) => {
  const launch = relauncher(evidenceDir, log, "n22");
  log(`scenario: ${SCENARIO}   platform: ${platform()}   cap: ${CAP_ON ? "3" : "OFF (negative control)"}`);

  let app = await launch(1, { first: true });
  apps.push(app);
  await completeOnboarding(app.bridge, log);
  await setFlagOverrides(app.bridge, { fleetControls: true, agentCatalog: true });
  const exit1 = await app.stop();
  assert(!exit1.forced && exit1.code === 0, "run 1 quit cleanly");

  app = await launch(2);
  apps.push(app);
  const { bridge } = app;
  await waitForReturningLaunch(bridge, log);

  if (CAP_ON) {
    log("step 1: Settings > Limits: agents running at once = 3");
    const label = await setCapInSettings(bridge, log, "maxRunning", "3");
    assert(label === "Agents running at once", `the field is labelled "${label}"`);
  }

  // The screen as one text: a banner can share a row with the command that
  // started it (a shell that did not echo the Enter yet) and wrap onto the
  // next row.
  const SCREEN_TEXT = `(H.readTerminal(id) || []).map((l) => l.replace(/\\s+$/, "")).join("")`;

  /** Terminal ids whose screen shows the task's banner, by task number. */
  const tasksOnScreen = () => bridge.eval(`
    const H = window.__HERMES_E2E__;
    const out = {};
    for (const id of H.terminalIds()) {
      for (const m of ${SCREEN_TEXT}.matchAll(/FAKE-TASK READY (\\d+)(?!\\d)/g)) out[m[1]] = id;
    }
    return out;
  `);
  const bannerShown = (n) => `
    const H = window.__HERMES_E2E__;
    return H.terminalIds().some((id) => new RegExp("FAKE-TASK READY ${n}(?!\\\\d)").test(${SCREEN_TEXT}));
  `;
  const queueState = () => bridge.eval(`
    const q = e2e.first(".task-queue");
    if (!q) return null;
    return {
      title: e2e.norm(q.querySelector(".task-queue-title")?.textContent ?? ""),
      slots: e2e.norm(q.querySelector(".task-queue-slots")?.textContent ?? ""),
      labels: e2e.all(".task-queue-item .task-queue-label").map((el) => e2e.norm(el.innerText)),
    };
  `);

  /** One task from the New Session wizard: the Custom agent, named "Task n". */
  async function launchTask(n) {
    await openWizard(bridge);
    await bridge.click('.session-creator-provider-card[data-agent-id="custom"]');
    await bridge.waitFor("the custom agent fields", `return !!e2e.first("#session-creator-custom-agent-command");`);
    await setInput(bridge, "#session-creator-custom-agent-name", `Task ${n}`);
    await setInput(bridge, "#session-creator-custom-agent-command", commandFor(n));
    await bridge.waitFor("Next to become enabled", `return e2e.first(".session-creator-actions .session-creator-btn-primary")?.disabled === false;`);
    await finishWizard(bridge, log);
    log(`  launched Task ${n}`);
  }

  async function quitTask(n, sessionId) {
    // Open the task's session, as a person would, then tell its agent to quit.
    await bridge.click(`.session-item[data-session-item-id="${sessionId}"]`);
    await bridge.waitFor(`Task ${n}'s terminal to be shown`, `
      return !!document.querySelector('div[data-session-id="${sessionId}"] textarea.xterm-helper-textarea');
    `);
    await bridge.typeInTerminal(sessionId, "quit\n");
    await bridge.waitForTerminal(sessionId, new RegExp(`^FAKE-TASK DONE ${n}$`), { timeoutMs: 15_000 });
    log(`  Task ${n}'s agent finished`);
  }

  log("step 2: launch five agent tasks");
  for (const n of [1, 2, 3]) {
    await launchTask(n);
    await bridge.waitFor(`Task ${n}'s agent to start`, bannerShown(n), { timeoutMs: 60_000 });
  }
  await launchTask(4);
  await launchTask(5);
  await sleep(3000);
  let running = await tasksOnScreen();
  log(`  tasks running: ${JSON.stringify(Object.keys(running))}`);
  const queue1 = await queueState();
  log(`  queue: ${JSON.stringify(queue1)}`);
  assert(Object.keys(running).sort().join(",") === "1,2,3", "tasks 1, 2 and 3 run");
  assert(queue1 && queue1.labels.join(",") === "Task 4,Task 5", "tasks 4 and 5 wait in the queue, in order");
  assert(queue1.title === "Queued · 2" && queue1.slots === "3 of 3 running", `the queue says "${queue1.title}" / "${queue1.slots}"`);
  const sessions1 = await bridge.eval(`return e2e.all(".session-item").length;`);
  assert(sessions1 === 3, `three sessions exist (${sessions1})`);
  await bridge.screenshot(join(evidenceDir, "01-two-queued.png"));

  log("step 3: Task 2 finishes -> Task 4 starts on its own; Task 5 keeps waiting");
  await quitTask(2, running["2"]);
  await bridge.waitFor("Task 4's agent to start", bannerShown(4), { timeoutMs: 60_000 });
  await sleep(2000);
  running = await tasksOnScreen();
  const queue2 = await queueState();
  log(`  queue: ${JSON.stringify(queue2)}`);
  assert(!running["5"], "Task 5 has not started");
  assert(queue2 && queue2.labels.join(",") === "Task 5", "only Task 5 waits");
  await bridge.screenshot(join(evidenceDir, "02-one-queued.png"));

  log("step 4: Task 1 finishes -> Task 5 starts; the queue is gone");
  await quitTask(1, running["1"]);
  await bridge.waitFor("Task 5's agent to start", bannerShown(5), { timeoutMs: 60_000 });
  await bridge.waitFor("the queue to disappear", `return !e2e.first(".task-queue");`);
  running = await tasksOnScreen();
  await bridge.screenshot(join(evidenceDir, "03-queue-empty.png"));

  log("step 5: a memory cap: running agents above 1 MB hold a sixth task until they finish");
  await setCapInSettings(bridge, log, "maxRunning", "");
  await setCapInSettings(bridge, log, "maxMemoryMb", "1");
  await sleep(1500); // one load reading with the memory cap on
  const load = await bridge.eval(`return window.__HERMES_E2E__.fleetState();`);
  log(`  fleet: ${JSON.stringify({ occupancy: load.occupancy, loads: load.loads })}`);
  await launchTask(6);
  await sleep(2000);
  const queue3 = await queueState();
  log(`  queue: ${JSON.stringify(queue3)}`);
  assert(queue3 && queue3.labels.join(",") === "Task 6", "Task 6 waits for memory");
  assert(/^\d+ of 1 MB$/.test(queue3.slots), `the queue shows the memory in use ("${queue3.slots}")`);
  assert(!(await tasksOnScreen())["6"], "Task 6 has not started");
  await bridge.screenshot(join(evidenceDir, "04-memory-queued.png"));
  for (const n of ["3", "4", "5"]) await quitTask(n, running[n]);
  await bridge.waitFor("Task 6's agent to start", bannerShown(6), { timeoutMs: 60_000 });
  await bridge.waitFor("the queue to disappear", `return !e2e.first(".task-queue");`);
  log("  ok — Task 6 started once the running agents finished");
});
