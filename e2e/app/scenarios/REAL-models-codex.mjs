#!/usr/bin/env node
// Scenario REAL-models-codex (local only): the REAL Codex CLI started by the
// test app with a model and an effort (2.0 launch contract). SKIP in CI, on
// Windows, or without a signed-in `codex` on PATH (e2e/app/ci-plan.mjs
// excludes it). One tiny prompt per launch that runs, on the cheapest model
// Codex's own list offers.
//
//   1. The account probe (`codex login status`) says signed in; the models
//      come from `codex debug models --bundled`.
//   2. Default model (no -m): either one tiny turn ends (Codex's notify), or
//      — when the person's own Codex config pins a model the account no
//      longer takes, as on the maintainer's Mac — Codex's refusal shows in
//      the banner as "refused its default model" and the launch is stopped.
//      Both are the right behaviour; the log says which happened.
//   3. An explicit model and effort (-m <cheap model> -c
//      model_reasoning_effort="low"): the flags are on the running codex and
//      one tiny turn ends. A listed model the account refuses is reported
//      and the next cheapest is tried (Codex's list is not filtered by plan).
//      The model chip shows the model Codex's rollout reports for the turn.
//   4. An invalid model: Codex's own refusal shows in the banner, the codex
//      process is gone well before Codex's minute of reconnecting would end,
//      and no turn ran.
//   ~/.codex/config.toml is byte-identical before and after.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/REAL-models-codex.mjs

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLogger, finishScenario, outDir, sleep } from "../harness.mjs";
import {
  answerTrustPrompts,
  banner,
  chip,
  cleanup,
  guard,
  home,
  invoke,
  launchRealApp,
  launchSpec,
  launchTree,
  launchWithChoice,
  quitAgent,
  requireRealCli,
  snapshot,
  tempProfileRoot,
  terminalText,
  throwawayRepo,
  turnEnded,
  waitForBanner,
} from "../real-steps.mjs";

const SCENARIO = "REAL-models-codex";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

const cli = requireRealCli("codex", log, { scenario: SCENARIO, evidenceDir });
const guarded = guard([join(home, ".codex", "config.toml")], log);
const repo = throwawayRepo("real-codex");
const profileRoot = tempProfileRoot("real-codex");
const TASK = "Reply with the word ok and nothing else. Do not read or run anything.";
const TRUST = `-c projects={${JSON.stringify(repo)}={trust_level="trusted"}}`;

/** Launch, get past a trust prompt, and wait for a turn end or a refusal. */
async function launchAndSettle(bridge, app, opts, what, { timeoutMs = 180_000 } = {}) {
  // Codex writes a trusted folder into ~/.codex/config.toml when its trust
  // prompt is answered; the throwaway repository is trusted for this launch
  // only instead, so the person's config is never touched.
  const sid = await launchWithChoice(bridge, { agentId: "codex", cwd: repo, task: TASK, suffix: TRUST, ...opts });
  const spec = await launchSpec(app, sid);
  log(`  ${what}: session ${sid}; args ${JSON.stringify(spec.args.filter((a) => !a.includes("/") && !a.startsWith("notify")))}`);
  const settled = async () => turnEnded(await snapshot(bridge, sid)) || !!(await banner(bridge, sid));
  await answerTrustPrompts(bridge, sid, log, settled, { timeoutMs: 60_000 });
  const deadline = Date.now() + timeoutMs;
  while (!(await settled())) {
    if (Date.now() > deadline) throw new Error(`${what}: neither a turn end nor a refusal within ${timeoutMs} ms. Terminal:\n${(await terminalText(bridge, sid)).split("\n").slice(-20).join("\n")}`);
    const s = await snapshot(bridge, sid);
    if (s.status?.kind === "needs_approval") {
      log(`  codex asks for approval ("${s.status.detail}"); answering Yes`);
      await bridge.typeInTerminal(sid, "\r");
      await sleep(1500);
    }
    await sleep(500);
  }
  return { sid, spec, refused: await banner(bridge, sid), snap: await snapshot(bridge, sid) };
}

