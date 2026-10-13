#!/usr/bin/env node
// QA-host-attach-nudge — a project attached to a running terminal-mode
// agent through the pane's "+" (the project picker) reaches the agent as one
// sent prompt: "Read the file at $HERMES_CONTEXT for project context about
// the attached workspaces." The fake Claude Code here turns on bracketed
// paste like the real one and records every prompt it is sent.
//
//   1. fresh: the agent waits; attach: EXPECT the nudge sent
//   2. busy: attach while the agent works on a turn: EXPECT it sent (the
//      agent reads it after the turn, as Claude Code queues it)
//   3. the person typed and deleted it with Backspace: nothing is typed while
//      text may be on the line; Ctrl+U clears it and the agent, which was
//      waiting all along, gets it: EXPECT it sent with no turn in between
//   4. the app is killed and relaunched; the session reattaches to the same
//      agent in the session host: EXPECT the nudge sent
//   5. the same after more output than the host keeps for a replay (a long
//      session; what the app reads back no longer shows how the agent
//      started): EXPECT the nudge sent
//
// Before the fix it ended in RESULT: FAIL at every case: an agent was only
// known from its banner (this fake prints none, like a long session read back
// after a restart), a nudge kept for later went out only on one kind of idle
// that an agent already waiting never reaches, and Done pressed while the
// attach was finishing sent nothing. REAL-attach-nudge-claude covers the real
// Claude Code, which also left the nudge in its input unsent (its Enter came
// inside a paste).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { skipScenario, sleep } from "../harness.mjs";
import { runScenario } from "../n11-steps.mjs";
import { claude, onWindows, startApp, write } from "../qa-host-steps.mjs";

