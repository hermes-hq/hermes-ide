#!/usr/bin/env node
// QA-status-away-failure — a broken away address does not fail in silence,
// and the address can be tried before an agent needs it.
//
//   1. the away address points at a server that answers 500
//   2. the person is away (window not focused); an agent asks for permission
//      EXPECT: a Hermes notice in the inbox: "Away message could not be sent
//      (the address answered 500 …) — check Settings > General"; a second
//      failure while it is open adds no second notice
//   3. Settings > General shows under the address "Last message: failed
//      <time>: …"
//   4. the server is fixed; "Send test message" posts {agent: "Hermes",
//      task: "test", state: "test"} and the field reads "Last message: sent
//      <time> ✓"
//
// Was broken: a failed send was only written to the console.

import { join } from "node:path";
import { runScenario } from "../n11-steps.mjs";
import { block, receiver, setAwayUrl, sleep, startAgent, startApp, waitForMessages } from "../qa-status-steps.mjs";

await runScenario("QA-status-away-failure", async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  const rx = await receiver(500);
  onCleanup(() => rx.close());
  const { fx, bridge } = await startApp("qa-away-fail", evidenceDir, log, onCleanup, apps);
  await setAwayUrl(bridge, rx.url);
  const A = await startAgent(bridge, fx, { cwd: fx.repo, label: "api: fix login" }, 1);
  const B = await startAgent(bridge, fx, { cwd: fx.otherRepo, label: "web: dark mode" }, 2);
  await sleep(2500);
  await bridge.eval(`window.__HERMES_E2E__.setWindowFocused(false); return true;`);
  await block(bridge, A);
  const result = await bridge.waitFor("the send result", `return window.__HERMES_E2E__.attentionState().away.at(-1)?.result ?? null;`, { timeoutMs: 15_000 });
  log(`  send result: ${JSON.stringify(result)}; the server got ${rx.got.length}`);
  assert(result.outcome === "failed", "the send failed (the server answered 500)");
  const notices = () => bridge.eval(`return window.__HERMES_E2E__.inboxItems().filter((i) => i.sessionId === null).map((i) => i.detail);`);
  const first = await bridge.waitFor("the Hermes notice", `const n = window.__HERMES_E2E__.inboxItems().filter((i) => i.sessionId === null).map((i) => i.detail); return n.length ? n : null;`, { timeoutMs: 5_000 }).catch(() => []);
  log(`  notices: ${JSON.stringify(first)}`);
  assert(first.length === 1 && /^Away message could not be sent \(the address answered 500[^)]*\) — check Settings > General$/.test(first[0]), `the inbox says the away message was not delivered: ${JSON.stringify(first)}`);
  await block(bridge, B);
  await waitForMessages(rx, 2);
  await sleep(1500);
  const again = await notices();
  assert(again.length === 1, `a second failure adds no second notice (${again.length})`);
  await bridge.screenshot(join(evidenceDir, "01-notice.png"));

  await bridge.eval(`window.__HERMES_E2E__.setWindowFocused(true); return true;`);
  await bridge.clickByName("Settings");
  const failedLine = await bridge.waitFor("the last-message line", `const s = e2e.first(".away-notify-last"); return s ? e2e.norm(s.innerText) : null;`);
  log(`  under the field: ${failedLine}`);
  assert(/^Last message: failed \d{1,2}:\d{2}.*: the address answered 500/.test(failedLine), `the field says the last message failed and why ("${failedLine}")`);
  await bridge.screenshot(join(evidenceDir, "02-setting-failed.png"));

  rx.answerWith(200);
  const before = rx.got.length;
  await bridge.clickByName("Send test message");
  await waitForMessages(rx, before + 1);
  const test = rx.got[before] ? JSON.parse(rx.got[before].body) : null;
  log(`  test message: ${JSON.stringify(test)}`);
  assert(test && test.agent === "Hermes" && test.task === "test" && test.state === "test", "the test message is {agent: Hermes, task: test, state: test}");
  const sentLine = await bridge.waitFor("the sent line", `const s = e2e.first(".away-notify-last"); return s && /sent/.test(s.innerText) ? e2e.norm(s.innerText) : null;`);
  log(`  under the field: ${sentLine}`);
  assert(/^Last message: sent \d{1,2}:\d{2}.* ✓$/.test(sentLine), `the field says the test message was sent ("${sentLine}")`);
  await bridge.screenshot(join(evidenceDir, "03-setting-sent.png"));
});
