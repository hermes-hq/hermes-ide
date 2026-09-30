#!/usr/bin/env node
// Scenario N17: fast worktrees — shared dependencies and ports.
//
// Drives the REAL app through the New Session wizard on a throwaway git repo
// whose project folder has node_modules installed (a small package the demo
// server needs, a few thousand filler packages and a 256 MB blob):
//
//   run 1  fresh install; turn the "diskGuard" feature flag on (stored in the
//          app's settings while it is closed, as Settings > Flags stores it —
//          N07 proves that control; the flag also gates N14)
//   run 2  - session A on a new branch: its worktree has node_modules within
//            10 s of pressing Create (real deps on Windows: 20 s and 1.5x faster
//            than a warm-cache install, see DEADLINE_MS), cloned copy-on-write from the project
//            folder (clonefile on macOS, reflink on Linux, block cloning on
//            Windows). The disk barely notices (the blob is shared, not
//            copied: the bytes the worktree holds of its own on
//            macOS/Linux, see cow-usage.mjs; the blob's clusters on
//            Windows), and the clone is independent: overwriting it leaves
//            the project folder alone. The Git panel says so and shows the ports.
//          - A's terminal runs the demo dev server: it finds its dependency
//            and listens on $PORT. Session B does the same in its worktree.
//            Both servers answer at once, on ports from different blocks,
//            each from its own worktree.
//          - the project folder's lockfile changes: session C's worktree
//            (lockfile as committed) is cloned from A's worktree instead.
//          - a lockfile no checkout has: session D gets nothing cloned and is
//            told to install as usual.
//   run 3  test-only switch HERMES_E2E_NO_COPY_ON_WRITE=1 (e2e builds with
//          HERMES_E2E=1 only): the disk "cannot share files", so session E
//          gets nothing cloned, is told why, and still gets its own ports.
//
// Copy-on-write needs the repo and the app's data on one volume that supports
// it: the temp folder on macOS (APFS). On Linux and Windows point
// HERMES_E2E_COW_DIR at a btrfs/XFS or ReFS folder (CI mounts one).
//
// Negative control: HERMES_E2E_N17_NEGATIVE=1 switches the flag off, so session
// A's worktree has no node_modules and the scenario must end in RESULT: FAIL.
//
// HERMES_E2E_N17_REAL_DEPS=1 uses this repo's own package.json and lockfile,
// installed into the project folder with npm ci (about 700 MB), to measure
// "a new worktree of this repo" rather than the synthetic one
// (N17-real-deps.mjs runs it that way).
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N17-fast-worktrees.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/N17-fast-worktrees.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ownDiskUsage } from "../cow-usage.mjs";
import { REPO_ROOT, createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const NEGATIVE = process.env.HERMES_E2E_N17_NEGATIVE === "1";
const REAL_DEPS = process.env.HERMES_E2E_N17_REAL_DEPS === "1";
const SCENARIO = REAL_DEPS ? "N17-real-deps" : "N17-fast-worktrees";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

const DB_FILE = "hermes_idea_v3.db";
const onWindows = platform() === "win32";
// N17-1, per OS. macOS and Linux: under 10 s. Windows, with this repo's own
// dependencies: under 20 s AND at least 1.5x faster than a warm-cache install
// (npm ci, scripts skipped) of the same lockfile, measured in the same run; a
// cold install downloads too and is much slower. ReFS block-clones only files
// over 64 KB and copies the rest, and those ~35,000 small files take most of
// the 8-9 s a hosted runner needs. The synthetic install keeps 10 s everywhere.
const DEADLINE_MS = onWindows && REAL_DEPS ? 20_000 : 10_000;
const MIN_SPEEDUP = 1.5;
// The install baseline: on Windows, or anywhere with
// HERMES_E2E_N17_INSTALL_BASELINE=1 (the ratio check then applies there too).
const MEASURE_INSTALL =
  REAL_DEPS && !NEGATIVE && (onWindows || process.env.HERMES_E2E_N17_INSTALL_BASELINE === "1");
const BLOB_BYTES = 256 * 1024 * 1024;
const FILLER_PACKAGES = 3_000;
const MARKER = join("node_modules", "n17-mine.txt");
const EXPECTED_METHOD = { darwin: "clonefile", linux: "reflink", win32: "block_clone" }[platform()];

const cowRoot = process.env.HERMES_E2E_COW_DIR || tmpdir();
mkdirSync(cowRoot, { recursive: true });
const workDir = mkdtempSync(join(cowRoot, "hermes-e2e-n17-work-"));
const homeDir = onWindows ? undefined : mkdtempSync(join(cowRoot, "hermes-e2e-n17-home-"));
// Windows keeps app data under %APPDATA% (on C:); point it at the same
// volume as the repo, or nothing could be cloned.
const dataDirOverride = onWindows ? join(workDir, "app-data") : undefined;
const repo = join(workDir, "demo-repo");

function launch(run, { first = false, env = {} } = {}) {
  const runDir = join(evidenceDir, `run-${run}`);
  const all = { ...env, ...(dataDirOverride ? { HERMES_DATA_DIR: dataDirOverride } : {}) };
  return onWindows
    ? launchApp({ runDir, log, home: "real", resetData: first, env: all })
    : launchApp({ runDir, log, home: "private", homeDir, env: all });
}

// ─── Throwaway repo ──────────────────────────────────────────────────

function git(dir, args) {
  const res = spawnSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", "-c", "commit.gpgsign=false", "-C", dir, ...args],
    { encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}

/** The module the demo server needs, and what it reports about it. */
const DEP = REAL_DEPS
  ? { require: "react/package.json", field: "version" }
  : { require: "n17-demo-dep", field: "value" };

const SERVER = `// Demo dev server: needs its dependency and listens on $PORT.
let dep;
try {
  dep = require(${JSON.stringify(DEP.require)});
} catch (e) {
  console.log("n17-server missing dependency: " + (e.code || e.message));
  process.exit(1);
}
const port = Number(process.env.PORT);
if (!port) {
  console.log("n17-server no PORT in its environment");
  process.exit(1);
}
const server = require("http").createServer((req, res) => {
  res.end(JSON.stringify({
    dep: dep[${JSON.stringify(DEP.field)}],
    port,
    base: process.env.HERMES_PORT_BASE,
    count: process.env.HERMES_PORT_COUNT,
    cwd: process.cwd(),
  }));
  if (req.url === "/quit") server.close(() => process.exit(0));
});
server.listen(port, "127.0.0.1", () => console.log("n17-server listening port=" + port));
setTimeout(() => process.exit(0), 300000).unref();
`;

function lockfile(version) {
  return JSON.stringify(
    {
      name: "demo",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "demo", version: "1.0.0" }, "node_modules/n17-demo-dep": { version } },
    },
    null,
    2,
  ) + "\n";
}

