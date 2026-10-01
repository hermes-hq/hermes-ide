#!/usr/bin/env node
// QA-status-away-tells-agents-apart — with several agents, the away message
// says which one is blocked without carrying any prompt text.
//
//   1. three fake Claude Code agents: one in launcher-repo, two in
//      other-repo; the window is not focused (the person is away)
//   2. A and B ask for permission
//      EXPECT: two messages that differ, each with "where": the repository
//      folder and the session's number in it ("launcher-repo #1",
//      "other-repo #1"), and no task name (the names came from the launcher)
//   3. Settings > General: "Include session names in away messages" on;
//      C asks
//      EXPECT: its message says "other-repo #2" and carries its name
//
// Was broken: every message read "Claude Code · needs approval".

import { join } from "node:path";
import { runScenario } from "../n11-steps.mjs";
import { block, invoke, receiver, sleep, startAgent, startApp } from "../qa-status-steps.mjs";

await runScenario("QA-status-away-tells-agents-apart", async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  const rx = await receiver();
  onCleanup(() => rx.close());
  const { fx, bridge } = await startApp("qa-away-where", evidenceDir, log, onCleanup, apps);
  await invoke(bridge, "set_setting", { key: "away_notify_url", value: rx.url });
  const A = await startAgent(bridge, fx, { cwd: fx.repo, label: "api: fix login" }, 1);
  const B = await startAgent(bridge, fx, { cwd: fx.otherRepo, label: "web: dark mode" }, 2);
  const C = await startAgent(bridge, fx, { cwd: fx.otherRepo, label: "web: i18n" }, 3);
  await sleep(2500);
  await bridge.eval(`window.__HERMES_E2E__.setWindowFocused(false); return true;`);
  await block(bridge, A);
  await block(bridge, B);
  const deadline = Date.now() + 15_000;
  while (rx.got.length < 2 && Date.now() < deadline) await sleep(250);
  const bodies = rx.got.map((g) => JSON.parse(g.body));
  log(`  away messages: ${JSON.stringify(bodies)}`);
  assert(bodies.length === 2, "two away messages arrived");
  assert(JSON.stringify(bodies[0]) !== JSON.stringify(bodies[1]), "the two messages say which agent is which");
  const where = bodies.map((b) => b.where).sort();
  assert(JSON.stringify(where) === JSON.stringify(["launcher-repo #1", "other-repo #1"]), `each names its repository folder and number (${JSON.stringify(where)})`);
  assert(bodies.every((b) => b.task === ""), "no session name without the opt-in");

  await bridge.eval(`window.__HERMES_E2E__.setWindowFocused(true); return true;`);
  await bridge.clickByName("Settings");
  await bridge.waitFor("the names switch", `return !!e2e.first('[data-setting="away_notify_names"] [role="switch"], [data-setting="away_notify_names"] input[type="checkbox"]');`);
  await bridge.screenshot(join(evidenceDir, "01-setting.png"));
  await bridge.click('[data-setting="away_notify_names"] [role="switch"], [data-setting="away_notify_names"] input[type="checkbox"]');
  await bridge.waitFor("the opt-in saved", `return (await window.__TAURI_INTERNALS__.invoke("get_settings")).away_notify_names === "on";`);
  await bridge.click(".settings-close");
  await bridge.waitFor("Settings closed", `return !e2e.first(".settings-close");`);
  await bridge.eval(`window.__HERMES_E2E__.setWindowFocused(false); return true;`);
  await block(bridge, C);
  const deadline2 = Date.now() + 15_000;
  while (rx.got.length < 3 && Date.now() < deadline2) await sleep(250);
  const third = rx.got[2] ? JSON.parse(rx.got[2].body) : null;
  log(`  with session names: ${JSON.stringify(third)}`);
  assert(third && third.where === "other-repo #2" && third.task === "web: i18n", "with the opt-in the message carries the session's name");
});
