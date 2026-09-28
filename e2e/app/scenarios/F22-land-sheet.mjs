#!/usr/bin/env node
// Scenario: F22 — Land sheet with undo, on the REAL app, with a throwaway git
// repository, a LOCAL BARE REMOTE and a stand-in gh (e2e/app/fixtures/
// fake-gh.mjs): no GitHub account, no network. Plain shell sessions stand in
// for the agents; the turn ledger (F20) is stood in for by the test hook
// setFakeLandTurns, and the Done-When result (F27) by injected SessionEvents
// (docs/adr/004).
//
//   run 1  fresh install; turn the landSheet and honestIsolation flags on
//          (settings, app closed), quit
//   run 2  task A (its own hermes/task-xxxx worktree) gets a file and a
//          feature.md whose slug is the branch's:
//            - the sheet shows Done-When (from .hermes/worktree.toml), the
//              turn count, the diffstat and the disk used
//            - Squash-merge locally: main gets ONE commit whose subject is the
//              plan's title, the project folder's files follow, and the
//              pre-land ref keeps main's old commit
//            - Undo: main is back at the commit it had before, the landed file
//              is gone from the project folder, the work is uncommitted again
//            - a failing Done-When (check_failed) demotes Land to "Land anyway"
//            - main and the task change the same line: the merge option is
//              disabled, "Ask agent to rebase" pastes one line into the task's
//              terminal (no Enter), main is never touched (never force-merged)
//            - "Open a pull request instead": push to the bare remote and
//              gh pr create; the PR body lists the turns and the plan; the
//              checks show; "Send failing CI log to the agent" saves the log in
//              .hermes/ci/ (ignored by git) and pastes one line
//            - Undo: gh pr close, the branch is deleted on the remote, the
//              local branch stays, the work is uncommitted again
//            - gh signed out: the PR option is disabled with a sign-in link
//          task B gets a file and build output (node_modules):
//            - Commit + "Archive after landing": the worktree folder is gone
//              (build output included), the branch and its land ref stay, the
//              session is closed
//            - Undo: the worktree is back on the branch, in a new session, and
//              the work is uncommitted again
//   run 3  gh not installed: the PR option is disabled with an install link
//
// Negative control: HERMES_E2E_F22_NEGATIVE=1 leaves the landSheet flag off,
// so there is no Land button and the scenario must end in RESULT: FAIL.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F22-land-sheet.mjs
//
// Evidence goes to HERMES_E2E_EVIDENCE, or <out dir>/evidence/F22-land-sheet.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "F22-land-sheet";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);
const NEGATIVE = process.env.HERMES_E2E_F22_NEGATIVE === "1";
const FAKE_GH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-gh.mjs");

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

// ── A throwaway repository and a local bare remote (synthetic identity) ──
const workDir = realpathSync.native(mkdtempSync(join(tmpdir(), "hermes-e2e-f22-")));
const repo = join(workDir, "f22-repo");
const remote = join(workDir, "f22-remote.git");
const ghState = join(workDir, "gh-state.json");
const ghLog = join(workDir, "gh-calls.jsonl");
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Hermes Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Hermes Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};
const gitIn = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { env: gitEnv, encoding: "utf8" }).trim();
const git = (...args) => gitIn(repo, ...args);

