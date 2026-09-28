#!/usr/bin/env node
// Scenario: F20 — turn history (Turn Ledger), on the REAL app with fake agents.
//
// A throwaway git repository with a synthetic identity and a pre-existing
// stash entry. Run 1 turns the turnLedger (and agentCatalog) flags on; run 2
// proves, in a plain terminal session opened in that repository:
//
//   A. a fake agent edits a tracked file through a shell command (`sed -i`
//      on POSIX, `echo >` on Windows), adds an untracked file and an
//      ignored one; the agent's turn end (an exact signal, through the
//      session-event injector) makes a T1 chip appear whose diff shows the
//      shell edit and the new file, and not the ignored one;
//   B. HEAD, the index, `git status` and the stash list are exactly as they
//      were: the snapshot lives only in refs/hermes/<session>/turn/1;
//   C. a turn that changed nothing creates no commit and no chip
//      (negative control: the chip count and the ref count do not move);
//   D. two more turns (T2, T3); a person edits a file, then "Restore to T1"
//      previews first (nothing changes yet) and restores exactly the T1
//      tree: the file T2 added is gone, the file T3 deleted is back, the
//      user's HEAD/index/stash still unchanged; another person edit, then
//      "Restore to T3" brings back exactly the T3 tree, and each restore
//      kept what it replaced under its own refs/hermes/<s>/before-restore/<k>;
//   E. the kill switch: the checkbox in Settings > Git (a real click) stops
//      a turn from being recorded, and ticking it again records the next;
//
// and, in a Custom-agent session in the same repository (no injected event
// at all; the wizard offers no default branch there because `main` is in
// use by the first session, so the scenario takes "Continue without
// isolation", as a person would):
//
//   F. the PTY heuristic: the agent edits a file and goes quiet at its
//      prompt; the Busy -> Idle transition records a turn whose diff shows
//      that edit.
//
// Also checked: opening a session writes nothing to the repository (no
// refs/hermes ref exists until a turn changed something).
//
// Negative control of the whole scenario: HERMES_E2E_F20_FLAG=off leaves
// the flag off; the turn bar never appears and no refs/hermes ref is
// written, so the scenario ends in RESULT: FAIL at step A (by design; the
// chip check is real). Run by hand to see it fail.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F20-turn-ledger.mjs
//
// Evidence (log + screenshots + the fake agents' logs) goes to
// HERMES_E2E_EVIDENCE, or <out dir>/evidence/F20-turn-ledger.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";
import { PROBE_OUTPUT, classifyProbe, commandLine, probeCommand } from "../shells.mjs";

const SCENARIO = "F20-turn-ledger";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);
const FLAG_ON = (process.env.HERMES_E2E_F20_FLAG || "on") !== "off";
const FAKE_AGENT = join(REPO_ROOT, "tools", "fake-agents", "fake-agent.mjs");
const onWindows = platform() === "win32";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

// ── A throwaway repository (synthetic identity, never the real one) ──
const workDir = realpathSync.native(mkdtempSync(join(tmpdir(), "hermes-e2e-f20-")));
const repo = join(workDir, "f20-repo");
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
git("config", "core.autocrlf", "false");
mkdirSync(join(repo, "src"), { recursive: true });
writeFileSync(join(repo, "README.md"), "# f20\n");
writeFileSync(join(repo, "src", "app.txt"), "hello\n");
writeFileSync(join(repo, ".gitignore"), "build/\n");
git("add", ".");
git("commit", "-q", "-m", "initial");
// One entry already on the stash, so "the stash is unchanged" is a real check.
writeFileSync(join(repo, "README.md"), "# f20 (stashed edit)\n");
git("stash", "push", "-q", "-m", "f20 pre-existing entry");

/** What a snapshot must never change: HEAD, the staged index, the stash. */
function userState(dir) {
  return {
    head: gitIn(dir, "rev-parse", "HEAD"),
    index: gitIn(dir, "ls-files", "-s"),
    stash: gitIn(dir, "stash", "list"),
  };
}
const status = (dir) => gitIn(dir, "status", "--porcelain=v1", "--untracked-files=all");
const turnRefs = (dir, sid) =>
  gitIn(dir, "for-each-ref", "--format=%(refname)", `refs/hermes/${sid}/turn/`)
    .split(/\r?\n/)
    .filter(Boolean);
/** The tree of the worktree as the ledger sees it, through a throwaway index. */
function worktreeTree(dir) {
  const idx = join(workDir, `probe-index-${Date.now()}`);
  const env = { ...gitEnv, GIT_INDEX_FILE: idx };
  execFileSync("git", ["-C", dir, "add", "-A", "--", "."], { env });
  const tree = execFileSync("git", ["-C", dir, "write-tree"], { env, encoding: "utf8" }).trim();
  rmSync(idx, { force: true });
  return tree;
}
const read = (dir, rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), "utf8").replace(/\r\n/g, "\n") : null);

