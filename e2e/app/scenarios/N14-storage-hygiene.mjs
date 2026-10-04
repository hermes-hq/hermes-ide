#!/usr/bin/env node
// Scenario N14-storage-hygiene: old worktrees never silently fill the disk,
// and nothing with work in it is lost.
//
// Drives the REAL app on a throwaway git repo whose worktrees are laid out in
// the app's own worktrees folder while the app is closed:
//
//   landed   linked to a session that is not open; its branch is already in
//            main and it is clean, with build output (node_modules)
//   dirty    no session; a commit only it has and an untracked notes.md,
//            plus build output (target)
//   orphan   no session, clean, with build output (dist)
//   gone     a folder whose repo no longer exists
//
//   run 1  fresh install, onboarding, quit; lay out the worktrees; settings:
//          idle after 0 days, automatic cleanup OFF
//   run 2  the disk reports 15 GB free (test-only override), under the 20 GB
//          warning. The background pass says so: a low-disk toast with
//          "Review storage", which opens Settings > Storage. There:
//            - every worktree shows with its state and what it holds
//            - "Clean up now" removes the landed and orphan worktrees (git
//              forgets them, their branches stay), clears the dirty one's
//              build output and keeps its files, and leaves the gone folder
//            - "Remove…" on the dirty one asks, then saves a backup ref in
//              the repo (notes.md and the commit in it) and removes it; the
//              backup is listed
//            - "Delete folder…" on the gone one needs "Delete for good"
//   run 3  automatic cleanup ON, 50 GB free: the background pass alone
//          removes a new clean orphan and keeps a new one with an untracked
//          file.
//
// Negative control: HERMES_E2E_N14S_NEGATIVE=1 leaves automatic cleanup off
// in run 3, so the clean orphan stays and the scenario must end in
// RESULT: FAIL.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N14-storage-hygiene.mjs

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "N14-storage-hygiene";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);
const NEGATIVE = process.env.HERMES_E2E_N14S_NEGATIVE === "1";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

const DB_FILE = "hermes_idea_v3.db";
const onWindows = platform() === "win32";
const homeDir = onWindows ? undefined : mkdtempSync(join(tmpdir(), "hermes-e2e-n14s-home-"));
const workDir = mkdtempSync(join(tmpdir(), "hermes-e2e-n14s-work-"));
const repo = join(workDir, "storage-repo");

function launch(run, { first = false, env = {} } = {}) {
  const runDir = join(evidenceDir, `run-${run}`);
  return onWindows
    ? launchApp({ runDir, log, home: "real", resetData: first, env })
    : launchApp({ runDir, log, home: "private", homeDir, env });
}

function git(dir, args, { allowFail = false } = {}) {
  const res = spawnSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", "-c", "commit.gpgsign=false", "-C", dir, ...args],
    { encoding: "utf8" },
  );
  if (res.status !== 0 && !allowFail) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.status === 0 ? res.stdout : null;
}

function writeBytes(file, bytes) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.alloc(bytes, 120));
}

function makeRepo() {
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, ".gitignore"), "node_modules/\ntarget/\ndist/\n");
  writeFileSync(join(repo, "README.md"), "storage\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);
}

function addWorktree(path, branch) {
  git(repo, ["worktree", "add", "-q", "-b", branch, path]);
  return path;
}

function withDb(dataDir, fn) {
  const db = new DatabaseSync(join(dataDir, DB_FILE));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function setSettings(dataDir, values) {
  withDb(dataDir, (db) => {
    const put = db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    );
    for (const [k, v] of Object.entries(values)) put.run(k, v);
  });
}

/** A session that is not open, linked to `path` since long ago. */
function linkToClosedSession(dataDir, sessionId, path, branch) {
  withDb(dataDir, (db) => {
    db.prepare(
      `INSERT INTO sessions (id, label, phase, working_directory, shell, created_at)
       VALUES (?, 'Old task', 'idle', ?, 'sh', '2026-01-01 00:00:00')`,
    ).run(sessionId, path);
    db.prepare(
      `INSERT INTO session_worktrees (id, session_id, realm_id, worktree_path, branch_name, is_main_worktree, created_at)
       VALUES (?, ?, 'n14s-project', ?, ?, 0, '2026-01-01 00:00:00')`,
    ).run(`${sessionId}-wt`, sessionId, path, branch);
  });
}

