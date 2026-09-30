#!/usr/bin/env node
// Scenario N19: rate limits and handoff, on the REAL app with fake agents.
//
// A fake `claude` and a fake `codex` (tools/fake-agents/fake-cli.mjs) stand
// in for the real CLIs; no account is used. The fake Claude starts through
// the launch helper, edits two files in its worktree, reports its limit
// windows through the status line Hermes configured (five_hour used up,
// resetting at a time the scenario chose) and ends its turn on
// `StopFailure` with `error: "rate_limit"`, as Claude Code 2.1.283 does.
//
//   run 1  fresh install: welcome screens; turn launchHelper (the handoff's
//          launch-argument path) and honestIsolation (a branch per task) on;
//          quit (flags are read at startup)
//   run 2  1. a Claude task in a throwaway git repo, through the New Session
//             wizard: the session list shows "limited" with the reset time
//             the agent reported, exactly; the session's status is
//             `limited` (exact, from the Claude hook); the attention inbox
//             holds one `limit` item for it
//          2. "Hand off…" > Continue in Codex: a Codex session starts in the
//             SAME checkout and branch; its first prompt — the task (edited
//             in the dialog, with quotes) and the two changed files — reaches
//             the fake Codex as ONE launch argument with its line breaks
//             intact (typed into a shell it would have been split and
//             submitted early); the terminal shows only `hi run <id>`; the
//             new session sits under the Claude one in the list
//          3. "Hand off…" > Duplicate to Codex: a Codex session starts on the
//             child branch <claude branch>--codex, in a worktree of its own,
//             cut from the Claude branch (the Claude session's uncommitted
//             files are not there); it also sits under the Claude session
//          4. the limit resets (the fake reports `quota_auto_resume_fired`):
//             "limited" goes away and the inbox item is resolved
//          5. the next turn hits the limit again (the fake's `l`), then the
//             person quits the agent (`q`): the session is exited, not
//             limited — no "limited" tag and no limit item outlive the agent
//
// Negative controls (each must end in RESULT: FAIL):
//   HERMES_E2E_N19_FAKE_ERROR=server_error  the fake Claude's turn ends on a
//          server error, not its limit: "limited" never shows.
//   HERMES_E2E_N19_FLAG=off                 launchHelper stays off: the agent
//          is typed into the shell with no hooks, and no handoff is offered.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N19-limits-and-handoff.mjs
//
// Evidence (log, screenshots, the fakes' launch records) goes to
// HERMES_E2E_EVIDENCE, or <out dir>/evidence/N19-limits-and-handoff.

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { REPO_ROOT, createLogger, finishScenario, launchApp, outDir, sleep, skipScenario } from "../harness.mjs";

const SCENARIO = "N19-limits-and-handoff";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);
const onWindows = platform() === "win32";
const FAKE_ERROR = process.env.HERMES_E2E_N19_FAKE_ERROR || "rate_limit";
const FLAG_ON = (process.env.HERMES_E2E_N19_FLAG || "on") !== "off";
const TASK = 'N19 task: make the "login" redirect work';

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

// ─── A throwaway repository (synthetic identity) ─────────────────────
const work = realpathSync.native(mkdtempSync(join(tmpdir(), "hermes-e2e-n19-")));
const repo = join(work, "n19-repo");
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
execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
git("config", "user.name", "Hermes Test");
git("config", "user.email", "test@example.com");
git("config", "commit.gpgsign", "false");
writeFileSync(join(repo, "README.md"), "# n19\n");
git("add", ".");
git("commit", "-q", "-m", "initial");

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

