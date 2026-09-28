#!/usr/bin/env node
// Scenario F27: Done-When checks block Claude's stop in a terminal.
//
// A fake `claude` (tools/fake-agents/fake-cli.mjs) stands in for the real CLI:
// it honours --settings, and each prompt is a turn that appends one line to
// `.fake-work.log` and then tries to stop, running the settings file's Stop
// hooks; a hook that exits 2 refuses the stop and the fake works once more,
// exactly as Claude Code does. The test repository says, in
// `.hermes/worktree.toml`, `done_when = ["node check.mjs"]`; check.mjs passes
// once the work log has as many lines as `pass-at.txt` asks for.
//
//   run 1  launchHelper flag OFF (negative control): a Claude session gets no
//          settings file, so nothing refuses its stop and no check chip shows.
//          Turn the flag on (takes effect on the next launch).
//   run 2  flag ON: the launch's settings file carries the Done-When Stop hook
//          (`hi check --stop-hook`).
//          a) The check can never pass: the agent is sent back exactly three
//             times with the failing output, then allowed to stop; the session
//             becomes check_failed (exact), the inbox holds one error for it,
//             and the pane's chip says "check failed".
//          b) Next prompt, the check passes after two more work steps: two
//             continuations, then "tests ✓", the status clears and the inbox
//             item is resolved.
//          c) The results are what the backend recorded (done_when_history).
//
// Negative control (must end in RESULT: FAIL):
//   HERMES_E2E_F27_STOP_MODE=ignore-stop-hooks   a vendor that stops even when
//          a hook refuses; the "sent back three times" checks fail.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F27-claude-stop-hook.mjs
//
// Evidence (log, screenshots, the fake's launch records) goes to
// HERMES_E2E_EVIDENCE, or <out dir>/evidence/F27-claude-stop-hook.

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { REPO_ROOT, createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "F27-claude-stop-hook";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);
const onWindows = platform() === "win32";
const STOP_MODE = process.env.HERMES_E2E_F27_STOP_MODE || "normal";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

// ─── A fake `claude` on PATH, a test repository, a home that survives relaunches ──

const work = realpathSync(mkdtempSync(join(tmpdir(), "hermes-e2e-f27-")));
const fakeBin = join(work, "bin");
const recordDir = join(work, "records");
const privateHome = join(work, "home");
const repo = join(work, "f27-repo");
for (const d of [fakeBin, recordDir, privateHome, repo]) mkdirSync(d, { recursive: true });
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

