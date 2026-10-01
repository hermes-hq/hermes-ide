#!/usr/bin/env node
// QA-status-spend-open-sessions — the status bar's spend says what it adds
// up: the sessions that are open.
//
//   1. two Claude Code agents report their cost ($1.25 and $3.00, exact)
//      through the Rust side of the session-event channel, as hooks do
//      EXPECT: "Open sessions: $4.25", tooltip "Covers open sessions only"
//   2. the $3.00 one is closed (sidebar ×, Close session)
//      EXPECT: "Open sessions: $1.25" — the drop is explained by the label
//
// Was broken: the bar showed a bare "$4.25" that silently fell to "$1.25"
// when a finished agent was closed, so it read as the day's spend.

import { join } from "node:path";
import { emitFromRust } from "../fleet-steps.mjs";
import { runScenario } from "../n11-steps.mjs";
import { sleep, startAgent, startApp } from "../qa-status-steps.mjs";

await runScenario("QA-status-spend-open-sessions", async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  const { fx, bridge } = await startApp("qa-spend", evidenceDir, log, onCleanup, apps);
  const A = await startAgent(bridge, fx, { cwd: fx.repo, label: "api: fix login" }, 1);
  const B = await startAgent(bridge, fx, { cwd: fx.otherRepo, label: "web: dark mode" }, 2);
  await sleep(2000);
  const usage = (costUsd) => ({ type: "usage", at: Date.now(), source: "hook:claude", inputTokens: 1000, outputTokens: 2000, costUsd, confidence: "exact" });
  await emitFromRust(bridge, A, usage(1.25));
  await emitFromRust(bridge, B, usage(3.0));
  const read = `const el = e2e.first(".status-bar-cost"); return el ? { text: e2e.norm(el.innerText), title: el.getAttribute("title") || "" } : null;`;
  const before = await bridge.waitFor("the total of both", `const r = (() => { ${read} })(); return r && /4\\.25/.test(r.text) ? r : null;`);
  log(`  with both open: ${JSON.stringify(before)}`);
  await bridge.screenshot(join(evidenceDir, "01-both-open.png"));
  assert(before.text === "Open sessions: $4.25", `the total says it covers the open sessions ("${before.text}")`);
  assert(before.title.split("\n")[0] === "Covers open sessions only", `the tooltip says so first ("${before.title.split("\n")[0]}")`);

  await bridge.click(`.session-item[data-session-item-id="${B}"]`);
  await bridge.clickWhenReady(`const b = document.querySelector('.session-item[data-session-item-id="${B}"] .session-item-close'); return e2e.click(e2e.must(b, "the row's close button"));`);
  await bridge.clickWhenReady(`const b = e2e.all("button").find((b) => e2e.norm(b.innerText) === "Close session"); return e2e.click(e2e.must(b, "Close session"));`, { timeoutMs: 10_000 });
  await bridge.waitFor("B closed", `return !document.querySelector('.session-item[data-session-item-id="${B}"]');`, { timeoutMs: 15_000 });
  const after = await bridge.waitFor("the total of the open one", `const r = (() => { ${read} })(); return r && /1\\.25/.test(r.text) ? r : null;`);
  log(`  after closing the $3.00 agent: ${JSON.stringify(after)}`);
  await bridge.screenshot(join(evidenceDir, "02-after-close.png"));
  assert(after.text === "Open sessions: $1.25", `the total still says it is the open sessions' ("${after.text}")`);
});
