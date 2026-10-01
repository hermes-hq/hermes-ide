#!/usr/bin/env node
// Scenario REAL-track-claude (local only): "Track as a feature" with the REAL
// `claude` CLI (haiku, the cheapest model), in the isolated test build with a
// fresh profile, on a throwaway repository and a tiny task.
//
// It runs only on a machine with a signed-in `claude` on PATH, macOS or
// Linux, and never in CI (RESULT: SKIP otherwise; e2e/app/ci-plan.mjs lists
// it as excluded).
//
// What must hold:
//   1. the launch carries the feature track's first prompt (not the bare
//      task);
//   2. Claude works the questions phase only: it writes questions.md, runs
//      `hi phase done` (feature.md: gate waiting) and stops — its turn ends
//      and the code is untouched (src/report.js byte-identical, nothing but
//      the track's own files changed in the worktree);
//   3. the Track panel says questions is ready for review;
//   4. approving moves the feature to research and tells Claude, which runs
//      `hi phase` and starts research (feature.md: research, gate none or
//      waiting with research.md written);
//   5. ~/.claude/settings.json is byte-identical before and after.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/REAL-track-claude.mjs

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";
import { guard, home, launchSpec, requireRealCli, snapshot, throwawayRepo, turnEnded } from "../real-steps.mjs";

const SCENARIO = "REAL-track-claude";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);
const MODEL = "haiku";

/** A webview starved of CPU (a loaded machine) can miss one answer: try again. */
async function patient(fn, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries || !/did not answer/.test(String(e?.message ?? e))) throw e;
      log(`  (the webview was busy; trying again: ${String(e.message).slice(0, 80)})`);
      await sleep(2000);
    }
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}
const frontMatter = (text) => Object.fromEntries([...text.matchAll(/^(phase|gate|track|slug): *(\S+)/gm)].map((m) => [m[1], m[2]]));

const cli = requireRealCli("claude", log, { scenario: SCENARIO, evidenceDir });
const guarded = guard([join(home, ".claude", "settings.json")], log);
const REPORT = "export function report(job) {\n  return job.status;\n}\n";
const repo = throwawayRepo("real-track", { "src/report.js": REPORT });
const TASK = "Add a failure notification: when report(job) sees job.status === 'failed', log the line 'job failed: <job.name>'.";

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
/** Press a key in the session's terminal the way a keyboard does. */
async function key(bridge, sid, k, code, keyCode) {
  await bridge.eval(`
    const host = document.querySelector('div[data-session-id="${sid}"]');
    const ta = e2e.must(host && host.querySelector("textarea.xterm-helper-textarea"), "terminal input");
    for (const type of ["keydown", "keyup"]) {
      const ev = new KeyboardEvent(type, { key: ${JSON.stringify(k)}, code: ${JSON.stringify(code)}, bubbles: true, cancelable: true, composed: true, view: window });
      Object.defineProperty(ev, "keyCode", { get: () => ${keyCode} });
      Object.defineProperty(ev, "which", { get: () => ${keyCode} });
      ta.dispatchEvent(ev);
    }
    return true;
  `);
}
/**
 * Claude's dialogs on screen, answered as a person would: the folder trust
 * ("Yes, I trust this folder", below the preselected "No, exit") and a
 * permission ("Do you want to proceed?", its preselected "Yes": reading the
 * session's context file outside the worktree, running `hi`).
 */
