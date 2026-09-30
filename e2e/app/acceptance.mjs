// The acceptance ledger (e2e/acceptance.yml): which real-app scenario proves
// which feature, and the rules that make a shipped feature fail the gate when
// its proof is missing or red. Zero dependencies, so it runs with plain Node
// on every CI runner.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export const ALL_PLATFORMS = ["darwin", "win32", "linux"];
export const STATUSES = ["planned", "partial", "shipped"];

// ─── A small YAML reader ─────────────────────────────────────────────
// The ledger only ever uses: nested maps, `- item` lists, `[a, b]` flow
// lists, quoted or bare scalars, and `#` comments. Anything else is an error,
// on purpose — the file is meant to stay that simple.

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

export function parseScalar(raw, where) {
  const text = raw.trim();
  if (text === "" || text === "~" || text === "null") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) throw new Error(`${where}: unterminated double-quoted string`);
    return JSON.parse(text);
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) throw new Error(`${where}: unterminated single-quoted string`);
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.startsWith("[")) {
    if (!text.endsWith("]")) throw new Error(`${where}: unterminated flow list`);
    const inner = text.slice(1, -1).trim();
    if (inner === "") return [];
    return splitFlow(inner, where).map((item) => parseScalar(item, where));
  }
  if (text.startsWith("{")) throw new Error(`${where}: flow maps are not supported in the ledger`);
  return text;
}

function splitFlow(inner, where) {
  const items = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"') current += inner[++i] ?? "";
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ",") {
      items.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (quote) throw new Error(`${where}: unterminated string in flow list`);
  items.push(current);
  return items.filter((s) => s.trim() !== "");
}

/** Parse the YAML subset. Returns plain objects, arrays and scalars. */
export function parseYaml(text, name = "yaml") {
  const lines = [];
  text.split(/\r?\n/).forEach((rawLine, index) => {
    if (rawLine.includes("\t")) throw new Error(`${name}:${index + 1}: tabs are not allowed; indent with spaces`);
    const line = stripComment(rawLine).replace(/\s+$/, "");
    if (line.trim() === "") return;
    lines.push({ indent: line.length - line.trimStart().length, text: line.trim(), number: index + 1 });
  });

  let pos = 0;
  const where = (line) => `${name}:${line.number}`;

  function parseBlock(indent) {
    if (pos >= lines.length) return null;
    const first = lines[pos];
    if (first.indent !== indent) throw new Error(`${where(first)}: unexpected indentation`);
    return first.text.startsWith("- ") || first.text === "-" ? parseList(indent) : parseMap(indent);
  }

  function parseList(indent) {
    const out = [];
    while (pos < lines.length && lines[pos].indent === indent && (lines[pos].text.startsWith("- ") || lines[pos].text === "-")) {
      const line = lines[pos];
      const rest = line.text.slice(1).trim();
      pos++;
      if (rest === "") {
        out.push(parseNested(indent));
      } else if (/^[A-Za-z0-9_.-]+:(\s|$)/.test(rest)) {
        // "- key: value" starts a map whose remaining keys are indented by two.
        const [, key, value] = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(rest);
        const item = {};
        item[key] = value === "" ? parseNested(indent + 2) : parseScalar(value, where(line));
        if (pos < lines.length && lines[pos].indent === indent + 2 && !lines[pos].text.startsWith("- ")) {
          Object.assign(item, parseMap(indent + 2));
        }
        out.push(item);
      } else {
        out.push(parseScalar(rest, where(line)));
      }
    }
    return out;
  }

  function parseNested(indent) {
    if (pos < lines.length && lines[pos].indent > indent) return parseBlock(lines[pos].indent);
    // A list may sit at the same indentation as its key.
    if (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith("- ")) return parseList(indent);
    return null; // "key:" with nothing under it
  }

  function parseMap(indent) {
    const out = {};
    while (pos < lines.length && lines[pos].indent === indent) {
      const line = lines[pos];
      if (line.text.startsWith("- ")) break;
      const m = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^:\s]+)\s*:\s*(.*)$/.exec(line.text);
      if (!m) throw new Error(`${where(line)}: expected "key: value", got "${line.text}"`);
      const key = String(parseScalar(m[1], where(line)));
      if (key in out) throw new Error(`${where(line)}: duplicate key "${key}"`);
      pos++;
      out[key] = m[2] === "" ? parseNested(indent) : parseScalar(m[2], where(line));
    }
    if (pos < lines.length && lines[pos].indent > indent) {
      throw new Error(`${where(lines[pos])}: unexpected indentation`);
    }
    return out;
  }

  const doc = parseBlock(lines[0]?.indent ?? 0);
  if (pos < lines.length) throw new Error(`${where(lines[pos])}: unexpected indentation`);
  return doc;
}

