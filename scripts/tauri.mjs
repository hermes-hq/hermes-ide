#!/usr/bin/env node
// `npm run tauri ...` goes through here. It runs the Tauri CLI unchanged,
// except that `tauri dev` always gets the dev overlay (its own identifier,
// com.hermes-ide.terminal.dev), so a dev build keeps its own data folder and
// never opens an installed Hermes's database, worktrees or journal.
//
// HERMES_TAURI_CLI replaces the Tauri CLI entry point (used by tests).

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEV_CONFIG = join("src-tauri", "tauri.dev.conf.json");

/** Arguments for the Tauri CLI: `dev` gets the dev overlay first. */
export function tauriArgs(argv) {
  if (argv[0] !== "dev") return [...argv];
  // Later --config values merge on top, so a caller can still add their own.
  return ["dev", "--config", DEV_CONFIG, ...argv.slice(1)];
}

function main() {
  const cli = process.env.HERMES_TAURI_CLI || createRequire(import.meta.url).resolve("@tauri-apps/cli/tauri.js");
  const child = spawn(process.execPath, [cli, ...tauriArgs(process.argv.slice(2))], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