let trusted = false;
let lastAnswer = 0;
async function answerDialogs(bridge, sid) {
  if (Date.now() - lastAnswer < 3000) return;
  const lines = ((await patient(() => bridge.readTerminal(sid))) ?? []).slice(-14).join("\n");
  if (!trusted && /Yes, I trust this folder/.test(lines)) {
    log("  Claude asks to trust the folder: Yes");
    if (/❯\s*(1\.\s*)?No, exit/.test(lines)) {
      await key(bridge, sid, "ArrowDown", "ArrowDown", 40);
      await sleep(300);
    }
    await bridge.typeInTerminal(sid, "\n");
    trusted = true;
    lastAnswer = Date.now();
    return;
  }
  // A permission, as Claude's own hook reports it (needs approval, exact).
  const snap = await patient(() => snapshot(bridge, sid));
  if (snap.status?.kind === "needs_approval" && /Do you want to proceed\?/.test(lines)) {
    log(`  Claude asks permission ("${snap.status.detail}"): Yes`);
    await bridge.typeInTerminal(sid, "\n");
    lastAnswer = Date.now();
  }
}
/** Waits for `test()` on the feature, answering Claude's dialogs meanwhile. */
async function untilFeature(bridge, sid, featureMd, test, what, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fm = existsSync(featureMd) ? frontMatter(readFileSync(featureMd, "utf8")) : null;
    if (fm && test(fm)) return fm;
    await answerDialogs(bridge, sid);
    await sleep(700);
  }
  throw new Error(`timed out waiting for ${what}. Terminal:\n${((await patient(() => bridge.readTerminal(sid))) ?? []).slice(-25).join("\n")}`);
}

