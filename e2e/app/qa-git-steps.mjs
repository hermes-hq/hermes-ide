// Shared steps for the QA-git-* scenarios: throwaway repositories with
// invented identities, fake agent CLIs on the app's PATH (tools/fake-agents),
// the ⌘N launcher, the session list, the Review Desk and the close dialogs,
// all driven through the real UI of the test app.
//
// Every launch fakes plenty of free disk (HERMES_E2E_FREE_SPACE_BYTES, test
// builds only): the low-disk guard must never be what makes a launch fail.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { REPO_ROOT, createLogger, finishScenario, launchApp, outDir, sleep } from "./harness.mjs";
import * as L from "./launcher-steps.mjs";

export { L, createLogger, finishScenario, launchApp, sleep };

export const onWindows = platform() === "win32";
export const FREE_SPACE = "200000000000";

export const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Hermes Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Hermes Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

/** git in `dir` (stdout, trimmed); throws with git's stderr on failure. */
export const gitIn = (dir, ...args) =>
  execFileSync("git", ["-C", dir, "-c", "protocol.file.allow=always", ...args], { env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export const tryGit = (dir, ...args) => {
  try {
    return { ok: true, out: gitIn(dir, ...args) };
  } catch (e) {
    return { ok: false, out: String(e.stderr || e.message) };
  }
};

/** A scenario's evidence folder, logger and soft checks. */
export function scenarioContext(name) {
  const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", name);
  rmSync(evidenceDir, { recursive: true, force: true });
  mkdirSync(evidenceDir, { recursive: true });
  const log = createLogger(join(evidenceDir, "scenario.log"));
  const problems = [];
  const check = (ok, msg) => {
    log(`  ${ok ? "ok" : "PROBLEM"} — ${msg}`);
    if (!ok) problems.push(msg);
    return ok;
  };
  return { evidenceDir, log, problems, check, startedAt: Date.now() };
}

export function tmpWork(tag) {
  return realpathSync.native(mkdtempSync(join(tmpdir(), `hermes-e2e-qagit-${tag}-`)));
}

export function rmrf(p) {
  try {
    rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    /* best effort */
  }
}

export function makeRepo(path, { branch = "main", files = { "README.md": "# demo\n" } } = {}) {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", branch, path], { env: gitEnv });
  gitIn(path, "config", "user.name", "Hermes Test");
  gitIn(path, "config", "user.email", "test@example.com");
  gitIn(path, "config", "commit.gpgsign", "false");
  // The scenarios' git skips the system config, the app's does not (Git
  // for Windows sets core.autocrlf there): keep LF for both.
  gitIn(path, "config", "core.autocrlf", "false");
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(path, f, ".."), { recursive: true });
    writeFileSync(join(path, f), c);
  }
  if (Object.keys(files).length > 0) {
    gitIn(path, "add", ".");
    gitIn(path, "commit", "-q", "-m", "initial");
  }
  return path;
}

export function worktreesOf(repo) {
  const list = [];
  let cur = null;
  for (const line of gitIn(repo, "worktree", "list", "--porcelain").split(/\r?\n/)) {
    if (line.startsWith("worktree ")) list.push((cur = { path: line.slice(9), branch: null, head: null, detached: false }));
    else if (line.startsWith("HEAD ") && cur) cur.head = line.slice(5);
    else if (line.startsWith("branch ") && cur) cur.branch = line.slice(7).replace("refs/heads/", "");
    else if (line === "detached" && cur) cur.detached = true;
  }
  return list;
}

/** Fake claude/codex on PATH (and nothing real), like launcher-steps does. */
export function fakeAgents(work) {
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
  const isRealAgentDir = (dir) => ["claude", "claude.exe", "claude.cmd", "codex", "codex.exe", "codex.cmd"].some((n) => existsSync(join(dir, n)));
  process.env.PATH = [fakeBin, ...(process.env.PATH || "").split(delimiter).filter((d) => d && !isRealAgentDir(d))].join(delimiter);
  for (const name of Object.keys(process.env)) if (name.startsWith("ANTHROPIC_") || name.startsWith("OPENAI_")) delete process.env[name];
  const records = () =>
    readdirSync(recordDir)
      .filter((f) => f.startsWith("launch-"))
      .sort()
      .map((f) => JSON.parse(readFileSync(join(recordDir, f), "utf8")));
  return { fakeBin, recordDir, setFake, records };
}

