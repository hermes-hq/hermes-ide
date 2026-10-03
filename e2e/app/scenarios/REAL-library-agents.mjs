#!/usr/bin/env node
// Scenario REAL-library-agents (local only): the prompt library with the
// REAL `claude` and `codex` CLIs, in the isolated test build with a fresh
// Hermes profile. Each agent that is installed and signed in here runs; the
// others are reported as not proven.
//
// Per agent, through the real UI:
//   1. ⌘N, the agent on its chip, "From library" -> the "Code reviewer"
//      persona, and a task asking the agent to name its role in a fixed
//      format. Launch.
//      - Claude Code: the persona is --append-system-prompt, the task is the
//        first prompt; Codex: the persona leads the first prompt.
//      - The agent answers "ROLE=<...>" naming a reviewer role: the persona
//        reached the real CLI and it acts on it.
//   2. Library -> "Review a pull request" with its diff argument -> Use in
//      session: the real TUI shows the text as a paste in its input box and
//      the agent does NOT start a turn (nothing was sent). The paste is then
//      cleared (Ctrl+C), so this step costs nothing.
//
// The cheapest model and low effort; the person's agent settings files are
// byte-identical afterwards (a folder-trust answer the CLI writes itself is
// put back).
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/REAL-library-agents.mjs
//
// Says SKIP in CI, on Windows, or with neither CLI on PATH.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { IS_CI, createLogger, finishScenario, launchApp, outDir, sleep, skipScenario } from "../harness.mjs";
import { chooseTarget, fillArg, openEntry, openLibrary, search, waitPreview } from "../library-steps.mjs";

const SCENARIO = "REAL-library-agents";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);
const problems = [];
const check = (ok, message) => {
  log(`  ${ok ? "ok" : "FAILED"} — ${message}`);
  if (!ok) problems.push(message);
  return ok;
};

const which = (name) => {
  const r = spawnSync("which", [name], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] : "";
};
const AGENTS = [
  { id: "claude", bin: "claude", name: "Claude Code", model: "haiku" },
  { id: "codex", bin: "codex", name: "Codex", model: null },
].filter((a) => (a.path = which(a.bin)));
if (IS_CI || platform() === "win32" || AGENTS.length === 0) {
  log(`needs a real, signed-in claude or codex on PATH, macOS or Linux, and no CI (CI=${process.env.CI ?? ""})`);
  skipScenario({ scenario: SCENARIO, evidenceDir, reason: "no real agent CLI here, or CI", log });
}

const home = homedir();
const guarded = [join(home, ".claude", "settings.json"), join(home, ".codex", "config.toml")].filter(existsSync);
const before = new Map(guarded.map((f) => [f, readFileSync(f)]));

const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "hermes-e2e-real-library-")));
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Hermes Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Hermes Test", GIT_COMMITTER_EMAIL: "test@example.com", GIT_CONFIG_NOSYSTEM: "1" };
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { env: gitEnv, encoding: "utf8" }).trim();
execFileSync("git", ["init", "-q", "-b", "main", repo], { env: gitEnv });
git("config", "user.name", "Hermes Test");
git("config", "user.email", "test@example.com");
git("config", "commit.gpgsign", "false");
writeFileSync(join(repo, "README.md"), "# throwaway\n\nA scratch repository for a Hermes test. Nothing here matters.\n");
mkdirSync(join(repo, ".codex"), { recursive: true });
writeFileSync(join(repo, ".codex", "config.toml"), `model = "${process.env.HERMES_E2E_CODEX_MODEL || "gpt-5.6-luna"}"\nmodel_reasoning_effort = "low"\n`);
git("add", ".");
git("commit", "-q", "-m", "init");

const TASK = "Reply with exactly one line in the form ROLE=<the role you are acting as, two words> and nothing else. Do not read, run or change anything.";
const PERSONA_HEAD = "From now on, work as this persona: Code reviewer.";

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
const KEYS = {
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  enter: { key: "Enter", code: "Enter", keyCode: 13 },
  ctrlC: { key: "c", code: "KeyC", keyCode: 67, ctrlKey: true },
};
const pressKey = (bridge, sessionId, name) =>
  bridge.eval(`
    const k = ${JSON.stringify(KEYS[name])};
    const host = document.querySelector('div[data-session-id="${sessionId}"]');
    const ta = e2e.must(host && host.querySelector("textarea.xterm-helper-textarea"), "terminal input");
    ta.focus();
    for (const type of ["keydown", "keyup"]) {
      const ev = new KeyboardEvent(type, { key: k.key, code: k.code, ctrlKey: !!k.ctrlKey, bubbles: true, cancelable: true, composed: true, view: window });
      Object.defineProperty(ev, "keyCode", { get: () => k.keyCode });
      Object.defineProperty(ev, "which", { get: () => k.keyCode });
      ta.dispatchEvent(ev);
    }
    return true;
  `);
