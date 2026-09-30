// Shared steps for the task launcher scenarios (F15 launcher v2, presets,
// the keyboard-only path, the morning view): a throwaway git repository with
// a few branches, fake agent CLIs on the app's PATH (tools/fake-agents),
// their launch records, and the launcher driven through its real UI.
//
// No real account and no CLI installed on the machine is ever run: the
// doctor and every terminal only find the fakes.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { REPO_ROOT, launchApp, sleep } from "./harness.mjs";

export const onWindows = platform() === "win32";
// HERMES_E2E_PLATFORM=linux|win runs the frontend with that platform's key rules (test builds only).
export const onMac = platform() === "darwin" && !process.env.HERMES_E2E_PLATFORM;
/** The launcher's own chords: ⌘ on macOS, Ctrl elsewhere. */
export const MOD = onMac ? { metaKey: true } : { ctrlKey: true };

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Hermes Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Hermes Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

/**
 * The fixtures: a repository (main, develop one commit ahead, feature/inbox),
 * a second repository, fake `claude` and `codex` on PATH, and their records.
 */
export function launcherFixtures(tag, log) {
  const work = realpathSync.native(mkdtempSync(join(tmpdir(), `hermes-e2e-${tag}-`)));
  const makeRepo = (name, extra) => {
    const repo = join(work, name);
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { env: gitEnv, encoding: "utf8" }).trim();
    execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
    git("config", "user.name", "Hermes Test");
    git("config", "user.email", "test@example.com");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "README.md"), `# ${name}\n`);
    extra?.(repo, git);
    git("add", ".");
    git("commit", "-q", "-m", "initial");
    return { repo, git };
  };
  const main = makeRepo("launcher-repo", (repo) => {
    mkdirSync(join(repo, ".hermes"), { recursive: true });
    writeFileSync(join(repo, ".hermes", "worktree.toml"), 'done_when = ["npm test"]\n');
  });
  main.git("branch", "feature/inbox");
  main.git("checkout", "-q", "-b", "develop");
  writeFileSync(join(main.repo, "DEVELOP.md"), "only on develop\n");
  main.git("add", ".");
  main.git("commit", "-q", "-m", "develop work");
  main.git("checkout", "-q", "main");
  const other = makeRepo("other-repo");

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
      await sleep(150);
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
    for (const line of main.git("worktree", "list", "--porcelain").split(/\r?\n/)) {
      if (line.startsWith("worktree ")) list.push((cur = { path: line.slice(9), branch: null, head: null }));
      else if (line.startsWith("HEAD ") && cur) cur.head = line.slice(5);
      else if (line.startsWith("branch ") && cur) cur.branch = line.slice(7).replace("refs/heads/", "");
    }
    return list;
  }

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

  const homeDir = onWindows ? undefined : mkdtempSync(join(tmpdir(), `hermes-e2e-${tag}-home-`));
  /** Launches the test app against the same data every run (first: a fresh install). */
  function launch(evidenceDir, run, { first = false, env = {}, flagDefaults } = {}) {
    const runDir = join(evidenceDir, `run-${run}`);
    const common = { runDir, log, env: { HERMES_FAKE_DIR: recordDir, HERMES_E2E_AGENT_PATH: fakeBin, ...env }, ...(flagDefaults ? { flagDefaults } : {}) };
    return onWindows ? launchApp({ ...common, home: "real", resetData: first }) : launchApp({ ...common, home: "private", homeDir });
  }

  function cleanup() {
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      if (homeDir) rmSync(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* best effort */
    }
  }

  return {
    work,
    repo: main.repo,
    git: main.git,
    otherRepo: other.repo,
    fakeBin,
    recordDir,
    setFake,
    records,
    waitForRecords,
    samePath,
    worktrees,
    addFakeBinToRegistryPath,
    canEditRegistryPath,
    launch,
    cleanup,
  };
}

// ─── App steps ──────────────────────────────────────────────────────────

export const invoke = (bridge, cmd, args) =>
  bridge.eval(`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})});`);

export async function dismissWhatsNew(bridge) {
  await sleep(300);
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
}

