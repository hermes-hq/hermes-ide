#!/usr/bin/env node
// The single required check for pull requests and the merge queue.
//
// The `gate` job in .github/workflows/ci.yml always runs and pipes
// `toJSON(needs)` into this script. It passes only when every job that was
// supposed to run finished with `success`. A job that failed, was cancelled,
// or was skipped although its inputs changed fails the gate — so a PR can
// never merge on a cancelled or missing check.
//
// Which jobs are expected is decided by the `changes` job outputs. Keep
// JOB_TRIGGERS and ALWAYS_REQUIRED in sync with the jobs listed under
// `gate.needs`: a job named there but missing from `needs` fails the gate.
// A job that is not listed in JOB_TRIGGERS is always expected to succeed.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Job id → `changes` outputs that make it expected to run (any of them). */
export const JOB_TRIGGERS = {
  frontend: ["frontend", "ci"],
  "rust-fmt": ["rust", "ci"],
  "rust-clippy": ["rust", "ci"],
  "rust-test": ["rust", "ci"],
  "e2e-app": ["frontend", "rust", "ci"],
  acceptance: ["frontend", "rust", "ci"],
};

/** Jobs that run on every change and must always succeed. */
export const ALWAYS_REQUIRED = ["privacy"];

/**
 * @param {Record<string, { result: string, outputs?: Record<string, string> }>} needs
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function evaluateGate(needs) {
  const lines = [];
  let ok = true;
  const fail = (msg) => {
    ok = false;
    lines.push(`FAIL ${msg}`);
  };

  if (!needs || typeof needs !== "object" || Object.keys(needs).length === 0) {
    fail("no job results were given to the gate");
    return { ok, lines };
  }

  const changes = needs.changes;
  if (!changes) {
    fail("changes: missing from gate.needs");
    return { ok, lines };
  }
  if (changes.result !== "success") {
    fail(`changes: ${changes.result} (cannot tell which jobs had to run)`);
    return { ok, lines };
  }
  lines.push("ok   changes: success");
  const outputs = changes.outputs || {};

  for (const job of [...Object.keys(JOB_TRIGGERS), ...ALWAYS_REQUIRED]) {
    if (!(job in needs)) fail(`${job}: missing from gate.needs, so its result is unknown`);
  }

  for (const [job, info] of Object.entries(needs)) {
    if (job === "changes") continue;
    const result = info && info.result;
    const triggers = JOB_TRIGGERS[job];
    const expected = triggers ? triggers.some((key) => outputs[key] === "true") : true;

    if (result === "success") {
      lines.push(`ok   ${job}: success`);
    } else if (result === "skipped" && !expected) {
      lines.push(`ok   ${job}: skipped (nothing it checks changed)`);
    } else if (result === "skipped") {
      fail(`${job}: skipped, but its inputs changed so it had to run`);
    } else if (result === "cancelled") {
      fail(`${job}: cancelled — a cancelled check counts as failed`);
    } else {
      fail(`${job}: ${result ?? "no result"}`);
    }
  }

  return { ok, lines };
}

function main() {
  const raw = process.env.NEEDS_JSON ?? readFileSync(0, "utf8");
  let needs;
  try {
    needs = JSON.parse(raw);
  } catch (err) {
    console.error(`gate: could not parse job results: ${err.message}`);
    process.exit(1);
  }
  const { ok, lines } = evaluateGate(needs);
  for (const line of lines) console.log(line);
  console.log(ok ? "\ngate: PASS" : "\ngate: FAIL");
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
