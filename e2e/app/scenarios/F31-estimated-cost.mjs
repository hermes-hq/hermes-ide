#!/usr/bin/env node
// Scenario F31 (regression audit item 5): cost and token totals from the
// agent's own transcript, estimated at list prices and marked as such — the
// same number in the session row, the project header, the status bar and the
// Context panel. On the REAL app with the fake `claude`
// (tools/fake-agents/fake-cli.mjs) started through `hi run`: its SessionStart
// hook names the transcript it writes, exactly like Claude Code, and each `c`
// typed into it appends one model call with the usage the scenario chose.
//
//   1. before any model call the Claude row, the project header and the
//      status bar say "n/a" (nothing known), never an amount;
//   2. after two calls on a priced model the project header, the status
//      bar and the Context panel all say "≈$1.04 (estimated)" (the narrow
//      row "≈$1.04", its tooltip says it is estimated), the
//      store holds the transcript's token totals, tagged estimated, from
//      source transcript:claude;
//   3. a third call on a model Hermes has no list price for (as after a
//      /model switch): the tokens keep rising and the row, the project
//      header, the status bar and the Context panel all go back to "n/a" —
//      never the frozen earlier estimate;
//   4. a plain shell session shows no spend at all.
//
// Negative control: HERMES_E2E_F31E_NEGATIVE=unpriced writes the calls on a
// model Hermes has no list price for; the cost stays "n/a" and the scenario
// must end in RESULT: FAIL. (Step 3 failed against the store that kept the
// previous estimate when a later one had no price.)
//
// Windows: the fake `claude` has to be on the user's registry Path, which is
// only changed on a CI runner; elsewhere the scenario reports RESULT: SKIP.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F31-estimated-cost.mjs

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp, sleep, skipScenario } from "../harness.mjs";
import { completeOnboarding, createPlainTerminal, runScenario } from "../n11-steps.mjs";
import { createClaudeTerminal, fakeClaudeOnPath } from "../perf-steps.mjs";
import { invoke, menuAction, rowState } from "../fleet-steps.mjs";