let app;
let failed = false;
try {
  log(`scenario: ${SCENARIO}   claude: ${cli.version}   model ${MODEL}`);
  app = await launchApp({ runDir: join(evidenceDir, "run-1"), log, home: "real", resetData: true, tmp: "shared", flagDefaults: null });
  const { bridge } = app;
  await threeStepWelcome(bridge);

  log("step 1: ⌘N, the task, Claude on haiku, Track as a feature");
  await bridge.eval(`await window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "menu-action", payload: { action: "file.new-session" } }); return true;`);
  await bridge.waitFor("the launcher's starting choice", `return e2e.first(".task-launcher")?.getAttribute("data-ready") === "true";`, { timeoutMs: 30_000 });
  await pickInMenu(bridge, "project");
  await typeInto(bridge, ".task-launcher-repo", repo);
  await typeInto(bridge, ".task-launcher-task", TASK);
  await pickInMenu(bridge, "agent", '[data-agent-id="claude"]');
  await pickInMenu(bridge, "model", `[data-model-id="${MODEL}"]`);
  await bridge.click(".task-launcher-expand");
  await bridge.waitFor("the options", `return !!e2e.first(".task-launcher-feature-box");`);
  await bridge.click(".task-launcher-feature-box");
  await bridge.waitFor("Launch to be enabled", `const b = e2e.first(".task-launcher-launch"); return !!b && !b.disabled;`, { timeoutMs: 60_000 });
  const approval = await bridge.eval(`return e2e.norm(e2e.first('[data-chip="approval"]')?.innerText ?? "");`);
  assert(/^Accept edits/.test(approval), `Claude in its safety default (${approval})`);
  await bridge.screenshot(join(evidenceDir, "01-launcher.png"));
  const idsBefore = await bridge.terminalIds();
  await bridge.click(".task-launcher-launch");
  await bridge.waitFor("the launcher to close", `return !e2e.first(".task-launcher-sheet");`, { timeoutMs: 30_000 });
  const [sid] = await bridge.waitFor("the task's terminal", `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(idsBefore)}.includes(id));
    return ids.length >= 1 ? ids : null;
  `, { timeoutMs: 30_000 });
  const spec = await launchSpec(app, sid);
  const prompt = spec.args.find((a) => a.startsWith("Hermes Feature Track (Full)")) ?? "";
  assert(prompt.includes(TASK) && /Current phase: questions \(1 of 6\)/.test(prompt), "claude starts with the feature track's first prompt, not the bare task");
  const qPath = prompt.match(/Write (\.hermes\/features\/[a-z0-9-]+\/questions\.md)/)?.[1];
  const slug = qPath.split("/")[2];
  const wt = (await bridge.eval(`return (await window.__TAURI_INTERNALS__.invoke("get_sessions")).find((s) => s.id === ${JSON.stringify(sid)})?.working_directory ?? null;`)) ?? spec.cwd;
  const featureMd = join(wt, ".hermes", "features", slug, "feature.md");
  log(`  worktree ${wt}; feature ${slug}`);

  log("step 2: Claude writes questions.md, hands it over, and stops");
  const waiting = await untilFeature(bridge, sid, featureMd, (fm) => fm.gate === "waiting", "the questions gate");
  assert(waiting.phase === "questions", `feature.md: questions, gate waiting (Claude ran hi phase done)`);
  const questions = readFileSync(join(wt, qPath), "utf8");
  log(`  questions.md:\n${questions.split("\n").slice(0, 14).map((l) => `    ${l}`).join("\n")}`);
  assert(/- \[[ xX]\]/.test(questions), "questions.md holds Claude's questions");
  // The turn ends there (Claude stopped at the gate, it did not go on).
  const endDeadline = Date.now() + 180_000;
  let snap = await patient(() => snapshot(bridge, sid));
  while (!turnEnded(snap) && Date.now() < endDeadline) {
    await answerDialogs(bridge, sid);
    await sleep(1000);
    snap = await patient(() => snapshot(bridge, sid));
  }
  assert(turnEnded(snap), "Claude's turn ended at the gate (its own Stop hook)");
  await sleep(5000);
  assert(readFileSync(join(wt, "src", "report.js"), "utf8") === REPORT, "the code is untouched: no implementation before the plan");
  const changed = execFileSync("git", ["-C", wt, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }).split("\n").filter(Boolean).map((l) => l.slice(3));
  log(`  changed in the worktree: ${JSON.stringify(changed)}`);
  assert(changed.every((f) => f.startsWith(".hermes/") || f.startsWith(".claude/")), "nothing but the track's own files changed");
  assert(frontMatter(readFileSync(featureMd, "utf8")).gate === "waiting", "and it is still waiting for the person");

  log("step 3: the Track panel says it is ready for review");
  await bridge.clickWhenReady(`
    const tab = e2e.all(".activity-bar-tab").find((el) => e2e.nameOf(el) === "Track");
    return e2e.click(e2e.must(tab, "the Track tab"));
  `);
  await bridge.waitFor("the panel at the gate", `const p = e2e.first('[data-testid="track-panel"]'); return p && p.dataset.gate === "waiting";`, { timeoutMs: 20_000 });
  const said = await bridge.eval(`return e2e.norm(e2e.first('[data-testid="track-explain"]')?.innerText ?? "");`);
  assert(/^questions is ready for your review\./.test(said), `"${said}"`);
  await bridge.screenshot(join(evidenceDir, "02-questions-ready.png"));

  log("step 4: approve; Claude is told, runs hi phase and starts research");
  await bridge.click(".track-approve");
  await untilFeature(bridge, sid, featureMd, (fm) => fm.phase === "research", "research approved", 30_000);
  const research = await untilFeature(bridge, sid, featureMd, (fm) => fm.phase === "research" && fm.gate !== "approved", "Claude to start research (hi phase)", 240_000);
  const researchMd = join(wt, ".hermes", "features", slug, "research.md");
  assert(research.phase === "research" && existsSync(researchMd), `research started: feature.md research, gate ${research.gate}, research.md there`);
  await bridge.screenshot(join(evidenceDir, "03-research.png"));
  // Let it hand research over if it is quick; it must stop there too.
  try {
    await untilFeature(bridge, sid, featureMd, (fm) => fm.gate === "waiting", "the research gate", 180_000);
    log("  research handed over (gate waiting)");
  } catch {
    log("  research still in progress");
  }
  assert(readFileSync(join(wt, "src", "report.js"), "utf8") === REPORT, "still no code before the plan");

  await bridge.typeInTerminal(sid, "/exit\r");
  await sleep(1500);
  await app.stop();
  app = null;
  guarded.check(assert);
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
  guarded.restore();
  rmSync(repo, { recursive: true, force: true });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
