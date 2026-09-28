#!/usr/bin/env node
// Runs scenarios against the built test app, each in a fresh process, and
// records every run in <evidence root>/results.json for the acceptance gate.
//
//   node e2e/app/run.mjs                          # every scenario, once
//   node e2e/app/run.mjs --repeat 20 terminal-echo.mjs
//   node e2e/app/run.mjs N01-bridge-safety.mjs N01-acceptance-gate.mjs
//   node e2e/app/run.mjs --ci-set shards --shard 2/3 --keep-going   # a CI shard
//
// Options:
//   --repeat N      run each scenario N times (default 1); a scenario is
//                   green only when every run passes
//   --repeat-scenario FILE=N
//                   run FILE N times instead (repeatable)
//   --ci-set SET    with no scenarios named: run a CI set from ci-plan.mjs
//                   instead of every file. `shards`: the scenarios the shard
//                   jobs split between them; `build`, `keys`: the ones CI
//                   runs in the build job or in the OS key-press step
//   --shard K/N     keep only the scenarios on shard K of N (a stable hash
//                   of the file name; see ci-plan.mjs)
//   --out DIR       evidence root (default <HERMES_E2E_OUT>/evidence)
//   --keep-going    keep running the remaining scenarios after a failure
//   --fresh         start a new results.json instead of adding to it
//   --scenarios DIR scenario folder (default e2e/app/scenarios)
//   --ledger FILE   acceptance ledger (default e2e/acceptance.yml)
//
// Scenarios whose ledger entry excludes this platform are skipped. Results
// accumulate across invocations so a workflow can run different scenario
// sets into the same results.json — which also means one old red run keeps
// `acceptance-check --results` red until you pass --fresh (or delete the
// evidence folder). The exit code and the closing summary cover only the
// runs of this invocation: exit 1 exactly when one of them failed, and each
// failed scenario is named.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { basename, join, resolve } from "node:path";
import { loadLedger, listScenarioFiles } from "./acceptance.mjs";
import { ciSetScenarios, filesInShard, parseShard } from "./ci-plan.mjs";
import { REPO_ROOT, SCENARIOS_DIR, appBinaryPath, outDir } from "./harness.mjs";

const args = process.argv.slice(2);
let repeat = 1;
const repeatFor = new Map();
let out = join(outDir(), "evidence");
let keepGoing = false;
let fresh = false;
let ciSet = null;
let shard = null;
let scenariosDir = SCENARIOS_DIR;
let ledgerFile = join(REPO_ROOT, "e2e", "acceptance.yml");
const picked = [];
const asFile = (name) => (name.endsWith(".mjs") ? name : `${name}.mjs`);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => {
    if (i + 1 >= args.length) throw new Error(`${a} needs a value`);
    return args[++i];
  };
  if (a === "--repeat") repeat = Number(next());
  else if (a === "--repeat-scenario") {
    const m = /^(.+)=(\d+)$/.exec(next());
    if (!m || Number(m[2]) < 1) throw new Error("--repeat-scenario wants FILE=N with N of at least 1");
    repeatFor.set(asFile(m[1]), Number(m[2]));
  } else if (a === "--out") out = resolve(next());
  else if (a === "--keep-going") keepGoing = true;
  else if (a === "--fresh") fresh = true;
  else if (a === "--ci-set") ciSet = next();
  else if (a === "--shard") shard = parseShard(next());
  else if (a === "--scenarios") scenariosDir = resolve(next());
  else if (a === "--ledger") ledgerFile = resolve(next());
  else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
  else picked.push(asFile(a));
}
if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat must be a whole number of at least 1");

const available = listScenarioFiles(scenariosDir);
for (const file of [...picked, ...repeatFor.keys()]) {
  if (!available.includes(file)) throw new Error(`no such scenario: ${file} (have: ${available.join(", ")})`);
}
if (ciSet && picked.length) throw new Error("--ci-set picks the scenarios; do not name any as well");
let scenarios = ciSet ? ciSetScenarios(available, ciSet) : picked.length ? picked : available;
if (shard) scenarios = filesInShard(scenarios, shard);

