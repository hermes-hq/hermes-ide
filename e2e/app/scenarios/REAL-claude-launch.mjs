#!/usr/bin/env node
// Scenario REAL-claude-launch (local only): the REAL `claude` CLI, started
// the way a person starts it in 2.0 — ⌘N, the task launcher, Claude in a
// terminal — inside the isolated test build with a fresh profile.
//
// It runs only on a machine with a signed-in `claude` on PATH and never in
// CI (RESULT: SKIP otherwise; e2e/app/ci-plan.mjs lists it as excluded).
// One tiny turn on the cheapest model (the throwaway repository's own
// .claude/settings.json picks haiku), so a run costs a fraction of a cent.
//
// The test app is started as if from inside another Claude Code session
// (CLAUDECODE, CLAUDE_CODE_CHILD_SESSION, ... in its environment) because
// that is how the 2.0 user test found the nested agent unable to save its
// transcript. What must hold:
//
//   - the agent is started by the bundled helper (`hi run <session>` is the
//     shell's child and `claude` is the helper's child), not typed into the
//     shell as a command line;
//   - the task is the agent's first prompt (its positional argument; the
//     project-context pointer follows it);
//   - the launch's generated hooks file is passed with --settings and lives
//     under the app's data folder; ~/.claude/settings.json is byte-identical
//     before and after;
//   - at least one EXACT status signal arrives: the turn's end is reported
//     by the Stop hook ("done", confidence exact, source hook);
//   - none of the parent session's markers reach the agent's environment,
//     and the agent therefore saved its transcript (a
//     ~/.claude/projects/*/<session id>.jsonl exists after the turn);
//   - no error or warning notice appears while the first session starts.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/REAL-claude-launch.mjs
//
// Evidence (log, screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/REAL-claude-launch.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { IS_CI, createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "REAL-claude-launch";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

const which = (name) => {
  const r = spawnSync(platform() === "win32" ? "where" : "which", [name], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] : "";
};
const claudeBin = which("claude");
if (IS_CI || platform() === "win32" || !claudeBin) {
  log(`needs a real, signed-in claude on PATH, macOS or Linux, and no CI (CI=${process.env.CI ?? ""}, claude=${claudeBin || "none"})`);
  log("RESULT: SKIP (real claude not available here, or CI)");
  process.exit(0);
}

// ─── What the parent Claude Code session leaves in the environment ────
// The names a Claude Code session sets for the processes it starts (seen
// on the maintainer's machine); a nested claude that inherits
// CLAUDE_CODE_CHILD_SESSION stops saving its transcript.
const PARENT_MARKERS = {
  CLAUDECODE: "1",
  CLAUDE_CODE_CHILD_SESSION: "1",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CLAUDE_CODE_SESSION_ID: "00000000-0000-4000-8000-00000000e2e1",
  CLAUDE_CODE_SESSION_ATTENDED: "1",
  CLAUDE_CODE_MESSAGING_SOCKET: join(tmpdir(), "hermes-e2e-no-such.sock"),
  CLAUDE_CODE_MESSAGING_TOKEN: "not-a-real-token",
  CLAUDE_CODE_EXECPATH: claudeBin,
  CLAUDE_EFFORT: "low",
  CLAUDE_PID: String(process.pid),
};

const home = homedir();
const guarded = [join(home, ".claude", "settings.json")].filter(existsSync);
const before = new Map(guarded.map((f) => [f, readFileSync(f)]));

// A throwaway repository; its project settings pick the cheapest model so
// nothing global changes.
const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "hermes-e2e-real-launch-")));
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
writeFileSync(join(repo, "README.md"), "# throwaway\n\nA scratch repository for a Hermes test. Nothing here matters.\n");
mkdirSync(join(repo, ".claude"), { recursive: true });
writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ model: "haiku" }, null, 2) + "\n");
git("add", ".");
git("commit", "-q", "-m", "init");

const TASK = "Reply with the word ok and nothing else. Do not read any file.";

