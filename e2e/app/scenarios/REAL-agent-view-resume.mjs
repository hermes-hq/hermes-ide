#!/usr/bin/env node
// Scenario REAL-agent-view-resume (local only): the REAL Claude Code in an
// Agent-view session, across an app restart. What N13-resume-agents proves
// with the stand-in bridge, here with the real bridge, the real SDK and the
// transcript the real claude writes.
//
// It runs only on a machine with a signed-in `claude` on PATH and never in
// CI (RESULT: SKIP otherwise; e2e/app/ci-plan.mjs lists it as excluded).
// Two tiny turns on the cheapest model (the throwaway repository's own
// .claude/settings.json picks haiku): a fraction of a cent. When claude
// refuses a turn because the account is at its usage limit, the run says
// SKIP with claude's words (that is the account, not Hermes).
//
//   run 1  an Agent-view session for Claude in a throwaway repository; the
//          first message asks it to remember a word and answer one word.
//          Its answer is drawn. Quit.
//   run 2  the same data: the session is back in Agent view with the first
//          message and its answer drawn again (from the transcript Claude
//          kept). A second message asks for the word: the resumed Claude
//          answers with it, so it really continued the conversation.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/REAL-agent-view-resume.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { IS_CI, ScenarioSkip, launchApp, skipScenario, sleep } from "../harness.mjs";
import { completeOnboarding, dismissWhatsNew, runScenario } from "../n11-steps.mjs";
import { sendAgentMessage, startAgentViewSession } from "../agent-setup-steps.mjs";

const SCENARIO = "REAL-agent-view-resume";
const WORD = "heliotrope";
const FIRST = `Remember the word ${WORD}. Reply with the single word ok and nothing else. Do not use any tool.`;
const SECOND = "Which word did I ask you to remember? Reply with that word only. Do not use any tool.";

