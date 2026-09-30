#!/usr/bin/env node
// Stylesheet lint with a baseline: the rules in .stylelintrc.json
// (docs/design-system/09-migration.md) hold for
//
//   - every line of the control set's stylesheets (src/styles/ui/), of the
//     screens already moved to it (STRICT_FILES) and of any stylesheet
//     added since the base commit, and
//   - only the added or changed lines of every other stylesheet.
//
// Existing lines of older stylesheets are the baseline: they migrate when a
// screen moves to the control set, not all at once. So a change may not add
// a raw px, a raw colour, a hand-rolled shadow or an outline:none, but it
// does not have to fix the lines around it.
//
//   node scripts/lint-css.mjs                 # against the merge-base with origin/main
//   node scripts/lint-css.mjs --base HEAD^1   # CI: against the PR's base
//
// Exit 1 when a problem is found. Uncommitted changes count too.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Stylesheets held to the rules on every line, whatever changed. */
export const STRICT_DIRS = ["src/styles/ui/"];

/**
 * Stylesheets of screens that have moved to the control set: they are held
 * to the rules on every line too, so a raw value cannot creep back in.
 */
export const STRICT_FILES = [
  "src/styles/components/AgentDoctor.css",
  "src/styles/components/SessionBranchSelector.css",
  "src/styles/components/SessionCreator.css",
  "src/styles/components/SetupWizard.css",
  "src/styles/components/TaskLauncher.css",
];

/** Line numbers (in the new file) added or changed by a unified diff with -U0. */
export function addedLines(diff) {
  const lines = new Set();
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < count; i++) lines.add(start + i);
  }
  return lines;
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Which stylesheets to lint and which of their lines count:
 * Map<relative path, "all" | Set<line>>.
 */
export function lintScope({ cwd = ROOT, base, strictFiles = STRICT_FILES }) {
  const mergeBase = git(["merge-base", base, "HEAD"], cwd).trim();
  const scope = new Map();
  // Changed against the merge-base, working tree included. Renames count as new files.
  const status = git(["diff", "--name-status", "--no-renames", mergeBase, "--", "*.css"], cwd);
  for (const line of status.split("\n").filter(Boolean)) {
    const [code, file] = line.split("\t");
    if (code === "D") continue;
    if (code === "A" || STRICT_DIRS.some((d) => file.startsWith(d)) || strictFiles.includes(file)) {
      scope.set(file, "all");
      continue;
    }
    const diff = git(["diff", "-U0", mergeBase, "--", file], cwd);
    const lines = addedLines(diff);
    if (lines.size > 0) scope.set(file, lines);
  }
  // Untracked stylesheets are new files.
  for (const file of git(["ls-files", "--others", "--exclude-standard", "--", "*.css"], cwd).split("\n").filter(Boolean)) {
    scope.set(file, "all");
  }
  // The control set is always checked in full.
  for (const file of git(["ls-files", "--", ...STRICT_DIRS.map((d) => `${d}*.css`)], cwd).split("\n").filter(Boolean)) {
    if (existsSync(join(cwd, file))) scope.set(file, "all");
  }
  // So are the stylesheets of the screens already on it.
  for (const file of strictFiles) {
    if (existsSync(join(cwd, file))) scope.set(file, "all");
  }
  return scope;
}

/** Keep the problems that fall on lines in scope. */
export function problemsInScope(results, scope, cwd = ROOT) {
  const out = [];
  for (const result of results) {
    const file = relative(cwd, result.source).split("\\").join("/");
    const lines = scope.get(file);
    if (!lines) continue;
    for (const w of result.warnings) {
      if (lines === "all" || lines.has(w.line)) out.push({ file, line: w.line, column: w.column, rule: w.rule, text: w.text });
    }
  }
  return out;
}

export async function lintChangedCss({ cwd = ROOT, base = "origin/main", configFile = join(ROOT, ".stylelintrc.json"), strictFiles = STRICT_FILES } = {}) {
  const { default: stylelint } = await import("stylelint");
  const scope = lintScope({ cwd, base, strictFiles });
  const files = [...scope.keys()].filter((f) => existsSync(join(cwd, f)));
  if (files.length === 0) return { scope, problems: [] };
  const { results } = await stylelint.lint({
    files: files.map((f) => join(cwd, f)),
    configFile,
    configBasedir: cwd,
    allowEmptyInput: true,
  });
  return { scope, problems: problemsInScope(results, scope, cwd) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--base");
  const base = i > 0 ? process.argv[i + 1] : process.env.CSS_LINT_BASE || "origin/main";
  const { scope, problems } = await lintChangedCss({ base });
  for (const p of problems) console.error(`${p.file}:${p.line}:${p.column}  ${p.text}`);
  const strict = [...scope.values()].filter((v) => v === "all").length;
  console.log(
    `${problems.length} problem(s) in ${scope.size} stylesheet(s) checked against ${base} (${strict} in full, ${scope.size - strict} on changed lines)`,
  );
  process.exit(problems.length ? 1 : 0);
}
