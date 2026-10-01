#!/usr/bin/env node
// QA-host-stop-hung-agent (CHAOS-10) — an Agent-view agent stops answering
// mid-turn (a stalled network call, a wedged tool; here the replayed
// bridge's `hang` cassette). ◼ Stop only asks the agent to stop its turn,
// and used to leave the view "Thinking" for good. EXPECT: a few seconds
// after Stop the view says "The agent isn't responding." with Force stop;
// Force stop ends the agent's process and the turn; the conversation stays
// (the next message starts the agent again with it).
import { mkdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { REPO_ROOT, launchApp, sleep } from "../harness.mjs";
import { completeOnboarding, runScenario } from "../n11-steps.mjs";
import { sendAgentMessage, startAgentViewSession } from "../agent-setup-steps.mjs";

const SCENARIO = "QA-host-stop-hung-agent";
const REPLAY = join(REPO_ROOT, "tools", "fake-agents", "replay-stdio.mjs");
const CASSETTE = join(REPO_ROOT, "tools", "fake-agents", "cassettes", "claude-bridge", "2.1.283", "hang.jsonl");

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps }) => {
  const app = await launchApp({ runDir: join(evidenceDir, "run"), log, env: { HERMES_BRIDGE_PATH: REPLAY, HERMES_FAKE_CASSETTE: CASSETTE, HERMES_FAKE_SPEED: "0" } });
  apps.push(app);
  const { bridge } = app;
  const folder = join(realpathSync(app.tmpDir), "demo-repo");
  mkdirSync(folder, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", folder]);
  execFileSync("git", ["-C", folder, "-c", "user.name=Hermes Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"]);
  await completeOnboarding(bridge, log);
  const sid = await startAgentViewSession(bridge, log, { folder });
  await sleep(1000);
  await sendAgentMessage(bridge, log, "hello there");
  const view = () =>
    bridge.eval(`
      const v = document.querySelector('.agent-session-view[data-session-id="' + CSS.escape(${JSON.stringify(sid)}) + '"]');
      return { working: !!v && v.querySelectorAll(".agent-session-stop").length > 0,
        hung: e2e.norm(v?.querySelector(".agent-session-hung")?.innerText || "") || null,
        force: !!v?.querySelector(".agent-session-force-stop") };`);
  await bridge.waitFor("the turn running", `return !!document.querySelector('.agent-session-view[data-session-id="' + CSS.escape(${JSON.stringify(sid)}) + '"] .agent-session-stop');`, { timeoutMs: 20_000 });
  log("press ◼ Stop");
  await bridge.click(".agent-session-stop");
  await sleep(2000);
  const early = await view();
  log(`  2 s after Stop: ${JSON.stringify(early)}`);
  assert(early.working && !early.force, "it waits a moment for the agent to stop on its own");
  const offered = await bridge.waitFor("the offer to force stop", `return !!document.querySelector(".agent-session-force-stop");`, { timeoutMs: 10_000 }).catch(() => false);
  const mid = await view();
  log(`  after the wait: ${JSON.stringify(mid)}`);
  await bridge.screenshot(join(evidenceDir, "01-not-responding.png"));
  assert(offered && /isn't responding/.test(mid.hung ?? ""), "the view says the agent isn't responding and offers Force stop");
  await bridge.click(".agent-session-force-stop");
  const stopped = await bridge.waitFor("the turn over", `return !document.querySelector('.agent-session-view[data-session-id="' + CSS.escape(${JSON.stringify(sid)}) + '"] .agent-session-stop');`, { timeoutMs: 15_000 }).catch(() => false);
  const after = await view();
  log(`  after Force stop: ${JSON.stringify(after)}`);
  await bridge.screenshot(join(evidenceDir, "02-force-stopped.png"));
  assert(stopped, "Force stop ended the turn");
  const kept = await bridge.eval(`return /hello there/.test(document.querySelector('.agent-session-view[data-session-id="' + CSS.escape(${JSON.stringify(sid)}) + '"]')?.innerText || "");`);
  assert(kept, "the conversation is still there");
});
