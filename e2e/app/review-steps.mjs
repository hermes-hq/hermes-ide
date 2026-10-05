// Shared steps of the QA-review-* scenarios: a throwaway repository, fake
// `claude` / `codex` first on PATH, a task launched from the launcher, the
// Track panel, the Review Desk and the turn ledger, all through the real UI.
//
// Every scenario keeps its own evidence folder and collects its failures
// instead of stopping at the first one, so one run says everything that is
// still wrong.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { REPO_ROOT, appBinaryPath, createLogger, launchApp, outDir, sleep } from "./harness.mjs";
import * as L from "./launcher-steps.mjs";
import { registryPath } from "./cap-steps.mjs";

export { L, sleep };
export const onWindows = platform() === "win32";

export const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Hermes Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Hermes Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};
delete gitEnv.HERMES_AGENT;

/** The bundled `hi` next to the test app. */
export const HI = join(dirname(appBinaryPath()), onWindows ? "hi.exe" : "hi");

/** Evidence folder, logger and a collecting assert for one scenario. */
export function scenarioContext(name) {
  const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", name);
  rmSync(evidenceDir, { recursive: true, force: true });
  mkdirSync(evidenceDir, { recursive: true });
  const log = createLogger(join(evidenceDir, "scenario.log"));
  const failures = [];
  const check = (cond, msg) => {
    if (cond) log(`  ok — ${msg}`);
    else {
      log(`  FAIL — ${msg}`);
      failures.push(msg);
    }
  };
  return { evidenceDir, log, failures, check, startedAt: Date.now() };
}

export function mkWork(tag) {
  return realpathSync.native(mkdtempSync(join(tmpdir(), `hermes-e2e-qa-${tag}-`)));
}

/** A repository on `main` with README.md and `files`, one commit. */
export function mkRepo(dir, files = {}) {
  mkdirSync(dir, { recursive: true });
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { env: gitEnv, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: gitEnv });
  git("config", "user.name", "Hermes Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return { repo: dir, git };
}

/** Fake claude/codex first on PATH (real ones removed from it). */
export function fakeAgents(work, { mode = "prompts" } = {}) {
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
  setFake("mode", mode);
  const isRealAgentDir = (dir) => ["claude", "claude.exe", "claude.cmd", "codex", "codex.exe", "codex.cmd", "agy"].some((n) => existsSync(join(dir, n)));
  process.env.PATH = [fakeBin, ...(process.env.PATH || "").split(delimiter).filter((d) => d && !isRealAgentDir(d))].join(delimiter);
  for (const name of Object.keys(process.env)) if (name.startsWith("ANTHROPIC_") || name.startsWith("OPENAI_")) delete process.env[name];
  const records = () =>
    readdirSync(recordDir)
      .filter((f) => f.startsWith("launch-"))
      .sort()
      .map((f) => JSON.parse(readFileSync(join(recordDir, f), "utf8")));
  return { fakeBin, recordDir, setFake, records, env: { HERMES_FAKE_DIR: recordDir, HERMES_E2E_AGENT_PATH: fakeBin } };
}

export const invoke = (bridge, cmd, args) =>
  bridge.eval(`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})});`, { timeoutMs: 60_000 });