function makeRepo() {
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "serve.cjs"), SERVER);
  if (REAL_DEPS) {
    cpSync(join(REPO_ROOT, "package.json"), join(repo, "package.json"));
    cpSync(join(REPO_ROOT, "package-lock.json"), join(repo, "package-lock.json"));
  } else {
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0", private: true }) + "\n");
    writeFileSync(join(repo, "package-lock.json"), lockfile("1.0.0"));
  }
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
}

/** node_modules in the project folder, as an install would leave it. */
function installInProjectFolder() {
  const nm = join(repo, "node_modules");
  if (REAL_DEPS) {
    // Installed here, from this repo's lockfile: the checkout running the
    // scenario need not have node_modules (CI shard jobs do not install).
    const ms = npmCi(repo);
    log(`  npm ci of this repo's lockfile in the project folder: ${ms} ms`);
    if (!existsSync(join(nm, "react", "package.json"))) throw new Error("npm ci left no react");
    return;
  }
  mkdirSync(join(nm, "n17-demo-dep"), { recursive: true });
  writeFileSync(join(nm, "n17-demo-dep", "package.json"), JSON.stringify({ name: "n17-demo-dep", version: "1.0.0", main: "index.js" }));
  writeFileSync(join(nm, "n17-demo-dep", "index.js"), 'module.exports = { value: "demo-dep-1.0.0" };\n');
  for (let i = 0; i < FILLER_PACKAGES; i++) {
    const dir = join(nm, `filler-${i}`);
    mkdirSync(join(dir, "lib"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `filler-${i}`, version: "1.0.0" }));
    writeFileSync(join(dir, "lib", "index.js"), `module.exports = ${i};\n`.repeat(40));
  }
  mkdirSync(join(nm, "n17-blob"), { recursive: true });
  const blob = join(nm, "n17-blob", "blob.bin");
  const chunk = 16 * 1024 * 1024;
  for (let written = 0; written < BLOB_BYTES; written += chunk) appendFileSync(blob, randomBytes(chunk));
}