const SCENARIO = "QA-host-attach-nudge";
const NUDGE = "Read the file at $HERMES_CONTEXT for project context about the attached workspaces.";

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  if (onWindows) skipScenario({ scenario: SCENARIO, evidenceDir, reason: "Windows has no session host", log });
  const { fx, app, bridge: b1 } = await startApp("qa-nudge", evidenceDir, log, onCleanup, apps);
  fx.setFake("mode", "prompts bracketed-paste");
  const extra = ["one", "two", "three", "four", "five"].map((n) => {
    const dir = join(fx.work, `extra-${n}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), `# extra ${n}\n`);
    return dir;
  });
  const A = await claude(b1, fx, fx.repo, "api: attach", 1);
  await b1.waitForTerminal(A, /fake-cli: ready/, { timeoutMs: 20_000 });
  await sleep(2500);

  const prompts = () => fx.records()[0]?.prompts ?? [];
  const nudges = () => prompts().filter((p) => p === NUDGE).length;
  async function nudgeSent(before, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (nudges() > before) return true;
      await sleep(250);
    }
    return nudges() > before;
  }

  /** Attach `folder` through the pane's "+" and the picker's folder field, then Done. */
  async function attach(bridge, folder) {
    await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.first(".split-pane")?.querySelector(".scope-bar-add"), "the pane's + (attach project)"));`);
    await bridge.waitFor("the project picker", `return !!e2e.first(".project-picker");`);
    await bridge.eval(`
      const input = e2e.must(e2e.first(".project-picker-scan-input"), "folder field");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(folder)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    `);
    await bridge.clickByName("Scan", { within: ".project-picker-footer" });
    const name = folder.split(/[\\/]/).pop();
    await bridge.waitFor(`${name} attached in the picker`, `return e2e.all(".project-picker-item-attached").some((el) => el.innerText.includes(${JSON.stringify(name)}));`, { timeoutMs: 20_000 });
    // Done as soon as the row shows it attached, as a quick hand does.
    const stillRunning = await bridge.eval(`return e2e.norm(e2e.first(".project-picker-browse")?.innerText || "") === "...";`);
    await bridge.clickByName("Done", { within: ".project-picker-footer" });
    await bridge.waitFor("the project picker to close", `return !e2e.first(".project-picker");`);
    log(`  attached ${name} (Done pressed while the attach was still running: ${stillRunning})`);
  }

  const results = [];
  const record = (ok, what) => {
    results.push({ ok, what });
    log(`  ${ok ? "ok" : "NOT OK"} — ${what}`);
  };

  log("case 1: fresh, the agent waits");
  let before = nudges();
  await attach(b1, extra[0]);
  record(await nudgeSent(before, 10_000), "fresh: the nudge reached the agent as a prompt");

  log("case 2: the agent works on a turn");
  await write(b1, A, "work 5000\r");
  await b1.waitForTerminal(A, /working for 5000 ms/, { timeoutMs: 10_000 });
  before = nudges();
  await attach(b1, extra[1]);
  const busySent = await nudgeSent(before, 20_000);
  const order = prompts().slice(-2);
  record(busySent && order[0] === "work 5000" && order[1] === NUDGE, `busy: the nudge reached the agent after its turn (last prompts: ${JSON.stringify(order)})`);

  log("case 3: text typed and deleted with Backspace, the agent waiting all along");
  await sleep(2500);
  await write(b1, A, "hello");
  await write(b1, A, "\x7f\x7f\x7f\x7f\x7f");
  before = nudges();
  await attach(b1, extra[2]);
  const early = await nudgeSent(before, 3000);
  record(!early, "nothing is typed while text may be on the person's line");
  await write(b1, A, "\x15");
  record(!early && (await nudgeSent(before, 8000)), "once the line is cleared, the waiting agent gets the nudge");

  log("case 4: the app is killed and relaunched; the session reattaches");
  app.child.kill("SIGKILL");
  await sleep(2000);
  const app2 = await fx.launch(evidenceDir, 2);
  apps.push(app2);
  const b2 = app2.bridge;
  await b2.waitFor("the app UI", `return !!e2e.first(".topbar") && !e2e.first(".onboarding-backdrop");`, { timeoutMs: 30_000 });
  await b2.waitFor("the session back", `return window.__HERMES_E2E__.terminalIds().includes(${JSON.stringify(A)});`, { timeoutMs: 30_000 });
  await sleep(3000);
  before = nudges();
  await attach(b2, extra[3]);
  record(await nudgeSent(before, 10_000), "after a restart: the nudge reached the agent");
  await b2.screenshot(join(evidenceDir, "01-after-restart.png"));

  log("case 5: more output than the host replays, then a restart");
  const ps = execFileSync("ps", ["-axo", "tty=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const row = ps.split("\n").find((l) => new RegExp(`(^|/)hi run ${A}(\\s|$)`).test(l.trim().split(/\s+/).slice(1).join(" ")));
  const tty = row ? `/dev/${row.trim().split(/\s+/)[0]}` : null;
  log(`  the agent's terminal: ${tty}`);
  assert(tty && tty !== "/dev/??", "the agent's terminal device is known");
  const line = `${"x".repeat(150)}\r\n`;
  writeFileSync(tty, line.repeat(Math.ceil((2.5 * 1024 * 1024) / line.length)));
  await sleep(3000);
  app2.child.kill("SIGKILL");
  await sleep(2000);
  const app3 = await fx.launch(evidenceDir, 3);
  apps.push(app3);
  const b3 = app3.bridge;
  await b3.waitFor("the app UI", `return !!e2e.first(".topbar") && !e2e.first(".onboarding-backdrop");`, { timeoutMs: 30_000 });
  await b3.waitFor("the session back", `return window.__HERMES_E2E__.terminalIds().includes(${JSON.stringify(A)});`, { timeoutMs: 30_000 });
  await sleep(3000);
  before = nudges();
  await attach(b3, extra[4]);
  record(await nudgeSent(before, 10_000), "after a restart of a long session: the nudge reached the agent");
  await b3.screenshot(join(evidenceDir, "02-after-restart-long.png"));

  log(`  prompts the agent got: ${JSON.stringify(prompts())}`);
  for (const r of results) assert(r.ok, r.what);
});
