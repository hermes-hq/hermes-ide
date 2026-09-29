#!/usr/bin/env node
// Scenario CAP-launch-choice: a terminal agent started with a model, an
// effort and an account (the 2.0 launch contract), and a launch the CLI
// refuses. Fake `claude` and `codex` CLIs (tools/fake-agents/fake-cli.mjs)
// stand in for the real ones; they answer like the real CLIs, verbatim.
//
//   1. Claude with model opus and effort high: the launch file carries
//      `--model opus --effort high`, the agent gets them, and the session's
//      model chip says "opus · high · requested" until the agent reports its
//      model; once its SessionStart hook reports it, the chip shows the
//      reported model (data-source "reported").
//   2. Claude with a model the account refuses ("not-a-model"): within
//      seconds the session shows the refusal banner with Claude's own line
//      and "Nothing ran"; the fake was stopped by Hermes (SIGTERM, no hook,
//      no turn) and the terminal says so. "Retry with default model" starts
//      it again without --model, and it runs (its SessionStart hook fires).
//   3. Codex with a model its catalog lists but the account refuses: Codex
//      retries for about a minute; Hermes stops it as soon as the 404 line
//      shows (well under 20 s), and the model is marked "refused by this
//      account" in Codex's capabilities afterwards.
//   4. An account whose profile is signed out: the launch is refused as
//      signed out; "Sign in" opens the CLI's own sign-in in that profile
//      (a second terminal); "Try again" then runs the agent in the profile.
//   5. After a restart, each agent resumes its conversation in its account's
//      profile with its model and effort (the saved workspace keeps them).
//
// Negative controls (each must FAIL at step 2):
//   HERMES_E2E_CAP_NEGATIVE=1        the fakes accept every model, so the
//                                    refusal never shows.
//   HERMES_E2E_CAP_NEGATIVE=product  the fakes refuse as always, but the
//                                    app's refusal watch is off
//                                    (HERMES_E2E_REFUSAL_WATCH=off): proves
//                                    the banner and the stop are Hermes's.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/CAP-launch-choice.mjs
//
// Evidence (log, screenshots, the fakes' records) goes to HERMES_E2E_EVIDENCE,
// or <out dir>/evidence/CAP-launch-choice.

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLogger, finishScenario, outDir, sleep } from "../harness.mjs";
import {
  completeOnboarding,
  invoke,
  launch,
  launchWithChoice,
  logins,
  onWindows,
  records,
  removeWork,
  registryPath,
  setFake,
  setFakeMode,
  setupFakes,
  terminalText,
  waitForRecord,
  waitForTerminalText,
} from "../cap-steps.mjs";

const SCENARIO = "CAP-launch-choice";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);
const NEGATIVE = process.env.HERMES_E2E_CAP_NEGATIVE === "1";
const PRODUCT_NEGATIVE = process.env.HERMES_E2E_CAP_NEGATIVE === "product";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

const f = setupFakes("cap-launch", ["claude", "codex"]);
const restorePath = registryPath(f, log);
if (restorePath === null) {
  log("this scenario needs the fake agents on a Windows terminal's PATH, which means the user's registry Path; that is only changed on a CI runner");
  log("RESULT: SKIP (Windows outside CI)");
  process.exit(0);
}
if (!NEGATIVE) {
  setFake(f, "reject-models", "claude", "not-a-model");
  setFake(f, "reject-models", "codex", "gpt-fake-old");
}
setFakeMode(f, "normal");

const recordsOf = (sid) => records(f).filter((r) => r.env?.HERMES_SESSION_ID === sid);
/** Whether a process is still running. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
/** The session's latest launch record once its fake has ended (recorded, or its process gone). */
async function waitStopped(sid, what, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rec = recordsOf(sid).at(-1);
    if (rec && (rec.exit || !pidAlive(rec.pid))) return rec;
    if (Date.now() > deadline) throw new Error(`${what}: the fake still runs after ${timeoutMs} ms`);
    await sleep(150);
  }
}
const chip = (bridge, sid) =>
  bridge.eval(`
    const row = e2e.first('.session-item[data-session-item-id="${sid}"]');
    const c = row && row.querySelector('[data-testid="session-model-chip"]');
    return c ? { text: e2e.norm(c.innerText), source: c.dataset.source } : null;
  `);
const banner = (bridge, sid) =>
  bridge.eval(`
    const b = e2e.first('.launch-rejected[data-session-id="${sid}"]');
    if (!b) return null;
    return {
      reason: b.dataset.reason,
      title: e2e.norm(b.querySelector(".launch-rejected-title").innerText),
      body: e2e.norm(b.querySelector(".launch-rejected-body").innerText),
      actions: [...b.querySelectorAll(".launch-rejected-action")].map((a) => ({ kind: a.dataset.action, account: a.dataset.account ?? null, text: e2e.norm(a.innerText) })),
    };
  `);
