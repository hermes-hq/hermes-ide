#!/usr/bin/env node
// Scenario N14: disk guard and worktree hygiene.
//
// Drives the REAL app through the New Session wizard and the session's Git
// panel, on a throwaway git repo:
//
//   run 1  fresh install; turn the "diskGuard" feature flag on (stored in the
//          app's settings while it is closed, as Settings > Flags stores it —
//          N07 proves that control)
//   run 2  the disk reports 4.2 GB free (test-only override
//          HERMES_E2E_FREE_SPACE_BYTES, honoured only by an e2e build with
//          HERMES_E2E=1). Creating a session on a new branch shows the reason
//          and creates nothing: no session, no worktree folder, no branch, no
//          database record. The inbox-ready event is raised.
//   run 3  the disk reports 50 GB free. The same journey creates the session
//          and its worktree (positive control: the guard is a threshold, not a
//          wall). Then, in Git panel > Worktrees:
//            - the disk used by the worktree is shown, with its build output
//            - "Remove build output" deletes node_modules/target/dist (only
//              folders git ignores; a committed docs/dist survives) and the
//              size shown drops by what was freed
//            - two orphaned worktree folders (one registered with git, one of
//              a repo that no longer exists) are listed with their size and
//              removed in one action; git forgets the worktree; the session's
//              own worktree is untouched
//
// Negative control: HERMES_E2E_N14_NEGATIVE=1 switches the flag off, so
// run 2 creates the session anyway and the scenario must end in RESULT: FAIL.
// Threshold control: HERMES_E2E_N14_LOW_FREE sets run 2's free bytes.
// 9999999999 (just under 10 GB) must PASS; 10000000000 (exactly 10 GB) is
// allowed, so run 2 creates the session and the scenario must FAIL.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N14-disk-guard.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/N14-disk-guard.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "N14-disk-guard";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);
const NEGATIVE = process.env.HERMES_E2E_N14_NEGATIVE === "1";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

const DB_FILE = "hermes_idea_v3.db";
const LOW_FREE = process.env.HERMES_E2E_N14_LOW_FREE || "4200000000"; // 4.2 GB: under the 10 GB guard

/** The refusal's "N.N GB", rounded down like the app does. */
function gbText(bytes) {
  const n = BigInt(bytes);
  if (n >= 100_000_000_000n) return `${n / 1_000_000_000n} GB`;
  const tenths = n / 100_000_000n;
  return `${tenths / 10n}.${tenths % 10n} GB`;
}
const ROOMY_FREE = "50000000000"; // 50 GB
const REFUSED_BRANCH = "n14-refused";
const TASK_BRANCH = "n14-task";
const ORPHAN_BRANCH = "n14-orphan";

const onWindows = platform() === "win32";
const homeDir = onWindows ? undefined : mkdtempSync(join(tmpdir(), "hermes-e2e-n14-home-"));
const workDir = mkdtempSync(join(tmpdir(), "hermes-e2e-n14-work-"));
const repo = join(workDir, "demo-repo");

function launch(run, { first = false, freeBytes } = {}) {
  const runDir = join(evidenceDir, `run-${run}`);
  const env = freeBytes ? { HERMES_E2E_FREE_SPACE_BYTES: freeBytes } : {};
  return onWindows
    ? launchApp({ runDir, log, home: "real", resetData: first, env })
    : launchApp({ runDir, log, home: "private", homeDir, env });
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

function writeBytes(file, bytes) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.alloc(bytes, 120));
}

function makeRepo() {
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, ".gitignore"), "node_modules/\ntarget/\ndist/\n");
  writeBytes(join(repo, "src", "index.js"), 2_000);
  // A committed folder named like build output: must never be removed.
  writeBytes(join(repo, "docs", "dist", "keep.html"), 1_000);
  git(repo, ["add", ".gitignore", "src"]);
  git(repo, ["add", "-f", join("docs", "dist", "keep.html")]);
  git(repo, ["commit", "-q", "-m", "init"]);
}

// ─── UI helpers ──────────────────────────────────────────────────────

/** First-launch welcome flow, same steps as the terminal-echo scenario. */
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

/** Type into a React-controlled input the way the browser reports typing. */
function setInput(bridge, selector, value) {
  return bridge.clickWhenReady(`
    const el = e2e.must(e2e.first(${JSON.stringify(selector)}), ${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return { value: el.value };
  `);
}