// ─── UI steps ────────────────────────────────────────────────────────

const invoke = (bridge, cmd, args) =>
  bridge.eval(`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})});`);

/** Collect error/warning notices and console errors from now on. */
const armCollectors = (bridge) =>
  bridge.eval(`
    if (!window.__hermesE2ENotices) {
      window.__hermesE2ENotices = [];
      window.__hermesE2EConsole = [];
      const seen = new WeakSet();
      const scan = () => {
        for (const el of document.querySelectorAll(".toast")) {
          if (seen.has(el)) continue;
          seen.add(el);
          window.__hermesE2ENotices.push({ type: [...el.classList].find((c) => c.startsWith("toast-") && c !== "toast-icon") ?? "", text: (el.querySelector(".toast-message")?.innerText ?? el.innerText).trim() });
        }
      };
      new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
      scan();
      const orig = console.error.bind(console);
      console.error = (...a) => { window.__hermesE2EConsole.push(a.map((x) => (x instanceof Error ? x.stack || x.message : String(x))).join(" ")); orig(...a); };
      window.addEventListener("error", (e) => window.__hermesE2EConsole.push("window.error: " + (e.message || String(e))));
      window.addEventListener("unhandledrejection", (e) => window.__hermesE2EConsole.push("unhandledrejection: " + String(e.reason?.stack || e.reason)));
    }
    return true;
  `);
const collected = (bridge) => bridge.eval(`return { notices: window.__hermesE2ENotices ?? [], console: window.__hermesE2EConsole ?? [] };`);

async function threeStepWelcome(bridge) {
  await bridge.waitFor("the first-launch welcome", `return !!e2e.first(".setup-dialog, .onboarding-dialog");`, { timeoutMs: 30_000 });
  assert(await bridge.exists(".setup-dialog"), "a fresh profile gets the three-step welcome");
  await bridge.click("#setup-policy-accept");
  await bridge.waitFor("Continue", `return !e2e.first(".setup-continue").disabled;`);
  await bridge.click(".setup-continue");
  await bridge.waitFor("the repository step", `return e2e.first(".setup-dialog")?.getAttribute("data-step") === "repo";`);
  await bridge.click(".setup-skip");
  await bridge.waitFor("the task step", `return e2e.first(".setup-dialog")?.getAttribute("data-step") === "task";`);
  await bridge.click(".setup-finish");
  await bridge.waitFor("the welcome to close", `return !e2e.first(".setup-backdrop");`);
  await sleep(300);
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
}

/** ⌘N: on macOS the File menu's action (the rig cannot press the native key equivalent). */
async function openLauncher(bridge) {
  if (platform() === "darwin") {
    const r = await bridge.eval(`
      try {
        await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu-action", payload: { action: "file.new-session" } });
        return true;
      } catch (e) { return String(e); }
    `);
    assert(r === true, "the File menu delivered New Session (⌘N)");
  } else {
    await bridge.eval(`
      (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "n", code: "KeyN", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
      return true;
    `);
  }
  await bridge.waitFor("the task launcher (not the old creator)", `
    if (e2e.first(".session-creator")) throw new Error("the old New Session creator opened instead of the task launcher");
    return !!e2e.first(".task-launcher-sheet .task-launcher");
  `, { timeoutMs: 20_000 });
}
const typeInto = (bridge, selector, value) =>
  bridge.eval(`
    const el = e2e.must(e2e.first(${JSON.stringify(selector)}), ${JSON.stringify(selector)});
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    el.focus();
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return el.value;
  `);
const launcherState = (bridge) =>
  bridge.eval(`
    return {
      agentText: e2e.norm(e2e.first('[data-chip="agent"]')?.innerText ?? ""),
      terminal: e2e.first('.task-launcher-view [data-mode="terminal"]')?.getAttribute("aria-checked") === "true",
      blocks: e2e.all(".task-launcher-block").map((b) => ({ kind: b.getAttribute("data-kind"), text: e2e.norm(b.innerText) })),
      launchDisabled: !!e2e.first(".task-launcher-launch")?.disabled,
    };
  `);
