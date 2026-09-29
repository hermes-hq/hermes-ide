#!/usr/bin/env node
// Scenario F14: the context gauge reads the agent's own transcript.
//
// A fake `claude` (tools/fake-agents/fake-cli.mjs) is started by Hermes
// through `hi run` (the launchHelper flag). Its SessionStart hook reports the
// transcript file it writes, exactly like Claude Code; keys typed into it
// append a model call (`c`, with the usage the scenario chose) or a
// compaction (`k`) to that file. On the real app:
//
//   1. a plain shell session shows no gauge (nothing reported, no guess);
//   2. the Claude session shows none either until its first model call;
//   3. after a call with 3 + 12,000 + 71,000 input tokens the row shows 42 %
//      (83,003 / 200,000 = 41.5 %, within one point), with the exact numbers
//      in its tooltip; a sub-agent's call (a sidechain record) moves nothing;
//      182,000 tokens shows 91 % and the warning colour;
//   4. a compaction in the transcript reaches the session (counted), and the
//      next, smaller call brings the gauge down to 10 %;
//   5. the optional Agent view draws a "Context compacted" divider where a
//      compact_boundary event arrived (none before it).
//
// Negative controls (each must end in RESULT: FAIL):
//   HERMES_E2E_F14_NEGATIVE=sidechain   step 3's call is written as a
//          sub-agent's: the gauge never appears.
//   HERMES_E2E_F14_NEGATIVE=no-compact  the Agent view's second turn does
//          not compact: no divider appears.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F14-context-gauge.mjs

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, launchApp, sleep } from "../harness.mjs";
import { completeOnboarding, createAgentSession, createPlainTerminal, dismissWhatsNew, runScenario } from "../n11-steps.mjs";
import { createClaudeTerminal, fakeClaudeOnPath, sessionRow, setFlagOverride } from "../perf-steps.mjs";