const SCENARIO = "F31-estimated-cost";
const NEGATIVE = process.env.HERMES_E2E_F31E_NEGATIVE || "";
const onWindows = platform() === "win32";
// A synthetic transcript on a priced model (list price per million tokens:
// $3 in, $15 out, $3.75 cache write, $0.30 cache read), or, for the
// negative control, on a model Hermes has no price for.
const MODEL = NEGATIVE === "unpriced" ? "claude-fake-1" : "claude-sonnet-4-6";
const CALLS = [
  { input_tokens: 3, cache_creation_input_tokens: 12_000, cache_read_input_tokens: 71_000, output_tokens: 700 },
  { input_tokens: 2_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 180_000, output_tokens: 60_000 },
];
const PRICE = { input: 3, output: 15, write: 3.75, read: 0.3 };
const expectedCost = CALLS.reduce(
  (sum, c) =>
    sum +
    (c.input_tokens * PRICE.input + c.output_tokens * PRICE.output + c.cache_creation_input_tokens * PRICE.write + c.cache_read_input_tokens * PRICE.read) / 1e6,
  0,
);
const expectedIn = CALLS.reduce((n, c) => n + c.input_tokens + c.cache_creation_input_tokens + c.cache_read_input_tokens, 0);
const expectedOut = CALLS.reduce((n, c) => n + c.output_tokens, 0);
const EXPECTED_TEXT = `≈$${expectedCost.toFixed(2)} (estimated)`;
// The session row is narrow: the estimate there is the amount with its ≈ (its
// tooltip says it is estimated).
const ROW_TEXT = `≈$${expectedCost.toFixed(2)}`;
const PROJECT = "Costs";

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   model: ${MODEL}${NEGATIVE ? `   NEGATIVE CONTROL: ${NEGATIVE}` : ""}`);
  log(`  expected: ${expectedIn} tokens in, ${expectedOut} out, ${EXPECTED_TEXT} (${expectedCost})`);
  const work = mkdtempSync(join(tmpdir(), "hermes-e2e-f31e-"));
  onCleanup(() => rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }));
  const recordDir = join(work, "records");
  const privateHome = join(work, "home");
  mkdirSync(recordDir, { recursive: true });
  mkdirSync(privateHome, { recursive: true });

  const fake = fakeClaudeOnPath(work, log);
  onCleanup(fake.undo);
  if (!fake.usable) {
    log("this scenario needs the fake claude on a Windows terminal's PATH, which means the user's registry Path; that is only changed on a CI runner");
    skipScenario({ scenario: SCENARIO, evidenceDir, reason: "Windows outside CI", log });
  }

  const env = { HERMES_FAKE_DIR: recordDir };
  const app = await (onWindows
    ? launchApp({ runDir: join(evidenceDir, "run-1"), log, env, home: "real", resetData: true })
    : launchApp({ runDir: join(evidenceDir, "run-1"), log, env, home: "private", homeDir: privateHome }));
  apps.push(app);
  const { bridge } = app;
  await completeOnboarding(bridge, log);

  log("a plain shell, then a Claude session in a terminal (through hi run), in a project");
  const shell = await createPlainTerminal(bridge, log);
  const claude = await createClaudeTerminal(bridge, log);
  await bridge.waitForTerminal(claude, /fake-cli: ready/, { timeoutMs: 30_000 });
  await invoke(bridge, "update_session_group", { sessionId: claude, group: PROJECT });
  await bridge.waitFor(`the "${PROJECT}" project header`, `
    return e2e.all(".project-section").some((s) => s.querySelector('[data-session-item-id="${claude}"]'));
  `, { timeoutMs: 10_000 });
  await sleep(1500); // the SessionStart signal and the transcript watch settle

  const headerCost = () => bridge.eval(`
    const section = e2e.all(".project-section").find((s) => s.querySelector('[data-session-item-id="${claude}"]'));
    const c = section?.querySelector(".project-header-cost");
    return c ? { text: e2e.norm(c.innerText), kind: c.dataset.spend } : null;
  `);
  const statusCost = () => bridge.eval(`
    const c = e2e.first(".status-bar-cost");
    // The amount; the bar labels it "Open sessions:" (QA-status-spend-open-sessions).
    return c ? { text: e2e.norm(c.querySelector(".status-bar-cost-amount").innerText), kind: c.dataset.spend } : null;
  `);

  // ── 1. Nothing known yet ───────────────────────────────────────────
  log("step 1: before any model call: n/a in the row, the project header and the status bar");
  const before = await rowState(bridge, claude);
  assert(before?.spend?.kind === "na" && before.spend.text === "n/a", `the Claude row says "${before?.spend?.text}"`);
  const deadline1 = Date.now() + 10_000;
  let headerBefore = await headerCost();
  let statusBefore = await statusCost();
  while (Date.now() < deadline1 && !(headerBefore?.text === "n/a" && statusBefore?.text === "n/a")) {
    await sleep(200);
    [headerBefore, statusBefore] = [await headerCost(), await statusCost()];
  }
  assert(headerBefore?.text === "n/a" && headerBefore.kind === "na", `the project header says n/a, no amount (${JSON.stringify(headerBefore)})`);
  assert(statusBefore?.text === "n/a" && statusBefore.kind === "na", `the status bar says n/a, no amount (${JSON.stringify(statusBefore)})`);

  // ── 2. Two model calls in the transcript ───────────────────────────
  log("step 2: the agent makes two model calls");
  for (const [i, c] of CALLS.entries()) {
    writeFileSync(join(recordDir, "usage-next.json"), JSON.stringify({ model: MODEL, ...c }));
    await bridge.typeInTerminal(claude, "c");
    const input = c.input_tokens + c.cache_creation_input_tokens + c.cache_read_input_tokens;
    await bridge.waitForTerminal(claude, new RegExp(`model call \\(${input} input tokens\\)`), { timeoutMs: 10_000 });
    log(`  call ${i + 1}: ${input} tokens in, ${c.output_tokens} out`);
  }
  const row = await bridge.waitFor(`the row to say ${ROW_TEXT}`, `
    const s = document.querySelector('.session-item[data-session-item-id="${claude}"] .session-spend');
    return s && e2e.norm(s.innerText) === ${JSON.stringify(ROW_TEXT)} ? { text: e2e.norm(s.innerText), kind: s.dataset.spend, title: s.title } : null;
  `, { timeoutMs: 15_000 });
  assert(row.kind === "estimated", `the row marks it estimated (${row.kind})`);
  // The webview's locale decides the digit grouping ("265,003", "265003", "265 003").
  const digits = row.title.replace(/(\d)[\s,.  ](?=\d{3}\b)/g, "$1");
  assert(/estimated/i.test(row.title) && digits.includes(String(expectedIn)), `its tooltip says why and has the tokens: ${JSON.stringify(row.title)}`);

  const snap = await bridge.eval(`return window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(claude)});`);
  log(`  store: ${JSON.stringify(snap.usage)}`);
  assert(snap.usage.confidence === "estimated", "the store holds an estimate");
  assert(snap.usage.inputTokens === expectedIn && snap.usage.outputTokens === expectedOut, `the token totals are the transcript's (${snap.usage.inputTokens} in, ${snap.usage.outputTokens} out)`);
  assert(Math.abs(snap.usage.costUsd - expectedCost) < 1e-6, `the cost is the list-price estimate (${snap.usage.costUsd})`);
  const usageEvent = [...snap.events].reverse().find((e) => e.type === "usage");
  assert(usageEvent?.source === "transcript:claude" && usageEvent.confidence === "estimated", `it came from the agent's transcript (${usageEvent?.source}, ${usageEvent?.confidence})`);

  const header = await headerCost();
  assert(header?.text === EXPECTED_TEXT && header.kind === "estimated", `the "${PROJECT}" header says ${JSON.stringify(header)}`);
  const status = await statusCost();
  assert(status?.text === EXPECTED_TEXT && status.kind === "estimated", `the status bar says ${JSON.stringify(status)}`);

  // The Context panel of the Claude session: the same numbers.
  await bridge.clickWhenReady(`return e2e.click(e2e.must(document.querySelector('.session-item[data-session-item-id="${claude}"]'), "the Claude row"));`);
  await sleep(300);
  if (!(await bridge.exists(".context-panel-body"))) await menuAction(bridge, "view.context-panel");
  const ctx = await bridge.waitFor("the Context panel's tokens", `
    const s = e2e.first(".ctx-usage");
    if (!s) return null;
    const c = s.querySelector(".ctx-cost");
    return { text: e2e.norm(c.innerText), kind: c.dataset.spend, input: Number(s.querySelector(".ctx-token-in").dataset.tokens), output: Number(s.querySelector(".ctx-token-out").dataset.tokens) };
  `, { timeoutMs: 10_000 });
  log(`  Context panel: ${JSON.stringify(ctx)}`);
  assert(ctx.text === EXPECTED_TEXT && ctx.kind === "estimated", "the Context panel shows the same estimate");
  assert(ctx.input === expectedIn && ctx.output === expectedOut, "and the same token totals");
  await bridge.screenshot(join(evidenceDir, "01-estimated-everywhere.png"));

  // ── 3. A call on a model without a list price: n/a, not the old figure ─
  log("step 3: a call on a model Hermes has no price for (a /model switch)");
  const UNPRICED = { model: "claude-fake-1", input_tokens: 5_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50 };
  writeFileSync(join(recordDir, "usage-next.json"), JSON.stringify(UNPRICED));
  await bridge.typeInTerminal(claude, "c");
  await bridge.waitForTerminal(claude, new RegExp(`model call \\(${UNPRICED.input_tokens} input tokens\\)`), { timeoutMs: 10_000 });
  const risenIn = expectedIn + UNPRICED.input_tokens;
  const unpricedSnap = await bridge.waitFor("the store to take the new total", `
    const u = window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(claude)}).usage;
    return u && u.inputTokens === ${risenIn} ? u : null;
  `, { timeoutMs: 15_000 });
  log(`  store: ${JSON.stringify(unpricedSnap)}`);
  assert(unpricedSnap.costUsd === null && unpricedSnap.confidence === "estimated", `the cost is unknown now, not the earlier estimate (${unpricedSnap.costUsd})`);
  const naRow = await bridge.waitFor("the row to say n/a", `
    const s = document.querySelector('.session-item[data-session-item-id="${claude}"] .session-spend');
    return s ? { text: e2e.norm(s.innerText), kind: s.dataset.spend } : null;
  `, { timeoutMs: 10_000 });
  assert(naRow.kind === "na" && naRow.text === "n/a", `the row says ${JSON.stringify(naRow)}`);
  const naHeader = await headerCost();
  assert(naHeader === null || !/estimated/.test(naHeader.text), `the project header no longer shows an estimate (${JSON.stringify(naHeader)})`);
  const naStatus = await statusCost();
  assert(naStatus === null || !/estimated/.test(naStatus.text), `the status bar no longer shows an estimate (${JSON.stringify(naStatus)})`);
  const naCtx = await bridge.waitFor("the Context panel's tokens to rise", `
    const s = e2e.first(".ctx-usage");
    if (!s || Number(s.querySelector(".ctx-token-in").dataset.tokens) !== ${risenIn}) return null;
    const c = s.querySelector(".ctx-cost");
    return { text: e2e.norm(c.innerText), kind: c.dataset.spend };
  `, { timeoutMs: 10_000 });
  assert(naCtx.kind === "na" && naCtx.text === "n/a", `the Context panel says ${JSON.stringify(naCtx)} with ${risenIn} tokens in`);
  await bridge.screenshot(join(evidenceDir, "02-unpriced-na.png"));

  // ── 4. A plain shell has no spend ──────────────────────────────────
  log("step 4: the plain shell shows no spend");
  const shellRow = await rowState(bridge, shell);
  assert(shellRow && shellRow.spend === null, "the plain shell row has no spend badge");
  const shellSnap = await bridge.eval(`return window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(shell)});`);
  assert(shellSnap.usage === null, "and nothing was reported for it");
});
