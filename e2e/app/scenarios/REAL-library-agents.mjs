#!/usr/bin/env node
// Scenario REAL-library-agents (local only): the prompt library with the
// REAL `claude` and `codex` CLIs, in the isolated test build with a fresh
// Hermes profile. Each agent that is installed and signed in here runs; the
// others are reported as not proven.
//
// Once, through the real UI:
//   0. A terminal in a real TypeScript project (this checkout, or
//      HERMES_E2E_REAL_TS_PROJECT): the Library's first shelf is "For this
//      project", names TypeScript, and its cards say why.
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
//   3. Library -> "Review a pull request" with a one-line diff -> Start task:
//      the launcher opens with the rendered prompt as the task. A line asking
//      for a fixed acknowledgement is added, the agent is picked, Launch: the
//      agent's first prompt is the library text and it answers "ACK-libs".
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
import { IS_CI, REPO_ROOT, createLogger, finishScenario, launchApp, outDir, sleep, skipScenario } from "../harness.mjs";
import { chooseTarget, closeLibrary, fillArg, invoke, libraryState, openEntry, openLibrary, search, waitPreview } from "../library-steps.mjs";

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
const DIFF = "diff --git a/README.md b/README.md\n-# throwaway\n+# scratch";
const ACK_ASK = "Before anything else: do not read, run or change anything, answer from this message alone in at most three lines, and make the first line ACK-<the word sbil spelled backwards>.";
const ACK = /ACK-libs/;

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

  log("step 0: For you, in a real TypeScript project");
  const tsProject = process.env.HERMES_E2E_REAL_TS_PROJECT || REPO_ROOT;
  log(`  project: ${tsProject === REPO_ROOT ? "this checkout" : "HERMES_E2E_REAL_TS_PROJECT"}`);
  const tsTerm = await bridge.eval(`return await window.__HERMES_E2E__.newTerminal(${JSON.stringify({ label: "ts-project", cwd: tsProject })});`, { timeoutMs: 30_000 });
  await bridge.waitFor("the project terminal", `const i = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(tsTerm)}); return !!i && i.opened;`, { timeoutMs: 30_000 });
  await sleep(800);
  await openLibrary(bridge);
  await bridge.waitFor("the project shelf", `return !!e2e.first('.lib-shelf[data-shelf="project"] .lib-card');`, { timeoutMs: 30_000 }).catch(() => null);
  const home0 = await libraryState(bridge);
  await bridge.screenshot(join(evidenceDir, "00-for-you-typescript.png"));
  const shelf0 = home0.shelves.find((s) => s.id === "project");
  log(`  shelves: ${home0.shelves.map((s) => `${s.id}(${s.cards.length})`).join(", ")}`);
  log(`  project shelf: ${shelf0 ? `"${shelf0.why}" -> ${shelf0.cards.map((c) => `${c.id}[${c.reasons.join("+")}] "${c.why}"`).join(", ")}` : "none"}`);
  const leadRows = [];
  for (const c of shelf0?.cards.slice(0, 3) ?? []) leadRows.push((await invoke(bridge, "library_get", { id: c.id })).row);
  log(`  leading entries' stacks: ${leadRows.map((r) => `${r.id}:${(r.stack ?? []).join("/")}`).join(", ")}`);
  check(home0.personalised === "true" && home0.shelves[0]?.id === "project", "the first shelf is For this project");
  check(!!shelf0 && /TypeScript/.test(shelf0.why), `it names TypeScript ("${shelf0?.why ?? ""}")`);
  check(
    leadRows.length > 0 && (shelf0?.cards.slice(0, 3) ?? []).every((c) => { const m = c.why.match(/uses (.+)$/); return !!m && shelf0.why.includes(m[1]); }),
    "its leading entries are for a stack the project uses",
  );
  check(!!shelf0 && shelf0.cards.slice(0, 3).every((c) => c.reasons.includes("stack") && c.why), "and each says why");
  check(!home0.shelves.some((s) => s.cards.length > 12), "no shelf dumps the catalog (12 cards at most)");
  await closeLibrary(bridge);

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
    await bridge.waitFor("Prompts", `return !!e2e.first('[data-testid="prompt-picker"] .pp-input');`, { timeoutMs: 30_000 });
    await typeInto(bridge, ".pp-input", "code reviewer");
    await bridge.waitFor("Code reviewer in Prompts", `
      if (e2e.first(".pp-pane-inner")?.getAttribute("data-entry") === "code-reviewer") return true;
      const r = e2e.first('.pp-row[data-entry="code-reviewer"]');
      if (r) r.click();
      return false;
    `, { timeoutMs: 20_000, intervalMs: 700 });
    await bridge.click(".pp-primary");
    await bridge.waitFor("Prompts to close", `return !e2e.first('[data-testid="prompt-picker"]');`);
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

    log("step 3: Library -> Review a pull request -> Start task -> Launch");
    await openLibrary(bridge);
    await search(bridge, "review a pull request");
    await openEntry(bridge, "review-pull-request");
    await fillArg(bridge, "diff", DIFF);
    const rendered = await waitPreview(bridge, "+# scratch");
    await bridge.click(".lib-start");
    await bridge.waitFor("the launcher", `return e2e.first(".task-launcher")?.getAttribute("data-ready") === "true";`, { timeoutMs: 30_000 });
    const seeded = await bridge.eval(`return { task: e2e.first(".task-launcher-task")?.value ?? "", chip: e2e.norm(e2e.first(".task-launcher-library-prompt")?.innerText ?? "") };`);
    log(`  launcher: chip "${seeded.chip}", task ${seeded.task.length} chars starting ${JSON.stringify(seeded.task.slice(0, 60))}`);
    const head = rendered.trim().split("\n")[0];
    check(seeded.task.startsWith(head) && seeded.task.includes("+# scratch"), "the launcher's task is the rendered library prompt");
    check(/Review a pull request/i.test(seeded.chip), "with the entry's chip");
    await typeInto(bridge, ".task-launcher-task", `${seeded.task}\n\n${ACK_ASK}`);
    if (await bridge.exists(".task-launcher-repo")) await typeInto(bridge, ".task-launcher-repo", repo);
    else {
      await pickInMenu(bridge, "project");
      await typeInto(bridge, ".task-launcher-repo", repo);
    }
    await sleep(800);
    await pickInMenu(bridge, "agent", `[data-agent-id="${agent.id}"]`);
    if (agent.model) await pickInMenu(bridge, "model", `[data-model-id="${agent.model}"]`).catch(() => log(`  (no ${agent.model} on the model chip; the default model)`));
    await bridge.waitFor("Launch to be enabled", `const b = e2e.first(".task-launcher-launch"); return !!b && !b.disabled;`, { timeoutMs: 60_000 });
    await bridge.screenshot(join(evidenceDir, `04-${agent.id}-start-task.png`));
    const ids3 = await bridge.terminalIds();
    await bridge.click(".task-launcher-launch");
    await bridge.waitFor("the launcher to close", `return !e2e.first(".task-launcher-sheet");`, { timeoutMs: 30_000 });
    const [sid3] = await bridge.waitFor("the task's terminal", `
      const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(ids3)}.includes(id));
      return ids.length >= 1 ? ids : null;
    `, { timeoutMs: 30_000 });
    const dir3 = join(app.dataDir, "launch", sid3);
    const until3 = Date.now() + 20_000;
    while (!existsSync(join(dir3, "launch.json")) && Date.now() < until3) await sleep(200);
    const spec3 = JSON.parse(readFileSync(join(dir3, "launch.json"), "utf8"));
    const first3 = spec3.args[spec3.args.length - 1] ?? "";
    log(`  launch: ${spec3.program}, first prompt ${first3.length} chars starting ${JSON.stringify(first3.slice(0, 60))}`);
    check(first3.startsWith(head) && first3.includes("+# scratch") && first3.includes(ACK_ASK), `${agent.name}'s first prompt is the library prompt`);
    const readName = `
      const el = e2e.first('[data-session-item-id="${sid3}"]');
      return { label: e2e.norm(el?.querySelector(".session-item-name")?.innerText ?? ""), branch: e2e.norm(el?.querySelector(".session-item-git-branch")?.innerText ?? "") };
    `;
    const named = await bridge
      .waitFor("the session's branch in the sidebar", `const n = (() => { ${readName} })(); return n.branch ? n : false;`, { timeoutMs: 20_000 })
      .catch(() => bridge.eval(readName));
    log(`  session: ${JSON.stringify(named)}`);
    check(named.label === "Review a pull request" && /review-a-pull-request/.test(named.branch), "the session and its branch are named after the library entry, not its markup");
    const ack = await waitAnswering(bridge, sid3, (t) => ACK.test(t.split("sbil spelled backwards").pop() ?? ""), `${agent.name}'s acknowledgement`).catch((e) => {
      log(`  ${e.message}`);
      return null;
    });
    await bridge.screenshot(join(evidenceDir, `05-${agent.id}-start-task-answer.png`));
    if (ack) log(`  ${agent.name} replied: ${JSON.stringify((ack.split("sbil spelled backwards").pop() ?? "").trim().split("\n").filter((l) => l.trim()).slice(0, 6).join(" | ").slice(0, 300))}`);
    check(!!ack, `${agent.name} received it as its first prompt and answered ACK-libs`);
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
