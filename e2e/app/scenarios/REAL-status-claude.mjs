#!/usr/bin/env node
// Scenario REAL-status-claude (local only): the REAL `claude` CLI started
// from the task launcher in the isolated test build, driven through an
// approval, a finished turn, a question and its exit. Every state must be
// on the status strip as EXACT within two seconds of Claude's own hook:
//
//   working          UserPromptSubmit
//   needs approval   PermissionRequest (Bash: a curl the rules do not allow)
//   done             Stop
//   needs an answer  PreToolUse AskUserQuestion (Claude then also asks
//                    permission for its question tool; that must not turn
//                    the question into an approval)
//   exited           SessionEnd, or the helper's exit report
//
// The throwaway repository's .claude/settings.json picks haiku; four tiny
// turns at most. ~/.claude/settings.json must be byte-identical afterwards.
// Everything is recorded for offline measurement (see real-status-steps.mjs).
//
//   node e2e/app/build.mjs
//   HERMES_STATUS_CORPUS=<folder> node e2e/app/scenarios/REAL-status-claude.mjs
//
// Says SKIP in CI, on Windows, or without a signed-in claude on PATH.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runRealStatus } from "../real-status-steps.mjs";

const toolOf = (l) => l.payload?.tool_name ?? "";

await runRealStatus({
  scenario: "REAL-status-claude",
  agentId: "claude",
  bin: "claude",
  prepareRepo(repo) {
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ model: "haiku" }, null, 2) + "\n");
  },
  guarded: [join(homedir(), ".claude", "settings.json")],
  checkLaunch(spec, { assert }) {
    const at = spec.args.indexOf("--settings");
    assert(at >= 0, "the per-launch hooks file is passed with --settings");
  },
  startup: [
    // A new worktree is a folder Claude has not seen: its trust dialog. In
    // 2.1.284 "No, exit" is preselected; Down selects "Yes, I trust".
    { label: "folder trust", match: /trust this folder|Quick safety check/i, keys: ["down", "enter"] },
  ],
  task: "Run this exact shell command with the Bash tool and nothing else: curl -sS -m 5 -o /dev/null https://example.com && echo fetched . Then reply with one word: done.",
  hooks: {
    working: (l) => l.event === "UserPromptSubmit",
    approval: (l) => l.event === "PermissionRequest" && toolOf(l) === "Bash",
    // Anything else it asks permission for on the way (reading the session's
    // context file outside the worktree, for one).
    anyApproval: (l) => l.event === "PermissionRequest" && !["AskUserQuestion", "ExitPlanMode"].includes(toolOf(l)),
    turnEnd: (l) => l.event === "Stop",
    question: (l) => l.event === "PreToolUse" && toolOf(l) === "AskUserQuestion",
    exit: (l) => l.event === "SessionEnd",
  },
  approvalConfidence: "exact",
  question: {
    prompt: "Use the AskUserQuestion tool to ask me whether I prefer tea or coffee. After I answer, reply with my choice in one word.",
    required: true,
  },
  exitKeys: ["/exit", "enter"],
});
