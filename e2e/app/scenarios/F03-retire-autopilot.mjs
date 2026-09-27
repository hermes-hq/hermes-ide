#!/usr/bin/env node
// Scenario F03: Hermes never types into a terminal on its own, and draws no
// suggestions over an agent CLI.
//
// A user updates from 1.4.0 with the old "Auto" mode switched on. Their data
// folder holds the database the real 1.4.0 release wrote
// (src-tauri/tests/fixtures/db/v1.4.0.sql), with the Auto settings and a
// learned command pattern that 1.4.0 would have typed into the terminal.
//
//   1. The app starts normally. The status bar has no Manual / Assisted /
//      Auto switch and Settings has no Autonomous tab.
//   2. In a plain terminal the user runs the two commands that 1.4.0 would
//      have followed with the learned one: nothing is typed for them and no
//      auto-run countdown appears.
//   3. At the shell prompt, typing shows Hermes's suggestions (the setting is
//      on by default) — the scenario's own proof that it can see them.
//   4. With a stand-in agent CLI in the foreground (a program the shell
//      started that reads the keyboard), typing the same text shows no
//      suggestion list and no ghost text.
//   5. After the agent exits, suggestions are back at the prompt.
//   6. After quitting, the database is at the new schema version and lost
//      only execution_nodes; a backup of the 1.4.0 data holds that table.
//
// Checks 1, 4 and 6 fail against a build of the code before F03 (the switch,
// the tab, suggestions over the agent on macOS, the table). Check 2 guards
// against the auto-run coming back; the old pipeline only ever fired for
// commands it recorded, which a plain shell in this rig never produced, so
// that check has no failing run to show.
//
// Negative control: HERMES_E2E_F03_NEGATIVE=1 types the text of step 4 at
// the shell prompt instead of into the agent; the run must end in
// RESULT: FAIL.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F03-retire-autopilot.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/F03-retire-autopilot.

import { readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { REPO_ROOT, createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "F03-retire-autopilot";
const startedAt = Date.now();
const DB_FILE = "hermes_idea_v3.db";
const SCHEMA_VERSION = 2;
const FIXTURE = join(REPO_ROOT, "src-tauri", "tests", "fixtures", "db", "v1.4.0.sql");
const NEGATIVE = process.env.HERMES_E2E_F03_NEGATIVE === "1";

// The commands the user runs, and what 1.4.0 learned to type after them.
const FIRST = "echo f03-first";
const SECOND = "echo f03-second";
const PREDICTED = "echo F03-PREDICTED";
// Typed at the prompt / into the agent: Hermes suggests "git status" for it.
const PROBE_TEXT = "git st";

const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

/** A check the later steps do not depend on: record a failure and go on. */
const failures = [];
function check(condition, message) {
  if (condition) {
    log(`  ok — ${message}`);
  } else {
    failures.push(message);
    log(`  CHECK FAILED: ${message}`);
  }
}

function readDb(path, fn) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function rowCounts(path) {
  return readDb(path, (db) => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r.name);
    return Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n]));
  });
}

/**
 * Folders the shell may report as its working directory at start-up (the
 * learned pattern is keyed by it): the home folder as given, resolved, with
 * a trailing separator, and none at all.
 */
function cwdVariants(home) {
  const out = new Set(["", home, `${home}/`, `${home}\\`]);
  try {
    const real = realpathSync(home);
    out.add(real);
    out.add(`${real}/`);
  } catch {
    // not created yet
  }
  return [...out];
}

/** The 1.4.0 database, as a user with "Auto" switched on left it. */
function prepare1_4Data(dataDir, home) {
  const path = join(dataDir, DB_FILE);
  const db = new DatabaseSync(path);
  db.exec(readFileSync(FIXTURE, "utf8"));
  const setting = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  setting.run("onboarding_completed", "true");
  setting.run("execution_mode", "autonomous");
  setting.run("auto_command_min_frequency", "2");
  setting.run("auto_cancel_delay_ms", "1000");
  // The fixture was captured on macOS with zsh as the default shell; this
  // user keeps the default shell of the machine the test runs on.
  db.exec("DELETE FROM settings WHERE key = 'default_shell';");
  // What 1.4.0 learned: after FIRST then SECOND, the user runs PREDICTED.
  const learned = db.prepare(
    "INSERT OR REPLACE INTO command_patterns (project_id, sequence, next_command, frequency, last_seen) VALUES (?, ?, ?, 9, 0)",
  );
  for (const cwd of cwdVariants(home)) learned.run(cwd, JSON.stringify([FIRST, SECOND]), PREDICTED);
  db.close();
  return path;
}

// ── Terminal helpers ─────────────────────────────────────────────────