// ─── Fake `claude` and `codex` on PATH ───────────────────────────────
const fakeBin = join(work, "bin");
const recordDir = join(work, "records");
const privateHome = join(work, "home");
for (const d of [fakeBin, recordDir, privateHome]) mkdirSync(d, { recursive: true });
const FAKE_CLI = join(REPO_ROOT, "tools", "fake-agents", "fake-cli.mjs");
const claudeMode = FAKE_ERROR === "rate_limit" ? "rate-limit" : "server-error";
function writeFake(name, mode) {
  if (onWindows) {
    writeFileSync(join(fakeBin, `${name}.cmd`), `@set "HERMES_FAKE_MODE=${mode}"\r\n@"${process.execPath}" "${FAKE_CLI}" %*\r\n`);
  } else {
    writeFileSync(join(fakeBin, name), `#!/bin/sh\nHERMES_FAKE_MODE=${mode} exec "${process.execPath}" "${FAKE_CLI}" "$@"\n`);
    chmodSync(join(fakeBin, name), 0o755);
  }
}
writeFake("claude", claudeMode);
writeFake("codex", "normal");
// Only the fakes answer to `claude` and `codex`, and no key reaches the app.
const hasReal = (dir) => ["claude", "claude.exe", "claude.cmd", "codex", "codex.exe", "codex.cmd"].some((n) => existsSync(join(dir, n)));
process.env.PATH = [fakeBin, ...(process.env.PATH || "").split(delimiter).filter((d) => d && !hasReal(d))].join(delimiter);
for (const name of Object.keys(process.env)) if (/^(ANTHROPIC_|OPENAI_|CODEX_)/.test(name)) delete process.env[name];

// The reset time the fake Claude reports (epoch seconds, on a whole minute).
const RESETS_AT = Math.ceil((Date.now() + 2 * 3600 * 1000) / 60_000) * 60;
writeFileSync(join(recordDir, "resets_at"), `${RESETS_AT}\n`);

/** Windows terminals take PATH from the registry: see N12-launch-and-resume.mjs. */
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
  log("  (CI runner: added the fake agents' folder to the user's registry Path)");
  return () => {
    if (old === null) execFileSync("reg", ["delete", "HKCU\\Environment", "/v", "Path", "/f"]);
    else execFileSync("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", old, "/f"]);
    log("  (CI runner: restored the user's registry Path)");
  };
}
if (onWindows && !canEditRegistryPath) {
  log("this scenario needs the fake agents on a Windows terminal's PATH, which means the user's registry Path; that is only changed on a CI runner");
  skipScenario({ scenario: SCENARIO, evidenceDir, reason: "Windows outside CI", log });
}

/** The fakes' launch records, oldest first (a record being written is skipped). */
const records = () =>
  readdirSync(recordDir)
    .filter((f) => f.startsWith("launch-"))
    .sort()
    .flatMap((f) => {
      try {
        return [{ file: f, ...JSON.parse(readFileSync(join(recordDir, f), "utf8")) }];
      } catch {
        return [];
      }
    });
async function waitForRecord(what, test, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = records().find(test);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`no fake launch record for ${what} within ${timeoutMs} ms (have ${records().length})`);
    await sleep(200);
  }
}

