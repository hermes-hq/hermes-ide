#!/usr/bin/env node
// A stand-in for src-tauri/bridge/hermes-claude-bridge.mjs, for real-app
// scenarios. The test app starts it through HERMES_BRIDGE_PATH exactly as it
// starts the real bridge (`node <bridge> --working-dir <dir> ... <claude flags>`),
// and it speaks the same NDJSON on stdin / stdout. No network, no account.
//
// Behaviour is read from a plan file on every user message, so a scenario can
// change what the running process (or the next one) does without relaunching
// the app:
//
//   HERMES_FAKE_BRIDGE_PLAN  path to a JSON file: { "mode": "<mode>" }
//   HERMES_FAKE_BRIDGE_LOG   path of an NDJSON log this process appends to:
//                            {"event":"start"|"input"|"exit", "pid", ...}
//   HERMES_FAKE_MCP_SERVERS  comma-separated MCP server names the init
//                            message reports as connected
//
// Modes, applied to each user message:
//   ok          replies "fake reply: <text>" and stays up for more messages
//   crash       prints a line on stderr and exits with code 3
//   signed-out  answers the way Claude does without a login
//               (assistant error "authentication_failed", then an error
//               result "Not logged in · Please run /login") and exits 0
//   garbage     prints a line that is not JSON and stays up
//
// The replies are synthetic; nothing here was recorded from a real account.

import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const sessionId = flag("--session-id") || flag("--resume") || "fake-session";
const cwd = flag("--working-dir") || process.cwd();

function log(entry) {
  const file = process.env.HERMES_FAKE_BRIDGE_LOG;
  if (!file) return;
  appendFileSync(file, JSON.stringify({ ...entry, pid: process.pid, t: Date.now() }) + "\n");
}

function readMode() {
  const file = process.env.HERMES_FAKE_BRIDGE_PLAN;
  if (!file) return "ok";
  try {
    return JSON.parse(readFileSync(file, "utf8")).mode || "ok";
  } catch {
    return "ok";
  }
}

log({ event: "start", mode: readMode(), argv });

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const finish = (code) => {
  log({ event: "exit", code });
  process.exit(code);
};

let turn = 0;
const init = () =>
  out({
    type: "system",
    subtype: "init",
    cwd,
    session_id: sessionId,
    tools: [],
    mcp_servers: (process.env.HERMES_FAKE_MCP_SERVERS || "")
      .split(",")
      .filter(Boolean)
      .map((name) => ({ name, status: "connected" })),
    model: "fake-model",
    permissionMode: "default",
    slash_commands: [],
    apiKeySource: "none",
    claude_code_version: "0.0.0-fake",
    uuid: `fake-init-${process.pid}`,
  });

function onUserMessage(text) {
  const mode = readMode();
  turn += 1;
  if (mode === "crash") {
    process.stderr.write("fake-bridge: simulated crash\n");
    finish(3);
    return;
  }
  if (turn === 1) init();
  if (mode === "signed-out") {
    const msg = "Not logged in · Please run /login";
    out({
      type: "assistant",
      error: "authentication_failed",
      message: {
        id: `fake-msg-${process.pid}-${turn}`,
        type: "message",
        role: "assistant",
        model: "fake-model",
        content: [{ type: "text", text: msg }],
      },
      parent_tool_use_id: null,
      session_id: sessionId,
    });
    out({ type: "result", subtype: "success", is_error: true, result: msg, session_id: sessionId, num_turns: 1 });
    finish(0);
    return;
  }
  if (mode === "garbage") {
    process.stdout.write("fake-bridge: this line is not JSON {\n");
    return;
  }
  const reply = `fake reply: ${text}`;
  out({
    type: "assistant",
    message: {
      id: `fake-msg-${process.pid}-${turn}`,
      type: "message",
      role: "assistant",
      model: "fake-model",
      content: [{ type: "text", text: reply }],
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  });
  out({ type: "result", subtype: "success", is_error: false, result: reply, session_id: sessionId, num_turns: turn });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  log({ event: "input", type: msg.type });
  if (msg.type !== "user") return;
  const content = msg.message?.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((b) => b?.type === "text").map((b) => b.text).join(" ")
      : "";
  onUserMessage(text);
});
rl.on("close", () => finish(0));
process.on("SIGTERM", () => finish(143));
process.on("SIGINT", () => finish(130));