/** A chip's menu, then an item in it (the launcher's own UI). */
async function pickInMenu(bridge, chip, item) {
  await bridge.waitFor(`the ${chip} menu`, `
    if (e2e.first('.task-launcher-menu[data-menu="${chip}"]')) return true;
    const c = e2e.first('[data-chip="${chip}"]');
    return c && !c.disabled ? (e2e.click(c), false) : false;
  `);
  if (item) await bridge.waitFor(`${item} in the ${chip} menu`, `const el = e2e.first('.task-launcher-menu ${item}'); return el && !el.disabled ? e2e.click(el) : false;`);
}
const pressEnterInTask = (bridge) =>
  bridge.eval(`
    const ta = e2e.must(e2e.first(".task-launcher-task"), "task field");
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    return true;
  `);

async function waitForStrip(bridge, sessionId, kinds, { confidence = null, timeoutMs = 120_000 } = {}) {
  const t0 = Date.now();
  const strip = await bridge.waitFor(`the strip to show ${kinds.join("/")}${confidence ? ` (${confidence})` : ""}`, `
    const el = e2e.first('.session-status-strip[data-strip-session="${sessionId}"]');
    if (!el || !${JSON.stringify(kinds)}.includes(el.dataset.statusKind)) return null;
    if (${JSON.stringify(confidence)} !== null && el.dataset.confidence !== ${JSON.stringify(confidence)}) return null;
    return { kind: el.dataset.statusKind, confidence: el.dataset.confidence, source: el.dataset.source, text: e2e.norm(el.innerText) };
  `, { timeoutMs, intervalMs: 50 });
  return { strip, ms: Date.now() - t0 };
}
const stripText = (bridge, sessionId) => bridge.eval(`const el = e2e.first('.session-status-strip[data-strip-session="${sessionId}"]'); return el ? e2e.norm(el.innerText) : null;`);
const tail = async (bridge, sessionId, n = 10) => ((await bridge.readTerminal(sessionId)) ?? []).slice(-n);

async function answerTrustPrompt(bridge, sessionId, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lines = (await bridge.readTerminal(sessionId)) ?? [];
    if (lines.some((l) => /trust/i.test(l))) {
      const yesBelow = lines.some((l) => /❯\s*No, exit/.test(l));
      log(`  trust prompt seen; accepting with ${yesBelow ? "Down + " : ""}Enter`);
      await sleep(500);
      if (yesBelow) {
        await bridge.eval(`
          const host = document.querySelector('div[data-session-id="${sessionId}"]');
          const ta = e2e.must(host && host.querySelector("textarea.xterm-helper-textarea"), "terminal input");
          for (const type of ["keydown", "keyup"]) {
            const ev = new KeyboardEvent(type, { key: "ArrowDown", code: "ArrowDown", bubbles: true, cancelable: true, composed: true, view: window });
            Object.defineProperty(ev, "keyCode", { get: () => 40 });
            Object.defineProperty(ev, "which", { get: () => 40 });
            ta.dispatchEvent(ev);
          }
          return true;
        `);
        await sleep(300);
      }
      await bridge.typeInTerminal(sessionId, "\n");
      return true;
    }
    // Already past it (the strip reports the agent started).
    const kind = await bridge.eval(`return e2e.first('.session-status-strip[data-strip-session="${sessionId}"]')?.dataset.statusKind ?? null;`);
    if (kind && kind !== "starting" && kind !== "launching") return false;
    await sleep(250);
  }
  return false;
}

// ─── Process tree and environment (ps, so nothing runs inside the agent) ──