// ─── App launch and UI steps ─────────────────────────────────────────
function launch(run, { first = false } = {}) {
  const runDir = join(evidenceDir, `run-${run}`);
  const common = { runDir, log, env: { HERMES_FAKE_DIR: recordDir } };
  return onWindows
    ? launchApp({ ...common, home: "real", resetData: first })
    : launchApp({ ...common, home: "private", homeDir: privateHome });
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

async function quit(current) {
  const exit = await current.stop({ keepFiles: false });
  log(`  app exited: ${JSON.stringify(exit)}`);
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");
}

const invoke = (bridge, cmd, args) =>
  bridge.eval(`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})});`);

const setInput = (selector, value, proto = "HTMLInputElement") => `
  const el = e2e.must(e2e.first(${JSON.stringify(selector)}), ${JSON.stringify(selector)});
  const setter = Object.getOwnPropertyDescriptor(window.${proto}.prototype, "value").set;
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

/** New Session wizard: a Claude task in the test repo, default (new) branch. */
async function startClaudeTask(bridge, label) {
  const before = await bridge.terminalIds();
  await bridge.click(".activity-bar-action");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  await bridge.waitFor("the agent picker", `return !!e2e.first('.session-creator-provider-card[data-agent-id="claude"]');`, { timeoutMs: 20_000 });
  await bridge.click('.session-creator-provider-card[data-agent-id="claude"]');
  // The terminal is what is tested; a wizard may offer the Agent view.
  await bridge.eval(`
    const box = e2e.first(".session-creator-agent-view input[type=checkbox]");
    if (box && box.checked) e2e.click(box);
    return true;
  `);
  await clickPrimary(bridge, "agent");
  await bridge.waitFor("the folder step", `return !!e2e.first(".session-creator-scan-input");`);
  const listed = await bridge.eval(`
    const row = e2e.all(".project-picker-item").find((el) => el.innerText.includes("n19-repo"));
    if (!row) return false;
    if (!row.classList.contains("project-picker-item-attached")) e2e.click(row);
    return true;
  `);
  if (!listed) {
    await bridge.eval(setInput(".session-creator-scan-input", repo));
    await bridge.clickByName("Scan", { within: ".project-picker-footer" });
  }
  await bridge.waitFor("the test repo to be selected", `
    return e2e.all(".project-picker-item.project-picker-item-attached").some((el) => el.innerText.includes("n19-repo"));
  `);
  await clickPrimary(bridge, "folder");
  await bridge.waitFor("the branch step", `return !!e2e.first(".session-creator-branch-multi");`, { timeoutMs: 20_000 });
  // Once the default branch is picked the project's panel folds away; until
  // then its own "Create & Use Branch" is the first primary button.
  await bridge.waitFor("a default branch", `return !!e2e.first(".session-creator-branch-selected-label") && !e2e.first(".session-creator-branch-project.expanded");`);
  await clickPrimary(bridge, "branch");
  await bridge.waitFor("the confirm step", `return !!e2e.first('input.session-creator-name[placeholder="Session name (optional)"]');`);
  await bridge.eval(setInput('input.session-creator-name[placeholder="Session name (optional)"]', label));
  await clickPrimary(bridge, "confirm");
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  return bridge.waitFor(`the terminal of "${label}"`, `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
    return ids.length === 1 ? ids[0] : null;
  `, { timeoutMs: 20_000 });
}

async function projectId(bridge) {
  const projects = await invoke(bridge, "get_registered_projects");
  const p = projects.find((x) => samePath(x.path, repo));
  if (!p) throw new Error("the test repo is not a project");
  return p.id;
}

const snapshot = (bridge, id) => bridge.eval(`return window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(id)});`);
const inboxItems = (bridge) => bridge.eval(`return window.__HERMES_E2E__.inboxItems();`);
const rowOf = (id) => `.session-item[data-session-item-id="${id}"]`;
/** The last status the agent's own hooks reported: the terminal's guesses
 *  (source "pty") and the launch helper's reports (source "hi") can land
 *  after it in the store, so the latest status is not always the agent's. */
const lastHookStatus = (snap) => [...snap.events].reverse().find((e) => e.type === "status" && String(e.source).startsWith("hook:"))?.status;

/** Whether the terminal text shows `line` (see N12's showsLine: a long prompt can wrap it). */
function showsLine(text, line) {
  const t = text.replace(/\s+/g, "");
  const l = line.replace(/\s+/g, "");
  if (t.includes(l)) return true;
  for (let k = 1; k <= l.length - 4; k++) if (t.includes(l.slice(0, k)) && t.includes(l.slice(k))) return true;
  return false;
}
async function waitForTerminalText(bridge, sessionId, test, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    const rows = (await bridge.readTerminal(sessionId)) ?? [];
    text = rows.map((r) => r.trimEnd()).join("").replace(/\s+/g, " ");
    if (test(text)) return text;
    await sleep(100);
  }
  throw new Error(`terminal never showed ${what} within ${timeoutMs} ms. Last content:\n${text}`);
}

/** Opens the handoff dialog from the Claude session's "limited" tag and starts `kind` in `agentId`. */
async function handOff(bridge, sessionId, kind, agentId, { editTask } = {}) {
  await bridge.clickWhenReady(`
    const row = e2e.must(e2e.first(${JSON.stringify(rowOf(sessionId))}), "the session row");
    return e2e.click(e2e.must(e2e.first(".session-limit-handoff", row), "the Hand off button"));
  `);
  await bridge.waitFor("the handoff dialog", `return !!e2e.first('.handoff-modal[role="dialog"]');`);
  await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.first('.handoff-kinds input[value="${kind}"]'), "${kind}"));`);
  await bridge.waitFor(`the ${agentId} option to be ready`, `
    const b = e2e.first('.handoff-agents input[value="${agentId}"]');
    return !!b && !b.disabled;
  `, { timeoutMs: 20_000 });
  const offered = await bridge.eval(`return e2e.all(".handoff-agents input").map((b) => ({ id: b.value, state: b.disabled ? e2e.norm(b.closest("label").innerText) : "ready", disabled: b.disabled }));`);
  await bridge.click(`.handoff-agents input[value="${agentId}"]`);
  if (editTask) await bridge.eval(setInput(".handoff-task", editTask, "HTMLTextAreaElement"));
  await bridge.waitFor("the Start button", `const b = e2e.first(".handoff-btn-start"); return !!b && !b.disabled;`, { timeoutMs: 20_000 });
  const dialog = await bridge.eval(`
    return {
      kind: document.querySelector(".handoff-kinds input:checked")?.value ?? null,
      files: [...document.querySelectorAll(".handoff-file")].map((li) => li.textContent),
      seed: document.querySelector(".handoff-seed-text")?.textContent ?? "",
      note: e2e.norm(e2e.first(".handoff-note")?.innerText),
    };
  `);
  return { offered, dialog };
}