// ── The fake agent's scenarios (written to a temp folder) ────────────
const fakeDir = mkdtempSync(join(tmpdir(), "hermes-e2e-f20-agent-"));
function agentScenario(name, steps) {
  const file = join(fakeDir, `${name}.json`);
  writeFileSync(file, JSON.stringify({ name, steps }, null, 1));
  return file;
}
const shell = (label, posix, win32) => ({ do: "shell", label, posix, win32 });
const SCEN = {
  edit1: agentScenario("edit1", [
    { do: "print", text: "fake-agent: editing src/app.txt with the shell\n" },
    shell(
      "sed -i",
      "sed -i.bak 's/hello/hello world/' src/app.txt && rm -f src/app.txt.bak && mkdir -p notes build && printf 'draft\\n' > notes/new.txt && printf 'bin\\n' > build/out.bin",
      "echo hello world>src\\app.txt & mkdir notes & echo draft>notes\\new.txt & mkdir build & echo bin>build\\out.bin",
    ),
    { do: "print", text: "fake-agent: edit1 done\n" },
    { do: "exit", code: 0 },
  ]),
  noop: agentScenario("noop", [
    { do: "print", text: "fake-agent: nothing to do\n" },
    { do: "print", text: "fake-agent: noop done\n" },
    { do: "exit", code: 0 },
  ]),
  edit2: agentScenario("edit2", [
    shell("append", "printf 'second\\n' >> src/app.txt", "echo second>>src\\app.txt"),
    { do: "print", text: "fake-agent: edit2 done\n" },
    { do: "exit", code: 0 },
  ]),
  edit3: agentScenario("edit3", [
    shell("delete and rewrite", "rm -f notes/new.txt && printf '# changed\\n' > README.md", "del notes\\new.txt & echo # changed>README.md"),
    { do: "print", text: "fake-agent: edit3 done\n" },
    { do: "exit", code: 0 },
  ]),
  edit4: agentScenario("edit4", [
    shell("append", "printf 'fourth\\n' >> src/app.txt", "echo fourth>>src\\app.txt"),
    { do: "print", text: "fake-agent: edit4 done\n" },
    { do: "exit", code: 0 },
  ]),
  idle: agentScenario("idle", [
    { do: "print", text: "FAKE-AGENT READY f20\n" },
    { do: "sleep", ms: 300 },
    shell("append", "printf 'guessed\\n' >> README.md", "echo guessed>>README.md"),
    { do: "print", text: "fake-agent: idle now\n" },
    { do: "waitKey", expect: ["q"], timeoutMs: 180000 },
    { do: "print", text: "fake-agent bye\n" },
    { do: "exit", code: 0 },
  ]),
};

// Windows keeps app data under %APPDATA%, which a private HOME does not move.
const homeDir = onWindows ? undefined : mkdtempSync(join(tmpdir(), "hermes-e2e-f20-home-"));
function launch(run, { first = false } = {}) {
  const runDir = join(evidenceDir, `run-${run}`);
  return onWindows
    ? launchApp({ runDir, log, home: "real", resetData: first })
    : launchApp({ runDir, log, home: "private", homeDir });
}