const which = (name) => {
  const r = spawnSync(platform() === "win32" ? "where" : "which", [name], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] : "";
};

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  const claudeBin = which("claude");
  if (IS_CI || platform() === "win32" || !claudeBin) {
    skipScenario({ scenario: SCENARIO, evidenceDir, reason: `needs a real, signed-in claude on PATH, macOS or Linux, and no CI (claude=${claudeBin || "none"})`, log });
  }

  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "hermes-e2e-real-resume-")));
  onCleanup(() => rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Hermes Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Hermes Test", GIT_COMMITTER_EMAIL: "test@example.com", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { env: gitEnv, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "# throwaway\n\nA scratch repository for a Hermes test.\n");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ model: "haiku" }, null, 2) + "\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");

  const viewOf = (sid) => `document.querySelector('.agent-session-view[data-session-id="' + CSS.escape(${JSON.stringify(sid)}) + '"]')`;
  /**
   * The conversation as [{ role, text }]: each message's typed text, or for
   * Hermes its text blocks (not thinking or tool cards). textContent, since
   * messages scrolled out of view have no innerText.
   */
  const MESSAGES_JS = (sid) => `
    const v = ${viewOf(sid)};
    return [...(v?.querySelectorAll(".agent-message[data-role]") ?? [])].map((m) => ({
      role: m.dataset.role,
      text: (m.dataset.role === "assistant"
        ? [...m.querySelectorAll(".agent-text-block")].map((b) => b.textContent).join(" ")
        : (m.querySelector(".agent-message-body, .agent-user-text")?.textContent ?? m.textContent)
      ).trim(),
    }));`;
  const messages = (bridge, sid) => bridge.eval(MESSAGES_JS(sid));
  /** Page expression: the assistant answer right after the user message `prompt` matches `re`. */
  const answeredJs = (sid, prompt, re) => `(() => {
    const ms = (() => { ${MESSAGES_JS(sid)} })();
    const i = ms.findIndex((m) => m.role === "user" && m.text.includes(${JSON.stringify(prompt)}));
    const a = i >= 0 ? ms.slice(i + 1).find((m) => m.role === "assistant" && m.text) : null;
    return !!a && ${re}.test(a.text);
  })()`;
  /**
   * Waits for `answered` (a page expression), unless claude refuses the turn
   * for the account's usage limit: that is the account, not Hermes, so the
   * run is skipped with what claude said (the app showed it correctly).
   */
  const answerOrLimit = async (bridge, sid, what, answered) => {
    const r = await bridge.waitFor(what, `
      const v = ${viewOf(sid)};
      const banner = v?.querySelector(".agent-error-banner");
      const said = banner ? (banner.querySelector(".agent-error-banner-message")?.textContent || banner.textContent || "") : "";
      if (/limit/i.test(said)) return { limit: said.trim() };
      return (${answered}) ? { ok: true } : null;`, { timeoutMs: 120_000 });
    if (r.limit) {
      await bridge.screenshot(join(evidenceDir, "00-usage-limit.png"));
      skipScenario({ scenario: SCENARIO, evidenceDir, reason: `the claude account is at its usage limit: ${r.limit}`, log });
    }
    return r;
  };
  const turnOver = (bridge, sid) =>
    bridge.waitFor("the turn to end", `return !!${viewOf(sid)} && !${viewOf(sid)}.querySelector(".agent-session-stop");`, { timeoutMs: 120_000 });

  // ── run 1 ────────────────────────────────────────────────────────
  log("run 1: an Agent-view session with the real claude; one message");
  let app = await launchApp({ runDir: join(evidenceDir, "run-1"), log, home: "real", resetData: true, tmp: "shared" });
  apps.push(app);
  await completeOnboarding(app.bridge, log);
  const sid1 = await startAgentViewSession(app.bridge, log, { folder: repo });
  await sendAgentMessage(app.bridge, log, FIRST);
  await answerOrLimit(app.bridge, sid1, "the first answer", answeredJs(sid1, FIRST, "/\\bok\\b/i"));
  await turnOver(app.bridge, sid1);
  log(`  conversation: ${JSON.stringify(await messages(app.bridge, sid1))}`);
  await app.bridge.screenshot(join(evidenceDir, "01-first-turn.png"));
  await sleep(2_000);
  let exit = await app.stop();
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");

  // ── run 2 ────────────────────────────────────────────────────────
  log("run 2: relaunch on the same data");
  app = await launchApp({ runDir: join(evidenceDir, "run-2"), log, home: "real", resetData: false, tmp: "shared" });
  apps.push(app);
  await app.bridge.waitFor("the app UI", `return !!e2e.first(".topbar-title, .topbar") && !e2e.first(".onboarding-backdrop");`, { timeoutMs: 60_000 });
  await dismissWhatsNew(app.bridge, log);
  const sid2 = await app.bridge.waitFor("the session back in Agent view", `
    const ids = e2e.all(".agent-session-view").map((e) => e.dataset.sessionId).filter(Boolean);
    return ids.length === 1 ? ids[0] : null;`, { timeoutMs: 60_000 });
  const redrawn = await app.bridge
    .waitFor("the earlier conversation drawn again", `return ${answeredJs(sid2, FIRST, "/\\bok\\b/i")};`, { timeoutMs: 30_000 })
    .then(() => true, () => false);
  const before = await messages(app.bridge, sid2);
  log(`  conversation after the restart: ${JSON.stringify(before)}`);
  const stderr = await app.bridge.eval(`return ${viewOf(sid2)}?.querySelector(".agent-stderr-body")?.textContent ?? "";`);
  log(`  the agent's stderr after the restart: ${JSON.stringify(stderr)}`);
  assert(stderr === "", "no STDERR panel: the resumed agent reports no problem");
  await app.bridge.screenshot(join(evidenceDir, "02-restored.png"));
  assert(before.some((m) => m.role === "user" && m.text.includes(FIRST)), "the first message is drawn again after the restart");
  assert(redrawn, "and so is the answer real claude gave to it, right after it");

  log("run 2: ask for the word");
  await sendAgentMessage(app.bridge, log, SECOND);
  const answered = await answerOrLimit(app.bridge, sid2, "the word in the answer", answeredJs(sid2, SECOND, `/${WORD}/i`))
    .then(() => true, (e) => {
      if (e instanceof ScenarioSkip) throw e;
      return false;
    });
  await turnOver(app.bridge, sid2).catch(() => {});
  const after = await messages(app.bridge, sid2);
  log(`  conversation: ${JSON.stringify(after)}`);
  await app.bridge.screenshot(join(evidenceDir, "03-continued.png"));
  assert(answered, `the resumed claude remembers the word (${WORD}): it continued the conversation`);
  const at = (prompt) => after.findIndex((m) => m.role === "user" && m.text.includes(prompt));
  assert(at(FIRST) >= 0 && at(FIRST) < at(SECOND), "the earlier turn reads before the new one");
  exit = await app.stop();
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");
});
