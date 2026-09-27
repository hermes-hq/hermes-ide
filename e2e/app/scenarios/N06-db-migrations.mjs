#!/usr/bin/env node
// Scenario N06: upgrades never lose data.
//
// Part A — a user updates from 1.4.0. Their data folder holds the database the
// real 1.4.0 release wrote (src-tauri/tests/fixtures/db/v1.4.0.sql). The new
// build starts normally, still shows their settings, saved SSH hosts and
// plugin choices, saves one backup of the old data first, and every row is
// still there after it quits.
//
// Part B — a user goes back to an older Hermes after a newer one updated the
// data. The app explains that the data is from a newer version, offers Quit,
// and leaves the database byte for byte as it was.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N06-db-migrations.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/N06-db-migrations.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { REPO_ROOT, createLogger, launchApp, outDir, sleep } from "../harness.mjs";

const DB_FILE = "hermes_idea_v3.db";
const FIXTURE = join(REPO_ROOT, "src-tauri", "tests", "fixtures", "db", "v1.4.0.sql");
const NEWER_VERSION = 99;

const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", "N06-db-migrations");
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

function loadFixture(dataDir, userVersion = 0) {
  const path = join(dataDir, DB_FILE);
  const db = new DatabaseSync(path);
  db.exec(readFileSync(FIXTURE, "utf8"));
  if (userVersion) db.exec(`PRAGMA user_version = ${userVersion};`);
  db.close();
  return path;
}

function readDb(path, fn) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const userVersion = (path) => readDb(path, (db) => db.prepare("PRAGMA user_version").get().user_version);

function rowCounts(path) {
  return readDb(path, (db) => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => r.name);
    return Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n]));
  });
}

