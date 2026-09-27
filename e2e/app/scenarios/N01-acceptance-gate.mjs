#!/usr/bin/env node
// Scenario: the acceptance gate (e2e/acceptance-check.mjs) fails when a
// shipped feature has no green scenario on every platform, and passes when
// it does. Runs the real gate script as a child process against synthetic
// ledgers and results in a temporary folder.
//
//   node e2e/app/scenarios/N01-acceptance-gate.mjs

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, createLogger, finishScenario, outDir } from "../harness.mjs";

const SCENARIO = "N01-acceptance-gate";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);
const GATE = join(REPO_ROOT, "e2e", "acceptance-check.mjs");

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

const work = mkdtempSync(join(tmpdir(), "hermes-gate-"));
const scenariosDir = join(work, "scenarios");
mkdirSync(scenariosDir);
writeFileSync(join(scenariosDir, "F99-thing.mjs"), "// synthetic scenario\n");

function ledger(status, scenarios = "[F99-thing.mjs]") {
  const file = join(work, `ledger-${status}-${Math.random().toString(36).slice(2, 8)}.yml`);
  writeFileSync(
    file,
    `features:\n  F99:\n    name: "Synthetic feature"\n    status: ${status}\n    criteria:\n      F99-1:\n        text: "it works"\n        scenarios: ${scenarios}\n`,
  );
  return file;
}

function results(name, runs) {
  const dir = join(work, "results", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "results.json"), JSON.stringify(runs));
  return dir;
}

const run = (n, p, status) => ({ scenario: "F99-thing", platform: p, run: n, status });
const green = (p, times = 3) => Array.from({ length: times }, (_, i) => run(i + 1, p, "pass"));

function gate(args) {
  const res = spawnSync(process.execPath, [GATE, "--scenarios", scenariosDir, ...args], {
    cwd: work,
    encoding: "utf8",
  });
  const out = (res.stdout ?? "") + (res.stderr ?? "");
  log(`  $ acceptance-check ${args.join(" ")} → exit ${res.status}`);
  for (const line of out.trim().split("\n").filter((l) => /ACCEPTANCE GATE/.test(l))) log(`    ${line}`);
  return { status: res.status, out };
}

let failed = false;
try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   work dir: ${work}`);

  log("case 1: shipped feature, green on all three platforms → PASS");
  const all = results("all", [...green("darwin"), ...green("win32"), ...green("linux")]);
  let r = gate(["--ledger", ledger("shipped"), "--results", all]);
  assert(r.status === 0 && r.out.includes("ACCEPTANCE GATE: PASS"), "gate passes");

  log("case 2: shipped feature, no result on Windows → FAIL");
  const twoOs = results("two-os", [...green("darwin"), ...green("linux")]);
  r = gate(["--ledger", ledger("shipped"), "--results", twoOs]);
  assert(r.status === 1, "gate exits 1");
  assert(r.out.includes("no result on win32"), "and names the missing platform");

  log("case 3: shipped feature, one red run on Linux out of 20 → FAIL");
  const oneRed = results("one-red", [...green("darwin"), ...green("win32"), ...green("linux", 19), run(20, "linux", "fail")]);
  r = gate(["--ledger", ledger("shipped"), "--results", oneRed]);
  assert(r.status === 1 && r.out.includes("failed 1 of 20 run(s) on linux"), "gate exits 1 and names the red run");

  log("case 4: shipped feature whose criterion lists no scenario → FAIL even without results");
  r = gate(["--ledger", ledger("shipped", "[]")]);
  assert(r.status === 1 && r.out.includes("has no scenario proving it"), "gate exits 1 and says the proof is missing");

  log("case 5: shipped feature naming a scenario file that does not exist → FAIL");
  r = gate(["--ledger", ledger("shipped", "[F99-missing.mjs]")]);
  assert(r.status === 1 && r.out.includes("does not exist"), "gate exits 1 and names the missing file");

  log("case 6: the same gaps on a planned feature → PASS (nothing is required yet)");
  r = gate(["--ledger", ledger("planned", "[]"), "--results", twoOs]);
  assert(r.status === 0, "gate passes");

  log("case 7: a scenario limited to Linux is only required there");
  const linuxOnly = results("linux-only", green("linux"));
  r = gate(["--ledger", ledger("shipped", "[F99-thing.mjs@linux]"), "--results", linuxOnly]);
  assert(r.status === 0, "gate passes with Linux results alone");

  log("case 8: the repository's own ledger is well-formed and every scenario it names exists");
  r = spawnSync(process.execPath, [GATE], { cwd: REPO_ROOT, encoding: "utf8" });
  assert(r.status === 0, `node e2e/acceptance-check.mjs passes in the repository (exit ${r.status})`);
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