/** `npm ci` (scripts skipped) of the package.json and lockfile in `dir`; returns how long it took. */
function npmCi(dir) {
  const started = Date.now();
  const res = spawnSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], {
    cwd: dir,
    encoding: "utf8",
    shell: onWindows, // npm is npm.cmd there
    maxBuffer: 64 * 1024 * 1024,
  });
  const ms = Date.now() - started;
  if (res.status !== 0) throw new Error(`npm ci in ${dir} failed (${res.status}): ${res.stderr || res.stdout}`);
  return ms;
}

/**
 * How long a fresh install of this repo's lockfile takes: `npm ci` in a new
 * folder on the same volume. It runs after the project folder's own install,
 * so npm's cache is warm and nothing is downloaded, and scripts are skipped:
 * the fast case for npm.
 */
function timeFreshInstall() {
  const dir = join(workDir, "fresh-install");
  mkdirSync(dir);
  cpSync(join(repo, "package.json"), join(dir, "package.json"));
  cpSync(join(repo, "package-lock.json"), join(dir, "package-lock.json"));
  const ms = npmCi(dir);
  if (!existsSync(join(dir, "node_modules", "react", "package.json"))) throw new Error("npm ci left no react");
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  return ms;
}

/** The first 64 KB of a file. */
function readHead(file) {
  const buf = Buffer.alloc(64 * 1024);
  const fd = openSync(file, "r");
  try {
    return buf.subarray(0, readSync(fd, buf, 0, buf.length, 0));
  } finally {
    closeSync(fd);
  }
}

/** Windows: where a file's data sits on the disk, as fsutil lists it. */
function extentsOf(file) {
  const res = spawnSync("fsutil", ["file", "queryextents", file], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`fsutil file queryextents failed: ${res.stdout}${res.stderr}`);
  return res.stdout
    .split(/\r?\n/)
    .filter((line) => /LCN/i.test(line))
    .map((line) => line.trim().replace(/\s+/g, " "));
}

// ─── UI helpers ──────────────────────────────────────────────────────

async function completeOnboarding(bridge) {
  await bridge.waitFor("the welcome dialog", `return !!e2e.first(".onboarding-dialog");`);
  for (const _screen of ["welcome", "theme", "AI tools"]) {
    await bridge.click(".onboarding-actions .onboarding-btn-primary");
    await sleep(150);
  }
  await bridge.waitFor("the privacy screen", `return e2e.all(".onboarding-privacy-checkbox input").length === 2;`);
  await bridge.clickWhenReady(`
    const [analytics, policy] = e2e.all(".onboarding-privacy-checkbox input");
    if (analytics.checked) e2e.click(analytics);
    if (!policy.checked) e2e.click(policy);
    return { analytics: analytics.checked, policy: policy.checked };
  `);
  await bridge.waitFor("the Finish button to become enabled", `
    const b = e2e.first(".onboarding-actions .onboarding-btn-primary");
    return !!b && !b.disabled;
  `);
  await bridge.click(".onboarding-actions .onboarding-btn-primary");
  await bridge.waitFor("the welcome dialog to close", `return !e2e.first(".onboarding-backdrop");`);
  await sleep(300);
  await dismissWhatsNew(bridge);
}

async function dismissWhatsNew(bridge) {
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
}

async function waitForReturningLaunch(bridge) {
  await bridge.waitFor("the app UI to be ready (no onboarding this time)", `
    return !!e2e.first(".topbar-title, .topbar") && !e2e.first(".onboarding-backdrop");
  `);
  await dismissWhatsNew(bridge);
}

function setInput(bridge, selector, value) {
  return bridge.clickWhenReady(`
    const el = e2e.must(e2e.first(${JSON.stringify(selector)}), ${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return { value: el.value };
  `);
}

/** "New session" from wherever the app is: the empty state or the sidebar. */
async function openWizard(bridge) {
  // Chosen and clicked in one go: right after a launch the empty state can
  // give way to the restored sessions between two separate calls.
  // "+" (New Session) is the button at the top of the left activity bar.
  await bridge.clickWhenReady(`
    const target = e2e.first("button.es-tile-primary") || e2e.first(".activity-bar-left > .activity-bar-action");
    return e2e.click(e2e.must(target, "a New Session button"));
  `);
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
}

