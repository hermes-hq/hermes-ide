#!/usr/bin/env node
// Scenario: F31 — honest cost and limits, on the REAL app with the fake
// terminal agent (tools/fake-agents, scenario e2e/app/fixtures/f31-estimate-bait.json).
//
// The fake agent prints a banner Hermes's terminal analyzer takes for
// Claude Code, and token counts from which that analyzer ESTIMATES a cost
// ($0.08), then works until interrupted.
//
//   run 1  flag switched off (on by default since 2.0): the estimate shows in the status bar, and the
//          Cost Dashboard is offered (View menu item enabled, listed in the
//          command palette, the menu action opens it). This is the
//          scenario's own control: the bait works, and the checks of run 2
//          can fail. Turn the fleetControls flag on; relaunch.
//   run 2  flag on:
//          - Settings > Limits: spend cap per session = 1 (USD).
//          - Two terminal sessions A and B run the fake agent. The backend
//            holds an estimated cost for them, yet no "$" appears anywhere in
//            the window: each row says "n/a" (the agent reports no cost).
//            The Cost Dashboard is greyed out in the View menu, missing from
//            the command palette, and its menu action opens nothing.
//          - The agent's own usage arrives as `usage` SessionEvents pushed
//            through the RUST side of the event channel (test build only):
//            A $0.40, B $0.30 -> the rows and the status bar show exactly
//            that, nothing is interrupted.
//          - A reports $1.25 -> A's agent is interrupted by a signal, and
//            nothing is typed into its terminal (SIGINT on macOS and Linux,
//            the console's Ctrl+C event on Windows, which Node reports as
//            SIGINT; it logs it and exits 130), A's row
//            says "cap $1.00 reached", one `limit` item is in the inbox
//            (source "cap"), and B's agent is still running.
//          - A reports $2.00 -> nothing more happens (the cap is soft: once
//            per cap value).
//
// Negative control: HERMES_E2E_F31_FLAG=off switches the flag off in run 2;
// the scenario must end in RESULT: FAIL (the estimate is shown).
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F31-honest-spend-cap.mjs

import { rmSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, sleep } from "../harness.mjs";
import { completeOnboarding, createPlainTerminal, runScenario } from "../n11-steps.mjs";
import { PROBE_OUTPUT, classifyProbe, commandLine, probeCommand } from "../shells.mjs";
import {
  costDashboardOffers,
  emitFromRust,
  readJsonl,
  relauncher,
  rowState,
  setCapInSettings,
  setFlagOverrides,
  waitForFile,
  waitForReturningLaunch,
} from "../fleet-steps.mjs";