/**
 * New Session wizard: plain shell, the demo repo as its folder, a NEW branch.
 * Leaves the wizard once it closed (whether or not a session was created).
 */
async function createSessionOnNewBranch(bridge, branch, shotPrefix) {
  await bridge.click("button.es-tile-primary");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, {
    timeoutMs: 20_000,
  });
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`);
  await bridge.clickWhenReady(`
    const cards = e2e.all(".session-creator-provider-card");
    return e2e.click(e2e.must(cards[cards.length - 1], "plain shell card"));
  `);
  await bridge.click(".session-creator-actions .session-creator-btn-primary");

  // Folder step: pick the repo if the app already knows it, otherwise type
  // its path and press Scan (Browse opens a native dialog).
  await bridge.waitFor("the folder step", `return !!e2e.first(".workspace-scan-input");`);
  const known = await bridge.clickWhenReady(`
    const item = e2e.all(".project-picker-item").find((el) => el.innerText.includes(${JSON.stringify(basename(repo))}));
    if (!item) return false;
    if (!item.classList.contains("project-picker-item-attached")) e2e.click(item);
    return true;
  `);
  if (!known) {
    await setInput(bridge, ".workspace-scan-input", repo);
    await bridge.clickByName("Scan", { within: ".project-picker-footer" });
  }
  await bridge.waitFor("the repo to be added and selected", `
    return e2e.all(".project-picker-item-attached").some((el) => el.innerText.includes(${JSON.stringify(basename(repo))}));
  `);
  // The wizard checks whether the folder is a git repo; once it knows, a
  // branch step joins the progress dots (3 -> 4). Continuing earlier skips it.
  await bridge.waitFor("the wizard to detect the git repo (branch step added)", `
    const next = e2e.first(".session-creator-actions .session-creator-btn-primary");
    return e2e.all(".session-creator-step-dot").length === 4 && !!next && !next.disabled;
  `, { timeoutMs: 20_000 });
  await bridge.click(".session-creator-actions .session-creator-btn-primary");

  // Branch step: the current branch is pre-selected; open the project and
  // create a new branch instead.
  await bridge.waitFor("the branch step", `return !!e2e.first(".session-creator-branch-multi");`, { timeoutMs: 20_000 });
  // The selector pre-selects the current branch once it has loaded, which
  // folds the project up; wait for that, then unfold it.
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
    const b = e2e.first(".branch-selector-body .session-creator-actions .session-creator-btn-primary");
    return !!b && !b.disabled;
  `);
  await bridge.click(".branch-selector-body .session-creator-actions .session-creator-btn-primary");
  await bridge.waitFor(`the wizard to record the new branch "${branch}"`, `
    return e2e.all(".session-creator-branch-selected-label").some((el) => el.innerText.includes(${JSON.stringify(branch)}));
  `);
  await bridge.screenshot(join(evidenceDir, `${shotPrefix}-wizard-new-branch.png`));
  await bridge.click(".session-creator-footer-actions .session-creator-btn-primary");

  // Confirm step: press the primary button until the wizard closes.
  for (let i = 0; i < 4; i++) {
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
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 30_000 });
}

/** Every folder two levels under hermes-worktrees/ (the worktree folders). */
function worktreeFolders(base) {
  if (!existsSync(base)) return [];
  const out = [];
  for (const hash of readdirSync(base)) {
    const hashDir = join(base, hash);
    if (!statSync(hashDir).isDirectory()) continue;
    for (const name of readdirSync(hashDir)) {
      if (statSync(join(hashDir, name)).isDirectory()) out.push(join(hashDir, name));
    }
  }
  return out;
}

function dbCounts(dataDir) {
  const db = new DatabaseSync(join(dataDir, DB_FILE), { readOnly: true });
  try {
    return {
      sessions: db.prepare("SELECT count(*) AS n FROM sessions").get().n,
      worktrees: db.prepare("SELECT count(*) AS n FROM session_worktrees").get().n,
    };
  } finally {
    db.close();
  }
}

