#!/usr/bin/env node
// Scenario: F26 — worktree recipes (.hermes/worktree.toml), on the REAL app,
// with a throwaway git repository and plain shell sessions (no agent account).
//
//   run 1  fresh install: welcome screens; turn the honestIsolation flag on
//          (recipes ship behind it; flags are read at startup), quit
//   run 2  - task 0: the repo has no worktree.toml -> nothing shows, nothing
//            is copied, the session starts as before
//          - the repo gets a recipe (setup, copy .env/.env.local, done_when,
//            [ports] web = P while something else listens on P)
//            task A: the panel asks first, listing the command; nothing runs
//            and no session exists until "Run setup". Then the log streams
//            (the setup command waits for the scenario, so the log is read
//            mid-run and the session is proven not to exist yet); .env is
//            copied, and its secret is masked in the log; the port handed
//            out is P+1 (P is busy); once it finishes the session starts
//          - task B, same file: runs without asking; gets another port
//          - the recipe changes to a failing setup: task C asks again (the
//            file changed); the failure shows in the log and raises ONE
//            inbox error for C; C's session still starts
//          - the recipe copies ".env*", which matches the tracked
//            .env.example: task D's copy is refused with a message, setup
//            does not run, an inbox error is raised
//          - the settings export has no trace of the approval or the secret
//          quit; no file in the app's data folder (nor its log) contains the
//          secret
//
// Negative control: HERMES_E2E_F26_FLAG=off leaves the flag off, so task A
// never shows the panel and the scenario must end in RESULT: FAIL.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F26-worktree-recipes.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/F26-worktree-recipes.

import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "F26-worktree-recipes";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);
const FLAG_ON = (process.env.HERMES_E2E_F26_FLAG || "on") !== "off";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

// A synthetic secret: it must never be shown, stored or exported.
const SECRET = "f26-fake-fake-fake-fake";

// ── A throwaway repository (synthetic identity, never the real one) ──
const workDir = realpathSync.native(mkdtempSync(join(tmpdir(), "hermes-e2e-f26-")));
const repo = join(workDir, "f26-repo");
const control = join(workDir, "control");
mkdirSync(control, { recursive: true });
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
git("config", "core.autocrlf", "false");
mkdirSync(join(repo, "scripts"), { recursive: true });
writeFileSync(join(repo, "README.md"), "# f26\n");
writeFileSync(join(repo, ".gitignore"), ".env*\n!.env.example\nsetup-ran.txt\n");
writeFileSync(join(repo, ".env.example"), "API_KEY=\n");
// The setup command: reports what it sees, can fail, can wait for the
// scenario (F26_CONTROL_DIR/go) so the log can be read while it runs.
writeFileSync(
  join(repo, "scripts", "setup.js"),
  `const fs = require("fs");
const path = require("path");
const mode = process.argv[2] || "ok";
console.log("f26-setup start mode=" + mode);
console.log("f26-setup port web=" + process.env.HERMES_PORT_WEB);
let env = "(no .env)";
try { env = fs.readFileSync(".env", "utf8").trim(); } catch {}
console.log("f26-setup env: " + env);
fs.writeFileSync("setup-ran.txt", JSON.stringify({ mode, port: process.env.HERMES_PORT_WEB, worktree: process.env.HERMES_WORKTREE }));
if (mode === "fail") { console.error("f26-setup failing on purpose"); process.exit(7); }
if (mode === "wait") {
  const go = path.join(process.env.F26_CONTROL_DIR || ".", "go");
  console.log("f26-setup waiting");
  const until = Date.now() + 120000;
  const nap = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(go) && Date.now() < until) Atomics.wait(nap, 0, 0, 100);
}
console.log("f26-setup done");
`,
);
git("add", ".");
git("commit", "-q", "-m", "initial");
// Local secrets the recipe copies: ignored by git, so never committed.
writeFileSync(join(repo, ".env"), `API_KEY=${SECRET}\nPORT=3000\n`);
writeFileSync(join(repo, ".env.local"), "LOCAL_ONLY=f26-local-value\n");