// ── UI helpers ───────────────────────────────────────────────────────
async function dismissWhatsNew(bridge) {
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
    return { analytics: analytics.checked, policy: policy.checked };
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

async function waitForReturningLaunch(bridge) {
  await bridge.waitFor("the app UI to be ready (no onboarding this time)", `
    return !!e2e.first(".topbar-title, .topbar") && !e2e.first(".onboarding-backdrop");
  `);
  await dismissWhatsNew(bridge);
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
async function clickPrimary(bridge, what) {
  const r = await bridge.clickWhenReady(`
    const b = e2e.must(e2e.first(${JSON.stringify(PRIMARY)}), "the wizard's primary button");
    return e2e.click(b);
  `);
  log(`  wizard ${what}: clicked "${r.clicked}"`);
  await sleep(300);
}

/**
 * Walk the New Session wizard: a plain shell, or a Custom agent with
 * `command`, in the test repository. Returns the new session's id.
 */
async function createSession(bridge, { label, custom = null }) {
  const before = await bridge.terminalIds();
  if (await bridge.exists(".activity-bar-action")) await bridge.click(".activity-bar-action");
  else await bridge.click("button.es-tile-primary");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`);
  if (custom) {
    await bridge.click('.session-creator-provider-card[data-agent-id="custom"]');
    await bridge.waitFor("the custom agent fields", `return !!e2e.first("#session-creator-custom-agent-command");`);
    await bridge.eval(setInput("#session-creator-custom-agent-name", custom.name));
    const typed = await bridge.eval(setInput("#session-creator-custom-agent-command", custom.command));
    assert(typed === custom.command, "the command field holds the fake agent command");
    await bridge.waitFor("Next to become enabled", `return e2e.first(${JSON.stringify(PRIMARY)}).disabled === false;`);
  } else {
    await bridge.clickWhenReady(`
      const cards = e2e.all(".session-creator-provider-card");
      return e2e.click(e2e.must(cards[cards.length - 1], "plain shell card"));
    `);
  }
  await clickPrimary(bridge, "agent");

  // The remaining steps, whichever the wizard shows: folder, branch, confirm.
  for (let i = 0; i < 8; i++) {
    if (!(await bridge.exists(".session-creator"))) break;
    const step = await bridge.eval(`
      if (e2e.first(".workspace-scan-input")) return "folder";
      if (e2e.first(".session-creator-branch-multi")) return "branch";
      if (e2e.first('input.command-palette-input[placeholder="Session name (optional)"]')) return "confirm";
      return e2e.first(".session-creator-step")?.innerText ?? "other";
    `);
    if (step === "folder") {
      const listed = await bridge.eval(`
        const row = e2e.all(".project-picker-item").find((el) => el.innerText.includes("f20-repo"));
        if (!row) return false;
        if (!row.classList.contains("project-picker-item-attached")) e2e.click(row);
        return true;
      `);
      if (!listed) {
        await bridge.eval(setInput(".workspace-scan-input", repo));
        await bridge.clickByName("Scan", { within: ".project-picker-footer" });
      }
      await bridge.waitFor("the test repo to be selected", `
        return e2e.all(".project-picker-item.project-picker-item-attached").some((el) => el.innerText.includes("f20-repo"));
      `);
    } else if (step === "branch") {
      // The first session in the repository is offered its current branch.
      // A second one is not (that branch is in use by the first), and the
      // wizard offers "Continue without isolation" instead: both sessions
      // then share the checkout, which is what F needs.
      const offered = await bridge.waitFor("the branch step to settle", `
        if (e2e.first(".session-creator-branch-selected-label")) return "default";
        const body = e2e.first(".branch-selector-body");
        if (body && !e2e.first(".branch-selector-loading", body) && e2e.all(".branch-selector-item", body).length > 0) return "none";
        return null;
      `, { timeoutMs: 20_000 });
      if (offered === "default") {
        log(`  branch offered: "${(await bridge.text(".session-creator-branch-selected-label")).trim()}"`);
      } else {
        log("  no default branch (in use by the first session): continuing without isolation");
        await bridge.clickByName("Continue without isolation", { within: ".session-creator-footer-actions" });
        await sleep(300);
        continue;
      }
    } else if (step === "confirm") {
      await bridge.eval(setInput('input.command-palette-input[placeholder="Session name (optional)"]', label));
    }
    await clickPrimary(bridge, step);
    await sleep(300);
  }
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  const id = await bridge.waitFor(`the terminal of "${label}"`, `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
    return ids.length === 1 ? ids[0] : null;
  `, { timeoutMs: 20_000 });
  await bridge.waitFor("the shell to print its prompt", `
    const lines = window.__HERMES_E2E__.readTerminal(${JSON.stringify(id)}) || [];
    const info = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(id)});
    return info && info.opened && lines.some((l) => l.trim().length > 0);
  `, { timeoutMs: 30_000 });
  await sleep(800);
  return id;
}

/** The folder the session's shell runs in (its worktree, or the project folder). */
async function sessionDir(bridge, sessionId) {
  const projects = await invoke(bridge, "get_registered_projects");
  const norm = (p) => {
    try { p = realpathSync.native(p); } catch { /* gone */ }
    return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  };
  const p = projects.find((x) => norm(x.path) === norm(repo));
  if (!p) return repo;
  const wt = await invoke(bridge, "git_session_worktree_info", { sessionId, projectId: p.id });
  return wt?.worktreePath ? realpathSync.native(wt.worktreePath) : repo;
}

async function detectShell(bridge, sessionId) {
  await bridge.typeInTerminal(sessionId, `${probeCommand()}\n`);
  const { line } = await bridge.waitForTerminal(sessionId, PROBE_OUTPUT, { timeoutMs: 20_000 });
  return classifyProbe(line);
}

/** Run the fake agent in the session's shell and wait for its last line. */
async function runAgent(bridge, sessionId, shellKind, scenarioFile, doneLine) {
  const agentLog = join(evidenceDir, `fake-agent-${scenarioFile.split(/[\\/]/).pop().replace(".json", "")}.jsonl`);
  rmSync(agentLog, { force: true });
  await bridge.typeInTerminal(sessionId, commandLine(shellKind, process.execPath, [FAKE_AGENT, "--scenario", scenarioFile, "--log", agentLog]) + "\n");
  await bridge.waitForTerminal(sessionId, new RegExp(`^${doneLine}`), { timeoutMs: 30_000 });
  await sleep(300);
  const events = existsSync(agentLog) ? readFileSync(agentLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  const failedShell = events.find((e) => e.ev === "shell" && e.code !== 0);
  if (failedShell) throw new Error(`the fake agent's shell command failed: ${JSON.stringify(failedShell)}`);
  return events;
}

