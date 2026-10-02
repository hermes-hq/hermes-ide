#!/usr/bin/env node
// QA-host-context-in-worktree (PLN-12) — a task's first prompt used to end
// with "Read the file at <app data>/context/<id>.md", a file outside the
// agent's worktree (real Claude Code then asks permission to read it on
// nearly every task), and the file named the main checkout as the project
// folder. EXPECT: the context file the prompt names is inside the agent's
// worktree, git does not see it, and it names the worktree, its branch and
// the main checkout to leave alone.
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { execFileSync } from "node:child_process";
import { sleep } from "../harness.mjs";
import { runScenario } from "../n11-steps.mjs";
import { startApp } from "../qa-host-steps.mjs";

const SCENARIO = "QA-host-context-in-worktree";
await runScenario(SCENARIO, async ({ evidenceDir, log, assert, apps, onCleanup }) => {
  const { fx, bridge } = await startApp("qa-context", evidenceDir, log, onCleanup, apps);
  const sid = await bridge.eval(
    `return await window.__HERMES_E2E__.launchWithChoice(${JSON.stringify({ agentId: "claude", cwd: fx.repo, label: "add an add function", task: "Add an add function", worktree: true })});`,
    { timeoutMs: 30_000 },
  );
  const [rec] = await fx.waitForRecords(1);
  const wt = await bridge.eval(`return (await window.__TAURI_INTERNALS__.invoke("get_sessions")).find((s) => s.id === ${JSON.stringify(sid)})?.working_directory ?? null;`);
  const prompt = rec.argv[rec.argv.length - 1];
  log(`  session folder: ${wt}`);
  log(`  first prompt: ${JSON.stringify(prompt)}`);
  const m = /Read the file at (.+?\.md)/.exec(prompt);
  if (!m) {
    log("  (this launch passed no context file; nothing to check)");
    return;
  }
  const ctx = m[1];
  const rel = relative(wt, ctx);
  assert(!rel.startsWith(".."), `the context file is inside the session's folder (${rel})`);
  const status = execFileSync("git", ["-C", wt, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
  assert(!status.includes(".hermes/context"), "git does not see it");
  const body = readFileSync(ctx, "utf8");
  log(`  context file:\n${body.split("\n").slice(0, 8).join("\n")}`);
  if (wt.replace(/\\/g, "/").toLowerCase() !== fx.repo.replace(/\\/g, "/").toLowerCase()) {
    assert(/^You work in .+ \(branch .+\); do not edit .+\./.test(body), "it names the worktree, its branch and the main checkout to leave alone");
  }
  await sleep(500);
});
