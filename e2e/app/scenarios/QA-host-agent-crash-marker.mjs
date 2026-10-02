#!/usr/bin/env node
// QA-host-agent-crash-marker (CHAOS-20) — an Agent-view agent is killed
// mid-answer (the replayed bridge's `crash` cassette). If the person simply
// types the next message instead of pressing Retry, the crash notice used
// to vanish (nothing showed the earlier answer was cut off) and the working
// timer counted from the dead turn. EXPECT: a marker "... stopped
// unexpectedly here: the answer above is incomplete" stays in the
// conversation, and the timer of the new turn starts at 0.
import { mkdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { REPO_ROOT, launchApp, sleep } from "../harness.mjs";
import { completeOnboarding, runScenario } from "../n11-steps.mjs";
import { sendAgentMessage, startAgentViewSession } from "../agent-setup-steps.mjs";

const SCENARIO = "QA-host-agent-crash-marker";
const REPLAY = join(REPO_ROOT, "tools", "fake-agents", "replay-stdio.mjs");
const CASSETTE = join(REPO_ROOT, "tools", "fake-agents", "cassettes", "claude-bridge", "2.1.283", "crash.jsonl");

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps }) => {
  const app = await launchApp({ runDir: join(evidenceDir, "run"), log, env: { HERMES_BRIDGE_PATH: REPLAY, HERMES_FAKE_CASSETTE: CASSETTE, HERMES_FAKE_SPEED: "0" } });
  apps.push(app);
  const { bridge } = app;
  const folder = join(realpathSync(app.tmpDir), "demo-repo");
  mkdirSync(folder, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", folder]);
  execFileSync("git", ["-C", folder, "-c", "user.name=Hermes Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"]);
  await completeOnboarding(bridge, log);
  await startAgentViewSession(bridge, log, { folder });
  await sleep(1000);
  await sendAgentMessage(bridge, log, "hello there");
  await bridge.waitFor("the crash notice", `return /stopped unexpectedly/i.test(document.body.innerText);`, { timeoutMs: 15_000 });
  log("  the crash notice is shown; waiting 20 s, then sending the next message without Retry");
  await sleep(20_000);
  await sendAgentMessage(bridge, log, "are you there?");
  await sleep(3000);
  const s = await bridge.eval(`
    const t = document.body.innerText;
    const m = t.match(/Thinking\\s*·\\s*((\\d+)m\\s*)?(\\d+)s/);
    return { marker: e2e.all(".agent-crash-marker").map((el) => e2e.norm(el.innerText)), timer: m ? m[0] : null, seconds: m ? (Number(m[2] || 0) * 60 + Number(m[3])) : null };`);
  log(`  3 s after the new message: ${JSON.stringify(s)}`);
  await bridge.screenshot(join(evidenceDir, "01-after-new-message.png"));
  assert(s.marker.some((m) => /stopped unexpectedly here: the answer above is incomplete/.test(m)), "the crash stays in the conversation as a marker");
  assert(s.seconds === null || s.seconds < 15, `the timer belongs to the new turn (shows ${s.timer})`);
});
