#!/usr/bin/env node
// Scenario: F09 — honest isolation, on the REAL app, with a throwaway git
// repository and plain shell sessions (no agent account needed).
//
//   run 1  fresh install: welcome screens; turn the honestIsolation flag on
//          (flags are read at startup), quit
//   run 2  - task A and task B, each created through the New Session wizard
//            with the default branch: each gets its OWN hermes/<slug> branch
//            and its own worktree folder; the terminal shows that branch
//          - task C asks for `main`, which the project folder has checked
//            out: a blocking "Branch In Use" choice appears.
//              Cancel          -> no session, no worktree
//              Use new branch  -> main-2 in a worktree of its own
//              Reuse           -> the session works in the project folder,
//                                 recorded as such (nothing new on disk)
//          - task E asks for task A's branch and reuses A's worktree on
//            purpose; with uncommitted work in it, closing E asks nothing
//            and leaves A's worktree, its files and its link alone
//          - task B gets a new file; closing it offers "Commit to session
//            branch & close" and "Archive (keep branch)" (no Stash & Close);
//            commit: the file is committed on B's branch, B's folder is
//            gone, the branch stays, `git stash list` is unchanged
//          - main-2 gets a new file; Archive: the work lands on a
//            hermes-archive/ branch, main-2 itself is unchanged, stash
//            unchanged
//          quit with task A still open
//   run 3  task A comes back with the SAME session id, still linked to its
//          worktree, and its terminal is on its hermes/ branch again
//
// Negative control: HERMES_E2E_F09_FLAG=off leaves the flag off, so task A
// lands on the current branch (no hermes/ branch) and the scenario must end
// in RESULT: FAIL.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F09-honest-isolation.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/F09-honest-isolation.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "F09-honest-isolation";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);
const FLAG_ON = (process.env.HERMES_E2E_F09_FLAG || "on") !== "off";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

// ── A throwaway repository (synthetic identity, never the real one) ──
// The long form of the path: on Windows the temp folder can come back as an
// 8.3 short name (a segment like RUNNER~1) that the app spells out in full.
const workDir = realpathSync.native(mkdtempSync(join(tmpdir(), "hermes-e2e-f09-")));
const repo = join(workDir, "f09-repo");
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Hermes Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Hermes Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { env: gitEnv, encoding: "utf8" }).trim();
execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
git("config", "user.name", "Hermes Test");
git("config", "user.email", "test@example.com");
git("config", "commit.gpgsign", "false");
writeFileSync(join(repo, "README.md"), "# f09\n");
git("add", ".");
git("commit", "-q", "-m", "initial");
// One entry already on the stash, so "the stash is unchanged" is a real
// check: a close that stashed would add a second one.
writeFileSync(join(repo, "README.md"), "# f09 (stashed edit)\n");
git("stash", "push", "-q", "-m", "f09 pre-existing entry");

/** { path, branch } for every checkout git knows about. */
function worktrees() {
  const out = git("worktree", "list", "--porcelain");
  const list = [];
  let cur = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) list.push((cur = { path: line.slice(9), branch: null }));
    else if (line.startsWith("branch ") && cur) cur.branch = line.slice(7).replace("refs/heads/", "");
  }
  return list;
}
const samePath = (a, b) => {
  const norm = (p) => {
    try { p = realpathSync.native(p); } catch { /* gone */ }
    return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  };
  return norm(a) === norm(b);
};

// Windows keeps app data under %APPDATA%, which a private HOME does not move.
const onWindows = platform() === "win32";
const homeDir = onWindows ? undefined : mkdtempSync(join(tmpdir(), "hermes-e2e-f09-home-"));
function launch(run, { first = false } = {}) {
  const runDir = join(evidenceDir, `run-${run}`);
  return onWindows
    ? launchApp({ runDir, log, home: "real", resetData: first })
    : launchApp({ runDir, log, home: "private", homeDir });
}

