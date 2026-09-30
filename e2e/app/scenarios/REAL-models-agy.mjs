#!/usr/bin/env node
// Scenario REAL-models-agy (local only): the REAL Antigravity CLI (`agy`)
// started by the test app with a model and an effort (2.0 launch
// contract). SKIP in CI, on Windows, or without a signed-in `agy` on PATH
// (e2e/app/ci-plan.mjs excludes it). One tiny prompt per launch that runs,
// on the cheapest model `agy models` lists.
//
//   1. The account probe (`agy models`: signed in when it lists models)
//      says signed in; the models are agy's own list.
//   2. Default model (no --model): one tiny turn ends (the Antigravity hook
//      reports it; agy 1.2 did not run the per-launch hooks file on the
//      maintainer's Mac, so the answer on screen counts too, and the log
//      says which).
//   3. An explicit model and effort (--model <flash, low> --effort low): the
//      flags are on the running agy; one tiny turn ends; the model chip
//      shows the model the hook reports (modelName).
//   4. An invalid model: agy 1.2 would run its default model without a word,
//      so Hermes refuses it before launch (the launcher's check and the
//      launch itself); nothing runs.
//   ~/.gemini/settings.json (when present) is byte-identical before and after.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/REAL-models-agy.mjs

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
  processes,
  quitAgent,
  requireRealCli,
  snapshot,
  tempProfileRoot,
  terminalText,
  throwawayRepo,
  turnEnded,
} from "../real-steps.mjs";

const SCENARIO = "REAL-models-agy";
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

const cli = requireRealCli("agy", log, { scenario: SCENARIO, evidenceDir });
const guarded = guard([join(home, ".gemini", "settings.json")], log);
const repo = throwawayRepo("real-agy");
const profileRoot = tempProfileRoot("real-agy");
const TASK = "Reply with the word ok and nothing else. Do not read or run anything.";

async function launchAndSettle(bridge, app, opts, what, { timeoutMs = 180_000 } = {}) {
  const sid = await launchWithChoice(bridge, { agentId: "antigravity", cwd: repo, task: TASK, ...opts });
  const spec = await launchSpec(app, sid);
  log(`  ${what}: session ${sid}; args ${JSON.stringify(spec.args.filter((a) => !a.includes("/")))}`);
  const settled = async () => turnEnded(await snapshot(bridge, sid)) || !!(await banner(bridge, sid)) || answered(await terminalText(bridge, sid));
  await answerTrustPrompts(bridge, sid, log, settled, { timeoutMs: 60_000 });
  const deadline = Date.now() + timeoutMs;
  while (!(await settled())) {
    if (Date.now() > deadline) throw new Error(`${what}: neither a turn end nor a refusal within ${timeoutMs} ms. Terminal:\n${(await terminalText(bridge, sid)).split("\n").slice(-20).join("\n")}`);
    await sleep(500);
  }
  const snap = await snapshot(bridge, sid);
  if (!turnEnded(snap) && answered(await terminalText(bridge, sid))) log("  (the answer is on screen, but no Antigravity hook reported the turn: this agy did not run the per-launch hooks file)");
  return { sid, spec, refused: await banner(bridge, sid), snap, done: turnEnded(snap) || answered(await terminalText(bridge, sid)) };
}

/** The agent answered: a line that is just "ok" after the prompt. */
function answered(text) {
  const at = text.lastIndexOf("Reply with the word ok");
  return at >= 0 && /^\s*ok\s*$/m.test(text.slice(at + 30));
}

