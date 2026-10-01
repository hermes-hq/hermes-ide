#!/usr/bin/env node
// Scenario REAL-context-codex (local only): Hermes's context gauge against
// the REAL `codex` CLI's own numbers, on its cheapest listed model, in the
// isolated test build. Also: the REAL `agy` (Antigravity) reports no context
// usage Hermes can read, so its row shows no gauge at all (never an
// estimate) — when agy is installed.
//
// Codex: three short turns; after each, Codex's `/status` is read from its
// terminal ("Context window: 98% left (16.2K used / 258K)") with its footer
// ("94% left"), and compared with Hermes's numbers for the session:
//   - the window is Codex's (its rollout's model_context_window: 258K);
//   - the tokens in use are Codex's "used" within 0.1K (the last call's
//     total, from the rollout's token_count);
//   - the percentage on the row is 100 minus Codex's footer "% left",
//     within one point.
// The throwaway repository is trusted for these launches only and the update
// check is off for them, so ~/.codex/config.toml is never written (it is
// compared byte for byte).
//
// It runs only with a signed-in `codex` on PATH, macOS or Linux, and never in
// CI (RESULT: SKIP otherwise; e2e/app/ci-plan.mjs excludes it).
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/REAL-context-codex.mjs

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLogger, finishScenario, outDir, sleep } from "../harness.mjs";
import {
  answerTrustPrompts,
  cleanup,
  guard,
  home,
  invoke,
  launchRealApp,
  launchWithChoice,
  quitAgent,
  requireRealCli,
  snapshot,
  tempProfileRoot,
  terminalText,
  throwawayRepo,
  turnEnded,
  which,
} from "../real-steps.mjs";

const SCENARIO = "REAL-context-codex";
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

const cli = requireRealCli("codex", log, { scenario: SCENARIO, evidenceDir });
const guarded = guard([join(home, ".codex", "config.toml"), join(home, ".gemini", "settings.json")], log);
const repo = throwawayRepo("real-context-codex", { "notes.txt": "alpha\nbeta\ngamma\n" });
const profileRoot = tempProfileRoot("real-context-codex");
const CODEX_ONLY = `-c projects={${JSON.stringify(repo)}={trust_level="trusted"}} -c check_for_update_on_startup=false`;

const k = (v, unit) => Number(v) * (unit?.toUpperCase() === "M" ? 1_000_000 : unit?.toUpperCase() === "K" ? 1_000 : 1);
/** Codex's /status line and its footer, the last ones on screen. */
function parseStatus(text) {
  const flat = text.replace(/\s+/g, " ");
  const s = [...flat.matchAll(/Context window: (\d+)% left \(([\d.]+)([KM])? used \/ ([\d.]+)([KM])\)/g)].at(-1);
  const footer = [...flat.matchAll(/(\d+)% (?:context )?left(?! \()/g)].at(-1);
  if (!s) return null;
  return { leftStatus: Number(s[1]), used: k(s[2], s[3]), window: k(s[4], s[5]), footerLeft: footer ? Number(footer[1]) : null, raw: s[0], footer: footer?.[0] ?? null };
}
async function codexStatus(bridge, sid) {
  await bridge.typeInTerminal(sid, "/status");
  await sleep(700);
  await bridge.typeInTerminal(sid, "\r");
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const st = parseStatus(await patient(() => terminalText(bridge, sid)));
    if (st) return st;
  }
  throw new Error(`no /status answer. Terminal:\n${(await patient(() => terminalText(bridge, sid))).split("\n").slice(-25).join("\n")}`);
}
const rowGauge = (bridge, sid) =>
  bridge.eval(`
    const item = e2e.first('.session-item[data-session-item-id="${sid}"]');
    const row = item?.closest(".session-item-wrapper") ?? item;
    const g = row?.querySelector(".session-context-gauge");
    return g ? e2e.norm(g.innerText) : null;
  `);

