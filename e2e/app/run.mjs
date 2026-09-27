#!/usr/bin/env node
// Runs scenarios against the built test app, each in a fresh process, and
// records every run in <evidence root>/results.json for the acceptance gate.
//
//   node e2e/app/run.mjs                          # every scenario, once
//   node e2e/app/run.mjs --repeat 20 terminal-echo.mjs
//   node e2e/app/run.mjs N01-bridge-safety.mjs N01-acceptance-gate.mjs
//
// Options:
//   --repeat N      run each scenario N times (default 1); a scenario is
//                   green only when every run passes
//   --out DIR       evidence root (default <HERMES_E2E_OUT>/evidence)
//   --keep-going    keep running the remaining scenarios after a failure
//   --fresh         start a new results.json instead of adding to it
//
// Scenarios whose ledger entry excludes this platform are skipped. Results
// accumulate across invocations so a workflow can run different scenario
// sets with different repeat counts into the same results.json — which also
// means one old red run keeps `acceptance-check --results` red until you
// pass --fresh (or delete the evidence folder).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { basename, join, resolve } from "node:path";
import { loadLedger, listScenarioFiles } from "./acceptance.mjs";
import { REPO_ROOT, SCENARIOS_DIR, appBinaryPath, outDir } from "./harness.mjs";

const args = process.argv.slice(2);
let repeat = 1;
let out = join(outDir(), "evidence");
let keepGoing = false;
let fresh = false;
const picked = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--repeat") repeat = Number(args[++i]);
  else if (a === "--out") out = resolve(args[++i]);
  else if (a === "--keep-going") keepGoing = true;
  else if (a === "--fresh") fresh = true;
  else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
  else picked.push(a.endsWith(".mjs") ? a : `${a}.mjs`);
}
if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat must be a whole number of at least 1");

const available = listScenarioFiles(SCENARIOS_DIR);
const scenarios = picked.length ? picked : available;
for (const file of scenarios) {
  if (!available.includes(file)) throw new Error(`no such scenario: ${file} (have: ${available.join(", ")})`);
}

// Platform restrictions come from the ledger ("file.mjs@linux").
const ledgerFile = join(REPO_ROOT, "e2e", "acceptance.yml");
const allowedPlatforms = new Map();
if (existsSync(ledgerFile)) {
  for (const feature of loadLedger(ledgerFile).features) {
    for (const c of feature.criteria) {
      for (const s of c.scenarios) {
        const set = allowedPlatforms.get(s.file) ?? new Set();
        for (const p of s.platforms) set.add(p);
        allowedPlatforms.set(s.file, set);
      }
    }
  }
}

if (!existsSync(appBinaryPath())) {
  console.log(`note: test app not built at ${appBinaryPath()}; scenarios that launch it will fail`);
}

mkdirSync(out, { recursive: true });
const resultsFile = join(out, "results.json");
const runs = !fresh && existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, "utf8")) : [];
const save = () => writeFileSync(resultsFile, JSON.stringify(runs, null, 2) + "\n");

let failures = 0;
let skipped = 0;
console.log(`platform: ${platform()}   repeat: ${repeat}   evidence: ${out}`);
for (const file of scenarios) {
  const name = basename(file, ".mjs");
  const allowed = allowedPlatforms.get(file);
  if (allowed && !allowed.has(platform())) {
    console.log(`\n=== ${name}: skipped on ${platform()} (ledger lists ${[...allowed].join(", ")})`);
    skipped++;
    continue;
  }
  for (let n = 1; n <= repeat; n++) {
    const evidenceDir = join(out, name, repeat > 1 ? `run-${String(n).padStart(2, "0")}` : "run");
    console.log(`\n=== ${name} (${n}/${repeat}) → ${evidenceDir}`);
    const started = Date.now();
    const res = spawnSync(process.execPath, [join(SCENARIOS_DIR, file)], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: { ...process.env, HERMES_E2E_EVIDENCE: evidenceDir },
    });
    const resultFile = join(evidenceDir, "result.json");
    let result = null;
    if (existsSync(resultFile)) {
      try {
        result = JSON.parse(readFileSync(resultFile, "utf8"));
      } catch {
        result = null;
      }
    }
    const status = res.status === 0 && result?.status === "pass" ? "pass" : "fail";
    runs.push({
      scenario: name,
      platform: platform(),
      run: n,
      status,
      exitCode: res.status,
      signal: res.signal ?? null,
      durationMs: Date.now() - started,
      evidence: evidenceDir,
      finishedAt: new Date().toISOString(),
    });
    save();
    if (status === "fail") {
      failures++;
      console.log(`=== ${name} (${n}/${repeat}): FAIL (exit ${res.status}${res.signal ? `, signal ${res.signal}` : ""})`);
      if (!keepGoing) break;
    } else {
      console.log(`=== ${name} (${n}/${repeat}): PASS in ${Date.now() - started} ms`);
    }
  }
  if (failures && !keepGoing) break;
}

const total = runs.length;
console.log(`\nresults: ${resultsFile}`);
console.log(`runs recorded: ${total}; failed in this invocation: ${failures}; scenarios skipped here: ${skipped}`);
process.exit(failures ? 1 : 0);
