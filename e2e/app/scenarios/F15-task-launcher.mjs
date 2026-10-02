#!/usr/bin/env node
// Scenario F15: the ⌘N task launcher, on the REAL app, with fake `claude`
// and `codex` CLIs (tools/fake-agents/fake-cli.mjs) on the app's PATH and a
// throwaway git repository. No real account is ever used.
//
//   run 1  fresh install: the welcome, then the taskLauncher flag is turned
//          on (flags are read at startup). The launchHelper flag stays OFF,
//          so the task reaching the agent proves the launcher itself hands
//          it over.
//   run 2  - ⌘N (the File menu's New Session; on Windows and Linux the
//            Ctrl+Shift+N key) opens the launcher, not the old creator.
//          - the repository is typed in (project chip); its
//            .hermes/worktree.toml gives the checks; the task names the
//            branch hermes/<slug>.
//          - Enter: a terminal session starts on a NEW worktree of that
//            branch, the fake claude gets the task as its first prompt (its
//            last argument, and it prints it), and the launch is recorded.
//          - the fake claude is signed out: ⌘N again opens on the repository
//            of the active session; Launch is disabled with a "signed out"
//            row; Enter does nothing; Sign in opens a terminal running the
//            CLI.
//          - a task whose branch exists: the row blocks until the suggested
//            free branch is used; then the same task also runs on codex
//            ("Also on"), tracked as a feature: two sessions side by side,
//            each on its own branch, each with the task, each worktree with
//            its feature.md.
//          - a folder that is not a git repository blocks Launch.
//          - ⌘⇧N (Ctrl+Shift+H) opens the advanced creator, which still
//            offers SSH; so does the launcher's Advanced link.
//          - with the launch helper moved away from the app, a task still
//            starts the agent, which cannot get the task: a notice names the
//            agent and puts the task on the clipboard (or shows it).
//   run 3  the disk reports 2 GB free: a "low disk" row blocks Launch.
//
// On macOS the File menu's key equivalents belong to the native menu, which
// this rig cannot press; the scenario delivers the menu item's action the
// way the native menu does ("menu-action"). On Windows and Linux it sends
// the key chord to the page, where the app's own listener takes it.
//
// Negative control (must end in RESULT: FAIL):
//   HERMES_E2E_F15_FLAG=off   the flag stays off, so ⌘N opens the old creator.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F15-task-launcher.mjs

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { REPO_ROOT, createLogger, finishScenario, launchApp, outDir, sleep, skipScenario } from "../harness.mjs";
import { chooseOption as chooseSelectOption } from "../launcher-steps.mjs";

const SCENARIO = "F15-task-launcher";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);
const onWindows = platform() === "win32";
// HERMES_E2E_PLATFORM=linux|win runs the frontend with that platform's key rules (test builds only).
const onMac = platform() === "darwin" && !process.env.HERMES_E2E_PLATFORM;
const FLAG_ON = (process.env.HERMES_E2E_F15_FLAG || "on") !== "off";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

// ─── Fixtures: a repository, a plain folder, fake agents ─────────────

const work = realpathSync.native(mkdtempSync(join(tmpdir(), "hermes-e2e-f15-")));
const repo = join(work, "f15-repo");
const plain = join(work, "not-a-repo");
mkdirSync(plain, { recursive: true });
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
writeFileSync(join(repo, "README.md"), "# f15\n");
mkdirSync(join(repo, ".hermes"), { recursive: true });
writeFileSync(join(repo, ".hermes", "worktree.toml"), 'done_when = ["npm test"]\n');
git("add", ".");
git("commit", "-q", "-m", "initial");
git("branch", "hermes/existing-task");