const SCENARIO = "F14-context-gauge";
const NEGATIVE = process.env.HERMES_E2E_F14_NEGATIVE || "";
const onWindows = platform() === "win32";
const CONTEXT_WINDOW = 200_000;

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  log(`scenario: ${SCENARIO}   platform: ${platform()}${NEGATIVE ? `   NEGATIVE CONTROL: ${NEGATIVE}` : ""}`);
  const work = mkdtempSync(join(tmpdir(), "hermes-e2e-f14-"));
  onCleanup(() => rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const recordDir = join(work, "records");
  const privateHome = join(work, "home");
  mkdirSync(recordDir, { recursive: true });
  mkdirSync(privateHome, { recursive: true });

  const fake = fakeClaudeOnPath(work, log);
  onCleanup(fake.undo);
  if (!fake.usable) {
    log("this scenario needs the fake claude on a Windows terminal's PATH, which means the user's registry Path; that is only changed on a CI runner");
    log("RESULT: SKIP (Windows outside CI)");
    process.exit(0);
  }

  // The Agent view's fake bridge (e2e/app/fixtures/fake-claude-bridge.mjs).
  const bridgeCopy = join(work, "fake-claude-bridge.mjs");
  copyFileSync(join(REPO_ROOT, "e2e", "app", "fixtures", "fake-claude-bridge.mjs"), bridgeCopy);
  const planFile = join(work, "plan.json");
  const setPlan = (mode) => {
    writeFileSync(planFile, JSON.stringify({ mode }));
    log(`  (fake bridge plan: ${mode})`);
  };
  setPlan("ok");

  const env = { HERMES_FAKE_DIR: recordDir, HERMES_BRIDGE_PATH: bridgeCopy, HERMES_FAKE_BRIDGE_PLAN: planFile };
  const launch = (run, first) => {
    const common = { runDir: join(evidenceDir, `run-${run}`), log, env };
    return onWindows
      ? launchApp({ ...common, home: "real", resetData: first })
      : launchApp({ ...common, home: "private", homeDir: privateHome });
  };

  // ── run 1: turn on the launch helper (agents report through hi) ─────
  log("run 1: fresh install; turn the launchHelper flag on");
  let app = await launch(1, true);
  apps.push(app);
  await completeOnboarding(app.bridge, log);
  await setFlagOverride(app.bridge, "launchHelper", "on", assert);
  const exit1 = await app.stop();
  assert(!exit1.forced && exit1.code === 0, "the app quit cleanly");

  // ── run 2 ───────────────────────────────────────────────────────────
  log("run 2: relaunch with the flag on");
  app = await launch(2, false);
  apps.push(app);
  const { bridge } = app;
  await bridge.waitFor("the app UI (no onboarding this time)", `return !e2e.first(".onboarding-backdrop");`);
  await dismissWhatsNew(bridge, log);

  log("step 1: a plain shell session shows no gauge");
  const shell = await createPlainTerminal(bridge, log);

  log("step 2: a Claude session shows no gauge until its first model call");
  const claude = await createClaudeTerminal(bridge, log);
  await bridge.waitForTerminal(claude, /fake-cli: ready/, { timeoutMs: 30_000 });
  await sleep(1500); // let the SessionStart signal and the transcript watch settle
  let row = await sessionRow(bridge, claude);
  assert(row && row.gauge === null, `the Claude row has no gauge before any model call ("${row?.text}")`);
  const shellRow = await sessionRow(bridge, shell);
  assert(shellRow && shellRow.gauge === null, "the plain shell row has no gauge");

  const call = async (usage, what) => {
    writeFileSync(join(recordDir, "usage-next.json"), JSON.stringify({ model: "claude-fake-1", output_tokens: 700, ...usage }));
    await bridge.typeInTerminal(claude, "c");
    await bridge.waitForTerminal(claude, new RegExp(`model call \\(${usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens} input tokens\\)`), { timeoutMs: 10_000 });
    log(`  the agent made a model call: ${what}`);
  };
  const waitForGauge = (percent) =>
    bridge.waitFor(`the gauge to show ${percent}%`, `
      const g = document.querySelector('[data-session-item-id="${claude}"] .session-context-gauge');
      return g && Number(g.dataset.percent) === ${percent} ? { text: e2e.norm(g.innerText), level: g.dataset.level, title: g.title } : null;
    `, { timeoutMs: 10_000 });

  log("step 3: a model call with 3 + 12,000 + 71,000 input tokens");
  await call(
    { input_tokens: 3, cache_creation_input_tokens: 12_000, cache_read_input_tokens: 71_000, isSidechain: NEGATIVE === "sidechain" },
    NEGATIVE === "sidechain" ? "83,003 tokens, written as a sub-agent's (negative control)" : "83,003 tokens",
  );
  const used = 83_003;
  const exact = (used / CONTEXT_WINDOW) * 100;
  const g1 = await waitForGauge(Math.round(exact));
  assert(Math.abs(Math.round(exact) - exact) <= 1, `the gauge shows ${Math.round(exact)}% for ${exact.toFixed(2)}% (within one point)`);
  assert(g1.text === `${Math.round(exact)}% context`, `the row reads "${g1.text}"`);
  assert(g1.title.includes((83003).toLocaleString("en-US")) || g1.title.includes("83003") || /83.003/.test(g1.title), `the tooltip has the exact numbers: "${g1.title}"`);
  const snap1 = await bridge.eval(`return window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(claude)});`);
  assert(snap1.context.usedTokens === used && snap1.context.contextLimit === CONTEXT_WINDOW && snap1.context.model === "claude-fake-1", "the session's store holds the reported usage");
  const usageEvent = snap1.events.find((e) => e.type === "context");
  assert(usageEvent?.source === "transcript:claude", `it came from the agent's transcript (source "${usageEvent?.source}")`);
  await bridge.screenshot(join(evidenceDir, "01-gauge-42.png"));

  log("  a sub-agent's call (sidechain) does not move the gauge");
  await call({ input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 190_000, isSidechain: true }, "190,005 tokens in a sub-agent");
  await sleep(2000);
  row = await sessionRow(bridge, claude);
  assert(row.gauge?.percent === 42, `still 42% (got ${row.gauge?.percent})`);

  log("  182,000 tokens: 91% in the warning colour");
  await call({ input_tokens: 2_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 180_000 }, "182,000 tokens");
  const g2 = await waitForGauge(91);
  assert(g2.level === "warn", `the gauge warns at 91% (level ${g2.level})`);
  await bridge.screenshot(join(evidenceDir, "02-gauge-91-warn.png"));

  log("step 4: the agent compacts; the next call is smaller");
  await bridge.typeInTerminal(claude, "k");
  await bridge.waitForTerminal(claude, /fake-cli: context compacted/, { timeoutMs: 10_000 });
  const compacted = await bridge.waitFor("the compaction to reach the session", `
    const s = window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(claude)});
    return s.compactions >= 1 ? s.events.filter((e) => e.type === "compacted") : null;
  `, { timeoutMs: 10_000 });
  assert(compacted.length === 1 && compacted[0].trigger === "manual" && compacted[0].preTokens === 150000, "one compaction, manual, from 150,000 tokens");
  await call({ input_tokens: 20_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, "20,000 tokens after the compaction");
  const g3 = await waitForGauge(10);
  assert(g3.level === "ok", "the gauge is back to normal at 10%");

  const shellAfter = await sessionRow(bridge, shell);
  assert(shellAfter.gauge === null, "the plain shell row still has no gauge");
  const shellSnap = await bridge.eval(`return window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(shell)});`);
  assert(shellSnap.context === null, "and nothing was reported for it");

  // ── step 5: the Agent view's divider ─────────────────────────────────
  log("step 5: the Agent view draws a divider where the context was compacted");
  setPlan("ok");
  await createAgentSession(bridge, log);
  const view = await bridge.waitFor("the Agent view", `
    const v = e2e.first(".agent-session-view");
    return v ? v.dataset.sessionId : null;
  `, { timeoutMs: 20_000 });
  const send = async (text) => {
    await bridge.clickWhenReady(`
      const ta = e2e.must(e2e.first(".session-composer-input"), "the composer");
      ta.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    `);
    await bridge.waitFor("the composer to hold the message", `return e2e.first(".session-composer-input")?.value === ${JSON.stringify(text)};`);
    await bridge.click(".session-composer-send-btn");
    await bridge.waitFor(`the reply to "${text}"`, `
      const v = document.querySelector('.agent-session-view[data-session-id="${view}"]');
      // textContent, not innerText: messages below the fold skip rendering
      // (content-visibility: auto), and WebKit leaves their text out of
      // innerText, so a reply that arrived off screen would read as missing.
      return !!v && v.textContent.includes(${JSON.stringify(`fake reply: ${text}`)});
    `, { timeoutMs: 20_000 });
    log(`  sent "${text}" and got its reply`);
  };
  const dividers = () => bridge.eval(`
    const v = document.querySelector('.agent-session-view[data-session-id="${view}"]');
    return [...v.querySelectorAll(".agent-compaction-divider")].map((d) => ({ text: e2e.norm(d.innerText), trigger: d.dataset.trigger }));
  `);
  await send("hello before compacting");
  assert((await dividers()).length === 0, "no divider before any compaction");
  setPlan(NEGATIVE === "no-compact" ? "ok" : "compact");
  await send("please compact");
  const found = await bridge.waitFor("the compaction divider", `
    const v = document.querySelector('.agent-session-view[data-session-id="${view}"]');
    const d = v.querySelector(".agent-compaction-divider");
    if (!d) return null;
    const text = v.querySelector(".agent-session-messages").textContent;
    return {
      text: e2e.norm(d.innerText),
      trigger: d.dataset.trigger,
      visible: e2e.visible(d),
      order: [text.indexOf("please compact"), text.indexOf("CONTEXT COMPACTED") >= 0 ? text.indexOf("CONTEXT COMPACTED") : text.indexOf("Context compacted"), text.indexOf("fake reply: please compact")],
    };
  `, { timeoutMs: 10_000 });
  assert(/context compacted/i.test(found.text) && found.visible, `a visible divider reads "${found.text}"`);
  assert(found.trigger === "manual", "it carries the trigger the agent reported");
  assert(found.order[0] < found.order[1] && found.order[1] < found.order[2], `it sits between the message and the reply (${JSON.stringify(found.order)})`);
  assert((await dividers()).length === 1, "exactly one divider");
  await bridge.screenshot(join(evidenceDir, "03-agent-view-divider.png"));
});