function makeRepo() {
  execFileSync("git", ["init", "-q", "--bare", remote], { env: gitEnv });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
  git("config", "user.name", "Hermes Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "# f22\n\nstatus: draft\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  mkdirSync(join(repo, ".hermes"), { recursive: true });
  writeFileSync(join(repo, ".hermes", "worktree.toml"), 'done_when = ["npm test"]\n');
  git("add", ".");
  git("commit", "-q", "-m", "initial");
  git("remote", "add", "origin", remote);
  git("push", "-q", "origin", "main");
}

function setGh(state) {
  writeFileSync(ghState, JSON.stringify(state, null, 2));
}
function ghCalls() {
  if (!existsSync(ghLog)) return [];
  return readFileSync(ghLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const onWindows = platform() === "win32";
const homeDir = onWindows ? undefined : mkdtempSync(join(tmpdir(), "hermes-e2e-f22-home-"));
function launch(run, { first = false, gh = FAKE_GH } = {}) {
  const runDir = join(evidenceDir, `run-${run}`);
  const env = { HERMES_E2E_GH: gh, FAKE_GH_STATE: ghState, FAKE_GH_LOG: ghLog };
  return onWindows
    ? launchApp({ runDir, log, home: "real", resetData: first, env })
    : launchApp({ runDir, log, home: "private", homeDir, env });
}

const DB_FILE = "hermes_idea_v3.db";
function setFlags(dataDir, flags) {
  const db = new DatabaseSync(join(dataDir, DB_FILE));
  try {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('feature_flag_overrides', ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    ).run(JSON.stringify(flags));
  } finally {
    db.close();
  }
}

// ── UI helpers (same steps as F09) ─────────────────────────────────────

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
  const exit = await current.stop();
  log(`  app exited: ${JSON.stringify(exit)}`);
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");
}

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

const PRIMARY = ".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary";
async function clickPrimary(bridge) {
  await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.first(${JSON.stringify(PRIMARY)}), "the wizard's primary button"));`);
  await sleep(300);
}

/** New Session wizard: plain shell, the test repo, its default hermes/ branch. */
async function startTask(bridge, label) {
  const before = await bridge.terminalIds();
  await bridge.click(".activity-bar-action");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`);
  await bridge.clickWhenReady(`
    const cards = e2e.all(".session-creator-provider-card");
    return e2e.click(e2e.must(cards[cards.length - 1], "plain shell card"));
  `);
  await clickPrimary(bridge);
  await bridge.waitFor("the folder step", `return !!e2e.first(".workspace-scan-input");`);
  const listed = await bridge.eval(`
    const row = e2e.all(".project-picker-item").find((el) => el.innerText.includes("f22-repo"));
    if (!row) return false;
    if (!row.classList.contains("project-picker-item-attached")) e2e.click(row);
    return true;
  `);
  if (!listed) {
    await bridge.eval(setInput(".workspace-scan-input", repo));
    await bridge.clickByName("Scan", { within: ".project-picker-footer" });
  }
  await bridge.waitFor("the test repo to be selected", `
    return e2e.all(".project-picker-item.project-picker-item-attached").some((el) => el.innerText.includes("f22-repo"));
  `);
  await clickPrimary(bridge);
  await bridge.waitFor("the branch step", `return !!e2e.first(".session-creator-branch-multi");`, { timeoutMs: 20_000 });
  await bridge.waitFor("a default branch to be chosen", `return !!e2e.first(".session-creator-branch-selected-label");`);
  await clickPrimary(bridge);
  await bridge.waitFor("the confirm step", `return !!e2e.first('input.command-palette-input[placeholder="Session name (optional)"]');`);
  await bridge.eval(setInput('input.command-palette-input[placeholder="Session name (optional)"]', label));
  await clickPrimary(bridge);
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  const id = await bridge.waitFor(`the terminal of "${label}"`, `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
    return ids.length === 1 ? ids[0] : null;
  `, { timeoutMs: 20_000 });
  await bridge.waitFor(`"${label}" in the session list`, `
    return e2e.all(".session-item").some((el) => el.innerText.includes(${JSON.stringify(label)}));
  `);
  await bridge.waitFor("the shell to start", `
    const info = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(id)});
    const lines = window.__HERMES_E2E__.readTerminal(${JSON.stringify(id)}) || [];
    return info && info.opened && lines.some((l) => l.trim().length > 0);
  `, { timeoutMs: 30_000 });
  await sleep(800);
  return id;
}

const samePath = (a, b) => {
  const norm = (p) => {
    try {
      p = realpathSync.native(p);
    } catch {
      /* gone */
    }
    return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  };
  return norm(a) === norm(b);
};

async function projectId(bridge) {
  const projects = await invoke(bridge, "get_registered_projects");
  const p = projects.find((x) => samePath(x.path, repo));
  if (!p) throw new Error("the test repo is not a project");
  return p.id;
}

async function selectSession(bridge, label) {
  await bridge.clickWhenReady(`
    const item = e2e.all(".session-item").find((el) => el.innerText.includes(${JSON.stringify(label)}));
    return e2e.click(e2e.must(item, "session ${label}"));
  `);
  await sleep(300);
}

/** Open the session's Git panel, press Land…, wait for the sheet. */
async function openLandSheet(bridge, label) {
  await selectSession(bridge, label);
  if (!(await bridge.exists(".session-git-panel"))) {
    await bridge.click('.session-subview-btn[title="Git"]');
  }
  await bridge.waitFor("the session Git panel", `return !!e2e.first(".session-git-panel");`);
  await bridge.waitFor("the Land button", `return !!e2e.first(".session-git-land-btn");`, { timeoutMs: 10_000 });
  await bridge.click(".session-git-land-btn");
  await bridge.waitFor("the Land sheet to read the worktree", `
    return !!e2e.first(".land-sheet") && !!e2e.first('.land-sheet-option[data-mode="merge"]');
  `, { timeoutMs: 20_000 });
}

