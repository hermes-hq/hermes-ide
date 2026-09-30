#!/usr/bin/env node
// The acceptance gate. Reads e2e/acceptance.yml and fails (exit 1) when a
// feature marked `shipped` has a criterion with no scenario, names a scenario
// file that does not exist, or — when results are given — has a scenario
// that is missing or red on any platform it must be green on.
//
//   node e2e/acceptance-check.mjs                       # ledger + files only
//   node e2e/acceptance-check.mjs --results <dir|file>  # plus CI results
//
// Options:
//   --ledger <file>       default e2e/acceptance.yml
//   --scenarios <dir>     default e2e/app/scenarios
//   --results <path>      a results.json, or a folder searched for them
//                         (repeatable; CI passes the downloaded artifacts)
//   --platforms a,b,c     platforms that must be green (default: all three)
//   --skipped-job <id>    a CI job the plan skipped in this run (repeatable):
//                         its scenarios (CI_JOB_SCENARIOS in app/ci-plan.mjs)
//                         are not applicable when they have no result. CI
//                         passes it only on a pull request whose change the
//                         job does not test.

import { resolve } from "node:path";
import { CI_JOB_SCENARIOS } from "./app/ci-plan.mjs";
import {
  ALL_PLATFORMS,
  collectResults,
  evaluateLedger,
  formatRows,
  listScenarioFiles,
  loadLedger,
} from "./app/acceptance.mjs";

const args = process.argv.slice(2);
const opts = { ledger: "e2e/acceptance.yml", scenarios: "e2e/app/scenarios", results: [], platforms: ALL_PLATFORMS, skippedJobs: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => {
    if (i + 1 >= args.length) throw new Error(`${a} needs a value`);
    return args[++i];
  };
  if (a === "--ledger") opts.ledger = next();
  else if (a === "--scenarios") opts.scenarios = next();
  else if (a === "--results") opts.results.push(next());
  else if (a === "--platforms") opts.platforms = next().split(",").map((p) => p.trim()).filter(Boolean);
  else if (a === "--skipped-job") {
    const job = next();
    if (!Object.hasOwn(CI_JOB_SCENARIOS, job)) throw new Error(`--skipped-job: unknown job ${JSON.stringify(job)} (have: ${Object.keys(CI_JOB_SCENARIOS).join(", ")})`);
    opts.skippedJobs.push(job);
  } else if (a === "--help" || a === "-h") {
    console.log("usage: node e2e/acceptance-check.mjs [--ledger f] [--scenarios d] [--results p]... [--platforms a,b] [--skipped-job id]...");
    process.exit(0);
  } else throw new Error(`unknown option ${a}`);
}

const ledgerFile = resolve(opts.ledger);
const ledger = loadLedger(ledgerFile);
const scenarioFiles = listScenarioFiles(resolve(opts.scenarios));
const results = opts.results.length ? opts.results.flatMap((p) => collectResults(resolve(p))) : null;

const notRun = new Map();
for (const job of opts.skippedJobs) for (const file of CI_JOB_SCENARIOS[job]) notRun.set(file, `${job} skipped`);

const { errors, warnings, rows } = evaluateLedger(ledger, { scenarioFiles, results, platforms: opts.platforms, notRun });

console.log(`acceptance ledger: ${ledgerFile}`);
console.log(`features: ${ledger.features.map((f) => `${f.id}=${f.status}`).join(", ") || "(none)"}`);
console.log(`scenario files: ${scenarioFiles.length}; results: ${results ? `${results.length} run(s)` : "not checked"}`);
if (notRun.size) console.log(`not applicable to this run (their CI job was skipped): ${[...notRun.keys()].join(", ")}`);
if (rows.length) {
  console.log("");
  console.log(formatRows(rows));
}
for (const w of warnings) console.log(`warning: ${w}`);
if (errors.length) {
  console.log("");
  for (const e of errors) console.log(`ACCEPTANCE GATE: ${e}`);
  console.log(`\nACCEPTANCE GATE: FAIL (${errors.length} problem${errors.length === 1 ? "" : "s"})`);
  process.exit(1);
}
console.log("\nACCEPTANCE GATE: PASS");