/** A key the way a keyboard sends it (e.g. Ctrl-C). */
function pressKey(bridge, sessionId, { key, code, keyCode, ctrlKey = false }) {
  return bridge.eval(`
    const host = document.querySelector('div[data-session-id="' + CSS.escape(${JSON.stringify(sessionId)}) + '"]');
    const ta = host.querySelector("textarea.xterm-helper-textarea");
    const mk = (type) => {
      const ev = new KeyboardEvent(type, { key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, ctrlKey: ${ctrlKey}, bubbles: true, cancelable: true, composed: true, view: window });
      Object.defineProperty(ev, "keyCode", { get: () => ${keyCode} });
      Object.defineProperty(ev, "which", { get: () => ${keyCode} });
      return ev;
    };
    ta.dispatchEvent(mk("keydown"));
    ta.dispatchEvent(mk("keyup"));
    return true;
  `);
}

const ctrlC = (bridge, sessionId) => pressKey(bridge, sessionId, { key: "c", code: "KeyC", keyCode: 67, ctrlKey: true });

/** What Hermes draws over the terminal right now. */
function drawn(bridge) {
  return bridge.eval(`
    const overlay = e2e.first(".suggestion-overlay");
    const ghost = [...document.querySelectorAll(".ghost-text-overlay")].filter((g) => g.isConnected);
    return {
      overlay: overlay ? e2e.all(".suggestion-command", overlay).map((e) => e.innerText) : null,
      ghost: ghost.map((g) => g.textContent),
    };
  `);
}
const isDrawn = (d) => d.overlay !== null || d.ghost.length > 0;

async function expectSuggestions(bridge, sessionId, why) {
  await bridge.typeInTerminal(sessionId, PROBE_TEXT);
  const d = await bridge.waitFor(`Hermes suggestions for "${PROBE_TEXT}" (${why})`, `
    const overlay = e2e.first(".suggestion-overlay");
    const ghost = [...document.querySelectorAll(".ghost-text-overlay")].filter((g) => g.isConnected);
    if (!overlay && ghost.length === 0) return null;
    return {
      overlay: overlay ? e2e.all(".suggestion-command", overlay).map((e) => e.innerText) : null,
      ghost: ghost.map((g) => g.textContent),
    };
  `, { timeoutMs: 10_000 });
  log(`  drawn: ${JSON.stringify(d)}`);
  return d;
}

/** Watch for `ms`: returns every distinct thing Hermes drew meanwhile. */
async function watchDrawn(bridge, ms) {
  const seen = [];
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const d = await drawn(bridge);
    if (isDrawn(d)) seen.push(d);
    await sleep(100);
  }
  return seen;
}

/** A stand-in agent CLI: prints a prompt and reads the keyboard until Ctrl-C. */
function writeStandInAgent(dir) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "stand-in-agent.mjs");
  writeFileSync(
    file,
    [
      'process.stdout.write("stand-in-agent: ready\\n> ");',
      "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
      "process.stdin.on('data', (b) => {",
      "  const s = b.toString('utf8');",
      "  if (s.includes('\\u0003')) { process.stdout.write('\\nstand-in-agent: bye\\n'); process.exit(130); }",
      "  process.stdout.write(s.replace(/\\r/g, '\\r\\n> '));",
      "});",
      "",
    ].join("\n"),
  );
  return file;
}