/** Every process: { pid, ppid, command }. */
function processes() {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out
    .split("\n")
    .map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
}
/** The environment of one of our own processes, as ps reports it. */
function environmentOf(pid) {
  const out = execFileSync("ps", ["-Eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const names = new Set();
  for (const token of out.split(/\s+/)) {
    const m = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (m) names.add(m[1]);
  }
  return names;
}
async function findLaunchTree(sessionId, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const all = processes();
    const byPid = new Map(all.map((p) => [p.pid, p]));
    const hi = all.find((p) => new RegExp(`(^|/)hi run ${sessionId}(\\s|$)`).test(p.command));
    const claude = hi && all.find((p) => p.ppid === hi.pid && /(^|\/)claude(\s|$)|claude.*--session-id/.test(p.command));
    if (hi && claude) return { hi, claude, shell: byPid.get(hi.ppid) ?? null };
    if (Date.now() > deadline) {
      const near = all.filter((p) => p.command.includes(sessionId) || /claude/.test(p.command)).map((p) => `${p.pid} ${p.ppid} ${p.command.slice(0, 160)}`);
      throw new Error(`no \`hi run ${sessionId}\` with a claude child within ${timeoutMs} ms; related processes:\n    ${near.join("\n    ") || "(none)"}`);
    }
    await sleep(250);
  }
}

let app;
let failed = false;
try {
  log(`scenario: ${SCENARIO}   claude: ${claudeBin} (${spawnSync(claudeBin, ["--version"], { encoding: "utf8" }).stdout.trim()})   repo: ${repo}`);
  for (const f of guarded) log(`  guarded: ${f} (${before.get(f).length} bytes)`);
  log(`  the app starts with a parent session's markers: ${Object.keys(PARENT_MARKERS).join(", ")}`);

  app = await launchApp({ runDir: join(evidenceDir, "run-1"), log, home: "real", resetData: true, tmp: "shared", flagDefaults: null, env: PARENT_MARKERS });
  const { bridge } = app;
  await threeStepWelcome(bridge);
  await armCollectors(bridge);
  await bridge.screenshot(join(evidenceDir, "01-fresh.png"));

  log("step 1: ⌘N opens the task launcher; the repository, the task, Claude in a terminal");
  await openLauncher(bridge);
  await bridge.waitFor("the launcher's starting choice", `return e2e.first(".task-launcher")?.getAttribute("data-ready") === "true";`, { timeoutMs: 30_000 });
  await pickInMenu(bridge, "project");
  await typeInto(bridge, ".task-launcher-repo", repo);
  await typeInto(bridge, ".task-launcher-task", TASK);
  await pickInMenu(bridge, "agent", '[data-agent-id="claude"]');
  await bridge.eval(`if (!e2e.first(".task-launcher-options")) e2e.click(e2e.first(".task-launcher-expand")); return true;`);
  await bridge.waitFor("the agent doctor to clear claude", `
    const blocks = e2e.all(".task-launcher-block").length;
    const btn = e2e.first(".task-launcher-launch");
    return blocks === 0 && !!btn && !btn.disabled ? true : null;
  `, { timeoutMs: 60_000 });
  const st = await launcherState(bridge);
  log(`  launcher: ${JSON.stringify(st)}`);
  assert(/^Claude Code/.test(st.agentText) && st.terminal, `Claude in a terminal (${st.agentText})`);
  await bridge.screenshot(join(evidenceDir, "02-launcher.png"));

  log("step 2: Enter starts the agent through the helper, with the task as its first prompt");
  const idsBefore = await bridge.terminalIds();
  await pressEnterInTask(bridge);
  await bridge.waitFor("the launcher to close", `return !e2e.first(".task-launcher-sheet");`, { timeoutMs: 30_000 });
  const [sid] = await bridge.waitFor("the task's terminal", `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(idsBefore)}.includes(id));
    return ids.length >= 1 ? ids : null;
  `, { timeoutMs: 30_000 });
  log(`  session: ${sid}`);

  const launchDir = join(app.dataDir, "launch", sid);
  const launchDeadline = Date.now() + 20_000;
  while (!existsSync(join(launchDir, "launch.json")) && Date.now() < launchDeadline) await sleep(200);
  assert(existsSync(join(launchDir, "launch.json")), `the helper's launch file exists (${launchDir.replace(app.dataDir, "<data>")}/launch.json)`);
  const spec = JSON.parse(readFileSync(join(launchDir, "launch.json"), "utf8"));
  log(`  launch: program ${spec.program}; args ${JSON.stringify(spec.args)}`);
  assert(/(^|\/)claude$/.test(spec.program), `the program is claude (${spec.program})`);
  const settingsAt = spec.args.indexOf("--settings");
  const settingsFile = settingsAt >= 0 ? spec.args[settingsAt + 1] : null;
  assert(settingsFile && settingsFile.startsWith(launchDir) && existsSync(settingsFile), `the generated hooks file is passed with --settings and lives under the app's data folder (${settingsFile?.replace(app.dataDir, "<data>")})`);
  const hooks = JSON.parse(readFileSync(settingsFile, "utf8")).hooks ?? {};
  assert(Object.keys(hooks).includes("Stop") && Object.keys(hooks).includes("SessionStart"), `it carries the per-launch hooks (${Object.keys(hooks).join(", ")})`);
  const sessionIdAt = spec.args.indexOf("--session-id");
  const vendorSessionId = sessionIdAt >= 0 ? spec.args[sessionIdAt + 1] : null;
  assert(vendorSessionId, `the conversation id is pre-assigned (${vendorSessionId})`);
  const prompt = spec.args.slice(settingsAt + 2).find((a) => !a.startsWith("--") && a.includes(TASK)) ?? spec.args[spec.args.length - 1];
  assert(prompt.split(/\r?\n\r?\n|\s+Read the file at /)[0] === TASK, "the task is the agent's first prompt (the project-context pointer follows it)");

  log("step 3: the process tree is shell → hi run → claude, and the parent session's markers are gone");
  const tree = await findLaunchTree(sid);
  log(`  shell : ${tree.shell ? `${tree.shell.pid} ${tree.shell.command.slice(0, 120)}` : "(unknown)"}`);
  log(`  hi    : ${tree.hi.pid} ${tree.hi.command.slice(0, 120)}`);
  log(`  claude: ${tree.claude.pid} ${tree.claude.command.slice(0, 200)}`);
  assert(tree.shell && /(^|\/)(-?)(zsh|bash|fish|sh|dash|ksh)(\s|$)|\/env\s/.test(tree.shell.command), `hi runs under the session's shell (${tree.shell?.command.slice(0, 60)})`);
  assert(tree.claude.ppid === tree.hi.pid, "claude is the helper's child, not a command typed into the shell");
  assert(tree.claude.command.includes(`--session-id ${vendorSessionId}`), "the running claude carries the pre-assigned conversation id");
  const env = environmentOf(tree.claude.pid);
  const leaked = Object.keys(PARENT_MARKERS).filter((n) => env.has(n));
  const scrubbed = [...env].filter((n) => /^CLAUDE/.test(n));
  log(`  claude's environment: ${env.size} variables; CLAUDE* present: ${JSON.stringify(scrubbed)}; HERMES_SESSION_ID: ${env.has("HERMES_SESSION_ID")}`);
  assert(leaked.length === 0, `none of the parent session's markers reached the agent (leaked: ${JSON.stringify(leaked)})`);
  assert(env.has("HERMES_SESSION_ID") && env.has("HERMES_SIGNAL_FILE"), "the helper's own variables are there");

  log("step 4: exact status signals: the start, then the turn's end from the Stop hook");
  await answerTrustPrompt(bridge, sid, { timeoutMs: 45_000 });
  const { strip: started, ms: startMs } = await waitForStrip(bridge, sid, ["idle", "working", "needs_approval", "done_unread"], { confidence: "exact", timeoutMs: 90_000 });
  assert(started.source === "hook", `claude reported its start exactly: "${started.text}" (${startMs} ms)`);
  await bridge.screenshot(join(evidenceDir, "03-started.png"));
  let done = null;
  for (let i = 0; i < 3 && !done; i++) {
    const { strip, ms } = await waitForStrip(bridge, sid, ["needs_approval", "done_unread"], { timeoutMs: 180_000 });
    if (strip.kind === "needs_approval") {
      log(`  claude asks for a permission ("${strip.text}" after ${ms} ms); answering Yes`);
      await bridge.screenshot(join(evidenceDir, `04-approval-${i}.png`));
      await sleep(800);
      await bridge.typeInTerminal(sid, "\n");
      await sleep(1500);
      continue;
    }
    done = { strip, ms };
  }
  assert(done && done.strip.confidence === "exact" && done.strip.source === "hook", `the turn ended, reported by the hook: "${done?.strip.text}" after ${done?.ms} ms`);
  for (const l of await tail(bridge, sid, 8)) log(`    | ${l}`);
  await bridge.screenshot(join(evidenceDir, "05-done.png"));
  const transcriptOff = ((await bridge.readTerminal(sid)) ?? []).some((l) => /transcript saving is off/i.test(l));
  assert(!transcriptOff, "claude did not say that transcript saving is off");

  log("step 5: nothing went wrong on screen while the first session started");
  const seen = await collected(bridge);
  for (const n of seen.notices) log(`  notice (${n.type}): ${n.text}`);
  for (const c of seen.console) log(`  console: ${c.slice(0, 300)}`);
  const bad = seen.notices.filter((n) => n.type === "toast-error" || n.type === "toast-warning");
  assert(bad.length === 0, `no error or warning notice appeared (${JSON.stringify(bad.map((n) => n.text))})`);
  assert(seen.console.length === 0, `no console error (${seen.console.length})`);

  log("step 6: the agent saved its transcript, and quitting leaves the machine as it was");
  await bridge.typeInTerminal(sid, "/exit\n");
  await waitForStrip(bridge, sid, ["exited"], { timeoutMs: 30_000 }).catch(async () => log(`  (claude did not report its exit within 30 s: "${await stripText(bridge, sid)}")`));
  const projects = join(home, ".claude", "projects");
  const transcripts = existsSync(projects)
    ? readdirSync(projects).flatMap((d) => {
        const f = join(projects, d, `${vendorSessionId}.jsonl`);
        return existsSync(f) ? [f] : [];
      })
    : [];
  assert(transcripts.length === 1, `the conversation's transcript exists (${transcripts.map((f) => f.replace(home, "~")).join(", ") || "none"})`);
  {
    const exit = await app.stop();
    assert(exit.code === 0, "the app quit cleanly");
  }
  const appLog = readFileSync(join(evidenceDir, "run-1", "app.log"), "utf8");
  const launchLines = appLog.split("\n").filter((l) => l.includes("[LAUNCH]"));
  for (const l of launchLines.slice(0, 6)) log(`  app: ${l.trim().slice(0, 200)}`);
  assert(launchLines.some((l) => l.includes("→ hi run")), "the app log records the helper launch");
  for (const f of guarded) {
    const after = readFileSync(f);
    assert(Buffer.compare(before.get(f), after) === 0, `${f.replace(home, "~")} is byte-identical before and after (${after.length} bytes)`);
  }
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      const dump = await app.bridge.eval(`
        return {
          strips: e2e.all(".session-status-strip").map((el) => ({ sid: el.dataset.stripSession, text: e2e.norm(el.innerText) })),
          notices: window.__hermesE2ENotices ?? [],
          console: window.__hermesE2EConsole ?? [],
          terminals: window.__HERMES_E2E__.terminalIds().map((id) => ({ id, tail: (window.__HERMES_E2E__.readTerminal(id) || []).slice(-15) })),
        };
      `);
      log(`  what the app showed: ${JSON.stringify(dump)}`);
    }
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  if (app?.isRunning()) {
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
  }
  rmSync(repo, { recursive: true, force: true });
  for (const f of guarded) {
    if (Buffer.compare(before.get(f), readFileSync(f)) !== 0) {
      writeFileSync(f, before.get(f));
      log(`  restored ${f.replace(home, "~")} to its bytes from before the scenario`);
    }
  }
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