/** The sheet's summary and options as a person reads them. */
function readSheet(bridge) {
  return bridge.eval(`
    const opt = (m) => {
      const el = e2e.first('.land-sheet-option[data-mode="' + m + '"]');
      return el ? { disabled: el.getAttribute("aria-disabled") === "true", text: e2e.norm(el.innerText),
                    checked: !!el.querySelector("input")?.checked } : null;
    };
    const d = e2e.first(".land-sheet-diffstat");
    return {
      doneWhen: e2e.norm(e2e.first(".land-sheet-donewhen")?.innerText ?? ""),
      doneWhenState: e2e.first(".land-sheet-donewhen")?.dataset.state ?? null,
      turns: Number(e2e.first(".land-sheet-turns")?.dataset.turns ?? -1),
      diffstat: d ? { files: Number(d.dataset.files), insertions: Number(d.dataset.insertions), deletions: Number(d.dataset.deletions) } : null,
      disk: e2e.norm(e2e.first(".land-sheet-disk")?.innerText ?? ""),
      diskBytes: e2e.first(".land-sheet-disk")?.dataset.totalBytes ?? "",
      commit: opt("commit"), pr: opt("pr"), merge: opt("merge"),
      message: e2e.first(".land-sheet-message")?.value ?? null,
      land: (() => { const b = e2e.first(".land-sheet-land"); return b ? { text: e2e.norm(b.innerText), className: b.className, disabled: b.disabled } : null; })(),
      conflict: e2e.norm(e2e.first(".land-sheet-conflict")?.innerText ?? ""),
      ghLink: e2e.norm(e2e.first(".land-sheet-gh-link")?.innerText ?? ""),
      title: e2e.norm(e2e.first(".land-sheet-title")?.innerText ?? ""),
      baseNote: e2e.first(".land-sheet-base-note") ? e2e.norm(e2e.first(".land-sheet-base-note").innerText) : null,
    };
  `);
}

async function pickMode(bridge, mode) {
  // The sheet settles its default pick once the GitHub CLI status arrives;
  // on a slow runner that can land right after the click, so click again
  // until the choice holds.
  const chosen = `return e2e.first('.land-sheet-option[data-mode="${mode}"] input')?.checked === true;`;
  for (let attempt = 0; attempt < 3; attempt++) {
    await bridge.clickWhenReady(`
      const input = e2e.first('.land-sheet-option[data-mode="${mode}"] input');
      if (!input || input.disabled) return null;
      return e2e.click(input);
    `);
    try {
      await bridge.waitFor(`the ${mode} option to be chosen`, chosen, { timeoutMs: 5_000 });
      return;
    } catch {
      /* clicked too early: try again */
    }
  }
  await bridge.waitFor(`the ${mode} option to be chosen`, chosen);
}

async function closeSheet(bridge) {
  await bridge.click(".land-sheet-close, .land-sheet-cancel");
  await bridge.waitFor("the Land sheet to close", `return !e2e.first(".land-sheet");`);
}

async function injectTurns(bridge, sessionId, turns) {
  await bridge.eval(`window.__HERMES_E2E__.setFakeLandTurns(${JSON.stringify(sessionId)}, ${JSON.stringify(turns)}); return true;`);
  for (const t of turns) {
    await bridge.eval(`
      window.__HERMES_E2E__.injectSessionEvent(${JSON.stringify(sessionId)}, { type: "turn_start", at: ${t.turn.startedAt}, source: "e2e", n: ${t.turn.n} });
      window.__HERMES_E2E__.injectSessionEvent(${JSON.stringify(sessionId)}, { type: "turn_end", at: ${t.turn.endedAt}, source: "e2e", n: ${t.turn.n} });
      return true;
    `);
  }
}

function fakeTurn(sessionId, n, files, insertions, deletions, paths) {
  return {
    turn: {
      sessionId,
      n,
      ref: `refs/hermes/${sessionId}/turn/${n}`,
      startedAt: 1_790_000_000_000 + n * 60_000,
      endedAt: 1_790_000_000_000 + n * 60_000 + 30_000,
      diffstat: { files, insertions, deletions },
    },
    patch: paths.map((p) => `diff --git a/${p} b/${p}\n`).join(""),
  };
}