const SCENARIO = "F31-honest-spend-cap";
const FLAG_ON = (process.env.HERMES_E2E_F31_FLAG || "on") !== "off";
const FAKE_AGENT = join(REPO_ROOT, "tools", "fake-agents", "fake-agent.mjs");
const BAIT = join(REPO_ROOT, "e2e", "app", "fixtures", "f31-estimate-bait.json");

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps }) => {
  const launch = relauncher(evidenceDir, log, "f31");
  log(`scenario: ${SCENARIO}   platform: ${platform()}   flag in run 2: ${FLAG_ON ? "on" : "OFF (negative control)"}`);

  /** Start the fake agent in a terminal session; resolves once it works. */
  async function startFakeAgent(bridge, sessionId, tag) {
    await bridge.typeInTerminal(sessionId, `${probeCommand()}\n`);
    const { line } = await bridge.waitForTerminal(sessionId, PROBE_OUTPUT, { timeoutMs: 20_000 });
    const shell = classifyProbe(line);
    const agentLog = join(evidenceDir, `fake-agent-${tag}.jsonl`);
    rmSync(agentLog, { force: true });
    await bridge.typeInTerminal(sessionId, commandLine(shell, process.execPath, [FAKE_AGENT, "--scenario", BAIT, "--log", agentLog]) + "\n");
    await bridge.waitForTerminal(sessionId, /^fake-agent: working until interrupted/, { timeoutMs: 20_000 });
    log(`  fake agent ${tag} is working in ${sessionId} (${shell} shell); its log: ${agentLog}`);
    return agentLog;
  }

  // Everything Hermes itself shows: the window without the terminals' own
  // contents (a shell prompt may contain "$").
  const bodyText = (bridge) => bridge.eval(`
    const clone = document.body.cloneNode(true);
    for (const n of clone.querySelectorAll(".xterm, textarea, script, style")) n.remove();
    return clone.textContent;
  `);
  const statusCost = (bridge) => bridge.eval(`return e2e.norm(e2e.first(".status-bar-cost .status-bar-cost-amount")?.innerText ?? "") || null;`);

  // ── run 1: flag off — the estimate is there to be hidden ────────────
  log("run 1: fresh install, flag switched off: Hermes's own estimate shows in the status bar");
  let app = await launch(1, { first: true });
  apps.push(app);
  await completeOnboarding(app.bridge, log);
  // On by default since 2.0: switch it off (the kill switch) and relaunch.
  await setFlagOverrides(app.bridge, { fleetControls: false });
  const exit0 = await app.stop();
  assert(!exit0.forced && exit0.code === 0, "run 1 quit cleanly after switching the flag off");
  app = await launch("1b");
  apps.push(app);
  await waitForReturningLaunch(app.bridge, log);
  const legacy = await createPlainTerminal(app.bridge, log);
  await startFakeAgent(app.bridge, legacy, "run1");
  const estimate = await app.bridge.waitFor("the analyzer's estimated cost in the status bar", `
    return e2e.norm(e2e.first(".status-bar-cost .status-bar-cost-amount")?.innerText ?? "") || null;
  `, { timeoutMs: 20_000 });
  log(`  status bar with the flag off: "${estimate}"`);
  assert(estimate === "$0.08", `without the flag Hermes shows its own estimate ("${estimate}")`);
  assert((await rowState(app.bridge, legacy)).spend === null, "without the flag the row has no spend badge");
  const offers1 = await costDashboardOffers(app.bridge);
  log(`  Cost Dashboard with the flag off: ${JSON.stringify(offers1)}`);
  assert(offers1.menuEnabled === true && offers1.inPalette && offers1.opens, "without the flag the Cost Dashboard is in the View menu and the palette, and opens");
  await app.bridge.screenshot(join(evidenceDir, "01-flag-off-estimate.png"));
  await setFlagOverrides(app.bridge, { fleetControls: FLAG_ON });
  await app.bridge.click(".session-item .session-item-close");
  await sleep(300);
  if (await app.bridge.exists(".close-dialog")) await app.bridge.click(".close-dialog .close-dialog-btn-confirm");
  await app.bridge.waitFor("the session to close", `return e2e.all(".session-item").length === 0;`, { timeoutMs: 20_000 });
  const exit1 = await app.stop();
  assert(!exit1.forced && exit1.code === 0, "run 1 quit cleanly");

  // ── run 2: flag on ──────────────────────────────────────────────────
  log("run 2: relaunch with the fleetControls flag");
  app = await launch(2);
  apps.push(app);
  const { bridge } = app;
  await waitForReturningLaunch(bridge, log);

  // (Without the flag there is no Limits tab; the negative control goes
  // straight to the check that no estimate is shown, and fails there.)
  if (FLAG_ON) {
    log("step 1: Settings > Limits: spend cap per session = 1");
    const capLabel = await setCapInSettings(bridge, log, "sessionUsd", "1");
    assert(capLabel === "Spend cap per session", `the field is labelled "${capLabel}"`);
  }

  log("step 2: two sessions run the fake agent; the backend estimates a cost, the window shows none");
  const a = await createPlainTerminal(bridge, log);
  const logA = await startFakeAgent(bridge, a, "A");
  const b = await createPlainTerminal(bridge, log);
  const logB = await startFakeAgent(bridge, b, "B");
  const backendEstimate = await bridge.waitFor("the backend to hold an estimated cost for A", `
    const s = await window.__TAURI_INTERNALS__.invoke("get_session_detail", { sessionId: ${JSON.stringify(a)} });
    const cost = Object.values(s?.metrics?.token_usage ?? {}).reduce((sum, t) => sum + t.estimated_cost_usd, 0);
    return cost > 0 ? cost : null;
  `, { timeoutMs: 20_000 });
  log(`  the terminal analyzer's estimate for A: ${backendEstimate}`);
  await sleep(1500); // the analyzer's numbers have reached the window by now
  const text0 = await bodyText(bridge);
  const dollars0 = text0.match(/\$\d[\d.,]*/g) ?? [];
  assert(dollars0.length === 0, `no dollar amount anywhere in the window (found ${JSON.stringify(dollars0)})`);
  const rowA0 = await bridge.waitFor("A's row to show n/a", `
    const row = document.querySelector('.session-item[data-session-item-id="' + CSS.escape(${JSON.stringify(a)}) + '"]');
    const spend = row?.querySelector(".session-spend");
    return spend ? { text: e2e.norm(spend.innerText), kind: spend.getAttribute("data-spend") } : null;
  `, { timeoutMs: 20_000 });
  assert(rowA0.text === "n/a" && rowA0.kind === "na", `A's row says "${rowA0.text}": the agent reports no cost`);
  const rowB0 = await rowState(bridge, b);
  assert(rowB0.spend?.text === "n/a", `B's row says "${rowB0.spend?.text}"`);
  // Two agents, neither reports a cost: the total is unknown, not zero and
  // not the analyzer's estimate.
  const status0 = await bridge.waitFor("the status bar to say n/a", `
    const t = e2e.norm(e2e.first(".status-bar-cost .status-bar-cost-amount")?.innerText ?? "");
    return t === "n/a" ? t : null;
  `, { timeoutMs: 10_000 }).catch(() => null);
  assert(status0 === "n/a", `the status bar says n/a, no amount ("${await statusCost(bridge)}")`);
  await bridge.screenshot(join(evidenceDir, "02-flag-on-na.png"));
  const offers2 = await costDashboardOffers(bridge);
  log(`  Cost Dashboard with the flag on: ${JSON.stringify(offers2)}`);
  assert(offers2.menuEnabled === false, "View > Cost Dashboard is greyed out (with its shortcut)");
  assert(!offers2.inPalette, "the command palette does not list the Cost Dashboard");
  assert(!offers2.opens, "the menu action opens nothing");

  log("step 3: the agents report their usage (Rust -> frontend): exactly that is shown, nothing is stopped");
  await emitFromRust(bridge, a, { type: "usage", at: Date.now(), source: "e2e", inputTokens: 12000, outputTokens: 3400, costUsd: 0.4 });
  await emitFromRust(bridge, b, { type: "usage", at: Date.now(), source: "e2e", inputTokens: 9000, outputTokens: 1000, costUsd: 0.3 });
  await bridge.waitFor("both rows to show the reported spend", `
    const spendOf = (id) => e2e.norm(document.querySelector('.session-item[data-session-item-id="' + CSS.escape(id) + '"] .session-spend')?.innerText ?? "");
    return spendOf(${JSON.stringify(a)}) === "$0.40" && spendOf(${JSON.stringify(b)}) === "$0.30";
  `);
  const rowA1 = await rowState(bridge, a);
  assert(rowA1.spend.kind === "exact" && rowA1.cap === null, `A: ${rowA1.spend.text}, reported by the agent, under the cap`);
  const total1 = await statusCost(bridge);
  assert(total1 === "$0.70", `the status bar adds up exactly what was reported ("${total1}")`);
  await sleep(1000);
  assert(!(await readJsonl(logA)).some((e) => e.ev === "exit"), "A's agent is still working");
  const inbox1 = await bridge.eval(`return window.__HERMES_E2E__.inboxItems();`);
  assert(inbox1.length === 0, "nothing in the inbox yet");
  await bridge.screenshot(join(evidenceDir, "03-reported-spend.png"));

  log("step 4: A reports $1.25: its agent is interrupted, its row says so, the inbox has a limit item; B goes on");
  await emitFromRust(bridge, a, { type: "usage", at: Date.now(), source: "e2e", inputTokens: 40000, outputTokens: 9000, costUsd: 1.25 });
  const exitA = await waitForFile("A's fake agent to be interrupted", async () => {
    const events = await readJsonl(logA);
    return events.find((e) => e.ev === "exit") ? events : null;
  });
  const how = exitA.find((e) => e.ev === "signal" && e.sig === "SIGINT");
  assert(!!how, `A's agent received an interrupt signal (${JSON.stringify(how ?? exitA.find((e) => e.ev === "ctrl-c") ?? null)})`);
  assert(exitA.filter((e) => e.ev === "exit").length === 1 && exitA.find((e) => e.ev === "exit").code === 130, "A's agent exited 130, once");
  const typed = exitA.filter((e) => e.ev === "input").flatMap((e) => e.hex.match(/../g) ?? []);
  assert(!exitA.some((e) => e.ev === "ctrl-c") && !typed.includes("03"), `on ${platform()} nothing was typed into A's terminal: the interrupt is a signal (input ${JSON.stringify(typed)})`);
  const capText = await bridge.waitFor("A's row to say the cap was reached", `
    const el = document.querySelector('.session-item[data-session-item-id="' + CSS.escape(${JSON.stringify(a)}) + '"] .session-cap-reached');
    return el ? e2e.norm(el.innerText) : null;
  `);
  assert(capText === "cap $1.00 reached", `A's row: "${capText}"`);
  const inbox2 = await bridge.eval(`return window.__HERMES_E2E__.inboxItems();`);
  log(`  inbox: ${JSON.stringify(inbox2)}`);
  assert(inbox2.length === 1, "one inbox item");
  assert(inbox2[0].kind === "limit" && inbox2[0].source === "cap" && inbox2[0].sessionId === a, "a limit item for A, raised by the cap");
  assert(inbox2[0].detail.includes("$1.25 of $1.00"), `it says what was spent against what cap ("${inbox2[0].detail}")`);
  await sleep(1500);
  assert(!(await readJsonl(logB)).some((e) => e.ev === "exit"), "B, under the cap, is still working");
  assert((await rowState(bridge, b)).cap === null, "B's row has no cap mark");
  await bridge.screenshot(join(evidenceDir, "04-cap-reached.png"));

  log("step 5: A reports more: the soft cap does not act twice");
  await emitFromRust(bridge, a, { type: "usage", at: Date.now(), source: "e2e", inputTokens: 60000, outputTokens: 12000, costUsd: 2 });
  await bridge.waitFor("A's row to show $2.00", `
    return e2e.norm(document.querySelector('.session-item[data-session-item-id="' + CSS.escape(${JSON.stringify(a)}) + '"] .session-spend')?.innerText ?? "") === "$2.00";
  `);
  await sleep(1000);
  const inbox3 = await bridge.eval(`return window.__HERMES_E2E__.inboxItems();`);
  assert(inbox3.length === 1, `still one inbox item (${inbox3.length})`);
  assert((await readJsonl(logA)).filter((e) => e.ev === "exit").length === 1, "A was not interrupted again");
});