let app;
let failed = false;
const evidence = [];
try {
  log(`scenario: ${SCENARIO}   codex: ${cli.path} (${cli.version})   repo: ${repo}`);
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

  const caps = await invoke(bridge, "get_agent_capabilities", { agentId: "codex", accountId: null, refresh: true });
  const listed = caps.models.filter((m) => m.id !== "default" && m.available).map((m) => m.id);
  const MODEL = ["gpt-5.6-luna", ...listed].find((m) => listed.includes(m)) ?? listed[0];
  log(`step 1: codex on ${MODEL} (listed: ${listed.join(", ")}), three short turns, /status after each`);
  const sid = await launchWithChoice(bridge, { agentId: "codex", cwd: repo, task: "Reply with the single word ok.", modelId: MODEL, effort: "low", suffix: CODEX_ONLY });
  await answerTrustPrompts(bridge, sid, log, async () => turnEnded(await patient(() => snapshot(bridge, sid))), { timeoutMs: 60_000 });
  const turns = ["Reply with the single word ok.", "Read notes.txt and tell me its second line.", "Now tell me its third line, in one word."];
  for (const [i, prompt] of turns.entries()) {
    const sentAt = Date.now();
    if (i > 0) {
      await bridge.typeInTerminal(sid, prompt);
      await sleep(400);
      await bridge.typeInTerminal(sid, "\r");
    }
    // This turn's own end (the agent's own report), not an earlier one.
    const deadline = Date.now() + 180_000;
    for (;;) {
      const snap = await patient(() => snapshot(bridge, sid));
      if (turnEnded({ events: snap.events.filter((e) => e.at >= sentAt - (i === 0 ? 60_000 : 1000)) })) break;
      if (Date.now() > deadline) throw new Error(`turn ${i + 1} did not end: ${JSON.stringify({ turn: snap.turn, status: snap.status, last: snap.events.slice(-6) })}`);
      if (snap.status?.kind === "needs_approval") {
        log(`  codex asks for approval ("${snap.status.detail}"); answering Yes`);
        await bridge.typeInTerminal(sid, "\r");
        await sleep(1500);
      }
      await sleep(500);
    }
    await sleep(2500);
    const h = (await patient(() => snapshot(bridge, sid))).context;
    assert(h && h.contextLimit, `turn ${i + 1}: Hermes has a context report (${JSON.stringify(h)})`);
    const st = await codexStatus(bridge, sid);
    const gauge = await rowGauge(bridge, sid);
    const hermesPercent = Math.round((h.usedTokens / h.contextLimit) * 100);
    evidence.push({ turn: i + 1, model: h.model, hermes: { used: h.usedTokens, window: h.contextLimit, percent: hermesPercent, row: gauge }, codex: st });
    log(`  turn ${i + 1}: Hermes ${h.usedTokens}/${h.contextLimit} (${hermesPercent}%, row "${gauge}") · Codex ${st.raw}; footer "${st.footer}"`);
    assert(Math.abs(h.contextLimit - st.window) <= 500, `turn ${i + 1}: the window is Codex's (${h.contextLimit} vs ${st.window})`);
    assert(Math.abs(h.usedTokens - st.used) <= 100, `turn ${i + 1}: the tokens in use are Codex's "used" within 0.1K (${h.usedTokens} vs ${st.used})`);
    if (st.footerLeft !== null) assert(Math.abs(hermesPercent - (100 - st.footerLeft)) <= 1, `turn ${i + 1}: the percentage is 100 minus Codex's "${st.footerLeft}% left", within a point (${hermesPercent})`);
    assert(gauge && new RegExp(`\\b${hermesPercent}\\s?%`).test(gauge), `turn ${i + 1}: the row shows it (${gauge})`);
  }
  await bridge.screenshot(join(evidenceDir, "01-codex-gauge.png"));
  await quitAgent(bridge, sid, "/quit");

  if (which("agy")) {
    log("step 2: Antigravity reports no context usage Hermes can read: no gauge");
    const agyCaps = await invoke(bridge, "get_agent_capabilities", { agentId: "antigravity", accountId: null, refresh: true });
    const agyModel = agyCaps.models.find((m) => m.id !== "default" && m.available && /flash|low/i.test(m.id))?.id ?? "default";
    const a = await launchWithChoice(bridge, { agentId: "antigravity", cwd: repo, task: "Reply with the single word ok.", modelId: agyModel });
    await answerTrustPrompts(bridge, a, log, async () => turnEnded(await patient(() => snapshot(bridge, a))), { timeoutMs: 60_000 });
    const deadline = Date.now() + 180_000;
    let lastAnswer = 0;
    // Its answer on screen (a line that is just "ok"), or its own turn end.
    const answered = async () => turnEnded(await patient(() => snapshot(bridge, a))) || /^\s*[●•]?\s*ok\.?\s*$/im.test(await patient(() => terminalText(bridge, a)));
    while (!(await answered()) && Date.now() < deadline) {
      // agy asks before reading the session's context file outside the
      // worktree (no hook says so): Yes, allow access.
      const screen = (await patient(() => terminalText(bridge, a))).split("\n").slice(-16).join("\n");
      if (/Allow access to this file\?/.test(screen) && /> 1\. Yes, allow access/.test(screen) && Date.now() - lastAnswer > 3000) {
        log("  agy asks to read a file outside the worktree: Yes");
        await bridge.typeInTerminal(a, "\r");
        lastAnswer = Date.now();
      }
      await sleep(1000);
    }
    await sleep(3000);
    const snap = await patient(() => snapshot(bridge, a));
    log(`  agy (${agyModel}): turn ended ${turnEnded(snap)}; context ${JSON.stringify(snap.context)}; row gauge ${JSON.stringify(await rowGauge(bridge, a))}; events ${JSON.stringify(snap.events.map((e) => `${e.type}:${e.source ?? ""}`).slice(-8))}`);
    assert(await answered(), "agy answered");
    await sleep(5000);
    assert((await patient(() => snapshot(bridge, a))).context === null && (await rowGauge(bridge, a)) === null, "no context report and no gauge: hidden, never estimated");
    evidence.push({ agent: "antigravity", model: agyModel, hermes: null });
    await quitAgent(bridge, a, "/quit");
  } else {
    log("step 2: agy is not installed here; skipped");
  }

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