let app;
let failed = false;
let undoRegistryPath = null;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   fake claude ends its turn on: ${FAKE_ERROR}   launchHelper: ${FLAG_ON ? "on" : "OFF"}`);
  log(`test repo: ${repo}; reset time the fake reports: ${new Date(RESETS_AT * 1000).toISOString()}`);
  undoRegistryPath = addFakeBinToRegistryPath();

  // ── run 1: onboarding, flags ──────────────────────────────────────
  log("run 1: fresh launch; flags on for the next start");
  app = await launch(1, { first: true });
  await completeOnboarding(app.bridge);
  await invoke(app.bridge, "set_setting", {
    key: "feature_flag_overrides",
    value: JSON.stringify({ launchHelper: FLAG_ON, honestIsolation: true }),
  });
  await quit(app);

  // ── run 2 ─────────────────────────────────────────────────────────
  app = await launch(2);
  const { bridge } = app;
  await bridge.waitFor("the app UI (returning launch)", `return !!e2e.first(".topbar") && !e2e.first(".onboarding-backdrop");`);
  await dismissWhatsNew(bridge);

  log("step 1: a Claude task hits its usage limit");
  const claudeId = await startClaudeTask(bridge, "N19 login fix");
  const pid = await projectId(bridge);
  const claudeWt = await invoke(bridge, "git_session_worktree_info", { sessionId: claudeId, projectId: pid });
  log(`  claude session ${claudeId}: ${JSON.stringify(claudeWt)}`);
  assert(claudeWt && /^hermes\//.test(claudeWt.branchName), `the task is on its own branch (${claudeWt?.branchName})`);
  const claudeRec = await waitForRecord("claude's turn", (r) => r.env?.HERMES_AGENT === "claude" && r.hooksRan.some((h) => h.event === "StopFailure"));
  log(`  fake claude argv: ${JSON.stringify(claudeRec.argv)}`);
  assert(samePath(claudeRec.cwd, claudeWt.worktreePath), "the fake Claude runs in the task's worktree");
  assert(claudeRec.settings?.statusLine?.command?.includes("signal"), "Hermes gave Claude a status line that reports to it (the user has none)");
  // StopFailure is hooked like every catalog event (F11): one group for
  // every error, and hi's payload says which error it was.
  const stopFailureHooks = claudeRec.hooksRan.filter((h) => h.event === "StopFailure");
  assert(Array.isArray(claudeRec.settings?.hooks?.StopFailure) && stopFailureHooks.some((h) => h.results?.length > 0), "Hermes hooks StopFailure, and the rate-limited stop reached it");
  const statusLineRun = claudeRec.hooksRan.find((h) => h.event === "statusLine");
  assert(statusLineRun?.results?.[0]?.code === 0, "the status line command ran and printed nothing harmful");

  const tag = await bridge.waitFor("the session list to say limited", `
    const row = e2e.first(${JSON.stringify(rowOf(claudeId))});
    const t = row && e2e.first(".session-limit-tag", row);
    if (!t) return null;
    return {
      word: e2e.norm(t.querySelector(".session-limit-word")?.innerText),
      // With the launch helper the row's status tag carries the word.
      statusWord: e2e.norm(row.querySelector(".agent-status-tag .agent-status-word")?.innerText ?? ""),
      saysLimited: (row.querySelector(".session-item-meta")?.innerText.match(/limited/g) ?? []).length,
      detail: e2e.norm(t.querySelector(".session-limit-detail")?.innerText),
      button: e2e.norm(t.querySelector(".session-limit-handoff")?.innerText),
      resetsAt: t.dataset.resetsAt,
      confidence: t.dataset.confidence,
      // Whether the reset time is drawn whole inside the row (not cut off).
      detailWhole: (() => {
        const d = t.querySelector(".session-limit-detail");
        if (!d) return false;
        const dr = d.getBoundingClientRect();
        const rr = row.getBoundingClientRect();
        return d.scrollWidth <= Math.ceil(d.clientWidth) && dr.right <= rr.right + 0.5 && dr.width > 0;
      })(),
    };
  `, { timeoutMs: 20_000 });
  // The reported reset time as the app's own engine writes a clock time in
  // English (the app's language here), with every kind of space made one
  // plain space (ICU versions differ on the space before AM/PM).
  const expectedTime = await bridge.eval(
    `return e2e.norm(new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(new Date(${RESETS_AT * 1000})));`,
  );
  log(`  tag: ${JSON.stringify(tag)}; expected time ${expectedTime}`);
  assert(tag.resetsAt === String(RESETS_AT * 1000), "the reset time is exactly the one the agent reported");
  // The word is said once: by the status tag when it says the session is
  // limited (launch helper on), else by the limit tag itself.
  const word = tag.word || tag.statusWord;
  assert(/limited$/.test(word) && tag.detail === `resets ${expectedTime}`, `the row says "${word} · ${tag.detail}"`);
  assert(tag.saysLimited === 1, `"limited" shows once in the row (${tag.saysLimited}; status tag "${tag.statusWord}", limit tag "${tag.word}")`);
  assert(FLAG_ON ? tag.button === "Hand off…" : !tag.button, `the handoff is offered with the launch helper (${tag.button || "no button"})`);
  assert(tag.confidence === "exact", "the limit comes from the agent's own hook (exact)");
  assert(tag.detailWhole === true, "the reset time is shown whole in the row, not cut off");
  const snap = await snapshot(bridge, claudeId);
  const hookStatus = lastHookStatus(snap);
  assert(hookStatus?.kind === "limited" && hookStatus.confidence === "exact" && snap.limit !== null, "the agent's own report says limited, exact, and the session holds the limit");
  assert(snap.limit?.window === "five_hour" && snap.limit?.resetsAt === RESETS_AT * 1000, `the limit is the five_hour window (${JSON.stringify(snap.limit)})`);
  assert(snap.events.some((e) => e.type === "limit" && e.source === "hook:claude"), "the limit event came from Claude's hook");
  const inbox1 = (await inboxItems(bridge)).filter((i) => i.kind === "limit");
  assert(inbox1.length === 1 && inbox1[0].sessionId === claudeId && inbox1[0].detail.replace(/\s+/g, " ").includes(expectedTime), `one limit item in the inbox: ${JSON.stringify(inbox1)}`);
  await bridge.screenshot(join(evidenceDir, "01-limited.png"));

  log("step 2: Continue in Codex — same checkout, the task and the changed files as a launch argument");
  const beforeContinue = await bridge.terminalIds();
  const cont = await handOff(bridge, claudeId, "continue", "codex", { editTask: TASK });
  log(`  offered: ${JSON.stringify(cont.offered)}`);
  log(`  dialog: ${JSON.stringify(cont.dialog)}`);
  assert(!cont.offered.some((o) => o.id === "claude"), "the agent already on the task is not offered");
  assert(cont.dialog.kind === "continue", "continue is selected");
  assert(cont.dialog.files.includes("src/login.ts") && cont.dialog.files.includes("README.md"), "the dialog lists the files changed so far");
  assert(cont.dialog.seed.includes(TASK) && cont.dialog.seed.includes("until it hit its usage limit"), "the seed carries the task and says why");
  assert(/never types it into a terminal/.test(cont.dialog.note), "the dialog says the task is passed, not typed");
  await bridge.screenshot(join(evidenceDir, "02-continue-dialog.png"));
  await bridge.click(".handoff-btn-start");
  await bridge.waitFor("the dialog to close", `return !e2e.first(".handoff-modal");`, { timeoutMs: 30_000 });
  const contId = await bridge.waitFor("the Codex session's terminal", `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(beforeContinue)}.includes(id));
    return ids.length === 1 ? ids[0] : null;
  `, { timeoutMs: 20_000 });
  const contRec = await waitForRecord("the continued Codex", (r) => r.env?.HERMES_AGENT === "codex" && r.env?.HERMES_SESSION_ID === contId);
  log(`  fake codex argv: ${JSON.stringify(contRec.argv)}`);
  const contPrompt = contRec.argv.find((a) => a.includes(TASK));
  assert(!!contPrompt, "the fake Codex got the task as an argument");
  // On Windows the fake Codex is a .cmd shim, like an npm-installed CLI:
  // cmd.exe cannot take a line break inside an argument, so the first prompt
  // is one line there: its lines, trimmed, without the blank ones, joined by
  // one space (src-tauri/src/pty/launch.rs: first_prompt, as for F15's task).
  const oneLine = (text) => text.split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean).join(" ");
  const seedAsPassed = onWindows ? oneLine(cont.dialog.seed) : cont.dialog.seed;
  assert(contPrompt.startsWith(seedAsPassed), "that argument is exactly what the dialog showed (then the project-context line)");
  assert(contPrompt.includes('"login"'), "one argument, quotes intact (a shell would have taken them as syntax)");
  assert(
    onWindows ? !contPrompt.includes("\n") && contPrompt.includes(" Task: ") : contPrompt.includes("\n"),
    onWindows ? "through the .cmd shim, line breaks arrive as spaces in the same single argument" : "line breaks intact in the one argument (typed into a shell, the first would have submitted the line)",
  );
  assert(contPrompt.includes("src/login.ts") && contPrompt.includes("README.md"), "it names the changed files");
  assert(samePath(contRec.cwd, claudeRec.cwd), "Codex runs in the SAME checkout as Claude");
  const contWt = await invoke(bridge, "git_session_worktree_info", { sessionId: contId, projectId: pid });
  assert(contWt?.branchName === claudeWt.branchName && samePath(contWt.worktreePath, claudeWt.worktreePath), `same branch and folder (${JSON.stringify(contWt)})`);
  assert(contWt.sharedWithOtherSessions === true, "both sessions know they share that checkout");
  const launchFile = JSON.parse(readFileSync(join(app.dataDir, "launch", contId, "launch.json"), "utf8"));
  // The launch file holds the prompt as it is passed (one line on Windows,
  // see above); hi would also make any line break a space for a .cmd shim.
  const asSpawned = (a) => (onWindows ? a.replace(/\r\n|\r|\n/g, " ") : a);
  assert(launchFile.agent === "codex" && launchFile.args.some((a) => asSpawned(a) === contPrompt), "the prompt travels in the launch file hi reads");
  // Everything in the terminal before the agent's own first line is the
  // shell and what Hermes typed: no task text may be there. (The typed line
  // itself, `hi run <id>`, can be partly redrawn away by the shell when the
  // new pane resizes, so it is logged, not required.)
  const termText = await waitForTerminalText(bridge, contId, (t) => t.includes("fake-cli 0.1"), "the agent's first line");
  const beforeAgent = termText.slice(0, termText.indexOf("fake-cli 0.1"));
  log(`  terminal before the agent started: ${JSON.stringify(beforeAgent.slice(-160))} (shows \`hi run <id>\`: ${showsLine(beforeAgent, `hi run ${contId}`)})`);
  assert(!beforeAgent.includes("N19 task") && !beforeAgent.includes("Task:") && !beforeAgent.includes("login.ts"), "nothing of the task was typed into the shell");
  const contRow = await bridge.eval(`return e2e.norm(e2e.first(${JSON.stringify(rowOf(contId))})?.innerText);`);
  assert(!/Claude Code/.test(contRow), `the Codex session is not taken for Claude by the prompt it echoes ("${contRow}")`);
  const nestedCont = await bridge.eval(`
    const w = e2e.first('.session-item-wrapper-nested[data-parent-session-id="${claudeId}"] ${rowOf(contId)}');
    return w ? e2e.norm(w.innerText) : null;
  `);
  assert(nestedCont && nestedCont.includes("N19 login fix · Codex"), `the Codex session sits under the Claude one ("${nestedCont}")`);
  const order = await bridge.eval(`return e2e.all(".session-item").map((el) => el.dataset.sessionItemId);`);
  assert(order.indexOf(contId) === order.indexOf(claudeId) + 1, "right under it in the list");
  await bridge.screenshot(join(evidenceDir, "03-continued.png"));

  log("step 3: Duplicate to Codex — a child branch of its own");
  const beforeDup = await bridge.terminalIds();
  const dup = await handOff(bridge, claudeId, "duplicate", "codex", { editTask: TASK });
  assert(dup.dialog.kind === "duplicate" && dup.dialog.files.length === 0, "duplicate lists no files (it starts from the branch)");
  await bridge.click(".handoff-btn-start");
  await bridge.waitFor("the dialog to close", `return !e2e.first(".handoff-modal");`, { timeoutMs: 30_000 });
  const dupId = await bridge.waitFor("the duplicate's terminal", `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(beforeDup)}.includes(id));
    return ids.length === 1 ? ids[0] : null;
  `, { timeoutMs: 20_000 });
  const dupRec = await waitForRecord("the duplicated Codex", (r) => r.env?.HERMES_AGENT === "codex" && r.env?.HERMES_SESSION_ID === dupId);
  const dupWt = await invoke(bridge, "git_session_worktree_info", { sessionId: dupId, projectId: pid });
  const child = `${claudeWt.branchName}--codex`;
  log(`  duplicate: ${JSON.stringify(dupWt)}; cwd ${dupRec.cwd}`);
  assert(dupWt?.branchName === child, `the duplicate works on ${child}`);
  assert(!samePath(dupWt.worktreePath, claudeWt.worktreePath) && samePath(dupRec.cwd, dupWt.worktreePath), "in a worktree of its own");
  assert(gitIn(dupRec.cwd, "branch", "--show-current") === child, "git agrees on the branch");
  assert(git("merge-base", child, claudeWt.branchName) === git("rev-parse", claudeWt.branchName), "the child branch is cut from the Claude branch");
  assert(!existsSync(join(dupRec.cwd, "src", "login.ts")), "Claude's uncommitted files are not in the duplicate");
  const dupPrompt = dupRec.argv.find((a) => a.includes(TASK));
  assert(
    !!dupPrompt && dupPrompt.includes("work independently") && dupPrompt.includes(`on branch ${claudeWt.branchName};`),
    "the duplicate got the task, knowing another agent works on it on the parent branch",
  );
  const nestedDup = await bridge.eval(`return !!e2e.first('.session-item-wrapper-nested[data-parent-session-id="${claudeId}"] ${rowOf(dupId)}');`);
  assert(nestedDup, "the duplicate sits under the Claude session too");
  await bridge.screenshot(join(evidenceDir, "04-duplicated.png"));

  log("step 4: the limit resets and Claude goes on");
  // The person goes back to the Claude session and presses a key in it (the
  // fake takes `r` as "the limit reset, go on").
  await bridge.click(rowOf(claudeId));
  await bridge.waitFor("the Claude terminal to be shown", `
    const host = document.querySelector('div[data-session-id="${claudeId}"]');
    return !!host && !!host.querySelector("textarea.xterm-helper-textarea");
  `, { timeoutMs: 20_000 });
  await bridge.typeInTerminal(claudeId, "r");
  await bridge.waitFor("the limited tag to go away", `return !e2e.first(${JSON.stringify(`${rowOf(claudeId)} .session-limit-tag`)});`, { timeoutMs: 20_000 });
  const after = await snapshot(bridge, claudeId);
  assert(lastHookStatus(after)?.kind === "working" && after.limit === null, `status ${lastHookStatus(after)?.kind}, no limit`);
  const inbox2 = (await inboxItems(bridge)).filter((i) => i.kind === "limit");
  assert(inbox2.length === 0, "the inbox item is resolved");
  await bridge.screenshot(join(evidenceDir, "05-limit-reset.png"));

  log("step 5: limited again, then the person quits the agent");
  await bridge.typeInTerminal(claudeId, "L");
  await bridge.waitFor("the limited tag to come back", `return !!e2e.first(${JSON.stringify(`${rowOf(claudeId)} .session-limit-tag`)});`, { timeoutMs: 20_000 });
  const again = await snapshot(bridge, claudeId);
  assert(lastHookStatus(again)?.kind === "limited" && again.limit?.resetsAt === RESETS_AT * 1000, `limited again, same reset (${JSON.stringify(again.limit)})`);
  const inbox3 = (await inboxItems(bridge)).filter((i) => i.kind === "limit");
  assert(inbox3.length === 1 && inbox3[0].sessionId === claudeId, "one limit item again");
  await bridge.typeInTerminal(claudeId, "q");
  // The fake records how it ended; then give Hermes time to see the process
  // go and any late event (a stale limit, a re-raised inbox item) to land.
  await waitForRecord("the fake Claude to quit", (r) => r.env?.HERMES_SESSION_ID === claudeId && r.exit?.why === "q", 20_000);
  await sleep(3_000);
  const gone = await snapshot(bridge, claudeId);
  log(`  after quitting: status ${JSON.stringify(gone.status)}, limit ${JSON.stringify(gone.limit)}, exit ${JSON.stringify(gone.exit)}`);
  assert((gone.status.kind === "exited" || gone.exit !== null) && gone.limit === null, "the session is exited, with no limit left");
  const tagAfterQuit = await bridge.eval(`return e2e.norm(e2e.first(${JSON.stringify(`${rowOf(claudeId)} .session-limit-tag`)})?.innerText ?? "");`);
  assert(tagAfterQuit === "", `no "limited" tag after the agent quit ("${tagAfterQuit}")`);
  const inbox4 = (await inboxItems(bridge)).filter((i) => i.kind === "limit");
  assert(inbox4.length === 0, `no limit item left or raised again for the exited agent (${JSON.stringify(inbox4)})`);
  await bridge.screenshot(join(evidenceDir, "06-quit-while-limited.png"));
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  try {
    if (existsSync(recordDir)) cpSync(recordDir, join(evidenceDir, "fake-records"), { recursive: true });
  } catch {
    /* evidence only */
  }
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
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    /* a worktree folder may still be locked on Windows */
  }
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
