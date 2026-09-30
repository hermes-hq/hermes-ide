#!/usr/bin/env node
// Scenario REAL-models-claude (local only): the REAL Claude Code started by
// the test app with a model, an effort and an account (2.0 launch contract).
// SKIP in CI, on Windows, or without a signed-in `claude` on PATH
// (e2e/app/ci-plan.mjs excludes it). One tiny prompt per launch that runs;
// the throwaway repository's own .claude/settings.json makes haiku the
// default model, so nothing global changes.
//
//   1. The account probe (`claude auth status --json`) says signed in, with
//      the plan and no e-mail; Settings > Agents shows it.
//   2. Default model: no --model flag; one tiny turn ends, reported exactly
//      by the Stop hook.
//   3. An explicit model and effort (sonnet, low): the flags are on the
//      running claude; one tiny turn ends.
//   4. An invalid model: Claude's own refusal shows in the banner within
//      seconds, the claude process is gone, no turn ended, nothing was spent.
//   5. A second account in a temporary profile folder the test creates
//      (never the person's own folders) reads as signed out.
//   ~/.claude/settings.json is byte-identical before and after.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/REAL-models-claude.mjs

import { existsSync, mkdirSync, rmSync } from "node:fs";
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
  waitForTurnEnd,
} from "../real-steps.mjs";

const SCENARIO = "REAL-models-claude";
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

const cli = requireRealCli("claude", log);
const guarded = guard([join(home, ".claude", "settings.json")], log);
const repo = throwawayRepo("real-claude", { ".claude/settings.json": JSON.stringify({ model: "haiku" }, null, 2) + "\n" });
const profileRoot = tempProfileRoot("real-claude");
const TASK = "Reply with the word ok and nothing else. Do not read any file.";

async function startAndFinish(bridge, app, opts, what) {
  const sid = await launchWithChoice(bridge, { agentId: "claude", cwd: repo, task: TASK, ...opts });
  const spec = await launchSpec(app, sid);
  log(`  ${what}: session ${sid}; args ${JSON.stringify(spec.args.filter((a) => !a.includes("/")))}`);
  await answerTrustPrompts(bridge, sid, log, async () => {
    const s = await snapshot(bridge, sid);
    return s.events.some((e) => String(e.source ?? "").startsWith("hook")) || !!(await banner(bridge, sid));
  }, { timeoutMs: 60_000 });
  return { sid, spec };
}