function filesIn(dir) {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/** Apps started by this run; their private folders are removed at the end. */
const launched = [];

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Call a real backend command from inside the app's webview. */
function invoke(bridge, command, args = {}) {
  return bridge.eval(
    `return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)});`,
  );
}

async function partA() {
  log("PART A: update from 1.4.0 keeps sessions, settings, saved hosts and plugins");
  let dbPath;
  let before;
  const app = await launchApp({
    runDir: join(evidenceDir, "run-upgrade"),
    log,
    prepareDataDir: (dataDir) => {
      dbPath = loadFixture(dataDir);
      // Someone updating has been through the first-launch welcome already.
      const db = new DatabaseSync(dbPath);
      db.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('onboarding_completed', 'true');");
      db.close();
      before = rowCounts(dbPath);
      log(`  put the database written by the real 1.4.0 release in ${dataDir}`);
      log(`  rows before: ${JSON.stringify(before)}`);
    },
  });
  launched.push(app);
  let exit;
  try {
    const { bridge } = app;
    log("step A1: the app starts normally (no problem screen)");
    await bridge.waitFor("the workspace", `return !!document.querySelector(".app-body");`, { timeoutMs: 20_000 });
    log("  the workspace UI rendered");
    assert(!(await bridge.exists(".startup-problem")), "no startup problem screen");

    log("step A2: the running app still has the user's data");
    const settings = await invoke(bridge, "get_settings");
    assert(settings.fx_marker === "fixture-settings-row", `a setting written under 1.4.0 is still there (fx_marker=${settings.fx_marker})`);
    assert(settings.font_size === "15", `font size setting kept (${settings.font_size})`);
    const hosts = await invoke(bridge, "list_ssh_saved_hosts");
    const hostSummary = hosts.map((h) => `${h.label} ${h.user}@${h.host}:${h.port}`).sort();
    assert(
      JSON.stringify(hostSummary) === JSON.stringify(["Build box test@build.example.test:22", "Staging deploy@staging.example.test:2222"]),
      `both saved SSH hosts are listed: ${hostSummary.join(", ")}`,
    );
    const disabled = await invoke(bridge, "get_disabled_plugin_ids");
    assert(disabled.includes("fx.plugin.timer"), `the plugin the user disabled is still disabled (${JSON.stringify(disabled)})`);
    const recent = await invoke(bridge, "get_recent_sessions", { limit: 20 }).catch((e) => ({ error: String(e) }));
    if (Array.isArray(recent)) {
      const ids = recent.map((s) => s.id);
      assert(ids.includes("fx-session-1") && ids.includes("fx-session-3"), `closed sessions from 1.4.0 are in recent sessions (${ids.join(", ")})`);
    } else {
      log(`  (recent sessions not checked: ${recent.error})`);
    }
    const logbook = await bridge.waitFor(
      "the recent sessions list",
      `const items = e2e.all(".es-logbook .es-recent-item").map(e2e.nameOf);
       return items.length ? items : null;`,
      { timeoutMs: 15_000 },
    );
    log(`  recent sessions on screen: ${logbook.map((t) => JSON.stringify(t.slice(0, 40))).join(", ")}`);
    assert(
      logbook.some((t) => t.includes("API server")) && logbook.some((t) => t.includes("Build box")),
      "the sessions from 1.4.0 are listed on the start screen",
    );
    await sleep(2000); // let the start screen finish fading in before the picture
    await bridge.eval(`e2e.first(".es-logbook").scrollIntoView({ block: "center" }); return true;`);
    await sleep(300);
    const shot = await bridge.screenshot(join(evidenceDir, "A1-app-after-upgrade.png"));
    log(`  screenshot saved: ${shot.file} (${shot.bytes} bytes)`);

    log("step A3: one backup of the 1.4.0 data was saved before the update");
    const backupDir = join(app.dataDir, "backups");
    const backups = filesIn(backupDir);
    assert(backups.length === 1 && /-from-v0\.db$/.test(backups[0]), `exactly one backup: ${backups.join(", ")}`);
    const backupCounts = rowCounts(join(backupDir, backups[0]));
    assert(JSON.stringify(backupCounts) === JSON.stringify(before), "the backup holds exactly the rows 1.4.0 left");
    assert(userVersion(join(backupDir, backups[0])) === 0, "the backup is the untouched 1.4.0 schema (version 0)");
  } finally {
    log("step A4: quit");
    exit = await app.stop({ keepFiles: true });
    log(`  app exited: ${JSON.stringify(exit)}`);
  }
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");

  log("step A5: after quitting, every row is still in the database");
  assert(userVersion(dbPath) === 1, `database now at schema version ${userVersion(dbPath)}`);
  const after = rowCounts(dbPath);
  for (const [table, n] of Object.entries(before)) {
    assert(after[table] >= n, `${table}: ${n} rows before, ${after[table]} after`);
  }
  const kept = readDb(dbPath, (db) => ({
    sessions: db.prepare("SELECT id FROM sessions WHERE id LIKE 'fx-%' ORDER BY id").all().map((r) => r.id),
    hosts: db.prepare("SELECT COUNT(*) AS n FROM ssh_saved_hosts WHERE id LIKE 'fx-%'").get().n,
    plugins: db.prepare("SELECT COUNT(*) AS n FROM plugins WHERE id LIKE 'fx.%'").get().n,
    storage: db.prepare("SELECT COUNT(*) AS n FROM plugin_storage").get().n,
  }));
  assert(kept.sessions.join(",") === "fx-session-1,fx-session-2,fx-session-3", `the three 1.4.0 sessions are kept (${kept.sessions.join(", ")})`);
  assert(kept.hosts === 2 && kept.plugins === 2 && kept.storage === 2, `saved hosts, plugins and plugin data kept (${JSON.stringify(kept)})`);
  assert(filesIn(join(app.dataDir, "backups")).length === 1, "still exactly one backup");
}

async function partB() {
  log(`PART B: data saved by a newer Hermes (schema version ${NEWER_VERSION}) is refused and left untouched`);
  let dbPath;
  let hashBefore;
  let filesBefore;
  let dataDir;
  const app = await launchApp({
    runDir: join(evidenceDir, "run-newer"),
    log,
    prepareDataDir: (dir) => {
      dataDir = dir;
      dbPath = loadFixture(dir, NEWER_VERSION);
      hashBefore = sha256(dbPath);
      filesBefore = filesIn(dir);
      log(`  put a database marked as schema version ${NEWER_VERSION} in ${dir} (sha256 ${hashBefore.slice(0, 16)}…)`);
    },
  });
  launched.push(app);
  let exit;
  let quitByButton = false;
  try {
    const { bridge } = app;
    log("step B1: the window explains the problem");
    const shown = await bridge.waitFor(
      "the startup problem screen",
      `const el = e2e.first(".startup-problem");
       return el ? {
         title: e2e.norm(e2e.first(".startup-problem-title")?.innerText),
         message: e2e.norm(e2e.first(".startup-problem-message")?.innerText),
         path: e2e.norm(e2e.first(".startup-problem-path code")?.innerText),
         buttons: e2e.all("button").map(e2e.nameOf),
         workspace: !!document.querySelector(".app-body"),
       } : null;`,
      { timeoutMs: 20_000 },
    );
    log(`  title: "${shown.title}"`);
    log(`  message: "${shown.message}"`);
    assert(shown.title === "Your data is from a newer version of Hermes", "title says the data is from a newer version");
    assert(shown.message.includes(`data version ${NEWER_VERSION}`) && shown.message.includes("up to 1"), "message names both versions");
    assert(shown.message.includes("has not opened or changed it"), "message says nothing was changed");
    assert(shown.path.endsWith(DB_FILE), `the data file is named (${shown.path.split(/[\\/]/).pop()})`);
    assert(JSON.stringify(shown.buttons) === JSON.stringify(["Quit Hermes"]), "the only action is Quit Hermes");
    assert(shown.workspace === false, "the workspace did not start");
    const shot = await bridge.screenshot(join(evidenceDir, "B1-newer-data-refused.png"));
    log(`  screenshot saved: ${shot.file} (${shot.bytes} bytes)`);

    log("step B2: press Quit Hermes");
    try {
      await bridge.clickByName("Quit Hermes");
    } catch (e) {
      // The app may be gone before the bridge answers the click.
      const until = Date.now() + 3_000;
      while (app.isRunning() && Date.now() < until) await sleep(50);
      if (app.isRunning()) throw e;
    }
    const until = Date.now() + 10_000;
    while (app.isRunning() && Date.now() < until) await sleep(100);
    quitByButton = !app.isRunning();
  } finally {
    exit = await app.stop({ keepFiles: true });
    log(`  app exited: ${JSON.stringify(exit)}`);
  }
  assert(quitByButton, "the Quit button closed the app");
  assert(exit.code === 0 && !exit.forced, "exit code 0");

  log("step B3: the database is exactly as it was");
  assert(sha256(dbPath) === hashBefore, "database file is byte-for-byte unchanged");
  assert(userVersion(dbPath) === NEWER_VERSION, `still schema version ${NEWER_VERSION}`);
  const filesAfter = filesIn(dataDir).filter((f) => f !== "context");
  assert(
    JSON.stringify(filesAfter) === JSON.stringify(filesBefore),
    `no backup, WAL or other database files were created (${filesAfter.join(", ")})`,
  );
}

let failed = false;
try {
  log(`scenario: N06-db-migrations   platform: ${platform()}`);
  await partA();
  await partB();
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
}
for (const app of launched) app.cleanup();
log(failed ? "RESULT: FAIL" : "RESULT: PASS");
process.exit(failed ? 1 : 0);
