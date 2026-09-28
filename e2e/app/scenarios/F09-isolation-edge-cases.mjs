#!/usr/bin/env node
// Scenario: F09 — honest isolation, the edge cases, on the REAL app with a
// throwaway git repository and plain shell sessions (no agent account).
//
//   run 1  fresh install: welcome screens; turn the honestIsolation flag on
//          (flags are read at startup), quit
//   run 2  A. task A gets its own hermes/<slug> worktree. Task E asks for
//             A's branch and reuses A's worktree on purpose. With an
//             uncommitted file in that worktree, closing E shows no
//             Uncommitted Changes dialog (nothing offers to commit or
//             discard A's work), and A's folder, file and link survive.
//             Control: closing A itself, with that same file, DOES show the
//             dialog — so "no dialog" above is a real check.
//          B. a checkout made OUTSIDE Hermes (`git worktree add` by hand)
//             has branch `external-branch`. Task X asks for that branch: the
//             Branch In Use choice names that checkout's folder. Reuse it,
//             put an uncommitted file there, close X: no dialog, no
//             "failed to clean up / retried on next startup" warning, the
//             folder, its file and git's record of it are untouched.
//             Then the same with a checkout of ANOTHER Hermes instance (a
//             folder under some other hermes-worktrees/): task Y reuses
//             it, and closing Y asks nothing and removes nothing.
//          C. task R gets its own worktree; quit with R open
//   run 3  R's worktree folder was deleted meanwhile (by hand). R is
//          restored anyway: its worktree is recreated on its branch, a
//          message says so, and its terminal answers (never stuck at
//          "starting"). Quit; delete the folder AND the branch.
//   run 4  R is restored in the project folder instead, a message says so,
//          and its terminal answers.
//
// Negative controls (each must end in RESULT: FAIL):
//   HERMES_E2E_ISOLATION_FIXES=off  test builds only: the app behaves as
//                                   before these fixes (an external checkout
//                                   is treated as the session's own; a
//                                   missing folder is not recovered)
//   HERMES_E2E_F09_FLAG=off         the honestIsolation flag stays off, so
//                                   no Branch In Use choice is shown
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F09-isolation-edge-cases.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/F09-isolation-edge-cases.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "F09-isolation-edge-cases";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);
const FLAG_ON = (process.env.HERMES_E2E_F09_FLAG || "on") !== "off";
const FIXES = process.env.HERMES_E2E_ISOLATION_FIXES || "on";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

// ── A throwaway repository (synthetic identity, never the real one) ──
// The long form of the path: on Windows the temp folder can come back as an
// 8.3 short name that the app spells out in full.
const workDir = realpathSync.native(mkdtempSync(join(tmpdir(), "hermes-e2e-f09e-")));
const repo = join(workDir, "f09e-repo");
const externalWt = join(workDir, "f09e-external-wt");
// What another Hermes instance's worktree looks like: under a
// hermes-worktrees/ folder that is not this instance's.
const foreignWt = join(workDir, "other-hermes", "hermes-worktrees", "abc123", "s9_foreign-branch");
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
writeFileSync(join(repo, "README.md"), "# f09 edge cases\n");
git("add", ".");
git("commit", "-q", "-m", "initial");
// A checkout made outside Hermes, the way a developer or another tool does it.
git("worktree", "add", "-q", "-b", "external-branch", externalWt);
writeFileSync(join(externalWt, "external-committed.txt"), "made outside Hermes\n");
execFileSync("git", ["-C", externalWt, "add", "."], { env: gitEnv });
execFileSync("git", ["-C", externalWt, "commit", "-q", "-m", "external work"], { env: gitEnv });
git("worktree", "add", "-q", "-b", "foreign-branch", foreignWt);

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
const norm = (p) => {
  try { p = realpathSync.native(p); } catch { /* gone */ }
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
};
const samePath = (a, b) => norm(a) === norm(b);

