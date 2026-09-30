#!/usr/bin/env node
// Scenario CAP-refusal-safety: Hermes stops a launch only for the CLI's own
// refusal, never for words that merely look like one, and a refused resume
// is resumed again. Fake `claude` and `codex` CLIs
// (tools/fake-agents/fake-cli.mjs) stand in for the real ones.
//
//   1. Two launches whose words look like refusals, all shown in the
//      terminal while the watch is on: Codex with the task "Fix the 401
//      Unauthorized error on the login page" (the reproduction that was
//      stopped 43 ms after its start); Claude with a task that quotes Claude
//      Code's "Not logged in · Please run /login", drawn wrapped so that a
//      row starts with those words; and both agents answering with their
//      CLI's refusal words behind their reply marks. Several seconds later
//      neither is stopped: no banner, no launch_rejected event, both fakes
//      still running.
//   2. After a restart the Claude session resumes while its account is
//      signed out. The CLI replays the conversation (which holds those
//      words) and waits: nothing is stopped. The first message is refused
//      ("Not logged in · Please run /login"): the banner says signed out and
//      Hermes stops the agent.
//   3. Signed in again, Try again resumes the SAME conversation (the fake's
//      --resume id is the first launch's --session-id), and although the
//      replay now holds the refusal itself, the agent keeps running.
//   4. After another restart the CLI first shows its trust prompt, and the
//      person accepts it with Enter; the replay that follows that Enter
//      (which holds the refusal line) stops nothing, and neither does the
//      first message, which the CLI sends (its UserPromptSubmit hook runs)
//      and answers.
//
// Negative controls (each must FAIL):
//   HERMES_E2E_CAP_SAFETY_NEGATIVE=echo    the first app run reads passed-in
//     text and replays like any output (HERMES_E2E_REFUSAL_WATCH=unfiltered):
//     step 1 stops the Claude launch.
//   HERMES_E2E_CAP_SAFETY_NEGATIVE=replay  the same for the second run only:
//     step 2 stops the resumed agent before its first message.
//   HERMES_E2E_CAP_SAFETY_NEGATIVE=fresh   a relaunch starts a new
//     conversation (HERMES_E2E_RELAUNCH_FRESH=1): step 3's resume check fails.
//   HERMES_E2E_CAP_SAFETY_NEGATIVE=trust   the third app run ends a resume's
//     replay at its first Enter, not at the prompt hook
//     (HERMES_E2E_REFUSAL_WATCH=first-enter, the behaviour before the fix):
//     step 4 stops the signed-in agent after the trust prompt.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/CAP-refusal-safety.mjs
//
// Evidence (log, screenshots, the fakes' records) goes to HERMES_E2E_EVIDENCE,
// or <out dir>/evidence/CAP-refusal-safety.

import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLogger, finishScenario, outDir, sleep, skipScenario } from "../harness.mjs";
import {
  completeOnboarding,
  launch,
  launchWithChoice,
  onWindows,
  records,
  registryPath,
  removeWork,
  setFake,
  setFakeMode,
  setupFakes,
  terminalText,
  waitForRecord,
  waitForTerminalText,
} from "../cap-steps.mjs";

const SCENARIO = "CAP-refusal-safety";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);
const NEGATIVE = process.env.HERMES_E2E_CAP_SAFETY_NEGATIVE || "";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

const f = setupFakes("cap-safety", ["claude", "codex"]);
const restorePath = registryPath(f, log);
if (restorePath === null) {
  log("this scenario needs the fake agents on a Windows terminal's PATH, which means the user's registry Path; that is only changed on a CI runner");
  skipScenario({ scenario: SCENARIO, evidenceDir, reason: "Windows outside CI", log });
}

/** How long "nothing happened" is watched for. */
const QUIET_MS = 6_000;
const CODEX_TASK = "Fix the 401 Unauthorized error on the login page";
// Wrapped at 40 columns by the fake, its second row is exactly Claude Code's
// signed-out line.
const CLAUDE_TASK = "Users report this error after SSO today: Not logged in · Please run /login appears";