/**
 * New Session wizard: plain shell, the demo repo, a NEW branch. Returns the
 * new session's id once its shell is up, and how long Create took.
 */
async function createSessionOnNewBranch(bridge, branch, shotPrefix) {
  await openWizard(bridge);
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`);
  await bridge.clickWhenReady(`
    const cards = e2e.all(".session-creator-provider-card");
    return e2e.click(e2e.must(cards[cards.length - 1], "plain shell card"));
  `);
  await bridge.click(".session-creator-actions .session-creator-btn-primary");

  await bridge.waitFor("the folder step", `return !!e2e.first(".session-creator-scan-input");`);
  const known = await bridge.clickWhenReady(`
    const item = e2e.all(".project-picker-item").find((el) => el.innerText.includes(${JSON.stringify(basename(repo))}));
    if (!item) return false;
    if (!item.classList.contains("project-picker-item-attached")) e2e.click(item);
    return true;
  `);
  if (!known) {
    await setInput(bridge, ".session-creator-scan-input", repo);
    await bridge.clickByName("Scan", { within: ".project-picker-footer" });
  }
  await bridge.waitFor("the repo to be added and selected", `
    return e2e.all(".project-picker-item-attached").some((el) => el.innerText.includes(${JSON.stringify(basename(repo))}));
  `);
  await bridge.waitFor("the wizard to detect the git repo (branch step added)", `
    const next = e2e.first(".session-creator-actions .session-creator-btn-primary");
    return e2e.all(".session-creator-step-dot").length === 4 && !!next && !next.disabled;
  `, { timeoutMs: 20_000 });
  await bridge.click(".session-creator-actions .session-creator-btn-primary");

  await bridge.waitFor("the branch step", `return !!e2e.first(".session-creator-branch-multi");`, { timeoutMs: 20_000 });
  await bridge.waitFor("the current branch to be pre-selected", `
    return !!e2e.first(".session-creator-branch-selected-label");
  `, { timeoutMs: 20_000 });
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(500);
    if (await bridge.exists(".branch-selector-tabs")) break;
    if (!(await bridge.exists(".branch-selector-body"))) {
      await bridge.click(".session-creator-branch-project-header");
    }
  }
  await bridge.waitFor("the branch tabs", `return e2e.all(".branch-selector-tab").length === 2;`, { timeoutMs: 20_000 });
  await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.all(".branch-selector-tab")[1], "New branch tab"));`);
  await bridge.waitFor("the new-branch form", `return !!e2e.first(".branch-selector-field-input");`);
  await setInput(bridge, ".branch-selector-field-input", branch);
  await bridge.waitFor("Create & use to become enabled", `
    const b = e2e.first(".branch-selector-body .session-creator-actions .branch-selector-create");
    return !!b && !b.disabled;
  `);
  await bridge.click(".branch-selector-body .session-creator-actions .branch-selector-create");
  await bridge.waitFor(`the wizard to record the new branch "${branch}"`, `
    return e2e.all(".session-creator-branch-selected-label").some((el) => el.innerText.includes(${JSON.stringify(branch)}));
  `);
  await bridge.screenshot(join(evidenceDir, `${shotPrefix}-wizard-new-branch.png`));
  const pressed = Date.now();
  await bridge.click(".session-creator-footer-actions .session-creator-btn-primary");

  // Confirm step: press the primary button until the wizard is creating the
  // session ("Creating..." is disabled: then just wait).
  for (let i = 0; i < 4; i++) {
    const state = await bridge.clickWhenReady(`
      if (!e2e.first(".session-creator")) return "closed";
      const b = e2e.must(
        e2e.first(".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary"),
        "the wizard's primary button",
      );
      if (b.disabled) return "busy";
      e2e.click(b);
      return "clicked";
    `);
    if (state !== "clicked") break;
    await sleep(400);
  }
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 180_000 });
  // The session that owns the new branch's worktree (sessions restored at
  // launch may still be starting their own terminals).
  const id = await bridge.waitFor(
    `the session on "${branch}" to have a terminal`,
    `const all = await window.__TAURI_INTERNALS__.invoke("git_list_all_worktrees");
     const wt = all.find((w) => w.branch_name === ${JSON.stringify(branch)});
     return wt && window.__HERMES_E2E__.terminalIds().includes(wt.session_id) ? wt.session_id : null;`,
    { timeoutMs: 30_000 },
  );
  const tookMs = Date.now() - pressed;
  await bridge.waitFor("the shell prompt", `
    const lines = window.__HERMES_E2E__.readTerminal(${JSON.stringify(id)}) || [];
    const info = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(id)});
    return info && info.opened && lines.some((l) => l.trim().length > 0);
  `, { timeoutMs: 30_000 });
  await sleep(1000);
  return { id, tookMs };
}

