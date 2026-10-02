#!/usr/bin/env node
// QA-git (LEAD-06): closing the session in front shows the session that
// becomes active, never the empty welcome page while the title bar and the
// sidebar name another session.
//
// Three plain terminals A, B, C in the one pane; B is in front and is closed
// (×, then "Close session"). The pane now shows the session the sidebar marks
// active, and there is no "Begin a session" page.
//
// Negative control: a build from before the fix ends in RESULT: FAIL.

import { join } from "node:path";
import { L, endScenario, gitFixtures, scenarioContext, sleep } from "../qa-git-steps.mjs";

const SCENARIO = "QA-git-close-active-pane";
const ctx = scenarioContext(SCENARIO);
const { evidenceDir, log, check } = ctx;
const fx = gitFixtures("closeactive", log);

let app;
let error;
try {
  app = await fx.launchFx(evidenceDir, 1, { flagDefaults: null });
  const { bridge } = app;
  await L.completeClassicOnboarding(bridge);
  const ids = [];
  for (const label of ["A shell", "B shell", "C shell"]) {
    ids.push(await bridge.eval(`return await window.__HERMES_E2E__.newTerminal(${JSON.stringify({ label, cwd: fx.repo })});`, { timeoutMs: 30_000 }));
  }
  await sleep(1500);
  const B = ids[1];
  await bridge.click(`.session-item[data-session-item-id="${B}"]`);
  await bridge.waitFor("B in front", `return e2e.first(".split-pane-label > span")?.textContent === "B shell";`);
  await bridge.clickWhenReady(`const row = document.querySelector('.session-item[data-session-item-id="${B}"]'); const b = [...row.querySelectorAll("button")].find((b) => /close/i.test((b.getAttribute("aria-label") || "") + b.className + (b.title || ""))); return e2e.click(e2e.must(b, "the row's close button"));`);
  // The dialog comes after the close checks (the session's projects, its
  // worktree): wait for it rather than look once.
  const asked = await bridge
    .waitFor("the close confirmation", `return !!e2e.first(".close-dialog .close-dialog-btn-confirm") || !document.querySelector('.session-item[data-session-item-id="${B}"]');`, { timeoutMs: 10_000 })
    .then(() => bridge.eval(`const b = e2e.first(".close-dialog .close-dialog-btn-confirm"); return b ? e2e.click(b) : false;`))
    .catch(() => false);
  if (!asked) log("  (no confirmation asked)");
  await bridge.waitFor("B gone", `return !document.querySelector('.session-item[data-session-item-id="${B}"]');`, { timeoutMs: 15_000 });
  await sleep(1500);
  const seen = await bridge.eval(`return {
    activeRow: e2e.norm(e2e.first(".session-item-active")?.innerText ?? "").slice(0, 20),
    panes: e2e.all(".split-pane-label > span:first-child").map((s) => s.textContent),
    welcome: !!e2e.all("*").find((el) => el.children.length === 0 && /Begin a session/i.test(el.textContent) && e2e.visible(el)),
  };`);
  log(`  after closing B: ${JSON.stringify(seen)}`);
  await bridge.screenshot(join(evidenceDir, "01-after-close.png"));
  check(seen.activeRow !== "", "the sidebar still has an active session");
  check(seen.panes.length > 0 && !seen.welcome, `the active session is on screen (panes: ${JSON.stringify(seen.panes)})`);
  check(seen.panes.some((p) => seen.activeRow.startsWith(p.slice(0, 5))), "the pane shows the session the sidebar marks active");
} catch (e) {
  error = e;
}
await endScenario({ ctx, app, error, scenario: SCENARIO, cleanup: () => fx.cleanup() });
