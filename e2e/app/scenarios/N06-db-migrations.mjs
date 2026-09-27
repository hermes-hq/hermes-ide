#!/usr/bin/env node
// Scenario N06: upgrades never lose data.
//
// Part 0 — the database each captured release wrote (0.6.16, 1.1.3, 1.2.5,
// 1.3.2, 1.4.0; src-tauri/tests/fixtures/db) opens in the new build, and after
// it quits every row is still there. The one exception is execution_nodes, a
// command log nothing read, which schema step 2 drops on purpose (F03; the
// backup keeps it).
//
// Part A — a user updates from 1.4.0. Their data folder holds the database the
// real 1.4.0 release wrote (src-tauri/tests/fixtures/db/v1.4.0.sql). The new
// build starts normally, still shows their settings, saved SSH hosts and
// plugin choices, saves one backup of the old data first, and every row is
// still there after it quits.
//
// Part B — a user goes back to an older Hermes after a newer one updated the
// data. The app explains that the data is from a newer version, in the
// language the user picked, offers Quit, and leaves the database (in WAL mode,
// like every real 1.4.0 database) byte for byte as it was.
//
// Part C — the newer Hermes stopped mid-write (a crash or power loss), so some
// of its data is still only in the -wal file next to the database. The older
// build refuses it the same way and leaves both the database and the -wal
// byte for byte as they were, so the newer version still finds that data.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N06-db-migrations.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/N06-db-migrations.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { REPO_ROOT, createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "N06-db-migrations";
const startedAt = Date.now();
const DB_FILE = "hermes_idea_v3.db";
const FIXTURES_DIR = join(REPO_ROOT, "src-tauri", "tests", "fixtures", "db");
const CAPTURED_RELEASES = ["0.6.16", "1.1.3", "1.2.5", "1.3.2", "1.4.0"];
const PREVIOUS_RELEASE = "1.4.0";
const NEWER_VERSION = 99;
/** The schema version this build writes. */
const SCHEMA_VERSION = 2;
/** Dropped on purpose by schema step 2 (F03); kept in the backup. */
const DROPPED = new Set(["execution_nodes"]);

const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

