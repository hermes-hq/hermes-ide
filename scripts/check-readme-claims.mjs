#!/usr/bin/env node
// The README claims gate. Every bullet under README.md's "## Features"
// heading must be tagged `<!-- claim:<id> -->`, and every tagged claim must
// have an entry in docs/readme-claims.yml that names the real-app scenario
// proving it (a scenario e2e/acceptance.yml actually tracks).
//
// Claims that were in the README before the gate existed and have no scenario
// yet are listed as `unproven`, each with the scenario planned to prove it.
// That backlog can only shrink:
//   - with --baseline (CI passes the target branch's readme-claims.yml), a
//     claim that is unproven here but was not unproven there fails: a new
//     README claim needs a scenario;
//   - an unproven claim whose planned scenario has landed (tracked by the
//     ledger, on disk) fails until it names that scenario;
//   - with --strict every unproven claim fails (CI runs this as a visible,
//     non-blocking job, so the backlog shows red on every run).
// See docs/readme-claims.yml for the format.
//
//   node scripts/check-readme-claims.mjs
//
// Options:
//   --readme <file>    default README.md
//   --claims <file>    default docs/readme-claims.yml
//   --ledger <file>    default e2e/acceptance.yml
//   --scenarios <dir>  default e2e/app/scenarios
//   --baseline <file>  the target branch's readme-claims.yml
//   --strict           fail on every unproven claim

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLedger, listScenarioFiles, parseYaml } from "../e2e/app/acceptance.mjs";

const TAG_RE = /<!--\s*claim:([A-Za-z0-9_-]+)\s*-->/;
export const FEATURES_HEADING = "## Features";

/**
 * Every bullet ("- " or "* ") between the "## Features" heading and the next
 * level-2 heading, with the claim id it is tagged with (or null).
 * Returns null when README.md has no "## Features" section at all.
 */
export function findFeatureBullets(readme) {
  const lines = readme.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === FEATURES_HEADING);
  if (start < 0) return null;
  const bullets = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) break;
    if (!/^\s*[-*]\s+/.test(line)) continue;
    bullets.push({ line, lineNumber: i + 1, id: TAG_RE.exec(line)?.[1] ?? null });
  }
  return bullets;
}

/** Lines in README.md tagged `<!-- claim:<id> -->`, grouped by id. */
export function findTaggedLines(readme) {
  const byId = new Map();
  readme.split(/\r?\n/).forEach((line, i) => {
    const m = TAG_RE.exec(line);
    if (!m) return;
    const id = m[1];
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push({ line, lineNumber: i + 1 });
  });
  return byId;
}

/** Parse and validate docs/readme-claims.yml's shape. Returns a list of claims. */
export function normaliseClaims(doc, name = "readme-claims.yml") {
  if (doc !== null && (typeof doc !== "object" || Array.isArray(doc))) {
    throw new Error(`${name}: expected a top-level "claims:" map`);
  }
  const rawClaims = doc?.claims ?? {};
  if (rawClaims === null) return [];
  if (typeof rawClaims !== "object" || Array.isArray(rawClaims)) throw new Error(`${name}: "claims" must be a map`);
  const claims = [];
  for (const [id, raw] of Object.entries(rawClaims)) {
    const where = `${name}: claim ${id}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: expected a map`);
    if (typeof raw.text !== "string" || raw.text.trim() === "") {
      throw new Error(`${where}: "text" must be a non-empty string (a substring of the tagged README line)`);
    }
    const list = raw.scenarios ?? (raw.scenario ? [raw.scenario] : []);
    const unproven = raw.unproven;
    if (unproven !== undefined) {
      if (typeof unproven !== "string" || unproven.trim() === "") {
        throw new Error(`${where}: "unproven" must say why no scenario proves this claim yet`);
      }
      if (Array.isArray(list) && list.length > 0) {
        throw new Error(`${where}: has both scenarios and "unproven"; drop "unproven" once a scenario proves it`);
      }
      if (typeof raw.planned !== "string" || !/^[A-Za-z0-9._-]+\.mjs$/.test(raw.planned)) {
        throw new Error(`${where}: an unproven claim must name the scenario planned to prove it ("planned: <file>.mjs")`);
      }
      claims.push({ id, text: raw.text, scenarios: [], unproven, planned: raw.planned });
      continue;
    }
    if (raw.planned !== undefined) throw new Error(`${where}: "planned" only goes with "unproven"`);
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(`${where}: needs at least one scenario ("scenario: <file>.mjs" or "scenarios: [...]"), or "unproven: <reason>"`);
    }
    claims.push({ id, text: raw.text, scenarios: list.map(String) });
  }
  return claims;
}

export function loadClaims(file) {
  return normaliseClaims(parseYaml(readFileSync(file, "utf8"), "readme-claims.yml"), "readme-claims.yml");
}

/**
 * Cross-check the claims map against README.md and the acceptance ledger.
 * Returns a list of error strings; empty means the gate passes.
 */
