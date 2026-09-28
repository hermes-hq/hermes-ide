#!/usr/bin/env node
// A fake agent that never stops talking, for the session-host scenario
// (N20): run it inside a Hermes terminal and it prints a numbered line every
// 250 ms, so a test can tell whether the program kept running while the app
// was gone (the numbers keep climbing) and whether the app replayed what it
// missed (the early numbers are on screen after a relaunch).
//
//   node e2e/app/fixtures/streamer.mjs /path/state.json
//
// The state file holds its pid and the last number printed, so the scenario
// can check the process from outside. It ends on SIGHUP or SIGTERM (as any
// program does when its terminal goes away), on "q", or after 10 minutes.

import { writeFileSync } from "node:fs";

const stateFile = process.argv[2];
if (!stateFile) {
  console.error("streamer: pass the state file as the first argument");
  process.exit(2);
}

let tick = 0;
const save = () => {
  try {
    writeFileSync(stateFile, JSON.stringify({ pid: process.pid, tick, startedAt: Date.now() }));
  } catch {
    /* the folder may already be gone at the very end */
  }
};
save();

// A terminal that went away makes writes fail; that is the end, not a crash.
process.stdout.on("error", () => process.exit(0));
process.stdout.write("\x1b]2;streamer working\x07");
process.stdout.write(`streamer pid ${process.pid}\r\n`);

const timer = setInterval(() => {
  tick += 1;
  process.stdout.write(`tick ${tick}\r\n`);
  save();
}, 250);

const stop = (code) => {
  clearInterval(timer);
  process.stdout.write(`streamer stopping (${code})\r\n`);
  process.exit(0);
};
process.on("SIGHUP", () => stop("hup"));
process.on("SIGTERM", () => stop("term"));
process.on("SIGINT", () => stop("int"));

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (chunk) => {
    if (chunk.includes("q")) stop("q");
  });
}
setTimeout(() => stop("timeout"), 10 * 60 * 1000).unref();