/** Launch the test app with a private home, plenty of (faked) free disk and the real flag defaults. */
export function launch({ evidenceDir, run = 1, homeDir, log, env = {}, fakes, flagDefaults = {} }) {
  return launchApp({
    runDir: join(evidenceDir, `run-${run}`),
    log,
    ...(onWindows ? { home: "real", resetData: run === 1 } : { home: "private", homeDir }),
    flagDefaults,
    env: {
      HERMES_E2E_FREE_SPACE_BYTES: FREE_SPACE,
      ...(fakes ? { HERMES_FAKE_DIR: fakes.recordDir, HERMES_E2E_AGENT_PATH: fakes.fakeBin } : {}),
      ...env,
    },
  });
}

/**
 * The launcher fixtures (a repository on main with develop one commit ahead
 * and feature/inbox, fake agents on PATH) and a launch that fakes plenty of
 * free disk.
 */
export function gitFixtures(tag, log) {
  const fx = L.launcherFixtures(`qagit-${tag}`, log);
  const launchFx = (evidenceDir, run = 1, { env = {}, ...rest } = {}) =>
    fx.launch(evidenceDir, run, { first: run === 1, flagDefaults: {}, env: { HERMES_E2E_FREE_SPACE_BYTES: FREE_SPACE, ...env }, ...rest });
  return { ...fx, launchFx };
}

/** The session's worktree link (path and branch). */
export const worktreeInfo = (bridge, sessionId, projectId) => invoke(bridge, "git_session_worktree_info", { sessionId, projectId });

/** git in a worktree with a test identity. */
export const gitAs = (dir, ...args) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=Hermes Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
    env: gitEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

export const invoke = (bridge, cmd, args, timeoutMs = 30_000) =>
  bridge.eval(`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})});`, { timeoutMs });

export const invokeSafe = (bridge, cmd, args, timeoutMs = 30_000) =>
  bridge.eval(
    `try { return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})}) }; } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }`,
    { timeoutMs },
  );

export const toasts = (bridge) => bridge.eval(`return e2e.all(".toast").map((el) => e2e.norm(el.innerText));`);

/**
 * Launch a task through the ⌘N launcher.
 * where: "new-worktree" (default) | "existing-branch" | "current-checkout"
 * Returns { sessionId } once its terminal exists, { blocked } when Launch is
 * disabled, or { before } when `expectSession` is false.
 */
export async function launchTask(bridge, { task, where = "new-worktree", base, branch, existing, repo, log = () => {}, expectSession = true }) {
  await L.openLauncher(bridge);
  if (repo) await L.setRepo(bridge, repo);
  await L.typeInto(bridge, ".task-launcher-task", task);
  if (where !== "new-worktree" || base || branch) {
    await L.openChip(bridge, "where");
    await bridge.clickWhenReady(`
      const w = e2e.first('.task-launcher-menu [data-where="${where}"]');
      if (!w) return false;
      return w.getAttribute("aria-checked") === "true" ? true : e2e.click(w);
    `);
    await sleep(200);
    if (where === "new-worktree" && base) await L.chooseOption(bridge, ".task-launcher-menu .task-launcher-base", base);
    if (where === "new-worktree" && branch) await L.typeInto(bridge, ".task-launcher-menu .task-launcher-branch", branch);
    if (where === "existing-branch" && existing) await L.chooseOption(bridge, ".task-launcher-menu .task-launcher-existing", existing);
    await sleep(300);
  }
  await bridge
    .waitFor("Launch enabled or a blocking row", `const b = e2e.first(".task-launcher-launch"); return (b && !b.disabled) || e2e.all(".task-launcher-block").length > 0;`, { timeoutMs: 30_000 })
    .catch(() => {});
  await sleep(500);
  const st = await L.launcherState(bridge);
  log(`  launcher: where="${st.where}" blocks=${JSON.stringify(st.blocks)} launchDisabled=${st.launchDisabled}`);
  if (st.launchDisabled) return { blocked: st };
  const before = await bridge.terminalIds();
  await bridge.click(".task-launcher-launch");
  if (!expectSession) {
    await sleep(4000);
    return { before };
  }
  const ids = await L.newTerminals(bridge, before, 1, "the task's terminal", 40_000);
  await L.waitLauncherClosed(bridge).catch(() => {});
  return { sessionId: ids[0], state: st };
}

export async function showSessionsPanel(bridge) {
  await bridge.clickWhenReady(`
    const tab = e2e.all(".activity-bar-tab").find((b) => /SESSIONS/i.test(b.innerText) || /sessions/i.test(b.getAttribute("aria-label") || b.title || ""));
    if (!tab) return true;
    if (tab.classList.contains("activity-bar-tab-active")) return "open";
    return e2e.click(tab);
  `);
}

export async function sessionLabel(bridge, id) {
  const s = await invoke(bridge, "get_sessions");
  return (s.find((x) => x.id === id) || {}).label;
}

