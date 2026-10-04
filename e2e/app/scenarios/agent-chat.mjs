#!/usr/bin/env node
// agent-chat — README claim "Structured conversation — thinking blocks,
// tool-call cards, and diff previews" (Agent view for Claude).
//
// The replayed bridge (tools/fake-agents/replay-stdio.mjs with the
// claude-bridge structured-turn cassette) answers one message the way Claude
// Code streams a turn: a thinking block, a Bash tool call and its output, an
// Edit tool call and its result, then the answer. EXPECT, in the Agent view:
//   - a thinking block, collapsed to a toggle, that opens to show the
//     reasoning text;
//   - a command card showing the command Claude ran and its output;
//   - a file card for the edited file with a diff preview: the old line
//     marked "-" and the new line marked "+".
// Each check looks for the rendered component (not the raw text anywhere on
// the page), so a view that printed the stream as plain text would fail.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/agent-chat.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, launchApp, sleep } from "../harness.mjs";
import { completeOnboarding, runScenario } from "../n11-steps.mjs";
import { sendAgentMessage, startAgentViewSession } from "../agent-setup-steps.mjs";

const SCENARIO = "agent-chat";
const REPLAY = join(REPO_ROOT, "tools", "fake-agents", "replay-stdio.mjs");
const CASSETTE = join(REPO_ROOT, "tools", "fake-agents", "cassettes", "claude-bridge", "2.1.283", "structured-turn.jsonl");
const THINKING = "The greeting lives in greet.js; read it before changing the wording.";
const ANSWER = "greet() now says hello, world.";

await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps }) => {
  const app = await launchApp({ runDir: join(evidenceDir, "run"), log, env: { HERMES_BRIDGE_PATH: REPLAY, HERMES_FAKE_CASSETTE: CASSETTE, HERMES_FAKE_SPEED: "0" } });
  apps.push(app);
  const { bridge } = app;
  const folder = join(realpathSync(app.tmpDir), "greet-repo");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "greet.js"), 'export const greet = () => "hello";\n');
  execFileSync("git", ["init", "-q", "-b", "main", folder]);
  execFileSync("git", ["-C", folder, "add", "."]);
  execFileSync("git", ["-C", folder, "-c", "user.name=Hermes Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"]);

  await completeOnboarding(bridge, log);
  const sid = await startAgentViewSession(bridge, log, { folder });
  const VIEW = `document.querySelector('.agent-session-view[data-session-id="' + CSS.escape(${JSON.stringify(sid)}) + '"]')`;

  log("step 1: send a message; the agent streams thinking, a command, an edit and its answer");
  await sendAgentMessage(bridge, log, "make greet say hello, world");
  await bridge.waitFor("the answer", `return (${VIEW}?.innerText || "").includes(${JSON.stringify(ANSWER)});`, { timeoutMs: 30_000 });
  await bridge.waitFor("the turn to end", `return !${VIEW}?.querySelector(".agent-session-stop");`, { timeoutMs: 20_000 });

  log("step 2: the thinking block");
  const thinking = await bridge.eval(`
    const v = ${VIEW};
    const block = v?.querySelector(".agent-thinking-block");
    return { found: !!block, open: !!block?.classList.contains("open"), label: e2e.norm(block?.querySelector(".agent-thinking-label")?.innerText || "") };`);
  log(`  ${JSON.stringify(thinking)}`);
  assert(thinking.found, "the reasoning is rendered as a thinking block");
  if (!thinking.open) await bridge.clickWhenReady(`return e2e.click(e2e.must(${VIEW}?.querySelector(".agent-thinking-toggle"), "the thinking toggle"));`);
  const reasoning = await bridge.waitFor("the reasoning text", `
    const body = ${VIEW}?.querySelector(".agent-thinking-block.open .agent-thinking-body");
    return body ? e2e.norm(body.innerText) : null;`, { timeoutMs: 10_000 });
  log(`  thinking body: "${reasoning}"`);
  assert(reasoning.includes(THINKING), "opening the thinking block shows the reasoning text");

  log("step 3: the command card");
  const exec = await bridge.eval(`
    const card = ${VIEW}?.querySelector(".agent-tool-exec");
    return card ? { status: card.dataset.status, command: e2e.norm(card.querySelector(".agent-tool-exec-command")?.innerText || ""), output: e2e.norm(card.querySelector(".agent-tool-exec-output")?.innerText || card.innerText) } : null;`);
  log(`  ${JSON.stringify(exec)}`);
  assert(!!exec, "the Bash call is rendered as a command card");
  assert(exec.command.includes("cat greet.js"), "the card shows the command the agent ran");
  assert(exec.output.includes('export const greet = () => "hello";'), "the card shows the command's output");
  assert(exec.status === "success", "the card shows the command finished");

  log("step 4: the edit's diff preview");
  // Messages off screen are not laid out (content-visibility: auto), and
  // WebKit reports no innerText for them: bring the card into view first and
  // read textContent.
  const FILE_CARD = `[...(${VIEW}?.querySelectorAll(".agent-tool-file") || [])].find((c) => (c.querySelector(".agent-tool-file-path")?.textContent || "").includes("greet.js"))`;
  await bridge.waitFor("the file card", `const card = ${FILE_CARD}; if (!card) return false; card.scrollIntoView({ block: "center" }); return true;`, { timeoutMs: 10_000 }).catch(() => null);
  await sleep(300);
  const diff = await bridge.eval(`
    const card = ${FILE_CARD};
    if (!card) return null;
    const rows = (type) => [...card.querySelectorAll(".agent-diff-row.agent-diff-" + type)].map((r) => ({
      marker: e2e.norm(r.querySelector(".agent-diff-marker")?.textContent || ""),
      text: r.querySelector(".agent-diff-text")?.textContent || "" }));
    return { path: e2e.norm(card.querySelector(".agent-tool-file-path")?.textContent || ""), removed: rows("remove"), added: rows("add"), hasDiff: !!card.querySelector(".agent-diff") };`);
  log(`  ${JSON.stringify(diff)}`);
  assert(!!diff && diff.hasDiff, "the Edit call is rendered as a file card with a diff preview");
  assert(diff.removed.some((r) => r.marker === "-" && r.text.includes('() => "hello";')), "the old line is shown removed (-)");
  assert(diff.added.some((r) => r.marker === "+" && r.text.includes('() => "hello, world";')), "the new line is shown added (+)");
  await bridge.screenshot(join(evidenceDir, "01-structured-turn.png"));
});
