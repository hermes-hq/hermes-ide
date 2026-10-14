#!/usr/bin/env node
// Scenario ACT-every-agent-narrow: every agent gets the session action bar,
// and the bar fits its pane.
//
//   1. Claude Code, Antigravity (agy) and OpenCode sessions each show the
//      bar: Prompts, the agent's own pinned actions (Antigravity: Model and
//      Plan; OpenCode: Model; nothing it lacks, never greyed) and Commands;
//   2. three panes side by side: no bar overflows or is cut by its pane; a
//      pane of 480 px or more keeps its chips, a narrower one collapses to
//      Prompts and "/ N" (the Commands list, its pinned chips first).
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/ACT-every-agent-narrow.mjs

import { join } from "node:path";
import { platform } from "node:os";
import { runScenario } from "../n11-steps.mjs";
import { bars, resizeWindow, sleep, startActionsApp, startAgentSession, toggleSidebar } from "../actions-steps.mjs";

const SCENARIO = "ACT-every-agent-narrow";

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  log(`scenario: ${SCENARIO}   platform: ${platform()}`);
  const { fx, bridge } = await startActionsApp("act-agents", evidenceDir, log, onCleanup, apps);
  await resizeWindow(bridge, 1300, 700);

  log("step 1: every agent gets the bar");
  const agy = await startAgentSession(bridge, fx, { agentId: "antigravity", label: "agy", mode: "prompts", log });
  let [b] = (await bars(bridge)).filter((x) => x.sid === agy);
  assert(b?.bar?.prompts && b.bar.commands.includes("Commands"), `the Antigravity session has Prompts and Commands (${JSON.stringify(b)})`);
  assert(JSON.stringify(b.bar.chips) === JSON.stringify(["Model", "Plan"]), `its chips are its own: ${JSON.stringify(b.bar.chips)}`);
  await bridge.screenshot(join(evidenceDir, "01-antigravity.png"));

  const oc = await startAgentSession(bridge, fx, { agentId: "opencode", label: "opencode", mode: "prompts", log });
  [b] = (await bars(bridge)).filter((x) => x.sid === oc);
  assert(b?.bar?.prompts && b.bar.commands.includes("Commands"), `the OpenCode session has Prompts and Commands (${JSON.stringify(b)})`);
  assert(JSON.stringify(b.bar.chips) === JSON.stringify(["Model"]), `OpenCode shows only what it has: ${JSON.stringify(b.bar.chips)}`);
  await bridge.screenshot(join(evidenceDir, "02-opencode.png"));

  const claude = await startAgentSession(bridge, fx, { agentId: "claude", label: "Claude", log });
  [b] = (await bars(bridge)).filter((x) => x.sid === claude);
  assert(JSON.stringify(b?.bar?.chips) === JSON.stringify(["Model", "Plan", "Review"]), `Claude Code: ${JSON.stringify(b?.bar?.chips)}`);
  assert(b.bar.layout === "full", `a wide pane shows the chips with their labels (${b.bar.layout})`);
  await bridge.screenshot(join(evidenceDir, "03-wide-pane.png"));

  log("step 2: three panes side by side");
  await toggleSidebar(bridge);
  await bridge.eval(`window.__HERMES_E2E__.splitWith(${JSON.stringify(agy)}, "horizontal"); return true;`);
  await bridge.waitFor("two panes", `return e2e.all(".split-pane").length === 2;`);
  await bridge.eval(`window.__HERMES_E2E__.splitWith(${JSON.stringify(oc)}, "horizontal"); return true;`);
  await bridge.waitFor("three panes", `return e2e.all(".split-pane").length === 3;`);
  await sleep(1500);
  const three = await bars(bridge);
  log(`  bars: ${JSON.stringify(three.map((x) => ({ sid: x.sid, ...x.bar })))}`);
  assert(three.length === 3, "three panes");
  for (const pane of three) {
    assert(pane.bar && !pane.bar.overflow && pane.bar.cut === 0, `pane ${pane.sid} (${pane.bar?.paneWidth} px): the bar fits (${pane.bar?.layout})`);
    if (pane.bar.paneWidth < 480) assert(pane.bar.layout === "collapsed" && /^\/\s*\d+$/.test(pane.bar.commands), `a ${pane.bar.paneWidth} px pane collapses to Prompts and "/ N" ("${pane.bar.commands}")`);
    else assert(pane.bar.layout !== "collapsed", `a ${pane.bar.paneWidth} px pane keeps its chips (${pane.bar.layout})`);
  }
  const headersFit = await bridge.eval(`return e2e.all(".split-pane-label").map((h) => h.scrollWidth <= h.clientWidth + 1);`);
  log(`  pane header lines fit: ${JSON.stringify(headersFit)}`);
  await bridge.screenshot(join(evidenceDir, "04-three-panes.png"));
});