// ─── Ledger model ────────────────────────────────────────────────────

/**
 * "file.mjs" or "file.mjs@darwin,linux" → { file, platforms }.
 * Without a suffix the scenario must be green on every platform.
 */
export function parseScenarioRef(ref, where = "ledger") {
  if (typeof ref !== "string" || ref.trim() === "") throw new Error(`${where}: scenario must be a file name`);
  const [file, suffix] = ref.split("@");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.mjs$/.test(file)) {
    throw new Error(`${where}: "${file}" is not a scenario file name (expected <name>.mjs)`);
  }
  const platforms = suffix === undefined ? [...ALL_PLATFORMS] : suffix.split(",").map((p) => p.trim());
  for (const p of platforms) {
    if (!ALL_PLATFORMS.includes(p)) throw new Error(`${where}: unknown platform "${p}" (use ${ALL_PLATFORMS.join(", ")})`);
  }
  if (platforms.length === 0) throw new Error(`${where}: "${ref}" names no platform`);
  return { file, platforms };
}

/**
 * Validate the parsed ledger and return a normalised model:
 * { features: [{ id, name, status, criteria: [{ id, text, scenarios: [{file, platforms}] }] }] }
 */
export function normaliseLedger(doc, name = "acceptance.yml") {
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || !doc.features || typeof doc.features !== "object") {
    throw new Error(`${name}: expected a top-level "features:" map`);
  }
  const features = [];
  for (const [id, raw] of Object.entries(doc.features)) {
    const where = `${name}: feature ${id}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: expected a map`);
    if (!STATUSES.includes(raw.status)) {
      throw new Error(`${where}: status must be one of ${STATUSES.join(", ")} (got ${JSON.stringify(raw.status ?? null)})`);
    }
    const criteria = [];
    const rawCriteria = raw.criteria ?? {};
    if (typeof rawCriteria !== "object" || Array.isArray(rawCriteria)) throw new Error(`${where}: "criteria" must be a map`);
    for (const [cid, c] of Object.entries(rawCriteria)) {
      const cwhere = `${where}, criterion ${cid}`;
      if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error(`${cwhere}: expected a map`);
      const list = c.scenarios ?? [];
      if (!Array.isArray(list)) throw new Error(`${cwhere}: "scenarios" must be a list`);
      criteria.push({
        id: cid,
        text: typeof c.text === "string" ? c.text : "",
        scenarios: list.map((ref) => parseScenarioRef(ref, cwhere)),
      });
    }
    features.push({ id, name: typeof raw.name === "string" ? raw.name : id, status: raw.status, criteria });
  }
  return { features };
}

export function loadLedger(file) {
  return normaliseLedger(parseYaml(readFileSync(file, "utf8"), basename(file)), basename(file));
}

/** Scenario files that exist in a scenarios directory. */
export function listScenarioFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".mjs") && statSync(join(dir, f)).isFile());
}

// ─── Results ─────────────────────────────────────────────────────────

/** Every results.json under `root` (any depth), flattened to one list of runs. */
export function collectResults(root) {
  const runs = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name === "results.json") {
        const parsed = JSON.parse(readFileSync(full, "utf8"));
        for (const run of Array.isArray(parsed) ? parsed : parsed.runs ?? []) runs.push(run);
      }
    }
  };
  if (existsSync(root)) {
    if (statSync(root).isFile()) {
      const parsed = JSON.parse(readFileSync(root, "utf8"));
      for (const run of Array.isArray(parsed) ? parsed : parsed.runs ?? []) runs.push(run);
    } else visit(root);
  }
  return runs;
}