function linkCount(dataDir, path) {
  const db = new DatabaseSync(join(dataDir, DB_FILE), { readOnly: true });
  try {
    return db.prepare("SELECT count(*) AS n FROM session_worktrees WHERE worktree_path = ?").get(path).n;
  } finally {
    db.close();
  }
}

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

async function quit(current) {
  const exit = await current.stop();
  log(`  app exited: ${JSON.stringify(exit)}`);
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");
}

/** What the Storage view shows for the row of `path`. */
function row(bridge, path) {
  return bridge.eval(`
    const r = e2e.all('[data-testid="storage-row"]').find((el) => el.dataset.path === ${JSON.stringify(path)});
    if (!r) return null;
    return {
      state: r.dataset.state,
      text: e2e.norm(r.innerText),
      buttons: [...r.querySelectorAll("button")].map((b) => e2e.norm(b.innerText)),
    };
  `);
}

function clickInRow(bridge, path, testId) {
  return bridge.clickWhenReady(`
    const r = e2e.all('[data-testid="storage-row"]').find((el) => el.dataset.path === ${JSON.stringify(path)});
    const b = r?.querySelector('[data-testid="${testId}"]');
    if (!b || b.disabled) return null;
    return e2e.click(b);
  `);
}

async function waitForNote(bridge, description, pattern) {
  return bridge.waitFor(description, `
    const el = e2e.first('[data-testid="storage-note"]');
    const text = el ? e2e.norm(el.innerText) : "";
    return new RegExp(${JSON.stringify(pattern)}).test(text) ? text : null;
  `, { timeoutMs: 30_000 });
}