function commitRecipe(text, message) {
  mkdirSync(join(repo, ".hermes"), { recursive: true });
  writeFileSync(join(repo, ".hermes", "worktree.toml"), text);
  git("add", ".hermes/worktree.toml");
  git("commit", "-q", "-m", message);
}

/** A port nothing listens on, with the next few free too. */
async function freePortBlock() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const base = 42000 + Math.floor(Math.random() * 15000);
    const ok = await Promise.all([0, 1, 2, 3].map((d) => canListen(base + d)));
    if (ok.every(Boolean)) return base;
  }
  throw new Error("no free port block found");
}
function canListen(port) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}
function listenOn(port) {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}

const samePath = (a, b) => {
  const norm = (p) => {
    try { p = realpathSync.native(p); } catch { /* gone */ }
    return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  };
  return norm(a) === norm(b);
};

// Windows keeps app data under %APPDATA%, which a private HOME does not move.
const onWindows = platform() === "win32";
const homeDir = onWindows ? undefined : mkdtempSync(join(tmpdir(), "hermes-e2e-f26-home-"));
const appEnv = { F26_CONTROL_DIR: control };
function launch(run, { first = false } = {}) {
  const runDir = join(evidenceDir, `run-${run}`);
  return onWindows
    ? launchApp({ runDir, log, home: "real", resetData: first, env: appEnv })
    : launchApp({ runDir, log, home: "private", homeDir, env: appEnv });
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

async function quit(current, opts) {
  const exit = await current.stop(opts);
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
async function clickPrimary(bridge, what) {
  const r = await bridge.clickWhenReady(`
    const b = e2e.must(e2e.first(${JSON.stringify(PRIMARY)}), "the wizard's primary button");
    return e2e.click(b);
  `);
  log(`  wizard ${what}: clicked "${r.clicked}"`);
  await sleep(300);
}

/** Walk the New Session wizard for a plain shell on a new hermes/ branch. */
async function startTask(bridge, label) {
  await bridge.click(".activity-bar-action");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`);
  await bridge.clickWhenReady(`
    const cards = e2e.all(".session-creator-provider-card");
    return e2e.click(e2e.must(cards[cards.length - 1], "plain shell card"));
  `);
  await clickPrimary(bridge, "agent");
  await bridge.waitFor("the folder step", `return !!e2e.first(".workspace-scan-input");`);
  const listed = await bridge.eval(`
    const row = e2e.all(".project-picker-item").find((el) => el.innerText.includes("f26-repo"));
    if (!row) return false;
    if (!row.classList.contains("project-picker-item-attached")) e2e.click(row);
    return true;
  `);
  if (!listed) {
    await bridge.eval(setInput(".workspace-scan-input", repo));
    await bridge.clickByName("Scan", { within: ".project-picker-footer" });
  }
  await bridge.waitFor("the test repo to be selected", `
    return e2e.all(".project-picker-item.project-picker-item-attached").some((el) => el.innerText.includes("f26-repo"));
  `);
  await clickPrimary(bridge, "folder");
  await bridge.waitFor("the branch step", `return !!e2e.first(".session-creator-branch-multi");`, { timeoutMs: 20_000 });
  await bridge.waitFor("a default branch to be chosen", `return !!e2e.first(".session-creator-branch-selected-label");`);
  await clickPrimary(bridge, "branch");
  await bridge.waitFor("the confirm step", `return !!e2e.first('input.command-palette-input[placeholder="Session name (optional)"]');`);
  await bridge.eval(setInput('input.command-palette-input[placeholder="Session name (optional)"]', label));
  await clickPrimary(bridge, "confirm");
}

async function waitForNewSession(bridge, before, label, timeoutMs = 30_000) {
  const id = await bridge.waitFor(`the terminal of "${label}"`, `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
    return ids.length === 1 ? ids[0] : null;
  `, { timeoutMs });
  await bridge.waitFor(`"${label}" in the session list`, `
    return e2e.all(".session-item").some((el) => el.innerText.includes(${JSON.stringify(label)}));
  `);
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  return id;
}

async function projectId(bridge) {
  const projects = await invoke(bridge, "get_registered_projects");
  const p = projects.find((x) => samePath(x.path, repo));
  if (!p) throw new Error("the test repo is not a project");
  return p.id;
}

const runs = (bridge) => bridge.eval(`return window.__HERMES_E2E__.worktreeRecipeRuns();`);
const inbox = (bridge) => bridge.eval(`return window.__HERMES_E2E__.inboxItems();`);

/** The newest recipe card, as the person sees it. */
const cardView = `
  const cards = e2e.all(".worktree-recipe-card");
  const c = cards[cards.length - 1];
  if (!c) return null;
  return {
    runId: c.dataset.runId,
    sessionId: c.dataset.sessionId,
    state: c.dataset.state,
    stateText: e2e.norm(c.querySelector(".worktree-recipe-state")?.textContent),
    text: c.innerText,
    commands: [...c.querySelectorAll(".worktree-recipe-commands code")].map((e) => e.innerText),
    log: c.querySelector(".worktree-recipe-log")?.innerText ?? "",
    buttons: [...c.querySelectorAll("button")].map(e2e.nameOf),
  };
`;
async function waitCard(bridge, what, predicate, timeoutMs = 60_000) {
  return bridge.waitFor(what, `const v = (() => { ${cardView} })(); return v && (${predicate})(v) ? v : null;`, { timeoutMs, intervalMs: 200 });
}
async function clickOnCard(bridge, runId, name) {
  await bridge.clickWhenReady(`
    const c = e2e.first('.worktree-recipe-card[data-run-id="${runId}"]');
    const b = c && [...c.querySelectorAll("button")].find((x) => e2e.nameOf(x) === ${JSON.stringify(name)});
    return e2e.click(e2e.must(b, ${JSON.stringify(name)}));
  `);
}

/** Unfold a finished card's log and read the card again. */
async function openLog(bridge, runId) {
  await clickOnCard(bridge, runId, "Show log");
  return waitCard(bridge, "the log to unfold", `(v) => v.runId === ${JSON.stringify(runId)} && v.log !== ""`, 10_000);
}

/** Every file under `dir` whose bytes contain `needle`. */
function filesContaining(dir, needle) {
  const hits = [];
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          if (statSync(p).size < 200 * 1024 * 1024 && readFileSync(p).includes(needle)) hits.push(p);
        } catch { /* unreadable */ }
      }
    }
  };
  walk(dir);
  return hits;
}

let app;
let failed = false;
let busy = null;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   flag: ${FLAG_ON ? "on" : "OFF (negative control)"}`);
  log(`test repo: ${repo}`);

  // ── run 1: onboarding, flag on ──────────────────────────────────
  log("step 1: fresh launch; turn the honestIsolation flag on (read at next start)");
  app = await launch(1, { first: true });
  await completeOnboarding(app.bridge);
  if (FLAG_ON) {
    await invoke(app.bridge, "set_setting", { key: "feature_flag_overrides", value: JSON.stringify({ honestIsolation: true }) });
  }
  await quit(app);

  // ── run 2 ───────────────────────────────────────────────────────
  app = await launch(2);
  const { bridge } = app;
  await bridge.waitFor("the app UI (returning launch)", `return !!e2e.first(".topbar") && !e2e.first(".onboarding-backdrop");`);
  await dismissWhatsNew(bridge);

  log("step 2: task 0 — no worktree.toml, so nothing changes");
  let before = await bridge.terminalIds();
  await startTask(bridge, "F26 task 0");
  const id0 = await waitForNewSession(bridge, before, "F26 task 0");
  const pid = await projectId(bridge);
  const wt0 = await invoke(bridge, "git_session_worktree_info", { sessionId: id0, projectId: pid });
  log(`  task 0: ${JSON.stringify(wt0)}`);
  assert(wt0 && !wt0.isMainWorktree, "task 0 has its own worktree");
  await sleep(500);
  assert(!(await bridge.exists(".worktree-recipe-panel")), "no setup panel appears");
  assert((await runs(bridge)).length === 0, "no recipe ran");
  assert(!existsSync(join(wt0.worktreePath, ".env")), "no file was copied into the worktree");

  // A recipe with a port that is busy: Hermes must hand out the next one.
  const base = await freePortBlock();
  busy = await listenOn(base);
  log(`  port ${base} is held by the scenario (busy for Hermes)`);
  commitRecipe(
    `# F26 scenario recipe
setup = ["node scripts/setup.js wait"]
copy = [".env", ".env.local"]
done_when = ["node scripts/check.js"]

[ports]
web = ${base}
`,
    "add a worktree recipe",
  );

  log("step 3: task A — asked first; nothing runs and no session starts before the answer");
  before = await bridge.terminalIds();
  await startTask(bridge, "F26 task A");
  const askA = await waitCard(bridge, "the setup question for task A", `(v) => v.state === "awaiting"`, 30_000);
  log(`  card: ${askA.text.replace(/\s+/g, " ").trim()}`);
  assert(askA.commands.length === 1 && askA.commands[0] === "node scripts/setup.js wait", `it lists the command (${JSON.stringify(askA.commands)})`);
  assert(/\.env, \.env\.local/.test(askA.text), "it lists what it will copy");
  assert(askA.buttons.includes("Run setup") && askA.buttons.includes("Skip"), `it offers Run setup and Skip (${JSON.stringify(askA.buttons)})`);
  await bridge.screenshot(join(evidenceDir, "01-asks-first.png"));
  const wtA = await invoke(bridge, "git_session_worktree_info", { sessionId: askA.sessionId, projectId: pid });
  assert(!!wtA && !wtA.isMainWorktree, "task A's worktree already exists");
  await sleep(1000);
  assert(!existsSync(join(wtA.worktreePath, ".env")) && !existsSync(join(wtA.worktreePath, "setup-ran.txt")), "nothing was copied or run before the answer");
  assert((await bridge.terminalIds()).length === before.length, "no session started before the answer");

  await clickOnCard(bridge, askA.runId, "Run setup");
  const midA = await waitCard(bridge, "the log to show setup waiting", `(v) => v.state === "running" && v.log.includes("f26-setup waiting")`);
  log(`  log mid-run:\n${midA.log}`);
  assert(midA.stateText === "Running", "the card says Running");
  assert(/copied \.env\b/.test(midA.log) && /copied \.env\.local/.test(midA.log), "the log shows the copies");
  assert(midA.log.includes("f26-setup env: API_KEY=••••••"), "the secret read by setup is masked in the log");
  assert(!midA.log.includes(SECRET), "the secret itself is not in the log");
  assert(midA.log.includes(`f26-setup port web=${base + 1}`), `setup got HERMES_PORT_WEB=${base + 1} (${base} is busy)`);
  assert(midA.log.includes(`Ports: web=${base + 1} (HERMES_PORT_WEB)`), "the log names the port");
  assert((await bridge.terminalIds()).length === before.length, "the session still has not started while setup runs");
  assert(await bridge.exists(".session-creator"), "the New Session wizard is still waiting");
  const domText = await bridge.eval(`return document.body.innerText;`);
  assert(!domText.includes(SECRET), "the secret is nowhere on screen");
  await bridge.screenshot(join(evidenceDir, "02-log-streaming.png"));

  writeFileSync(join(control, "go"), "");
  const foldedA = await waitCard(bridge, "task A's setup to finish", `(v) => v.state === "succeeded"`);
  const idA = await waitForNewSession(bridge, before, "F26 task A");
  assert(idA === askA.sessionId, "the session started under the id the setup ran for");
  assert(foldedA.log === "" && foldedA.buttons.includes("Show log"), "a good run folds its log away, one click from view");
  assert(!(await bridge.exists(".worktree-recipe-panel-active")), "a finished card sits below dialogs");
  const doneA = await openLog(bridge, foldedA.runId);
  assert(doneA.stateText === "Ready" && /Setup finished in/.test(doneA.log) && doneA.log.includes("f26-setup done"), "the card says Ready and the log ends with the finish");
  assert(doneA.text.includes(`Ports: web ${base + 1}`) && doneA.text.includes("Done when: node scripts/check.js"), "the card shows the port and the default check");
  assert(readFileSync(join(wtA.worktreePath, ".env"), "utf8") === readFileSync(join(repo, ".env"), "utf8"), ".env was copied as is");
  assert(existsSync(join(wtA.worktreePath, ".env.local")), ".env.local was copied");
  const ranA = JSON.parse(readFileSync(join(wtA.worktreePath, "setup-ran.txt"), "utf8"));
  assert(ranA.mode === "wait" && samePath(ranA.worktree, wtA.worktreePath), "setup ran inside the new worktree with HERMES_WORKTREE");
  const checksA = await bridge.eval(`return window.__HERMES_E2E__.defaultDoneWhen(${JSON.stringify(idA)});`);
  assert(JSON.stringify(checksA) === JSON.stringify(["node scripts/check.js"]), "the session's default done_when is recorded for Done-When");
  assert((await inbox(bridge)).length === 0, "a good run raises nothing");
  rmSync(join(control, "go"), { force: true });
  await clickOnCard(bridge, doneA.runId, "Close");
  await bridge.waitFor("the card to close", `return !e2e.first('.worktree-recipe-card[data-run-id="${doneA.runId}"]');`);

  log("step 4: task B — same file, approved before: runs without asking, on another port");
  writeFileSync(join(control, "go"), "");
  before = await bridge.terminalIds();
  await startTask(bridge, "F26 task B");
  const foldedB = await waitCard(bridge, "task B's setup to finish (no question)", `(v) => v.state === "succeeded"`);
  const idB = await waitForNewSession(bridge, before, "F26 task B");
  const doneB = await openLog(bridge, foldedB.runId);
  assert(doneB.sessionId === idB, "the card is task B's");
  assert(doneB.log.includes(`f26-setup port web=${base + 2}`), `task B got port ${base + 2}: A holds ${base + 1}, ${base} is busy`);
  rmSync(join(control, "go"), { force: true });

  log("step 5: the recipe changes to a failing setup — task C asks again, fails, raises one inbox error");
  commitRecipe(`setup = ["node scripts/setup.js fail"]\ncopy = [".env"]\n`, "failing recipe");
  before = await bridge.terminalIds();
  await startTask(bridge, "F26 task C");
  const askC = await waitCard(bridge, "the question again (the file changed)", `(v) => v.state === "awaiting"`, 30_000);
  assert(askC.commands[0] === "node scripts/setup.js fail", "it shows the new command");
  await clickOnCard(bridge, askC.runId, "Run setup");
  const failC = await waitCard(bridge, "task C's setup to fail", `(v) => v.state === "failed"`);
  const idC = await waitForNewSession(bridge, before, "F26 task C");
  log(`  log:\n${failC.log}`);
  assert(failC.stateText === "Failed", "the card says Failed");
  assert(failC.log.includes("f26-setup failing on purpose"), "the command's error output is in the log");
  assert(/exited with code 7/.test(failC.text), "the card says which command failed and how");
  const itemsC = await inbox(bridge);
  log(`  inbox: ${JSON.stringify(itemsC)}`);
  assert(itemsC.length === 1, "exactly one inbox item");
  assert(itemsC[0].kind === "error" && itemsC[0].sessionId === idC && itemsC[0].source === "worktree", "an error for task C, raised by the worktree setup");
  assert(/Setup failed in f26-repo: `node scripts\/setup\.js fail` exited with code 7/.test(itemsC[0].detail), `it says what failed: ${itemsC[0].detail}`);
  await bridge.screenshot(join(evidenceDir, "03-failure.png"));

  log("step 6: copy \".env*\" matches the tracked .env.example — refused with a message, setup does not run");
  commitRecipe(`setup = ["node scripts/setup.js ok"]\ncopy = [".env*"]\n`, "copy everything");
  before = await bridge.terminalIds();
  await startTask(bridge, "F26 task D");
  const askD = await waitCard(bridge, "the question for task D", `(v) => v.state === "awaiting"`, 30_000);
  await clickOnCard(bridge, askD.runId, "Run setup");
  const failD = await waitCard(bridge, "task D's copy to be refused", `(v) => v.state === "failed"`);
  const idD = await waitForNewSession(bridge, before, "F26 task D");
  log(`  log:\n${failD.log}`);
  assert(failD.text.includes('Refused copy ".env*": .env.example is tracked by git (copy only takes files git ignores)'), "the refusal names the pattern and the tracked file");
  assert(failD.log.includes("Setup did not run.") && !failD.log.includes("f26-setup start"), "setup did not run");
  const wtD = await invoke(bridge, "git_session_worktree_info", { sessionId: idD, projectId: pid });
  assert(!existsSync(join(wtD.worktreePath, ".env")) && !existsSync(join(wtD.worktreePath, "setup-ran.txt")), "nothing was copied into task D's worktree");
  const itemsD = (await inbox(bridge)).filter((i) => i.sessionId === idD);
  assert(itemsD.length === 1 && itemsD[0].kind === "error" && itemsD[0].detail.includes(".env.example is tracked by git"), "task D's refusal is an inbox error");
  await bridge.screenshot(join(evidenceDir, "04-refused-copy.png"));

  log("step 7: the settings export carries neither the approval nor the secret");
  const exportFile = join(workDir, "settings-export.json");
  await invoke(bridge, "export_settings", { path: exportFile });
  const exported = readFileSync(exportFile, "utf8");
  assert(!exported.includes("worktree_recipe_trust") && !exported.includes(SECRET), "the export has no recipe approvals and no secret");
  const dataDir = app.dataDir;
  const appLog = app.appLog;
  await quit(app, { keepFiles: true });
  const hits = filesContaining(dataDir, SECRET);
  log(`  scanned ${dataDir}`);
  // The worktrees themselves live under the data folder; the .env the
  // recipe copied into them is the one place the secret belongs.
  const inWorktrees = (p) => /[\\/]hermes-worktrees[\\/][^\\/]+[\\/][^\\/]+[\\/]\.env$/.test(p);
  assert(hits.filter(inWorktrees).length === 3, `the secret is in the three worktrees' copied .env (${hits.length} hits)`);
  const stored = hits.filter((p) => !inWorktrees(p));
  assert(stored.length === 0, `no file Hermes keeps (database, settings, logs) contains the secret (${JSON.stringify(stored)})`);
  assert(!readFileSync(appLog, "utf8").includes(SECRET), "the app's log does not contain the secret");
  app.cleanup();
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      const dump = await app.bridge.eval(`
        return {
          buttons: e2e.all("button").map(e2e.nameOf).slice(0, 40),
          runs: window.__HERMES_E2E__.worktreeRecipeRuns?.().map((r) => ({ state: r.state, failure: r.failure, lines: r.lines.slice(-10) })),
        };
      `);
      log(`  what the app showed: ${JSON.stringify(dump)}`);
    }
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  writeFileSync(join(control, "go"), ""); // release a waiting setup, if any
  if (app?.isRunning()) {
    log("finally: quit the app");
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
    if (!failed && (exit.forced || exit.code !== 0)) {
      failed = true;
      log("FAILED: the app did not quit cleanly");
    }
  }
  busy?.close();
  if (homeDir) rmSync(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
