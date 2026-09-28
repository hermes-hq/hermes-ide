#!/usr/bin/env node
// A stand-in for the GitHub CLI (`gh`) in real-app scenarios, so the Land
// sheet's pull-request path runs against a local bare remote with no GitHub
// account. The test app runs it (with node) when started with
// HERMES_E2E_GH=<this file> (honoured only by an e2e build with HERMES_E2E=1).
//
//   FAKE_GH_STATE  JSON file the scenario edits between steps:
//                  { "signedIn": true, "checks": [...], "failedLog": "..." }
//   FAKE_GH_LOG    every call is appended as one JSON line:
//                  { "args": [...], "stdin": "...", "cwd": "..." }
//
// Supported: auth status, pr create, pr close, pr checks --json, run view
// --log-failed. Anything else exits 1.

import { appendFileSync, readFileSync, existsSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const statePath = process.env.FAKE_GH_STATE;
const logPath = process.env.FAKE_GH_LOG;

function readState() {
  if (!statePath || !existsSync(statePath)) return {};
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return {};
  }
}

function readStdin() {
  if (!(args[0] === "pr" && args[1] === "create" && args.includes("-"))) return "";
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const state = readState();
const stdin = readStdin();
if (logPath) appendFileSync(logPath, `${JSON.stringify({ args, stdin, cwd: process.cwd() })}\n`);

const say = (text) => process.stdout.write(`${text}\n`);
const fail = (text, code = 1) => {
  process.stderr.write(`${text}\n`);
  process.exit(code);
};
const cmd = `${args[0] ?? ""} ${args[1] ?? ""}`;

if (cmd === "auth status") {
  if (state.signedIn === false) fail("You are not logged into any GitHub hosts. To log in, run: gh auth login");
  say("github.com\n  ✓ Logged in to github.com account e2e-user (keyring)");
  process.exit(0);
}
if (state.signedIn === false) fail("To get started with GitHub CLI, please run:  gh auth login", 4);

if (cmd === "pr create") {
  const n = (state.nextPr ?? 7);
  if (statePath) writeFileSync(statePath, JSON.stringify({ ...state, nextPr: n + 1 }, null, 2));
  say(`https://github.test/e2e/repo/pull/${n}`);
  process.exit(0);
}
if (cmd === "pr close") {
  say(`✓ Closed pull request ${args[2]}`);
  process.exit(0);
}
if (cmd === "pr checks") {
  const checks = state.checks ?? [];
  say(JSON.stringify(checks));
  // gh exits 1 when a check failed, 8 while one is pending.
  process.exit(checks.some((c) => c.bucket === "fail") ? 1 : checks.some((c) => c.bucket === "pending") ? 8 : 0);
}
if (cmd === "run view" && args.includes("--log-failed")) {
  process.stdout.write(state.failedLog ?? "no log\n");
  process.exit(0);
}
fail(`fake gh: unsupported command: ${args.join(" ")}`);