function enableDiskGuardFlag(dataDir, on = true) {
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

/** Quit and require a clean exit (so the database is closed and flushed). */
async function quit(current) {
  const exit = await current.stop();
  log(`  app exited: ${JSON.stringify(exit)}`);
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");
}

/** The size the Worktrees view shows for one row, and the numbers behind it. */
function rowUsage(bridge, path) {
  return bridge.eval(`
    const row = e2e.all(".worktree-overview-entry").find((el) => el.dataset.worktreePath === ${JSON.stringify(path)});
    const size = row?.querySelector(".worktree-overview-disk-size");
    if (!size || !size.dataset.totalBytes) return null;
    return {
      text: e2e.norm(size.innerText),
      total: Number(size.dataset.totalBytes),
      build: size.dataset.buildOutputBytes === undefined ? null : Number(size.dataset.buildOutputBytes),
      reclaimButton: !!row.querySelector(".worktree-reclaim-btn"),
    };
  `);
}

let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}${NEGATIVE ? "   NEGATIVE CONTROL (flag switched off)" : ""}`);
  makeRepo();
  log(`  throwaway repo: ${repo}`);

  // ── run 1: fresh install, flag on ────────────────────────────────
  log("step 1: fresh launch, complete onboarding, quit");
  app = await launch(1, { first: true });
  await completeOnboarding(app.bridge);
  await quit(app);
  if (NEGATIVE) {
    // On by default since 2.0: the negative control switches it off.
    log("step 2: NEGATIVE CONTROL — switching the diskGuard flag off");
    enableDiskGuardFlag(app.dataDir, false);
  } else {
    log("step 2: turn the diskGuard flag on (settings, app closed)");
    enableDiskGuardFlag(app.dataDir);
  }
  const base = join(app.dataDir, "hermes-worktrees");

  // ── run 2: 4.2 GB free -> refused, nothing created ───────────────
  log(`step 3: relaunch with the disk reporting ${LOW_FREE} bytes free`);
  app = await launch(2, { freeBytes: LOW_FREE });
  await waitForReturningLaunch(app.bridge);
  const flags = await app.bridge.eval(`
    const raw = await window.__TAURI_INTERNALS__.invoke("get_settings");
    return raw.feature_flag_overrides ?? null;
  `);
  log(`  feature_flag_overrides seen by the app: ${flags}`);
  // Listen for the inbox-ready event the way the app's own listeners do.
  await app.bridge.eval(`
    window.__n14Inbox = [];
    const internals = window.__TAURI_INTERNALS__;
    await internals.invoke("plugin:event|listen", {
      event: "hermes-inbox-item",
      target: { kind: "Any" },
      handler: internals.transformCallback((event) => window.__n14Inbox.push(event.payload)),
    });
    return true;
  `);

  log(`step 4: create a session on the new branch "${REFUSED_BRANCH}"`);
  await createSessionOnNewBranch(app.bridge, REFUSED_BRANCH, "01");
  const toast = await app.bridge.waitFor("the refusal to be shown", `
    const t = e2e.all(".toast-message").map((el) => e2e.norm(el.innerText)).find((s) => s.includes("disk space"));
    return t || null;
  `, { timeoutMs: 15_000 });
  log(`  toast: "${toast}"`);
  assert(toast.includes("Not enough free disk space"), "the toast says why: not enough free disk space");
  assert(toast.includes(`${gbText(LOW_FREE)} free`) && toast.includes("10.0 GB needed"), "the toast gives the free space and what is needed");
  assert(toast.startsWith("Session was not created"), "the toast says the session was not created");
  await app.bridge.screenshot(join(evidenceDir, "02-refused-toast.png"));

  await sleep(800); // anything created late would show up by now
  assert((await app.bridge.eval(`return e2e.all(".session-item").length;`)) === 0, "no session in the session list");
  const listed = await app.bridge.eval(`return await window.__TAURI_INTERNALS__.invoke("git_list_all_worktrees");`);
  assert(listed.length === 0, "the app records no worktree");
  const folders = worktreeFolders(base);
  log(`  worktree folders on disk: ${JSON.stringify(folders)}`);
  assert(folders.length === 0, "no worktree folder was created");
  assert(git(repo, ["branch", "--list", REFUSED_BRANCH]).trim() === "", `no branch "${REFUSED_BRANCH}" was created`);
  const inbox = await app.bridge.eval(`return window.__n14Inbox;`);
  log(`  inbox events: ${JSON.stringify(inbox)}`);
  assert(inbox.length === 1, "one inbox-ready event was raised");
  assert(inbox[0].kind === "disk_low" && inbox[0].section === "blocked", "it is a blocked disk_low item");
  assert(inbox[0].freeBytes === Number(LOW_FREE) && inbox[0].requiredBytes === 10_000_000_000, "it carries the numbers");
  await quit(app);
  const afterRefusal = dbCounts(app.dataDir);
  log(`  database after quit: ${JSON.stringify(afterRefusal)}`);
  assert(afterRefusal.sessions === 0 && afterRefusal.worktrees === 0, "the database holds no session and no worktree record");

  // ── run 3: 50 GB free -> created; usage, build output, orphans ───
  log(`step 5: relaunch with the disk reporting ${ROOMY_FREE} bytes free`);
  app = await launch(3, { freeBytes: ROOMY_FREE });
  await waitForReturningLaunch(app.bridge);
  log(`step 6: the same journey on the new branch "${TASK_BRANCH}" now creates the session`);
  await createSessionOnNewBranch(app.bridge, TASK_BRANCH, "03");
  await app.bridge.waitFor("the session to show in the session list", `return e2e.all(".session-item").length === 1;`, {
    timeoutMs: 20_000,
  });
  const created = await app.bridge.eval(`return await window.__TAURI_INTERNALS__.invoke("git_list_all_worktrees");`);
  assert(created.length === 1 && created[0].branch_name === TASK_BRANCH, `one worktree on "${TASK_BRANCH}"`);
  const wtPath = created[0].worktree_path;
  log(`  worktree: ${wtPath}`);
  assert(existsSync(join(wtPath, "src", "index.js")), "the worktree is checked out on disk");
  assert(git(repo, ["branch", "--list", TASK_BRANCH]).includes(TASK_BRANCH), `branch "${TASK_BRANCH}" exists`);

  log("step 7: build output appears in the worktree; two orphaned folders appear");
  writeBytes(join(wtPath, "node_modules", "left-pad", "index.js"), 2_000_000);
  writeBytes(join(wtPath, "packages", "web", "node_modules", "react", "index.js"), 1_000_000);
  writeBytes(join(wtPath, "target", "debug", "app.bin"), 1_500_000);
  writeBytes(join(wtPath, "dist", "bundle.js"), 500_000);
  const BUILD_BYTES = 5_000_000;
  const orphanA = join(dirname(wtPath), `deadbeef_${ORPHAN_BRANCH}`);
  git(repo, ["worktree", "add", "-q", "-b", ORPHAN_BRANCH, orphanA]);
  writeBytes(join(orphanA, "node_modules", "x.bin"), 1_000_000);
  const goneRepoDir = join(base, "00000000deadbeef");
  const orphanB = join(goneRepoDir, "cafebabe_old-task");
  writeBytes(join(orphanB, "notes.bin"), 500_000);
  writeFileSync(join(goneRepoDir, "repo_path.txt"), join(workDir, "deleted-repo"));

  log("step 8: open Git panel > Worktrees (the Review Desk's Worktrees tab when the desk replaces the panel)");
  if (await app.bridge.exists('.session-subview-btn[title="Review Desk"]')) {
    await app.bridge.click('.session-subview-btn[title="Review Desk"]');
    await app.bridge.waitFor("the Review Desk", `return !!e2e.first(".review-desk");`);
    await app.bridge.clickByName("Worktrees", { within: ".review-desk" });
  } else {
    await app.bridge.click('.session-subview-btn[title="Git"]');
    await app.bridge.waitFor("the session Git panel", `return !!e2e.first(".session-git-panel");`);
    await app.bridge.clickByName("Worktrees", { within: ".session-git-panel" });
  }
  const freeText = await app.bridge.waitFor("the free-space line", `
    const el = e2e.first(".worktree-disk-status");
    return el ? e2e.norm(el.innerText) : null;
  `);
  assert(freeText === "Free disk space: 50.0 GB", `free space is shown ("${freeText}")`);

  const before = await app.bridge.waitFor("the worktree's disk use", `
    const row = e2e.all(".worktree-overview-entry").find((el) => el.dataset.worktreePath === ${JSON.stringify(wtPath)});
    const size = row?.querySelector(".worktree-overview-disk-size");
    return size && size.dataset.totalBytes && Number(size.dataset.buildOutputBytes) > 0 ? true : null;
  `, { timeoutMs: 20_000 }).then(() => rowUsage(app.bridge, wtPath));
  log(`  worktree row shows: ${JSON.stringify(before)}`);
  assert(before.build === BUILD_BYTES, "its build output (node_modules, target, dist) is measured exactly");
  assert(before.total >= BUILD_BYTES + 3_000, "its total includes the checked-out files");
  assert(/build output 5\.0 MB/.test(before.text), `the row shows the build output ("${before.text}")`);

  const orphanRows = await app.bridge.waitFor("both orphans to be listed with a size", `
    const rows = e2e.all(".worktree-overview-orphan").map((el) => ({
      path: el.dataset.worktreePath,
      size: el.querySelector(".worktree-overview-disk-size")?.dataset.totalBytes || null,
    }));
    return rows.length === 2 && rows.every((r) => r.size) ? rows : null;
  `, { timeoutMs: 20_000 });
  log(`  orphans listed: ${JSON.stringify(orphanRows)}`);
  const orphanNames = orphanRows.map((r) => basename(r.path)).sort();
  assert(
    JSON.stringify(orphanNames) === JSON.stringify([basename(orphanB), basename(orphanA)].sort()),
    "exactly the two orphaned folders are listed (the session's own worktree is not)",
  );
  await app.bridge.screenshot(join(evidenceDir, "04-worktrees-view.png"));

  log("step 9: Remove build output");
  await app.bridge.clickWhenReady(`
    const row = e2e.all(".worktree-overview-entry").find((el) => el.dataset.worktreePath === ${JSON.stringify(wtPath)});
    return e2e.click(e2e.must(row?.querySelector(".worktree-reclaim-btn"), "Remove build output"));
  `);
  const note = await app.bridge.waitFor("the removal note", `
    const el = e2e.first(".worktree-reclaim-note");
    return el ? e2e.norm(el.innerText) : null;
  `, { timeoutMs: 20_000 });
  log(`  note: "${note}"`);
  assert(/freed 5\.0 MB/.test(note), "the note says 5.0 MB was freed");
  await app.bridge.waitFor("the row to show the new size", `
    const row = e2e.all(".worktree-overview-entry").find((el) => el.dataset.worktreePath === ${JSON.stringify(wtPath)});
    const size = row?.querySelector(".worktree-overview-disk-size");
    return size && size.dataset.buildOutputBytes === "0";
  `);
  const after = await rowUsage(app.bridge, wtPath);
  log(`  worktree row now shows: ${JSON.stringify(after)}`);
  const dropped = before.total - after.total;
  assert(
    dropped >= BUILD_BYTES && dropped < BUILD_BYTES + 10_000,
    `the size shown dropped by the build output (${dropped} bytes)`,
  );
  assert(!after.reclaimButton, "nothing left to remove");
  for (const gone of ["node_modules", join("packages", "web", "node_modules"), "target", "dist"]) {
    assert(!existsSync(join(wtPath, gone)), `${gone} is gone from disk`);
  }
  assert(existsSync(join(wtPath, "docs", "dist", "keep.html")), "the committed docs/dist folder is kept");
  assert(existsSync(join(wtPath, "src", "index.js")), "source files are kept");
  await app.bridge.screenshot(join(evidenceDir, "05-build-output-removed.png"));

  log("step 10: Remove all orphans (one action, one confirmation)");
  await app.bridge.click(".worktree-sweep-btn");
  const confirmText = await app.bridge.waitFor("the confirmation", `
    const el = e2e.first(".worktree-overview-confirm");
    return el ? e2e.norm(el.innerText) : null;
  `);
  log(`  confirmation: "${confirmText}"`);
  assert(/Clean up 2 orphans \(1\.5 MB\)/.test(confirmText), "it asks once, for both orphans and their size");
  await app.bridge.screenshot(join(evidenceDir, "06-sweep-confirm.png"));
  await app.bridge.click(".worktree-overview-confirm-yes");
  await app.bridge.waitFor("the orphans to leave the list", `return e2e.all(".worktree-overview-orphan").length === 0;`, {
    timeoutMs: 20_000,
  });
  assert(!existsSync(orphanA), "the orphan registered with git is gone from disk");
  assert(!existsSync(goneRepoDir), "the folder of the deleted repo is gone entirely");
  const gitList = git(repo, ["worktree", "list", "--porcelain"]);
  assert(!gitList.includes(basename(orphanA)), "git no longer lists the orphaned worktree");
  assert(existsSync(join(wtPath, "src", "index.js")), "the session's own worktree is untouched");
  assert((await app.bridge.eval(`return e2e.all(".session-item").length;`)) === 1, "the session is still there");
  await app.bridge.screenshot(join(evidenceDir, "07-orphans-removed.png"));
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
          buttons: e2e.all("button").map(e2e.nameOf).slice(0, 40),
        };
      `);
      log(`  what the app showed: ${JSON.stringify(dump)}`);
    }
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  if (app?.isRunning()) {
    log("step 11: quit the app");
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