async function waitForBanner(bridge, sid, timeoutMs) {
  const t0 = Date.now();
  const b = await bridge.waitFor("the refusal banner", `
    const b = e2e.first('.launch-rejected[data-session-id="${sid}"]');
    return b ? true : null;
  `, { timeoutMs, intervalMs: 100 });
  void b;
  return { banner: await banner(bridge, sid), ms: Date.now() - t0 };
}
async function clickAction(bridge, sid, kind, account) {
  await bridge.clickWhenReady(`
    const b = e2e.must(e2e.first('.launch-rejected[data-session-id="${sid}"]'), "the banner");
    const btn = [...b.querySelectorAll(".launch-rejected-action")].find((a) => a.dataset.action === ${JSON.stringify(kind)} && (${JSON.stringify(account ?? null)} === null || a.dataset.account === ${JSON.stringify(account ?? null)}));
    return e2e.click(e2e.must(btn, ${JSON.stringify(kind)}));
  `);
}

let app;
let failed = false;
try {
  log(`scenario: ${SCENARIO}${NEGATIVE ? " (NEGATIVE CONTROL: the fakes accept every model)" : PRODUCT_NEGATIVE ? " (NEGATIVE CONTROL: the app's refusal watch is off)" : ""}`);
  app = await launch(f, evidenceDir, log, 1, { first: true, env: PRODUCT_NEGATIVE ? { HERMES_E2E_REFUSAL_WATCH: "off" } : {} });
  const { bridge } = app;
  await completeOnboarding(bridge);

  // ─── 1. model + effort ─────────────────────────────────────────────
  log("step 1: Claude with model opus and effort high; the chip says requested, then what the agent reports");
  setFakeMode(f, "no-start-hook");
  const s1 = await launchWithChoice(bridge, { agentId: "claude", cwd: f.repo, task: "CAP one", modelId: "opus", effort: "high" });
  assert(typeof s1 === "string", `a session started (${s1})`);
  const rec1 = await waitForRecord(f, "the opus launch", (r) => r.env?.HERMES_SESSION_ID === s1);
  log(`  argv: ${JSON.stringify(rec1.argv)}`);
  const at = rec1.argv.indexOf("--model");
  assert(at >= 0 && rec1.argv[at + 1] === "opus" && rec1.argv[at + 2] === "--effort" && rec1.argv[at + 3] === "high", "the agent was started with --model opus --effort high");
  assert(rec1.model === "opus" && rec1.effort === "high", "the fake took the model and the effort");
  const requested = await bridge.waitFor("the requested chip", `
    const row = e2e.first('.session-item[data-session-item-id="${s1}"]');
    const c = row && row.querySelector('[data-testid="session-model-chip"]');
    return c ? { text: e2e.norm(c.innerText), source: c.dataset.source } : null;
  `, { timeoutMs: 20_000 });
  assert(requested.source === "requested" && requested.text === "opus · high · requested", `before any report the chip is the launch choice, labelled requested ("${requested.text}")`);
  await bridge.screenshot(join(evidenceDir, "01-requested-chip.png"));

  setFakeMode(f, "normal");
  const s1b = await launchWithChoice(bridge, { agentId: "claude", cwd: f.repo, task: "CAP one b", modelId: "opus", effort: "high" });
  await waitForRecord(f, "the second opus launch", (r) => r.env?.HERMES_SESSION_ID === s1b && r.hooksRan?.some((h) => h.event === "SessionStart"));
  const reported = await bridge.waitFor("the reported chip", `
    const row = e2e.first('.session-item[data-session-item-id="${s1b}"]');
    const c = row && row.querySelector('[data-testid="session-model-chip"][data-source="reported"]');
    return c ? e2e.norm(c.innerText) : null;
  `, { timeoutMs: 20_000 });
  assert(reported === "opus", `once the agent reports its model, the chip shows it ("${reported}")`);
  assert(!(await chip(bridge, s1b))?.text.includes("requested"), "and no longer says requested");
  await bridge.screenshot(join(evidenceDir, "02-reported-chip.png"));

  // ─── 2. a refused model ────────────────────────────────────────────
  log("step 2: Claude with a model the account refuses: stopped within seconds, the banner, nothing ran");
  const t2 = Date.now();
  const s2 = await launchWithChoice(bridge, { agentId: "claude", cwd: f.repo, task: "CAP two", modelId: "not-a-model", effort: "high" });
  const { banner: b2, ms: bannerMs } = await waitForBanner(bridge, s2, 30_000);
  log(`  banner after ${Date.now() - t2} ms: ${JSON.stringify(b2)}`);
  assert(b2.reason === "model", "the banner says the model was refused");
  assert(b2.title === "not-a-model isn't available on your default Claude Code account", `plain title ("${b2.title}")`);
  assert(b2.body.includes("There's an issue with the selected model (not-a-model). It may not exist or you may not have access to it.") && b2.body.includes("Nothing ran."), "Claude's own line and \"Nothing ran.\"");
  assert(b2.actions.map((a) => a.kind).join(",") === "retry-default,pick-model", `offers Retry with default model and Pick another model (${b2.actions.map((a) => a.text).join(" | ")})`);
  assert(bannerMs < 15_000, `within seconds (${bannerMs} ms)`);
  const rec2 = await waitStopped(s2, "the refused launch to end", 15_000);
  log(`  the fake: exit ${JSON.stringify(rec2.exit)}; alive ${pidAlive(rec2.pid)}; hooks ${rec2.hooksRan.length}; turns ${rec2.turns.length}`);
  // POSIX: SIGTERM, which the fake records; Windows: the process tree is
  // ended (TerminateProcess), so the fake records nothing and is just gone.
  assert(onWindows ? !pidAlive(rec2.pid) : rec2.exit?.why === "SIGTERM", `Hermes stopped the agent (${rec2.exit?.why ?? "process gone"})`);
  assert(rec2.hooksRan.length === 0 && rec2.turns.length === 0 && rec2.prompts.length === 0, "nothing ran: no hook, no turn, no prompt");
  await waitForTerminalText(bridge, s2, (t) => t.includes("hermes: claude refused this launch; Hermes stopped it."), "hi's stop line", 15_000);
  const snap2 = await bridge.eval(`return window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(s2)});`);
  const ev = snap2.events.find((e) => e.type === "launch_rejected");
  assert(ev && ev.reason === "model" && ev.suggestion === "retry-default" && ev.source === "hermes", "the session got the launch_rejected event");
  await bridge.screenshot(join(evidenceDir, "03-refused-banner.png"));

  log("        Retry with default model starts it again without --model, and it runs");
  const seen2 = new Set(recordsOf(s2).map((r) => r.file));
  await clickAction(bridge, s2, "retry-default");
  const rec2b = await waitForRecord(f, "the retry", (r) => r.env?.HERMES_SESSION_ID === s2 && !seen2.has(r.file) && r.hooksRan?.some((h) => h.event === "SessionStart"), 30_000);
  assert(!rec2b.argv.includes("--model"), `the retry has no --model (${JSON.stringify(rec2b.argv)})`);
  assert(rec2b.prompt?.startsWith("CAP two"), "and still carries the task as its first prompt");
  await bridge.waitFor("the banner to go", `return !e2e.first('.launch-rejected[data-session-id="${s2}"]');`);
  await bridge.screenshot(join(evidenceDir, "04-retried.png"));

  // ─── 3. Codex's reconnect loop is cut short ────────────────────────
  log("step 3: Codex with a listed model the account refuses: stopped at the first 404, not after a minute");
  const t3 = Date.now();
  const s3 = await launchWithChoice(bridge, { agentId: "codex", cwd: f.repo, task: "CAP three", modelId: "gpt-fake-old", effort: "medium" });
  const rec3start = await waitForRecord(f, "the codex launch", (r) => r.env?.HERMES_SESSION_ID === s3);
  assert(rec3start.argv.join(" ").includes('-m gpt-fake-old') && rec3start.argv.join(" ").includes('-c model_reasoning_effort="medium"'), `codex got -m and -c model_reasoning_effort (${JSON.stringify(rec3start.argv)})`);
  const { banner: b3 } = await waitForBanner(bridge, s3, 30_000);
  const rec3 = await waitStopped(s3, "codex to be stopped", 20_000);
  const stoppedAfter = Date.now() - t3;
  log(`  codex stopped after ${stoppedAfter} ms (${JSON.stringify(rec3.exit)}); banner: ${b3.title}`);
  assert(b3.reason === "model" && b3.body.includes("The model `gpt-fake-old` does not exist or you do not have access to it."), "Codex's own 404 line");
  assert(stoppedAfter < 20_000 && (rec3.exit?.t ?? 0) < 20_000, `the minute of reconnecting was cut short (${stoppedAfter} ms)`);
  const codexCaps = await invoke(bridge, "get_agent_capabilities", { agentId: "codex", accountId: null, refresh: false });
  const old = codexCaps.models.find((m) => m.id === "gpt-fake-old");
  log(`  codex models: ${codexCaps.models.map((m) => `${m.id}${m.available ? "" : " (off)"}`).join(", ")}`);
  assert(codexCaps.modelSource === "cli-list" && old && old.available === false && /refused by this account/.test(old.unavailableReason), "the refused model is off in Codex's capabilities now");
  await bridge.screenshot(join(evidenceDir, "05-codex-refused.png"));

  // ─── 4. a signed-out account ───────────────────────────────────────
  log("step 4: a second Claude account whose profile is not signed in: refused, Sign in, Try again");
  const added = await invoke(bridge, "add_agent_account", { agentId: "claude", label: "Work" });
  log(`  added: ${JSON.stringify(added)}`);
  assert(added.account.id === "work" && added.account.signInState === "signed-out" && !added.reused, "Work is a new, signed-out profile");
  assert(added.account.profileEnv?.name === "CLAUDE_CONFIG_DIR" && existsSync(added.account.profileEnv.value), "its profile folder exists (in the test's profile root)");
  const s4 = await launchWithChoice(bridge, { agentId: "claude", cwd: f.repo, task: "CAP four", accountId: "work" });
  const { banner: b4 } = await waitForBanner(bridge, s4, 30_000);
  log(`  banner: ${JSON.stringify(b4)}`);
  assert(b4.reason === "signed_out" && b4.title === "Claude Code is not signed in on your Work account", `signed out, in plain words ("${b4.title}")`);
  const rec4 = await waitForRecord(f, "the signed-out launch", (r) => r.env?.HERMES_SESSION_ID === s4);
  assert(rec4.profileDir === added.account.profileEnv.value, "the agent ran with the Work profile");
  const idsBefore = await bridge.terminalIds();
  await clickAction(bridge, s4, "sign-in");
  const login = await (async () => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const l = logins(f).find((x) => x.profileDir === added.account.profileEnv.value);
      if (l) return l;
      if (Date.now() > deadline) throw new Error("no sign-in ran in the Work profile");
      await sleep(200);
    }
  })();
  assert(login.argv.join(" ") === "auth login" && login.profileEnv === "CLAUDE_CONFIG_DIR", "Sign in ran `claude auth login` with CLAUDE_CONFIG_DIR set to the Work profile");
  const idsAfter = await bridge.terminalIds();
  assert(idsAfter.some((id) => !idsBefore.includes(id)), "in a terminal of its own");
  const seen4 = new Set(recordsOf(s4).map((r) => r.file));
  await clickAction(bridge, s4, "try-again");
  const rec4b = await waitForRecord(f, "the second try", (r) => r.env?.HERMES_SESSION_ID === s4 && !seen4.has(r.file) && r.hooksRan?.some((h) => h.event === "SessionStart"), 30_000);
  assert(rec4b.profileDir === added.account.profileEnv.value, "Try again runs the agent in the (now signed-in) Work profile");
  await bridge.screenshot(join(evidenceDir, "06-signed-in.png"));

  const exit = await app.stop();
  assert(exit.code === 0, "the app quit cleanly");

  // ─── 5. a restart resumes each agent with its choice ───────────────
  log("step 5: after a restart, each agent resumes in its account's profile with its model and effort");
  const seenBefore = new Set(records(f).map((r) => r.file));
  app = await launch(f, evidenceDir, log, 2);
  const s1bBack = await waitForRecord(f, "the opus session resumed", (r) => !seenBefore.has(r.file) && r.env?.HERMES_SESSION_ID === s1b, 60_000);
  log(`  resumed ${s1b}: ${JSON.stringify(s1bBack.argv.filter((a) => !a.includes("/")))}`);
  assert(s1bBack.resumeIdArg && s1bBack.model === "opus" && s1bBack.effort === "high", "the opus session resumed its conversation with --model opus --effort high");
  const s4Back = await waitForRecord(f, "the Work session resumed", (r) => !seenBefore.has(r.file) && r.env?.HERMES_SESSION_ID === s4, 60_000);
  assert(s4Back.profileDir === added.account.profileEnv.value, "the Work session resumed in the Work profile");
  const restoredChip = await chip(app.bridge, s1b);
  log(`  chip after restart: ${JSON.stringify(restoredChip)}`);
  assert(restoredChip && /opus/.test(restoredChip.text), "its model chip still shows opus");
  const exit2 = await app.stop();
  assert(exit2.code === 0, "the app quit cleanly again");
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      for (const id of (await app.bridge.terminalIds()) ?? []) log(`  terminal ${id}:\n${(await terminalText(app.bridge, id)).split("\n").slice(-12).join("\n")}`);
    }
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  if (app?.isRunning()) await app.stop();
  try {
    cpSync(f.recordDir, join(evidenceDir, "fake-records"), { recursive: true });
  } catch {
    /* nothing recorded */
  }
  restorePath?.();
  removeWork(f, log);
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
