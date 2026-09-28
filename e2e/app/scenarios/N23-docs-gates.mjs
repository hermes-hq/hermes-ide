#!/usr/bin/env node
// Scenario: the two "docs stay true" gates really gate.
//
//   1. The shortcut tables are generated: removing a shortcut from the menu
//      (or from src/shortcuts/app-shortcuts.json) changes the generated table,
//      and `generate-shortcuts.mjs --check` (the CI job) fails until the docs
//      are regenerated. When the menu reads its chords from a keymap.json
//      table instead of string literals, every row is kept, with the
//      per-platform chords.
//   2. A README feature bullet with no scenario fails the claims gate (the CI
//      job), while the repository's own README passes it. A new claim cannot
//      join the unproven backlog, and a backlog claim whose planned scenario
//      has landed fails until it names that scenario.
//
// Runs the real gate scripts as child processes, against copies of the
// repository's own menu, app-shortcuts.json, README.md and claims map in a
// temp folder.
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
const CLAIMS_YML = join(REPO_ROOT, "docs", "readme-claims.yml");
const KEYMAP = join(REPO_ROOT, "src", "utils", "keymap.json");

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
  assert(/^\| New Tab \| ⌘T \| /m.test(readFileSync(DOCS_MD, "utf8")), "docs/shortcuts.md lists New Tab (⌘T in the menu)");

  log("case 2: remove New Tab's accelerator from a copy of the menu (and its chord from a copy of keymap.json)");
  const menu = readFileSync(MENU, "utf8");
  const trimmedMenu = menu.replace(/(with_id\("file\.new-session-tab", "New Tab"\)\s*)\.accelerator\([^\r\n]*\)\r?\n/, "$1");
  assert(trimmedMenu !== menu, "the copy no longer binds a key to New Tab");
  const menuCopy = join(work, "mod.rs");
  writeFileSync(menuCopy, trimmedMenu);
  // The menu reads its chords from keymap.json; a chord no menu item uses is
  // an error, so the chord goes too, as it would in a real removal.
  const realKeymap = JSON.parse(readFileSync(KEYMAP, "utf8"));
  const trimmedKeymap = { ...realKeymap, chords: realKeymap.chords.filter((c) => c.action !== "file.new-session-tab") };
  assert(trimmedKeymap.chords.length === realKeymap.chords.length - 1, "the keymap copy drops New Tab's chord");
  const trimmedKeymapCopy = join(work, "keymap-no-new-tab.json");
  writeFileSync(trimmedKeymapCopy, JSON.stringify(trimmedKeymap, null, 2));
  r = run(GENERATOR, ["--check", "--menu", menuCopy, "--keymap", trimmedKeymapCopy], "generate-shortcuts --check --menu <copy> --keymap <copy>");
  assert(r.status === 1 && r.out.includes("STALE"), "the CI check fails: the committed docs no longer match the menu");
  const tsOut = join(work, "shortcuts.ts");
  const mdOut = join(work, "shortcuts.md");
  r = run(GENERATOR, ["--menu", menuCopy, "--keymap", trimmedKeymapCopy, "--ts-out", tsOut, "--md-out", mdOut], "generate-shortcuts --menu <copy> --keymap <copy>");
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

  // The menu reads every CmdOrCtrl chord through app_accel("<id>")? from
  // src/utils/keymap.json. The Windows/Linux chords get their own keys:
  // Ctrl+Shift+<key>, with the old Ctrl+<key> kept for outside a terminal.
  const keymap = JSON.parse(readFileSync(KEYMAP, "utf8"));
  const accelIds = [...menu.matchAll(/\.accelerator\(app_accel\("([^"]+)"\)\?\)/g)].map((m) => m[1]);
  assert(accelIds.length >= 10, `the menu reads ${accelIds.length} chords through app_accel`);
  assert(accelIds.every((id) => keymap.chords.some((c) => c.action === id)), "every app_accel id has a chord in keymap.json");
  assert(
    /^\| New Tab \| ⌘T \| Ctrl\+Shift\+T \| Windows \/ Linux: also Ctrl\+T when no terminal has focus \|$/m.test(readFileSync(DOCS_MD, "utf8")),
    "New Tab shows its Windows/Linux chord from the keymap",
  );
  keymap.chords.pop();
  const keymapCopy = join(work, "keymap.json");
  writeFileSync(keymapCopy, JSON.stringify(keymap, null, 2));
  r = run(GENERATOR, ["--keymap", keymapCopy, "--ts-out", tsOut, "--md-out", mdOut], "generate-shortcuts with a chord missing from keymap.json");
  assert(r.status !== 0 && r.out.includes("keymap.json has no such chord"), "a chord missing from the keymap fails instead of dropping the row");

  log("case 4: the repository's README passes the claims gate");
  r = run(CLAIMS, [], "check-readme-claims");
  assert(r.status === 0 && r.out.includes("CLAIMS GATE: PASS"), "the CI check passes on README.md as committed");
  const proven = /(\d+) proven by a scenario/.exec(r.out);
  assert(!!proven && Number(proven[1]) >= 1, `at least one README claim is proven by a tracked scenario (${proven?.[1]})`);

  log("case 5: a copy of README.md with a new, unproven feature bullet");
  const readme = readFileSync(README, "utf8");
  const withBullet = readme.replace(/^(### Terminal[^\r\n]*\r?\n)/m, "$1- **Time travel** — rewind any command you ran\n");
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

  log("case 7: the same claim added to the map as unproven, checked against the committed map as the baseline (as CI does)");
  const claimsYml = readFileSync(CLAIMS_YML, "utf8");
  const claimsCopy = join(work, "readme-claims.yml");
  writeFileSync(claimsCopy, `${claimsYml.trimEnd()}\n  time-travel:\n    text: "Time travel"\n    unproven: "Not proven yet"\n    planned: time-travel.mjs\n`);
  r = run(CLAIMS, ["--readme", readmeCopy, "--claims", claimsCopy], "check-readme-claims --readme <copy> --claims <copy>");
  assert(r.status === 0, "without a baseline the entry is well-formed");
  r = run(CLAIMS, ["--readme", readmeCopy, "--claims", claimsCopy, "--baseline", CLAIMS_YML], "check-readme-claims --readme <copy> --claims <copy> --baseline <committed map>");
  assert(r.status === 1 && r.out.includes('claim "time-travel" is new and has no scenario'), "a new README claim with no scenario fails CI");
  r = run(CLAIMS, ["--baseline", CLAIMS_YML], "check-readme-claims --baseline <committed map>");
  assert(r.status === 0 && r.out.includes("CLAIMS GATE: PASS"), "the committed README passes against its own baseline");

  log("case 8: a backlog claim whose planned scenario has landed");
  const landed = claimsYml.replace(/(split-panes:[\s\S]*?planned: )\S+/, "$1N23-docs-gates.mjs");
  assert(landed !== claimsYml, "the copy plans split-panes on a scenario the ledger tracks");
  writeFileSync(claimsCopy, landed);
  r = run(CLAIMS, ["--claims", claimsCopy], "check-readme-claims --claims <copy>");
  assert(r.status === 1 && r.out.includes('claim "split-panes" is still unproven, but its planned scenario N23-docs-gates.mjs has landed'), "the CI check fails until the claim names the scenario");

  log("case 9: strict mode lists the whole backlog as failures");
  r = run(CLAIMS, ["--strict"], "check-readme-claims --strict");
  const unprovenCount = Number(/(\d+) listed as unproven/.exec(r.out)?.[1] ?? -1);
  assert(r.status === 1 && unprovenCount > 0 && r.out.includes(`CLAIMS GATE: FAIL (${unprovenCount} problem`), `strict mode fails once per unproven claim (${unprovenCount})`);
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
