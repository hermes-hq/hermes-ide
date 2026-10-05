#!/usr/bin/env node
// N13-resume-agents — README claim "Persistent conversations — Agent-view
// sessions come back after an app restart with the earlier conversation".
//
// The fake bridge (e2e/app/fixtures/fake-claude-bridge.mjs, started through
// HERMES_BRIDGE_PATH like the real one) logs how each process was started
// (its argv) and every message it receives, and writes the conversation
// where Claude Code keeps it (CLAUDE_CONFIG_DIR, a folder of this run).
//
//   run 1  fresh install: onboarding; a new Agent-view session for Claude;
//          one message and its answer. The bridge was started as a new
//          conversation (--session-id <id>). Quit.
//   run 2  the same data: the session is back, in Agent view (not a
//          terminal), and Hermes starts the agent again with
//          --resume <the same id>, so Claude continues that conversation.
//          The earlier message and its answer are drawn again, before
//          anything new. A new message gets an answer from the resumed
//          process, after them.
//
// Negative controls: HERMES_E2E_N13A_NEGATIVE=no-transcript runs without
// CLAUDE_CONFIG_DIR (Claude kept no transcript): the earlier messages are
// not drawn and the run must end in RESULT: FAIL. By reasoning: a build
// that restored the session as a terminal, or started a fresh conversation
// (--session-id) instead of resuming, fails the run 2 checks; the id
// compared is the one run 1's process was given.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N13-resume-agents.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, launchApp, sleep } from "../harness.mjs";
import { completeOnboarding, dismissWhatsNew, runScenario } from "../n11-steps.mjs";
import { sendAgentMessage, startAgentViewSession } from "../agent-setup-steps.mjs";

