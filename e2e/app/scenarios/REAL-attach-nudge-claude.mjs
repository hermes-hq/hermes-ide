#!/usr/bin/env node
// Scenario REAL-attach-nudge-claude (local only): a project attached to a
// running terminal-mode Claude Code session through the pane's "+" picker
// reaches the REAL `claude` CLI as a prompt: "Read the file at
// $HERMES_CONTEXT for project context about the attached workspaces."
// Proof is Claude's own transcript (a user message, or a queued one it took
// in during a turn), not the screen.
//
//   1. fresh: claude (haiku) idle, attach a project: sent
//   2. busy: attach while Claude works on a turn: sent (Claude queues it)
//   3. typed then cleared: the person types text and deletes it with
//      Backspace; attach: nothing is typed while text may be on the line;
//      once the person sends a prompt and Claude waits again: sent
//   4. app restart: the app is killed and relaunched; the session reattaches
//      to the same Claude in the session host; attach: sent
//   5. the same after more output than the host keeps for a replay (a long
//      session: Claude's banner is no longer in what the app reads back)
//
// Before the fix (2.3.1, claude 2.1.296) every case failed: the nudge typed
// in one burst was a paste to Claude (its Enter only a new line, the text
// left unsent in the input), a long session was no longer recognised after
// the restart, a nudge kept for later never went out, and Done pressed
// while the attach was finishing sent nothing.
//
// It runs only with a signed-in `claude` on PATH, macOS or Linux, and never
// in CI (RESULT: SKIP otherwise; e2e/app/ci-plan.mjs excludes it).
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/REAL-attach-nudge-claude.mjs

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";
import { domKey } from "../qa-host-steps.mjs";
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
} from "../real-steps.mjs";

const SCENARIO = "REAL-attach-nudge-claude";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);

const NUDGE = /Read the file at \$HERMES_CONTEXT for project context about the attached workspaces/;
let failures = 0;
function check(condition, message) {
  if (condition) log(`  ok — ${message}`);
  else {
    failures++;
    log(`  NOT OK — ${message}`);
  }
}

const cli = requireRealCli("claude", log, { scenario: SCENARIO, evidenceDir });
const guarded = guard([join(home, ".claude", "settings.json")], log);
const repo = throwawayRepo("real-nudge-claude", { "notes.txt": "alpha\n" });
const extras = ["one", "two", "three", "four", "five"].map((n) => throwawayRepo(`real-nudge-extra-${n}`));
const profileRoot = tempProfileRoot("real-nudge-claude");

async function backendSession(bridge, sid) {
  const all = await bridge.eval(`return await window.__TAURI_INTERNALS__.invoke("get_sessions");`);
  const s = all.find((x) => x.id === sid);
  return s ? { phase: s.phase, detected_agent: s.detected_agent?.name ?? null, ai_provider: s.ai_provider ?? null } : null;
}

/** Times the nudge line shows in Claude's terminal (in its input, or sent). */
async function nudgeCount(bridge, sid) {
  const flat = (await terminalText(bridge, sid)).replace(/\s*\n\s*/g, " ");
  return (flat.match(new RegExp(NUDGE.source, "g")) || []).length;
}

/**
 * Times Claude took the nudge as a prompt: the user messages (and the
 * queued ones it took in during a turn) in its own transcript (~/.claude/projects/<the repo's folder>/*.jsonl). The screen
 * cannot say: a reattach replays and redraws it.
 */
function nudgesSent() {
  const root = join(home, ".claude", "projects");
  const base = repo.split("/").pop();
  let n = 0;
  if (!existsSync(root)) return 0;
  for (const dir of readdirSync(root).filter((d) => d.endsWith(base))) {
    for (const f of readdirSync(join(root, dir)).filter((x) => x.endsWith(".jsonl"))) {
      for (const line of readFileSync(join(root, dir, f), "utf8").split("\n")) {
        try {
          const r = JSON.parse(line);
          // A prompt, or one Claude queued while busy and took in mid-turn.
          if (r.type === "user" && NUDGE.test(JSON.stringify(r.message?.content ?? ""))) n++;
          else if (r.attachment?.type === "queued_command" && NUDGE.test(r.attachment.prompt ?? "")) n++;
        } catch {
          /* not a record */
        }
      }
    }
  }
  return n;
}

/** Claude started a turn (its UserPromptSubmit hook) after `since`. */
async function turnStartedSince(bridge, sid, since) {
  const snap = await snapshot(bridge, sid);
  return snap.events.some((e) => e.type === "turn_start" && e.at >= since - 200);
}

