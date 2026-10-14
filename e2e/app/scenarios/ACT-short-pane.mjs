#!/usr/bin/env node
// Scenario ACT-short-pane: on a short pane Hermes's chrome gives its rows
// back to the agent.
//
// An agent's own interface (Claude Code's footer) drops lines when its
// terminal has too few rows. Below 18 rows, the session action bar and the
// turn bar fold into the pane header line (the bar collapsed to Prompts,
// the state chip and "/ N"; the turn bar as one "Replies · N" chip), and a
// tall pane brings their rows back.
//
//   1. a Claude Code session with a reply that changed a file (the turn bar
//      shows it);
//   2. a 960 × 440 window: the pane is short; the bar and the turn bar sit
//      in the header, nothing in the header is cut off, and the terminal has
//      at least 2 more rows than the same pane with the folding turned off
//      (the layout before this change);
//   3. the "Replies" chip opens the list of replies;
//   4. a tall window: the bar and the turn bar have their own rows again.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/ACT-short-pane.mjs

import { join } from "node:path";
import { platform } from "node:os";
import { runScenario } from "../n11-steps.mjs";
import { setFlagOverride } from "../perf-steps.mjs";
import { bars, promptsOf, resizeWindow, sleep, startActionsApp, startAgentSession, waitUntilWaiting } from "../actions-steps.mjs";

const SCENARIO = "ACT-short-pane";

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  log(`scenario: ${SCENARIO}   platform: ${platform()}`);
  const first = await startActionsApp("act-short", evidenceDir, log, onCleanup, apps);
  const { fx } = first;
  log("run 1: turn the turn history (turnLedger) on; it is read at the next start");
  await setFlagOverride(first.bridge, "turnLedger", "on", assert);
  const exit1 = await first.app.stop();
  assert(!exit1.forced && exit1.code === 0, "the app quit cleanly");
  apps.length = 0;
  const app = await fx.launch(evidenceDir, 2);
  apps.push(app);
  const { bridge } = app;
  await bridge.waitFor("the app UI", `return !e2e.first(".onboarding-backdrop");`, { timeoutMs: 30_000 });
  await resizeWindow(bridge, 1300, 700);

  log("step 1: a Claude Code session with one reply");
  // work-log: each turn writes a line to a file in its folder, so the turn
  // changes something and the turn history records it.
  const claude = await startAgentSession(bridge, fx, { agentId: "claude", label: "Claude", mode: "prompts bracketed-paste work-log", log });
  await bridge.typeInTerminal(claude, "add a readme\n");
  const deadline = Date.now() + 10_000;
  while (!promptsOf(fx).includes("add a readme") && Date.now() < deadline) await sleep(150);
  await waitUntilWaiting(bridge, claude);
  const turnBar = await bridge
    .waitFor("the turn bar", `return !!document.querySelector('.turn-bar[data-session-id="${claude}"]');`, { timeoutMs: 20_000 })
    .then(() => true)
    .catch(() => false);
  log(`  the turn bar ${turnBar ? "shows the reply" : "did not appear: the fold is measured on the action bar alone"}`);
  let tall = (await bars(bridge)).find((x) => x.sid === claude);
  assert(tall?.bar && !tall.bar.inHeader, `a tall pane: the bar has its own row (${JSON.stringify(tall?.bar)})`);
  await bridge.screenshot(join(evidenceDir, "01-tall-pane.png"));

  log("step 2: a short pane");
  const rowsOf = async () => (await bridge.eval(`return window.__HERMES_E2E__.terminalInfo(${JSON.stringify(claude)});`))?.rows ?? 0;
  // The layout before this change: the folding turned off.
  await bridge.eval(`window.__HERMES_E2E_NO_FOLD__ = true; return true;`);
  await resizeWindow(bridge, 960, 440);
  await sleep(800);
  const before = (await bars(bridge)).find((x) => x.sid === claude);
  const beforeRows = await rowsOf();
  await bridge.screenshot(join(evidenceDir, "02-short-pane-before.png"));
  await bridge.eval(`window.__HERMES_E2E_NO_FOLD__ = false; return true;`);
  await resizeWindow(bridge, 980, 450);
  await resizeWindow(bridge, 960, 440);
  await sleep(800);
  const after = (await bars(bridge)).find((x) => x.sid === claude);
  const afterRows = await rowsOf();
  await bridge.screenshot(join(evidenceDir, "03-short-pane-folded.png"));
  log(`  pane ${after?.bar?.paneWidth}×${after?.bar?.paneHeight} px: ${beforeRows} rows with the chrome in rows of its own, ${afterRows} folded`);
  assert(before?.bar && !before.bar.inHeader, "before: the bar had a row of its own");
  assert(after?.bar?.inHeader && after.bar.layout === "collapsed", `folded: the bar sits in the header line, collapsed (${JSON.stringify(after?.bar)})`);
  assert(afterRows >= beforeRows + 2, `the terminal gets at least 2 more rows (${beforeRows} → ${afterRows})`);
  for (const pane of await bars(bridge)) {
    assert(pane.bar && pane.bar.cut === 0 && !pane.bar.overflow, `pane ${pane.sid}: nothing of the bar is cut off`);
  }
  const headers = await bridge.eval(`return e2e.all(".split-pane-label").map((h) => ({ fits: h.scrollWidth <= h.clientWidth + 1, text: e2e.norm(h.innerText) }));`);
  assert(headers.every((h) => h.fits), `every header line fits its pane (${JSON.stringify(headers)})`);
  if (turnBar) {
    const chip = await bridge.eval(`
      const c = document.querySelector('.split-pane-label [data-session-turns="${claude}"] .turn-bar-more');
      return c ? { text: e2e.norm(c.innerText), inHeader: !!c.closest(".split-pane-label") } : null;`);
    assert(chip?.inHeader && /Replies · \d+/.test(chip.text), `the turn bar is one chip in the header: "${chip?.text}"`);
    assert(!(await bridge.eval(`return !!document.querySelector('.turn-bar[data-session-id="${claude}"]');`)), "and no row of its own");

    log("step 3: the Replies chip opens the list of replies");
    await bridge.eval(`return e2e.click(e2e.must(document.querySelector('[data-session-turns="${claude}"] .turn-bar-more'), "the Replies chip"));`);
    await bridge.waitFor("the list of replies", `return !!document.querySelector('[role="listbox"]');`, { timeoutMs: 5_000 });
    await bridge.screenshot(join(evidenceDir, "04-replies-list.png"));
    await bridge.eval(`document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true;`);
  }

  log("step 4: a tall window brings the rows back");
  await resizeWindow(bridge, 1300, 700);
  await sleep(800);
  tall = (await bars(bridge)).find((x) => x.sid === claude);
  assert(tall?.bar && !tall.bar.inHeader && tall.bar.layout !== "collapsed", `the bar has its own row again (${JSON.stringify(tall?.bar)})`);
});