async function dismissWhatsNew(bridge) {
  await sleep(300);
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
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
    return true;
  `);
  await bridge.waitFor("the Finish button", `const b = e2e.first(".onboarding-actions .onboarding-btn-primary"); return !!b && !b.disabled;`);
  await bridge.click(".onboarding-actions .onboarding-btn-primary");
  await bridge.waitFor("the welcome dialog to close", `return !e2e.first(".onboarding-backdrop");`);
  await dismissWhatsNew(bridge);
}

async function waitForReturningLaunch(bridge) {
  await bridge.waitFor("the app UI (returning launch)", `return !!e2e.first(".topbar") && !e2e.first(".onboarding-backdrop");`);
  await dismissWhatsNew(bridge);
}

async function quit(current) {
  const exit = await current.stop({ keepFiles: false });
  log(`  app exited: ${JSON.stringify(exit)}`);
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");
}

/** Set a controlled input's value the way typing does (React sees `input`). */
const setInput = (selector, value) => `
  const el = e2e.must(e2e.first(${JSON.stringify(selector)}), ${JSON.stringify(selector)});
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  el.focus();
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return el.value;
`;

const invoke = (bridge, cmd, args) =>
  bridge.eval(`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})});`);

/** The primary button of whatever wizard step is showing. */
const PRIMARY = ".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary";
async function clickPrimary(bridge, what) {
  const r = await bridge.clickWhenReady(`
    const b = e2e.must(e2e.first(${JSON.stringify(PRIMARY)}), "the wizard's primary button");
    return e2e.click(b);
  `);
  log(`  wizard ${what}: clicked "${r.clicked}"`);
  await sleep(300);
}

/**
 * Walk the New Session wizard for a plain shell in the test repo.
 * `pickBranch`: null = keep the default; "main" etc = pick that existing branch.
 * Returns once the branch-step choice is made and Create was clicked.
 */
async function startTask(bridge, { label, pickBranch = null }) {
  await bridge.click(".activity-bar-action");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator .session-creator-mode-step");`, { timeoutMs: 20_000 });
  await bridge.click('.session-creator-mode-card[data-category="universal"]');
  await clickPrimary(bridge, "mode");
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`);
  await bridge.clickWhenReady(`
    const cards = e2e.all(".session-creator-provider-card");
    return e2e.click(e2e.must(cards[cards.length - 1], "plain shell card"));
  `);
  await clickPrimary(bridge, "agent");

  // Folder step: the test repo (added by path the first time, then listed).
  await bridge.waitFor("the folder step", `return !!e2e.first(".workspace-scan-input");`);
  const listed = await bridge.eval(`
    const row = e2e.all(".project-picker-item").find((el) => el.innerText.includes("f09-repo"));
    if (!row) return false;
    if (!row.classList.contains("project-picker-item-attached")) e2e.click(row);
    return true;
  `);
  if (!listed) {
    await bridge.eval(setInput(".workspace-scan-input", repo));
    await bridge.clickByName("Scan", { within: ".project-picker-footer" });
  }
  await bridge.waitFor("the test repo to be selected", `
    return e2e.all(".project-picker-item.project-picker-item-attached").some((el) => el.innerText.includes("f09-repo"));
  `);
  await clickPrimary(bridge, "folder");

  // Branch step.
  await bridge.waitFor("the branch step", `return !!e2e.first(".session-creator-branch-multi");`, { timeoutMs: 20_000 });
  await bridge.waitFor("a default branch to be chosen", `return !!e2e.first(".session-creator-branch-selected-label");`);
  const defaultChoice = await bridge.text(".session-creator-branch-selected-label");
  log(`  default branch offered: "${defaultChoice.trim()}"`);
  if (pickBranch) {
    if (!(await bridge.exists(".branch-selector-body"))) await bridge.click(".session-creator-branch-project-header");
    await bridge.clickByName("Existing Branch", { within: ".branch-selector-tabs" });
    await bridge.clickWhenReady(`
      const row = e2e.all(".branch-selector-item").find((el) => e2e.norm(el.querySelector(".branch-selector-item-name")?.innerText) === ${JSON.stringify(pickBranch)});
      return e2e.click(e2e.must(row, "branch row ${pickBranch}"));
    `);
    await bridge.waitFor(`"${pickBranch}" to be chosen`, `
      return e2e.norm(e2e.first(".session-creator-branch-selected-label")?.innerText) === ${JSON.stringify(pickBranch)};
    `);
  }
  await clickPrimary(bridge, "branch");

  // Confirm step: name the session, then create it.
  await bridge.waitFor("the confirm step", `return !!e2e.first('input.command-palette-input[placeholder="Session name (optional)"]');`);
  await bridge.eval(setInput('input.command-palette-input[placeholder="Session name (optional)"]', label));
  await clickPrimary(bridge, "confirm");
  return defaultChoice.trim();
}

async function waitForNewSession(bridge, before, label) {
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  const id = await bridge.waitFor(`the terminal of "${label}"`, `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
    return ids.length === 1 ? ids[0] : null;
  `, { timeoutMs: 20_000 });
  await bridge.waitFor(`"${label}" in the session list`, `
    return e2e.all(".session-item").some((el) => el.innerText.includes(${JSON.stringify(label)}));
  `);
  return id;
}

async function projectId(bridge) {
  const projects = await invoke(bridge, "get_registered_projects");
  const p = projects.find((x) => samePath(x.path, repo));
  if (!p) throw new Error("the test repo is not a project");
  return p.id;
}

async function worktreeOf(bridge, sessionId, pid) {
  return invoke(bridge, "git_session_worktree_info", { sessionId, projectId: pid });
}

/** Type a command and wait for an output line matching `pattern`. */
async function runInTerminal(bridge, sessionId, command, pattern, timeoutMs = 20_000) {
  await bridge.waitFor("the shell prompt", `
    const lines = window.__HERMES_E2E__.readTerminal(${JSON.stringify(sessionId)}) || [];
    const info = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(sessionId)});
    return info && info.opened && lines.some((l) => l.trim().length > 0);
  `, { timeoutMs: 30_000 });
  await sleep(800);
  // A restored terminal shows its old scrollback: only count NEW output.
  const matching = (lines) => (lines ?? []).filter((l) => pattern.test(l.trim()));
  const seen = matching(await bridge.readTerminal(sessionId)).length;
  await bridge.typeInTerminal(sessionId, `${command}\n`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hits = matching(await bridge.readTerminal(sessionId));
    if (hits.length > seen) return hits[hits.length - 1].trim();
    if (Date.now() > deadline) throw new Error(`no new line matching ${pattern} after typing "${command}"`);
    await sleep(100);
  }
}

async function closeSessionByLabel(bridge, label) {
  await bridge.clickWhenReady(`
    const item = e2e.all(".session-item").find((el) => el.innerText.includes(${JSON.stringify(label)}));
    const btn = e2e.must(item && item.querySelector(".session-item-close"), "close button of ${label}");
    return e2e.click(btn);
  `);
}

async function confirmCloseIfAsked(bridge) {
  await sleep(400);
  if (await bridge.exists(".close-dialog")) await bridge.click(".close-dialog .close-dialog-btn-confirm");
}

async function waitSessionGone(bridge, label) {
  await bridge.waitFor(`"${label}" to leave the session list`, `
    return !e2e.all(".session-item").some((el) => el.innerText.includes(${JSON.stringify(label)}) && !el.classList.contains("session-item-destroyed"));
  `, { timeoutMs: 20_000 });
}

let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   flag: ${FLAG_ON ? "on" : "OFF (negative control)"}`);
  log(`test repo: ${repo}`);

  // ── run 1: onboarding, flag on ──────────────────────────────────
  log("step 1: fresh launch; turn the honestIsolation flag on (read at next start)");
  app = await launch(1, { first: true });
  await completeOnboarding(app.bridge);
  if (FLAG_ON) {
    await invoke(app.bridge, "set_setting", { key: "feature_flag_overrides", value: JSON.stringify({ honestIsolation: true }) });
  }
  await quit(app);

  // ── run 2 ───────────────────────────────────────────────────────
  app = await launch(2);
  const { bridge } = app;
  await waitForReturningLaunch(bridge);
  const stashBefore = git("stash", "list");
  assert(stashBefore.split("\n").length === 1, `the stash starts with one entry (${stashBefore})`);

  log("step 2: task A with the default branch");
  let before = await bridge.terminalIds();
  const offeredA = await startTask(bridge, { label: "F09 task A" });
  const idA = await waitForNewSession(bridge, before, "F09 task A");
  const pid = await projectId(bridge);
  const wtA = await worktreeOf(bridge, idA, pid);
  log(`  task A: session ${idA}, worktree ${JSON.stringify(wtA)}`);
  assert(/^hermes\/task-[a-z2-9]{4} \(new\)$/.test(offeredA), `the wizard offered a new hermes/<slug> branch ("${offeredA}")`);
  assert(wtA && /^hermes\/task-/.test(wtA.branchName), `task A is on its own branch ${wtA?.branchName}`);
  assert(wtA.worktreePath.replace(/\\/g, "/").includes("hermes-worktrees/"), "task A has its own worktree folder");
  assert(!/[\\/]\.hermes[\\/]worktrees/.test(wtA.worktreePath), "the worktree folder is not under .hermes/worktrees");
  const shownA = await runInTerminal(bridge, idA, "git branch --show-current", /^hermes\/task-/);
  assert(shownA === wtA.branchName, `task A's terminal is on ${shownA}`);
  await bridge.screenshot(join(evidenceDir, "01-task-a.png"));

  log("step 3: task B with the default branch — never the same checkout as A");
  before = await bridge.terminalIds();
  await startTask(bridge, { label: "F09 task B" });
  const idB = await waitForNewSession(bridge, before, "F09 task B");
  const wtB = await worktreeOf(bridge, idB, pid);
  log(`  task B: session ${idB}, worktree ${JSON.stringify(wtB)}`);
  assert(/^hermes\/task-/.test(wtB.branchName) && wtB.branchName !== wtA.branchName, `task B has a different branch (${wtB.branchName})`);
  assert(!samePath(wtA.worktreePath, wtB.worktreePath), "task A and task B do not share a checkout");
  const listAB = worktrees();
  log(`  git worktree list: ${JSON.stringify(listAB)}`);
  assert(listAB.length === 3, "git knows exactly three checkouts: the project folder, A and B");
  assert(new Set(listAB.map((w) => w.branch)).size === 3, "each checkout has its own branch");

  log("step 4: task C asks for main (checked out in the project folder) and cancels");
  before = await bridge.terminalIds();
  await startTask(bridge, { label: "F09 task C", pickBranch: "main" });
  await bridge.waitFor("the Branch In Use choice", `return !!e2e.first('.branch-conflict-modal[role="dialog"]');`, { timeoutMs: 20_000 });
  const conflictText = await bridge.text(".branch-conflict-modal");
  log(`  dialog: ${conflictText.replace(/\s+/g, " ").trim()}`);
  assert(/main/.test(conflictText) && /the project folder/.test(conflictText), "it names the branch and who has it");
  const choices = await bridge.eval(`return e2e.all(".branch-conflict-modal button").map(e2e.nameOf);`);
  assert(["Use new branch", "Reuse its checkout", "Cancel"].every((c) => choices.includes(c)), `it offers ${JSON.stringify(choices)}`);
  await bridge.screenshot(join(evidenceDir, "02-branch-in-use.png"));
  // Blocking: a click on the dimmed backdrop chooses nothing.
  await bridge.eval(`e2e.first(".branch-conflict-overlay").dispatchEvent(new MouseEvent("click", { bubbles: true })); return true;`);
  await sleep(300);
  assert(await bridge.exists(".branch-conflict-modal"), "clicking outside does not dismiss the choice");
  await bridge.clickByName("Cancel", { within: ".branch-conflict-actions" });
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator") && !e2e.first(".branch-conflict-modal");`, { timeoutMs: 20_000 });
  await sleep(500);
  assert((await bridge.terminalIds()).length === before.length, "Cancel: no session was created");
  assert(worktrees().length === 3, "Cancel: no worktree was created");

  log("step 5: task C again, this time 'Use new branch' (main-2)");
  before = await bridge.terminalIds();
  await startTask(bridge, { label: "F09 task C", pickBranch: "main" });
  await bridge.waitFor("the Branch In Use choice", `return !!e2e.first(".branch-conflict-modal");`, { timeoutMs: 20_000 });
  const suggested = await bridge.eval(`return e2e.first(".branch-conflict-create-input").value;`);
  assert(suggested === "main-2", `it suggests main-2 ("${suggested}")`);
  await bridge.clickByName("Use new branch", { within: ".branch-conflict-actions" });
  const idC = await waitForNewSession(bridge, before, "F09 task C");
  const wtC = await worktreeOf(bridge, idC, pid);
  log(`  task C: ${JSON.stringify(wtC)}`);
  assert(wtC.branchName === "main-2" && !wtC.isMainWorktree, "task C works on main-2 in a worktree of its own");
  assert(worktrees().length === 4, "git now has four checkouts, none shared");

  log("step 6: task D asks for main and chooses to reuse the project folder");
  before = await bridge.terminalIds();
  await startTask(bridge, { label: "F09 task D", pickBranch: "main" });
  await bridge.waitFor("the Branch In Use choice", `return !!e2e.first(".branch-conflict-modal");`, { timeoutMs: 20_000 });
  await bridge.clickByName("Reuse its checkout", { within: ".branch-conflict-actions" });
  const idD = await waitForNewSession(bridge, before, "F09 task D");
  const wtD = await worktreeOf(bridge, idD, pid);
  log(`  task D: ${JSON.stringify(wtD)}`);
  assert(wtD.isMainWorktree && samePath(wtD.worktreePath, repo), "task D is linked to the project folder, on purpose, as the main checkout");
  assert(worktrees().length === 4, "reusing created nothing on disk");
  await closeSessionByLabel(bridge, "F09 task D");
  await confirmCloseIfAsked(bridge);
  await waitSessionGone(bridge, "F09 task D");
  assert(existsSync(join(repo, "README.md")), "closing task D left the project folder alone");

  log("step 6b: task E reuses task A's worktree (not the project folder), then closes");
  // The picker greys out branches other sessions hold, so reach A's branch
  // through the Branch In Use choice: ask for main, then type A's branch
  // as the new name, which A has checked out.
  before = await bridge.terminalIds();
  await startTask(bridge, { label: "F09 task E", pickBranch: "main" });
  await bridge.waitFor("the Branch In Use choice", `return !!e2e.first(".branch-conflict-modal");`, { timeoutMs: 20_000 });
  await bridge.eval(setInput(".branch-conflict-create-input", wtA.branchName));
  await bridge.clickByName("Use new branch", { within: ".branch-conflict-actions" });
  await bridge.waitFor("a second Branch In Use choice naming task A", `
    const m = e2e.first(".branch-conflict-modal");
    return !!m && m.innerText.includes("F09 task A");
  `, { timeoutMs: 20_000 });
  await bridge.clickByName("Reuse its checkout", { within: ".branch-conflict-actions" });
  const idE = await waitForNewSession(bridge, before, "F09 task E");
  const wtE = await worktreeOf(bridge, idE, pid);
  const wtAShared = await worktreeOf(bridge, idA, pid);
  log(`  task E: ${JSON.stringify(wtE)}`);
  assert(!wtE.isMainWorktree && samePath(wtE.worktreePath, wtA.worktreePath), "task E is linked to task A's worktree, on purpose");
  assert(wtE.worktreePath === wtA.worktreePath, "both links record the checkout with the same path");
  assert(wtE.sharedWithOtherSessions === true && wtAShared.sharedWithOtherSessions === true, "both sessions know the checkout is shared");
  assert(worktrees().length === 4, "reusing task A's checkout created nothing on disk");
  // Uncommitted work in the shared checkout: closing E must neither ask
  // about it (it may be A's) nor delete it.
  const aWork = join(wtA.worktreePath, "f09-a-work.txt");
  writeFileSync(aWork, "task A's uncommitted work\n");
  await closeSessionByLabel(bridge, "F09 task E");
  await sleep(800);
  assert(!(await bridge.exists(".dirty-wt-modal")), "closing task E does not offer to commit, archive or discard the shared checkout's changes");
  await confirmCloseIfAsked(bridge);
  await waitSessionGone(bridge, "F09 task E");
  await sleep(1500);
  assert(existsSync(wtA.worktreePath) && existsSync(aWork), "task A's worktree and its uncommitted file are still there");
  assert(worktrees().some((w) => samePath(w.path, wtA.worktreePath)) && worktrees().length === 4, "git still has task A's worktree");
  const wtAAfter = await worktreeOf(bridge, idA, pid);
  assert(wtAAfter && samePath(wtAAfter.worktreePath, wtA.worktreePath) && wtAAfter.sharedWithOtherSessions === false,
    "task A is still linked to its worktree, now alone");
  rmSync(aWork);

  log("step 7: task B has a new file; close it and commit to its branch");
  writeFileSync(join(wtB.worktreePath, "f09-note.txt"), "work from task B\n");
  await closeSessionByLabel(bridge, "F09 task B");
  await bridge.waitFor("the Uncommitted Changes dialog", `return !!e2e.first(".dirty-wt-modal");`);
  const closeChoices = await bridge.eval(`return e2e.all(".dirty-wt-actions button").map(e2e.nameOf);`);
  log(`  close choices: ${JSON.stringify(closeChoices)}`);
  assert(closeChoices.includes("Commit to session branch & close"), "it offers Commit to session branch & close");
  assert(closeChoices.includes("Archive (keep branch)"), "it offers Archive (keep branch)");
  assert(!closeChoices.some((c) => /stash/i.test(c)), "Stash & Close is gone");
  await bridge.screenshot(join(evidenceDir, "03-close-dirty.png"));
  await bridge.clickByName("Commit to session branch & close", { within: ".dirty-wt-actions" });
  await confirmCloseIfAsked(bridge);
  await waitSessionGone(bridge, "F09 task B");
  for (let i = 0; i < 50 && existsSync(wtB.worktreePath); i++) await sleep(200);
  assert(!existsSync(wtB.worktreePath), "task B's worktree folder is gone");
  const committed = git("show", "--name-only", "--format=%s", wtB.branchName);
  log(`  ${wtB.branchName}: ${committed.replace(/\n/g, " | ")}`);
  assert(committed.includes("f09-note.txt"), `the file is committed on ${wtB.branchName}`);
  assert(git("stash", "list") === stashBefore, "git stash list is unchanged");

  log("step 8: task C has a new file; close it and archive");
  const mainTwoBefore = git("rev-parse", "main-2");
  writeFileSync(join(wtC.worktreePath, "f09-archived.txt"), "work from task C\n");
  await closeSessionByLabel(bridge, "F09 task C");
  await bridge.waitFor("the Uncommitted Changes dialog", `return !!e2e.first(".dirty-wt-modal");`);
  await bridge.clickByName("Archive (keep branch)", { within: ".dirty-wt-actions" });
  await confirmCloseIfAsked(bridge);
  await waitSessionGone(bridge, "F09 task C");
  const archived = git("branch", "--list", "hermes-archive/*");
  log(`  archive branches: ${archived}`);
  assert(/hermes-archive\/main-2/.test(archived), "the work is on a hermes-archive/main-2 branch");
  assert(git("show", "--name-only", "--format=", "hermes-archive/main-2").includes("f09-archived.txt"), "the archive branch has the file");
  assert(git("rev-parse", "main-2") === mainTwoBefore, "main-2 itself is unchanged");
  assert(git("stash", "list") === stashBefore, "git stash list is still unchanged");
  await bridge.screenshot(join(evidenceDir, "04-after-close.png"));

  log("step 9: quit with task A open (wait until the workspace is saved)");
  await bridge.waitFor("the workspace (with task A) to be saved", `
    const s = await window.__TAURI_INTERNALS__.invoke("get_settings");
    return !!s.saved_workspace && s.saved_workspace.includes(${JSON.stringify(idA)}) && !s.saved_workspace.includes(${JSON.stringify(idB)});
  `, { timeoutMs: 40_000, intervalMs: 500 });
  await quit(app);

  // ── run 3: restore ──────────────────────────────────────────────
  log("step 10: relaunch — task A comes back with the same id and its worktree");
  app = await launch(3);
  await waitForReturningLaunch(app.bridge);
  await app.bridge.waitFor("task A to be restored", `
    return e2e.all(".session-item").some((el) => el.innerText.includes("F09 task A"));
  `, { timeoutMs: 30_000 });
  const ids = await app.bridge.terminalIds();
  log(`  terminals after restore: ${JSON.stringify(ids)}`);
  assert(ids.includes(idA), `task A kept its session id (${idA})`);
  const wtA2 = await worktreeOf(app.bridge, idA, pid);
  assert(wtA2 && samePath(wtA2.worktreePath, wtA.worktreePath), "task A is still linked to its worktree");
  const shownA2 = await runInTerminal(app.bridge, idA, "git branch --show-current", /^hermes\/task-/);
  assert(shownA2 === wtA.branchName, `the restored terminal is on ${shownA2}`);
  await app.bridge.screenshot(join(evidenceDir, "05-restored.png"));
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      const dump = await app.bridge.eval(`
        return {
          buttons: e2e.all("button").map(e2e.nameOf).slice(0, 40),
          dialogs: [...document.querySelectorAll('[class*="backdrop"],[class*="overlay"],[role="dialog"]')].map((e) => e.className),
        };
      `);
      log(`  what the app showed: ${JSON.stringify(dump)}`);
    }
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  if (app?.isRunning()) {
    log("finally: quit the app");
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
    if (!failed && (exit.forced || exit.code !== 0)) {
      failed = true;
      log("FAILED: the app did not quit cleanly");
    }
  }
  try {
    log(`final git worktree list: ${JSON.stringify(worktrees())}`);
  } catch { /* repo may be gone */ }
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
