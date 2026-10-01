#!/usr/bin/env node
// QA-status-cmd-i-nothing-waiting — ⌘I with no agent waiting says so on
// screen, where "2 of 3 waiting" would appear, for a few seconds.
//
//   1. two agents running, none blocked
//   2. ⌘I (Ctrl+Shift+I on Windows and Linux)
//   EXPECT: the note "Nothing is waiting on you" is visible, the active
//   session does not change, and the note goes after about 3 s
//
// Was broken: only the screen-reader live region heard it; a sighted person
// saw nothing happen and took the shortcut for broken.

import { join } from "node:path";
import { runScenario } from "../n11-steps.mjs";
import { pressNextWaiting, sleep, startAgent, startApp } from "../qa-status-steps.mjs";

await runScenario("QA-status-cmd-i-nothing-waiting", async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  const { fx, bridge } = await startApp("qa-cmdi", evidenceDir, log, onCleanup, apps);
  await startAgent(bridge, fx, { cwd: fx.repo, label: "api: fix login" }, 1);
  const B = await startAgent(bridge, fx, { cwd: fx.otherRepo, label: "web: dark mode" }, 2);
  await sleep(2500);
  await pressNextWaiting(bridge);
  const seen = await bridge.waitFor("the note", `
    const n = e2e.first(".attention-position");
    if (!n) return null;
    const r = n.getBoundingClientRect(); const cs = getComputedStyle(n);
    return { text: e2e.norm(n.innerText), visible: r.width > 2 && r.height > 2 && cs.visibility !== "hidden" && Number(cs.opacity) > 0.5, inWindow: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight };`, { timeoutMs: 3_000 }).catch(() => null);
  const active = await bridge.eval(`return e2e.first(".session-item-active")?.dataset.sessionItemId;`);
  log(`  after ⌘I: ${JSON.stringify(seen)}; active ${active === B ? "still B" : active}`);
  await bridge.screenshot(join(evidenceDir, "01-cmd-i-nothing.png"));
  assert(seen && seen.text === "Nothing is waiting on you", `the note says nothing is waiting (${JSON.stringify(seen)})`);
  assert(seen.visible && seen.inWindow, "a sighted person sees it");
  assert(active === B, "the session in view does not change");
  await sleep(3800);
  const gone = await bridge.eval(`return !e2e.first(".attention-position");`);
  assert(gone, "the note goes after about 3 s");
});
