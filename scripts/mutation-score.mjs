#!/usr/bin/env node
// Mutation score for the nightly mutation job (.github/workflows/mutation.yml).
//
// Reads cargo-mutants' outcomes.json and fails when fewer than --min percent
// of the viable mutants on changed lines were killed. A mutant counts as
// killed when the tests caught it or timed out on it; unviable mutants (the
// mutation does not compile) are left out.
//
// A reviewed waiver is an `exclude_re` entry in src-tauri/.cargo/mutants.toml,
// added in a pull request that says why the mutant cannot be killed.
// The file is created by the first such pull request.
//
// Usage: node scripts/mutation-score.mjs <outcomes.json> [--min 80]

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * @param {{ outcomes?: { scenario: unknown, summary: string }[] }} outcomes
 * @param {number} min percent
 */
export function scoreOutcomes(outcomes, min) {
  const counts = { caught: 0, missed: 0, timeout: 0, unviable: 0 };
  const missed = [];
  for (const o of outcomes.outcomes ?? []) {
    if (o.scenario === "Baseline") continue;
    const kind = String(o.summary).toLowerCase();
    if (kind === "caughtmutant") counts.caught++;
    else if (kind === "missedmutant") {
      counts.missed++;
      missed.push(describe(o.scenario));
    } else if (kind === "timeout") counts.timeout++;
    else if (kind === "unviable") counts.unviable++;
  }
  const viable = counts.caught + counts.missed + counts.timeout;
  const killed = counts.caught + counts.timeout;
  const percent = viable === 0 ? 100 : Math.floor((killed * 1000) / viable) / 10;
  return { counts, viable, killed, percent, ok: percent >= min, missed };
}

/** cargo-mutants names each mutant as "file:line:col: replace X with Y in fn". */
function describe(scenario) {
  const m = scenario && scenario.Mutant;
  return m && m.name ? m.name : JSON.stringify(scenario);
}

function main() {
  const args = process.argv.slice(2);
  const minIdx = args.indexOf("--min");
  const file = args.find((a, i) => !a.startsWith("--") && i !== minIdx + 1);
  const min = minIdx >= 0 ? Number(args[minIdx + 1]) : 80;
  if (!file || Number.isNaN(min)) {
    console.error("usage: mutation-score.mjs <outcomes.json> [--min 80]");
    process.exit(2);
  }
  const result = scoreOutcomes(JSON.parse(readFileSync(file, "utf8")), min);
  const { counts, viable, killed, percent, ok, missed } = result;
  console.log(`caught ${counts.caught}, timeout ${counts.timeout}, missed ${counts.missed}, unviable ${counts.unviable}`);
  for (const m of missed) console.log(`MISSED ${m}`);
  console.log(`mutation score: ${percent}% (${killed}/${viable} killed, minimum ${min}%) ${ok ? "PASS" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