export function checkClaims({ readme, claims, ledgerScenarios, scenarioFiles, baseline = null, strict = false }) {
  const errors = [];
  const tagged = findTaggedLines(readme);
  const claimIds = new Set(claims.map((c) => c.id));

  const bullets = findFeatureBullets(readme);
  if (bullets === null) {
    errors.push(`README.md has no "${FEATURES_HEADING}" section; the gate checks every bullet in it, so it must exist`);
  } else {
    for (const b of bullets) {
      if (!b.id) {
        errors.push(
          `README.md:${b.lineNumber}: feature bullet has no <!-- claim:<id> --> tag; tag it and add the claim to docs/readme-claims.yml with the scenario that proves it (or "unproven: <reason>")`,
        );
      }
    }
  }

  for (const id of tagged.keys()) {
    if (!claimIds.has(id)) {
      const at = tagged.get(id).map((t) => t.lineNumber).join(", ");
      errors.push(`README.md:${at} tags claim "${id}" with <!-- claim:${id} --> but docs/readme-claims.yml has no entry for it`);
    }
  }

  for (const claim of claims) {
    const lines = tagged.get(claim.id);
    if (!lines || lines.length === 0) {
      errors.push(`docs/readme-claims.yml: claim "${claim.id}" has no <!-- claim:${claim.id} --> line in README.md (stale entry)`);
    } else if (!lines.some((l) => l.line.includes(claim.text))) {
      errors.push(
        `docs/readme-claims.yml: claim "${claim.id}"'s text ${JSON.stringify(claim.text)} is not found on its tagged README.md line(s) ${lines.map((l) => l.lineNumber).join(", ")}`,
      );
    }
    if (claim.scenarios.length === 0 && !claim.unproven) {
      errors.push(`docs/readme-claims.yml: claim "${claim.id}" has no scenario proving it`);
    }
    if (claim.unproven) {
      if (ledgerScenarios.has(claim.planned) && scenarioFiles.includes(claim.planned)) {
        errors.push(
          `docs/readme-claims.yml: claim "${claim.id}" is still unproven, but its planned scenario ${claim.planned} has landed; replace "unproven"/"planned" with "scenario: ${claim.planned}" (or plan a different scenario if it does not prove the claim)`,
        );
      }
      if (baseline) {
        const before = baseline.find((c) => c.id === claim.id);
        if (!before) {
          errors.push(`docs/readme-claims.yml: claim "${claim.id}" is new and has no scenario; a new README claim needs a real-app scenario that proves it`);
        } else if (!before.unproven) {
          errors.push(`docs/readme-claims.yml: claim "${claim.id}" was proven by ${before.scenarios.join(", ")} and is now unproven; keep its scenario`);
        }
      }
      if (strict) errors.push(`docs/readme-claims.yml: claim "${claim.id}" has no scenario yet (planned: ${claim.planned})`);
    }
    for (const file of claim.scenarios) {
      if (!ledgerScenarios.has(file)) {
        errors.push(`docs/readme-claims.yml: claim "${claim.id}" names ${file}, which e2e/acceptance.yml does not reference from any feature`);
      } else if (!scenarioFiles.includes(file)) {
        errors.push(`docs/readme-claims.yml: claim "${claim.id}" names ${file}, which does not exist under e2e/app/scenarios/`);
      }
    }
  }

  return errors;
}

/** Every scenario file name referenced by any criterion in the ledger. */
export function ledgerScenarioFiles(ledger) {
  const set = new Set();
  for (const feature of ledger.features) {
    for (const criterion of feature.criteria) {
      for (const { file } of criterion.scenarios) set.add(file);
    }
  }
  return set;
}

// ─── CLI ─────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const opts = { readme: "README.md", claims: "docs/readme-claims.yml", ledger: "e2e/acceptance.yml", scenarios: "e2e/app/scenarios" };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => {
      if (i + 1 >= args.length) throw new Error(`${a} needs a value`);
      return args[++i];
    };
    if (a === "--readme") opts.readme = next();
    else if (a === "--claims") opts.claims = next();
    else if (a === "--ledger") opts.ledger = next();
    else if (a === "--scenarios") opts.scenarios = next();
    else if (a === "--baseline") opts.baseline = next();
    else if (a === "--strict") opts.strict = true;
    else if (a === "--help" || a === "-h") {
      console.log("usage: node scripts/check-readme-claims.mjs [--readme f] [--claims f] [--ledger f] [--scenarios d] [--baseline f] [--strict]");
      process.exit(0);
    } else throw new Error(`unknown option ${a}`);
  }

  const readme = readFileSync(resolve(opts.readme), "utf8");
  const claims = loadClaims(resolve(opts.claims));
  const ledger = loadLedger(resolve(opts.ledger));
  const scenarioFiles = listScenarioFiles(resolve(opts.scenarios));

  const baseline = opts.baseline ? loadClaims(resolve(opts.baseline)) : null;

  const errors = checkClaims({ readme, claims, ledgerScenarios: ledgerScenarioFiles(ledger), scenarioFiles, baseline, strict: !!opts.strict });

  const unproven = claims.filter((c) => c.unproven);
  console.log(
    `README claims: ${claims.length} tagged claim(s) checked against ${opts.ledger}; ${claims.length - unproven.length} proven by a scenario, ${unproven.length} listed as unproven`,
  );
  if (baseline) console.log(`compared with the baseline ${opts.baseline} (${baseline.filter((c) => c.unproven).length} unproven there)`);
  for (const c of unproven) console.log(`  unproven: ${c.id} — ${c.unproven} (planned: ${c.planned})`);
  if (errors.length) {
    console.log("");
    for (const e of errors) console.log(`CLAIMS GATE: ${e}`);
    console.log(`\nCLAIMS GATE: FAIL (${errors.length} problem${errors.length === 1 ? "" : "s"})`);
    process.exit(1);
  }
  console.log("\nCLAIMS GATE: PASS");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
