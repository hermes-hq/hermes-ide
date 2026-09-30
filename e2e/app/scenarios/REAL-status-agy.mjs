#!/usr/bin/env node
// Scenario REAL-status-agy (local only): the REAL Antigravity CLI (`agy`)
// started from the task launcher in the isolated test build. Antigravity
// takes no per-launch hook flag: Hermes writes .agents/hooks.json into the
// worktree it made (kept out of git) in the shape agy reads — flat handler
// lists for PreInvocation, PostInvocation and Stop, matcher groups for the
// tool events (the shape Hermes wrote before this fix was silently ignored).
//
//   working          PreInvocation (exact)
//   needs approval   agy has no approval event: its PreToolUse, then no
//                    command and no CPU for a moment, is shown as a GUESSED
//                    approval (the agent's hook source, confidence guessed)
//   done             Stop with fullyIdle (exact)
//   needs an answer  PreToolUse ask_question (exact), when the model uses it
//   exited           the helper's exit report (agy has no end hook)
//
// Uses agy's default model (no project setting chooses one); three tiny
// turns at most. Everything is recorded for offline measurement.
//
//   node e2e/app/build.mjs
//   HERMES_STATUS_CORPUS=<folder> node e2e/app/scenarios/REAL-status-agy.mjs
//
// Says SKIP in CI, on Windows, or without a signed-in agy on PATH.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runRealStatus } from "../real-status-steps.mjs";

const toolOf = (l) => l.payload?.tool_name ?? "";

await runRealStatus({
  scenario: "REAL-status-agy",
  agentId: "antigravity",
  bin: "agy",
  checkLaunch(spec, { assert, log }) {
    const file = join(spec.cwd, ".agents", "hooks.json");
    assert(existsSync(file), "the hook file is in the Hermes-owned worktree");
    const ours = JSON.parse(readFileSync(file, "utf8"))["hermes-signal"] ?? {};
    log(`  hooks.json events: ${Object.keys(ours).join(", ")}`);
    assert(Array.isArray(ours.Stop) && typeof ours.Stop[0]?.command === "string", "Stop is a flat handler list");
    assert(ours.PreToolUse?.[0]?.matcher === "*", "PreToolUse is a matcher group for every tool");
  },
  startup: [{ label: "folder trust", match: /trust the contents of this project/i, keys: ["enter"] }],
  task: "Run this exact shell command and nothing else: curl -sS -m 5 -o /dev/null https://example.com . Then reply with one word: done.",
  hooks: {
    working: (l) => l.event === "PreInvocation",
    approval: (l) => l.event === "PreToolUse" && toolOf(l) !== "ask_question",
    // Every tool call announces itself the same way, asked or not: only the
    // first (the curl) is answered.
    anyApproval: () => false,
    turnEnd: (l) => l.event === "Stop" && l.payload?.fullyIdle === true,
    question: (l) => l.event === "PreToolUse" && toolOf(l) === "ask_question",
    exit: () => false,
  },
  approvalConfidence: "guessed",
  // The guess needs the tool call to stay pending for 1.5 s.
  approvalAfterMs: 1500,
  question: {
    prompt: "Use your ask_question tool to ask me whether I prefer tea or coffee. After I answer, reply with my choice in one word.",
    required: false,
    missingNote: "the model asked in text instead of with its ask_question tool",
  },
  exitKeys: ["ctrlC", "ctrlC"],
});
