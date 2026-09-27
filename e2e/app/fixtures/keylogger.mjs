#!/usr/bin/env node
// Keylogger fixture for real-app scenarios: run it inside a Hermes terminal
// and it records every byte the terminal delivers, exactly as a shell or an
// agent TUI would receive them.
//
//   E2E_KEYLOG_OUT=/path/keys.log node e2e/app/fixtures/keylogger.mjs
//
// The terminal is put in raw mode, so Ctrl+C, Ctrl+D, Ctrl+Z ... arrive as
// plain bytes (0x03, 0x04, 0x1a) instead of signals. Each chunk is appended
// to E2E_KEYLOG_OUT as one line of hex bytes and echoed on screen as
// "KEYLOG <hex>". It exits after 10 minutes, or when it reads "\x1b\x1bQ".

import { appendFileSync, writeFileSync } from "node:fs";

const out = process.env.E2E_KEYLOG_OUT;
if (!out) {
  console.error("keylogger: set E2E_KEYLOG_OUT to the file to write");
  process.exit(2);
}
if (!process.stdin.isTTY) {
  console.error("keylogger: stdin is not a terminal");
  process.exit(2);
}

writeFileSync(out, "");
process.stdin.setRawMode(true);
process.stdin.resume();

const hex = (buf) => [...buf].map((b) => b.toString(16).padStart(2, "0")).join(" ");
let tail = "";

process.stdin.on("data", (chunk) => {
  const line = hex(chunk);
  appendFileSync(out, line + "\n");
  process.stdout.write(`KEYLOG ${line}\r\n`);
  tail = (tail + chunk.toString("latin1")).slice(-3);
  if (tail === "\x1b\x1bQ") stop(0);
});

function stop(code) {
  try {
    process.stdin.setRawMode(false);
  } catch {
    // the terminal may already be gone
  }
  process.exit(code);
}

setTimeout(() => stop(0), 10 * 60_000).unref();
process.stdout.write("KEYLOG READY\r\n");