const fakeBin = join(work, "bin");
const recordDir = join(work, "records");
mkdirSync(fakeBin, { recursive: true });
mkdirSync(recordDir, { recursive: true });
const FAKE_CLI = join(REPO_ROOT, "tools", "fake-agents", "fake-cli.mjs");
for (const agent of ["claude", "codex"]) {
  if (onWindows) {
    writeFileSync(join(fakeBin, `${agent}.cmd`), `@set "HERMES_FAKE_AGENT=${agent}"\r\n@"${process.execPath}" "${FAKE_CLI}" %*\r\n`);
  } else {
    writeFileSync(join(fakeBin, agent), `#!/bin/sh\nHERMES_FAKE_AGENT=${agent} exec "${process.execPath}" "${FAKE_CLI}" "$@"\n`);
    chmodSync(join(fakeBin, agent), 0o755);
  }
}
const setFake = (file, value) => writeFileSync(join(recordDir, file), `${value}\n`);
setFake("version-claude", "2.1.300");
setFake("version-codex", "0.150.0");
setFake("auth-claude", "in");
setFake("auth-codex", "in");

const isRealAgentDir = (dir) =>
  ["claude", "claude.exe", "claude.cmd", "codex", "codex.exe", "codex.cmd"].some((n) => existsSync(join(dir, n)));
process.env.PATH = [fakeBin, ...(process.env.PATH || "").split(delimiter).filter((d) => d && !isRealAgentDir(d))].join(delimiter);
for (const name of Object.keys(process.env)) if (name.startsWith("ANTHROPIC_") || name.startsWith("OPENAI_")) delete process.env[name];

/** Windows terminals rebuild PATH from the registry (see N12); CI runners only. */
const canEditRegistryPath = onWindows && process.env.GITHUB_ACTIONS === "true";
function addFakeBinToRegistryPath() {
  if (!canEditRegistryPath) return null;
  let old = null;
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Environment", "/v", "Path"], { encoding: "utf8" });
    const m = out.match(/^\s*Path\s+REG_\w+\s+(.*)$/im);
    old = m ? m[1].trim() : "";
  } catch {
    old = null;
  }
  execFileSync("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", old ? `${old};${fakeBin}` : fakeBin, "/f"]);
  log("  (CI runner: added the fake agents' folder to the user's registry Path)");
  return () => {
    if (old === null) execFileSync("reg", ["delete", "HKCU\\Environment", "/v", "Path", "/f"]);
    else execFileSync("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", old, "/f"]);
    log("  (CI runner: restored the user's registry Path)");
  };
}
if (onWindows && !canEditRegistryPath) {
  log("this scenario needs the fake agents on a Windows terminal's PATH (the user's registry Path); that is only changed on a CI runner");
  skipScenario({ scenario: SCENARIO, evidenceDir, reason: "Windows outside CI", log });
}

/** The fake CLIs' launch records, oldest first (doctor probes record nothing). */
const records = () =>
  readdirSync(recordDir)
    .filter((f) => f.startsWith("launch-"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(recordDir, f), "utf8")));
async function waitForRecords(count, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const all = records();
    if (all.length >= count) return all;
    if (Date.now() > deadline) throw new Error(`expected ${count} fake launch records, have ${all.length}`);
    await sleep(200);
  }
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
function worktrees() {
  const list = [];
  let cur = null;
  for (const line of git("worktree", "list", "--porcelain").split(/\r?\n/)) {
    if (line.startsWith("worktree ")) list.push((cur = { path: line.slice(9), branch: null }));
    else if (line.startsWith("branch ") && cur) cur.branch = line.slice(7).replace("refs/heads/", "");
  }
  return list;
}

// ─── App steps ───────────────────────────────────────────────────────

const homeDir = onWindows ? undefined : mkdtempSync(join(tmpdir(), "hermes-e2e-f15-home-"));
function launch(run, { first = false, env = {} } = {}) {
  const runDir = join(evidenceDir, `run-${run}`);
  // The doctor looks for agents in the fakes' folder only (a test-build
  // override), so no CLI installed on the machine is ever run.
  const common = { runDir, log, env: { HERMES_FAKE_DIR: recordDir, HERMES_E2E_AGENT_PATH: fakeBin, ...env } };
  return onWindows ? launchApp({ ...common, home: "real", resetData: first }) : launchApp({ ...common, home: "private", homeDir });
}