async function createPlainTerminal(bridge) {
  await bridge.click("button.es-tile-primary");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, {
    timeoutMs: 20_000,
  });
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`);
  // "Plain shell" is always the last card.
  await bridge.clickWhenReady(`
    const cards = e2e.all(".session-creator-provider-card");
    return e2e.click(e2e.must(cards[cards.length - 1], "plain shell card"));
  `);
  const before = await bridge.terminalIds();
  for (let i = 0; i < 6; i++) {
    if (!(await bridge.exists(".session-creator"))) break;
    await bridge.clickWhenReady(`
      if (!e2e.first(".session-creator")) return null;
      return e2e.click(e2e.must(
        e2e.first(".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary"),
        "the wizard's primary button",
      ));
    `);
    await sleep(400);
  }
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  return bridge.waitFor(
    "a terminal to appear",
    `const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
     return ids.length === 1 ? ids[0] : null;`,
    { timeoutMs: 20_000 },
  );
}

async function runAndWait(bridge, sessionId, command, output) {
  await bridge.typeInTerminal(sessionId, `${command}\n`);
  await bridge.waitForTerminal(sessionId, new RegExp(`^${output}\\s*$`), { timeoutMs: 20_000 });
}

// ── The run ──────────────────────────────────────────────────────────

let app;
let failed = false;
let dbPath;
let before;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}${NEGATIVE ? "   NEGATIVE CONTROL (must fail)" : ""}`);

  log("step 1: start the new build on the data a 1.4.0 user with Auto switched on left behind");
  app = await launchApp({
    runDir: join(evidenceDir, "run"),
    log,
    prepareDataDir: (dataDir) => {
      // The shell starts in the home folder the app was given: the private
      // one around the data folder, or the real one on Windows.
      const home = platform() === "win32" ? homedir() : dataDir.split(/[\\/](Library|\.local)[\\/]/)[0];
      dbPath = prepare1_4Data(dataDir, home);
      before = rowCounts(dbPath);
      log(`  1.4.0 rows: ${JSON.stringify(before)}`);
    },
  });
  const { bridge } = app;
  await bridge.waitFor("the workspace", `return !!document.querySelector(".app-body");`, { timeoutMs: 20_000 });
  assert(!(await bridge.exists(".startup-problem")), "the app started normally");
  await sleep(300);
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
    log("  dismissed the what's-new dialog");
  }

  log("step 2: open a plain terminal; the status bar has no execution-mode switch");
  const sessionId = await createPlainTerminal(bridge);
  log(`  session: ${sessionId}`);
  await bridge.waitFor("the shell to print its prompt", `
    const lines = window.__HERMES_E2E__.readTerminal(${JSON.stringify(sessionId)}) || [];
    const info = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(sessionId)});
    return info && info.opened && lines.some((l) => l.trim().length > 0);
  `, { timeoutMs: 30_000 });
  await sleep(1000); // let the shell finish starting up
  const bar = await bridge.eval(`
    const bar = e2e.first(".status-bar");
    return bar && {
      text: e2e.norm(bar.innerText),
      radiogroups: bar.querySelectorAll('[role="radiogroup"]').length,
      modeButtons: [...bar.querySelectorAll("button")].map((b) => e2e.norm(b.innerText)).filter((n) => /^(Manual|Assisted|Auto)$/.test(n)),
    };
  `);
  log(`  status bar: "${bar?.text}"`);
  assert(!!bar && bar.text.length > 0, "the status bar is on screen");
  check(bar.radiogroups === 0 && bar.modeButtons.length === 0, `no Manual / Assisted / Auto switch (radio groups: ${bar.radiogroups}, buttons: ${JSON.stringify(bar.modeButtons)})`);
  await bridge.screenshot(join(evidenceDir, "01-status-bar.png"));

  log("step 3: Settings has no Autonomous tab");
  await bridge.clickWhenReady(`
    const b = e2e.all(".activity-bar-action").find((el) => el.textContent.includes("Settings"));
    return e2e.click(e2e.must(b, "the Settings button"));
  `);
  const tabs = await bridge.waitFor("the settings tabs", `
    const t = e2e.all(".settings-tabs .settings-tab").map(e2e.nameOf);
    return t.length ? t : null;
  `);
  log(`  settings tabs: ${tabs.join(", ")}`);
  assert(tabs.includes("General"), "the settings tabs are on screen");
  check(!tabs.some((t) => /autonom/i.test(t)), "no Autonomous tab");
  await bridge.screenshot(join(evidenceDir, "02-settings-tabs.png"));
  await bridge.click(".settings-close");
  await bridge.waitFor("settings to close", `return !e2e.first(".settings-tabs");`);

  log("step 4: run the commands 1.4.0 learned to follow up; nothing is typed for the user");
  const toasts = [];
  for (let round = 1; round <= 2; round++) {
    await runAndWait(bridge, sessionId, FIRST, "f03-first");
    await runAndWait(bridge, sessionId, SECOND, "f03-second");
    // 1.4.0 counted down for auto_cancel_delay_ms (1 s) and then typed.
    const until = Date.now() + 4_000;
    while (Date.now() < until) {
      if (await bridge.exists(".auto-toast")) toasts.push(await bridge.text(".auto-toast"));
      await sleep(100);
    }
  }
  const afterRuns = (await bridge.readTerminal(sessionId)) ?? [];
  log("  terminal:");
  for (const l of afterRuns.slice(-6)) log(`    | ${l}`);
  check(toasts.length === 0, `no auto-run countdown appeared (${JSON.stringify(toasts.slice(0, 1))})`);
  check(!afterRuns.some((l) => l.includes("F03-PREDICTED")), "the learned command was never typed");
  // Whatever 1.4.0 left on the prompt must not be run by the next steps.
  await ctrlC(bridge, sessionId);
  await sleep(500);
  await bridge.screenshot(join(evidenceDir, "03-no-autopilot.png"));

  log("step 5: at the shell prompt, typing shows Hermes suggestions (the scenario can see them)");
  const atPrompt = await expectSuggestions(bridge, sessionId, "at the shell prompt");
  assert(isDrawn(atPrompt), "a suggestion list or ghost text is drawn at the prompt");
  await bridge.screenshot(join(evidenceDir, "04-suggestions-at-prompt.png"));
  await ctrlC(bridge, sessionId);
  await bridge.waitFor("suggestions to go away", `
    return !e2e.first(".suggestion-overlay") && document.querySelectorAll(".ghost-text-overlay").length === 0;
  `);
  await sleep(500);

  log("step 6: with an agent CLI in the foreground, typing draws nothing");
  const agent = writeStandInAgent(join(evidenceDir, "run"));
  for (const p of [process.execPath, agent]) {
    if (/[\s'"]/.test(p)) throw new Error(`path needs quoting, which this scenario does not do: ${p}`);
  }
  if (NEGATIVE) {
    log("  NEGATIVE CONTROL: not starting the agent; typing at the shell prompt instead");
  } else {
    await bridge.typeInTerminal(sessionId, `${process.execPath} ${agent}\n`);
    await bridge.waitForTerminal(sessionId, /stand-in-agent: ready/, { timeoutMs: 20_000 });
    await sleep(1000); // the agent owns the terminal; give the poll time to see it
  }
  await bridge.typeInTerminal(sessionId, PROBE_TEXT);
  const overAgent = await watchDrawn(bridge, 2_500);
  const agentLines = (await bridge.readTerminal(sessionId)) ?? [];
  log("  terminal:");
  for (const l of agentLines.slice(-4)) log(`    | ${l}`);
  await bridge.screenshot(join(evidenceDir, "05-agent-in-foreground.png"));
  if (!NEGATIVE) assert(agentLines.some((l) => l.includes(`> ${PROBE_TEXT}`)), `the agent received "${PROBE_TEXT}"`);
  check(overAgent.length === 0, `no suggestion list or ghost text over the agent (${JSON.stringify(overAgent[0] ?? null)})`);

  log("step 7: the agent exits; suggestions are back at the prompt");
  await ctrlC(bridge, sessionId);
  if (!NEGATIVE) await bridge.waitForTerminal(sessionId, /stand-in-agent: bye/, { timeoutMs: 10_000 });
  await sleep(1500); // the shell prints its prompt again
  const back = await expectSuggestions(bridge, sessionId, "after the agent exited");
  assert(isDrawn(back), "suggestions are drawn at the prompt again");
  await ctrlC(bridge, sessionId);
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  if (app) {
    log("step 8: quit");
    const exit = await app.stop({ keepFiles: true });
    log(`  app exited: ${JSON.stringify(exit)}`);
    if (!failed && (exit.forced || exit.code !== 0)) {
      failed = true;
      log("FAILED: the app did not quit cleanly");
    }
  }
}

if (dbPath && existsSync(dbPath)) {
  // Where this build recorded the user's commands, if anywhere (1.4.0 keyed
  // its learned patterns by that folder).
  const recorded = readDb(dbPath, (db) =>
    db.prepare("SELECT project_id, sequence, next_command FROM command_patterns WHERE next_command LIKE 'echo f03-%'").all(),
  );
  log(`  command patterns recorded during the run: ${JSON.stringify(recorded)}`);
}

if (!failed && dbPath) {
  try {
    log("step 9: the 1.4.0 database lost only execution_nodes; the backup has it");
    const version = readDb(dbPath, (db) => db.prepare("PRAGMA user_version").get().user_version);
    assert(version === SCHEMA_VERSION, `database at schema version ${version}`);
    const after = rowCounts(dbPath);
    assert(before.execution_nodes > 0, `1.4.0 had ${before.execution_nodes} execution_nodes rows`);
    assert(!("execution_nodes" in after), "execution_nodes is gone");
    for (const [table, n] of Object.entries(before)) {
      if (table === "execution_nodes") continue;
      assert(after[table] >= n, `${table}: ${n} rows before, ${after[table]} after`);
    }
    assert(Object.keys(after).length === Object.keys(before).length - 1, "no other table was added or removed");
    const backupDir = join(dirname(dbPath), "backups");
    const backups = existsSync(backupDir) ? readdirSync(backupDir) : [];
    assert(backups.length === 1 && /-from-v0\.db$/.test(backups[0]), `one backup of the 1.4.0 data: ${backups.join(", ")}`);
    const backupCounts = rowCounts(join(backupDir, backups[0]));
    assert(backupCounts.execution_nodes === before.execution_nodes, "the backup still holds execution_nodes");
  } catch (e) {
    failed = true;
    log(`FAILED: ${e?.stack ?? e}`);
  }
}
app?.cleanup();
if (failures.length) {
  failed = true;
  log(`FAILED: ${failures.length} check(s): ${failures.join("; ")}`);
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