/** The classic first-run welcome (the task-launcher welcome is off until the flag is set). */
export async function completeClassicOnboarding(bridge) {
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

export async function waitForReturningLaunch(bridge) {
  await bridge.waitFor("the app UI (returning launch)", `return !!e2e.first(".topbar, .activity-bar") && !e2e.first(".onboarding-backdrop, .setup-backdrop");`, { timeoutMs: 30_000 });
  await dismissWhatsNew(bridge);
}

/**
 * A File-menu shortcut. macOS: the native menu's action (what the menu sends
 * when its key equivalent is pressed). Windows/Linux: the key chord itself.
 */
export async function pressAppShortcut(bridge, { action, pcKey }) {
  if (onMac) {
    const r = await bridge.eval(`
      try {
        await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu-action", payload: { action: ${JSON.stringify(action)} } });
        return true;
      } catch (e) { return String(e); }
    `);
    if (r !== true) throw new Error(`the File menu did not deliver ${action}: ${r}`);
  } else {
    await bridge.eval(`
      const target = document.activeElement || document.body;
      target.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(pcKey)}, code: "Key" + ${JSON.stringify(pcKey.toUpperCase())}, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
      return true;
    `);
  }
}

/** ⌘N: the launcher, settled on its starting choice. */
export async function openLauncher(bridge) {
  await pressAppShortcut(bridge, { action: "file.new-session", pcKey: "n" });
  await bridge.waitFor("the task launcher (not the old creator)", `
    if (e2e.first(".session-creator")) throw new Error("the old New Session creator opened instead of the task launcher");
    return !!e2e.first(".task-launcher-sheet .task-launcher");
  `, { timeoutMs: 20_000 });
  await bridge.waitFor("the launcher's starting choice", `return e2e.first(".task-launcher")?.getAttribute("data-ready") === "true";`, { timeoutMs: 30_000 });
}

/** Types into a React-controlled field the way typing does. */
export const typeInto = (bridge, selector, value) =>
  bridge.eval(`
    const el = e2e.must(e2e.first(${JSON.stringify(selector)}), ${JSON.stringify(selector)});
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    el.focus();
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return el.value;
  `);

/**
 * Chooses an option of a select (once the option is there), as picking it
 * does. The control set's Select (a combobox) is opened with a click and the
 * option clicked in its list, the way the mouse does; a native select gets
 * its value and a change event.
 */
export const chooseOption = (bridge, selector, value) =>
  bridge.waitFor(`the option ${value} of ${selector}`, `
    const el = e2e.first(${JSON.stringify(selector)});
    if (!el) return false;
    if (el.getAttribute("role") === "combobox") {
      if (el.getAttribute("data-value") === ${JSON.stringify(value)} && el.getAttribute("aria-expanded") !== "true") return true;
      if (el.getAttribute("aria-expanded") !== "true") { e2e.click(el); return false; }
      const list = document.getElementById(el.getAttribute("aria-controls"));
      const opt = list && [...list.querySelectorAll('[role="option"]')].find((o) => o.getAttribute("data-value") === ${JSON.stringify(value)});
      if (!opt || opt.getAttribute("aria-disabled") === "true") return false;
      e2e.click(opt);
      return false;
    }
    if (![...el.options].some((o) => o.value === ${JSON.stringify(value)})) return false;
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.value === ${JSON.stringify(value)};
  `);

/** A key pressed while `selector` has the focus (a key event, as the keyboard sends it). */
export const pressKey = (bridge, selector, key, mods = {}) =>
  bridge.eval(`
    const el = e2e.must(e2e.first(${JSON.stringify(selector)}), ${JSON.stringify(selector)});
    el.focus();
    const ev = new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true, ...${JSON.stringify(mods)} });
    el.dispatchEvent(ev);
    return document.activeElement ? (document.activeElement.getAttribute("data-chip") || document.activeElement.className || document.activeElement.tagName) : null;
  `);

/** A key pressed on whatever has the focus now. */
export const pressKeyOnFocus = (bridge, key, mods = {}) =>
  bridge.eval(`
    const el = document.activeElement || document.body;
    el.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true, ...${JSON.stringify(mods)} }));
    const now = document.activeElement;
    return now ? { chip: now.getAttribute("data-chip"), mode: now.getAttribute("data-mode"), model: now.getAttribute("data-model-id"), cls: now.className, tag: now.tagName } : null;
  `);

/** Opens a chip's menu (when closed). */
export async function openChip(bridge, name) {
  await bridge.waitFor(`the ${name} chip`, `
    const chip = e2e.first('[data-chip="${name}"]');
    if (!chip || chip.disabled) return false;
    if (e2e.first('.task-launcher-menu[data-menu="${name}"]')) return true;
    return e2e.click(chip);
  `);
  await bridge.waitFor(`the ${name} menu`, `return !!e2e.first('.task-launcher-menu[data-menu="${name}"]');`);
}

/** Picks an item in a chip's menu: opens the menu, clicks the item. */
export async function pickInMenu(bridge, chip, itemSelector) {
  await openChip(bridge, chip);
  await bridge.waitFor(`${itemSelector} in the ${chip} menu`, `
    const item = e2e.first('.task-launcher-menu ${itemSelector}');
    return item && !item.disabled ? e2e.click(item) : false;
  `);
}

export async function setRepo(bridge, path) {
  await openChip(bridge, "project");
  await typeInto(bridge, ".task-launcher-repo", path);
}

/** + options open. */
export async function expandOptions(bridge) {
  await bridge.clickWhenReady(`
    if (e2e.first(".task-launcher-options")) return true;
    return e2e.click(e2e.must(e2e.first(".task-launcher-expand"), "+ options"));
  `);
  await bridge.waitFor("the options", `return !!e2e.first(".task-launcher-options");`);
}

/** What the launcher shows now. */
export const launcherState = (bridge) =>
  bridge.eval(`
    const chip = (n) => e2e.norm(e2e.first('[data-chip="' + n + '"]')?.innerText ?? "");
    return {
      agent: chip("agent"),
      project: chip("project"),
      where: chip("where"),
      approval: chip("approval"),
      approvalDanger: !!e2e.first('[data-chip="approval"]')?.classList.contains("danger"),
      model: chip("model"),
      effort: chip("effort"),
      effortDisabled: !!e2e.first('[data-chip="effort"]')?.disabled,
      task: e2e.first(".task-launcher-task")?.value ?? null,
      preview: e2e.norm(e2e.first(".task-launcher-command")?.textContent ?? ""),
      blocks: e2e.all(".task-launcher-block").map((b) => ({ kind: b.getAttribute("data-kind"), text: e2e.norm(b.innerText) })),
      presets: e2e.all(".task-launcher-preset").map((b) => ({ name: e2e.norm(b.innerText), selected: b.classList.contains("selected") })),
      fallback: e2e.first(".task-launcher-fallback") ? e2e.all(".task-launcher-fallback li").map((l) => ({ field: l.getAttribute("data-field"), text: e2e.norm(l.innerText) })) : null,
      suggest: e2e.norm(e2e.first(".task-launcher-suggest")?.innerText ?? ""),
      launched: e2e.norm(e2e.first(".task-launcher-launched")?.innerText ?? ""),
      launchDisabled: !!e2e.first(".task-launcher-launch")?.disabled,
      open: !!e2e.first(".task-launcher-sheet"),
    };
  `);

export async function waitLaunchEnabled(bridge) {
  await bridge.waitFor("Launch to be enabled", `
    const b = e2e.first(".task-launcher-launch");
    if (!b) throw new Error("the launcher is gone");
    return !b.disabled;
  `, { timeoutMs: 30_000 });
}

export async function newTerminals(bridge, before, count, what, timeoutMs = 30_000) {
  return bridge.waitFor(what, `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
    return ids.length >= ${count} ? ids : null;
  `, { timeoutMs });
}

/** The session list's text for a session label. */
export const hasSessionNamed = (bridge, label) =>
  bridge.eval(`return e2e.all(".session-item").some((el) => el.innerText.includes(${JSON.stringify(label)}));`);