const inject = (bridge, sessionId, event) =>
  bridge.eval(`return window.__HERMES_E2E__.injectSessionEvent(${JSON.stringify(sessionId)}, ${JSON.stringify(event)});`);

// On Windows the fake agent's `echo x>file` (cmd.exe) writes CRLF, so a
// deleted line reads "-draft\r" in the raw diff text; compare without it.
// Windows: files cmd wrote end in CRLF, and `echo draft>f & ...` keeps the
// space before the `&` ("draft "), so compare diff lines without either.
const stripCr = (lines) => lines.map((l) => l.replace(/[\r ]+$/, ""));

const chipsOf = (bridge, sessionId) =>
  bridge.eval(`
    const bar = e2e.first('.turn-bar[data-session-id="' + CSS.escape(${JSON.stringify(sessionId)}) + '"]');
    if (!bar) return [];
    return e2e.all(".turn-bar-turn", bar).map((b) => ({ n: Number(b.getAttribute("data-turn-n")), files: Number(b.getAttribute("data-files")), text: e2e.norm(b.innerText), disabled: b.disabled }));
  `);

async function waitForChip(bridge, sessionId, n, { timeoutMs = 20_000 } = {}) {
  return bridge.waitFor(`the T${n} chip`, `
    const bar = e2e.first('.turn-bar[data-session-id="' + CSS.escape(${JSON.stringify(sessionId)}) + '"]');
    const chip = bar && e2e.first('.turn-bar-turn[data-turn-n="${n}"]', bar);
    return chip ? { files: Number(chip.getAttribute("data-files")), text: e2e.norm(chip.innerText) } : null;
  `, { timeoutMs });
}

async function openDiff(bridge, sessionId, n) {
  await bridge.clickWhenReady(`
    const bar = e2e.first('.turn-bar[data-session-id="' + CSS.escape(${JSON.stringify(sessionId)}) + '"]');
    return e2e.click(e2e.must(bar && e2e.first('.turn-bar-turn[data-turn-n="${n}"]', bar), "chip T${n}"));
  `);
  await bridge.waitFor(`the diff sheet of T${n}`, `
    const s = e2e.first('.turn-sheet[data-sheet="diff"][data-turn-n="${n}"]');
    return s && e2e.first(".turn-diff-text, .turn-diff-empty", s) ? true : null;
  `);
  return bridge.eval(`
    const s = e2e.first('.turn-sheet[data-sheet="diff"]');
    return e2e.all(".turn-diff-line", s).map((l) => l.textContent);
  `).then(stripCr);
}

const closeSheet = async (bridge) => {
  await bridge.click(".turn-sheet-close");
  await bridge.waitFor("the sheet to close", `return !e2e.first(".turn-sheet");`);
};

/**
 * Opens Settings > Git from the activity bar, sets the turn history checkbox
 * to `on` with a real click, and closes Settings again. Returns the
 * checkbox's state after the click.
 */
async function setTurnLedgerInSettings(bridge, on, shot) {
  await bridge.clickWhenReady(`
    const btn = e2e.all(".activity-bar-action").find((b) =>
      e2e.norm(b.querySelector(".activity-bar-label")?.textContent).toLowerCase() === "settings");
    return e2e.click(e2e.must(btn, "the Settings button"));
  `);
  await bridge.waitFor("the Settings panel", `return !!e2e.first(".settings-panel");`);
  await bridge.clickByName("Git", { within: ".settings-tabs" });
  const box = 'input[type=checkbox][data-setting="turn_ledger"]';
  await bridge.waitFor("the turn history checkbox on the Git tab", `return !!e2e.first(${JSON.stringify(box)});`);
  const hint = await bridge.eval(`return e2e.norm(e2e.first('[data-setting-hint="turn_ledger"]')?.innerText ?? "");`);
  assert(/untracked files/.test(hint) && /mirror push/.test(hint), `the setting says snapshots include untracked files and are copied by a mirror push: "${hint}"`);
  const before = await bridge.eval(`return e2e.first(${JSON.stringify(box)}).checked;`);
  if (before !== on) await bridge.click(box);
  const after = await bridge.waitFor(`the checkbox to be ${on ? "ticked" : "unticked"}`, `
    const b = e2e.first(${JSON.stringify(box)});
    return b && b.checked === ${on} ? { checked: b.checked } : null;
  `);
  await bridge.screenshot(join(evidenceDir, shot));
  await bridge.click(".settings-close");
  await bridge.waitFor("Settings to close", `return !e2e.first(".settings-panel");`);
  await sleep(300);
  return after.checked;
}

