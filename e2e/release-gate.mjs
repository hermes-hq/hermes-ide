#!/usr/bin/env node
// The release gate: nothing is built for a release unless the commit has
// passed CI's `gate` check — the real-app scenarios on all three OSes plus
// the acceptance ledger — and the ledger in the tree is well-formed.
//
//   node e2e/release-gate.mjs --sha <commit>            # in CI (uses `gh api`)
//   node e2e/release-gate.mjs --sha <commit> --check-runs runs.json   # offline
//
// Options:
//   --sha <commit>         the commit being released (required)
//   --check <name>         the check run that must have passed (default: gate)
//   --repo <owner/name>    default $GITHUB_REPOSITORY
//   --wait-minutes <n>     how long to wait for a running check (default 90)
//   --missing-grace-minutes <n>
//                          how long a commit may have no run of that name
//                          before that counts as "CI did not run" (default
//                          15): CI and the release start together on a push
//                          to main, so the check can be a few seconds away
//   --check-runs <file>    read the check runs from a JSON file instead of
//                          GitHub (a { check_runs: [...] } object or an array)
//   --ledger <file>        default e2e/acceptance.yml
//   --scenarios <dir>      default e2e/app/scenarios
//
// Exit 0 and "RELEASE GATE: PASS" when the release may go ahead; exit 1 and
// "RELEASE GATE: FAIL" with the reason otherwise. A commit that still has no
// `gate` run after the grace period (CI did not run on it) fails: run the CI
// workflow on it first.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateLedger, listScenarioFiles, loadLedger } from "./app/acceptance.mjs";
import { waitForRequiredCheck } from "./app/required-check.mjs";

const args = process.argv.slice(2);
const opts = {
  sha: "",
  check: "gate",
  repo: process.env.GITHUB_REPOSITORY || "",
  waitMinutes: 90,
  missingGraceMinutes: 15,
  checkRuns: "",
  ledger: "e2e/acceptance.yml",
  scenarios: "e2e/app/scenarios",
};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => {
    if (i + 1 >= args.length) throw new Error(`${a} needs a value`);
    return args[++i];
  };
  if (a === "--sha") opts.sha = next();
  else if (a === "--check") opts.check = next();
  else if (a === "--repo") opts.repo = next();
  else if (a === "--wait-minutes") opts.waitMinutes = Number(next());
  else if (a === "--missing-grace-minutes") opts.missingGraceMinutes = Number(next());
  else if (a === "--check-runs") opts.checkRuns = next();
  else if (a === "--ledger") opts.ledger = next();
  else if (a === "--scenarios") opts.scenarios = next();
  else if (a === "--help" || a === "-h") {
    console.log(
      "usage: node e2e/release-gate.mjs --sha <commit> [--check gate] [--repo o/r] [--wait-minutes n] [--missing-grace-minutes n] [--check-runs f]",
    );
    process.exit(0);
  } else throw new Error(`unknown option ${a}`);
}

function fail(reason) {
  console.log(`RELEASE GATE: ${reason}`);
  console.log("\nRELEASE GATE: FAIL");
  process.exit(1);
}

if (!/^[0-9a-f]{7,40}$/i.test(opts.sha)) fail(`--sha must be a commit hash, got "${opts.sha}"`);
if (!Number.isFinite(opts.waitMinutes) || opts.waitMinutes < 0) fail("--wait-minutes must be a number");
if (!Number.isFinite(opts.missingGraceMinutes) || opts.missingGraceMinutes < 0) fail("--missing-grace-minutes must be a number");

// 1. The ledger in the tree: every shipped feature names scenarios that exist.
const ledgerFile = resolve(opts.ledger);
const ledger = loadLedger(ledgerFile);
const { errors } = evaluateLedger(ledger, { scenarioFiles: listScenarioFiles(resolve(opts.scenarios)), results: null });
console.log(`acceptance ledger: ${ledgerFile} — ${errors.length ? `${errors.length} problem(s)` : "well-formed"}`);
for (const e of errors) console.log(`  ${e}`);
if (errors.length) fail("the acceptance ledger has problems (see above)");

// 2. The commit's CI gate: the scenarios ran green on every OS and the
//    ledger was checked against their results.
function fetchFromFile() {
  const doc = JSON.parse(readFileSync(resolve(opts.checkRuns), "utf8"));
  return Array.isArray(doc) ? doc : doc.check_runs ?? [];
}

function fetchFromGitHub() {
  if (!opts.repo) fail("--repo (or $GITHUB_REPOSITORY) is needed to read check runs");
  const runs = [];
  for (let page = 1; page <= 20; page++) {
    const res = spawnSync(
      "gh",
      ["api", `repos/${opts.repo}/commits/${opts.sha}/check-runs?per_page=100&page=${page}`, "-H", "Accept: application/vnd.github+json"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    if (res.status !== 0) fail(`could not read check runs for ${opts.sha}: ${(res.stderr || res.stdout || "").trim()}`);
    const doc = JSON.parse(res.stdout);
    runs.push(...(doc.check_runs ?? []));
    if (runs.length >= (doc.total_count ?? 0) || (doc.check_runs ?? []).length === 0) break;
  }
  return runs;
}

const fetchCheckRuns = opts.checkRuns ? fetchFromFile : fetchFromGitHub;
console.log(
  `commit ${opts.sha}: waiting up to ${opts.waitMinutes} min for the "${opts.check}" check (up to ${opts.missingGraceMinutes} min for CI to register it)`,
);
const result = await waitForRequiredCheck(fetchCheckRuns, opts.check, {
  timeoutMs: opts.waitMinutes * 60_000,
  intervalMs: opts.checkRuns ? 0 : 30_000,
  // Offline (--check-runs) reads a fixed file: a missing run there is missing.
  missingGraceMs: opts.checkRuns ? 0 : opts.missingGraceMinutes * 60_000,
  log: (m) => console.log(`  ${m}`),
});
console.log(`  ${result.detail}`);
if (result.state !== "success") {
  fail(
    result.state === "missing"
      ? `${result.detail}. CI did not run on this commit; run the CI workflow on it (workflow_dispatch) and release again.`
      : result.detail,
  );
}
console.log("\nRELEASE GATE: PASS");