let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}${NEGATIVE ? "   NEGATIVE CONTROL (automatic cleanup left off)" : ""}`);
  makeRepo();
  log(`  throwaway repo: ${repo}`);

  // ── run 1 ──────────────────────────────────────────────────────────
  log("step 1: fresh launch, onboarding, quit");
  app = await launch(1, { first: true });
  await completeOnboarding(app.bridge);
  await quit(app);
  const dataDir = app.dataDir;
  const base = join(dataDir, "hermes-worktrees");
  const hashDir = join(base, "e2e0000000000001");
  mkdirSync(hashDir, { recursive: true });
  writeFileSync(join(hashDir, "repo_path.txt"), repo);

  log("step 2: lay out the worktrees (app closed)");
  const landed = addWorktree(join(hashDir, "aaaaaaaa_n14s-landed"), "n14s-landed");
  writeBytes(join(landed, "node_modules", "pkg", "index.js"), 1_000_000);
  linkToClosedSession(dataDir, "n14s-session-landed", landed, "n14s-landed");

  const dirty = addWorktree(join(hashDir, "bbbbbbbb_n14s-dirty"), "n14s-dirty");
  writeFileSync(join(dirty, "feature.txt"), "committed work\n");
  git(dirty, ["add", "feature.txt"]);
  git(dirty, ["commit", "-q", "-m", "feature"]);
  writeFileSync(join(dirty, "notes.md"), "only copy\n");
  writeBytes(join(dirty, "target", "debug", "app.bin"), 1_000_000);

  const orphan = addWorktree(join(hashDir, "cccccccc_n14s-orphan"), "n14s-orphan");
  writeBytes(join(orphan, "dist", "bundle.js"), 500_000);

  const goneHash = join(base, "e2e00000000dead1");
  const gone = join(goneHash, "dddddddd_old-task");
  writeBytes(join(gone, "notes.bin"), 300_000);
  writeFileSync(join(goneHash, "repo_path.txt"), join(workDir, "deleted-repo"));

  setSettings(dataDir, {
    feature_flag_overrides: JSON.stringify({ diskGuard: true }),
    worktree_idle_days: "0",
    worktree_auto_cleanup: "false",
  });

  // ── run 2 ──────────────────────────────────────────────────────────
  log("step 3: relaunch with 15 GB free (under the 20 GB warning)");
  app = await launch(2, {
    env: { HERMES_E2E_FREE_SPACE_BYTES: "15000000000", HERMES_E2E_HYGIENE_START_SECS: "5", HERMES_E2E_HYGIENE_TICK_SECS: "600" },
  });
  await waitForReturningLaunch(app.bridge);

  const toast = await app.bridge.waitFor("the low-disk notice", `
    const t = e2e.all(".toast-message").map((el) => e2e.norm(el.innerText)).find((s) => s.includes("Low disk space"));
    return t || null;
  `, { timeoutMs: 60_000 });
  log(`  toast: "${toast}"`);
  assert(toast.startsWith("Low disk space: 15.0 GB free."), "the notice gives the free space");
  assert(/Old worktrees use [\d.]+ [KMG]B; [\d.]+ [KMG]B can be freed without losing work\./.test(toast), "it says what old worktrees use and what can go safely");
  await app.bridge.screenshot(join(evidenceDir, "01-low-disk-notice.png"));

  log("step 4: Review storage opens Settings > Storage");
  await app.bridge.clickWhenReady(`
    const toast = e2e.all(".toast").find((el) => el.innerText.includes("Low disk space"));
    const b = [...(toast?.querySelectorAll(".toast-actions button") ?? [])].find((el) => el.innerText.includes("Review storage"));
    return b ? e2e.click(b) : null;
  `);
  await app.bridge.waitFor("the Storage view with all four worktrees", `
    return e2e.all('[data-testid="storage-row"]').length === 4;
  `, { timeoutMs: 30_000 });
  const free = await app.bridge.eval(`return e2e.norm(e2e.first('[data-testid="storage-free"]').innerText);`);
  assert(free === "15.0 GB free", `free space shown ("${free}")`);

  const rLanded = await row(app.bridge, landed);
  const rDirty = await row(app.bridge, dirty);
  const rOrphan = await row(app.bridge, orphan);
  const rGone = await row(app.bridge, gone);
  log(`  rows: ${JSON.stringify({ rLanded, rDirty, rOrphan, rGone })}`);
  assert(rLanded.state === "landed" && rLanded.text.includes("Nothing to lose"), "the merged, clean worktree is Merged with nothing to lose");
  assert(rDirty.state === "orphaned" && rDirty.text.includes("1 changed file") && rDirty.text.includes("1 commit not pushed or merged"), "the dirty orphan shows its changed file and its commit");
  assert(rDirty.buttons.includes("Remove…") && !rDirty.buttons.includes("Remove worktree"), "the dirty orphan is never a one-click removal");
  assert(rOrphan.state === "orphaned" && rOrphan.text.includes("No session"), "the clean orphan says it has no session");
  assert(rGone.text.includes("no backup possible") && rGone.buttons.includes("Delete folder…"), "the folder of the deleted repo says no backup is possible");
  await app.bridge.screenshot(join(evidenceDir, "02-storage-view.png"));

  log("step 5: Clean up now");
  await app.bridge.clickWhenReady(`
    const b = e2e.first('[data-testid="storage-clean-up"]');
    return b && !b.disabled ? e2e.click(b) : null;
  `);
  const cleaned = await waitForNote(app.bridge, "the clean-up note", "^Freed ");
  log(`  note: "${cleaned}"`);
  assert(/Worktrees removed: 2\. Build output cleared: 1\./.test(cleaned), "two worktrees removed, one build output cleared");
  assert(!existsSync(landed), "the landed worktree is gone from disk");
  assert(!existsSync(orphan), "the clean orphan is gone from disk");
  const list = git(repo, ["worktree", "list", "--porcelain"]);
  assert(!list.includes("n14s-landed") && !list.includes("n14s-orphan"), "git forgot both");
  assert(git(repo, ["branch", "--list", "n14s-landed", "n14s-orphan"]).includes("n14s-landed"), "their branches stay");
  assert(existsSync(join(dirty, "notes.md")) && existsSync(join(dirty, "feature.txt")), "the dirty worktree keeps its files");
  assert(!existsSync(join(dirty, "target")), "the dirty worktree's build output is gone");
  assert(existsSync(join(gone, "notes.bin")), "the folder of the deleted repo is untouched");
  await app.bridge.screenshot(join(evidenceDir, "03-cleaned.png"));

  log("step 6: Remove… the dirty worktree (asks, then backs up)");
  await clickInRow(app.bridge, dirty, "storage-remove");
  const confirmText = await app.bridge.waitFor("the confirmation", `
    const el = e2e.first(".storage-confirm");
    return el ? e2e.norm(el.innerText) : null;
  `);
  assert(confirmText.includes("saves a backup of its files first"), "it says a backup is saved first");
  assert(existsSync(join(dirty, "notes.md")), "nothing removed before the yes");
  await clickInRow(app.bridge, dirty, "storage-confirm-remove");
  const removedNote = await waitForNote(app.bridge, "the removal note", "Backup: refs/hermes/backups/");
  log(`  note: "${removedNote}"`);
  const ref = removedNote.match(/Backup: (refs\/hermes\/backups\/\S+)/)[1];
  assert(!existsSync(dirty), "the dirty worktree is gone from disk");
  assert(git(repo, ["show", `${ref}:notes.md`]) === "only copy\n", "the backup holds the untracked notes.md");
  assert(git(repo, ["show", `${ref}:feature.txt`]) === "committed work\n", "and the commit only it had");
  assert(git(repo, ["branch", "--list", "n14s-dirty"]).includes("n14s-dirty"), "its branch stays");
  await app.bridge.waitFor("the backup to be listed", `
    return e2e.norm(e2e.first('[data-testid="storage-backups"]')?.innerText ?? "").includes(${JSON.stringify(ref)});
  `);
  await app.bridge.screenshot(join(evidenceDir, "04-backed-up.png"));

  log("step 7: Delete folder… for the deleted repo's folder");
  await clickInRow(app.bridge, gone, "storage-remove");
  await app.bridge.waitFor("the unrecoverable warning", `
    return e2e.norm(e2e.first(".storage-confirm")?.innerText ?? "").includes("cannot be brought back");
  `);
  await clickInRow(app.bridge, gone, "storage-confirm-remove");
  await waitForNote(app.bridge, "the removal note", "^Removed old-task ");
  assert(!existsSync(gone), "the folder of the deleted repo is gone after the explicit yes");
  await app.bridge.waitFor("the Storage view to be empty", `return e2e.all('[data-testid="storage-row"]').length === 0;`);
  await quit(app);
  assert(linkCount(dataDir, landed) === 0, "the database no longer links the removed worktree");

  // ── run 3 ──────────────────────────────────────────────────────────
  log(`step 8: automatic cleanup ${NEGATIVE ? "left OFF (negative control)" : "ON"}; a clean and a dirty orphan`);
  const auto = addWorktree(join(hashDir, "eeeeeeee_n14s-auto"), "n14s-auto");
  writeBytes(join(auto, "node_modules", "x.js"), 400_000);
  const keep = addWorktree(join(hashDir, "ffffffff_n14s-keep"), "n14s-keep");
  writeFileSync(join(keep, "draft.md"), "mine\n");
  setSettings(dataDir, { worktree_auto_cleanup: NEGATIVE ? "false" : "true" });
  app = await launch(3, {
    env: { HERMES_E2E_FREE_SPACE_BYTES: "50000000000", HERMES_E2E_HYGIENE_START_SECS: "3", HERMES_E2E_HYGIENE_TICK_SECS: "600" },
  });
  await waitForReturningLaunch(app.bridge);
  const deadline = Date.now() + 60_000;
  while (existsSync(auto) && Date.now() < deadline) await sleep(500);
  assert(!existsSync(auto), "the background pass removed the clean orphan by itself");
  assert(existsSync(join(keep, "draft.md")) && readFileSync(join(keep, "draft.md"), "utf8") === "mine\n", "and kept the orphan with an untracked file");
  assert(git(repo, ["worktree", "list", "--porcelain"]).includes("n14s-keep"), "git still knows the kept one");
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      const dump = await app.bridge.eval(`
        return {
          toasts: e2e.all(".toast-message").map((el) => e2e.norm(el.innerText)),
          rows: e2e.all('[data-testid="storage-row"]').map((el) => e2e.norm(el.innerText)),
          note: e2e.norm(e2e.first('[data-testid="storage-note"]')?.innerText ?? ""),
        };
      `);
      log(`  what the app showed: ${JSON.stringify(dump)}`);
    }
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  if (app?.isRunning()) {
    log("step 9: quit the app");
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
    if (!failed && (exit.forced || exit.code !== 0)) {
      failed = true;
      log("FAILED: the app did not quit cleanly");
    }
  }
  if (homeDir) rmSync(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
