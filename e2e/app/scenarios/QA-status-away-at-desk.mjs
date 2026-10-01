#!/usr/bin/env node
// QA-status-away-at-desk — away messages go out when Hermes is not in front
// of you, not while you sit in it working in another session.
//
//   1. the away address is typed into Settings > General; the window has the
//      keyboard focus and the person looks at session B; agent A asks for
//      permission
//      EXPECT: no away message (the badge and the OS notification reach them)
//   2. the window loses the focus while A still waits
//      EXPECT: one away message for A within a few seconds
//   3. Settings > General: the copy says when Hermes sends, and "Send after"
//      offers Immediately / After 2 min / After 10 min, After 2 min by
//      default; Immediately is chosen
//   4. agent C asks while the window is focused on B
//      EXPECT: one away message for C at once
//
// (After 2 min unanswered while focused is covered by the notifier's unit
// tests: a real-app run would have to wait two minutes.)
//
// Was broken: every Blocked on you item that was not the focused session's
// sent the away message at once, also while the person was at Hermes.

import { join } from "node:path";
import { chooseOption } from "../launcher-steps.mjs";
import { runScenario } from "../n11-steps.mjs";
import { block, receiver, setAwayUrl, sleep, startAgent, startApp, waitForMessages } from "../qa-status-steps.mjs";

await runScenario("QA-status-away-at-desk", async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  const rx = await receiver();
  onCleanup(() => rx.close());
  const { fx, bridge } = await startApp("qa-away-desk", evidenceDir, log, onCleanup, apps);
  await setAwayUrl(bridge, rx.url);

  const A = await startAgent(bridge, fx, { cwd: fx.repo, label: "api: fix login" }, 1);
  const C = await startAgent(bridge, fx, { cwd: fx.repo, label: "api: docs" }, 2);
  const B = await startAgent(bridge, fx, { cwd: fx.otherRepo, label: "web: dark mode" }, 3);
  await sleep(2500);
  await bridge.eval(`window.__HERMES_E2E__.setWindowFocused(true); return true;`);
  const active = await bridge.eval(`return e2e.first(".session-item-active")?.dataset.sessionItemId;`);
  assert(active === B, "the person is looking at B, window focused");

  await block(bridge, A);
  await sleep(3000);
  const decisions = await bridge.eval(`return window.__HERMES_E2E__.attentionState().decisions.map((d) => d.decision + ":" + (d.away ? "away" : "-"));`);
  log(`  decisions: ${JSON.stringify(decisions)}; received ${rx.got.length}`);
  await bridge.screenshot(join(evidenceDir, "01-blocked-while-present.png"));
  assert(rx.got.length === 0, "no away message while the person is at Hermes");

  await bridge.eval(`window.__HERMES_E2E__.setWindowFocused(false); return true;`);
  await waitForMessages(rx, 1, 10_000);
  log(`  after the window lost the focus: ${JSON.stringify(rx.got.map((g) => g.body))}`);
  assert(rx.got.length === 1, "one away message once Hermes is no longer in front of the person");

  await bridge.eval(`window.__HERMES_E2E__.setWindowFocused(true); return true;`);
  await bridge.clickByName("Settings");
  const setting = await bridge.waitFor("the away setting", `
    const g = e2e.first('[data-setting="away_notify_url"]');
    const d = e2e.first("#away-notify-delay");
    if (!g || !d) return null;
    return { hint: e2e.norm(g.innerText), delay: d.getAttribute("data-value"), shown: e2e.norm(d.innerText) };`);
  log(`  setting: ${JSON.stringify(setting)}`);
  await bridge.screenshot(join(evidenceDir, "02-setting.png"));
  assert(setting.hint.includes("When an agent is blocked on you and Hermes is not in front of you, Hermes sends one message to this address"), "the copy says the message goes out when Hermes is not in front of you");
  assert(setting.delay === "120" && setting.shown === "After 2 min", `"Send after" is After 2 min by default (${setting.shown})`);
  await bridge.click("#away-notify-delay");
  const choices = await bridge.waitFor("the delay choices", `
    const d = e2e.first("#away-notify-delay"); const list = document.getElementById(d.getAttribute("aria-controls"));
    return list ? [...list.querySelectorAll('[role="option"]')].map((o) => e2e.norm(o.innerText)) : null;`);
  assert(JSON.stringify(choices) === JSON.stringify(["Immediately", "After 2 min", "After 10 min"]), `the choices are Immediately / After 2 min / After 10 min (${JSON.stringify(choices)})`);
  await chooseOption(bridge, "#away-notify-delay", "0");
  await bridge.waitFor("Immediately saved", `return (await window.__TAURI_INTERNALS__.invoke("get_settings")).away_notify_delay === "0";`);
  await bridge.click(".settings-close");
  await bridge.waitFor("Settings closed", `return !e2e.first(".settings-close");`);

  await block(bridge, C);
  await waitForMessages(rx, 2, 8_000);
  log(`  with Immediately: ${JSON.stringify(rx.got.map((g) => g.body))}`);
  assert(rx.got.length === 2, "with Immediately the message goes out at once, also while Hermes is in front");
});
