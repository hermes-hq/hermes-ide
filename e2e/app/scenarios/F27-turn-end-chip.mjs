#!/usr/bin/env node
// Scenario F27: Done-When checks for agents Hermes cannot block — a chip at
// the turn end, and "Send failures back".
//
// Any agent in a terminal: here a fake one (tools/fake-agents/fake-cli.mjs,
// started by hand as `fakeagent` in a plain shell session), whose turn ends
// are fed through the C0 test injector (the turn ledger, F20, is not on this
// branch). The test repository's `.hermes/worktree.toml` says
// `done_when = ["f27node check.mjs"]`; check.mjs takes about 1.5 s and passes
// once `pass-at.txt` is at or below the fake's work steps.
//
// On macOS and Linux the app starts with the bare PATH an app opened from
// the Dock or a desktop launcher gets (/usr/bin:/bin:/usr/sbin:/sbin), and
// `f27node` (node under another name, like a tool nvm or volta installs)
// lives in a folder only the private home's shell profile puts on PATH. So
// every check Hermes runs proves it uses the login shell's PATH, as the
// person's own terminal does. (Windows apps get the user's PATH from the
// registry; there the check names node by its full path.)
//
//   run 1  launchHelper flag switched OFF (on by default since 2.0; negative control): a turn end runs nothing
//          and shows no chip. Turn the flag on.
//   run 2  flag ON:
//          1. A turn end shows "checking…" and then the failing chip, within
//             the check's own runtime (plus a small margin).
//          2. The chip lists the checks with the failing output; "Send
//             failures back" pastes them into the agent's terminal as one
//             prompt (the fake records exactly what it received).
//          3. The next turn end passes: "tests ✓"; each result is kept on its
//             turn.
//          4. Three failing turn ends in a row: check_failed (exact), one
//             error in the inbox, chip "check failed". A run before Land
//             (trigger land) reports without counting as a turn end.
//          5. "Run checks again" after a fix: "tests ✓", status and inbox
//             clear.
//          6. `hi check` typed at the shell prompt lists the checks and says
//             whether they pass.
//          7. With the agent gone (the shell at its prompt), a failing result
//             offers no "Send failures back" and says why; asking the
//             controller to send anyway writes nothing to the shell.
//
// Negative controls (each must end in RESULT: FAIL):
//   HERMES_E2E_F27_CHIP_NEGATIVE=1   the check passes from the start, so the
//          failing chip of step 1 never shows.
//   HERMES_E2E_F27_CHIP_NO_PROFILE_PATH=1   (macOS/Linux) the profile does
//          not add f27node's folder, so the check fails at once with exit
//          127 (command not found) and step 1 never sees it running.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F27-turn-end-chip.mjs

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { REPO_ROOT, createLogger, finishScenario, launchApp, outDir, sleep, skipScenario } from "../harness.mjs";

const SCENARIO = "F27-turn-end-chip";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);
const onWindows = platform() === "win32";
const NEGATIVE = process.env.HERMES_E2E_F27_CHIP_NEGATIVE === "1";
const NO_PROFILE_PATH = process.env.HERMES_E2E_F27_CHIP_NO_PROFILE_PATH === "1";
const CHECK_MS = 1500;
/** The PATH an app opened from the Dock gets on macOS. */
const BARE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

