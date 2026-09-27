#!/usr/bin/env node
// Scenario N02: Hermes instances never clobber each other.
//
// 1. A test build pointed at the installed app's data folder refuses to start
//    however the path is spelled. The folder is a stand-in in a throwaway
//    home: a test build is never started on the real one, so a regression
//    fails this test instead of opening real data.
// 2. Two builds run side by side in the machine's REAL temp folder, next to
//    shell-setup files named the way an older installed Hermes names them
//    (fresh and days old: only the installed app itself sweeps old ones). Starting
//    the second build leaves the installed app's files and the first build's
//    live terminal files alone, only clears its own leftovers, and never opens
//    a file in the other build's data folder or in the production one. The
//    first build's terminal keeps working.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N02-instance-isolation.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/N02-instance-isolation. Nothing is written inside the
// production data folder, and the real one is never given to a build.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { appBinaryPath, createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "N02-instance-isolation";
const startedAt = Date.now();
const PRODUCTION_IDENTIFIER = "com.hermes-ide.terminal";
const REFUSAL_EXIT_CODE = 78;
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", "N02-instance-isolation");
rmSync(evidenceDir, { recursive: true, force: true });
const log = createLogger(join(evidenceDir, "scenario.log"));

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

/** The platform data folder under `home` (what the app computes). */
function platformDataBase(home) {
  if (platform() === "darwin") return join(home, "Library", "Application Support");
  if (platform() === "win32") return process.env.APPDATA || join(home, "AppData", "Roaming");
  return process.env.XDG_DATA_HOME || join(home, ".local", "share");
}

/** Same FNV-1a hash the app uses to name its per-instance temp folder. */
function fnv1a64(text) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(text, "utf8")) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}
const shellTempRoot = (dataDir) => join(tmpdir(), `hermes-shell-${fnv1a64(realpathSync.native(dataDir))}`);

/** Environment without anything a surrounding Hermes or agent session set. */
function cleanEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(_?HERMES_|CLAUDE_|CLAUDECODE$|ZDOTDIR$|TERM_PROGRAM)/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, RUST_LOG: "info", ...extra };
}

/** Starts the test app expecting it to refuse; returns its exit and output. */
async function expectRefusal(label, env, runDir) {
  mkdirSync(runDir, { recursive: true });
  const bridgeFile = join(runDir, "bridge.json");
  const child = spawn(appBinaryPath(), [], {
    cwd: runDir,
    env: cleanEnv({ HERMES_E2E: "1", HERMES_E2E_BRIDGE_FILE: bridgeFile, ...env }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const started = Date.now();
  const exit = await new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveExit({ code: null, timedOut: true });
    }, 20_000);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
  const refusal = output.split("\n").find((l) => l.startsWith("Hermes: ")) ?? "";
  log(`  [${label}] exit ${JSON.stringify(exit)} after ${Date.now() - started} ms`);
  log(`  [${label}] app said: ${refusal}`);
  writeFileSync(join(runDir, "output.log"), output);
  assert(exit.code === REFUSAL_EXIT_CODE, `${label}: the build exits with code ${REFUSAL_EXIT_CODE} instead of starting`);
  assert(!existsSync(bridgeFile), `${label}: the app never came up (no automation bridge)`);
  return refusal;
}

/** Files and folders the given process has open (macOS/Linux, via lsof). */
function openPaths(pid) {
  const res = spawnSync("lsof", ["-n", "-P", "-Fn", "-p", String(pid)], { encoding: "utf8" });
  return res.stdout
    .split("\n")
    .filter((l) => l.startsWith("n/"))
    .map((l) => l.slice(1));
}
const under = (p, dir) => p === dir || p.startsWith(dir.endsWith("/") ? dir : dir + "/");

function sha(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
}

function deadPid() {
  for (let pid = 99_991; pid > 90_000; pid--) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e.code === "ESRCH") return pid;
    }
  }
  throw new Error("no free pid found");
}

async function finishOnboarding(bridge) {
  await bridge.waitFor("the welcome dialog", `return !!e2e.first(".onboarding-dialog");`);
  for (let i = 0; i < 3; i++) {
    await bridge.click(".onboarding-actions .onboarding-btn-primary");
    await sleep(150);
  }
  await bridge.waitFor("the privacy screen", `return e2e.all(".onboarding-privacy-checkbox input").length === 2;`);
  await bridge.clickWhenReady(`
    const [analytics, policy] = e2e.all(".onboarding-privacy-checkbox input");
    if (analytics.checked) e2e.click(analytics);
    if (!policy.checked) e2e.click(policy);
    return true;
  `);
  await bridge.waitFor("Finish to be enabled", `
    const b = e2e.first(".onboarding-actions .onboarding-btn-primary");
    return !!b && !b.disabled;
  `);
  await bridge.click(".onboarding-actions .onboarding-btn-primary");
  await bridge.waitFor("the welcome dialog to close", `return !e2e.first(".onboarding-backdrop");`);
  await sleep(300);
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
}