/** Attach `folder` through the pane's "+" and the picker's folder field, then Done. */
async function attachThroughPicker(bridge, folder) {
  await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.first(".split-pane")?.querySelector(".scope-bar-add"), "the pane's + (add project)"));`);
  await bridge.waitFor("the project picker", `return !!e2e.first(".project-picker");`);
  await bridge.eval(`
    const input = e2e.must(e2e.first(".project-picker-scan-input"), "folder field");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(folder)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  `);
  await bridge.clickByName("Scan", { within: ".project-picker-footer" });
  const name = folder.split("/").pop();
  await bridge.waitFor(`${name} attached in the picker`, `return e2e.all(".project-picker-item-attached").some((el) => el.innerText.includes(${JSON.stringify(name)}));`, { timeoutMs: 20_000 });
  const stillRunning = await bridge.eval(`return e2e.norm(e2e.first(".project-picker-browse")?.innerText || "") === "...";`);
  await bridge.clickByName("Done", { within: ".project-picker-footer" });
  await bridge.waitFor("the project picker to close", `return !e2e.first(".project-picker");`);
  log(`  attached ${name} (Done pressed while the attach was still running: ${stillRunning})`);
}

/** Wait until Claude waits for input again (its Stop hook after `since`). */
async function waitTurnEnd(bridge, sid, since, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = await snapshot(bridge, sid);
    if (turnEnded({ events: snap.events.filter((e) => e.at >= since - 500) })) return true;
    if (Date.now() > deadline) return false;
    if (snap.status?.kind === "needs_approval") {
      await bridge.typeInTerminal(sid, "\r");
      await sleep(1500);
    }
    await sleep(500);
  }
}

/** A webview starved of CPU (Claude streaming) can miss one answer: try again. */
async function patient(fn, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries || !/did not (answer|finish)/.test(String(e?.message ?? e))) throw e;
      log(`  (the webview was busy; trying again: ${String(e.message).slice(0, 80)})`);
      await sleep(2000);
    }
  }
}

/** The person sends a prompt, as from the keyboard. */
async function sendPrompt(bridge, sid, text) {
  await patient(() => bridge.typeInTerminal(sid, text));
  await sleep(500);
  await patient(() => bridge.typeInTerminal(sid, "\r"));
}

/**
 * Attach, then report within `windowMs` whether the nudge line showed in
 * Claude's terminal (typed) and whether Claude took it as a prompt (sent).
 */
async function attachAndWatch(bridge, sid, folder, label, windowMs = 15_000) {
  const before = await nudgeCount(bridge, sid);
  const sentBefore = nudgesSent();
  log(`  ${label}: backend before attach: ${JSON.stringify(await backendSession(bridge, sid))}`);
  const since = Date.now();
  await attachThroughPicker(bridge, folder);
  const deadline = Date.now() + windowMs;
  let typed = false;
  let sent = false;
  while (Date.now() < deadline && !sent) {
    sent = nudgesSent() > sentBefore;
    typed = sent || typed || (await nudgeCount(bridge, sid)) > before;
    await sleep(500);
  }
  log(`  ${label}: nudge line typed: ${typed}; sent as a prompt: ${sent}`);
  if (sent) await waitTurnEnd(bridge, sid, since);
  else if (typed) {
    // Left in Claude's input: clear it (Ctrl+C) so the next case starts clean.
    await bridge.typeInTerminal(sid, "\x03");
    await sleep(1500);
  }
  return { typed, sent };
}

async function onboard(bridge) {
  await bridge.waitFor("the app", `return !!e2e.first(".onboarding-dialog, .setup-dialog, .topbar");`, { timeoutMs: 30_000 });
  await sleep(2000);
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
  }
  if (await bridge.exists(".whatsnew-backdrop")) await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
}

function relaunch(run) {
  return launchApp({
    runDir: join(evidenceDir, `run-${run}`),
    log,
    home: "real",
    resetData: false,
    tmp: "shared",
    flagDefaults: { taskLauncher: false },
    env: { HERMES_E2E_PROFILE_ROOT: profileRoot },
  });
}

/** The tty of the `claude` process under the session's launch tree. */
function claudeTty(sessionId) {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,tty=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const rows = out.split("\n").map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean);
  const hi = rows.find((r) => new RegExp(`(^|/)hi run ${sessionId}(\\s|$)`).test(r[4]));
  return hi ? `/dev/${hi[3]}` : null;
}

let app;
let sid;
let failed = false;
try {
  log(`scenario: ${SCENARIO}   claude: ${cli.path} (${cli.version})   repo: ${repo}`);
  app = await launchRealApp(evidenceDir, log, profileRoot);
  await onboard(app.bridge);
  let bridge = app.bridge;

  log("start: claude on haiku in terminal mode, idle");
  sid = await launchWithChoice(bridge, { agentId: "claude", cwd: repo, modelId: "haiku" });
  await answerTrustPrompts(bridge, sid, log, async () => (await snapshot(bridge, sid)).events.some((e) => String(e.source ?? "").startsWith("hook")), { timeoutMs: 60_000 });
  await bridge.waitFor("Claude's input box", `return (window.__HERMES_E2E__.readTerminal(${JSON.stringify(sid)}) || []).some((l) => /for shortcuts|│ >|^> |❯/.test(l));`, { timeoutMs: 60_000 }).catch(() => null);
  await sleep(4000);

  log("case 1: fresh session, Claude idle");
  const c1 = await attachAndWatch(bridge, sid, extras[0], "fresh");
  check(c1.sent, "fresh: the nudge reached Claude as a prompt");
  await bridge.screenshot(join(evidenceDir, "01-fresh.png"));

  log("case 2: Claude busy on a turn");
  let t0 = Date.now();
  await sendPrompt(bridge, sid, "Write the numbers from 1 to 150 in English words, one per line, nothing else.");
  for (let i = 0; i < 60 && !(await turnStartedSince(bridge, sid, t0)); i++) await sleep(250);
  log(`  busy: Claude's turn started: ${await turnStartedSince(bridge, sid, t0)}`);
  const c2 = await attachAndWatch(bridge, sid, extras[1], "busy", 90_000);
  check(c2.sent, "busy: the nudge reached Claude as a prompt");
  await waitTurnEnd(bridge, sid, Date.now() - 1000, 60_000);
  await bridge.screenshot(join(evidenceDir, "02-busy.png"));

  log("case 3: text typed, then deleted with Backspace");
  await patient(() => bridge.typeInTerminal(sid, "hello"));
  await sleep(300);
  for (let i = 0; i < 5; i++) await domKey(bridge, sid, { key: "Backspace", code: "Backspace" }, 8);
  await sleep(800);
  const c3 = await attachAndWatch(bridge, sid, extras[2], "typed-then-cleared", 10_000);
  if (!c3.sent) {
    log("  the person sends a prompt; Claude answers and waits again");
    const shown = nudgesSent();
    t0 = Date.now();
    await sendPrompt(bridge, sid, "Reply with the single word ok.");
    await waitTurnEnd(bridge, sid, t0);
    const after = Date.now();
    let later = false;
    for (let i = 0; i < 40 && !later; i++) {
      const snap = await snapshot(bridge, sid);
      later = snap.events.some((e) => e.type === "turn_start" && e.at >= after - 200) && nudgesSent() > shown;
      await sleep(500);
    }
    log(`  typed-then-cleared: the nudge went out after the next turn: ${later}`);
    check(later, "typed-then-cleared: the deferred nudge went out once Claude waited again");
    if (later) await waitTurnEnd(bridge, sid, after);
  } else check(true, "typed-then-cleared: the nudge reached Claude as a prompt");
  await bridge.screenshot(join(evidenceDir, "03-typed-cleared.png"));

  log("case 4: the app is killed and relaunched; the session reattaches");
  app.child.kill("SIGKILL");
  await sleep(2500);
  app = await relaunch(2);
  bridge = app.bridge;
  await onboard(bridge);
  await bridge.waitFor("the session back", `return window.__HERMES_E2E__.terminalIds().includes(${JSON.stringify(sid)});`, { timeoutMs: 30_000 });
  await sleep(5000);
  const c4 = await attachAndWatch(bridge, sid, extras[3], "after restart");
  check(c4.sent, "after restart: the nudge reached Claude as a prompt");
  await bridge.screenshot(join(evidenceDir, "04-restart.png"));

  log("case 5: more output than the host replays, then a restart");
  const tty = claudeTty(sid);
  log(`  claude's terminal: ${tty}`);
  if (tty) {
    const line = `${"x".repeat(150)}\r\n`;
    writeFileSync(tty, line.repeat(Math.ceil((2.5 * 1024 * 1024) / line.length)));
    await sleep(3000);
    app.child.kill("SIGKILL");
    await sleep(2500);
    app = await relaunch(3);
    bridge = app.bridge;
    await onboard(bridge);
    await bridge.waitFor("the session back", `return window.__HERMES_E2E__.terminalIds().includes(${JSON.stringify(sid)});`, { timeoutMs: 30_000 });
    await sleep(5000);
    const c5 = await attachAndWatch(bridge, sid, extras[4], "after restart, long session");
    check(c5.sent, "after restart of a long session: the nudge reached Claude as a prompt");
    await bridge.screenshot(join(evidenceDir, "05-restart-long.png"));
  } else check(false, "found claude's terminal device");

  writeFileSync(join(evidenceDir, "terminal.txt"), await terminalText(bridge, sid));
  await quitAgent(bridge, sid, "/exit");
  await app.stop();
  app = null;
  guarded.check((c, m) => check(c, m));
  if (failures) throw new Error(`${failures} check(s) failed`);
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      if (sid) writeFileSync(join(evidenceDir, "terminal.txt"), await terminalText(app.bridge, sid));
    }
  } catch {
    /* no screenshot */
  }
} finally {
  if (app?.isRunning()) await app.stop({ stopPrograms: true }).catch(() => {});
  guarded.restore();
  cleanup([repo, ...extras, profileRoot]);
}
finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
