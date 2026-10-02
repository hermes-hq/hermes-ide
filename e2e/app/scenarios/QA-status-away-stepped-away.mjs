#!/usr/bin/env node
// QA-status-away-stepped-away — the person looks at agent A in a focused
// window and steps away; A asks for permission. Its away message goes out
// once A has waited unanswered for the chosen delay (After 2 min by
// default), or at once when the window loses the focus first.
//
//   1. the away address is set; one agent A; the window is focused on A
//   2. A asks for permission
//      EXPECT: no away message yet (a focused window: maybe someone is there)
//   3. the window loses the focus (screen locked, another app in front)
//      EXPECT: one away message for A within a few seconds
//   4. A asks again while the window is focused on A, and nobody touches
//      Hermes for 2 min 10 s
//      EXPECT: a second away message after the 2 min, none before
//
// Was broken: the session in view was recorded as "you are looking at it"
// and never queued, so no away message went out at all, whatever the delay
// and also once the window lost the focus.

import { join } from "node:path";
import { runScenario } from "../n11-steps.mjs";
import { block, receiver, setAwayUrl, sleep, startAgent, startApp, waitForMessages, writeTo } from "../qa-status-steps.mjs";

await runScenario("QA-status-away-stepped-away", async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  const rx = await receiver();
  onCleanup(() => rx.close());
  const { fx, bridge } = await startApp("qa-away-stepped", evidenceDir, log, onCleanup, apps);
  await setAwayUrl(bridge, rx.url);
  const A = await startAgent(bridge, fx, { cwd: fx.repo, label: "api: fix login" }, 1);
  await sleep(2500);
  await bridge.eval(`window.__HERMES_E2E__.setWindowFocused(true); return true;`);
  const active = await bridge.eval(`return e2e.first(".session-item-active")?.dataset.sessionItemId;`);
  assert(active === A, "the person is looking at A, window focused");

  await block(bridge, A);
  await sleep(3000);
  const state = await bridge.eval(`const s = window.__HERMES_E2E__.attentionState(); return { decisions: s.decisions.map((d) => d.decision + ":" + (d.away ? "away" : "-")), pending: s.pendingAway ?? null };`);
  log(`  blocked while focused on A: ${JSON.stringify(state)}; received ${rx.got.length}`);
  assert(rx.got.length === 0, "no away message at once while the window is focused on A");
  assert(Array.isArray(state.pending) && state.pending.some((p) => p.sessionId === A), `A's away message waits for the delay (${JSON.stringify(state.pending)})`);

  await bridge.eval(`window.__HERMES_E2E__.setWindowFocused(false); return true;`);
  await waitForMessages(rx, 1, 10_000);
  log(`  after the window lost the focus: ${JSON.stringify(rx.got.map((g) => g.body))}`);
  await bridge.screenshot(join(evidenceDir, "01-lost-focus.png"));
  assert(rx.got.length === 1, "one away message once the window loses the focus");

  // Answer A (it moves on), then it asks again with the window focused on A.
  await bridge.eval(`window.__HERMES_E2E__.setWindowFocused(true); return true;`);
  await writeTo(bridge, A, "y");
  await bridge.waitFor("A answered", `return window.__HERMES_E2E__.sessionStatus(${JSON.stringify(A)}).kind !== "needs_approval";`, { timeoutMs: 15_000 });
  await sleep(1500);
  await block(bridge, A);
  const askedAt = Date.now();
  await sleep(100_000);
  const early = rx.got.length;
  log(`  ${Math.round((Date.now() - askedAt) / 1000)} s after the second ask: received ${early}`);
  assert(early === 1, "nothing more before the 2 min");
  await waitForMessages(rx, 2, 40_000);
  const waited = Math.round((rx.got[1]?.at - askedAt) / 1000);
  log(`  second message after ${waited} s: ${JSON.stringify(rx.got.map((g) => g.body))}`);
  await bridge.screenshot(join(evidenceDir, "02-after-delay.png"));
  assert(rx.got.length === 2 && waited >= 118, `the agent still waiting after 2 min sends its away message (${rx.got.length}, after ${waited} s)`);
});