// Windows keeps app data under %APPDATA%, which a private HOME does not move.
const onWindows = platform() === "win32";
const homeDir = onWindows ? undefined : mkdtempSync(join(tmpdir(), "hermes-e2e-f09e-home-"));
function launch(run, { first = false } = {}) {
  const runDir = join(evidenceDir, `run-${run}`);
  const env = { HERMES_E2E_ISOLATION_FIXES: FIXES };
  return onWindows
    ? launchApp({ runDir, log, home: "real", resetData: first, env })
    : launchApp({ runDir, log, home: "private", homeDir, env });
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

/** Text of every toast on screen right now. */
const toasts = (bridge) => bridge.eval(`return e2e.all(".toast .toast-message").map((el) => el.innerText);`);

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
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`);
  await bridge.clickWhenReady(`
    const cards = e2e.all(".session-creator-provider-card");
    return e2e.click(e2e.must(cards[cards.length - 1], "plain shell card"));
  `);
  await clickPrimary(bridge, "agent");

  // Folder step: the test repo (added by path the first time, then listed).
  await bridge.waitFor("the folder step", `return !!e2e.first(".workspace-scan-input");`);
  const listed = await bridge.eval(`
    const row = e2e.all(".project-picker-item").find((el) => el.innerText.includes("f09e-repo"));
    if (!row) return false;
    if (!row.classList.contains("project-picker-item-attached")) e2e.click(row);
    return true;
  `);
  if (!listed) {
    await bridge.eval(setInput(".workspace-scan-input", repo));
    await bridge.clickByName("Scan", { within: ".project-picker-footer" });
  }
  await bridge.waitFor("the test repo to be selected", `
    return e2e.all(".project-picker-item.project-picker-item-attached").some((el) => el.innerText.includes("f09e-repo"));
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

/** The sessions sidebar folds away once the last session is closed; open it again. */
async function showSessionsPanel(bridge) {
  await bridge.clickWhenReady(`
    const tab = e2e.must(e2e.all(".activity-bar-tab").find((b) => /SESSIONS/i.test(b.innerText)), "the SESSIONS tab");
    if (tab.classList.contains("activity-bar-tab-active")) return "open";
    return e2e.click(tab);
  `);
}

async function waitForSessionListed(bridge, label, timeoutMs = 15_000) {
  await showSessionsPanel(bridge);
  await bridge.waitFor(`"${label}" in the session list`, `
    return e2e.all(".session-item").some((el) => el.innerText.includes(${JSON.stringify(label)}));
  `, { timeoutMs });
}

async function waitForNewSession(bridge, before, label) {
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  const id = await bridge.waitFor(`the terminal of "${label}"`, `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
    return ids.length === 1 ? ids[0] : null;
  `, { timeoutMs: 20_000 });
  await waitForSessionListed(bridge, label);
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

/** The status word the session list shows for a session ("starting", "ready", ...). */
const statusOf = (bridge, label) => bridge.eval(`
  const item = e2e.all(".session-item").find((el) => el.innerText.includes(${JSON.stringify(label)}));
  return item ? item.innerText : null;
`);

/** Ask for `branch` through the Branch In Use choice and reuse the checkout that has it. */
async function reuseCheckoutOf(bridge, { label, branch, viaNewName = false }) {
  const before = await bridge.terminalIds();
  if (viaNewName) {
    // The picker greys out branches other sessions hold, so reach the branch
    // through the Branch In Use choice: ask for main, then type the branch as
    // the new name, which is also in use.
    await startTask(bridge, { label, pickBranch: "main" });
    await bridge.waitFor("the Branch In Use choice", `return !!e2e.first(".branch-conflict-modal");`, { timeoutMs: 20_000 });
    await bridge.eval(setInput(".branch-conflict-create-input", branch));
    await bridge.clickByName("Use new branch", { within: ".branch-conflict-actions" });
    await bridge.waitFor(`a Branch In Use choice for ${branch}`, `
      const m = e2e.first(".branch-conflict-modal");
      return !!m && m.innerText.includes(${JSON.stringify(branch)});
    `, { timeoutMs: 20_000 });
  } else {
    await startTask(bridge, { label, pickBranch: branch });
    await bridge.waitFor("the Branch In Use choice", `return !!e2e.first('.branch-conflict-modal[role="dialog"]');`, { timeoutMs: 20_000 });
  }
  const text = (await bridge.text(".branch-conflict-modal")).replace(/\s+/g, " ").trim();
  const shownPath = await bridge.text(".branch-conflict-path");
  log(`  dialog: ${text}`);
  await bridge.clickByName("Reuse its checkout", { within: ".branch-conflict-actions" });
  const id = await waitForNewSession(bridge, before, label);
  return { id, text, shownPath: (shownPath ?? "").trim() };
}

let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   flag: ${FLAG_ON ? "on" : "OFF (negative control)"}   fixes: ${FIXES}`);
  log(`test repo: ${repo}`);
  log(`external checkout: ${externalWt}`);

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
  const checkoutsAtStart = worktrees().length;
  assert(checkoutsAtStart === 3, "git starts with three checkouts: the project folder, the external one and another instance's");

  // A ─────────────────────────────────────────────────────────────
  log("step 2 (A): task A with the default branch");
  let before = await bridge.terminalIds();
  await startTask(bridge, { label: "F09 task A" });
  const idA = await waitForNewSession(bridge, before, "F09 task A");
  const pid = await projectId(bridge);
  const wtA = await worktreeOf(bridge, idA, pid);
  log(`  task A: session ${idA}, worktree ${JSON.stringify(wtA)}`);
  assert(wtA && /^hermes\/task-/.test(wtA.branchName) && wtA.ownedBySession === true, `task A owns its worktree on ${wtA?.branchName}`);

  log("step 3 (A): task E reuses task A's worktree on purpose; A has uncommitted work; close E");
  const reuseA = await reuseCheckoutOf(bridge, { label: "F09 task E", branch: wtA.branchName, viaNewName: true });
  assert(/F09 task A/.test(reuseA.text), "the choice named task A as the holder");
  const idE = reuseA.id;
  const wtE = await worktreeOf(bridge, idE, pid);
  log(`  task E: ${JSON.stringify(wtE)}`);
  assert(!wtE.isMainWorktree && samePath(wtE.worktreePath, wtA.worktreePath), "task E is linked to task A's worktree");
  assert(wtE.sharedWithOtherSessions === true && wtE.ownedBySession === false, "task E knows the checkout is shared, not its own");
  const aWork = join(wtA.worktreePath, "f09e-a-work.txt");
  writeFileSync(aWork, "task A's uncommitted work\n");
  await closeSessionByLabel(bridge, "F09 task E");
  await sleep(800);
  assert(!(await bridge.exists(".dirty-wt-modal")), "closing task E shows no Uncommitted Changes dialog for task A's work");
  await bridge.screenshot(join(evidenceDir, "01-close-e-no-dialog.png"));
  await confirmCloseIfAsked(bridge);
  await waitSessionGone(bridge, "F09 task E");
  await sleep(1500);
  assert(existsSync(wtA.worktreePath) && existsSync(aWork), "task A's worktree and its uncommitted file are still there");
  assert(worktrees().some((w) => samePath(w.path, wtA.worktreePath)), "git still has task A's worktree");
  const wtAAfter = await worktreeOf(bridge, idA, pid);
  assert(wtAAfter && samePath(wtAAfter.worktreePath, wtA.worktreePath) && wtAAfter.ownedBySession === true, "task A is still linked to its worktree, now alone");
  let toastText = (await toasts(bridge)).join(" | ");
  assert(!/clean up|retried on next startup/i.test(toastText), `no cleanup warning was shown (${JSON.stringify(toastText)})`);

  log("step 4 (A, control): closing task A itself, with that file, DOES ask");
  await closeSessionByLabel(bridge, "F09 task A");
  await bridge.waitFor("the Uncommitted Changes dialog", `return !!e2e.first(".dirty-wt-modal");`);
  const dialogText = (await bridge.text(".dirty-wt-modal")).replace(/\s+/g, " ");
  assert(/f09e-a-work\.txt/.test(dialogText), "the dialog lists task A's own file");
  await bridge.screenshot(join(evidenceDir, "02-close-a-asks.png"));
  await bridge.clickByName("Commit to session branch & close", { within: ".dirty-wt-actions" });
  await confirmCloseIfAsked(bridge);
  await waitSessionGone(bridge, "F09 task A");
  for (let i = 0; i < 50 && existsSync(wtA.worktreePath); i++) await sleep(200);
  assert(!existsSync(wtA.worktreePath), "task A's own worktree is removed once A is closed");
  assert(git("show", "--name-only", "--format=", wtA.branchName).includes("f09e-a-work.txt"), `the file was committed on ${wtA.branchName}`);

  // B ─────────────────────────────────────────────────────────────
  log("step 5 (B): task X asks for external-branch, checked out in a folder Hermes did not make");
  const reuseX = await reuseCheckoutOf(bridge, { label: "F09 task X", branch: "external-branch" });
  assert(/external-branch/.test(reuseX.text) && /a checkout outside Hermes/.test(reuseX.text), "the choice says the branch is held by a checkout outside Hermes");
  assert(samePath(reuseX.shownPath, externalWt), `the choice names that checkout's folder (${reuseX.shownPath})`);
  const idX = reuseX.id;
  const wtX = await worktreeOf(bridge, idX, pid);
  log(`  task X: ${JSON.stringify(wtX)}`);
  assert(wtX && !wtX.isMainWorktree && samePath(wtX.worktreePath, externalWt), "task X is linked to the external checkout");
  assert(worktrees().length === checkoutsAtStart, "reusing created nothing on disk");
  const shownX = await runInTerminal(bridge, idX, "git branch --show-current", /^external-branch$/);
  assert(shownX === "external-branch", "task X's terminal is on external-branch");
  await bridge.screenshot(join(evidenceDir, "03-task-x-external.png"));

  log("step 6 (B): uncommitted work in the external checkout; close X");
  const xWork = join(externalWt, "f09e-external-work.txt");
  writeFileSync(xWork, "work in a checkout Hermes did not make\n");
  await closeSessionByLabel(bridge, "F09 task X");
  await sleep(800);
  assert(!(await bridge.exists(".dirty-wt-modal")), "closing task X shows no Uncommitted Changes dialog for the external checkout");
  assert(wtX.ownedBySession === false && wtX.sharedWithOtherSessions === false, "task X did not own that checkout (and shared it with no session)");
  await confirmCloseIfAsked(bridge);
  await waitSessionGone(bridge, "F09 task X");
  await sleep(2500);
  toastText = (await toasts(bridge)).join(" | ");
  log(`  toasts after closing X: ${JSON.stringify(toastText)}`);
  assert(!/clean up|retried on next startup|project folder/i.test(toastText), "no cleanup warning, no 'retry on next startup', no 'project folder' message");
  assert(existsSync(externalWt) && existsSync(xWork) && existsSync(join(externalWt, "external-committed.txt")), "the external checkout and its uncommitted file are untouched");
  assert(worktrees().some((w) => samePath(w.path, externalWt) && w.branch === "external-branch"), "git still has the external checkout on external-branch");
  assert((await worktreeOf(bridge, idX, pid)) === null, "task X's link to it is gone");
  await bridge.screenshot(join(evidenceDir, "04-after-close-x.png"));

  log("step 6b (B): task Y reuses a checkout of ANOTHER Hermes instance; uncommitted work; close Y");
  const reuseY = await reuseCheckoutOf(bridge, { label: "F09 task Y", branch: "foreign-branch" });
  assert(samePath(reuseY.shownPath, foreignWt), `the choice names the other instance's folder (${reuseY.shownPath})`);
  const idY = reuseY.id;
  const wtY = await worktreeOf(bridge, idY, pid);
  log(`  task Y: ${JSON.stringify(wtY)}`);
  assert(wtY && samePath(wtY.worktreePath, foreignWt) && wtY.ownedBySession === false, "task Y is linked to it and does not own it");
  const yWork = join(foreignWt, "f09e-foreign-work.txt");
  writeFileSync(yWork, "work in another Hermes instance's checkout\n");
  await closeSessionByLabel(bridge, "F09 task Y");
  await sleep(800);
  assert(!(await bridge.exists(".dirty-wt-modal")), "closing task Y shows no Uncommitted Changes dialog for another instance's checkout");
  await confirmCloseIfAsked(bridge);
  await waitSessionGone(bridge, "F09 task Y");
  await sleep(2500);
  toastText = (await toasts(bridge)).join(" | ");
  log(`  toasts after closing Y: ${JSON.stringify(toastText)}`);
  assert(!/clean up|retried on next startup|project folder/i.test(toastText), "no cleanup warning after closing Y");
  assert(existsSync(foreignWt) && existsSync(yWork), "the other instance's checkout and its uncommitted file are untouched");
  assert(worktrees().some((w) => samePath(w.path, foreignWt) && w.branch === "foreign-branch"), "git still has the other instance's checkout");
  assert((await worktreeOf(bridge, idY, pid)) === null, "task Y's link to it is gone");

  // C ─────────────────────────────────────────────────────────────
  log("step 7 (C): task R with the default branch, then quit with R open");
  before = await bridge.terminalIds();
  await startTask(bridge, { label: "F09 task R" });
  const idR = await waitForNewSession(bridge, before, "F09 task R");
  const wtR = await worktreeOf(bridge, idR, pid);
  log(`  task R: session ${idR}, worktree ${JSON.stringify(wtR)}`);
  assert(wtR && /^hermes\/task-/.test(wtR.branchName) && wtR.ownedBySession === true, `task R owns its worktree on ${wtR?.branchName}`);
  writeFileSync(join(wtR.worktreePath, "f09e-r.txt"), "committed by task R\n");
  execFileSync("git", ["-C", wtR.worktreePath, "add", "."], { env: gitEnv });
  execFileSync("git", ["-C", wtR.worktreePath, "commit", "-q", "-m", "r work"], { env: gitEnv });
  await bridge.waitFor("the workspace (with task R) to be saved", `
    const s = await window.__TAURI_INTERNALS__.invoke("get_settings");
    return !!s.saved_workspace && s.saved_workspace.includes(${JSON.stringify(idR)});
  `, { timeoutMs: 40_000, intervalMs: 500 });
  await quit(app);

  log("step 8 (C): delete R's worktree folder behind Hermes' back, relaunch");
  rmSync(wtR.worktreePath, { recursive: true, force: true });
  assert(!existsSync(wtR.worktreePath), "the folder is gone");
  app = await launch(3);
  await waitForReturningLaunch(app.bridge);
  await waitForSessionListed(app.bridge, "F09 task R", 30_000);
  const recreatedMsg = await app.bridge.waitFor("a message that the folder was recreated", `
    return e2e.all(".toast .toast-message").map((el) => el.innerText).find((t) => /was missing and has been recreated/.test(t)) || null;
  `, { timeoutMs: 15_000 });
  log(`  message: ${recreatedMsg}`);
  assert(recreatedMsg.includes(wtR.branchName), "the message names R's branch");
  await app.bridge.screenshot(join(evidenceDir, "05-restored-recreated.png"));
  const ids3 = await app.bridge.terminalIds();
  assert(ids3.includes(idR), `task R kept its session id (${idR})`);
  assert(existsSync(join(wtR.worktreePath, "f09e-r.txt")), "the worktree folder is back, with R's committed file");
  const wtR3 = await worktreeOf(app.bridge, idR, pid);
  assert(wtR3 && samePath(wtR3.worktreePath, wtR.worktreePath), "task R is still linked to its worktree");
  const shownR3 = await runInTerminal(app.bridge, idR, "git branch --show-current", /^hermes\/task-/);
  assert(shownR3 === wtR.branchName, `R's terminal answers, on ${shownR3} (not stuck at starting)`);
  assert(!/starting/.test((await statusOf(app.bridge, "F09 task R")) ?? ""), "the session list does not show R as starting");
  await app.bridge.waitFor("the workspace (with task R) to be saved again", `
    const s = await window.__TAURI_INTERNALS__.invoke("get_settings");
    return !!s.saved_workspace && s.saved_workspace.includes(${JSON.stringify(idR)});
  `, { timeoutMs: 40_000, intervalMs: 500 });
  await quit(app);

  log("step 9 (C): delete R's folder AND its branch, relaunch");
  rmSync(wtR.worktreePath, { recursive: true, force: true });
  git("worktree", "prune");
  git("branch", "-D", wtR.branchName);
  assert(!git("branch", "--list", wtR.branchName), "the branch is gone");
  app = await launch(4);
  await waitForReturningLaunch(app.bridge);
  await waitForSessionListed(app.bridge, "F09 task R", 30_000);
  const fallbackMsg = await app.bridge.waitFor("a message that R opened in the project folder", `
    return e2e.all(".toast .toast-message").map((el) => el.innerText).find((t) => /opened in the project folder/.test(t)) || null;
  `, { timeoutMs: 15_000 });
  log(`  message: ${fallbackMsg}`);
  await app.bridge.screenshot(join(evidenceDir, "06-restored-project-folder.png"));
  assert(!existsSync(wtR.worktreePath), "nothing was recreated for a branch that no longer exists");
  assert((await worktreeOf(app.bridge, idR, pid)) === null, "R is no longer shown as isolated (its stale link is gone)");
  const repoName = basename(repo);
  const shownDir = await runInTerminal(app.bridge, idR, "pwd", new RegExp(`${repoName}$`));
  assert(samePath(shownDir, repo), `R's terminal answers, in the project folder (${shownDir})`);
  assert(!/starting/.test((await statusOf(app.bridge, "F09 task R")) ?? ""), "the session list does not show R as starting");
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
          toasts: e2e.all(".toast .toast-message").map((el) => el.innerText),
          sessions: e2e.all(".session-item").map((el) => el.innerText.replace(/\\s+/g, " ")),
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