function loadFixture(dataDir, userVersion = 0, { wal = false, release = PREVIOUS_RELEASE } = {}) {
  const path = join(dataDir, DB_FILE);
  const db = new DatabaseSync(path);
  db.exec(readFileSync(join(FIXTURES_DIR, `v${release}.sql`), "utf8"));
  if (userVersion) db.exec(`PRAGMA user_version = ${userVersion};`);
  // WAL mode is stored in the file; closing the last connection removes the
  // -wal/-shm files, as when a real 1.4.0 quits.
  if (wal) db.exec("PRAGMA journal_mode = WAL;");
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

/** The data folder's database files: the database, its -wal/-shm/-journal and backups. */
const dbFilesIn = (dir) => filesIn(dir).filter((f) => f.startsWith(DB_FILE) || f === "backups");

async function part0() {
  log("PART 0: the database every captured release wrote opens, and keeps every row");
  for (const release of CAPTURED_RELEASES) {
    log(`release ${release}`);
    let dbPath;
    let before;
    const app = await launchApp({
      runDir: join(evidenceDir, `run-v${release}`),
      log,
      prepareDataDir: (dataDir) => {
        dbPath = loadFixture(dataDir, 0, { release });
        const db = new DatabaseSync(dbPath);
        db.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('onboarding_completed', 'true');");
        db.close();
        before = rowCounts(dbPath);
      },
    });
    launched.push(app);
    let exit;
    try {
      await app.bridge.waitFor("the workspace", `return !!document.querySelector(".app-body");`, { timeoutMs: 20_000 });
      assert(!(await app.bridge.exists(".startup-problem")), `${release}: the app started normally`);
      const settings = await invoke(app.bridge, "get_settings");
      assert(settings.fx_marker === "fixture-settings-row", `${release}: the running app reads the old settings`);
    } finally {
      exit = await app.stop({ keepFiles: true });
    }
    assert(!exit.forced && exit.code === 0, `${release}: the app quit cleanly`);
    assert(userVersion(dbPath) === SCHEMA_VERSION, `${release}: database now at schema version ${SCHEMA_VERSION}`);
    const after = rowCounts(dbPath);
    const lost = Object.entries(before).filter(([table, n]) => !DROPPED.has(table) && !(after[table] >= n));
    assert(lost.length === 0, `${release}: all ${Object.keys(before).length} tables kept their rows (${JSON.stringify(before)})`);
    assert(filesIn(join(app.dataDir, "backups")).length === 1, `${release}: one backup saved before the update`);
  }
}

async function partA() {
  log(`PART A: update from ${PREVIOUS_RELEASE} keeps sessions, settings, saved hosts and plugins`);
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
    // The disabled-plugin list is host-only (plugin identity binding), so the
    // page cannot read it; step A5 checks it in the database after quitting.
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
  assert(userVersion(dbPath) === SCHEMA_VERSION, `database now at schema version ${userVersion(dbPath)}`);
  const after = rowCounts(dbPath);
  for (const [table, n] of Object.entries(before)) {
    if (DROPPED.has(table)) {
      assert(!(table in after), `${table}: dropped on purpose (the backup keeps its ${n} rows)`);
      continue;
    }
    assert(after[table] >= n, `${table}: ${n} rows before, ${after[table]} after`);
  }
  const kept = readDb(dbPath, (db) => ({
    sessions: db.prepare("SELECT id FROM sessions WHERE id LIKE 'fx-%' ORDER BY id").all().map((r) => r.id),
    hosts: db.prepare("SELECT COUNT(*) AS n FROM ssh_saved_hosts WHERE id LIKE 'fx-%'").get().n,
    plugins: db.prepare("SELECT COUNT(*) AS n FROM plugins WHERE id LIKE 'fx.%'").get().n,
    storage: db.prepare("SELECT COUNT(*) AS n FROM plugin_storage").get().n,
    disabled: db.prepare("SELECT id FROM plugins WHERE enabled = 0 ORDER BY id").all().map((r) => r.id),
  }));
  assert(kept.sessions.join(",") === "fx-session-1,fx-session-2,fx-session-3", `the three 1.4.0 sessions are kept (${kept.sessions.join(", ")})`);
  assert(kept.hosts === 2 && kept.plugins === 2 && kept.storage === 2, `saved hosts, plugins and plugin data kept (${JSON.stringify(kept)})`);
  assert(kept.disabled.includes("fx.plugin.timer"), `the plugin the user disabled is still disabled (${JSON.stringify(kept.disabled)})`);
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
      dbPath = loadFixture(dir, NEWER_VERSION, { wal: true });
      filesBefore = dbFilesIn(dir);
      hashBefore = sha256(dbPath);
      // Bytes 18/19 of the SQLite header are 2 for a WAL-mode database.
      const header = readFileSync(dbPath).subarray(18, 20);
      assert(header[0] === 2 && header[1] === 2, "the database is in WAL mode, like a real 1.4.0 one");
      log(`  put a WAL-mode database marked as schema version ${NEWER_VERSION} in ${dir} (sha256 ${hashBefore.slice(0, 16)}…)`);
      log(`  files before: ${filesBefore.join(", ")}`);
    },
  });
  launched.push(app);
  let exit;
  let quitByButton = false;
  try {
    const { bridge } = app;
    const readScreen = (description, titleWanted) =>
      bridge.waitFor(
        description,
        `const el = e2e.first(".startup-problem");
         const title = e2e.norm(e2e.first(".startup-problem-title")?.innerText);
         return el && ${titleWanted ? `title === ${JSON.stringify(titleWanted)}` : "true"} ? {
           title,
           message: e2e.norm(e2e.first(".startup-problem-message")?.innerText),
           label: e2e.norm(e2e.first(".startup-problem-path-label")?.textContent), // shown upper-cased by CSS
           path: e2e.norm(e2e.first(".startup-problem-path code")?.innerText),
           buttons: e2e.all("button").map(e2e.nameOf),
           workspace: !!document.querySelector(".app-body"),
         } : null;`,
        { timeoutMs: 20_000 },
      );
    log("step B1: the window explains the problem");
    const shown = await readScreen("the startup problem screen");
    log(`  title: "${shown.title}"`);
    log(`  message: "${shown.message}"`);
    assert(shown.title === "Your data is from a newer version of Hermes", "title says the data is from a newer version");
    assert(shown.message.includes(`data version ${NEWER_VERSION}`) && shown.message.includes(`up to ${SCHEMA_VERSION}`), "message names both versions");
    assert(shown.message.includes("has not opened or changed it"), "message says nothing was changed");
    assert(shown.path.endsWith(DB_FILE), `the data file is named (${shown.path.split(/[\\/]/).pop()})`);
    assert(JSON.stringify(shown.buttons) === JSON.stringify(["Quit Hermes"]), "the only action is Quit Hermes");
    assert(shown.workspace === false, "the workspace did not start");
    const shot = await bridge.screenshot(join(evidenceDir, "B1-newer-data-refused.png"));
    log(`  screenshot saved: ${shot.file} (${shot.bytes} bytes)`);

    log("step B2: a user who picked German sees the explanation in German");
    // The settings database is what is refused, so the screen uses the
    // language choice Hermes also keeps in the webview's local storage.
    await bridge.eval(
      `localStorage.setItem("hermes.ui_language", "de"); setTimeout(() => location.reload(), 50); return true;`,
    );
    const german = await readScreen("the German startup problem screen", "Deine Daten stammen aus einer neueren Version von Hermes");
    log(`  title: "${german.title}"`);
    log(`  message: "${german.message}"`);
    assert(german.message.includes(`Datenversion ${NEWER_VERSION}`) && german.message.includes(`bis ${SCHEMA_VERSION}`), "German message names both versions");
    assert(german.message.includes("nicht geöffnet und nicht verändert"), "German message says nothing was changed");
    assert(german.label === "Datendatei" && german.path.endsWith(DB_FILE), `German label for the data file (${german.label})`);
    assert(JSON.stringify(german.buttons) === JSON.stringify(["Hermes beenden"]), "the only action is Hermes beenden (Quit Hermes)");
    assert(german.workspace === false, "the workspace still did not start");
    const shotDe = await bridge.screenshot(join(evidenceDir, "B2-newer-data-refused-de.png"));
    log(`  screenshot saved: ${shotDe.file} (${shotDe.bytes} bytes)`);

    // Leave the language as it was: on Windows the webview's storage outlives
    // this run and the next scenario would otherwise start in German.
    await bridge.eval(`localStorage.removeItem("hermes.ui_language"); return true;`);

    log("step B3: press Hermes beenden (Quit Hermes)");
    try {
      await bridge.clickByName("Hermes beenden");
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

  log("step B4: the database is exactly as it was");
  // List the folder before opening the database below: even a read-only open
  // of a WAL database creates -wal/-shm files. Only database files count; the
  // webview may keep its own storage in this folder on some platforms.
  log(`  files after: ${filesIn(dataDir).join(", ")}`);
  const filesAfter = dbFilesIn(dataDir);
  assert(
    JSON.stringify(filesAfter) === JSON.stringify(filesBefore),
    `no backup, WAL or other database files were created (${filesAfter.join(", ")})`,
  );
  assert(sha256(dbPath) === hashBefore, "database file is byte-for-byte unchanged");
  assert(userVersion(dbPath) === NEWER_VERSION, `still schema version ${NEWER_VERSION}`);
}

async function partC() {
  log(`PART C: newer data (schema version ${NEWER_VERSION}) left mid-write by a crash is refused and left untouched`);
  let dbPath;
  let walPath;
  let dataDir;
  let filesBefore;
  let dbHash;
  let walHash;
  const scratch = mkdtempSync(join(tmpdir(), "n06-crash-"));
  const app = await launchApp({
    runDir: join(evidenceDir, "run-newer-crashed"),
    log,
    prepareDataDir: (dir) => {
      dataDir = dir;
      // A "newer Hermes" writes, with its last changes still only in the WAL.
      const live = loadFixture(scratch, 0, { wal: true });
      const writer = new DatabaseSync(live);
      writer.exec(`PRAGMA wal_autocheckpoint = 0;
        PRAGMA user_version = ${NEWER_VERSION};
        INSERT OR REPLACE INTO settings (key, value) VALUES ('written_by_newer', 'only-in-wal');`);
      // Copy the files while it is still open: what a crash leaves behind.
      dbPath = join(dir, DB_FILE);
      walPath = `${dbPath}-wal`;
      copyFileSync(live, dbPath);
      copyFileSync(`${live}-wal`, walPath);
      writer.close();
      rmSync(scratch, { recursive: true, force: true });
      filesBefore = dbFilesIn(dir);
      dbHash = sha256(dbPath);
      walHash = sha256(walPath);
      log(`  files before: ${filesBefore.join(", ")}`);
    },
  });
  launched.push(app);
  let exit;
  try {
    const { bridge } = app;
    log("step C1: the window explains the problem");
    const shown = await bridge.waitFor(
      "the startup problem screen",
      `const t = e2e.first(".startup-problem-title");
       return t ? { title: e2e.norm(t.innerText), message: e2e.norm(e2e.first(".startup-problem-message")?.innerText),
                    workspace: !!document.querySelector(".app-body") } : null;`,
      { timeoutMs: 20_000 },
    );
    log(`  title: "${shown.title}"`);
    assert(shown.title === "Your data is from a newer version of Hermes", "title says the data is from a newer version");
    assert(shown.message.includes(`data version ${NEWER_VERSION}`), "the version still only in the WAL was read");
    assert(shown.workspace === false, "the workspace did not start");
    const shot = await bridge.screenshot(join(evidenceDir, "C1-newer-crashed-data-refused.png"));
    log(`  screenshot saved: ${shot.file} (${shot.bytes} bytes)`);
  } finally {
    log("step C2: quit");
    exit = await app.stop({ keepFiles: true });
    log(`  app exited: ${JSON.stringify(exit)}`);
  }

  log("step C3: the database and its WAL are exactly as they were");
  log(`  files after: ${filesIn(dataDir).join(", ")}`);
  // SQLite's -shm index holds no data (any reader rebuilds it from the WAL).
  const filesAfter = dbFilesIn(dataDir).filter((f) => !f.endsWith("-shm"));
  assert(
    JSON.stringify(filesAfter) === JSON.stringify(filesBefore),
    `no backup or other data files were created or removed (${filesAfter.join(", ")})`,
  );
  assert(sha256(dbPath) === dbHash, "database file is byte-for-byte unchanged");
  assert(sha256(walPath) === walHash, "the WAL is byte-for-byte unchanged (not folded into the database)");
  const seen = readDb(dbPath, (db) => ({
    version: db.prepare("PRAGMA user_version").get().user_version,
    row: db.prepare("SELECT value FROM settings WHERE key = 'written_by_newer'").get()?.value,
  }));
  assert(seen.version === NEWER_VERSION && seen.row === "only-in-wal", "the newer version still finds its last changes");
}

let failed = false;
try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}`);
  await part0();
  await partA();
  await partB();
  await partC();
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
}
for (const app of launched) app.cleanup();
finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