let app;
let failed = false;
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

  // ─── 1. probes ─────────────────────────────────────────────────────
  log("step 1: codex login status and codex debug models");
  const caps = await invoke(bridge, "get_agent_capabilities", { agentId: "codex", accountId: null, refresh: true });
  log(`  capabilities: version ${caps.cliVersion}; accounts ${JSON.stringify(caps.accounts.map((a) => ({ id: a.id, state: a.signInState, detail: a.detail })))}; models ${caps.models.map((m) => `${m.id}[${m.efforts.join("/")}]`).join(", ")}`);
  assert(caps.installed && caps.verifiedOnRealInstall && caps.cliVersion, `installed and verified (${caps.cliVersion})`);
  assert(caps.accounts[0].signInState === "signed-in", `signed in (${caps.accounts[0].detail})`);
  assert(caps.modelSource === "cli-list" && caps.models.length > 1, "models from Codex's own list");

  // ─── 2. default model ──────────────────────────────────────────────
  log("step 2: the default model (no -m)");
  const d = await launchAndSettle(bridge, app, {}, "default");
  assert(!d.spec.args.includes("-m") && !d.spec.args.some((a) => a.startsWith("model_reasoning_effort")), "no -m and no effort on the launch");
  if (d.refused) {
    log(`  Codex refused its default model (the person's own config): ${JSON.stringify(d.refused)}`);
    assert(d.refused.reason === "model" && /default model/.test(d.refused.title), `the banner says the default model was refused ("${d.refused.title}")`);
    assert(!d.refused.actions.includes("retry-default") && d.refused.actions.includes("pick-model"), "it offers another model, not the same default again");
    await sleep(3000);
    assert(launchTree(d.sid).children.length === 0, "the launch was stopped");
  } else {
    assert(turnEnded(d.snap), "one tiny turn ended, reported by Codex");
    await quitAgent(bridge, d.sid, "/quit");
  }
  await bridge.screenshot(join(evidenceDir, "01-default.png"));

  // ─── 3. explicit model + effort ────────────────────────────────────
  log("step 3: an explicit model with effort low");
  const cheapFirst = (m) => (/(mini|luna|nano|lite|small|fast)/i.test(`${m.id} ${m.label} ${m.note ?? ""}`) ? 0 : 1);
  const candidates = caps.models.filter((m) => m.id !== "default" && m.available && m.efforts.includes("low")).sort((a, b) => cheapFirst(a) - cheapFirst(b));
  assert(candidates.length > 0, `a listed model takes effort low (${candidates.map((m) => m.id).join(", ")})`);
  let ran = null;
  for (const model of candidates.slice(0, 3)) {
    const r = await launchAndSettle(bridge, app, { modelId: model.id, effort: "low" }, `${model.id}/low`);
    const argv = r.spec.args.join(" ");
    assert(argv.includes(`-m ${model.id}`) && argv.includes('-c model_reasoning_effort="low"'), `-m ${model.id} -c model_reasoning_effort="low" are on the launch`);
    if (r.refused) {
      log(`  the account refused ${model.id}: ${r.refused.body.slice(0, 200)} — trying the next`);
      const after = await invoke(bridge, "get_agent_capabilities", { agentId: "codex", accountId: null, refresh: false });
      assert(after.models.find((m) => m.id === model.id)?.available === false, `${model.id} is now marked refused by this account`);
      continue;
    }
    ran = { ...r, model };
    break;
  }
  assert(ran, "one explicit model with effort low ran a turn");
  assert(turnEnded(ran.snap), "its turn ended, reported by Codex");
  const reported = await bridge.waitFor("the reported model chip", `
    const row = e2e.first('.session-item[data-session-item-id="${ran.sid}"]');
    const c = row && row.querySelector('[data-testid="session-model-chip"][data-source="reported"]');
    return c ? e2e.norm(c.innerText) : null;
  `, { timeoutMs: 20_000 });
  assert(reported === ran.model.id, `the model chip shows the model Codex reports in its rollout (${reported})`);
  await bridge.screenshot(join(evidenceDir, "02-explicit.png"));
  await quitAgent(bridge, ran.sid, "/quit");

  // ─── 4. an invalid model ───────────────────────────────────────────
  log("step 4: an invalid model is refused and stopped at once");
  const t4 = Date.now();
  const bad = await launchAndSettle(bridge, app, { modelId: "not-a-model" }, "not-a-model", { timeoutMs: 90_000 });
  const ms = Date.now() - t4;
  log(`  banner after ${ms} ms: ${JSON.stringify(bad.refused)}`);
  assert(bad.refused && bad.refused.reason === "model", "the model was refused");
  assert(/not-a-model/.test(bad.refused.body), "Codex's own words name it");
  await sleep(3000);
  assert(launchTree(bad.sid).children.length === 0, "no codex process is left");
  assert(ms < 45_000, `stopped long before Codex's minute of reconnecting (${ms} ms)`);
  assert(!turnEnded(bad.snap), "no turn ran");
  await bridge.screenshot(join(evidenceDir, "03-invalid.png"));

  const exit = await app.stop();
  assert(exit.code === 0, "the app quit cleanly");
  guarded.check(assert);
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      for (const id of (await app.bridge.terminalIds()) ?? []) log(`  terminal ${id}:\n${(await terminalText(app.bridge, id)).split("\n").slice(-15).join("\n")}`);
    }
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  if (app?.isRunning()) await app.stop();
  guarded.restore();
  cleanup([repo, profileRoot]);
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