const invoke = (bridge, cmd, args) =>
  bridge.eval(`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})});`);

async function dismissWhatsNew(bridge) {
  await sleep(300);
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
}

async function completeClassicOnboarding(bridge) {
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
  await bridge.waitFor("the Finish button", `const b = e2e.first(".onboarding-actions .onboarding-btn-primary"); return !!b && !b.disabled;`);
  await bridge.click(".onboarding-actions .onboarding-btn-primary");
  await bridge.waitFor("the welcome dialog to close", `return !e2e.first(".onboarding-backdrop");`);
  await dismissWhatsNew(bridge);
}

async function waitForReturningLaunch(bridge) {
  await bridge.waitFor("the app UI (returning launch)", `return !!e2e.first(".topbar, .activity-bar") && !e2e.first(".onboarding-backdrop, .setup-backdrop");`, { timeoutMs: 30_000 });
  await dismissWhatsNew(bridge);
}

/**
 * A File-menu shortcut. macOS: the native menu's action (what the menu sends
 * when its key equivalent is pressed). Windows/Linux: the key chord itself.
 */
async function pressAppShortcut(bridge, { action, pcKey }) {
  if (onMac) {
    const r = await bridge.eval(`
      try {
        await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu-action", payload: { action: ${JSON.stringify(action)} } });
        return true;
      } catch (e) { return String(e); }
    `);
    assert(r === true, `the File menu delivered ${action}`);
  } else {
    await bridge.eval(`
      const target = document.activeElement || document.body;
      target.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(pcKey)}, code: "Key" + ${JSON.stringify(pcKey.toUpperCase())}, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
      return true;
    `);
    log(`  pressed Ctrl+Shift+${pcKey.toUpperCase()}`);
  }
}

const openLauncher = async (bridge) => {
  await pressAppShortcut(bridge, { action: "file.new-session", pcKey: "n" });
  await bridge.waitFor("the task launcher (not the old creator)", `
    if (e2e.first(".session-creator")) throw new Error("the old New Session creator opened instead of the task launcher");
    return !!e2e.first(".task-launcher-sheet .task-launcher");
  `, { timeoutMs: 20_000 });
  if (FLAG_ON) await launcherReady(bridge);
};

/** Type into a React-controlled field the way typing does. */
const typeInto = (bridge, selector, value) =>
  bridge.eval(`
    const el = e2e.must(e2e.first(${JSON.stringify(selector)}), ${JSON.stringify(selector)});
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    el.focus();
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return el.value;
  `);
// The launcher's selects are the control set's Select: picked with the mouse (launcher-steps.mjs).
const chooseOption = chooseSelectOption;
const pressEnterInTask = (bridge) =>
  bridge.eval(`
    const ta = e2e.must(e2e.first(".task-launcher-task"), "task field");
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    return true;
  `);
const launcherState = (bridge) =>
  bridge.eval(`
    return {
      repo: e2e.first('[data-chip="project"]')?.innerText ?? null,
      branch: e2e.first(".task-launcher-branch")?.value ?? null,
      doneWhen: e2e.all(".task-launcher-check-input").map((c) => c.value),
      blocks: e2e.all(".task-launcher-block").map((b) => ({ kind: b.getAttribute("data-kind"), text: e2e.norm(b.innerText) })),
      launchDisabled: !!e2e.first(".task-launcher-launch")?.disabled,
      agent: e2e.norm(e2e.first('[data-chip="agent"]')?.innerText ?? ""),
    };
  `);
