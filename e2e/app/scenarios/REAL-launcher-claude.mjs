#!/usr/bin/env node
// Scenario REAL-launcher-claude (local only): the REAL `claude` CLI started
// from the ⌘N launcher with a model and an effort chosen on its chips, in
// the isolated test build with a fresh profile.
//
// It runs only on a machine with a signed-in `claude` on PATH, macOS or
// Linux, and never in CI (RESULT: SKIP otherwise; e2e/app/ci-plan.mjs lists
// it as excluded). One tiny turn ("reply ok") on sonnet at low effort.
//
// What must hold:
//   - the launcher shows what it will run: `claude … --model sonnet
//     --effort low` with the task;
//   - the process tree is shell → `hi run <session>` → claude (the agent is
//     the helper's child, never a command typed into the shell);
//   - claude's arguments hold exactly one --model (sonnet) and one --effort
//     (low), and the task is its first prompt; the running process carries
//     the same arguments;
//   - the turn ends with an exact status from the agent's own Stop hook;
//   - ~/.claude/settings.json is byte-identical before and after.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/REAL-launcher-claude.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { IS_CI, createLogger, finishScenario, launchApp, outDir, sleep, skipScenario } from "../harness.mjs";

const SCENARIO = "REAL-launcher-claude";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);
const MODEL = "sonnet";
const EFFORT = "low";

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
  skipScenario({ scenario: SCENARIO, evidenceDir, reason: "real claude not available here, or CI", log });
}

const home = homedir();
const guarded = [join(home, ".claude", "settings.json")].filter(existsSync);
const before = new Map(guarded.map((f) => [f, readFileSync(f)]));

const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "hermes-e2e-real-launcher-")));
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Hermes Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Hermes Test", GIT_COMMITTER_EMAIL: "test@example.com", GIT_CONFIG_NOSYSTEM: "1" };
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { env: gitEnv, encoding: "utf8" }).trim();
execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
git("config", "user.name", "Hermes Test");
git("config", "user.email", "test@example.com");
git("config", "commit.gpgsign", "false");
writeFileSync(join(repo, "README.md"), "# throwaway\n\nA scratch repository for a Hermes test. Nothing here matters.\n");
git("add", ".");
git("commit", "-q", "-m", "init");

const TASK = "Reply with the word ok and nothing else. Do not read any file.";

const typeInto = (bridge, selector, value) =>
  bridge.eval(`
    const el = e2e.must(e2e.first(${JSON.stringify(selector)}), ${JSON.stringify(selector)});
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    el.focus();
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return el.value;
  `);
async function pickInMenu(bridge, chip, item) {
  await bridge.waitFor(`the ${chip} menu`, `
    if (e2e.first('.task-launcher-menu[data-menu="${chip}"]')) return true;
    const c = e2e.first('[data-chip="${chip}"]');
    return c && !c.disabled ? (e2e.click(c), false) : false;
  `);
  if (item) await bridge.waitFor(`${item} in the ${chip} menu`, `const el = e2e.first('.task-launcher-menu ${item}'); return el && !el.disabled ? e2e.click(el) : false;`);
}

