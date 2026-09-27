#!/usr/bin/env node
// Scenario: the two "docs stay true" gates really gate.
//
//   1. The shortcut tables are generated: removing a shortcut from the menu
//      (or from src/shortcuts/app-shortcuts.json) changes the generated table,
//      and `generate-shortcuts.mjs --check` (the CI job) fails until the docs
//      are regenerated.
//   2. A README feature bullet with no scenario fails the claims gate (the CI
//      job), while the repository's own README passes it.
//
// Runs the real gate scripts as child processes, against copies of the
// repository's own menu, app-shortcuts.json and README.md in a temp folder.
//
//   node e2e/app/scenarios/N23-docs-gates.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, createLogger, finishScenario, outDir } from "../harness.mjs";

const SCENARIO = "N23-docs-gates";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

const GENERATOR = join(REPO_ROOT, "scripts", "generate-shortcuts.mjs");
const CLAIMS = join(REPO_ROOT, "scripts", "check-readme-claims.mjs");
const MENU = join(REPO_ROOT, "src-tauri", "src", "menu", "mod.rs");
const APP_JSON = join(REPO_ROOT, "src", "shortcuts", "app-shortcuts.json");
const README = join(REPO_ROOT, "README.md");
const DOCS_MD = join(REPO_ROOT, "docs", "shortcuts.md");

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

function run(script, args, label) {
  const res = spawnSync(process.execPath, [script, ...args], { cwd: REPO_ROOT, encoding: "utf8" });
  const out = (res.stdout ?? "") + (res.stderr ?? "");
  log(`  $ ${label} → exit ${res.status}`);
  for (const line of out.trim().split("\n").filter((l) => /STALE|up to date|CLAIMS GATE|feature bullet/.test(l))) log(`    ${line}`);
  return { status: res.status, out };
}

const work = mkdtempSync(join(tmpdir(), "hermes-docs-gates-"));
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   work dir: ${work}`);

  log("case 1: the repository's generated shortcut docs match the menu and app-shortcuts.json");
  let r = run(GENERATOR, ["--check"], "generate-shortcuts --check");
  assert(r.status === 0 && r.out.includes("up to date"), "the CI check passes on the repository as committed");
  assert(readFileSync(DOCS_MD, "utf8").includes("| New Tab | ⌘T | Ctrl+T |"), "docs/shortcuts.md lists New Tab (CmdOrCtrl+T in the menu)");

  log("case 2: remove New Tab's accelerator from a copy of the menu");
  const menu = readFileSync(MENU, "utf8");
  const trimmedMenu = menu.replace(/(with_id\("file\.new-session-tab", "New Tab"\)\s*)\.accelerator\("CmdOrCtrl\+T"\)/, "$1");
  assert(trimmedMenu !== menu, "the copy no longer binds CmdOrCtrl+T");
  const menuCopy = join(work, "mod.rs");
  writeFileSync(menuCopy, trimmedMenu);
  r = run(GENERATOR, ["--check", "--menu", menuCopy], "generate-shortcuts --check --menu <copy>");
  assert(r.status === 1 && r.out.includes("STALE"), "the CI check fails: the committed docs no longer match the menu");
  const tsOut = join(work, "shortcuts.ts");
  const mdOut = join(work, "shortcuts.md");
  r = run(GENERATOR, ["--menu", menuCopy, "--ts-out", tsOut, "--md-out", mdOut], "generate-shortcuts --menu <copy>");
  assert(r.status === 0, "regenerating from the changed menu succeeds");
  assert(!readFileSync(mdOut, "utf8").includes("| New Tab |"), "the regenerated table has no New Tab row");
  assert(!readFileSync(tsOut, "utf8").includes('"file.new-session-tab"'), "the regenerated panel data has no New Tab entry");

  log("case 3: remove Focus Composer from a copy of app-shortcuts.json");
  const app = JSON.parse(readFileSync(APP_JSON, "utf8"));
  const before = app.shortcuts.length;
  app.shortcuts = app.shortcuts.filter((s) => s.id !== "app.focus-composer");
  assert(app.shortcuts.length === before - 1, "the copy drops app.focus-composer");
  const appCopy = join(work, "app-shortcuts.json");
  writeFileSync(appCopy, JSON.stringify(app, null, 2));
  r = run(GENERATOR, ["--check", "--app", appCopy], "generate-shortcuts --check --app <copy>");
  assert(r.status === 1 && r.out.includes("STALE"), "the CI check fails");
  r = run(GENERATOR, ["--app", appCopy, "--ts-out", tsOut, "--md-out", mdOut], "generate-shortcuts --app <copy>");
  assert(r.status === 0 && !readFileSync(mdOut, "utf8").includes("Focus Composer"), "the regenerated table has no Focus Composer row");

  log("case 4: the repository's README passes the claims gate");
  r = run(CLAIMS, [], "check-readme-claims");
  assert(r.status === 0 && r.out.includes("CLAIMS GATE: PASS"), "the CI check passes on README.md as committed");
  const proven = /(\d+) proven by a scenario/.exec(r.out);
  assert(!!proven && Number(proven[1]) >= 1, `at least one README claim is proven by a tracked scenario (${proven?.[1]})`);

  log("case 5: a copy of README.md with a new, unproven feature bullet");
  const readme = readFileSync(README, "utf8");
  const withBullet = readme.replace(/^(### Terminal\r?\n)/m, "$1- **Time travel** — rewind any command you ran\n");
  assert(withBullet !== readme, "the copy adds a bullet under ## Features");
  const readmeCopy = join(work, "README.md");
  writeFileSync(readmeCopy, withBullet);
  r = run(CLAIMS, ["--readme", readmeCopy], "check-readme-claims --readme <copy>");
  assert(r.status === 1 && r.out.includes("CLAIMS GATE: FAIL"), "the CI check fails");
  assert(r.out.includes("feature bullet has no <!-- claim:<id> --> tag"), "and says the bullet has no claim");

  log("case 6: the same bullet tagged, but with no entry in readme-claims.yml");
  writeFileSync(readmeCopy, withBullet.replace("rewind any command you ran", "rewind any command you ran <!-- claim:time-travel -->"));
  r = run(CLAIMS, ["--readme", readmeCopy], "check-readme-claims --readme <copy>");
  assert(r.status === 1 && r.out.includes('tags claim "time-travel"'), "the CI check fails and names the claim");
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