let app;
let failed = false;
try {
  log(`scenario: ${SCENARIO}   agy: ${cli.path} (${cli.version})   repo: ${repo}`);
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
  log("step 1: agy models");
  const caps = await invoke(bridge, "get_agent_capabilities", { agentId: "antigravity", accountId: null, refresh: true });
  log(`  capabilities: version ${caps.cliVersion}; accounts ${JSON.stringify(caps.accounts.map((a) => ({ id: a.id, state: a.signInState, detail: a.detail })))}; models ${caps.models.map((m) => m.id).join(", ")}`);
  assert(caps.installed && caps.verifiedOnRealInstall, `installed and verified (${caps.cliVersion})`);
  assert(caps.accounts.length === 1 && caps.accounts[0].signInState === "signed-in", "signed in (the model list came back)");
  assert(caps.modelSource === "cli-list" && caps.models.length > 1 && !caps.canAddAccount, "models from agy's own list; one account per user");

  // ─── 2. default model ──────────────────────────────────────────────
  log("step 2: the default model");
  const d = await launchAndSettle(bridge, app, {}, "default");
  assert(!d.spec.args.includes("--model") && !d.spec.args.includes("--effort"), "no --model and no --effort on the launch");
  assert(!d.refused && d.done, "one tiny turn ended (the answer is there)");
  log(`  chip: ${JSON.stringify(await chip(bridge, d.sid))}`);
  await bridge.screenshot(join(evidenceDir, "01-default.png"));
  await quitAgent(bridge, d.sid, "/exit");

  // ─── 3. explicit model + effort ────────────────────────────────────
  log("step 3: an explicit model with effort low");
  const flash = caps.models.filter((m) => m.id !== "default" && /flash/i.test(m.id) && m.efforts.includes("low"));
  const pick = flash.find((m) => /low/i.test(m.id)) ?? flash[0] ?? caps.models.find((m) => m.id !== "default");
  const m = await launchAndSettle(bridge, app, { modelId: pick.id, effort: "low" }, `${pick.id}/low`);
  const at = m.spec.args.indexOf("--model");
  assert(at >= 0 && m.spec.args[at + 1] === pick.id && m.spec.args[at + 2] === "--effort" && m.spec.args[at + 3] === "low", `--model ${pick.id} --effort low are on the launch`);
  const running = launchTree(m.sid).children.find((p) => /agy/.test(p.command));
  log(`  running: ${running?.command.slice(0, 200) ?? "(already gone)"}`);
  assert(!m.refused && m.done, "one tiny turn ended");
  const c = await chip(bridge, m.sid);
  log(`  chip: ${JSON.stringify(c)}; identity ${JSON.stringify(m.snap.identity)}`);
  assert(c && (c.source === "reported" || c.text.startsWith(pick.id)), `the model chip shows the reported model, else the request (${c?.text})`);
  await bridge.screenshot(join(evidenceDir, "02-explicit.png"));
  await quitAgent(bridge, m.sid, "/exit");

  // ─── 4. an invalid model ───────────────────────────────────────────
  // agy 1.2 in its interactive mode does not refuse a model it does not
  // know: it runs its default model without a word (the capability matrix
  // saw 1.0.6 refuse it before any request, in print mode). So Hermes never
  // launches a model agy's own list does not have (the catalog marks agy
  // silent_fallback): the launcher's check refuses it, and so does the
  // launch itself.
  log("step 4: an invalid model is refused by Hermes before anything runs");
  const choice = { agentId: "antigravity", accountId: "default", approvalModeId: "default", modelId: "not-a-model", effort: null, extraArgs: "", prefix: "", channels: [], where: { kind: "current-checkout" }, trackAsFeature: false };
  const v = await invoke(bridge, "validate_launch", { choice });
  log(`  validate_launch: ${JSON.stringify(v)}`);
  assert(v.ok === false && v.field === "model" && /not-a-model/.test(v.message), "the launcher's check refuses it, naming the model");
  const idsBefore = await bridge.terminalIds();
  const bad = await launchWithChoice(bridge, { agentId: "antigravity", cwd: repo, task: TASK, modelId: "not-a-model" });
  await sleep(3000);
  const agyRunning = processes().filter((p) => /(^|\/)agy /.test(p.command) && p.command.includes("not-a-model"));
  log(`  launch returned ${JSON.stringify(bad)}; agy processes with it: ${agyRunning.length}`);
  assert(bad === null, "the launch itself is refused (no session)");
  assert(agyRunning.length === 0, "no agy runs with it");
  assert((await bridge.terminalIds()).length <= idsBefore.length, "no terminal was left behind");
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