/**
 * Apply the rules. `results` is optional: without it, only the ledger's shape
 * and the scenario files are checked (a fast pre-commit check).
 *
 * Returns { errors, warnings, rows } where rows describe every scenario ×
 * platform the ledger requires, for printing.
 *
 * `notRun` maps a scenario file to why the CI plan did not run it in this
 * run (its job was skipped: a pull request that does not touch what the
 * job tests). With no result, such a scenario is not applicable to the run
 * instead of missing; a result it does have still counts, red included.
 */
export function evaluateLedger(ledger, { scenarioFiles, results = null, platforms = ALL_PLATFORMS, notRun = new Map() } = {}) {
  const errors = [];
  const warnings = [];
  const rows = [];
  const files = new Set(scenarioFiles);
  const referenced = new Set();

  const byScenarioPlatform = new Map();
  if (results) {
    for (const run of results) {
      const key = `${run.scenario}@${run.platform}`;
      if (!byScenarioPlatform.has(key)) byScenarioPlatform.set(key, []);
      byScenarioPlatform.get(key).push(run);
    }
  }

  for (const feature of ledger.features) {
    const label = `${feature.id} (${feature.name})`;
    if (feature.status === "shipped" && feature.criteria.length === 0) {
      errors.push(`${label} is shipped but lists no acceptance criteria`);
    }
    for (const criterion of feature.criteria) {
      const clabel = `${feature.id}/${criterion.id}`;
      if (feature.status === "shipped" && criterion.scenarios.length === 0) {
        errors.push(`${clabel} is shipped but has no scenario proving it: "${criterion.text}"`);
      }
      for (const { file, platforms: wanted } of criterion.scenarios) {
        const scenario = file.replace(/\.mjs$/, "");
        referenced.add(file);
        if (!files.has(file)) {
          errors.push(`${clabel} names ${file}, which does not exist under the scenarios folder`);
          continue;
        }
        if (!results) continue;
        for (const platform of platforms) {
          if (!wanted.includes(platform)) continue;
          const runs = byScenarioPlatform.get(`${scenario}@${platform}`) ?? [];
          const passes = runs.filter((r) => r.status === "pass").length;
          const fails = runs.length - passes;
          const green = runs.length > 0 && fails === 0;
          const skipped = runs.length === 0 && notRun.has(file) ? notRun.get(file) : null;
          rows.push({ feature: feature.id, criterion: criterion.id, scenario: file, platform, runs: runs.length, passes, fails, green, ...(skipped ? { skipped } : {}) });
          if (feature.status === "planned") continue;
          if (skipped) continue;
          if (runs.length === 0) {
            errors.push(`${clabel}: ${file} has no result on ${platform}`);
          } else if (fails > 0) {
            errors.push(`${clabel}: ${file} failed ${fails} of ${runs.length} run(s) on ${platform}`);
          }
        }
      }
    }
  }

  for (const file of files) {
    if (!referenced.has(file)) warnings.push(`${file} is not referenced by any feature in the ledger`);
  }

  return { errors, warnings, rows };
}

/** Human-readable table of the rows from evaluateLedger. */
export function formatRows(rows) {
  if (rows.length === 0) return "(no results checked)";
  const lines = [];
  const width = Math.max(...rows.map((r) => r.scenario.length), 8);
  for (const r of rows) {
    const mark = r.green ? "green" : r.skipped ? `not run here (${r.skipped})` : r.runs === 0 ? "MISSING" : "RED";
    lines.push(
      `${r.feature.padEnd(5)} ${r.criterion.padEnd(8)} ${r.scenario.padEnd(width)} ${r.platform.padEnd(6)} ${String(r.passes).padStart(3)}/${String(r.runs).padEnd(3)} ${mark}`,
    );
  }
  return lines.join("\n");
}