const work = realpathSync(mkdtempSync(join(tmpdir(), "hermes-e2e-f27b-")));
const fakeBin = join(work, "bin");
const recordDir = join(work, "records");
const privateHome = join(work, "home");
const toolBin = join(privateHome, "tools", "bin");
const repo = join(work, "f27b-repo");
for (const d of [fakeBin, recordDir, privateHome, toolBin, repo]) mkdirSync(d, { recursive: true });
const FAKE_CLI = join(REPO_ROOT, "tools", "fake-agents", "fake-cli.mjs");
if (onWindows) {
  writeFileSync(join(fakeBin, "fakeagent.cmd"), `@"${process.execPath}" "${FAKE_CLI}" %*\r\n`);
} else {
  writeFileSync(join(fakeBin, "fakeagent"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`);
  chmodSync(join(fakeBin, "fakeagent"), 0o755);
}
process.env.PATH = [fakeBin, ...(process.env.PATH || "").split(delimiter).filter(Boolean)].join(delimiter);
if (!onWindows) {
  // node under another name, reachable only through the shell profile.
  writeFileSync(join(toolBin, "f27node"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  chmodSync(join(toolBin, "f27node"), 0o755);
  const dirs = NO_PROFILE_PATH ? [fakeBin] : [toolBin, fakeBin];
  const profile = `export PATH="${dirs.join(":")}:$PATH"\n`;
  for (const rc of [".profile", ".bash_profile", ".bashrc", ".zprofile", ".zshrc"]) writeFileSync(join(privateHome, rc), profile);
}
const CHECK_COMMAND = onWindows ? `"${process.execPath}" check.mjs` : "f27node check.mjs";

const CHECK_JS = `import fs from "node:fs";
await new Promise((r) => setTimeout(r, ${CHECK_MS}));
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
  writeFileSync(join(repo, ".hermes", "worktree.toml"), `done_when = ['${CHECK_COMMAND}']\n`);
  writeFileSync(join(repo, "check.mjs"), CHECK_JS);
  writeFileSync(join(repo, "pass-at.txt"), NEGATIVE ? "0\n" : "99\n");
  writeFileSync(join(repo, ".gitignore"), ".fake-work.log\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
}
// The fake agent takes typed lines as prompts and logs each turn's work
// (tools/fake-agents/fake-cli.mjs, modes `prompts` and `work-log`).
writeFileSync(join(recordDir, "mode"), "prompts work-log\n");

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
  execFileSync("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", old ? `${old};${fakeBin}` : fakeBin, "/f"]);
  log("  (CI runner: added the fake agent folder to the user's registry Path)");
  return () => {
    if (old === null) execFileSync("reg", ["delete", "HKCU\\Environment", "/v", "Path", "/f"]);
    else execFileSync("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", old, "/f"]);
    log("  (CI runner: restored the user's registry Path)");
  };
}
if (onWindows && !canEditRegistryPath) {
  log("this scenario needs the fake agent on a Windows terminal's PATH, which means the user's registry Path; that is only changed on a CI runner");
  skipScenario({ scenario: SCENARIO, evidenceDir, reason: "Windows outside CI", log });
}
let undoRegistryPath = null;

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
  const env = onWindows ? { HERMES_FAKE_DIR: recordDir } : { HERMES_FAKE_DIR: recordDir, PATH: BARE_PATH };
  return onWindows
    ? launchApp({ runDir, log, env, home: "real", resetData: first })
    : launchApp({ runDir, log, env, home: "private", homeDir: privateHome });
}

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

const setInput = (selector, value) => `
  const el = e2e.must(e2e.first(${JSON.stringify(selector)}), ${JSON.stringify(selector)});
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  el.focus();
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return el.value;
`;
const PRIMARY = ".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary";