/** The worktree the app recorded for a branch, and its setup report. */
async function worktreeOf(bridge, branch) {
  const all = await bridge.eval(`return await window.__TAURI_INTERNALS__.invoke("git_list_all_worktrees");`);
  const wt = all.find((w) => w.branch_name === branch);
  if (!wt) throw new Error(`no worktree recorded for ${branch}: ${JSON.stringify(all)}`);
  const info = await bridge.eval(`
    return await window.__TAURI_INTERNALS__.invoke("git_session_worktree_info", {
      sessionId: ${JSON.stringify(wt.session_id)},
      projectId: ${JSON.stringify(wt.project_id)},
    });
  `);
  return { path: wt.worktree_path, sessionId: wt.session_id, setup: info?.setup ?? null };
}

/** Start the demo server in a session's terminal; returns its port. */
async function startServer(bridge, sessionId) {
  await bridge.typeInTerminal(sessionId, `${process.execPath} serve.cjs\n`);
  const { line } = await bridge.waitForTerminal(sessionId, /n17-server (listening port=\d+|missing dependency|no PORT)/, {
    timeoutMs: 30_000,
  });
  log(`  terminal: "${line.trim()}"`);
  const m = /listening port=(\d+)/.exec(line);
  assert(!!m, "the demo server found its dependency and a PORT");
  return Number(m[1]);
}

async function ask(port, path = "/") {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return JSON.parse(await res.text());
}

/**
 * Opens the session's worktree setup: the Git panel, or the Review Desk's
 * Repository tab when the desk replaces the panel (reviewDesk flag on).
 */
async function openSetupView(bridge) {
  if (await bridge.exists('.session-subview-btn[title="Review Desk"]')) {
    await bridge.click('.session-subview-btn[title="Review Desk"]');
    await bridge.waitFor("the Review Desk", `return !!e2e.first(".review-desk");`);
    await bridge.clickByName("Repository", { within: ".review-desk" });
  } else {
    await bridge.click('.session-subview-btn[title="Git"]');
  }
}

async function closeSetupView(bridge) {
  if (await bridge.exists(".review-desk")) {
    await bridge.click(".review-desk .review-close");
    await bridge.waitFor("the Review Desk to close", `return !e2e.first(".review-desk");`);
  } else {
    await bridge.click('.session-subview-btn[title="Git"]');
  }
}

async function quit(current) {
  const exit = await current.stop();
  log(`  app exited: ${JSON.stringify(exit)}`);
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");
}

function enableFlag(dataDir, on = true) {
  const db = new DatabaseSync(join(dataDir, DB_FILE));
  try {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('feature_flag_overrides', ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    ).run(JSON.stringify({ diskGuard: on }));
  } finally {
    db.close();
  }
}