const screen = async (bridge, sid) => ((await bridge.readTerminal(sid)) ?? []).join("\n");

/** Answers what a CLI asks before it starts (folder trust, an update notice) while waiting for `done`. */
async function waitAnswering(bridge, sid, done, what, timeoutMs = 180_000) {
  const answered = new Set();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await screen(bridge, sid);
    const tail = text.split("\n").slice(-40).join("\n");
    if (done(text)) return text;
    if (!answered.has("update") && /Update available/i.test(tail) && /Update now/i.test(tail)) {
      answered.add("update");
      log("  (an update notice: skipping it)");
      await sleep(600);
      await pressKey(bridge, sid, "down");
      await sleep(250);
      await pressKey(bridge, sid, "enter");
    } else if (!answered.has("trust") && /trust (the files|the contents|this folder)/i.test(tail)) {
      answered.add("trust");
      log("  (a folder-trust question: answering yes)");
      await sleep(600);
      if (/❯\s*No, exit/.test(tail)) {
        await pressKey(bridge, sid, "down");
        await sleep(250);
      }
      await pressKey(bridge, sid, "enter");
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function welcome(bridge) {
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

let app;
let failed = false;
try {
  log(`scenario: ${SCENARIO}   agents: ${AGENTS.map((a) => `${a.bin} ${spawnSync(a.path, ["--version"], { encoding: "utf8" }).stdout.trim().split("\n")[0]}`).join(", ")}`);
  for (const missing of ["claude", "codex"].filter((b) => !AGENTS.some((a) => a.bin === b))) log(`  NOT PROVEN: ${missing} is not installed here`);
  app = await launchApp({ runDir: join(evidenceDir, "run-1"), log, home: "real", resetData: true, tmp: "shared", flagDefaults: null });
  const { bridge } = app;
  await welcome(bridge);

  for (const agent of AGENTS) {
    log(`— ${agent.name}`);
    log("step 1: ⌘N, the agent, the Code reviewer persona from the library, the task");
    await bridge.eval(`await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu-action", payload: { action: "file.new-session" } }); return true;`);
    await bridge.waitFor("the launcher", `return e2e.first(".task-launcher")?.getAttribute("data-ready") === "true";`, { timeoutMs: 30_000 });
    if (await bridge.exists(".task-launcher-start-over")) await bridge.click(".task-launcher-start-over");
    await pickInMenu(bridge, "project");
    await typeInto(bridge, ".task-launcher-repo", repo);
    await sleep(800);
    await pickInMenu(bridge, "agent", `[data-agent-id="${agent.id}"]`);
    if (agent.model) await pickInMenu(bridge, "model", `[data-model-id="${agent.model}"]`).catch(() => log(`  (no ${agent.model} on the model chip; the default model)`));
    await bridge.click(".task-launcher-from-library");
    await bridge.waitFor("the picker", `return !!e2e.first(".lib-picker .lib-picker-search");`, { timeoutMs: 30_000 });
    await typeInto(bridge, ".lib-picker-search", "code reviewer");
    await bridge.waitFor("Code reviewer in the picker", `
      if (e2e.first(".lib-picker-detail")?.getAttribute("data-entry") === "code-reviewer") return true;
      const r = e2e.first('.lib-picker-list .lib-row[data-entry="code-reviewer"]');
      if (r) r.click();
      return false;
    `, { timeoutMs: 20_000, intervalMs: 700 });
    await bridge.click(".lib-picker-insert");
    await typeInto(bridge, ".task-launcher-task", TASK);
    await bridge.waitFor("Launch to be enabled", `const b = e2e.first(".task-launcher-launch"); return !!b && !b.disabled;`, { timeoutMs: 60_000 });
    await bridge.screenshot(join(evidenceDir, `01-${agent.id}-launcher.png`));
    const idsBefore = await bridge.terminalIds();
    await bridge.click(".task-launcher-launch");
    await bridge.waitFor("the launcher to close", `return !e2e.first(".task-launcher-sheet");`, { timeoutMs: 30_000 });
    const [sid] = await bridge.waitFor("the task's terminal", `
      const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(idsBefore)}.includes(id));
      return ids.length >= 1 ? ids : null;
    `, { timeoutMs: 30_000 });
    const launchDir = join(app.dataDir, "launch", sid);
    const until = Date.now() + 20_000;
    while (!existsSync(join(launchDir, "launch.json")) && Date.now() < until) await sleep(200);
    const spec = JSON.parse(readFileSync(join(launchDir, "launch.json"), "utf8"));
    log(`  launch: ${spec.program} ${JSON.stringify(spec.args.map((a) => (a.length > 70 ? `${a.slice(0, 70)}…(${a.length})` : a)))}`);
    const last = spec.args[spec.args.length - 1] ?? "";
    if (agent.id === "claude") {
      const at = spec.args.indexOf("--append-system-prompt");
      check(at >= 0 && spec.args[at + 1].startsWith(PERSONA_HEAD), "Claude Code gets the persona as --append-system-prompt");
      check(last.startsWith(TASK), "and the task as its first prompt");
    } else {
      check(!spec.args.includes("--append-system-prompt") && last.startsWith(PERSONA_HEAD) && last.includes(TASK), `${agent.name} gets the persona, then the task, as its first prompt`);
    }

    const answer = await waitAnswering(bridge, sid, (t) => /ROLE\s*=\s*(?!<)[^\n]{2,60}/.test(t.split(TASK).pop() ?? ""), `${agent.name}'s answer`).catch((e) => {
      log(`  ${e.message}`);
      return null;
    });
    const role = answer ? ((answer.split(TASK).pop() ?? "").match(/ROLE\s*=\s*(?!<)([^\n]{2,60})/)?.[1] ?? "").trim() : "";
    log(`  ${agent.name} answered: ROLE=${role}`);
    await bridge.screenshot(join(evidenceDir, `02-${agent.id}-answer.png`));
    check(/review/i.test(role), `${agent.name} acts as the persona (named its role "${role}")`);

    log("step 2: Use in session -> the paste lands in the real input, nothing is sent");
    await sleep(1500);
    await openLibrary(bridge);
    await search(bridge, "review a pull request");
    await openEntry(bridge, "review-pull-request");
    await fillArg(bridge, "diff", "diff --git a/README.md b/README.md\n-# throwaway\n+# scratch");
    await waitPreview(bridge, "+# scratch");
    await chooseTarget(bridge, sid);
    await bridge.waitFor("Use in session enabled", `return e2e.first(".lib-use")?.disabled === false;`);
    await bridge.click(".lib-use");
    await sleep(2500);
    const afterUse = await screen(bridge, sid);
    await bridge.screenshot(join(evidenceDir, `03-${agent.id}-pasted.png`));
    const pasteShown = /\[Pasted (text|Content)[^\]]*\]/i.test(afterUse) || afterUse.includes("+# scratch");
    log(`  input after Use: ${JSON.stringify(afterUse.split("\n").slice(-8).join(" | ").slice(0, 400))}`);
    check(pasteShown, `${agent.name} shows the text as a paste in its input`);
    await sleep(4000);
    // Sent, the input would be empty again and the text a message in the
    // conversation; unsent, the paste is still waiting in the input box.
    const later = (await screen(bridge, sid)).split("\n").slice(-12).join("\n");
    const stillWaiting = /\[Pasted (text|Content)[^\]]*\]/i.test(later) || later.includes("+# scratch");
    check(stillWaiting, "and it is still waiting in the input 4 s later: nothing was sent");
    await pressKey(bridge, sid, "ctrlC");
    await sleep(500);
    await pressKey(bridge, sid, "ctrlC");
    await sleep(1500);
  }

  const exit = await app.stop();
  app = null;
  check(exit.code === 0, "the app quit cleanly");
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
      log(`  restored ${f.replace(home, "~")} (the CLI wrote to it: a folder-trust answer)`);
    }
  }
}
if (problems.length) log(`PROBLEMS:\n  - ${problems.join("\n  - ")}`);
finishScenario({ scenario: SCENARIO, evidenceDir, failed: failed || problems.length > 0, startedAt, log });
