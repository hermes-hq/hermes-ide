#!/usr/bin/env node
// Scenario REAL-context-claude (local only): Hermes's context gauge against
// the REAL `claude` CLI's own number, on haiku (the cheapest model), in the
// isolated test build.
//
// Three short turns; after each one Claude's own `/context` is read from its
// terminal ("41.2k/200k tokens (21%)") and compared with what Hermes shows
// for the session (its store and the row's gauge):
//   - the window is Claude's (200k for haiku);
//   - the tokens in use are Claude's within 1 % of the window (Hermes reads
//     the last call's input + cache reads + cache writes from the
//     transcript; /context counts the same conversation);
//   - the percentage on the row is Claude's within one point;
//   - the gauge goes up from turn to turn (the current context, not a sum).
// Then one one-word turn on sonnet (a 1M-window model, the reported case):
// Hermes's window and percentage must be Claude's there too.
//
// It runs only with a signed-in `claude` on PATH, macOS or Linux, and never
// in CI (RESULT: SKIP otherwise; e2e/app/ci-plan.mjs excludes it).
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/REAL-context-claude.mjs

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger, finishScenario, outDir, sleep } from "../harness.mjs";
import {
  answerTrustPrompts,
  cleanup,
  guard,
  home,
  launchRealApp,
  launchWithChoice,
  quitAgent,
  requireRealCli,
  snapshot,
  tempProfileRoot,
  terminalText,
  throwawayRepo,
  turnEnded,
  waitForTurnEnd,
} from "../real-steps.mjs";

const SCENARIO = "REAL-context-claude";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);

/** A webview starved of CPU (a loaded machine) can miss one answer: try again. */
async function patient(fn, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries || !/did not answer/.test(String(e?.message ?? e))) throw e;
      log(`  (the webview was busy; trying again: ${String(e.message).slice(0, 80)})`);
      await sleep(2000);
    }
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

const cli = requireRealCli("claude", log, { scenario: SCENARIO, evidenceDir });
const guarded = guard([join(home, ".claude", "settings.json")], log);
const repo = throwawayRepo("real-context-claude", { "notes.txt": "alpha\nbeta\ngamma\n" });
const profileRoot = tempProfileRoot("real-context-claude");

const num = (v, unit) => Number(v) * (unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1);
/**
 * Claude's /context answer → { used, window, percent }: its header line
 * "41.2k/200k tokens (21%)"; when that has scrolled away (a 1M model's grid
 * is taller), the same from its other lines: the window ("Auto-compact
 * window: 1m tokens"), "Free space: 917.7k" and the "Autocompact buffer: 33k"
 * it keeps (used = window − free − buffer).
 */
function parseContext(text) {
  const flat = text.replace(/\s+/g, " ");
  const m = [...flat.matchAll(/([\d.]+)(k|m)?\/([\d.]+)(k|m) tokens \((\d+)%\)/g)].at(-1);
  if (m) return { used: num(m[1], m[2]), window: num(m[3], m[4]), percent: Number(m[5]), raw: m[0] };
  const win = [...flat.matchAll(/Auto-compact window: ([\d.]+)(k|m) tokens/g)].at(-1);
  const free = [...flat.matchAll(/Free space: ([\d.]+)(k|m)? \(/g)].at(-1);
  if (!win || !free) return null;
  const buffer = [...flat.matchAll(/Autocompact buffer: ([\d.]+)(k|m)? tokens/g)].at(-1);
  const window = num(win[1], win[2]);
  const used = window - num(free[1], free[2]) - (buffer ? num(buffer[1], buffer[2]) : 0);
  return { used, window, percent: Math.round((used / window) * 100), raw: `${free[0]}… of ${win[0]}${buffer ? ` (${buffer[0]})` : ""}` };
}
async function claudeContext(bridge, sid) {
  // The answer's "used/window tokens (n%)" line; a previous answer may still
  // be on screen, so a new one is taken once it differs or after a while.
  const before = parseContext(await patient(() => terminalText(bridge, sid)));
  await bridge.typeInTerminal(sid, "/context");
  await sleep(600);
  await bridge.typeInTerminal(sid, "\r");
  const started = Date.now();
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const text = await patient(() => terminalText(bridge, sid));
    const c = parseContext(text);
    if (c && /Free space/.test(text) && (!before || c.raw !== before.raw || Date.now() - started > 6000)) return c;
  }
  writeFileSync(join(evidenceDir, `terminal-${sid.slice(0, 8)}.txt`), await patient(() => terminalText(bridge, sid)));
  throw new Error(`no /context answer (terminal saved). Last lines:\n${(await patient(() => terminalText(bridge, sid))).split("\n").slice(-25).join("\n")}`);
}
const rowGauge = (bridge, sid) =>
  bridge.eval(`
    const row = e2e.first('.session-item[data-session-item-id="${sid}"]')?.closest(".session-item-wrapper") ?? e2e.first('.session-item[data-session-item-id="${sid}"]');
    const g = row?.querySelector(".session-context-gauge");
    return g ? { text: e2e.norm(g.innerText), title: g.getAttribute("title") } : null;
  `);

