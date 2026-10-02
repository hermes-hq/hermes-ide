// Shared steps for the QA-launcher-* scenarios: the regressions the QA pass
// found in the ⌘N task launcher, its accounts, presets and queue, the
// first-run welcome and the overlays around them.
//
// Each scenario runs a fresh install in a private home with 2.0's real flag
// defaults (no test overrides), fake `claude` / `codex` (and `agy` for the
// account scenarios) on the app's PATH, invented fixtures (a demo repository
// with a few branches), and the disk guard told there is room for worktrees
// (HERMES_E2E_FREE_SPACE_BYTES). No real CLI, account or user folder is
// ever touched.
//
// A scenario's checks are collected: every one is logged and the scenario
// fails at the end if any did not hold, so one run says everything that is
// wrong.

import { mkdirSync, rmSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { createLogger, finishScenario, launchApp, outDir, skipScenario, sleep } from "./harness.mjs";
import { completeTaskWelcome, dismissWhatsNew, launcherFixtures, onWindows } from "./launcher-steps.mjs";
import { fakeEnv, registryPath, removeWork, setFake, setFakeMode, setupFakes } from "./cap-steps.mjs";

/** The disk guard sees plenty of room: a worktree launch is never stopped by the machine running the test. */
export const ROOMY_DISK = { HERMES_E2E_FREE_SPACE_BYTES: "200000000000" };

export function qaContext(name) {
  const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", name);
  mkdirSync(evidenceDir, { recursive: true });
  const logFile = join(evidenceDir, "scenario.log");
  rmSync(logFile, { force: true });
  const log = createLogger(logFile);
  const problems = [];
  const check = (condition, message) => {
    if (condition) log(`  ok — ${message}`);
    else {
      log(`  FAILED — ${message}`);
      problems.push(message);
    }
    return !!condition;
  };
  const assert = (condition, message) => {
    if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
    log(`  ok — ${message}`);
  };
  return { evidenceDir, log, check, assert, problems, startedAt: Date.now() };
}

/**
 * A QA scenario on the launcher fixtures (launcher-steps.mjs: launcher-repo
 * with main, develop and feature/inbox, other-repo, fake claude and codex).
 * `welcome`: finish the three-step welcome on launcher-repo first (the
 * default); false leaves the welcome up for the body. The body gets
 * { app, bridge, fx, relaunch(run), log, check, assert, evidenceDir }.
 */
export async function runLauncherQa(name, body, { welcome = true, env = {}, tag, before } = {}) {
  const ctx = qaContext(name);
  const { evidenceDir, log, problems, startedAt } = ctx;
  const fx = launcherFixtures(tag ?? name.replace(/^QA-launcher-/, "qa-").slice(0, 24), log);
  before?.(fx);
  if (onWindows && !fx.canEditRegistryPath) {
    fx.cleanup();
    skipScenario({ scenario: name, evidenceDir, reason: "Windows outside CI (the fake agents must be on a terminal's PATH)", log });
  }
  let app = null;
  let failed = false;
  let undoPath = null;
  try {
    log(`scenario: ${name}   platform: ${platform()}`);
    undoPath = fx.addFakeBinToRegistryPath();
    app = await fx.launch(evidenceDir, 1, { first: true, flagDefaults: {}, env: { ...ROOMY_DISK, ...env } });
    if (welcome) {
      await completeTaskWelcome(app.bridge, fx.repo);
    }
    const relaunch = async (run, more = {}) => {
      app = await fx.launch(evidenceDir, run, { flagDefaults: {}, env: { ...ROOMY_DISK, ...env, ...more } });
      return app;
    };
    await body({ ...ctx, app, bridge: app.bridge, fx, relaunch, current: () => app });
  } catch (err) {
    failed = true;
    log(`ERROR: ${err?.stack ?? err}`);
    try {
      if (app?.isRunning()) await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
    } catch {
      /* the window is gone */
    }
  } finally {
    try {
      if (app?.isRunning()) await app.stop();
    } catch (e) {
      log(`  (stop: ${e.message})`);
    }
    try {
      undoPath?.();
    } catch {
      /* best effort */
    }
    fx.cleanup();
  }
  if (problems.length) log(`PROBLEMS:\n  - ${problems.join("\n  - ")}`);
  finishScenario({ scenario: name, evidenceDir, failed: failed || problems.length > 0, startedAt, log, details: { problems } });
}

/**
 * A QA scenario on the account fixtures (cap-steps.mjs: one repository,
 * fake claude / codex / agy, and a profile root where Add account creates
 * its profile folders). The welcome is finished on the repository. The body
 * gets { app, bridge, f, log, check, assert, evidenceDir }.
 */
export async function runAccountsQa(name, body, { bins = ["claude"], env = {}, before } = {}) {
  const ctx = qaContext(name);
  const { evidenceDir, log, problems, startedAt } = ctx;
  const f = setupFakes(name.replace(/^QA-launcher-/, "qa").slice(0, 16), bins);
  const undoPath = registryPath(f, log);
  if (undoPath === null) {
    removeWork(f, log);
    skipScenario({ scenario: name, evidenceDir, reason: "Windows outside CI (the fake agents must be on a terminal's PATH)", log });
  }
  setFake(f, "version", "claude", "2.1.284");
  setFake(f, "version", "codex", "0.145.0");
  setFake(f, "version", "antigravity", "1.0.6");
  setFakeMode(f, "normal");
  before?.(f);
  let app = null;
  let failed = false;
  try {
    log(`scenario: ${name}   platform: ${platform()}`);
    const common = { runDir: join(evidenceDir, "run-1"), log, flagDefaults: {}, env: { ...fakeEnv(f), ...ROOMY_DISK, ...env } };
    app = onWindows ? await launchApp({ ...common, home: "real", resetData: true }) : await launchApp({ ...common, home: "private", homeDir: f.home });
    await completeTaskWelcome(app.bridge, f.repo);
    await body({ ...ctx, app, bridge: app.bridge, f });
  } catch (err) {
    failed = true;
    log(`ERROR: ${err?.stack ?? err}`);
    try {
      if (app?.isRunning()) await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
    } catch {
      /* the window is gone */
    }
  } finally {
    try {
      if (app?.isRunning()) await app.stop();
    } catch (e) {
      log(`  (stop: ${e.message})`);
    }
    try {
      undoPath?.();
    } catch {
      /* best effort */
    }
    removeWork(f, log);
  }
  if (problems.length) log(`PROBLEMS:\n  - ${problems.join("\n  - ")}`);
  finishScenario({ scenario: name, evidenceDir, failed: failed || problems.length > 0, startedAt, log, details: { problems } });
}

/** A menu bar action (what the native menu sends, on every OS). */
export const menuAction = (bridge, action) =>
  bridge.eval(`await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu-action", payload: { action: ${JSON.stringify(action)} } }); return true;`);

/**
 * Whether a fake agent started after `before` launch records: the launch
 * goes through the worktree, the shell and the helper first, which takes a
 * few seconds on a slow runner.
 */
export async function launchedSince(fx, before, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (fx.records().length <= before && Date.now() < deadline) await sleep(300);
  return fx.records().length > before;
}

/** Where the keyboard is: on the page itself, in the launcher sheet, or which element. */
export const focusState = (bridge) =>
  bridge.eval(`
    const a = document.activeElement;
    return {
      body: !a || a === document.body || a === document.documentElement,
      inSheet: !!a?.closest?.(".task-launcher-sheet"),
      task: a === e2e.first(".task-launcher-task"),
      cls: a ? a.tagName + "." + String(a.className).slice(0, 60) : null,
    };
  `);

/** Puts the keyboard on an element. */
export const focusOn = (bridge, selector) =>
  bridge.eval(`const el = e2e.must(e2e.first(${JSON.stringify(selector)}), ${JSON.stringify(selector)}); el.focus(); return document.activeElement === el;`);

/** The welcome's first two steps: the policy, then `repo` typed (or Skip). Leaves it on step 3. */
export async function welcomeToTaskStep(bridge, repo) {
  await bridge.waitFor("the welcome's agent check", `return e2e.first(".setup-dialog")?.getAttribute("data-step") === "agents" && e2e.first(".agent-doctor")?.getAttribute("data-loading") === "false";`, { timeoutMs: 60_000 });
  await bridge.clickWhenReady(`const box = e2e.must(e2e.first("#setup-policy-accept"), "policy"); return box.checked ? true : e2e.click(box);`);
  await bridge.waitFor("Continue", `return !e2e.first(".setup-continue").disabled;`);
  await bridge.click(".setup-continue");
  await bridge.waitFor("the repository step", `return e2e.first(".setup-dialog")?.getAttribute("data-step") === "repo";`, { timeoutMs: 20_000 });
  if (repo) {
    await typeValue(bridge, ".setup-repo-input", repo);
    await bridge.waitFor("the repository accepted", `return e2e.first(".setup-repo-state")?.getAttribute("data-git") === "true";`, { timeoutMs: 20_000 });
    await bridge.click(".setup-continue");
  } else {
    await bridge.click(".setup-skip");
  }
  await bridge.waitFor("the task step", `return e2e.first(".setup-dialog")?.getAttribute("data-step") === "task" && e2e.first(".setup-dialog .task-launcher")?.getAttribute("data-ready") === "true";`, { timeoutMs: 30_000 });
}

/** Types into a React-controlled field the way typing does. */
export const typeValue = (bridge, selector, value) =>
  bridge.eval(`
    const el = e2e.must(e2e.first(${JSON.stringify(selector)}), ${JSON.stringify(selector)});
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    el.focus();
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return el.value;
  `);

export { dismissWhatsNew, sleep };
