#!/usr/bin/env node
// Scenario REAL-status-codex (local only): the REAL `codex` CLI started from
// the task launcher in the isolated test build. Hermes passes Codex its
// hooks on the command line (-c hooks.<Event>=...) and trusts exactly those
// for the launch with the hashes Codex's own app server reports, so Codex
// neither asks to review them nor runs anyone else's untrusted hooks. Every
// state must be on the status strip as EXACT within two seconds of the hook:
//
//   working          UserPromptSubmit
//   needs approval   PermissionRequest (the sandbox blocks the network, so
//                    the curl asks to run outside it)
//   done             Stop (the notify program says so too)
//   needs an answer  PreToolUse request_user_input — only in plan mode; the
//                    scenario switches to it (Shift+Tab). In the default
//                    mode Codex refuses the tool (verified with 0.145.0) and
//                    asks in text, which is an ended turn, not a question.
//   exited           SessionEnd, or the helper's exit report
//
// The throwaway repository's .codex/config.toml picks the smallest model
// with low effort. Codex asks whether to trust the new folder and writes
// the answer to ~/.codex/config.toml: the scenario puts that file back byte
// for byte afterwards (Hermes itself never writes it).
//
//   node e2e/app/build.mjs
//   HERMES_STATUS_CORPUS=<folder> node e2e/app/scenarios/REAL-status-codex.mjs
//
// Says SKIP in CI, on Windows, or without a signed-in codex on PATH.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runRealStatus } from "../real-status-steps.mjs";

const toolOf = (l) => l.payload?.tool_name ?? "";
const MODEL = process.env.HERMES_E2E_CODEX_MODEL || "gpt-5.6-luna";

await runRealStatus({
  scenario: "REAL-status-codex",
  agentId: "codex",
  bin: "codex",
  prepareRepo(repo) {
    mkdirSync(join(repo, ".codex"), { recursive: true });
    writeFileSync(join(repo, ".codex", "config.toml"), `model = "${MODEL}"\nmodel_reasoning_effort = "low"\n`);
  },
  restored: [join(homedir(), ".codex", "config.toml")],
  checkLaunch(spec, { assert, log }) {
    const hooks = spec.args.filter((a) => a.startsWith("hooks."));
    log(`  hook flags: ${hooks.map((h) => h.split("=")[0]).join(", ")}`);
    assert(hooks.some((a) => a.startsWith("hooks.PermissionRequest=")), "the launch carries Codex's PermissionRequest hook");
    assert(hooks.some((a) => a.startsWith("hooks.state=")), "and the trust for exactly Hermes's hooks (from Codex's app server)");
    assert(!spec.args.includes("--dangerously-bypass-hook-trust"), "never the blanket bypass");
  },
  startup: [
    // The update notice preselects "Update now": never take it here.
    { label: "update notice", match: /Update available/i, keys: ["down", "enter"] },
    { label: "folder trust", match: /trust the contents of this directory/i, keys: ["enter"] },
    { label: "hook review (must not appear)", match: /Hooks need review/i, keys: ["escape"] },
  ],
  task: "Run exactly this shell command and nothing else: curl -sS -m 5 -o /dev/null https://example.com && echo fetched . If the sandbox blocks the network, request approval to run it outside the sandbox. Then reply with one word: done.",
  hooks: {
    working: (l) => l.event === "UserPromptSubmit",
    approval: (l) => l.event === "PermissionRequest",
    turnEnd: (l) => l.event === "Stop",
    question: (l) => l.event === "PreToolUse" && toolOf(l) === "request_user_input",
    exit: (l) => l.event === "SessionEnd",
  },
  approvalConfidence: "exact",
  question: {
    before: ["shiftTab"],
    prompt: "Ask me one short multiple-choice question with your request_user_input tool (options: tea, coffee). After I answer, reply with my choice in one word.",
    required: false,
    missingNote: "request_user_input is only available in plan mode; Codex asked in text and ended its turn",
  },
  exitKeys: ["/quit", "enter"],
});