export async function selectSessionByLabel(bridge, label) {
  await showSessionsPanel(bridge);
  await bridge.clickWhenReady(`
    const item = e2e.all(".session-item").find((el) => el.innerText.includes(${JSON.stringify(label)}));
    return e2e.click(e2e.must(item, "session ${label}"));
  `);
  await sleep(300);
}

export async function openReviewDesk(bridge, label) {
  await selectSessionByLabel(bridge, label);
  if (!(await bridge.exists(".review-desk"))) await bridge.click('.session-subview-btn[title="Review Desk"]');
  await bridge.waitFor("the Review Desk", `return !!e2e.first(".review-desk");`, { timeoutMs: 20_000 });
}

/** Review Desk (or Git panel) → Land… → the sheet. */
export async function openLandSheet(bridge, label) {
  await selectSessionByLabel(bridge, label);
  if (await bridge.exists('.session-subview-btn[title="Review Desk"]')) {
    if (!(await bridge.exists(".review-desk"))) await bridge.click('.session-subview-btn[title="Review Desk"]');
    await bridge.waitFor("the Review Desk", `return !!e2e.first(".review-desk");`);
    await bridge.waitFor("the Land button", `return !!e2e.first(".review-desk .review-land-btn");`, { timeoutMs: 15_000 });
    await bridge.click(".review-desk .review-land-btn");
  } else {
    if (!(await bridge.exists(".session-git-panel"))) await bridge.click('.session-subview-btn[title="Git"]');
    await bridge.waitFor("the session Git panel", `return !!e2e.first(".session-git-panel");`);
    await bridge.waitFor("the Land button", `return !!e2e.first(".session-git-land-btn");`, { timeoutMs: 15_000 });
    await bridge.click(".session-git-land-btn");
  }
  await bridge.waitFor("the Land sheet to read the worktree", `
    return !!e2e.first(".land-sheet") && !!e2e.first('.land-sheet-option[data-mode="merge"]');
  `, { timeoutMs: 20_000 });
}

export function readLandSheet(bridge) {
  return bridge.eval(`
    const opt = (m) => {
      const el = e2e.first('.land-sheet-option[data-mode="' + m + '"]');
      return el ? { disabled: el.getAttribute("aria-disabled") === "true", text: e2e.norm(el.innerText), checked: !!el.querySelector("input")?.checked } : null;
    };
    return {
      title: e2e.norm(e2e.first(".land-sheet-title")?.innerText ?? ""),
      base: e2e.first("#land-sheet-base")?.value ?? null,
      baseNote: e2e.first(".land-sheet-base-note") ? e2e.norm(e2e.first(".land-sheet-base-note").innerText) : null,
      merge: opt("merge"),
      pr: opt("pr"),
      commit: opt("commit"),
      message: e2e.first(".land-sheet-message")?.value ?? null,
      text: e2e.norm(e2e.first(".land-sheet")?.innerText ?? "").slice(0, 2000),
    };
  `);
}

export async function closeSessionByLabel(bridge, label) {
  await showSessionsPanel(bridge);
  await bridge.clickWhenReady(`
    const item = e2e.all(".session-item").find((el) => el.innerText.includes(${JSON.stringify(label)}));
    const btn = e2e.must(item && item.querySelector(".session-item-close"), "close button of ${label}");
    return e2e.click(btn);
  `);
}

export async function confirmCloseIfAsked(bridge) {
  await sleep(500);
  if (await bridge.exists(".close-dialog")) await bridge.click(".close-dialog .close-dialog-btn-confirm");
}

export async function waitSessionGone(bridge, label, timeoutMs = 20_000) {
  await bridge.waitFor(`"${label}" to leave the session list`, `
    return !e2e.all(".session-item").some((el) => el.innerText.includes(${JSON.stringify(label)}) && !el.classList.contains("session-item-destroyed"));
  `, { timeoutMs });
}

export const dialogText = (bridge, selector = ".dirty-wt-modal") =>
  bridge.eval(`const d = e2e.first(${JSON.stringify(selector)}); return d ? e2e.norm(d.innerText) : null;`);

/** End the scenario: screenshots on failure, stop the app, clean up, write the result. */
export async function endScenario({ ctx, app, failed, error, cleanup, scenario }) {
  const { evidenceDir, log, problems, startedAt } = ctx;
  if (error) {
    log(`FAILED: ${error?.stack ?? error}`);
    try {
      if (app?.isRunning()) await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
    } catch {
      /* best effort */
    }
  }
  if (app?.isRunning()) await app.stop().catch(() => {});
  try {
    cleanup?.();
  } catch {
    /* best effort */
  }
  if (problems.length) log(`PROBLEMS:\n  - ${problems.join("\n  - ")}`);
  finishScenario({ scenario, evidenceDir, failed: failed || !!error || problems.length > 0, startedAt, log });
}