/** The sheet has settled on its starting choice (the usual one or the defaults). */
const launcherReady = (bridge) => bridge.waitFor("the launcher's starting choice", `return e2e.first(".task-launcher")?.getAttribute("data-ready") === "true";`, { timeoutMs: 30_000 });
/** Opens a chip's menu (when closed). */
async function openChip(bridge, name) {
  await bridge.clickWhenReady(`
    const chip = e2e.first('[data-chip="${name}"]');
    if (!chip) return false;
    if (e2e.first('.task-launcher-menu[data-menu="${name}"]')) return true;
    return e2e.click(chip);
  `);
  await bridge.waitFor(`the ${name} menu`, `return !!e2e.first('.task-launcher-menu[data-menu="${name}"]');`);
}
/** The project chip: type a path into its menu. */
async function setRepo(bridge, path) {
  await openChip(bridge, "project");
  await typeInto(bridge, ".task-launcher-repo", path);
}
/** The agent chip: pick an agent. */
async function pickAgent(bridge, id) {
  await openChip(bridge, "agent");
  await bridge.click(`.task-launcher-menu [data-agent-id="${id}"]`);
}
/** + options open (branch, checks, feature, also on). */
async function expandOptions(bridge) {
  await bridge.clickWhenReady(`
    if (e2e.first(".task-launcher-options")) return true;
    return e2e.click(e2e.must(e2e.first(".task-launcher-expand"), "+ options"));
  `);
  await bridge.waitFor("the options", `return !!e2e.first(".task-launcher-options");`);
}

async function newTerminals(bridge, before, count, what) {
  return bridge.waitFor(what, `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
    return ids.length >= ${count} ? ids : null;
  `, { timeoutMs: 30_000 });
}

async function projectIdOf(bridge) {
  const projects = await invoke(bridge, "get_registered_projects");
  const p = projects.find((x) => samePath(x.path, repo));
  if (!p) throw new Error("the test repository is not a project");
  return p.id;
}

