#!/usr/bin/env node
// QA-host-pane-header-status (LEAD-05) — the pane header used to show the
// backend's raw phase ("idle", "busy", untranslated) next to the session's
// name, while the status strip right under it and the sidebar said what
// the agent reported ("needs approval"): a lead glancing at four panes read
// "idle" on an agent blocked on them. EXPECT: the header never contradicts
// the strip (it shows the same status, or none while the strip shows it).
import { join } from "node:path";
import { sleep } from "../harness.mjs";
import { runScenario } from "../n11-steps.mjs";
import { block, claude, startApp } from "../qa-host-steps.mjs";

const SCENARIO = "QA-host-pane-header-status";
await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  const { fx, bridge } = await startApp("qa-header", evidenceDir, log, onCleanup, apps);
  const id = await claude(bridge, fx, fx.repo, "api: fix login", 1);
  await sleep(2500);
  await block(bridge, id);
  await sleep(1500);
  const seen = await bridge.eval(`
    const header = e2e.first(".split-pane-header .split-pane-label");
    return {
      phaseSpan: e2e.norm(e2e.first(".split-pane-phase")?.innerText ?? ""),
      headerTag: header?.querySelector(".agent-status-tag")?.getAttribute("data-status") ?? null,
      header: e2e.norm(header?.innerText ?? ""),
      strip: e2e.first(".session-status-strip")?.getAttribute("data-status-kind") ?? null,
      sidebar: e2e.first(".session-item-active .agent-status-tag")?.getAttribute("data-status") ?? null,
    };`);
  log(`  seen: ${JSON.stringify(seen)}`);
  await bridge.screenshot(join(evidenceDir, "01-header-vs-strip.png"));
  assert(seen.sidebar === "needs_approval", "the sidebar says needs approval");
  assert(seen.phaseSpan === "" && !/\b(idle|busy|ready)\b/.test(seen.header.replace("api: fix login", "")), `the pane header shows no raw phase (it says "${seen.header}")`);
  assert(seen.headerTag === null || seen.headerTag === "needs_approval", "and nothing that contradicts the status");
  await bridge.eval(`await window.__TAURI_INTERNALS__.invoke("write_to_session", { sessionId: ${JSON.stringify(id)}, data: btoa("y") }); return true;`);
});
