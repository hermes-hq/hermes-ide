#!/usr/bin/env node
// The single required check for pull requests and the merge queue.
//
// The `gate` job in .github/workflows/ci.yml always runs and pipes
// `toJSON(needs)` into this script. It passes only when every job that was
// supposed to run finished with `success`. A job that failed, was cancelled,
// or was skipped although its inputs changed fails the gate — so a PR can
// never merge on a cancelled or missing check.
//
// Which jobs are expected is decided by the `changes` job outputs. A job that
// is not listed in JOB_TRIGGERS is always expected to succeed.
//
// `--workflow <ci.yml>` checks that the workflow and this file agree: every
// job except those in UNGATED is in `gate.needs`, and each job's `if:` asks
// for exactly the `changes` outputs listed in JOB_TRIGGERS. The gate job runs
// that check first, so the two cannot drift apart unnoticed.

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
  actionlint: ["workflows"],
};

/** Jobs that run on every change and must always succeed. */
export const ALWAYS_REQUIRED = ["privacy"];

/** Jobs deliberately left out of the gate, with the reason. */
export const UNGATED = {
  "rust-audit": "runs on main only, after merge; new advisories must not block unrelated pull requests",
};

/**
 * Reads the jobs of a GitHub Actions workflow: id → { needs, if }.
 * Understands the shapes ci.yml uses (two-space indentation, `needs` as a
 * scalar or a flow list, `if` on one line or as a `>-` block).
 *
 * @param {string} text
 * @returns {Record<string, { needs: string[], if: string | null, outputs: string[] }>}
 */
export function parseWorkflowJobs(text) {
  const lines = text.split(/\r?\n/);
  const jobs = {};
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return jobs;
  let current = null;
  let section = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S/.test(line)) break;
    const jobMatch = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobMatch) {
      current = { needs: [], if: null, outputs: [] };
      jobs[jobMatch[1]] = current;
      section = null;
      continue;
    }
    if (!current) continue;
    const key = /^ {4}([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (key) {
      section = key[1];
      const value = key[2].replace(/\s+#.*$/, "").trim();
      if (section === "needs") {
        current.needs = value
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      } else if (section === "if") {
        if (/^[>|]-?$/.test(value)) {
          const block = [];
          while (i + 1 < lines.length && (/^ {6}/.test(lines[i + 1]) || lines[i + 1].trim() === "")) {
            block.push(lines[++i].trim());
          }
          current.if = block.filter(Boolean).join(" ");
        } else {
          current.if = value;
        }
      }
      continue;
    }
    const output = /^ {6}([A-Za-z0-9_-]+):/.exec(line);
    if (section === "outputs" && output) current.outputs.push(output[1]);
  }
  return jobs;
}

/**
 * Checks that ci.yml and this script agree on which jobs the gate covers and
 * when each may be skipped.
 *
 * @param {string} text contents of .github/workflows/ci.yml
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function checkWorkflow(text) {
  const lines = [];
  let ok = true;
  const fail = (msg) => {
    ok = false;
    lines.push(`FAIL ${msg}`);
  };

  const jobs = parseWorkflowJobs(text);
  const gate = jobs.gate;
  if (!gate) {
    fail("workflow: no `gate` job");
    return { ok, lines };
  }
  if (gate.if !== "always()") fail("gate: must have `if: always()` so it reports even when a job failed");
  const needs = new Set(gate.needs);
  const outputs = new Set(jobs.changes ? jobs.changes.outputs : []);

  for (const job of needs) {
    if (!(job in jobs)) fail(`gate.needs names \`${job}\`, which is not a job in the workflow`);
  }
  for (const job of [...Object.keys(JOB_TRIGGERS), ...ALWAYS_REQUIRED]) {
    if (!(job in jobs)) fail(`${job}: listed in ci-gate.mjs but not a job in the workflow`);
  }

  for (const [job, info] of Object.entries(jobs)) {
    if (job === "gate") continue;
    if (job in UNGATED) {
      if (needs.has(job)) fail(`${job}: listed as UNGATED in ci-gate.mjs but also in gate.needs`);
      continue;
    }
    if (!needs.has(job)) {
      fail(`${job}: not in gate.needs, so its result never reaches the required check`);
      continue;
    }
    if (job === "changes") continue;

    const triggers = JOB_TRIGGERS[job];
    const cond = info.if;
    if (!triggers) {
      if (cond) fail(`${job}: has \`if: ${cond}\` but ci-gate.mjs expects it to run on every change`);
      continue;
    }
    for (const key of triggers) {
      if (!outputs.has(key)) fail(`${job}: trigger \`${key}\` is not an output of the changes job`);
    }
    if (!cond) {
      fail(`${job}: has no \`if:\`, but ci-gate.mjs lets it skip unless ${triggers.join("/")} changed`);
      continue;
    }
    const term = /needs\.changes\.outputs\.([A-Za-z0-9_-]+)\s*==\s*'true'/g;
    const asked = [...cond.matchAll(term)].map((m) => m[1]);
    // Allowed shapes: `A || B`, and `always() && needs.changes.result ==
    // 'success' && (A || B)`. When `changes` did not succeed the gate fails
    // anyway, so both run exactly when one of A, B changed.
    const guard = /^always\(\)&&needs\.changes\.result=='success'&&\((.*)\)$/;
    const compact = cond.replace(term, "T").replace(/\s/g, "");
    const body = guard.test(compact) ? compact.replace(guard, "$1") : compact;
    if (!/^T(\|\|T)*$/.test(body)) {
      fail(`${job}: \`if: ${cond}\` is not a plain OR of changes outputs, so the gate cannot tell when it may skip`);
      continue;
    }
    const same = asked.length === triggers.length && triggers.every((key) => asked.includes(key));
    if (!same) {
      fail(`${job}: runs when ${asked.join("/") || "nothing"} changed, but ci-gate.mjs expects ${triggers.join("/")}`);
      continue;
    }
    lines.push(`ok   ${job}: runs when ${triggers.join("/")} changed`);
  }

  return { ok, lines };
}

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
  const flag = process.argv.indexOf("--workflow");
  if (flag >= 0) {
    const file = process.argv[flag + 1];
    if (!file) {
      console.error("gate: --workflow needs a path");
      process.exit(1);
    }
    const { ok, lines } = checkWorkflow(readFileSync(file, "utf8"));
    for (const line of lines) console.log(line);
    console.log(ok ? "\nworkflow: gate and jobs agree" : "\nworkflow: FAIL");
    process.exit(ok ? 0 : 1);
  }
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