let app;
let failed = false;
let undoRegistryPath = null;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   flag: ${FLAG_ON ? "on" : "OFF (negative control)"}`);
  undoRegistryPath = addFakeBinToRegistryPath();

  // ── run 1 ───────────────────────────────────────────────────────
  log("run 1: fresh install; turn the taskLauncher flag on (read at the next start)");
  app = await launch(1, { first: true });
  await completeClassicOnboarding(app.bridge);
  await invoke(app.bridge, "set_setting", {
    key: "feature_flag_overrides",
    value: JSON.stringify(FLAG_ON ? { taskLauncher: true, launchHelper: false } : { launchHelper: false }),
  });
  await app.stop();

  // ── run 2 ───────────────────────────────────────────────────────
  app = await launch(2);
  const { bridge } = app;
  await waitForReturningLaunch(bridge);
  if (process.env.HERMES_E2E_PLATFORM) {
    log(`  switching the frontend to ${process.env.HERMES_E2E_PLATFORM} keyboard rules and reloading`);
    await bridge.eval(`localStorage.setItem("hermes-e2e-platform", ${JSON.stringify(process.env.HERMES_E2E_PLATFORM)}); setTimeout(() => location.reload(), 50); return true;`);
    await sleep(1500);
    await bridge.waitFor("the app UI to render again", `return document.readyState === "complete" && !!window.__HERMES_E2E__ && !!e2e.first(".topbar, .activity-bar");`, { timeoutMs: 30_000 });
  }

  log("step 1: ⌘N opens the task launcher");
  await openLauncher(bridge);
  await bridge.screenshot(join(evidenceDir, "01-launcher.png"));

  log("step 2: the repository, the checks and the branch from the task");
  await setRepo(bridge, repo);
  const TASK = "Fix the flaky login test";
  await typeInto(bridge, ".task-launcher-task", TASK);
  await openChip(bridge, "agent");
  await bridge.waitFor("the doctor's answer for claude", `
    const opt = e2e.first('.task-launcher-menu [data-agent-id="claude"]');
    return !!opt && /2\\.1\\.300/.test(opt.textContent);
  `, { timeoutMs: 30_000 });
  await bridge.click('.task-launcher-menu [data-agent-id="claude"]');
  await expandOptions(bridge);
  await bridge.waitFor("the checks from .hermes/worktree.toml", `return e2e.all(".task-launcher-check-input").length === 1;`, { timeoutMs: 20_000 });
  let st = await launcherState(bridge);
  log(`  launcher: ${JSON.stringify(st)}`);
  assert(st.branch === "hermes/fix-the-flaky-login-test", `the branch is hermes/<slug> (${st.branch})`);
  assert(JSON.stringify(st.doneWhen) === JSON.stringify(["npm test"]), "done when: npm test, from the repository's worktree.toml");
  assert(st.blocks.length === 0 && !st.launchDisabled, "nothing blocks Launch");
  assert(await bridge.eval(`return e2e.first('.task-launcher-view [data-mode="terminal"]')?.getAttribute("aria-checked") === "true";`), "Claude runs in a terminal by default (Agent view is an option)");
  await bridge.screenshot(join(evidenceDir, "02-filled.png"));

  log("step 3: Enter starts the agent in a terminal on a new worktree, with the task as its first prompt");
  let before = await bridge.terminalIds();
  await pressEnterInTask(bridge);
  await bridge.waitFor("the launcher to close", `return !e2e.first(".task-launcher-sheet");`, { timeoutMs: 30_000 });
  const [taskSession] = await newTerminals(bridge, before, 1, "the task's terminal");
  const [rec1] = await waitForRecords(1);
  log(`  fake claude record: ${JSON.stringify({ argv: rec1.argv, cwd: rec1.cwd, prompt: rec1.prompt })}`);
  const firstPrompt = (rec) => String(rec.argv[rec.argv.length - 1]).split(/\r?\n\r?\n|\s+Read the file at /)[0];
  assert(firstPrompt(rec1) === TASK, "the task is the agent's first prompt (its last argument; the project-context pointer follows it)");
  assert(rec1.sessionIdArg && rec1.settingsFile, "it was started by Hermes' launch helper (session id and hook settings passed)");
  const pid = await projectIdOf(bridge);
  const wt = await invoke(bridge, "git_session_worktree_info", { sessionId: taskSession, projectId: pid });
  log(`  worktree: ${JSON.stringify(wt)}`);
  assert(wt && wt.branchName === "hermes/fix-the-flaky-login-test" && !wt.isMainWorktree, "the session has its own new worktree on hermes/fix-the-flaky-login-test");
  assert(samePath(rec1.cwd, wt.worktreePath) && !samePath(rec1.cwd, repo), "the agent runs inside that worktree, not the project folder");
  assert(worktrees().some((w) => w.branch === "hermes/fix-the-flaky-login-test" && samePath(w.path, wt.worktreePath)), "git lists the new worktree on that branch");
  await bridge.waitForTerminal(taskSession, /prompt: Fix the flaky login test/, { timeoutMs: 20_000 });
  log("  the terminal shows the agent received the task");
  const launches = JSON.parse((await invoke(bridge, "get_settings")).task_launches || "[]");
  assert(launches.length === 1 && launches[0].track === "Quick" && launches[0].doneWhen[0] === "npm test" && launches[0].sessionId === taskSession, "the launch is recorded with its track and done-when line");
  await bridge.screenshot(join(evidenceDir, "03-task-running.png"));

  log("step 4: a signed-out agent disables Launch and offers Sign in");
  setFake("auth-claude", "out");
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "Second task");
  await bridge.waitFor("the signed-out row", `return e2e.all('.task-launcher-block[data-kind="signed-out"]').length === 1;`, { timeoutMs: 30_000 });
  st = await launcherState(bridge);
  log(`  launcher: ${JSON.stringify(st)}`);
  assert(/f15-repo/.test(st.repo), `it opens on the repository of the active session (${st.repo})`);
  assert(st.launchDisabled, "Launch is disabled");
  assert(/signed out/.test(st.blocks[0].text), `the row says so: "${st.blocks[0].text}"`);
  const countBefore = records().length;
  await pressEnterInTask(bridge);
  await sleep(2000);
  assert(records().length === countBefore && (await bridge.exists(".task-launcher-sheet")), "Enter starts nothing while the agent is signed out");
  await bridge.screenshot(join(evidenceDir, "04-signed-out.png"));
  before = await bridge.terminalIds();
  await bridge.click(".task-launcher-sign-in");
  const [signInSession] = await newTerminals(bridge, before, 1, "a terminal for signing in");
  const signInRec = (await waitForRecords(countBefore + 1)).at(-1);
  assert(signInRec.prompt === null || signInRec.prompt === undefined, "Sign in runs the CLI itself, with no task");
  assert(await bridge.eval(`return e2e.all(".session-item").some((el) => el.innerText.includes("Sign in to Claude Code"));`), "the sign-in terminal is named for it");
  log(`  sign-in session: ${signInSession}`);
  setFake("auth-claude", "in");

  log("step 5: an existing branch blocks until a free one is used; the same task on a second agent, Full track");
  // Back on the task's session so the launcher opens on the repository.
  await bridge.clickWhenReady(`
    const item = e2e.all(".session-item").find((el) => el.innerText.includes(${JSON.stringify(TASK)}));
    return e2e.click(e2e.must(item, "the task's session"));
  `);
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "Existing task");
  await expandOptions(bridge);
  // The same task again gets the next free branch by itself (QA-launcher-11).
  await bridge.waitFor("the next free branch", `return e2e.first(".task-launcher-branch")?.value === "hermes/existing-task-2";`, { timeoutMs: 20_000 });
  st = await launcherState(bridge);
  assert(!st.blocks.some((b) => b.kind === "branch-exists"), "hermes/existing-task exists, so the task gets hermes/existing-task-2 by itself and nothing blocks");
  // A branch typed by hand that exists still blocks Launch with its own row.
  await typeInto(bridge, ".task-launcher-branch", "hermes/existing-task");
  await bridge.waitFor("the branch-exists row", `return e2e.all('.task-launcher-block[data-kind="branch-exists"]').length === 1;`, { timeoutMs: 20_000 });
  st = await launcherState(bridge);
  assert(st.branch === "hermes/existing-task" && st.launchDisabled, "a typed hermes/existing-task exists, so Launch is disabled");
  await bridge.click(".task-launcher-use-branch");
  await bridge.click(".task-launcher-also-toggle");
  await bridge.waitFor("the second agent picker", `return !!e2e.first(".task-launcher-also-agent");`);
  await chooseOption(bridge, ".task-launcher-also-agent", "codex");
  await bridge.clickWhenReady(`
    const box = e2e.must(e2e.first(".task-launcher-feature-box"), "Track as a feature");
    return box.checked ? true : e2e.click(box);
  `);
  await bridge.waitFor("the doctor to clear claude", `return !e2e.first('.task-launcher-block[data-kind="signed-out"]');`, { timeoutMs: 30_000 });
  st = await launcherState(bridge);
  log(`  launcher: ${JSON.stringify(st)}`);
  assert(st.branch === "hermes/existing-task-2" && st.blocks.length === 0 && !st.launchDisabled, "the suggested free branch unblocks Launch");
  before = await bridge.terminalIds();
  const recsBefore = records().length;
  await bridge.click(".task-launcher-launch");
  const pair = await newTerminals(bridge, before, 2, "two new terminals");
  const recs = (await waitForRecords(recsBefore + 2)).slice(recsBefore);
  log(`  records: ${JSON.stringify(recs.map((r) => ({ argv: r.argv, cwd: r.cwd })))}`);
  // Tracked as a feature: the first prompt is the track's (the task, then the
  // questions phase and its gate), so the agents plan before any code.
  // (Windows hands it over on one line: its line breaks become spaces.)
  const trackPrompt = (r) => String(r.argv.find((a) => String(a).startsWith("Hermes Feature Track (Full)")) ?? "").replace(/\s+/g, " ");
  assert(recs.every((r) => trackPrompt(r).includes(": Existing task Phases:") && /Current phase: questions \(1 of 6\)/.test(trackPrompt(r))), "both agents got the feature track's first prompt, with the task");
  const wtPair = [];
  for (const id of pair) wtPair.push(await invoke(bridge, "git_session_worktree_info", { sessionId: id, projectId: pid }));
  const branches = wtPair.map((w) => w.branchName).sort();
  assert(JSON.stringify(branches) === JSON.stringify(["hermes/existing-task-2", "hermes/existing-task-2-codex"]), `each agent has its own branch (${branches})`);
  assert(!samePath(wtPair[0].worktreePath, wtPair[1].worktreePath), "and its own worktree");
  for (const w of wtPair) {
    const file = join(w.worktreePath, ".hermes", "features", "existing-task", "feature.md");
    assert(existsSync(file) && /track: Full/.test(readFileSync(file, "utf8")), `the Full track wrote ${file.replace(work, "<work>")}`);
  }
  // The second agent opens beside the first: two panes, both on the task.
  await bridge.waitFor("the two agents side by side", `
    const labels = e2e.all(".split-pane .split-pane-label > span:first-child").map((el) => el.textContent.trim());
    return labels.filter((l) => l === "Existing task").length === 2;
  `, { timeoutMs: 20_000 });
  const panes = await bridge.eval(`return e2e.all(".split-pane .split-pane-label > span:first-child").map((el) => el.textContent.trim());`);
  log(`  panes on screen: ${JSON.stringify(panes)}`);
  await bridge.screenshot(join(evidenceDir, "05-two-agents.png"));

  log("step 6: a folder that is not a git repository blocks Launch");
  await openLauncher(bridge);
  await setRepo(bridge, plain);
  await typeInto(bridge, ".task-launcher-task", "Anything");
  await bridge.waitFor("the not-a-repository row", `return e2e.all('.task-launcher-block[data-kind="not-git"]').length === 1;`, { timeoutMs: 20_000 });
  st = await launcherState(bridge);
  assert(st.launchDisabled, "Launch is disabled outside a repository");
  await bridge.screenshot(join(evidenceDir, "06-not-git.png"));

  log("step 7: the launcher's Advanced link and ⌘⇧N open the old creator, which offers SSH");
  await bridge.click(".task-launcher-advanced");
  await bridge.waitFor("the advanced creator", `return !!e2e.first(".session-creator") && !e2e.first(".task-launcher-sheet");`, { timeoutMs: 20_000 });
  assert(await bridge.exists(".session-creator-ssh-link"), "the advanced creator still offers SSH");
  await bridge.click(".session-creator .session-creator-close");
  await bridge.waitFor("the creator to close", `return !e2e.first(".session-creator");`, { timeoutMs: 10_000 });
  await pressAppShortcut(bridge, { action: "file.new-session-advanced", pcKey: "h" });
  await bridge.waitFor("the advanced creator from its own shortcut", `return !!e2e.first(".session-creator") && !e2e.first(".task-launcher-sheet");`, { timeoutMs: 20_000 });
  assert(await bridge.exists(".session-creator-ssh-link"), "⌘⇧N opens the creator with SSH");
  await bridge.screenshot(join(evidenceDir, "07-advanced.png"));
  await bridge.click(".session-creator .session-creator-close");
  await bridge.waitFor("the creator to close", `return !e2e.first(".session-creator");`, { timeoutMs: 10_000 });

  log("step 8: with no launch helper next to the app, the agent starts without the task and the person is told");
  const hiPath = join(outDir(), "bin", onWindows ? "hi.exe" : "hi");
  const hiAside = `${hiPath}.aside`;
  renameSync(hiPath, hiAside);
  try {
    await openLauncher(bridge);
    await setRepo(bridge, repo);
    await typeInto(bridge, ".task-launcher-task", "Helper missing task");
    // The usual combination is now the last one (a second agent, a feature): one agent here.
    await pickAgent(bridge, "claude");
    await expandOptions(bridge);
    await bridge.clickWhenReady(`
      const also = e2e.first(".task-launcher-also-toggle");
      if (also && also.getAttribute("aria-pressed") === "true") e2e.click(also);
      const box = e2e.first(".task-launcher-feature-box");
      if (box && box.checked) e2e.click(box);
      return e2e.first(".task-launcher-also-toggle")?.getAttribute("aria-pressed") === "false";
    `);
    await bridge.waitFor("Launch to be enabled", `return !e2e.first(".task-launcher-launch")?.disabled;`, { timeoutMs: 30_000 });
    before = await bridge.terminalIds();
    const recsBeforeFallback = records().length;
    await pressEnterInTask(bridge);
    await newTerminals(bridge, before, 1, "the fallback terminal");
    const toast = await bridge.waitFor("the task-not-delivered notice", `
      const t = e2e.all(".toast-message").map((el) => e2e.norm(el.innerText)).find((m) => m.includes("started without your task"));
      return t || null;
    `, { timeoutMs: 30_000 });
    log(`  toast: "${toast}"`);
    assert(toast.startsWith("Claude Code started without your task"), "the notice names the agent");
    assert(toast.includes("clipboard") || toast.includes("Helper missing task"), "the task is on the clipboard, or shown in the notice");
    const fallbackRec = (await waitForRecords(recsBeforeFallback + 1)).at(-1);
    log(`  fake claude record: ${JSON.stringify({ argv: fallbackRec.argv, prompt: fallbackRec.prompt })}`);
    assert(!fallbackRec.argv.some((a) => String(a).includes("Helper missing task")), "the typed command did not carry the task (the notice is not a false alarm)");
    await bridge.screenshot(join(evidenceDir, "08-task-not-delivered.png"));
  } finally {
    renameSync(hiAside, hiPath);
  }
  await app.stop();

  // ── run 3: low disk ──────────────────────────────────────────────
  log("run 3: with 2 GB free, a low-disk row blocks Launch");
  app = await launch(3, { env: { HERMES_E2E_FREE_SPACE_BYTES: String(2e9) } });
  await waitForReturningLaunch(app.bridge);
  await openLauncher(app.bridge);
  await setRepo(app.bridge, repo);
  await typeInto(app.bridge, ".task-launcher-task", "Low disk task");
  await app.bridge.waitFor("the low-disk row", `return e2e.all('.task-launcher-block[data-kind="low-disk"]').length === 1;`, { timeoutMs: 20_000 });
  st = await launcherState(app.bridge);
  log(`  launcher: ${JSON.stringify(st)}`);
  assert(st.launchDisabled && /2\.0 GB/.test(st.blocks.find((b) => b.kind === "low-disk").text), "Launch is disabled and the row says how much is free");
  await app.bridge.screenshot(join(evidenceDir, "09-low-disk.png"));
  await app.stop();
  app = null;
} catch (err) {
  failed = true;
  log(`ERROR: ${err.stack || err.message || err}`);
  if (app) {
    try {
      await app.bridge.screenshot(join(evidenceDir, "failure.png"));
    } catch {
      /* no screenshot */
    }
  }
} finally {
  if (app) {
    try {
      await app.stop();
    } catch {
      /* already gone */
    }
  }
  if (undoRegistryPath) {
    try {
      undoRegistryPath();
    } catch (e) {
      log(`could not restore the registry Path: ${e.message}`);
    }
  }
  if (!failed) {
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      if (homeDir) rmSync(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* best effort */
    }
  }
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