const SCENARIO = "N13-resume-agents";
const FIRST = "remember the word heliotrope";
const SECOND = "which word did I ask you to remember?";
const onWindows = platform() === "win32";
const NO_TRANSCRIPT = process.env.HERMES_E2E_N13A_NEGATIVE === "no-transcript";

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  const work = mkdtempSync(join(tmpdir(), "hermes-e2e-n13-agents-"));
  // Windows keeps app data under %APPDATA%, which a private HOME does not
  // move (see N07-feature-flags.mjs); there the test app's own data folder is used.
  const homeDir = onWindows ? undefined : mkdtempSync(join(tmpdir(), "hermes-e2e-n13-agents-home-"));
  onCleanup(() => {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    if (homeDir) rmSync(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const bridgeCopy = join(work, "fake-claude-bridge.mjs");
  copyFileSync(join(REPO_ROOT, "e2e", "app", "fixtures", "fake-claude-bridge.mjs"), bridgeCopy);
  const fakeLog = join(work, "fake-bridge.ndjson");
  const fakeEvents = () =>
    existsSync(fakeLog) ? readFileSync(fakeLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const starts = () => fakeEvents().filter((e) => e.event === "start");
  const argAfter = (argv, flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : null;
  };
  // Claude Code's folder for this run (never the machine's ~/.claude).
  const claudeConfig = join(work, "claude-config");
  const env = { HERMES_BRIDGE_PATH: bridgeCopy, HERMES_FAKE_BRIDGE_LOG: fakeLog, ...(NO_TRANSCRIPT ? {} : { CLAUDE_CONFIG_DIR: claudeConfig }) };
  if (NO_TRANSCRIPT) log("negative control: no CLAUDE_CONFIG_DIR, so no transcript");
  const launch = (run, { first = false } = {}) => {
    const runDir = join(evidenceDir, `run-${run}`);
    return onWindows
      ? launchApp({ runDir, log, home: "real", resetData: first, env })
      : launchApp({ runDir, log, home: "private", homeDir, env });
  };
  const viewText = (bridge, sid) =>
    bridge.eval(`return document.querySelector('.agent-session-view[data-session-id="' + CSS.escape(${JSON.stringify(sid)}) + '"]')?.innerText || "";`);

  /** Whether a session shows as Agent view (its view on screen) and how many terminals are on screen. */
  const viewMode = (bridge, sid) =>
    bridge.eval(`
      const v = document.querySelector('.agent-session-view[data-session-id="' + CSS.escape(${JSON.stringify(sid)}) + '"]');
      const onScreen = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
      return { agentView: !!v && onScreen(v), visibleTerminals: e2e.all(".xterm").filter(onScreen).length };`);

  // ── run 1 ────────────────────────────────────────────────────────
  log("run 1: a new Agent-view session, one message, quit");
  let app = await launch(1, { first: true });
  apps.push(app);
  const folder = join(realpathSync(work), "resume-repo");
  mkdirSync(folder, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", folder]);
  execFileSync("git", ["-C", folder, "-c", "user.name=Hermes Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"]);
  await completeOnboarding(app.bridge, log);
  const sid1 = await startAgentViewSession(app.bridge, log, { folder });
  await sendAgentMessage(app.bridge, log, FIRST);
  await app.bridge.waitFor("the first answer", `return (document.querySelector('.agent-session-view[data-session-id="' + CSS.escape(${JSON.stringify(sid1)}) + '"]')?.innerText || "").includes(${JSON.stringify(`fake reply: ${FIRST}`)});`, { timeoutMs: 30_000 });
  const firstStarts = starts();
  log(`  bridge starts so far: ${firstStarts.length}; last argv: ${JSON.stringify(firstStarts.at(-1)?.argv)}`);
  assert(firstStarts.length >= 1, "the agent process was started");
  const conversation = argAfter(firstStarts.at(-1).argv, "--session-id");
  assert(!!conversation && argAfter(firstStarts.at(-1).argv, "--resume") === null, `run 1 starts a new conversation (--session-id ${conversation})`);
  const mode1 = await viewMode(app.bridge, sid1);
  log(`  view before quitting: ${JSON.stringify(mode1)}`);
  assert(mode1.agentView && mode1.visibleTerminals === 0, "the session shows in Agent view");
  await app.bridge.screenshot(join(evidenceDir, "01-before-quit.png"));
  // Let the workspace save that follows the new session and its first turn land.
  await sleep(2_000);
  let exit = await app.stop();
  log(`  app exited: ${JSON.stringify(exit)}`);
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");
  const startsBefore = starts().length;

  // ── run 2 ────────────────────────────────────────────────────────
  log("run 2: relaunch on the same data");
  app = await launch(2);
  apps.push(app);
  await app.bridge.waitFor("the app UI (no onboarding this time)", `return !!e2e.first(".topbar-title, .topbar") && !e2e.first(".onboarding-backdrop");`);
  await dismissWhatsNew(app.bridge, log);
  const sid2 = await app.bridge.waitFor("the session back in Agent view", `
    const ids = e2e.all(".agent-session-view").map((e) => e.dataset.sessionId).filter(Boolean);
    return ids.length === 1 ? ids[0] : null;`, { timeoutMs: 30_000 });
  log(`  restored Agent-view session: ${sid2}`);
  const mode = await viewMode(app.bridge, sid2);
  log(`  restored view: ${JSON.stringify(mode)}`);
  assert(mode.agentView && mode.visibleTerminals === 0, "it came back in Agent view, not as a terminal");
  let restart = null;
  for (let i = 0; i < 60 && !restart; i++) {
    restart = starts().slice(startsBefore).at(-1) ?? null;
    if (!restart) await sleep(500);
  }
  log(`  bridge start after relaunch: ${JSON.stringify(restart?.argv)}`);
  assert(!!restart, "Hermes started the agent again for the restored session");
  assert(argAfter(restart.argv, "--resume") === conversation, `it resumes the same conversation (--resume ${conversation})`);
  assert(argAfter(restart.argv, "--session-id") === null, "it does not start a new conversation");
  const earlierShown = await app.bridge
    .waitFor("the earlier conversation drawn again", `
      const t = document.querySelector('.agent-session-view[data-session-id="' + CSS.escape(${JSON.stringify(sid2)}) + '"]')?.innerText || "";
      return t.includes(${JSON.stringify(FIRST)}) && t.includes(${JSON.stringify(`fake reply: ${FIRST}`)});`, { timeoutMs: 15_000 })
    .then(() => true, () => false);
  const shownAfter = await viewText(app.bridge, sid2);
  log(`  view after the restart: ${JSON.stringify(shownAfter.slice(0, 300))}`);
  await app.bridge.screenshot(join(evidenceDir, "02-restored.png"));
  assert(earlierShown, "the earlier message and its answer are drawn again after the restart");

  log("run 2: a new message gets an answer from the resumed agent");
  await sendAgentMessage(app.bridge, log, SECOND);
  await app.bridge.waitFor("the answer after the restart", `return (document.querySelector('.agent-session-view[data-session-id="' + CSS.escape(${JSON.stringify(sid2)}) + '"]')?.innerText || "").includes(${JSON.stringify(`fake reply: ${SECOND}`)});`, { timeoutMs: 30_000 });
  const answeredBy = fakeEvents().filter((e) => e.event === "input" && e.type === "user" && e.pid === restart.pid);
  assert(answeredBy.length === 1, "the message went to the resumed process");
  // textContent: messages scrolled out of view are not laid out
  // (content-visibility: auto), and WebKit gives them no innerText.
  const order = await app.bridge.eval(`return document.querySelector('.agent-session-view[data-session-id="' + CSS.escape(${JSON.stringify(sid2)}) + '"]')?.textContent || "";`);
  const at = (s) => order.indexOf(s);
  assert(at(FIRST) >= 0 && at(`fake reply: ${FIRST}`) > at(FIRST) && at(SECOND) > at(`fake reply: ${FIRST}`) && at(`fake reply: ${SECOND}`) > at(SECOND),
    "the conversation reads in order: the earlier turn, then the new one");
  assert(order.split(`fake reply: ${FIRST}`).length === 2, "the earlier answer is shown once");
  await app.bridge.screenshot(join(evidenceDir, "03-answered.png"));
  exit = await app.stop();
  log(`  app exited: ${JSON.stringify(exit)}`);
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");
});