let app;
let failed = false;
let sessionA = null;
let sessionB = null;
let dirA = repo;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   flag: ${FLAG_ON ? "on" : "OFF (negative control)"}`);
  log(`test repo: ${repo}`);

  // ── run 1: onboarding, flags on ─────────────────────────────────
  log("step 0: fresh launch; turn the turnLedger and agentCatalog flags on (read at next start)");
  app = await launch(1, { first: true });
  await completeOnboarding(app.bridge);
  if (FLAG_ON) {
    await invoke(app.bridge, "set_setting", { key: "feature_flag_overrides", value: JSON.stringify({ turnLedger: true, agentCatalog: true }) });
  }
  const exit1 = await app.stop();
  assert(!exit1.forced && exit1.code === 0, "run 1 quit cleanly");

  // ── run 2 ───────────────────────────────────────────────────────
  app = await launch(2);
  const { bridge } = app;
  await waitForReturningLaunch(bridge);
  await bridge.waitFor("the e2e hooks", `return typeof window.__HERMES_E2E__?.injectSessionEvent === "function";`);

  log("step 1: a plain terminal session in the test repository");
  sessionA = await createSession(bridge, { label: "F20 turns" });
  dirA = await sessionDir(bridge, sessionA);
  log(`  session ${sessionA} runs in ${dirA}`);
  const shellKind = await detectShell(bridge, sessionA);
  log(`  the session's shell is ${shellKind}`);
  const stateAtStart = userState(dirA);
  assert(stateAtStart.stash.split("\n").length === 1, `the stash starts with one entry (${stateAtStart.stash})`);
  assert((await chipsOf(bridge, sessionA)).length === 0, "no turn chip before any turn");
  // The baseline is taken in the background when the session opens; it must
  // stay in memory: a session that never records a turn leaves no ref.
  await sleep(1500);
  assert(gitIn(dirA, "for-each-ref", "refs/hermes/") === "", "no refs/hermes ref before any turn (the baseline writes nothing)");

  // ── A. a shell edit shows in the turn diff ──────────────────────
  log("step A: the fake agent edits with a shell command; its turn end records T1");
  assert(await inject(bridge, sessionA, { type: "turn_start", at: Date.now(), n: 1, source: "e2e" }), "turn_start injected");
  await runAgent(bridge, sessionA, shellKind, SCEN.edit1, "fake-agent: edit1 done");
  assert(read(dirA, "src/app.txt").startsWith("hello world"), "the shell command rewrote src/app.txt");
  const statusAfterEdit = status(dirA);
  const treeAfterEdit1 = worktreeTree(dirA);
  assert(await inject(bridge, sessionA, { type: "turn_end", at: Date.now(), n: 1, source: "e2e" }), "turn_end injected");
  const t1 = await waitForChip(bridge, sessionA, 1);
  assert(t1.files === 2, `T1 counts 2 files (app.txt and notes/new.txt; the ignored build/ is not one): ${JSON.stringify(t1)}`);
  await bridge.screenshot(join(evidenceDir, "01-turn-bar-t1.png"));
  const linesT1 = await openDiff(bridge, sessionA, 1);
  assert(linesT1.some((l) => l === "-hello") && linesT1.some((l) => l.startsWith("+hello world")), "the T1 diff shows the sed edit (-hello / +hello world)");
  assert(linesT1.some((l) => l.includes("notes/new.txt")) && linesT1.some((l) => l.startsWith("+draft")), "the T1 diff shows the new untracked file");
  assert(!linesT1.some((l) => l.includes("build/out.bin")), "the ignored file is not in the diff");
  await bridge.screenshot(join(evidenceDir, "02-t1-diff.png"));
  await closeSheet(bridge);

  // ── B. nothing of the user's changed ────────────────────────────
  log("step B: HEAD, the index, git status and the stash are untouched; the snapshot is a hidden ref");
  const stateAfterT1 = userState(dirA);
  assert(stateAfterT1.head === stateAtStart.head, "HEAD is unchanged");
  assert(stateAfterT1.index === stateAtStart.index, "the index is unchanged (nothing was staged)");
  assert(stateAfterT1.stash === stateAtStart.stash, "the stash list is unchanged");
  assert(status(dirA) === statusAfterEdit, `git status is exactly what the shell edit left (${JSON.stringify(status(dirA))})`);
  const refs1 = turnRefs(dirA, sessionA);
  assert(refs1.length === 1 && refs1[0] === `refs/hermes/${sessionA}/turn/1`, `one turn ref: ${refs1.join(", ")}`);
  assert(gitIn(dirA, "rev-parse", `refs/hermes/${sessionA}/turn/1^{tree}`) === treeAfterEdit1, "the T1 snapshot is exactly the worktree after the edit");
  assert(gitIn(dirA, "branch", "--show-current") === "main", "still on main");

  // ── C. a no-change turn creates nothing ─────────────────────────
  log("step C (negative control): a turn that changed nothing creates no commit and no chip");
  await runAgent(bridge, sessionA, shellKind, SCEN.noop, "fake-agent: noop done");
  assert(await inject(bridge, sessionA, { type: "turn_end", at: Date.now(), n: 2, source: "e2e" }), "turn_end injected");
  await sleep(3000);
  assert((await chipsOf(bridge, sessionA)).length === 1, "still exactly one chip");
  assert(turnRefs(dirA, sessionA).length === 1, "still exactly one turn ref");

  // ── D. more turns, then restore to T1 ───────────────────────────
  log("step D: turns T2 and T3, then Restore to T1 (previewed first)");
  await runAgent(bridge, sessionA, shellKind, SCEN.edit2, "fake-agent: edit2 done");
  assert(await inject(bridge, sessionA, { type: "turn_end", at: Date.now(), n: 3, source: "e2e" }), "turn_end injected");
  const t2 = await waitForChip(bridge, sessionA, 2);
  assert(t2.files === 1, `T2 changed one file: ${JSON.stringify(t2)}`);
  await runAgent(bridge, sessionA, shellKind, SCEN.edit3, "fake-agent: edit3 done");
  assert(await inject(bridge, sessionA, { type: "turn_end", at: Date.now(), n: 4, source: "e2e" }), "turn_end injected");
  const t3 = await waitForChip(bridge, sessionA, 3);
  assert(t3.files === 2, `T3 changed two files: ${JSON.stringify(t3)}`);
  const linesT3 = await openDiff(bridge, sessionA, 3);
  assert(linesT3.some((l) => l === "-draft") && linesT3.some((l) => l.startsWith("+# changed")), "the T3 diff shows only what T3 changed");
  assert(!linesT3.some((l) => l.startsWith("+hello world")), "the T1 edit is not in the T3 diff");
  await closeSheet(bridge);
  assert(read(dirA, "notes/new.txt") === null && read(dirA, "src/app.txt").includes("second"), "the worktree is at T3");
  const treeAtT3 = worktreeTree(dirA);
  assert(gitIn(dirA, "rev-parse", `refs/hermes/${sessionA}/turn/3^{tree}`) === treeAtT3, "the T3 snapshot is exactly the worktree after edit3");
  // A person edits after T3 (outside any turn): the restore must set this
  // aside, not lose it.
  writeFileSync(join(dirA, "src", "app.txt"), read(dirA, "src/app.txt") + "by a person\n");

  await openDiff(bridge, sessionA, 1);
  await bridge.clickByName("Restore to T1", { within: ".turn-sheet-actions" });
  const preview = await bridge.waitFor("the restore preview", `
    const s = e2e.first('.turn-sheet[data-sheet="restore"][data-turn-n="1"]');
    const hint = s && e2e.first(".turn-sheet-hint", s);
    return hint ? { files: Number(hint.getAttribute("data-preview-files")), text: e2e.norm(hint.innerText), lines: e2e.all(".turn-diff-line", s).map((l) => l.textContent) } : null;
  `, { timeoutMs: 20_000 });
  preview.lines = stripCr(preview.lines);
  log(`  preview: ${preview.text}`);
  assert(preview.files === 3, `the preview says 3 files would change (app.txt, README.md, notes/new.txt): ${preview.files}`);
  assert(preview.lines.some((l) => l === "-second") && preview.lines.some((l) => l.startsWith("+draft")), "the preview shows the changes restoring would make");
  assert(read(dirA, "src/app.txt").includes("second") && read(dirA, "notes/new.txt") === null, "a preview changes nothing on disk");
  const treeBeforeRestore = worktreeTree(dirA);
  await bridge.screenshot(join(evidenceDir, "03-restore-preview.png"));
  await bridge.clickByName("Restore", { within: ".turn-sheet-actions" });
  await bridge.waitFor("the restore notice", `
    const bar = e2e.first('.turn-bar[data-session-id="' + CSS.escape(${JSON.stringify(sessionA)}) + '"]');
    const n = bar && e2e.first(".turn-bar-notice", bar);
    return n && e2e.norm(n.innerText) === "Restored to T1" ? true : null;
  `, { timeoutMs: 20_000 });
  await bridge.screenshot(join(evidenceDir, "04-restored.png"));
  assert(read(dirA, "src/app.txt") === "hello world\n" || read(dirA, "src/app.txt") === "hello world \n", `src/app.txt is T1's (${JSON.stringify(read(dirA, "src/app.txt"))})`);
  assert(read(dirA, "notes/new.txt")?.trim() === "draft", "the file T3 deleted is back");
  assert(read(dirA, "README.md") === "# f20\n", "README.md is T1's again");
  assert(worktreeTree(dirA) === treeAfterEdit1, "the worktree is exactly the T1 tree");
  const stateAfterRestore = userState(dirA);
  assert(stateAfterRestore.head === stateAtStart.head && stateAfterRestore.index === stateAtStart.index && stateAfterRestore.stash === stateAtStart.stash, "HEAD, index and stash are still untouched after the restore");
  assert(turnRefs(dirA, sessionA).length === 3, "T1..T3 are still there after the restore");
  const keptRefs = (dir, sid) =>
    gitIn(dir, "for-each-ref", "--format=%(refname)", `refs/hermes/${sid}/before-restore/`).split(/\r?\n/).filter(Boolean);
  assert(keptRefs(dirA, sessionA).join(",") === `refs/hermes/${sessionA}/before-restore/1`, `the pre-restore state is kept under before-restore/1: ${keptRefs(dirA, sessionA).join(",")}`);
  assert(gitIn(dirA, "rev-parse", `refs/hermes/${sessionA}/before-restore/1^{tree}`) === treeBeforeRestore, "before-restore/1 is exactly the worktree the restore replaced (including the person's edit)");

  // Now forward again: a second restore, to T3 (the plan's F20-3), after
  // another person edit. It keeps its own pre-restore state and leaves the
  // first one alone.
  log("step D2: Restore to T3 (previewed first) brings back exactly the T3 tree; both pre-restore states are kept");
  writeFileSync(join(dirA, "README.md"), "# f20\nperson again\n");
  const treeBeforeRestore2 = worktreeTree(dirA);
  await openDiff(bridge, sessionA, 3);
  await bridge.clickByName("Restore to T3", { within: ".turn-sheet-actions" });
  const preview3 = await bridge.waitFor("the restore preview of T3", `
    const s = e2e.first('.turn-sheet[data-sheet="restore"][data-turn-n="3"]');
    const hint = s && e2e.first(".turn-sheet-hint", s);
    return hint ? { files: Number(hint.getAttribute("data-preview-files")), text: e2e.norm(hint.innerText), lines: e2e.all(".turn-diff-line", s).map((l) => l.textContent) } : null;
  `, { timeoutMs: 20_000 });
  preview3.lines = stripCr(preview3.lines);
  log(`  preview: ${preview3.text}`);
  assert(preview3.files === 3, `the preview says 3 files would change (app.txt, README.md, notes/new.txt): ${preview3.files}`);
  assert(preview3.lines.some((l) => l === "-draft") && preview3.lines.some((l) => l.startsWith("+second")), "the preview shows the changes restoring to T3 would make");
  assert(read(dirA, "README.md") === "# f20\nperson again\n", "a preview changes nothing on disk");
  await bridge.screenshot(join(evidenceDir, "03b-restore-preview-t3.png"));
  await bridge.clickByName("Restore", { within: ".turn-sheet-actions" });
  await bridge.waitFor("the restore notice", `
    const bar = e2e.first('.turn-bar[data-session-id="' + CSS.escape(${JSON.stringify(sessionA)}) + '"]');
    const n = bar && e2e.first(".turn-bar-notice", bar);
    return n && e2e.norm(n.innerText) === "Restored to T3" ? true : null;
  `, { timeoutMs: 20_000 });
  assert(worktreeTree(dirA) === treeAtT3, "the worktree is exactly the T3 tree");
  assert(read(dirA, "notes/new.txt") === null && read(dirA, "README.md").startsWith("# changed"), "notes/new.txt is gone again and README.md is T3's");
  const stateAfterRestore2 = userState(dirA);
  assert(stateAfterRestore2.head === stateAtStart.head && stateAfterRestore2.index === stateAtStart.index && stateAfterRestore2.stash === stateAtStart.stash, "HEAD, index and stash are still untouched after the second restore");
  assert(keptRefs(dirA, sessionA).join(",") === `refs/hermes/${sessionA}/before-restore/1,refs/hermes/${sessionA}/before-restore/2`, `two pre-restore states are kept: ${keptRefs(dirA, sessionA).join(",")}`);
  assert(gitIn(dirA, "rev-parse", `refs/hermes/${sessionA}/before-restore/1^{tree}`) === treeBeforeRestore, "before-restore/1 was not overwritten by the second restore");
  assert(gitIn(dirA, "rev-parse", `refs/hermes/${sessionA}/before-restore/2^{tree}`) === treeBeforeRestore2, "before-restore/2 is exactly the worktree the second restore replaced");

  // ── E. the kill switch ──────────────────────────────────────────
  log("step E: the kill switch (the checkbox in Settings > Git) stops recording; ticking it again records again");
  assert((await setTurnLedgerInSettings(bridge, false, "06-settings-git-off.png")) === false, "the checkbox is unticked after a real click");
  assert((await invoke(bridge, "get_settings")).turn_ledger === "off", "the click saved turn_ledger=off");
  await runAgent(bridge, sessionA, shellKind, SCEN.edit4, "fake-agent: edit4 done");
  assert(await inject(bridge, sessionA, { type: "turn_end", at: Date.now(), n: 5, source: "e2e" }), "turn_end injected");
  await sleep(3000);
  assert((await chipsOf(bridge, sessionA)).length === 3, "no chip was added while the switch is off");
  assert(turnRefs(dirA, sessionA).length === 3, "no ref was added while the switch is off");
  assert((await setTurnLedgerInSettings(bridge, true, "07-settings-git-on.png")) === true, "the checkbox is ticked again after a real click");
  assert((await invoke(bridge, "get_settings")).turn_ledger === "on", "the click saved turn_ledger=on");
  assert(await inject(bridge, sessionA, { type: "turn_end", at: Date.now(), n: 6, source: "e2e" }), "turn_end injected");
  const t4 = await waitForChip(bridge, sessionA, 4);
  assert(t4.files === 1, `T4 records the edit made while the switch was off, now that it is on: ${JSON.stringify(t4)}`);

  // ── F. the PTY heuristic in a Custom-agent session ──────────────
  log("step F: a Custom-agent session; the agent edits then goes quiet: a turn is recorded from the PTY alone");
  const command = commandLine(shellKind, process.execPath, [FAKE_AGENT, "--scenario", SCEN.idle, "--log", join(evidenceDir, "fake-agent-idle.jsonl")]);
  const readmeBefore = read(dirA, "README.md");
  sessionB = await createSession(bridge, { label: "F20 guessed", custom: { name: "Fake Agent", command } });
  const dirB = await sessionDir(bridge, sessionB);
  log(`  session ${sessionB} runs in ${dirB}`);
  await bridge.waitForTerminal(sessionB, /^fake-agent: idle now/, { timeoutMs: 60_000 });
  assert(read(dirB, "README.md") !== readmeBefore, "the agent appended to README.md through the shell");
  const g1 = await waitForChip(bridge, sessionB, 1, { timeoutMs: 30_000 });
  assert(g1.files === 1, `a turn was recorded from the Busy -> Idle transition with no injected event: ${JSON.stringify(g1)}`);
  const linesG1 = await openDiff(bridge, sessionB, 1);
  assert(linesG1.some((l) => l.startsWith("+guessed")), "its diff shows the agent's edit");
  await bridge.screenshot(join(evidenceDir, "05-guessed-turn.png"));
  await closeSheet(bridge);
  await sleep(2500);
  assert((await chipsOf(bridge, sessionB)).length === 1, "the agent staying quiet does not add turns");
  await bridge.typeInTerminal(sessionB, "q");
  await bridge.waitForTerminal(sessionB, /^fake-agent bye/, { timeoutMs: 15_000 });
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      for (const sid of [sessionA, sessionB]) {
        if (!sid) continue;
        const lines = (await app.bridge.readTerminal(sid)) ?? [];
        log(`  terminal ${sid} (last lines):`);
        for (const l of lines.slice(-12)) log(`    | ${l}`);
      }
      log(`  refs: ${JSON.stringify(gitIn(dirA, "for-each-ref", "refs/hermes/"))}`);
    }
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  if (app?.isRunning()) {
    log("step G: quit the app");
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
    if (!failed && (exit.forced || exit.code !== 0)) {
      failed = true;
      log("FAILED: the app did not quit cleanly");
    }
  }
  try {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    rmSync(fakeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch { /* leave it */ }
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