const recordsOf = (sid) => records(f).filter((r) => r.env?.HERMES_SESSION_ID === sid);
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
async function waitStopped(sid, what, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rec = recordsOf(sid).at(-1);
    if (rec && (rec.exit || !pidAlive(rec.pid))) return rec;
    if (Date.now() > deadline) throw new Error(`${what}: the fake still runs after ${timeoutMs} ms`);
    await sleep(150);
  }
}
const banner = (bridge, sid) =>
  bridge.eval(`
    const b = e2e.first('.launch-rejected[data-session-id="${sid}"]');
    if (!b) return null;
    return {
      reason: b.dataset.reason,
      title: e2e.norm(b.querySelector(".launch-rejected-title").innerText),
      body: e2e.norm(b.querySelector(".launch-rejected-body").innerText),
      actions: [...b.querySelectorAll(".launch-rejected-action")].map((a) => a.dataset.action),
    };
  `);
const rejectedEvents = async (bridge, sid) => {
  const snap = await bridge.eval(`return window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(sid)});`);
  return (snap?.events ?? []).filter((e) => e.type === "launch_rejected");
};
/** Nothing stops the session's agent for QUIET_MS: no banner, no event, the fake runs. */
async function staysRunning(bridge, sid, what) {
  const rec = recordsOf(sid).at(-1);
  const before = (await rejectedEvents(bridge, sid)).length;
  const deadline = Date.now() + QUIET_MS;
  while (Date.now() < deadline) {
    const b = await banner(bridge, sid);
    if (b) throw new Error(`ASSERTION FAILED: ${what} was stopped as refused: ${JSON.stringify(b)}`);
    await sleep(250);
  }
  const now = recordsOf(sid).find((r) => r.file === rec.file);
  assert(!now.exit && pidAlive(now.pid), `${what}: its agent still runs after ${QUIET_MS / 1000} s (no exit recorded)`);
  assert((await rejectedEvents(bridge, sid)).length === before, `${what}: no new launch_rejected event`);
}