/** New Session wizard: a plain shell in the test repo. */
async function createShellSession(bridge) {
  const before = await bridge.terminalIds();
  if (await bridge.exists("button.es-tile-primary")) await bridge.click("button.es-tile-primary");
  else await bridge.clickByName("New session");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`, { timeoutMs: 20_000 });
  await bridge.clickWhenReady(`
    const cards = e2e.all(".session-creator-provider-card");
    return e2e.click(e2e.must(cards[cards.length - 1], "the plain shell card"));
  `);
  for (let i = 0; i < 10; i++) {
    if (!(await bridge.exists(".session-creator"))) break;
    if (await bridge.exists(".session-creator-scan-input")) {
      const listed = await bridge.eval(`
        const row = e2e.all(".project-picker-item").find((el) => el.innerText.includes("f27b-repo"));
        if (!row) return false;
        if (!row.classList.contains("project-picker-item-attached")) e2e.click(row);
        return true;
      `);
      if (!listed) {
        await bridge.eval(setInput(".session-creator-scan-input", repo));
        await bridge.clickByName("Scan", { within: ".project-picker-footer" });
      }
      await bridge.waitFor("the test repo to be selected", `
        return e2e.all(".project-picker-item.project-picker-item-attached").some((el) => el.innerText.includes("f27b-repo"));
      `);
    }
    const clicked = await bridge.clickWhenReady(`
      if (!e2e.first(".session-creator")) return { clicked: "(closed)" };
      return e2e.click(e2e.must(e2e.first(${JSON.stringify(PRIMARY)}), "the wizard's primary button"));
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

const chip = (bridge) =>
  bridge.eval(`
    const c = e2e.first(".done-when-chip");
    return c ? { text: e2e.norm(c.innerText), state: c.getAttribute("data-state") } : null;
  `);
const waitChip = (bridge, state, { timeoutMs = 20_000 } = {}) =>
  bridge.waitFor(`the chip to be ${state}`, `
    const c = e2e.first(".done-when-chip");
    return c && c.getAttribute("data-state") === ${JSON.stringify(state)} ? e2e.norm(c.innerText) : null;
  `, { timeoutMs });
const injectTurnEnd = (bridge, sid, n) =>
  bridge.eval(`return window.__HERMES_E2E__.injectSessionEvent(${JSON.stringify(sid)}, { type: "turn_end", at: Date.now(), n: ${n}, source: "e2e" });`);
const doneWhen = (bridge, sid) => bridge.eval(`return window.__HERMES_E2E__.doneWhenSnapshot(${JSON.stringify(sid)});`);
const forTurn = (bridge, sid, n) => bridge.eval(`return window.__HERMES_E2E__.doneWhenForTurn(${JSON.stringify(sid)}, ${n});`);
const snapshot = (bridge, id) => bridge.eval(`return window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(id)});`);
const inbox = (bridge) => bridge.eval(`return window.__HERMES_E2E__.inboxItems();`);
async function quit(current) {
  const exit = await current.stop();
  log(`  app exited: ${JSON.stringify(exit)}`);
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");
}
/** Wait until a result newer than `after` (epoch ms) is the chip's. */
async function waitResult(bridge, sid, after, { timeoutMs = 20_000 } = {}) {
  return bridge.waitFor("a new check result", `
    const s = window.__HERMES_E2E__.doneWhenSnapshot(${JSON.stringify(sid)});
    return s.last && s.last.run.started_at >= ${after} && !s.running ? s.last : null;
  `, { timeoutMs });
}

let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}${NEGATIVE ? "   NEGATIVE CONTROL" : ""}${NO_PROFILE_PATH ? "   NEGATIVE CONTROL (no profile PATH)" : ""}`);
  if (!onWindows) log(`  the app starts with PATH=${BARE_PATH}; the check runs "${CHECK_COMMAND}"`);
  makeRepo();
  undoRegistryPath = addFakeBinToRegistryPath();

  // ── run 1: flag off (negative control) ────────────────────────────
  log("run 1: launchHelper flag switched OFF — a turn end runs no check and shows no chip");
  app = await launch(1, { first: true });
  await completeOnboarding(app.bridge);
  // On by default since 2.0: switch it off (the kill switch) and relaunch.
  await invoke(app.bridge, "set_setting", { key: "feature_flag_overrides", value: JSON.stringify({ launchHelper: false }) });
  await quit(app);
  app = await launch("1b");
  await app.bridge.waitFor("the app UI to be ready", `return !!e2e.first(".topbar-title, .topbar") && !e2e.first(".onboarding-backdrop");`);
  await dismissWhatsNew(app.bridge);
  const off = await createShellSession(app.bridge);
  assert((await injectTurnEnd(app.bridge, off, 1)) === true, "a turn_end was injected");
  await sleep(CHECK_MS + 2000);
  assert((await chip(app.bridge)) === null, "no chip");
  assert((await doneWhen(app.bridge, off)).last === null, "no result recorded");
  await app.bridge.screenshot(join(evidenceDir, "00-flag-off.png"));
  await invoke(app.bridge, "close_session", { sessionId: off });
  await app.bridge.waitFor("the session to close", `return e2e.all(".session-item").length === 0;`);
  await invoke(app.bridge, "set_setting", { key: "feature_flag_overrides", value: JSON.stringify({ launchHelper: true }) });
  await quit(app);

  // ── run 2: flag on ────────────────────────────────────────────────
  log("run 2: flag ON");
  app = await launch(2);
  await app.bridge.waitFor("the app UI to be ready", `return !!e2e.first(".topbar-title, .topbar") && !e2e.first(".onboarding-backdrop");`);
  await dismissWhatsNew(app.bridge);
  const sid = await createShellSession(app.bridge);
  const folder = (await invoke(app.bridge, "get_sessions")).find((s) => s.id === sid).working_directory;
  log(`  session ${sid} in ${folder}`);
  await app.bridge.waitForTerminal(sid, /\S/, { timeoutMs: 30_000 });
  await sleep(1000);
  await app.bridge.typeInTerminal(sid, "fakeagent --session-id f27b\n");
  await app.bridge.waitForTerminal(sid, /fake-cli: ready/, { timeoutMs: 30_000 });
  const rec = await waitForRecord((r) => r.sessionIdArg === "f27b", "the fake agent starting");

  // 1. the chip at a turn end
  log("step 1: a turn end shows the check chip within the check's runtime");
  const t0 = Date.now();
  await injectTurnEnd(app.bridge, sid, 1);
  const sawRunning = await app.bridge.waitFor("the chip to say checking", `
    const c = e2e.first(".done-when-chip");
    return c && c.getAttribute("data-state") === "running" ? e2e.norm(c.innerText) : null;
  `, { timeoutMs: CHECK_MS });
  assert(sawRunning === "checking…", `while the check runs the chip says "${sawRunning}"`);
  const failedText = await waitChip(app.bridge, "failed", { timeoutMs: CHECK_MS + 8000 });
  const elapsed = Date.now() - t0;
  const r1 = (await doneWhen(app.bridge, sid)).last;
  log(`  chip "${failedText}" ${elapsed} ms after the turn end; the check itself took ${r1.run.duration_ms} ms`);
  assert(failedText === "checks ✗ 1/1", `the chip says "${failedText}"`);
  assert(r1.run.trigger === "turn_end" && r1.turn === 1 && !r1.hook, "a turn-end run for turn 1, no hook");
  assert(r1.run.duration_ms >= CHECK_MS - 100, "the check really ran (its own runtime)");
  assert(elapsed <= r1.run.duration_ms + 3000, `the chip showed within the check's runtime plus 3 s (${elapsed} ms)`);
  await app.bridge.screenshot(join(evidenceDir, "01-chip-failed.png"));

  // 2. Send failures back
  log("step 2: the chip lists the checks; Send failures back pastes them into the agent");
  await app.bridge.click(".done-when-chip");
  const pop = await app.bridge.waitFor("the check list", `
    const p = e2e.first(".done-when-popover");
    return p ? { rows: e2e.all(".done-when-command", p).map((r) => r.getAttribute("data-ok")), out: e2e.norm(e2e.first(".done-when-output", p)?.innerText), result: e2e.norm(e2e.first(".done-when-command-result", p)?.innerText) } : null;
  `);
  assert(pop.rows.join() === "false" && pop.result === "exit 1", `one failing check, exit 1`);
  assert(/expected at least 99 work steps/.test(pop.out), "its output is shown");
  await app.bridge.waitFor("Send failures back (the agent owns the terminal)", `return !!e2e.first(".done-when-send");`);
  await app.bridge.screenshot(join(evidenceDir, "02-popover.png"));
  await app.bridge.click(".done-when-send");
  const sent = await waitForRecord((r) => r.file === rec.file && (r.turns ?? []).length >= 1, "the prompt Hermes pasted");
  const pasted = sent.turns[0].prompt;
  log(`  the agent received: ${JSON.stringify(pasted.slice(0, 160))}…`);
  assert(pasted.startsWith("Hermes Done-When checks failed (from .hermes/worktree.toml)."), "the agent got the failure report as its prompt");
  assert(/\$ .*check\.mjs \(exit 1\)/.test(pasted) && pasted.includes("expected at least 99 work steps"), "with the failing command and its output");
  assert(!pasted.includes("\x1b"), "and nothing that could drive the terminal");
  const sentLabel = await app.bridge.waitFor("the button to confirm", `
    const b = e2e.first(".done-when-send");
    return b && e2e.norm(b.innerText) === "Sent to the agent" ? e2e.norm(b.innerText) : null;
  `);
  assert(!!sentLabel, "the button says Sent to the agent");
  await app.bridge.click(".done-when-chip");

  // 3. passing turn; results on their turns
  log("step 3: the next turn end passes: tests ✓, each result on its turn");
  writeFileSync(join(folder, "pass-at.txt"), "0\n");
  let mark = Date.now();
  await injectTurnEnd(app.bridge, sid, 2);
  await waitResult(app.bridge, sid, mark);
  assert((await waitChip(app.bridge, "passed")) === "tests ✓", "the chip says tests ✓");
  assert((await forTurn(app.bridge, sid, 1))?.run.state === "failed", "turn 1 keeps its failing result");
  assert((await forTurn(app.bridge, sid, 2))?.run.state === "passed", "turn 2 has its passing result");
  await app.bridge.screenshot(join(evidenceDir, "03-tests-pass.png"));

  // 4. three failing turn ends in a row
  log("step 4: three failing turn ends in a row make the session check_failed");
  writeFileSync(join(folder, "pass-at.txt"), "99\n");
  for (const n of [3, 4]) {
    mark = Date.now();
    await injectTurnEnd(app.bridge, sid, n);
    const r = await waitResult(app.bridge, sid, mark);
    assert(r.run.state === "failed" && !r.check_failed && r.failed_turns === n - 2, `turn ${n}: failing, ${r.failed_turns} in a row, not yet check_failed`);
  }
  assert((await snapshot(app.bridge, sid)).status.kind !== "check_failed", "two failures are not enough");
  mark = Date.now();
  await injectTurnEnd(app.bridge, sid, 5);
  const r5 = await waitResult(app.bridge, sid, mark);
  assert(r5.check_failed && r5.failed_turns === 3, "the third makes it check_failed");
  const st = await app.bridge.waitFor("the status", `
    const s = window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(sid)});
    return s.status.kind === "check_failed" ? s.status : null;
  `);
  assert(st.confidence === "exact" && /check\.mjs/.test(st.detail), `status check_failed (exact): "${st.detail}"`);
  // Only the checks' own item: with the attention inbox on (the 2.0 default)
  // the session's status raises its own items too.
  const items = (await inbox(app.bridge)).filter((i) => i.sessionId === sid && i.source === "checks");
  assert(items.length === 1 && items[0].kind === "error" && items[0].source === "checks", `one error in the inbox: "${items[0]?.detail}"`);
  assert((await waitChip(app.bridge, "check_failed")) === "check failed", "the chip says check failed");
  const land = await invoke(app.bridge, "done_when_run", { sessionId: sid, trigger: "land", turn: null });
  assert(land.record?.run.trigger === "land" && land.record.run.state === "failed" && land.record.failed_turns === 3, "a run before Land reports the failure and is not counted as a turn end");
  await app.bridge.screenshot(join(evidenceDir, "04-check-failed.png"));

  // 5. Run checks again after the fix
  log("step 5: Run checks again after a fix clears it");
  writeFileSync(join(folder, "pass-at.txt"), "0\n");
  await app.bridge.click(".done-when-chip");
  mark = Date.now();
  await app.bridge.click(".done-when-rerun");
  const again = await waitResult(app.bridge, sid, mark);
  assert(again.run.trigger === "manual" && again.run.state === "passed" && !again.check_failed, "a manual run passed");
  assert((await waitChip(app.bridge, "passed")) === "tests ✓", "tests ✓ again");
  const cleared = await snapshot(app.bridge, sid);
  assert(cleared.status.kind === "done_unread", `the status cleared (${cleared.status.kind})`);
  assert((await inbox(app.bridge)).filter((i) => i.sessionId === sid && i.source === "checks").length === 0, "the inbox item was resolved");

  // 6. hi check at the shell prompt
  log("step 6: `hi check` at the shell prompt");
  await app.bridge.typeInTerminal(sid, "q");
  await waitForRecord((r) => r.file === rec.file && r.exit, "the fake agent quitting");
  await sleep(800);
  await app.bridge.typeInTerminal(sid, "hi check\n");
  await app.bridge.waitForTerminal(sid, /All checks passed\./, { timeoutMs: 30_000 });
  writeFileSync(join(folder, "pass-at.txt"), "99\n");
  await app.bridge.typeInTerminal(sid, "hi check\n");
  await app.bridge.waitForTerminal(sid, /1 of 1 checks failed\./, { timeoutMs: 30_000 });
  const lines = await app.bridge.readTerminal(sid);
  assert(lines.some((l) => /hi check: 1 check from \.hermes\/worktree\.toml/.test(l)), "it names where the checks come from");
  assert(lines.some((l) => /FAILED .*check\.mjs/.test(l)), "and which one failed");
  await app.bridge.screenshot(join(evidenceDir, "05-hi-check.png"));

  // 7. no agent, no send
  log("step 7: with the agent gone, a failing result offers no Send failures back");
  await app.bridge.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); return true;`);
  await app.bridge.waitFor("the check list to close", `return !e2e.first(".done-when-popover");`);
  await app.bridge.click(".done-when-chip");
  mark = Date.now();
  await app.bridge.click(".done-when-rerun");
  const noAgent = await waitResult(app.bridge, sid, mark);
  assert(noAgent.run.trigger === "manual" && noAgent.run.state === "failed", "a manual run failed");
  const note = await app.bridge.waitFor("the list to say no agent is running", `
    const p = e2e.first(".done-when-popover");
    const n = p && e2e.first(".done-when-note-no-agent", p);
    return n ? { note: e2e.norm(n.innerText), send: !!e2e.first(".done-when-send", p), rerun: !!e2e.first(".done-when-rerun", p) } : null;
  `);
  assert(!note.send && note.rerun, "no Send failures back button, Run checks again stays");
  assert(/No agent is running in this terminal/.test(note.note), `it says why: "${note.note}"`);
  await app.bridge.screenshot(join(evidenceDir, "06-no-agent.png"));
  const forced = await app.bridge.eval(`return await window.__HERMES_E2E__.doneWhenSendBack(${JSON.stringify(sid)});`);
  assert(forced === "no_agent", `asking the controller to send anyway is refused (${forced})`);
  await sleep(1000);
  const tail = await app.bridge.readTerminal(sid);
  assert(!tail.some((l) => l.includes("Hermes Done-When checks failed")), "nothing was pasted at the shell prompt");
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
    if (existsSync(recordDir)) cpSync(recordDir, join(evidenceDir, "fake-launch-records"), { recursive: true });
  } catch {
    /* best effort */
  }
  // A process the app started can still be writing its last line (an
  // agent reporting its exit) while the folder goes: retry briefly.
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