// The repository's Done-When contract. `node` is named by its full path so
// the check runs the same on every runner whatever the terminal's PATH is.
const CHECK_JS = `import fs from "node:fs";
const need = Number(fs.readFileSync("pass-at.txt", "utf8"));
let steps = 0;
try { steps = fs.readFileSync(".fake-work.log", "utf8").split("\\n").filter(Boolean).length; } catch {}
console.log("work steps: " + steps + ", need " + need);
if (steps >= need) process.exit(0);
console.error("expected at least " + need + " work steps, found " + steps);
process.exit(1);
`;
const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString();
function makeRepo() {
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.invalid");
  git("config", "user.name", "Hermes e2e");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(repo, ".hermes"), { recursive: true });
  writeFileSync(join(repo, ".hermes", "worktree.toml"), `# Done-When checks for this repository\ndone_when = ['"${process.execPath}" check.mjs']\n`);
  writeFileSync(join(repo, "check.mjs"), CHECK_JS);
  writeFileSync(join(repo, "pass-at.txt"), "99\n");
  writeFileSync(join(repo, ".gitignore"), ".fake-work.log\n");
  writeFileSync(join(repo, "README.md"), "# f27 test repository\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
}

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
    .map((f) => {
      // A record being replaced right now is skipped until the next look.
      try {
        return { file: f, ...JSON.parse(readFileSync(join(recordDir, f), "utf8")) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
async function waitForRecord(pred, what, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = records().filter(pred).at(-1);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`the fake never recorded ${what}`);
    await sleep(200);
  }
}

function launch(run, { first = false } = {}) {
  const runDir = join(evidenceDir, `run-${run}`);
  // Short budgets so a broken hook cannot hang the scenario.
  const env = { HERMES_FAKE_DIR: recordDir, HERMES_DONE_WHEN_TIMEOUT_SECS: "60", HERMES_DONE_WHEN_BUDGET_SECS: "300" };
  return onWindows
    ? launchApp({ runDir, log, env, home: "real", resetData: first })
    : launchApp({ runDir, log, env, home: "private", homeDir: privateHome });
}

// ─── UI steps ────────────────────────────────────────────────────────

async function dismissWhatsNew(bridge) {
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
  await bridge.waitFor("the Finish button to become enabled", `
    const b = e2e.first(".onboarding-actions .onboarding-btn-primary");
    return !!b && !b.disabled;
  `);
  await bridge.click(".onboarding-actions .onboarding-btn-primary");
  await bridge.waitFor("the welcome dialog to close", `return !e2e.first(".onboarding-backdrop");`);
  await sleep(300);
  await dismissWhatsNew(bridge);
}

const invoke = (bridge, cmd, args) =>
  bridge.eval(`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})});`);

async function setLaunchHelper(bridge, on) {
  await invoke(bridge, "set_setting", { key: "feature_flag_overrides", value: JSON.stringify({ launchHelper: on }) });
  log(`  launchHelper override saved: ${on} (read at the next launch)`);
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

/** New Session wizard: a Claude session in a terminal, in the test repo. */
async function createClaudeSession(bridge) {
  const before = await bridge.terminalIds();
  if (await bridge.exists("button.es-tile-primary")) await bridge.click("button.es-tile-primary");
  else await bridge.clickByName("New session");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`, { timeoutMs: 20_000 });
  await bridge.clickWhenReady(`
    const card = e2e.all(".session-creator-provider-card").find((c) => c.innerText.trim().startsWith("Claude"));
    return e2e.click(e2e.must(card, "the Claude card"));
  `);
  for (let i = 0; i < 10; i++) {
    if (!(await bridge.exists(".session-creator"))) break;
    // The Agent view is optional; the terminal is what this tests.
    await bridge.eval(`
      const box = e2e.first(".session-creator-agent-view input[type=checkbox]");
      if (box && box.checked) e2e.click(box);
      return true;
    `);
    if (await bridge.exists(".workspace-scan-input")) {
      const listed = await bridge.eval(`
        const row = e2e.all(".project-picker-item").find((el) => el.innerText.includes("f27-repo"));
        if (!row) return false;
        if (!row.classList.contains("project-picker-item-attached")) e2e.click(row);
        return true;
      `);
      if (!listed) {
        await bridge.eval(setInput(".workspace-scan-input", repo));
        await bridge.clickByName("Scan", { within: ".project-picker-footer" });
      }
      await bridge.waitFor("the test repo to be selected", `
        return e2e.all(".project-picker-item.project-picker-item-attached").some((el) => el.innerText.includes("f27-repo"));
      `);
    }
    const clicked = await bridge.clickWhenReady(`
      if (!e2e.first(".session-creator")) return { clicked: "(closed)" };
      const b = e2e.must(e2e.first(${JSON.stringify(PRIMARY)}), "the wizard's primary button");
      return e2e.click(b);
    `);
    log(`  wizard: clicked "${clicked.clicked}"`);
    await sleep(400);
  }
  await bridge.waitFor("the wizard to close", `return !e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  return bridge.waitFor(
    "a terminal to appear",
    `const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
     return ids.length === 1 ? ids[0] : null;`,
    { timeoutMs: 20_000 },
  );
}

async function sessionData(bridge, sessionId) {
  const all = await invoke(bridge, "get_sessions");
  return all.find((s) => s.id === sessionId) ?? null;
}
const chip = (bridge) =>
  bridge.eval(`
    const c = e2e.first(".done-when-chip");
    return c ? { text: e2e.norm(c.innerText), state: c.getAttribute("data-state"), title: c.getAttribute("title") } : null;
  `);
const snapshot = (bridge, id) => bridge.eval(`return window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(id)});`);
const inbox = (bridge) => bridge.eval(`return window.__HERMES_E2E__.inboxItems();`);
async function quit(current) {
  const exit = await current.stop();
  log(`  app exited: ${JSON.stringify(exit)}`);
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");
}

/** Type a prompt to the agent and wait for the fake to finish the turn. */
async function prompt(bridge, sessionId, launchRecord, text, turnIndex) {
  await bridge.typeInTerminal(sessionId, `${text}\n`);
  const turnsDone = (r) => r.events.filter((e) => e.ev === "turn-done").length;
  return waitForRecord((r) => r.file === launchRecord.file && turnsDone(r) > turnIndex, `turn ${turnIndex + 1} ending`, { timeoutMs: 120_000 });
}

let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   fake claude: ${fakeBin}`);
  makeRepo();
  undoRegistryPath = addFakeBinToRegistryPath();
  // Typed lines are prompts, and each turn's work is logged for the check.
  setFakeMode("prompts work-log");

  // ── run 1: flag off (negative control) ────────────────────────────
  log("run 1: launchHelper flag OFF — no Stop hook, no check chip");
  app = await launch(1, { first: true });
  await completeOnboarding(app.bridge);
  const off = await createClaudeSession(app.bridge);
  const offRec = await waitForRecord(() => true, "a launch");
  await app.bridge.waitForTerminal(off, /fake-cli: ready/, { timeoutMs: 30_000 });
  assert(!offRec.argv.includes("--settings"), "with the flag off the agent gets no settings file");
  const offTurn = await prompt(app.bridge, off, offRec, "make the tests pass", 0);
  assert(JSON.stringify(offTurn.turns[0].stops) === JSON.stringify([{ active: false, codes: [] }]), `nothing refused the stop (${JSON.stringify(offTurn.turns[0].stops)})`);
  await sleep(1500);
  assert((await chip(app.bridge)) === null, "no Done-When chip shows with the flag off");
  await app.bridge.screenshot(join(evidenceDir, "00-flag-off.png"));
  await invoke(app.bridge, "close_session", { sessionId: off });
  await app.bridge.waitFor("the session to close", `return e2e.all(".session-item").length === 0;`);
  rmSync(join(repo, ".fake-work.log"), { force: true });
  await setLaunchHelper(app.bridge, true);
  await quit(app);

  // ── run 2: flag on ────────────────────────────────────────────────
  log("run 2: flag ON — Claude's stop runs the checks");
  if (STOP_MODE !== "normal") setFakeMode(`prompts work-log ${STOP_MODE}`);
  app = await launch(2);
  await app.bridge.waitFor("the app UI to be ready", `return !!e2e.first(".topbar-title, .topbar") && !e2e.first(".onboarding-backdrop");`);
  await dismissWhatsNew(app.bridge);
  const before = records().length;
  const sid = await createClaudeSession(app.bridge);
  log(`  session: ${sid}`);
  const rec = await waitForRecord((r) => r.argv.includes("--settings"), "a launch through hi with a settings file");
  assert(records().length > before, "the agent was started again in this run");
  await app.bridge.waitForTerminal(sid, /fake-cli: ready/, { timeoutMs: 30_000 });
  // Exec form, like F11's signal hooks: the helper and its arguments, no shell.
  const stopHook = rec.settings?.hooks?.Stop?.flatMap((g) => g.hooks ?? []).find((h) => Array.isArray(h.args) && h.args.join(" ") === "check --stop-hook");
  assert(stopHook && stopHook.type === "command", `the per-launch settings carry the Done-When Stop hook (${JSON.stringify(stopHook ?? null)})`);
  assert(/\bhi(\.exe)?$/.test(stopHook.command), "the hook is the bundled hi helper");
  const data = await sessionData(app.bridge, sid);
  log(`  session folder: ${data.working_directory}`);

  // a) a check that never passes
  log("step a: the check never passes — three automatic continuations, then check_failed");
  const t1 = await prompt(app.bridge, sid, rec, "make the tests pass", 0);
  const stops1 = t1.turns[0].stops;
  log(`  stops: ${JSON.stringify(stops1)}`);
  assert(stops1.length === 4, `the agent tried to stop four times: the first and three continuations (${stops1.length})`);
  // Each stop runs F11's signal hook first and the Done-When check last:
  // the check's exit code is the last one.
  assert(JSON.stringify(stops1.map((s) => s.codes.at(-1))) === "[2,2,2,0]", "the hook refused three stops (exit 2) and then let it stop");
  assert(JSON.stringify(stops1.map((s) => s.active)) === "[false,true,true,true]", "continuations carry stop_hook_active");
  const stopRuns = t1.hooksRan.filter((h) => h.event === "Stop").slice(0, 3);
  for (const [i, h] of stopRuns.entries()) {
    const err = h.results[0]?.stderr ?? "";
    assert(err.includes(`attempt ${i + 1} of 3`) && err.includes("expected at least 99 work steps"), `continuation ${i + 1} was told what failed ("${err.split("\n")[0].slice(0, 90)}…")`);
  }
  await app.bridge.waitForTerminal(sid, /Stop hook feedback: Hermes Done-When checks failed/, { timeoutMs: 5_000 });
  const failedSnap = await app.bridge.waitFor("the session to be check_failed", `
    const s = window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(sid)});
    return s.status.kind === "check_failed" ? s : null;
  `, { timeoutMs: 15_000 });
  assert(failedSnap.status.confidence === "exact" && /check\.mjs/.test(failedSnap.status.detail), `status check_failed (exact), detail "${failedSnap.status.detail}"`);
  const items = (await inbox(app.bridge)).filter((i) => i.sessionId === sid);
  assert(items.length === 1 && items[0].kind === "error" && items[0].source === "checks" && /check\.mjs/.test(items[0].detail), `one error in the inbox: "${items[0]?.detail}"`);
  const c1 = await app.bridge.waitFor("the chip to say check failed", `
    const c = e2e.first(".done-when-chip");
    return c && c.getAttribute("data-state") === "check_failed" ? e2e.norm(c.innerText) : null;
  `);
  assert(c1 === "check failed", `the pane's chip says "${c1}"`);
  await app.bridge.click(".done-when-chip");
  const pop = await app.bridge.waitFor("the check list", `
    const p = e2e.first(".done-when-popover");
    return p ? { rows: e2e.all(".done-when-command", p).map((r) => r.getAttribute("data-ok")), out: e2e.norm(e2e.first(".done-when-output", p)?.innerText), send: !!e2e.first(".done-when-send", p) } : null;
  `);
  assert(pop.rows.join() === "false" && /expected at least 99/.test(pop.out), "the list shows the failing check and its output");
  await app.bridge.screenshot(join(evidenceDir, "01-check-failed.png"));
  await app.bridge.click(".done-when-chip");

  // b) the agent gets there on the second continuation
  log("step b: the next prompt passes after two continuations — tests ✓, status and inbox clear");
  const steps = readFileSync(join(data.working_directory, ".fake-work.log"), "utf8").split("\n").filter(Boolean).length;
  writeFileSync(join(data.working_directory, "pass-at.txt"), `${steps + 3}\n`);
  const t2 = await prompt(app.bridge, sid, rec, "try again", 1);
  const stops2 = t2.turns[1].stops;
  log(`  stops: ${JSON.stringify(stops2)}`);
  assert(JSON.stringify(stops2.map((s) => s.codes.at(-1))) === "[2,2,0]", "two refused stops, then the checks passed and it stopped");
  const c2 = await app.bridge.waitFor("the chip to say tests ✓", `
    const c = e2e.first(".done-when-chip");
    return c && c.getAttribute("data-state") === "passed" ? e2e.norm(c.innerText) : null;
  `, { timeoutMs: 15_000 });
  assert(c2 === "tests ✓", `the chip says "${c2}"`);
  const cleared = await snapshot(app.bridge, sid);
  assert(cleared.status.kind === "done_unread" && cleared.status.confidence === "exact", `the status cleared to ${cleared.status.kind}`);
  assert((await inbox(app.bridge)).filter((i) => i.sessionId === sid).length === 0, "the inbox item was resolved");
  await app.bridge.screenshot(join(evidenceDir, "02-tests-pass.png"));

  // c) what the backend recorded
  const history = await invoke(app.bridge, "done_when_history", { sessionId: sid });
  const summary = history.map((h) => `${h.run.trigger}:${h.run.state}:${h.run.attempt ?? "-"}${h.run.gave_up ? ":gave_up" : ""}`);
  log(`  history: ${summary.join(" ")}`);
  assert(history.length === 7, `seven check runs recorded (${history.length})`);
  assert(history.every((h) => h.hook && h.run.trigger === "stop_hook"), "every run was the agent's own Stop hook");
  assert(history[3].run.gave_up && history[3].check_failed, "the fourth run gave up and made the session check_failed");
  assert(history[6].run.state === "passed" && !history[6].check_failed, "the last run passed and cleared it");
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      const dump = await app.bridge.eval(`
        return {
          chip: e2e.first(".done-when-chip")?.outerHTML ?? null,
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
  // A process the app started can still be writing its last line (an
  // agent reporting its exit) while the folder goes: retry briefly.
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