const terminalText = async (bridge, id) => ((await bridge.readTerminal(id)) ?? []).join("\n");

/**
 * Wait for `text` in a terminal. The shell's line editor wraps a long input
 * line itself, so rows are joined without a separator before matching.
 */
async function waitForPasted(bridge, id, text, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const joined = ((await bridge.readTerminal(id)) ?? []).join("");
    if (joined.includes(text)) return;
    if (Date.now() > deadline) throw new Error(`terminal never showed ${JSON.stringify(text)}; last content:\n${joined}`);
    await sleep(150);
  }
}
const porcelain = (dir) => gitIn(dir, "status", "--porcelain", "--untracked-files=all").split(/\r?\n/).filter(Boolean).sort();

let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}${NEGATIVE ? "   NEGATIVE CONTROL (landSheet flag off)" : ""}`);
  makeRepo();
  setGh({ signedIn: true, checks: [] });
  log(`  throwaway repo: ${repo}; bare remote: ${remote}`);

  // ── run 1 ──────────────────────────────────────────────────────────
  log("step 1: fresh launch, onboarding, quit; flags on");
  app = await launch(1, { first: true });
  await completeOnboarding(app.bridge);
  await quit(app);
  setFlags(app.dataDir, NEGATIVE ? { honestIsolation: true } : { landSheet: true, honestIsolation: true });

  // ── run 2 ──────────────────────────────────────────────────────────
  log("step 2: relaunch; task A in its own worktree");
  app = await launch(2);
  const { bridge } = app;
  await waitForReturningLaunch(bridge);
  const idA = await startTask(bridge, "Task A");
  const pid = await projectId(bridge);
  const wtA = await invoke(bridge, "git_session_worktree_info", { sessionId: idA, projectId: pid });
  const pathA = wtA.worktreePath;
  const branchA = wtA.branchName;
  const slugA = branchA.replace(/^hermes\//, "");
  log(`  task A: session ${idA}, ${branchA} at ${pathA}`);
  assert(/^hermes\/task-[a-z2-9]{4}$/.test(branchA) && !wtA.isMainWorktree, "task A has its own hermes/ branch and worktree");

  // What an agent would have done in two turns.
  mkdirSync(join(pathA, "notes"), { recursive: true });
  writeFileSync(join(pathA, "notes", "merge.txt"), "first\nsecond\n");
  mkdirSync(join(pathA, ".hermes", "features", slugA), { recursive: true });
  writeFileSync(
    join(pathA, ".hermes", "features", slugA, "feature.md"),
    `---\nslug: ${slugA}\ntrack: Light\nphase: implement\ngate: approved\n---\n# Add merge notes\n\nWrite the merge notes file.\n`,
  );
  await injectTurns(bridge, idA, [
    fakeTurn(idA, 1, 1, 2, 0, ["notes/merge.txt"]),
    fakeTurn(idA, 2, 1, 7, 0, [`.hermes/features/${slugA}/feature.md`]),
  ]);

  log("step 3: open the Land sheet on task A");
  await openLandSheet(bridge, "Task A");
  await bridge.waitFor("the disk use", `return !!e2e.first(".land-sheet-disk")?.dataset.totalBytes;`, { timeoutMs: 20_000 });
  let sheet = await readSheet(bridge);
  log(`  sheet: ${JSON.stringify(sheet)}`);
  assert(sheet.doneWhen.includes("1 check, no result yet") && sheet.doneWhenState === "not_run", "Done-When shows the worktree.toml check");
  assert(sheet.turns === 2, "the turn count is 2");
  assert(sheet.diffstat.files === 2 && sheet.diffstat.insertions === 11 && sheet.diffstat.deletions === 0, "the diffstat counts both new files (+11)");
  assert(Number(sheet.diskBytes) > 0 && /^disk/i.test(sheet.disk), `the disk used is shown ("${sheet.disk}")`);
  assert(sheet.message.startsWith("Add merge notes\n\n2 turns:\n- Turn 1: 1 file, +2 -0 (notes/merge.txt)"), "the message is drafted from the plan and the turns");
  assert(!sheet.merge.disabled && /fast-forward/.test(sheet.merge.text), "the merge option says it is a fast-forward");
  assert(sheet.title.endsWith("into main") && sheet.baseNote === null, "the sheet lands into main and adds no branch warning");
  await bridge.screenshot(join(evidenceDir, "01-land-sheet.png"));

  log("step 4: squash-merge into main locally");
  const mainBefore = git("rev-parse", "main");
  await pickMode(bridge, "merge");
  await bridge.click(".land-sheet-land");
  const landedText = await bridge.waitFor("the landed result", `
    const r = e2e.first('.land-sheet-result[data-status="landed"]');
    return r ? e2e.norm(r.innerText) : null;
  `, { timeoutMs: 30_000 });
  log(`  result: "${landedText}"`);
  assert(/Squash-merged into main/.test(landedText), "the sheet says it squash-merged into main");
  assert(git("rev-parse", "main^") === mainBefore, "main has exactly one new commit");
  assert(git("log", "-1", "--format=%s", "main") === "Add merge notes", "its subject is the plan's title");
  assert(existsSync(join(repo, "notes", "merge.txt")), "the project folder's files followed main");
  assert(git("rev-parse", `refs/hermes/${idA}/land/1/base`) === mainBefore, "the pre-land ref keeps main's old commit");
  assert(porcelain(pathA).length === 0, "task A's work is committed on its branch");
  await bridge.screenshot(join(evidenceDir, "02-merged.png"));

  log("step 5: Undo the local merge");
  await bridge.click(".land-sheet-undo");
  const undoneText = await bridge.waitFor("the undo result", `
    const r = e2e.first(".land-sheet-undone");
    return r ? e2e.norm(r.innerText) : null;
  `, { timeoutMs: 30_000 });
  log(`  undo: "${undoneText}"`);
  assert(git("rev-parse", "main") === mainBefore, "main is back at the commit it had before");
  assert(!existsSync(join(repo, "notes", "merge.txt")), "the landed file is gone from the project folder");
  assert(git("status", "--porcelain") === "", "the project folder is clean");
  const afterUndo = porcelain(pathA);
  assert(afterUndo.includes("?? notes/merge.txt"), `task A's work is uncommitted again (${afterUndo.join(", ")})`);
  await bridge.screenshot(join(evidenceDir, "03-merge-undone.png"));
  await closeSheet(bridge);

  log("step 6: a failing Done-When check demotes Land to 'Land anyway'");
  await bridge.eval(`
    window.__HERMES_E2E__.injectSessionEvent(${JSON.stringify(idA)}, { type: "status", at: Date.now(), source: "e2e",
      status: { kind: "check_failed", confidence: "exact", detail: "npm test exited 1" } });
    return true;
  `);
  await openLandSheet(bridge, "Task A");
  sheet = await readSheet(bridge);
  log(`  sheet: ${JSON.stringify({ doneWhen: sheet.doneWhen, land: sheet.land })}`);
  assert(sheet.doneWhen === "Done-When Failing: npm test exited 1" || sheet.doneWhen.includes("Failing: npm test exited 1"), "Done-When says it is failing");
  assert(sheet.land.text === "Land anyway" && /land-sheet-btn-secondary/.test(sheet.land.className), "Land becomes a secondary 'Land anyway'");
  await bridge.screenshot(join(evidenceDir, "04-land-anyway.png"));
  await closeSheet(bridge);
  await bridge.eval(`
    window.__HERMES_E2E__.injectSessionEvent(${JSON.stringify(idA)}, { type: "status", at: Date.now(), source: "e2e",
      status: { kind: "idle", confidence: "exact", detail: "" } });
    return true;
  `);

  log("step 7: main and task A change the same line -> no merge, routes to PR or rebase");
  writeFileSync(join(pathA, "README.md"), "# f22\n\nstatus: task\n");
  writeFileSync(join(repo, "README.md"), "# f22\n\nstatus: main\n");
  git("commit", "-q", "-am", "main edits the status");
  const mainConflict = git("rev-parse", "main");
  await openLandSheet(bridge, "Task A");
  sheet = await readSheet(bridge);
  log(`  sheet: ${JSON.stringify({ merge: sheet.merge, conflict: sheet.conflict })}`);
  assert(sheet.merge.disabled && sheet.merge.text.includes("would conflict in README.md"), "the merge option is disabled and names the file");
  assert(sheet.conflict.includes("Hermes never forces a merge"), "the sheet says it never forces a merge");
  await bridge.screenshot(join(evidenceDir, "05-conflict-routes.png"));
  await bridge.clickByName("Ask agent to rebase", { within: ".land-sheet-conflict" });
  await waitForPasted(bridge, idA, "Please rebase this branch onto main and resolve the conflicts in README.md.");
  assert(true, "the rebase request was pasted into task A's terminal");
  await sleep(500);
  const txt = await terminalText(bridge, idA);
  assert(!/command not found|not recognized/i.test(txt), "it was not sent (no Enter): the shell did not run it");
  assert(git("rev-parse", "main") === mainConflict, "main is untouched (never force-merged)");

  log("step 8: open a pull request instead (push to the bare remote, gh pr create)");
  setGh({
    signedIn: true,
    checks: [
      { name: "lint", state: "SUCCESS", bucket: "pass", link: "https://github.test/e2e/repo/actions/runs/41/job/1", workflow: "CI" },
      { name: "test", state: "FAILURE", bucket: "fail", link: "https://github.test/e2e/repo/actions/runs/42/job/2", workflow: "CI" },
    ],
    failedLog: "test\tRun npm test\n  FAIL src/search.test.ts\n  expected 3, got 2\n",
  });
  await bridge.clickByName("Open a pull request instead", { within: ".land-sheet-conflict" });
  await bridge.waitFor("the PR option to be chosen", `return e2e.first('.land-sheet-option[data-mode="pr"] input')?.checked === true;`);
  const bodyShown = await bridge.text(".land-sheet-prbody-text");
  assert(bodyShown.includes("## Turns") && bodyShown.includes("## Plan"), "the PR description shows the turns and the plan");
  await bridge.click(".land-sheet-land");
  const prText = await bridge.waitFor("the PR result", `
    const r = e2e.first('.land-sheet-result[data-status="landed"]');
    return r ? e2e.norm(r.innerText) : null;
  `, { timeoutMs: 30_000 });
  log(`  result: "${prText}"`);
  const create = ghCalls().find((c) => c.args[0] === "pr" && c.args[1] === "create");
  log(`  gh pr create: ${JSON.stringify(create)}`);
  assert(!!create, "gh pr create ran");
  assert(create.args.join(" ").includes(`--base main --head ${branchA} --title Add merge notes`), "against main, from the task branch, titled from the plan");
  assert(create.stdin.includes("## Turns\n\n- Turn 1: 1 file, +2 -0 (notes/merge.txt)\n- Turn 2: 1 file, +7 -0"), "the PR body lists the turns");
  assert(create.stdin.includes("## Plan\n\n# Add merge notes\n\nWrite the merge notes file."), "the PR body includes the plan");
  assert(create.stdin.includes("## Done-When\n\n- `npm test`"), "the PR body lists the Done-When checks");
  const pushed = gitIn(remote, "rev-parse", `refs/heads/${branchA}`);
  assert(pushed === gitIn(pathA, "rev-parse", "HEAD"), "the task branch was pushed to the bare remote");
  assert(git("rev-parse", "main") === mainConflict, "main is still untouched");

  log("step 9: the PR's checks, and the failing log handed to the agent");
  await bridge.waitFor("the checks", `return e2e.all(".land-sheet-ci").length === 2;`, { timeoutMs: 20_000 });
  const ciRows = await bridge.eval(`return e2e.all(".land-sheet-ci").map((el) => ({ bucket: el.dataset.bucket, text: e2e.norm(el.innerText) }));`);
  log(`  checks: ${JSON.stringify(ciRows)}`);
  assert(ciRows.some((r) => r.bucket === "fail" && r.text.includes("Send failing CI log to the agent")), "the failing check offers to send its log");
  await bridge.screenshot(join(evidenceDir, "06-pr-checks.png"));
  await bridge.clickByName("Send failing CI log to the agent", { within: ".land-sheet-checks" });
  await waitForPasted(bridge, idA, 'CI check "test" failed on the pull request. The failing log is in .hermes/ci/test.log; please fix it.');
  const savedLog = readFileSync(join(pathA, ".hermes", "ci", "test.log"), "utf8");
  assert(savedLog.includes("expected 3, got 2"), "the failing log is saved in the worktree");
  assert(porcelain(pathA).length === 0, "git ignores the saved log");
  assert(ghCalls().some((c) => c.args.join(" ") === "run view 42 --log-failed --job 2"), "the log came from gh run view --log-failed");

  log("step 10: Undo the pull request");
  await bridge.click(".land-sheet-undo");
  const prUndone = await bridge.waitFor("the undo result", `
    const r = e2e.first(".land-sheet-undone");
    return r ? e2e.norm(r.innerText) : null;
  `, { timeoutMs: 30_000 });
  log(`  undo: "${prUndone}"`);
  assert(ghCalls().some((c) => c.args[0] === "pr" && c.args[1] === "close" && c.args[2] === "https://github.test/e2e/repo/pull/7"), "gh pr close ran for that PR");
  assert(gitIn(remote, "branch", "--list", branchA) === "", "the branch is deleted on the remote");
  assert(git("branch", "--list", branchA).includes(branchA), "the local branch stays");
  const afterPrUndo = porcelain(pathA);
  assert(afterPrUndo.includes(" M README.md") || afterPrUndo.includes("M README.md") || afterPrUndo.some((l) => l.endsWith("README.md")), `the work is uncommitted again (${afterPrUndo.join(", ")})`);
  await bridge.screenshot(join(evidenceDir, "07-pr-undone.png"));
  await closeSheet(bridge);

  log("step 11: gh signed out -> the PR option is disabled with a sign-in link");
  setGh({ signedIn: false });
  await openLandSheet(bridge, "Task A");
  await bridge.waitFor("the gh check", `return !!e2e.first(".land-sheet-gh-link");`, { timeoutMs: 20_000 });
  sheet = await readSheet(bridge);
  log(`  pr option: ${JSON.stringify(sheet.pr)}; link: "${sheet.ghLink}"`);
  assert(sheet.pr.disabled && sheet.pr.text.includes("GitHub CLI (gh) is not signed in."), "the PR option is disabled: gh is not signed in");
  assert(sheet.ghLink === "Sign in: run gh auth login", "a sign-in link is offered");
  await bridge.screenshot(join(evidenceDir, "08-gh-signed-out.png"));
  await closeSheet(bridge);
  setGh({ signedIn: true, checks: [] });

  log("step 12: task B — commit and archive after landing");
  const idB = await startTask(bridge, "Task B");
  const wtB = await invoke(bridge, "git_session_worktree_info", { sessionId: idB, projectId: pid });
  const pathB = wtB.worktreePath;
  const branchB = wtB.branchName;
  log(`  task B: session ${idB}, ${branchB} at ${pathB}`);
  writeFileSync(join(pathB, "b.txt"), "task b\n");
  mkdirSync(join(pathB, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(pathB, "node_modules", "left-pad", "index.js"), Buffer.alloc(300_000, 120));
  await openLandSheet(bridge, "Task B");
  await bridge.waitFor("the disk use", `return /build output/.test(e2e.first(".land-sheet-disk")?.innerText ?? "");`, { timeoutMs: 20_000 });
  await pickMode(bridge, "commit");
  await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.first(".land-sheet-archive-after"), "archive checkbox"));`);
  await bridge.click(".land-sheet-land");
  const archivedText = await bridge.waitFor("the archive result", `
    const r = e2e.first(".land-sheet-archived");
    return r ? e2e.norm(r.innerText) : null;
  `, { timeoutMs: 30_000 });
  log(`  result: "${archivedText}"`);
  assert(/including .* of build output/.test(archivedText), "the sheet says the build output went too");
  const until = Date.now() + 20_000;
  while (existsSync(pathB) && Date.now() < until) await sleep(200);
  assert(!existsSync(pathB), "the worktree folder is gone (build output included)");
  assert(git("branch", "--list", branchB).includes(branchB), "the branch still exists");
  assert(git("log", "-1", "--format=%s", branchB).length > 0 && gitIn(repo, "show", `${branchB}:b.txt`) === "task b", "the work is committed on the branch");
  assert(git("rev-parse", `refs/hermes/${idB}/land/1/branch`).length === 40, "the pre-land ref stays");
  await bridge.waitFor("task B to leave the session list", `
    return !e2e.all(".session-item").some((el) => el.innerText.includes("Task B") && !el.classList.contains("session-item-destroyed"));
  `, { timeoutMs: 20_000 });
  await bridge.screenshot(join(evidenceDir, "09-archived.png"));

  log("step 13: Undo the archive");
  await bridge.click(".land-sheet-undo");
  await bridge.waitFor("the undo result", `return !!e2e.first(".land-sheet-undone");`, { timeoutMs: 30_000 });
  assert(existsSync(join(pathB, "b.txt")), "the worktree is back");
  assert(gitIn(pathB, "rev-parse", "--abbrev-ref", "HEAD") === branchB, "on the task branch");
  assert(porcelain(pathB).includes("?? b.txt"), "the work is uncommitted again");
  const restoredRow = await bridge.waitFor("a session linked to the restored worktree", `
    const rows = await window.__TAURI_INTERNALS__.invoke("git_list_all_worktrees");
    return rows.find((r) => r.branch_name === ${JSON.stringify(branchB)}) || null;
  `, { timeoutMs: 20_000 });
  log(`  restored: ${JSON.stringify(restoredRow)}`);
  assert(restoredRow.session_id !== idB, "it opened in a new session");
  await bridge.waitFor("the restored session in the list", `
    return e2e.all(".session-item").some((el) => el.innerText.includes("Task B"));
  `, { timeoutMs: 20_000 });
  const restoredId = restoredRow.session_id;
  const live = await invoke(bridge, "get_sessions");
  const restoredLive = live.find((x) => x.id === restoredId);
  log(`  restored session working directory: ${restoredLive?.working_directory}`);
  assert(restoredLive && samePath(restoredLive.working_directory, pathB), "the new session starts in the restored worktree");
  await bridge.waitFor("the restored shell to start", `
    const info = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(restoredId)});
    const lines = window.__HERMES_E2E__.readTerminal(${JSON.stringify(restoredId)}) || [];
    return info && info.opened && lines.some((l) => l.trim().length > 0);
  `, { timeoutMs: 30_000 });
  await sleep(800);
  // The test (not Hermes) types into the shell: the same line runs in bash,
  // zsh, PowerShell and cmd, and prints the folder the shell is in.
  await bridge.typeInTerminal(restoredId, "git rev-parse --show-toplevel\n");
  const shellDir = await (async () => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const lines = (await bridge.readTerminal(restoredId)) ?? [];
      const hit = lines.map((l) => l.trim()).find((l) => l && !l.includes("rev-parse") && samePath(l, pathB));
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`the restored shell never printed its folder; last content:\n${lines.join("\n")}`);
      await sleep(150);
    }
  })();
  assert(samePath(shellDir, pathB), `the restored shell runs in the worktree ("${shellDir}")`);
  await bridge.screenshot(join(evidenceDir, "10-archive-undone.png"));
  await closeSheet(bridge);
  await quit(app);

  // The project folder moves to another branch while the app is closed: the
  // sheet must say that landing goes there, not to main.
  git("checkout", "-q", "-b", "release-1");

  // ── run 3: gh not installed ────────────────────────────────────────
  log("step 14: relaunch with gh not installed");
  app = await launch(3, { gh: "none" });
  await waitForReturningLaunch(app.bridge);
  await app.bridge.waitFor("task A restored", `return e2e.all(".session-item").some((el) => el.innerText.includes("Task A"));`, { timeoutMs: 30_000 });
  await openLandSheet(app.bridge, "Task A");
  await app.bridge.waitFor("the gh check", `return !!e2e.first(".land-sheet-gh-link");`, { timeoutMs: 20_000 });
  sheet = await readSheet(app.bridge);
  log(`  pr option: ${JSON.stringify(sheet.pr)}; link: "${sheet.ghLink}"`);
  assert(sheet.pr.disabled && sheet.pr.text.includes("GitHub CLI (gh) is not installed."), "the PR option is disabled: gh is not installed");
  assert(sheet.ghLink === "Install GitHub CLI", "an install link is offered");
  log(`  title: "${sheet.title}"; branch note: "${sheet.baseNote}"`);
  assert(sheet.title.endsWith("into release-1"), "the sheet lands into the branch the project folder has checked out");
  assert(
    sheet.baseNote === "The project folder has release-1 checked out, so this lands on release-1. To land on your main branch, check it out in the project folder first.",
    "the sheet warns that landing goes to release-1, not main",
  );
  await app.bridge.screenshot(join(evidenceDir, "11-gh-missing.png"));
  await closeSheet(app.bridge);
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      const dump = await app.bridge.eval(`
        return {
          sheet: e2e.norm(e2e.first(".land-sheet")?.innerText ?? ""),
          toasts: e2e.all(".toast-message").map((el) => e2e.norm(el.innerText)),
          sessions: e2e.all(".session-item").map((el) => e2e.norm(el.innerText)),
        };
      `);
      log(`  what the app showed: ${JSON.stringify(dump)}`);
    }
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  if (app?.isRunning()) {
    log("quit the app");
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