async function threeStepWelcome(bridge) {
  await bridge.waitFor("the first-launch welcome", `return !!e2e.first(".setup-dialog, .onboarding-dialog");`, { timeoutMs: 30_000 });
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

function processes() {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out
    .split("\n")
    .map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
}
async function findLaunchTree(sessionId, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const all = processes();
    const byPid = new Map(all.map((p) => [p.pid, p]));
    const hi = all.find((p) => new RegExp(`(^|/)hi run ${sessionId}(\\s|$)`).test(p.command));
    const claude = hi && all.find((p) => p.ppid === hi.pid && /claude/.test(p.command));
    if (hi && claude) return { hi, claude, shell: byPid.get(hi.ppid) ?? null };
    if (Date.now() > deadline) throw new Error(`no \`hi run ${sessionId}\` with a claude child within ${timeoutMs} ms`);
    await sleep(250);
  }
}
async function waitForStrip(bridge, sessionId, kinds, { confidence = null, timeoutMs = 120_000 } = {}) {
  return bridge.waitFor(`the strip to show ${kinds.join("/")}`, `
    const el = e2e.first('.session-status-strip[data-strip-session="${sessionId}"]');
    if (!el || !${JSON.stringify(kinds)}.includes(el.dataset.statusKind)) return null;
    if (${JSON.stringify(confidence)} !== null && el.dataset.confidence !== ${JSON.stringify(confidence)}) return null;
    return { kind: el.dataset.statusKind, confidence: el.dataset.confidence, source: el.dataset.source, text: e2e.norm(el.innerText) };
  `, { timeoutMs, intervalMs: 100 });
}
async function answerTrustPrompt(bridge, sessionId, { timeoutMs = 45_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lines = (await bridge.readTerminal(sessionId)) ?? [];
    if (lines.some((l) => /trust/i.test(l))) {
      const yesBelow = lines.some((l) => /❯\s*No, exit/.test(l));
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
    const kind = await bridge.eval(`return e2e.first('.session-status-strip[data-strip-session="${sessionId}"]')?.dataset.statusKind ?? null;`);
    if (kind && kind !== "starting") return false;
    await sleep(250);
  }
  return false;
}

let app;
let failed = false;
try {
  log(`scenario: ${SCENARIO}   claude: ${spawnSync(claudeBin, ["--version"], { encoding: "utf8" }).stdout.trim()}   model ${MODEL}, effort ${EFFORT}`);
  app = await launchApp({ runDir: join(evidenceDir, "run-1"), log, home: "real", resetData: true, tmp: "shared", flagDefaults: null });
  const { bridge } = app;
  await threeStepWelcome(bridge);

  log("step 1: ⌘N, the project, the task, Claude, model and effort on their chips");
  if (platform() === "darwin") {
    await bridge.eval(`await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu-action", payload: { action: "file.new-session" } }); return true;`);
  } else {
    await bridge.eval(`(document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "n", code: "KeyN", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })); return true;`);
  }
  await bridge.waitFor("the launcher's starting choice", `return e2e.first(".task-launcher")?.getAttribute("data-ready") === "true";`, { timeoutMs: 30_000 });
  await pickInMenu(bridge, "project");
  await typeInto(bridge, ".task-launcher-repo", repo);
  await typeInto(bridge, ".task-launcher-task", TASK);
  await pickInMenu(bridge, "agent", '[data-agent-id="claude"]');
  await pickInMenu(bridge, "model", `[data-model-id="${MODEL}"]`);
  await pickInMenu(bridge, "effort", `[data-effort="${EFFORT}"]`);
  await bridge.waitFor("Launch to be enabled", `const b = e2e.first(".task-launcher-launch"); return !!b && !b.disabled;`, { timeoutMs: 60_000 });
  const preview = await bridge.eval(`return e2e.norm(e2e.first(".task-launcher-command")?.textContent ?? "");`);
  log(`  Hermes will run: ${preview}`);
  assert(
    preview.startsWith("claude --permission-mode acceptEdits") && preview.includes(`--model ${MODEL}`) && preview.includes(`--effort ${EFFORT}`) && preview.includes(`'${TASK}'`),
    "the launcher shows the command it will run, with the model, the effort and the task",
  );
  await bridge.screenshot(join(evidenceDir, "01-launcher.png"));

  log("step 2: Enter");
  const idsBefore = await bridge.terminalIds();
  await bridge.eval(`const ta = e2e.first(".task-launcher-task"); ta.focus(); ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); return true;`);
  await bridge.waitFor("the launcher to close", `return !e2e.first(".task-launcher-sheet");`, { timeoutMs: 30_000 });
  const [sid] = await bridge.waitFor("the task's terminal", `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(idsBefore)}.includes(id));
    return ids.length >= 1 ? ids : null;
  `, { timeoutMs: 30_000 });
  const launchDir = join(app.dataDir, "launch", sid);
  const deadline = Date.now() + 20_000;
  while (!existsSync(join(launchDir, "launch.json")) && Date.now() < deadline) await sleep(200);
  const spec = JSON.parse(readFileSync(join(launchDir, "launch.json"), "utf8"));
  log(`  launch: program ${spec.program}; args ${JSON.stringify(spec.args.map((a) => (a.length > 80 ? `${a.slice(0, 80)}…` : a)))}`);
  const count = (flag) => spec.args.filter((a) => a === flag).length;
  const valueOf = (flag) => spec.args[spec.args.indexOf(flag) + 1];
  assert(count("--model") === 1 && valueOf("--model") === MODEL, `exactly one --model, ${MODEL}`);
  assert(count("--effort") === 1 && valueOf("--effort") === EFFORT, `exactly one --effort, ${EFFORT}`);
  const settingsAt = spec.args.indexOf("--settings");
  const firstPositional = spec.args.slice(settingsAt + 2).find((a) => !a.startsWith("--"));
  assert(firstPositional?.split(/\r?\n\r?\n|\s+Read the file at /)[0] === TASK, "the task is the agent's first prompt");

  log("step 3: the process tree is shell → hi run → claude, carrying those arguments");
  const tree = await findLaunchTree(sid);
  log(`  hi    : ${tree.hi.pid} ${tree.hi.command.slice(0, 120)}`);
  log(`  claude: ${tree.claude.pid} ${tree.claude.command.slice(0, 240)}`);
  assert(tree.claude.ppid === tree.hi.pid, "claude is the helper's child, not a command typed into the shell");
  assert(tree.claude.command.includes(`--model ${MODEL}`) && tree.claude.command.includes(`--effort ${EFFORT}`), "the running claude carries --model and --effort");
  assert(tree.claude.command.includes(TASK), "and the task");

  log("step 4: the turn ends, reported exactly by the agent");
  await answerTrustPrompt(bridge, sid);
  let done = null;
  for (let i = 0; i < 3 && !done; i++) {
    const strip = await waitForStrip(bridge, sid, ["needs_approval", "done_unread", "idle"], { confidence: "exact", timeoutMs: 180_000 });
    if (strip.kind === "needs_approval") {
      await sleep(800);
      await bridge.typeInTerminal(sid, "\n");
      await sleep(1500);
      continue;
    }
    if (strip.kind === "idle") {
      await sleep(1000);
      continue;
    }
    done = strip;
  }
  assert(done && done.source === "hook", `the turn ended, reported by the hook: "${done?.text}"`);
  await bridge.screenshot(join(evidenceDir, "02-done.png"));
  await bridge.typeInTerminal(sid, "/exit\n");
  await sleep(1500);
  const exit = await app.stop();
  app = null;
  assert(exit.code === 0, "the app quit cleanly");
  for (const f of guarded) assert(Buffer.compare(before.get(f), readFileSync(f)) === 0, `${f.replace(home, "~")} is byte-identical before and after`);
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
  } catch {
    /* no screenshot */
  }
} finally {
  if (app?.isRunning()) await app.stop();
  rmSync(repo, { recursive: true, force: true });
  for (const f of guarded) {
    if (Buffer.compare(before.get(f), readFileSync(f)) !== 0) {
      writeFileSync(f, before.get(f));
      log(`  restored ${f.replace(home, "~")}`);
    }
  }
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