/** Same folder, however it is spelled (symlinked temp dirs, \ vs /, case on Windows). */
function sameDir(a, b) {
  if (!a || !b) return false;
  const norm = (p) => {
    let real = p;
    try {
      real = realpathSync.native(p);
    } catch {
      // keep the spelling as given
    }
    const s = real.replace(/\\/g, "/").replace(/\/+$/, "");
    return onWindows ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

let app;
let failed = false;
const servers = [];

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}${NEGATIVE ? "   NEGATIVE CONTROL (flag switched off)" : ""}`);
  log(`  copy-on-write folder: ${cowRoot}${process.env.HERMES_E2E_COW_DIR ? "" : " (the temp folder)"}`);
  makeRepo();
  installInProjectFolder();
  log(`  throwaway repo with node_modules installed: ${repo}${REAL_DEPS ? " (this repo's own dependencies)" : ""}`);
  let installMs = null;
  if (MEASURE_INSTALL) {
    log("step 0: baseline — a warm-cache install of the same lockfile on the same volume");
    installMs = timeFreshInstall();
    log(`  npm ci --ignore-scripts --prefer-offline (warm cache): ${installMs} ms`);
  }

  // ── run 1: fresh install, flag on ────────────────────────────────
  log("step 1: fresh launch, complete onboarding, quit");
  app = await launch(1, { first: true });
  await completeOnboarding(app.bridge);
  const dataDir = app.dataDir;
  await quit(app);
  if (NEGATIVE) {
    // On by default since 2.0: the negative control switches it off.
    log("step 2: NEGATIVE CONTROL — switching the diskGuard flag off");
    enableFlag(dataDir, false);
  } else {
    log("step 2: turn the diskGuard flag on (settings, app closed)");
    enableFlag(dataDir);
  }

  // ── run 2 ────────────────────────────────────────────────────────
  app = await launch(2);
  await waitForReturningLaunch(app.bridge);

  log('step 3: session A on the new branch "n17-a"');
  const a = await createSessionOnNewBranch(app.bridge, "n17-a", "01");
  const wtA = await worktreeOf(app.bridge, "n17-a");
  log(`  worktree: ${wtA.path}`);
  log(`  Create to shell: ${a.tookMs} ms; setup: ${JSON.stringify(wtA.setup)}`);
  assert(existsSync(join(wtA.path, "serve.cjs")), "the worktree is checked out");
  assert(existsSync(join(wtA.path, "node_modules")), "the worktree has node_modules");
  const depA = wtA.setup?.dependencies?.find((d) => d.folder === "node_modules");
  assert(depA?.status === "cloned", `node_modules was cloned (${depA?.status}: ${depA?.detail ?? ""})`);
  assert(depA.method === EXPECTED_METHOD, `copy-on-write with ${EXPECTED_METHOD} (${depA.method})`);
  assert(sameDir(depA.source, repo), "from the project folder");
  assert(depA.millis < DEADLINE_MS, `the clone took ${depA.millis} ms (< ${DEADLINE_MS} ms)`);
  assert(a.tookMs < DEADLINE_MS, `the session was up with its dependencies ${a.tookMs} ms after Create (< ${DEADLINE_MS} ms)`);
  if (installMs !== null) {
    assert(
      a.tookMs * MIN_SPEEDUP <= installMs,
      `${(installMs / a.tookMs).toFixed(1)}x faster than a warm-cache install (${installMs} ms; at least ${MIN_SPEEDUP}x)`,
    );
  }
  // What the worktree holds of its own: the bytes of its files no other file
  // shares (not the disk's free space, which any other writer moves).
  const own = onWindows ? null : ownDiskUsage(wtA.path);
  if (own) log(`  worktree A: ${own.files} files, ${own.bytes} bytes, ${own.privateBytes} of them its own`);
  if (!REAL_DEPS) {
    const blob = join("node_modules", "n17-blob", "blob.bin");
    if (onWindows) {
      // ReFS reports free space late and in bursts (a 256 MB clone has
      // shown as 786 MB used), so ask the file system where the data is:
      // a shared file sits on the very clusters of its source.
      const [mine, source] = [extentsOf(join(wtA.path, blob)), extentsOf(join(repo, blob))];
      log(`  blob extents: clone ${JSON.stringify(mine)}; source ${JSON.stringify(source)}`);
      assert(mine.length > 0 && JSON.stringify(mine) === JSON.stringify(source), `the ${BLOB_BYTES / 2 ** 20} MB blob was shared, not copied (same clusters as the source)`);
    } else {
      // A copy would hold the blob plus the filler (about 259 MB in some
      // 6,000 files) of its own; a clone next to nothing. The same limit as when this was
      // measured as free space.
      const used = own.privateBytes;
      assert(own.bytes > BLOB_BYTES, `the worktree has the blob and the filler (${(own.bytes / 2 ** 20).toFixed(1)} MB in ${own.files} files)`);
      assert(used < BLOB_BYTES * 0.75, `the ${BLOB_BYTES / 2 ** 20} MB blob was shared, not copied (${(used / 2 ** 20).toFixed(1)} MB of the worktree's own)`);
    }
    assert(statSync(join(wtA.path, blob)).size === BLOB_BYTES, "the clone has the whole blob");
    const dep = join("node_modules", "n17-demo-dep", "index.js");
    if (!onWindows) assert(statSync(join(wtA.path, dep)).ino !== statSync(join(repo, dep)).ino, "a separate file, not a hard link");
    // Copy-on-write: overwriting the clone's shared blocks leaves the source's.
    const sourceHead = readHead(join(repo, blob));
    const fd = openSync(join(wtA.path, blob), "r+");
    writeSync(fd, Buffer.alloc(sourceHead.length, 0x4e), 0, sourceHead.length, 0);
    closeSync(fd);
    assert(readHead(join(wtA.path, blob)).every((b) => b === 0x4e) && readHead(join(repo, blob)).equals(sourceHead), "overwriting the clone's blob leaves the project folder's blob as it was");
  }
  // A file only A's node_modules has (step 7 tells which checkout C came from).
  writeFileSync(join(wtA.path, MARKER), "written in the worktree");
  assert(!existsSync(join(repo, MARKER)), "writing the clone leaves the project folder alone");

  log("step 4: the session's Git panel (or the Review Desk replacing it) shows the ports and the clone");
  await openSetupView(app.bridge);
  const shown = await app.bridge.waitFor("the worktree setup summary", `
    const el = e2e.first(".worktree-setup");
    if (!el) return null;
    return {
      base: Number(el.dataset.portBase),
      ports: e2e.norm(el.querySelector(".worktree-setup-ports")?.innerText),
      deps: e2e.all(".worktree-setup-dep", el).map((d) => ({ status: d.dataset.status, text: e2e.norm(d.innerText) })),
    };
  `, { timeoutMs: 15_000 });
  log(`  shown: ${JSON.stringify(shown)}`);
  assert(shown.base === wtA.setup.ports.base, `the panel shows the recorded ports (${shown.ports})`);
  assert(shown.ports === `Ports ${shown.base}–${shown.base + 9} (PORT=${shown.base})`, "as a block of 10 with PORT");
  assert(shown.deps[0]?.status === "cloned" && shown.deps[0].text.startsWith("node_modules: cloned from demo-repo in"), "and says node_modules was cloned");
  await app.bridge.screenshot(join(evidenceDir, "02-git-panel-setup.png"));
  await closeSetupView(app.bridge);

  log("step 5: A's terminal runs the dev server");
  const portA = await startServer(app.bridge, a.id);
  servers.push(portA);
  assert(portA === wtA.setup.ports.base, "on the first port of A's block");

  log('step 6: session B on the new branch "n17-b" runs the same server');
  const b = await createSessionOnNewBranch(app.bridge, "n17-b", "03");
  const wtB = await worktreeOf(app.bridge, "n17-b");
  log(`  worktree: ${wtB.path}; setup: ${JSON.stringify(wtB.setup)}`);
  assert(wtB.setup?.dependencies?.[0]?.status === "cloned", "B's node_modules was cloned too");
  const portB = await startServer(app.bridge, b.id);
  servers.push(portB);
  const [fromA, fromB] = await Promise.all([ask(portA), ask(portB)]);
  log(`  A answers ${JSON.stringify(fromA)}`);
  log(`  B answers ${JSON.stringify(fromB)}`);
  const wantDep = REAL_DEPS ? JSON.parse(readFileSync(join(repo, "node_modules", "react", "package.json"), "utf8")).version : "demo-dep-1.0.0";
  assert(fromA.dep === wantDep && fromB.dep === wantDep, `both load their dependency (${wantDep})`);
  assert(portA !== portB, `the two dev servers got different ports (${portA}, ${portB})`);
  assert(Math.abs(portA - portB) >= 10, "from different blocks of 10");
  assert(fromA.base === String(portA) && fromA.count === "10", "A's terminal has HERMES_PORT_BASE and HERMES_PORT_COUNT");
  assert(fromB.base === String(portB) && fromB.count === "10", "B's terminal has HERMES_PORT_BASE and HERMES_PORT_COUNT");
  assert(sameDir(fromA.cwd, wtA.path) && sameDir(fromB.cwd, wtB.path), "each server runs in its own worktree");
  await app.bridge.screenshot(join(evidenceDir, "04-two-servers.png"));

  log("step 7: the project folder's lockfile changes; session C is cloned from A's worktree");
  const lockPath = join(repo, "package-lock.json");
  const committedLock = readFileSync(lockPath, "utf8");
  writeFileSync(lockPath, committedLock.replace(/\n$/, "\n\n"));
  await createSessionOnNewBranch(app.bridge, "n17-c", "05");
  const wtC = await worktreeOf(app.bridge, "n17-c");
  const depC = wtC.setup?.dependencies?.[0];
  log(`  setup: ${JSON.stringify(wtC.setup)}`);
  assert(depC?.status === "cloned", "C's node_modules was cloned");
  assert(sameDir(depC.source, wtA.path) || sameDir(depC.source, wtB.path), "from a worktree with the same lockfile, not the project folder");
  assert(existsSync(join(wtC.path, MARKER)) === sameDir(depC.source, wtA.path), "with that worktree's files");

  log("step 8: a lockfile no checkout has: session D is told to install");
  writeFileSync(lockPath, REAL_DEPS ? committedLock.replace(/\n$/, "\n\n\n") : lockfile("2.0.0"));
  git(repo, ["commit", "-q", "-am", "bump the demo dependency"]);
  writeFileSync(lockPath, readFileSync(lockPath, "utf8") + "\n"); // project folder: yet another lockfile
  await createSessionOnNewBranch(app.bridge, "n17-d", "06");
  const wtD = await worktreeOf(app.bridge, "n17-d");
  log(`  setup: ${JSON.stringify(wtD.setup)}`);
  assert(wtD.setup?.dependencies?.[0]?.status === "lockfile_changed", "D's lockfile matches no checkout");
  assert(!existsSync(join(wtD.path, "node_modules")), "nothing was copied into D");
  assert(!!wtD.setup.ports, "D still has its own ports");
  const bases = [wtA, wtB, wtC, wtD].map((w) => w.setup.ports.base);
  assert(new Set(bases).size === 4, `four worktrees, four port blocks (${bases.join(", ")})`);

  for (const port of servers.splice(0)) await ask(port, "/quit").catch(() => {});
  await quit(app);

  // ── run 3: a disk that cannot share files ────────────────────────
  log("step 9: relaunch where copy-on-write is unavailable (test-only switch)");
  writeFileSync(lockPath, readFileSync(join(wtD.path, "package-lock.json"), "utf8")); // matches again
  app = await launch(3, { env: { HERMES_E2E_NO_COPY_ON_WRITE: "1" } });
  await waitForReturningLaunch(app.bridge);
  await createSessionOnNewBranch(app.bridge, "n17-e", "07");
  const wtE = await worktreeOf(app.bridge, "n17-e");
  log(`  setup: ${JSON.stringify(wtE.setup)}`);
  const depE = wtE.setup?.dependencies?.[0];
  assert(depE?.status === "copy_on_write_unavailable", "E's matching node_modules could not be cloned");
  assert(!existsSync(join(wtE.path, "node_modules")), "and nothing was copied instead");
  assert(!!wtE.setup.ports, "E still has its own ports");
  await openSetupView(app.bridge);
  const fallback = await app.bridge.waitFor("the install-as-usual note", `
    const el = e2e.first('.worktree-setup-dep[data-status="copy_on_write_unavailable"]');
    return el ? e2e.norm(el.innerText) : null;
  `, { timeoutMs: 15_000 });
  log(`  shown: "${fallback}"`);
  assert(fallback.endsWith("Install dependencies as usual"), "the panel says to install as usual");
  await app.bridge.screenshot(join(evidenceDir, "08-install-as-usual.png"));
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      const dump = await app.bridge.eval(`
        return {
          toasts: e2e.all(".toast-message").map((el) => e2e.norm(el.innerText)),
          sessions: e2e.all(".session-item").length,
        };
      `);
      log(`  what the app showed: ${JSON.stringify(dump)}`);
    }
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  for (const port of servers) await ask(port, "/quit").catch(() => {});
  if (app?.isRunning()) {
    log("step 10: quit the app");
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
    if (!failed && (exit.forced || exit.code !== 0)) {
      failed = true;
      log("FAILED: the app did not quit cleanly");
    }
  }
  // Windows may still hold a file in a worktree just after the app quit:
  // retry, and never let the cleanup decide the result.
  for (const dir of [homeDir, workDir].filter(Boolean)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (e) {
      log(`  (could not remove ${dir}: ${e.message})`);
    }
  }
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