// Platform restrictions come from the ledger ("file.mjs@linux").
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
let runs = [];
if (!fresh && existsSync(resultsFile)) {
  try {
    runs = JSON.parse(readFileSync(resultsFile, "utf8"));
    if (!Array.isArray(runs)) throw new Error("not a list of runs");
  } catch (err) {
    console.log(`note: ${resultsFile} is unreadable (${err.message}); starting a new one`);
    runs = [];
  }
}
const earlier = runs.length;
const save = () => writeFileSync(resultsFile, JSON.stringify(runs, null, 2) + "\n");

/** Runs of this invocation that failed: { name, n, of, exitCode, signal, evidence }. */
const failed = [];
let runCount = 0;
const skipped = [];
const notRun = [];
const shardLabel = shard ? `   shard: ${shard.index}/${shard.count}` : "";
console.log(`platform: ${platform()}   repeat: ${repeat}${shardLabel}   evidence: ${out}`);
console.log(`scenarios here (${scenarios.length}): ${scenarios.join(", ") || "(none)"}`);
for (const [idx, file] of scenarios.entries()) {
  if (failed.length && !keepGoing) {
    notRun.push(...scenarios.slice(idx).map((f) => basename(f, ".mjs")));
    break;
  }
  const name = basename(file, ".mjs");
  const allowed = allowedPlatforms.get(file);
  if (allowed && !allowed.has(platform())) {
    console.log(`\n=== ${name}: skipped on ${platform()} (ledger lists ${[...allowed].join(", ")})`);
    skipped.push(name);
    continue;
  }
  const times = repeatFor.get(file) ?? repeat;
  for (let n = 1; n <= times; n++) {
    const evidenceDir = join(out, name, times > 1 ? `run-${String(n).padStart(2, "0")}` : "run");
    console.log(`\n=== ${name} (${n}/${times}) → ${evidenceDir}`);
    const started = Date.now();
    const res = spawnSync(process.execPath, [join(scenariosDir, file)], {
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
    runCount++;
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
      failed.push({ name, n, of: times, exitCode: res.status, signal: res.signal ?? null, evidence: evidenceDir, result: result?.status ?? "none" });
      console.log(`=== ${name} (${n}/${times}): FAIL (exit ${res.status}${res.signal ? `, signal ${res.signal}` : ""})`);
      if (!keepGoing) break;
    } else {
      console.log(`=== ${name} (${n}/${times}): PASS in ${Date.now() - started} ms`);
    }
  }
}
if (runCount === 0 && !existsSync(resultsFile)) save();

const inGitHub = process.env.GITHUB_ACTIONS === "true";
console.log(`\n── this invocation${shard ? ` (shard ${shard.index}/${shard.count})` : ""} on ${platform()} ──`);
console.log(`runs: ${runCount}; failed: ${failed.length}; skipped here: ${skipped.length}${notRun.length ? `; not run after a failure: ${notRun.length}` : ""}`);
for (const f of failed) {
  const how = `run ${f.n}/${f.of}, exit ${f.exitCode ?? "none"}${f.signal ? `, signal ${f.signal}` : ""}, result ${f.result}`;
  console.log(`FAILED: ${f.name} (${how}) — evidence: ${f.evidence}`);
  if (inGitHub) console.log(`::error title=Real-app scenario failed::${f.name} failed on ${platform()} (${how})`);
}
if (notRun.length) console.log(`not run (stopped at the first failure; pass --keep-going to run them): ${notRun.join(", ")}`);
console.log(`results: ${resultsFile} (${runs.length} run(s) in total; ${earlier} from earlier invocations, not counted above)`);
console.log(failed.length ? `RUN: FAIL (${[...new Set(failed.map((f) => f.name))].join(", ")})` : "RUN: PASS");
process.exit(failed.length ? 1 : 0);