let app;
let failed = false;
const evidence = [];
try {
  log(`scenario: ${SCENARIO}   claude: ${cli.path} (${cli.version})   repo: ${repo}`);
  app = await launchRealApp(evidenceDir, log, profileRoot);
  const { bridge } = app;
  await bridge.waitFor("the app", `return !!e2e.first(".onboarding-dialog, .setup-dialog, .topbar");`, { timeoutMs: 30_000 });
  if (await bridge.exists(".onboarding-dialog")) {
    for (let i = 0; i < 3; i++) {
      await bridge.click(".onboarding-actions .onboarding-btn-primary");
      await sleep(150);
    }
    await bridge.clickWhenReady(`
      const [analytics, policy] = e2e.all(".onboarding-privacy-checkbox input");
      if (analytics.checked) e2e.click(analytics);
      if (!policy.checked) e2e.click(policy);
      return true;
    `);
    await bridge.click(".onboarding-actions .onboarding-btn-primary");
    await bridge.waitFor("the welcome to close", `return !e2e.first(".onboarding-backdrop");`);
    await sleep(300);
    if (await bridge.exists(".whatsnew-backdrop")) await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
  }

  log("step 1: claude on haiku, three short turns, /context after each");
  const sid = await launchWithChoice(bridge, { agentId: "claude", cwd: repo, task: "Reply with the single word ok.", modelId: "haiku" });
  await answerTrustPrompts(bridge, sid, log, async () => (await patient(() => snapshot(bridge, sid))).events.some((e) => String(e.source ?? "").startsWith("hook")), { timeoutMs: 60_000 });
  const turns = ["Reply with the single word ok.", "Read notes.txt and tell me its second line.", "Now tell me its third line, in one word."];
  let lastUsed = 0;
  for (const [i, prompt] of turns.entries()) {
    const sentAt = Date.now();
    if (i > 0) {
      await bridge.typeInTerminal(sid, prompt);
      await sleep(400);
      await bridge.typeInTerminal(sid, "\r");
    }
    // This turn's own end (the agent's Stop hook), not an earlier one.
    if (i === 0) await waitForTurnEnd(bridge, sid, log);
    else {
      const deadline = Date.now() + 180_000;
      for (;;) {
        const snap = await patient(() => snapshot(bridge, sid));
        if (turnEnded({ events: snap.events.filter((e) => e.at >= sentAt - 1000) })) break;
        if (Date.now() > deadline) throw new Error(`turn ${i + 1} did not end: ${JSON.stringify({ turn: snap.turn, status: snap.status, last: snap.events.slice(-6) })}`);
        if (snap.status?.kind === "needs_approval") {
          log(`  Claude asks permission ("${snap.status.detail}"): Yes`);
          await bridge.typeInTerminal(sid, "\r");
          await sleep(1500);
        }
        await sleep(500);
      }
    }
    await sleep(2500);
    const snap = await patient(() => snapshot(bridge, sid));
    const h = snap.context;
    assert(h && h.contextLimit, `turn ${i + 1}: Hermes has a context report (${JSON.stringify(h)})`);
    const c = await claudeContext(bridge, sid);
    const gauge = await rowGauge(bridge, sid);
    const hermesPercent = Math.round((h.usedTokens / h.contextLimit) * 100);
    const row = { turn: i + 1, model: h.model, hermes: { used: h.usedTokens, window: h.contextLimit, percent: hermesPercent, row: gauge?.text ?? null }, claude: c };
    evidence.push(row);
    log(`  turn ${i + 1}: Hermes ${h.usedTokens}/${h.contextLimit} (${hermesPercent}%, row "${gauge?.text}") · Claude /context ${c.raw}`);
    assert(h.contextLimit === c.window, `turn ${i + 1}: the window is Claude's (${h.contextLimit} = ${c.window})`);
    assert(Math.abs(h.usedTokens - c.used) <= 0.01 * c.window, `turn ${i + 1}: the tokens in use are Claude's within 1 % of the window (${h.usedTokens} vs ${c.used})`);
    assert(Math.abs(hermesPercent - c.percent) <= 1, `turn ${i + 1}: the percentage is Claude's within a point (${hermesPercent} vs ${c.percent})`);
    assert(gauge && new RegExp(`\\b${hermesPercent}\\s?%`).test(gauge.text), `turn ${i + 1}: the row shows it (${gauge?.text})`);
    assert(h.usedTokens >= lastUsed, `turn ${i + 1}: the current context, not shrinking without a compaction (${lastUsed} → ${h.usedTokens})`);
    assert(h.usedTokens < 3 * (lastUsed || h.usedTokens), "and not a sum of every turn");
    lastUsed = h.usedTokens;
  }
  await bridge.screenshot(join(evidenceDir, "01-gauge.png"));
  await quitAgent(bridge, sid, "/exit");

  log("step 2: a 1M-window model (sonnet): one one-word turn, the reported case");
  const s2 = await launchWithChoice(bridge, { agentId: "claude", cwd: repo, task: "Reply with the single word ok.", modelId: "sonnet" });
  await answerTrustPrompts(bridge, s2, log, async () => (await patient(() => snapshot(bridge, s2))).events.some((e) => String(e.source ?? "").startsWith("hook")), { timeoutMs: 60_000 });
  await waitForTurnEnd(bridge, s2, log);
  await sleep(2500);
  const h2 = (await patient(() => snapshot(bridge, s2))).context;
  const c2 = await claudeContext(bridge, s2);
  const p2 = Math.round((h2.usedTokens / h2.contextLimit) * 100);
  evidence.push({ turn: "sonnet", model: h2.model, hermes: { used: h2.usedTokens, window: h2.contextLimit, percent: p2, row: (await rowGauge(bridge, s2))?.text ?? null }, claude: c2 });
  log(`  sonnet: Hermes ${h2.usedTokens}/${h2.contextLimit} (${p2}%) · Claude /context ${c2.raw} (${h2.model})`);
  assert(c2.window === 1_000_000 && h2.contextLimit === c2.window, `the window is Claude's 1M for ${h2.model} (Hermes ${h2.contextLimit}; it used to assume 200k and show five times too full)`);
  assert(Math.abs(h2.usedTokens - c2.used) <= 0.01 * c2.window && Math.abs(p2 - c2.percent) <= 1, `the tokens and the percentage are Claude's (${h2.usedTokens} vs ${c2.used}, ${p2}% vs ${c2.percent}%)`);
  await bridge.screenshot(join(evidenceDir, "02-gauge-1m.png"));
  await quitAgent(bridge, s2, "/exit");

  await app.stop();
  app = null;
  guarded.check(assert);
  log(`EVIDENCE ${JSON.stringify(evidence)}`);
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
  } catch {
    /* no screenshot */
  }
} finally {
  if (app?.isRunning()) await app.stop();
  guarded.restore();
  cleanup([repo, profileRoot]);
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log, details: { evidence } });