let app;
let failed = false;
try {
  log(`scenario: ${SCENARIO}${NEGATIVE ? ` (NEGATIVE CONTROL: ${NEGATIVE})` : ""}`);
  setFakeMode(f, "wrap-prompt quote-errors");
  app = await launch(f, evidenceDir, log, 1, { first: true, env: NEGATIVE === "echo" ? { HERMES_E2E_REFUSAL_WATCH: "unfiltered" } : {} });
  let { bridge } = app;
  await completeOnboarding(bridge);

  // ─── 1. words that look like refusals ─────────────────────────────
  log("step 1: a task and answers with a refusal's words stop nothing");
  const cx = await launchWithChoice(bridge, { agentId: "codex", cwd: f.repo, task: CODEX_TASK });
  const cl = await launchWithChoice(bridge, { agentId: "claude", cwd: f.repo, task: CLAUDE_TASK });
  assert(typeof cx === "string" && typeof cl === "string", `two sessions started (${cx}, ${cl})`);
  const cxRec = await waitForRecord(f, "the codex launch", (r) => r.env?.HERMES_SESSION_ID === cx);
  const clRec = await waitForRecord(f, "the claude launch", (r) => r.env?.HERMES_SESSION_ID === cl);
  assert(cxRec.prompt?.startsWith(CODEX_TASK) && clRec.prompt?.startsWith(CLAUDE_TASK), "each agent got its task as its first prompt");
  await waitForTerminalText(bridge, cx, (t) => t.includes("Fix the 401 Unauthorized error on the") && t.includes("• ERROR: unexpected status 401 Unauthorized"), "codex's task and its answer", 30_000);
  const clText = await waitForTerminalText(bridge, cl, (t) => t.includes("⏺ Not logged in · Please run /login") && t.includes("fake-cli: ready"), "claude's task and its answer", 30_000);
  const rows = clText.split("\n").map((r) => r.trim());
  assert(rows.some((r) => r.startsWith("Not logged in · Please run /login")), "a row of Claude's task starts with Claude Code's own signed-out words");
  await staysRunning(bridge, cx, "Codex (task: Fix the 401 Unauthorized error)");
  await staysRunning(bridge, cl, "Claude (task quoting Not logged in)");
  await bridge.screenshot(join(evidenceDir, "01-nothing-stopped.png"));
  const conversation = clRec.sessionIdArg;
  assert(typeof conversation === "string" && conversation.length > 0, `Claude's conversation id: ${conversation}`);

  const exit = await app.stop();
  assert(exit.code === 0, "the app quit cleanly");

  // ─── 2. a refused resume ──────────────────────────────────────────
  log("step 2: after a restart, signed out: the replay stops nothing, the first message is refused");
  setFake(f, "auth", "claude", "out");
  setFakeMode(f, "refuse-signed-out");
  const seenBefore = new Set(records(f).map((r) => r.file));
  app = await launch(f, evidenceDir, log, 2, { env: NEGATIVE === "replay" ? { HERMES_E2E_REFUSAL_WATCH: "unfiltered" } : NEGATIVE === "fresh" ? { HERMES_E2E_RELAUNCH_FRESH: "1" } : {} });
  bridge = app.bridge;
  const resumed = await waitForRecord(f, "the claude session resumed", (r) => !seenBefore.has(r.file) && r.env?.HERMES_SESSION_ID === cl, 60_000);
  assert(resumed.resumeIdArg === conversation, `it resumed its conversation (--resume ${resumed.resumeIdArg})`);
  await waitForTerminalText(bridge, cl, (t) => t.includes("earlier in this conversation:") && /resumed from/.test(t) && t.split("earlier in this conversation:").at(-1).includes("fake-cli: ready"), "the replay, then ready", 30_000);
  await staysRunning(bridge, cl, "the resumed Claude, before its first message");
  await bridge.screenshot(join(evidenceDir, "02-replayed.png"));

  log("        the first message");
  const t2 = Date.now();
  await bridge.typeInTerminal(cl, "hello\n");
  await bridge.waitFor("the refusal banner", `return !!e2e.first('.launch-rejected[data-session-id="${cl}"]');`, { timeoutMs: 20_000, intervalMs: 100 });
  const b2 = await banner(bridge, cl);
  log(`  banner after ${Date.now() - t2} ms: ${JSON.stringify(b2)}`);
  assert(b2.reason === "signed_out" && b2.body.includes("Not logged in · Please run /login"), "the banner says signed out, in Claude Code's words");
  assert(b2.actions.includes("try-again"), `it offers Try again (${b2.actions.join(", ")})`);
  const stopped = await waitStopped(cl, "the refused resume to end", 15_000);
  assert(onWindows ? !pidAlive(stopped.pid) : stopped.exit?.why === "SIGTERM", `Hermes stopped the agent (${stopped.exit?.why ?? "process gone"})`);
  await bridge.screenshot(join(evidenceDir, "03-refused-resume.png"));

  // ─── 3. Try again resumes the same conversation ───────────────────
  log("step 3: signed in again, Try again resumes the same conversation and its replay stops nothing");
  setFake(f, "auth", "claude", "in");
  setFakeMode(f, "normal");
  const seen3 = new Set(recordsOf(cl).map((r) => r.file));
  await bridge.clickWhenReady(`
    const b = e2e.must(e2e.first('.launch-rejected[data-session-id="${cl}"]'), "the banner");
    return e2e.click(e2e.must([...b.querySelectorAll(".launch-rejected-action")].find((a) => a.dataset.action === "try-again"), "Try again"));
  `);
  const again = await waitForRecord(f, "the second try", (r) => r.env?.HERMES_SESSION_ID === cl && !seen3.has(r.file), 30_000);
  log(`  argv: ${JSON.stringify(again.argv.filter((a) => !a.includes("/") && !a.includes("\\")))}`);
  assert(again.resumeIdArg === conversation && !again.sessionIdArg, `Try again resumed the same conversation (--resume ${again.resumeIdArg ?? "none"}, --session-id ${again.sessionIdArg ?? "none"})`);
  await waitForTerminalText(bridge, cl, (t) => t.includes(`(resumed from ${conversation})`) && t.split("earlier in this conversation:").at(-1).includes("fake-cli: ready"), "the resumed conversation, ready", 30_000);
  const replay = (await terminalText(bridge, cl)).split("earlier in this conversation:").at(-1);
  assert(replay.split("\n").some((r) => r.trim() === "Not logged in · Please run /login"), "its replay holds the refusal line itself");
  await bridge.waitFor("the banner to go", `return !e2e.first('.launch-rejected[data-session-id="${cl}"]');`);
  await staysRunning(bridge, cl, "the resumed Claude after Try again");
  const hooks = recordsOf(cl).find((r) => r.file === again.file).hooksRan.map((h) => h.event);
  assert(hooks.includes("SessionStart"), "and it started (its SessionStart hook ran)");
  await bridge.screenshot(join(evidenceDir, "04-resumed-again.png"));

  const exit2 = await app.stop();
  assert(exit2.code === 0, "the app quit cleanly again");

  // ─── 4. Enter at a trust prompt shown before the replay ───────────
  log("step 4: after a restart the CLI asks for trust first; Enter there, then the replay with the refusal line, stops nothing");
  setFakeMode(f, "trust-prompt prompts");
  const seen4 = new Set(recordsOf(cl).map((r) => r.file));
  app = await launch(f, evidenceDir, log, 3, { env: NEGATIVE === "trust" ? { HERMES_E2E_REFUSAL_WATCH: "first-enter" } : {} });
  bridge = app.bridge;
  const trusted = await waitForRecord(f, "the claude session resumed behind its trust prompt", (r) => r.env?.HERMES_SESSION_ID === cl && !seen4.has(r.file), 60_000);
  assert(trusted.resumeIdArg === conversation, `it resumed its conversation (--resume ${trusted.resumeIdArg})`);
  await waitForTerminalText(bridge, cl, (t) => t.includes("Do you trust the files in this folder?"), "the trust prompt", 30_000);
  await bridge.screenshot(join(evidenceDir, "05-trust-prompt.png"));
  await sleep(300);
  await bridge.typeInTerminal(cl, "\r");
  await waitForTerminalText(bridge, cl, (t) => t.includes("Trusted. Starting") && t.split("Trusted. Starting").at(-1).includes("earlier in this conversation:") && t.split("Trusted. Starting").at(-1).includes("fake-cli: ready"), "the replay after the trust prompt, then ready", 30_000);
  const replay4 = (await terminalText(bridge, cl)).split("Trusted. Starting").at(-1);
  assert(replay4.split("\n").some((r) => r.trim() === "Not logged in · Please run /login"), "the replay after the trust prompt holds the refusal line");
  await staysRunning(bridge, cl, "the resumed Claude after Enter at its trust prompt");
  await bridge.screenshot(join(evidenceDir, "06-trusted-replayed.png"));

  log("        the first message is sent and answered");
  await bridge.typeInTerminal(cl, "hello\r");
  const sent = await waitForRecord(f, "the first message's prompt hook", (r) => r.file === trusted.file && r.hooksRan?.some((h) => h.event === "UserPromptSubmit"), 20_000);
  assert(sent.prompts?.includes("hello"), "the CLI took the message (its UserPromptSubmit hook ran)");
  await staysRunning(bridge, cl, "the resumed Claude after its first message");
  await bridge.screenshot(join(evidenceDir, "07-first-message.png"));

  const exit3 = await app.stop();
  assert(exit3.code === 0, "the app quit cleanly a third time");
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      for (const id of (await app.bridge.terminalIds()) ?? []) log(`  terminal ${id}:\n${(await terminalText(app.bridge, id)).split("\n").slice(-14).join("\n")}`);
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