let app;
let failed = false;
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

  // ─── 1. the account probe ──────────────────────────────────────────
  log("step 1: claude auth status --json says signed in");
  const caps = await invoke(bridge, "get_agent_capabilities", { agentId: "claude", accountId: null, refresh: true });
  const def = caps.accounts.find((a) => a.id === "default");
  log(`  capabilities: version ${caps.cliVersion}; accounts ${JSON.stringify(caps.accounts.map((a) => ({ id: a.id, state: a.signInState, detail: a.detail })))}; models ${caps.models.map((m) => m.id).join(", ")}`);
  assert(caps.installed && caps.verifiedOnRealInstall && caps.cliVersion, `installed and verified (${caps.cliVersion})`);
  assert(def?.signInState === "signed-in" && def.signedIn, `the default account is signed in (${def?.detail})`);
  assert(!/@/.test(JSON.stringify(caps)), "no e-mail anywhere in what the probe kept");
  assert(["default", "opus", "sonnet", "haiku", "opusplan"].every((m) => caps.models.some((x) => x.id === m)), "Claude's aliases are offered");

  // ─── 2. default model ──────────────────────────────────────────────
  log("step 2: the default model (no flag); one tiny turn");
  const d = await startAndFinish(bridge, app, {}, "default");
  assert(!d.spec.args.includes("--model") && !d.spec.args.includes("--effort"), "no --model and no --effort on the launch");
  const dSnap = await waitForTurnEnd(bridge, d.sid, log);
  assert(turnEnded(dSnap), "the turn ended, reported by Claude's own hook");
  log(`  chip: ${JSON.stringify(await chip(bridge, d.sid))}; identity ${JSON.stringify(dSnap.identity)}`);
  await bridge.screenshot(join(evidenceDir, "01-default.png"));
  await quitAgent(bridge, d.sid, "/exit");

  // ─── 3. explicit model + effort ────────────────────────────────────
  log("step 3: model sonnet, effort low; one tiny turn");
  const valid = await invoke(bridge, "validate_launch", { choice: { agentId: "claude", accountId: "default", approvalModeId: "acceptEdits", modelId: "sonnet", effort: "low", extraArgs: "", prefix: "", channels: [], where: { kind: "current-checkout" }, trackAsFeature: false } });
  assert(valid.ok === true, "Hermes accepts sonnet with effort low");
  const m = await startAndFinish(bridge, app, { modelId: "sonnet", effort: "low" }, "sonnet/low");
  const at = m.spec.args.indexOf("--model");
  assert(at >= 0 && m.spec.args[at + 1] === "sonnet" && m.spec.args[at + 2] === "--effort" && m.spec.args[at + 3] === "low", "--model sonnet --effort low are on the launch");
  const tree = launchTree(m.sid);
  const running = tree.children.find((p) => /claude/.test(p.command));
  log(`  running: ${running?.command.slice(0, 200)}`);
  assert(running && running.command.includes("--model sonnet") && running.command.includes("--effort low"), "the running claude carries them");
  const mSnap = await waitForTurnEnd(bridge, m.sid, log);
  assert(turnEnded(mSnap), "the turn ended");
  const mChip = await chip(bridge, m.sid);
  log(`  chip: ${JSON.stringify(mChip)}; identity ${JSON.stringify(mSnap.identity)}`);
  // Claude reports its model in its SessionStart hook, so the chip must be
  // the reported one here (the "requested" fallback would hide a broken report).
  assert(mChip?.source === "reported" && /sonnet/.test(mChip.text), `the model chip shows the model Claude reported (${JSON.stringify(mChip)})`);
  await bridge.screenshot(join(evidenceDir, "02-sonnet-low.png"));
  await quitAgent(bridge, m.sid, "/exit");

  // ─── 4. an invalid model ───────────────────────────────────────────
  log("step 4: an invalid model is refused; Hermes stops the launch; nothing runs");
  const t4 = Date.now();
  const bad = await launchWithChoice(bridge, { agentId: "claude", cwd: repo, task: TASK, modelId: "not-a-model" });
  await answerTrustPrompts(bridge, bad, log, async () => !!(await banner(bridge, bad)), { timeoutMs: 60_000 });
  const b = await waitForBanner(bridge, bad, 60_000);
  const ms = Date.now() - t4;
  log(`  banner after ${ms} ms: ${JSON.stringify(b)}`);
  assert(b.reason === "model" && b.body.includes("There's an issue with the selected model (not-a-model)"), "Claude's own refusal is in the banner");
  assert(b.actions.includes("retry-default"), "Retry with default model is offered");
  await sleep(3000);
  const left = launchTree(bad).children.filter((p) => /claude/.test(p.command));
  assert(left.length === 0, `no claude process is left (${left.map((p) => p.command.slice(0, 80)).join(" | ")})`);
  const badSnap = await snapshot(bridge, bad);
  assert(!turnEnded(badSnap) && !badSnap.events.some((e) => e.type === "turn_start"), "no turn started or ended");
  const usage = badSnap.usage;
  assert(!usage || !usage.costUsd, `nothing was spent (${JSON.stringify(usage)})`);
  assert((await terminalText(bridge, bad)).includes("Hermes stopped it"), "the terminal says Hermes stopped it");
  await bridge.screenshot(join(evidenceDir, "03-invalid-model.png"));

  // ─── 5. a second account in a temporary profile ────────────────────
  log("step 5: a second account in a temporary profile reads as signed out");
  const added = await invoke(bridge, "add_agent_account", { agentId: "claude", label: "CAP Test" });
  log(`  added: ${JSON.stringify({ id: added.account.id, state: added.account.signInState, env: added.account.profileEnv?.name, reused: added.reused })}`);
  assert(added.account.profileEnv?.value.startsWith(profileRoot) && existsSync(added.account.profileEnv.value), "its profile folder is in the test's temporary folder");
  assert(added.account.signInState === "signed-out" && !added.signedIn, "it reads as signed out");
  const after = await invoke(bridge, "get_agent_capabilities", { agentId: "claude", accountId: null, refresh: true });
  assert(after.accounts.find((a) => a.id === "default")?.signInState === "signed-in", "the default account is still signed in");
  await invoke(bridge, "remove_agent_account", { agentId: "claude", accountId: added.account.id });

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