/** ⌘N launcher → a task in `repo` with fake claude; returns the new session id. */
export async function launchTask(bridge, repo, task, { approval = "acceptEdits", track = false, checks = [], currentCheckout = false } = {}) {
  await L.openLauncher(bridge);
  await L.setRepo(bridge, repo);
  await L.typeInto(bridge, ".task-launcher-task", task);
  await L.pickInMenu(bridge, "agent", '[data-agent-id="claude"]');
  await L.pickInMenu(bridge, "approval", `[data-mode="${approval}"]`);
  if (track || checks.length || currentCheckout) await L.expandOptions(bridge);
  if (currentCheckout) await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.first('[data-where="current-checkout"]'), "current checkout"));`);
  for (const cmd of checks) {
    const had = await bridge.eval(`return e2e.all(".task-launcher-check-input").length;`);
    await bridge.click(".task-launcher-check-add");
    // The new check's field renders after the click: wait for it rather than for a fixed time.
    await bridge.waitFor("the new check's field", `return e2e.all(".task-launcher-check-input").length > ${had};`, { timeoutMs: 10_000 });
    await bridge.eval(
      `const els = e2e.all(".task-launcher-check-input"); const el = els[els.length - 1]; el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(cmd)}); el.dispatchEvent(new Event("input", { bubbles: true })); return el.value;`,
    );
  }
  if (track)
    await bridge.eval(
      `const cb = [...document.querySelectorAll(".task-launcher-options input[type=checkbox]")].find((c) => c.closest("label")?.innerText.includes("Track as a feature")); if (!cb.checked) e2e.click(cb); return cb.checked;`,
    );
  try {
    await L.waitLaunchEnabled(bridge);
  } catch (e) {
    throw new Error(`${e.message}\nlauncher: ${JSON.stringify(await L.launcherState(bridge).catch(() => null))}`);
  }
  const before = await bridge.terminalIds();
  await bridge.click(".task-launcher-launch");
  await L.waitLauncherClosed(bridge);
  const [sid] = await L.newTerminals(bridge, before, 1, "the task terminal");
  return sid;
}

/** The working directory of a session (its worktree). */
export const sessionCwd = (bridge, sid) =>
  bridge.eval(`return (await window.__TAURI_INTERNALS__.invoke("get_sessions")).find((s) => s.id === ${JSON.stringify(sid)})?.working_directory ?? null;`).catch(() => null);

export const toastTexts = (bridge) => bridge.eval(`return e2e.all(".toast-message").map((t) => e2e.norm(t.innerText));`);

export const trackPanelAttr = (bridge, name) => bridge.eval(`return e2e.first("[data-testid=track-panel]")?.getAttribute(${JSON.stringify(name)}) ?? null;`);

export async function openReviewDesk(bridge) {
  if (!(await bridge.exists(".review-desk"))) {
    await bridge.eval(`await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu-action", payload: { action: "view.git-panel" } }); return true;`);
  }
  await bridge.waitFor("the Review Desk", `return e2e.first(".review-desk")?.getAttribute("data-loading") === "0";`, { timeoutMs: 20_000 });
}

/**
 * One fake-agent turn: `work <ms>` keeps the agent on its turn while
 * `during()` writes files as the agent; waits for the ledger to record it.
 */
export async function agentTurn(bridge, sid, during, { ms = 2500 } = {}) {
  const count = () => bridge.eval(`return (await window.__TAURI_INTERNALS__.invoke("list_turns", { sessionId: ${JSON.stringify(sid)} })).length;`);
  const n0 = await count();
  // The times of the prompt and of the agent's edits (ms), next to the
  // turn ledger's own (its debug lines in the app log).
  const stamp = (what) => console.log(`[agentTurn] ${what} at ${Date.now()}`);
  stamp("typing the prompt");
  await bridge.typeInTerminal(sid, `work ${ms}\n`);
  stamp("prompt typed");
  await sleep(700);
  during?.();
  stamp("agent's edits written");
  await bridge.waitFor(
    "the turn to be recorded",
    `return (await window.__TAURI_INTERNALS__.invoke("list_turns", { sessionId: ${JSON.stringify(sid)} })).length > ${n0};`,
    { timeoutMs: 30_000 },
  );
  // Let the turn end settle (the ledger may record before the hook's echo).
  await sleep(ms);
}

/**
 * A fake-claude task launched from the launcher in a fresh repository (a
 * Full track unless `track: false`), the Track panel open when it is one.
 */
export async function taskSetup(tag, evidenceDir, log, { checks = [], track = true, task = "Add an add function", files = {}, env = {} } = {}) {
  const work = mkWork(tag);
  const { repo, git } = mkRepo(join(work, "demo-repo"), { "math.js": "export const sub = (a, b) => a - b;\n", ...files });
  const fake = fakeAgents(work, { mode: "prompts" });
  // Windows terminals rebuild PATH from the registry (see N12): the fake
  // agents must be on it there too (CI runners only).
  const undoPath = registryPath(fake, log);
  try {
    return await taskSetupWith({ work, repo, git, fake, undoPath }, tag, evidenceDir, log, { checks, track, task, env });
  } catch (e) {
    undoPath?.();
    throw e;
  }
}