async function openPlainTerminal(bridge) {
  await bridge.click("button.es-tile-primary");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, {
    timeoutMs: 20_000,
  });
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`);
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
  const sessionId = await bridge.waitFor(
    "a terminal to appear",
    `const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
     return ids.length === 1 ? ids[0] : null;`,
    { timeoutMs: 20_000 },
  );
  await bridge.waitFor("the shell prompt", `
    const lines = window.__HERMES_E2E__.readTerminal(${JSON.stringify(sessionId)}) || [];
    const info = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(sessionId)});
    return info && info.opened && lines.some((l) => l.trim().length > 0);
  `, { timeoutMs: 30_000 });
  await sleep(1000);
  return sessionId;
}

async function echo(bridge, sessionId, marker) {
  await bridge.typeInTerminal(sessionId, `echo ${marker}\n`);
  const { line } = await bridge.waitForTerminal(sessionId, new RegExp(`^${marker}$`), { timeoutMs: 20_000 });
  return line;
}

function instanceLine(appLog) {
  return readFileSync(appLog, "utf8").split("\n").find((l) => l.includes("[instance]")) ?? "";
}

let failed = false;
let appA;
let appB;
const scratch = mkdtempSync(join(tmpdir(), "hermes-n02-"));
const tag = `n02-${process.pid}`;
const decoyZsh = join(tmpdir(), `hermes-zsh-${tag}-installed-app`);
const decoyBash = join(tmpdir(), `hermes-bash-${tag}-installed-app.sh`);
const decoyOldZsh = join(tmpdir(), `hermes-zsh-${tag}-old-installed-app`);
const rootsToRemove = [];

try {
  log(`scenario: N02-instance-isolation   platform: ${platform()}   temp folder: ${tmpdir()}`);
  if (platform() === "win32") throw new Error("this scenario uses lsof; run it on macOS or Linux");
  const installed = spawnSync("ps", ["-axo", "pid=,comm="], { encoding: "utf8" })
    .stdout.split("\n")
    .filter((l) => /\/Applications\/[^/]+\.app\/Contents\/MacOS\/hermes-ide$/i.test(l.trim()));
  log(`installed Hermes running during this run: ${installed.length > 0 ? `yes (${installed.map((l) => l.trim().split(" ")[0]).join(", ")})` : "no"}`);

  // ── 1. Refusal with a stand-in production folder ─────────────────────
  log("step 1: a test build pointed at the production data folder refuses to start (throwaway home)");
  const fakeHome = join(scratch, "home");
  const fakeProd = join(platformDataBase(fakeHome), PRODUCTION_IDENTIFIER);
  mkdirSync(fakeProd, { recursive: true });
  writeFileSync(join(fakeProd, "hermes_idea_v3.db"), "stand-in database");
  const fakeHomeEnv = {
    HOME: fakeHome,
    CFFIXED_USER_HOME: fakeHome,
    XDG_DATA_HOME: join(fakeHome, ".local", "share"),
    TMPDIR: join(scratch, "tmp-refusal"),
  };
  mkdirSync(fakeHomeEnv.TMPDIR, { recursive: true });
  const before = readdirSync(fakeProd).sort();
  const said = await expectRefusal("exact path", { ...fakeHomeEnv, HERMES_DATA_DIR: fakeProd }, join(evidenceDir, "refuse-1"));
  assert(said.includes("refusing to start") && said.includes("HERMES_DATA_DIR"), "the refusal says why and how to fix it");
  await expectRefusal("sub-folder", { ...fakeHomeEnv, HERMES_DATA_DIR: join(fakeProd, "nested") }, join(evidenceDir, "refuse-2"));
  await expectRefusal(
    "dot-dot spelling",
    { ...fakeHomeEnv, HERMES_DATA_DIR: join(fakeProd, "..", "x", "..", PRODUCTION_IDENTIFIER) },
    join(evidenceDir, "refuse-3"),
  );
  const alias = join(scratch, "innocent-looking-alias");
  symlinkSync(fakeProd, alias);
  await expectRefusal("symlink alias", { ...fakeHomeEnv, HERMES_DATA_DIR: alias }, join(evidenceDir, "refuse-4"));
  const relative = await expectRefusal("relative path", { ...fakeHomeEnv, HERMES_DATA_DIR: "relative/data" }, join(evidenceDir, "refuse-5"));
  assert(relative.includes("must be an absolute path"), "a relative override is rejected");
  assert(JSON.stringify(readdirSync(fakeProd).sort()) === JSON.stringify(before), "the stand-in production folder is unchanged");
  assert(readFileSync(join(fakeProd, "hermes_idea_v3.db"), "utf8") === "stand-in database", "its database is untouched");

  // The real installed app's data folder is never handed to a test build:
  // if the refusal ever regressed, that build would open the real database.
  // Step 1 runs the same check on a stand-in. The real path is only used
  // below to confirm no build has a file open inside it.
  const realProd = join(platformDataBase(homedir()), PRODUCTION_IDENTIFIER);

  // ── 2. Files an installed Hermes has in the real temp folder ─────────
  log("step 2: plant shell-setup files named the way an older installed Hermes names them");
  mkdirSync(decoyZsh, { recursive: true });
  writeFileSync(join(decoyZsh, ".zshrc"), "# installed app's live terminal\n");
  writeFileSync(decoyBash, "# installed app's live terminal\n");
  // Old enough for the installed app's own legacy sweep; a test build must
  // still leave it alone.
  mkdirSync(decoyOldZsh, { recursive: true });
  writeFileSync(join(decoyOldZsh, ".zshrc"), "# left by an older installed app\n");
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  utimesSync(join(decoyOldZsh, ".zshrc"), threeDaysAgo, threeDaysAgo);
  utimesSync(decoyOldZsh, threeDaysAgo, threeDaysAgo);
  const liveLegacy = readdirSync(tmpdir()).filter((n) => /^hermes-(zsh|bash)-/.test(n));
  log(`  legacy shell-setup entries in ${tmpdir()} now: ${liveLegacy.length} (${liveLegacy.join(", ")})`);

  // ── 3. First build with a live terminal ──────────────────────────────
  log("step 3: start build A (own data folder, real temp folder) and open a terminal");
  mkdirSync(join(scratch, "data-a"));
  mkdirSync(join(scratch, "data-b"));
  const dataA = realpathSync.native(join(scratch, "data-a"));
  const dataB = realpathSync.native(join(scratch, "data-b"));
  const rootA = shellTempRoot(dataA);
  const rootB = shellTempRoot(dataB);
  rootsToRemove.push(rootA, rootB);
  // A worktree journal of A's with an unfinished operation: if anything but A
  // replayed it, the folder it names would be deleted.
  const journalTarget = join(dataA, "n02-journal-target");
  mkdirSync(journalTarget, { recursive: true });
  const journal = join(dataA, "hermes-worktrees", "n02test", "worktree-journal.log");
  mkdirSync(join(dataA, "hermes-worktrees", "n02test"), { recursive: true });
  writeFileSync(journal, `CREATE\tsession-test\tproject-test\tbranch-test\t${journalTarget}\t2026-01-01T00:00:00Z\n`);
  const journalSha = sha(journal);

  appA = await launchApp({ runDir: join(evidenceDir, "run-a"), log, tmp: "shared", env: { HERMES_DATA_DIR: dataA } });
  const pidA = appA.child.pid;
  log(`  A: ${instanceLine(appA.appLog).replace(/^.*\[instance\]/, "[instance]")}`);
  assert(instanceLine(appA.appLog).includes(JSON.stringify(dataA)), "A uses the data folder it was given");
  assert(instanceLine(appA.appLog).includes(JSON.stringify(rootA)), `A keeps its shell files in its own temp folder ${basename(rootA)}`);
  await finishOnboarding(appA.bridge);
  const sessionA = await openPlainTerminal(appA.bridge);
  log(`  A: terminal ${sessionA} open; output: ${await echo(appA.bridge, sessionA, "n02-a-before")}`);
  const filesA = readdirSync(rootA).filter((n) => n.includes(`-${pidA}-${sessionA}`));
  assert(filesA.length === 1, `A's live terminal has its shell-setup entry ${filesA[0]} in ${basename(rootA)}`);
  const entryA = join(rootA, filesA[0]);

  // ── 4. Leftovers of an earlier crashed run of B ──────────────────────
  const dead = deadPid();
  log(`step 4: plant leftovers of a crashed earlier run of B (pid ${dead}, not running) in its own temp folder`);
  mkdirSync(join(rootB, `zsh-${dead}-n02-stale`), { recursive: true });
  writeFileSync(join(rootB, `zsh-${dead}-n02-stale`, ".zshrc"), "stale");
  writeFileSync(join(rootB, `bash-${dead}-n02-stale.sh`), "stale");

  // ── 5. Second build starts while A runs ──────────────────────────────
  log("step 5: start build B next to A (own data folder, same real temp folder)");
  appB = await launchApp({ runDir: join(evidenceDir, "run-b"), log, tmp: "shared", env: { HERMES_DATA_DIR: dataB } });
  const pidB = appB.child.pid;
  log(`  B: ${instanceLine(appB.appLog).replace(/^.*\[instance\]/, "[instance]")}`);
  await sleep(1500);

  log("step 6: check what B's startup left alone and what it cleaned");
  assert(existsSync(join(decoyZsh, ".zshrc")), `the installed app's zsh folder ${basename(decoyZsh)} is still there`);
  assert(existsSync(decoyBash), `the installed app's bash file ${basename(decoyBash)} is still there`);
  assert(existsSync(join(decoyOldZsh, ".zshrc")), `the installed app's days-old zsh folder ${basename(decoyOldZsh)} is still there`);
  const stillLegacy = readdirSync(tmpdir()).filter((n) => /^hermes-(zsh|bash)-/.test(n));
  assert(liveLegacy.every((n) => stillLegacy.includes(n)), "every legacy shell-setup entry that existed before B started still exists");
  assert(existsSync(entryA), `A's live terminal entry ${basename(entryA)} is still there`);
  assert(rootA !== rootB, "A and B use different temp folders");
  assert(!existsSync(join(rootB, `zsh-${dead}-n02-stale`)), "B removed its own crashed run's zsh folder");
  assert(!existsSync(join(rootB, `bash-${dead}-n02-stale.sh`)), "B removed its own crashed run's bash file");
  assert(existsSync(journalTarget) && sha(journal) === journalSha, "A's worktree journal and the folder it names are untouched");

  const openB = openPaths(pidB);
  const openA = openPaths(pidA);
  log(`  B has ${openB.length} files open, A has ${openA.length}`);
  const bDb = openB.filter((p) => p.endsWith(".db") || p.includes(".db-"));
  log(`  B's database files: ${bDb.join(", ")}`);
  assert(bDb.length > 0 && bDb.every((p) => under(p, dataB)), "B's database is inside B's own data folder");
  assert(!openB.some((p) => under(p, dataA)), "B has no file open in A's data folder");
  assert(!openA.some((p) => under(p, dataB)), "A has no file open in B's data folder");
  assert(!openB.some((p) => under(p, realProd)) && !openA.some((p) => under(p, realProd)), "neither build has a file open in the production data folder");

  log("step 7: A's terminal still works after B started");
  log(`  A: output: ${await echo(appA.bridge, sessionA, "n02-a-after")}`);
  await sleep(300);
  const shotA = await appA.bridge.screenshot(join(evidenceDir, "01-build-a-terminal-after-b-started.png"));
  const shotB = await appB.bridge.screenshot(join(evidenceDir, "02-build-b-running-alongside.png"));
  log(`  screenshots: ${shotA.file}, ${shotB.file}`);
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  for (const [name, app] of [["a", appA], ["b", appB]]) {
    try {
      if (app?.isRunning()) await app.bridge.screenshot(join(evidenceDir, `99-failure-${name}.png`));
    } catch (inner) {
      log(`  (no failure screenshot for ${name}: ${inner.message})`);
    }
  }
} finally {
  for (const [name, app] of [["B", appB], ["A", appA]]) {
    if (!app) continue;
    const exit = await app.stop();
    log(`quit ${name}: ${JSON.stringify(exit)}`);
    if (!failed && (exit.forced || exit.code !== 0)) {
      failed = true;
      log(`FAILED: ${name} did not quit cleanly`);
    }
  }
  // Only what this run created.
  rmSync(decoyZsh, { recursive: true, force: true });
  rmSync(decoyBash, { force: true });
  rmSync(decoyOldZsh, { recursive: true, force: true });
  for (const root of rootsToRemove) {
    if (basename(root).startsWith("hermes-shell-")) rmSync(root, { recursive: true, force: true });
  }
  if (basename(scratch).startsWith("hermes-n02-")) rmSync(scratch, { recursive: true, force: true });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