async function taskSetupWith({ work, repo, git, fake, undoPath }, tag, evidenceDir, log, { checks, track, task, env }) {
  const homeDir = onWindows ? undefined : join(work, "home");
  // A crowded developer disk would block the launcher's new worktree (it
  // wants 10 GB free); the test worktrees are a few KB.
  if (process.env.HERMES_E2E_FREE_SPACE_BYTES) env = { HERMES_E2E_FREE_SPACE_BYTES: process.env.HERMES_E2E_FREE_SPACE_BYTES, ...env };
  // The turn ledger says in the app log what it decided at every boundary.
  env = { RUST_LOG: process.env.RUST_LOG || "info,hermes_ide_lib::turn_ledger=debug", ...env };
  const app = await launchApp(
    onWindows
      ? { runDir: join(evidenceDir, "run-1"), log, home: "real", resetData: true, flagDefaults: null, env: { ...fake.env, ...env } }
      : { runDir: join(evidenceDir, "run-1"), log, home: "private", homeDir, flagDefaults: null, env: { ...fake.env, ...env } },
  );
  const { bridge } = app;
  await L.completeTaskWelcome(bridge, repo);
  const sid = await launchTask(bridge, repo, task, { approval: "acceptEdits", track, checks });
  const wt = await sessionCwd(bridge, sid);
  await bridge.waitForTerminal(sid, /fake-cli: ready/, { timeoutMs: 20_000 });
  if (track) {
    await bridge.clickByName("Track");
    await bridge.waitFor("the Track panel with the feature", `return !!e2e.first("[data-testid=track-panel]")?.getAttribute("data-phase");`, { timeoutMs: 15_000 });
  }
  const hi = (args, { agent = true } = {}) => {
    const hiEnv = { ...process.env };
    if (agent) hiEnv.HERMES_AGENT = "claude";
    else delete hiEnv.HERMES_AGENT;
    return execFileSync(HI, args, { cwd: wt, env: hiEnv, encoding: "utf8" });
  };
  const cleanup = async () => {
    if (app.isRunning()) await app.stop();
    undoPath?.();
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  return { work, repo, git, fake, app, bridge, sid, wt, hi, cleanup };
}

/** feature.md's path for the default task's slug. */
export const featureDir = (wt, slug = "add-an-add-function") => join(wt, ".hermes", "features", slug);

/**
 * One scenario: `body(ctx, setup)` runs with the evidence context; `setup`
 * is what taskSetup returned (call `ctx.setup(...)` to make it), cleaned up
 * at the end whatever happened. Ends with RESULT: PASS or FAIL.
 */
export async function runScenario(name, body) {
  const { finishScenario } = await import("./harness.mjs");
  const ctx = scenarioContext(name);
  let t = null;
  ctx.setup = async (tag, opts) => (t = await taskSetup(tag, ctx.evidenceDir, ctx.log, opts));
  try {
    await body(ctx);
  } catch (e) {
    ctx.failures.push(String(e?.stack ?? e));
    ctx.log(`ERROR ${e?.stack ?? e}`);
    try {
      await t?.bridge.screenshot(join(ctx.evidenceDir, "99-failure.png"));
    } catch {
      /* best effort */
    }
  } finally {
    await t?.cleanup();
  }
  finishScenario({ scenario: name, evidenceDir: ctx.evidenceDir, failed: ctx.failures.length > 0, startedAt: ctx.startedAt, log: ctx.log, details: { failures: ctx.failures } });
}

/** The Review Desk's by-turn view. */
export async function byTurn(bridge) {
  await bridge.eval(`e2e.click([...document.querySelectorAll(".review-desk button, .review-desk [role=radio]")].find((b) => b.innerText.trim() === "By turn")); return true;`);
  await sleep(600);
}

/** A file the person writes (no agent turn running). */
export function writeAs(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
