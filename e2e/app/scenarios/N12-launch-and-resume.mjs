#!/usr/bin/env node
// Scenario N12 + N13: agents start through the bundled `hi` helper and
// resume after a restart.
//
// A fake `claude` (tools/fake-agents/fake-cli.mjs) stands in for the real
// CLI: it records how it was started, honours --session-id / --resume /
// --settings, runs the SessionStart hook from the settings file, and can act
// like a vendor that shows a folder-trust prompt or rejects a resume.
//
//   run 0  fresh install, flag OFF: a Claude session starts the old way (the
//          vendor command typed into the shell, no session id) — the negative
//          control that proves the flag gates the new path. Turn the
//          `launchHelper` flag on in the hidden Settings > Flags section.
//   run 1  flag ON, first shell (zsh/bash on macOS and Linux, PowerShell on
//          Windows): the terminal shows only `hi run <session-id>`; the fake
//          receives `--session-id <uuid> --settings <file under app data>`,
//          the Hermes environment and the session's folder; the settings file
//          holds hooks only; the SessionStart hook marks the session started;
//          nothing appears under the vendor's global config; the id is saved.
//   run 2  relaunch: the restored session runs `--resume <same id>`.
//   run 3  relaunch on the other shell (bash / cmd) with a vendor that rejects
//          the resume: one visible line, a fresh start with a new id, and the
//          new id is what Hermes remembers. Then a second session against a
//          vendor that sits at a trust prompt: "waiting at a startup prompt"
//          shows in the session list within a few seconds and clears once
//          the prompt is answered. A third session declines the prompt: the
//          agent is gone without ever having started, and Hermes says so
//          (ended) instead of leaving "waiting" on a shell that is back at
//          its prompt. A fourth session starts with the vendor CLI removed:
//          `hi` reports "command not found" and the state ends with it.
//
// Negative controls (each must end in RESULT: FAIL):
//   HERMES_E2E_N12_RESUME_MODE=ignore-resume   run 2's vendor accepts --resume
//          but starts a new conversation anyway; the resume checks fail.
//   HERMES_E2E_EXPECT_NOTICE=something-else     the failed-resume line check.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N12-launch-and-resume.mjs
//
// Evidence (log, screenshots, the fake's launch records) goes to
// HERMES_E2E_EVIDENCE, or <out dir>/evidence/N12-launch-and-resume.

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { REPO_ROOT, createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "N12-launch-and-resume";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
// Start from a clean evidence folder: a screenshot or record left by an
// earlier run must not sit next to this run's result.
mkdirSync(evidenceDir, { recursive: true });
for (const name of readdirSync(evidenceDir)) {
  if (name === "scenario.log" || name === "result.json" || name === "fake-launch-records" || name.endsWith(".png") || /^run-\w+$/.test(name)) {
    rmSync(join(evidenceDir, name), { recursive: true, force: true });
  }
}
const log = createLogger(logFile);
const onWindows = platform() === "win32";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// The one visible line a failed resume prints. Override it to prove the
// check can fail (HERMES_E2E_EXPECT_NOTICE=something-else must end in
// RESULT: FAIL).
const EXPECT_NOTICE = process.env.HERMES_E2E_EXPECT_NOTICE || "hermes: could not resume the previous conversation";
// The vendor's behaviour for run 2's resume; "ignore-resume" is the
// behavioural negative control (a vendor that starts fresh despite --resume).
const RESUME_MODE = process.env.HERMES_E2E_N12_RESUME_MODE || "normal";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

// ─── A fake `claude` on PATH, a record folder, a home that survives relaunches ──

const work = mkdtempSync(join(tmpdir(), "hermes-e2e-n12-"));
const fakeBin = join(work, "bin");
const recordDir = join(work, "records");
const privateHome = join(work, "home");
mkdirSync(fakeBin, { recursive: true });
mkdirSync(recordDir, { recursive: true });
mkdirSync(privateHome, { recursive: true });
const FAKE_CLI = join(REPO_ROOT, "tools", "fake-agents", "fake-cli.mjs");
if (onWindows) {
  writeFileSync(join(fakeBin, "claude.cmd"), `@"${process.execPath}" "${FAKE_CLI}" %*\r\n`);
} else {
  writeFileSync(join(fakeBin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`);
  chmodSync(join(fakeBin, "claude"), 0o755);
}
// Only the fake may answer to `claude`, and no key reaches the app.
const hasRealClaude = (dir) => ["claude", "claude.exe", "claude.cmd"].some((n) => existsSync(join(dir, n)));
process.env.PATH = [fakeBin, ...(process.env.PATH || "").split(delimiter).filter((d) => d && !hasRealClaude(d))].join(delimiter);
for (const name of Object.keys(process.env)) if (name.startsWith("ANTHROPIC_")) delete process.env[name];

/**
 * Windows terminals do not inherit the app's PATH: the terminal library
 * rebuilds PATH from the registry (machine Path, then the user's
 * HKCU\Environment Path) for every new terminal. So on Windows the fake
 * `claude` has to be on the user's registry Path (run 0 types `claude` into
 * that PATH; with the flag on, `hi` starts the agent with the same PATH).
 * That is a machine setting, so it is only changed on a throwaway CI runner,
 * and restored afterwards. Returns an undo function, or null.
 */
const canEditRegistryPath = onWindows && process.env.GITHUB_ACTIONS === "true";
function addFakeBinToRegistryPath() {
  if (!canEditRegistryPath) return null;
  let old = null;
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Environment", "/v", "Path"], { encoding: "utf8" });
    const m = out.match(/^\s*Path\s+REG_\w+\s+(.*)$/im);
    old = m ? m[1].trim() : "";
  } catch {
    old = null; // no user Path yet
  }
  const next = old ? `${old};${fakeBin}` : fakeBin;
  execFileSync("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", next, "/f"]);
  log("  (CI runner: added the fake claude folder to the user's registry Path)");
  return () => {
    if (old === null) {
      execFileSync("reg", ["delete", "HKCU\\Environment", "/v", "Path", "/f"]);
    } else {
      execFileSync("reg", ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", old, "/f"]);
    }
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
/**
 * One launch record. The fake replaces it whole on every update; a failed
 * parse (a fake from before that, or a slow file system) is read again.
 */
function readRecord(file) {
  for (let attempt = 0; ; attempt++) {
    try {
      return JSON.parse(readFileSync(join(recordDir, file), "utf8"));
    } catch (e) {
      if (attempt >= 20 || !(e instanceof SyntaxError)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}
/** The fake's launch records, oldest first. */
const records = () =>
  readdirSync(recordDir)
    .filter((f) => f.startsWith("launch-") && f.endsWith(".json"))
    .sort()
    .map((f) => ({ file: f, ...readRecord(f) }));
async function waitForRecords(count, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const all = records();
    if (all.length >= count) return all;
    if (Date.now() > deadline) throw new Error(`expected ${count} fake launch records, have ${all.length}`);
    await sleep(200);
  }
}

// Windows keeps app data under %APPDATA%, which a private HOME does not move,
// so there the harness uses the real home and the test app's own data folder.
const homeForVendor = onWindows ? homedir() : privateHome;
function launch(run, { first = false } = {}) {
  const runDir = join(evidenceDir, `run-${run}`);
  const common = { runDir, log, env: { HERMES_FAKE_DIR: recordDir } };
  return onWindows
    ? launchApp({ ...common, home: "real", resetData: first })
    : launchApp({ ...common, home: "private", homeDir: privateHome });
}

// ─── The vendor's global config must never change ────────────────────
const VENDOR_CONFIG = [".claude", ".claude.json", ".codex", ".gemini", ".config/claude"];
function vendorConfigSnapshot() {
  const snap = {};
  for (const rel of VENDOR_CONFIG) {
    const p = join(homeForVendor, rel);
    if (!existsSync(p)) continue;
    const st = statSync(p);
    snap[rel] = st.isDirectory()
      ? { dir: true, entries: readdirSync(p).sort(), mtimeMs: st.mtimeMs }
      : { dir: false, size: st.size, mtimeMs: st.mtimeMs };
  }
  return snap;
}

// ─── UI steps ────────────────────────────────────────────────────────

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

async function dismissWhatsNew(bridge) {
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
}

async function waitForReturningLaunch(bridge) {
  await bridge.waitFor("the app UI to be ready (no onboarding this time)", `
    return !!e2e.first(".topbar-title, .topbar") && !e2e.first(".onboarding-backdrop");
  `);
  await dismissWhatsNew(bridge);
}

/** Settings > (7 clicks on the title) > Flags: set the launchHelper override. */
async function setLaunchHelperOverride(bridge, value) {
  await bridge.clickByName("Settings");
  await bridge.waitFor("the Settings dialog", `return !!e2e.first('[role="dialog"] .settings-title');`);
  await bridge.eval(`
    const title = e2e.must(e2e.first(".settings-title"), "settings title");
    for (let i = 0; i < 7; i++) e2e.click(title);
    return true;
  `);
  await bridge.waitFor("the hidden Flags tab", `return e2e.all(".settings-tab").some((el) => e2e.norm(el.innerText) === "Flags");`);
  await bridge.eval(`
    const tab = e2e.all(".settings-tab").find((el) => e2e.norm(el.innerText) === "Flags");
    return e2e.click(e2e.must(tab, "Flags tab"));
  `);
  await bridge.waitFor("the launchHelper flag control", `return !!e2e.first('select.settings-select[data-flag-id="launchHelper"]');`);
  const result = await bridge.eval(`
    const sel = e2e.must(e2e.first('select.settings-select[data-flag-id="launchHelper"]'), "launchHelper select");
    const label = e2e.norm(sel.closest(".settings-group")?.querySelector(".settings-label")?.innerText);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
    setter.call(sel, ${JSON.stringify(value)});
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return { value: sel.value, label };
  `);
  assert(result.value === value, `flag "${result.label}" set to "${value}"`);
  await bridge.waitFor("the override to be saved", `
    const raw = await window.__TAURI_INTERNALS__.invoke("get_settings");
    const overrides = raw.feature_flag_overrides ? JSON.parse(raw.feature_flag_overrides) : {};
    return overrides.launchHelper === ${value === "on" ? "true" : "false"};
  `);
  await bridge.click(".settings-close");
  await bridge.waitFor("the Settings dialog to close", `return !e2e.first(".settings-title");`);
}

/** New Session wizard: a Claude session in a terminal, default folder. */
async function createClaudeSession(bridge) {
  const before = await bridge.terminalIds();
  // The empty state offers a tile; with sessions open, the top bar's button.
  if (await bridge.exists("button.es-tile-primary")) await bridge.click("button.es-tile-primary");
  else await bridge.clickByName("New session");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  // Older wizards start with a mode step; pick "terminal" there.
  if (await bridge.exists('.session-creator-mode-card[data-category="universal"]')) {
    await bridge.click('.session-creator-mode-card[data-category="universal"]');
    await sleep(200);
    if (await bridge.exists(".session-creator-mode-step")) {
      await bridge.click(".session-creator-actions .session-creator-btn-primary");
    }
  }
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`, { timeoutMs: 20_000 });
  const picked = await bridge.clickWhenReady(`
    const card = e2e.all(".session-creator-provider-card").find((c) => c.innerText.trim().startsWith("Claude"));
    return e2e.click(e2e.must(card, "the Claude card"));
  `);
  log(`  agent picker: clicked "${picked.clicked}"`);
  // A wizard may offer the Agent view for Claude; the terminal is what we test.
  await bridge.eval(`
    const box = e2e.first(".session-creator-agent-view input[type=checkbox]");
    if (box && box.checked) e2e.click(box);
    return true;
  `);
  for (let i = 0; i < 8; i++) {
    if (!(await bridge.exists(".session-creator"))) break;
    const clicked = await bridge.clickWhenReady(`
      if (!e2e.first(".session-creator")) return null;
      const b = e2e.must(
        e2e.first(".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary"),
        "the wizard's primary button",
      );
      const step = e2e.first(".session-creator-step")?.innerText ?? "";
      return { step, ...e2e.click(b) };
    `);
    if (clicked) log(`  wizard ${clicked.step}: clicked "${clicked.clicked}"`);
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

/** What the backend knows about a session (the same data the session list shows). */
async function sessionData(bridge, sessionId) {
  const all = await bridge.eval(`return await window.__TAURI_INTERNALS__.invoke("get_sessions");`);
  return all.find((s) => s.id === sessionId) ?? null;
}
async function waitForStartup(bridge, sessionId, state, { timeoutMs = 20_000 } = {}) {
  const t0 = Date.now();
  await bridge.waitFor(`the session's startup state to be "${state}"`, `
    const all = await window.__TAURI_INTERNALS__.invoke("get_sessions");
    const s = all.find((x) => x.id === ${JSON.stringify(sessionId)});
    return s?.agent_startup?.state === ${JSON.stringify(state)} ? s.agent_startup : null;
  `, { timeoutMs });
  return Date.now() - t0;
}
// With the flag on, the session list shows one status per session (F10): a
// startup prompt is the status tag with data-status="startup_prompt", its
// word is the text, and the row keeps the helper's raw state in data-startup.
const STARTUP_TAG = `.session-item .agent-status-tag[data-status="startup_prompt"]`;
const READ_STARTUP_TAG = `
  const tag = e2e.first(${JSON.stringify(STARTUP_TAG)});
  return tag ? { text: e2e.norm(tag.querySelector(".agent-status-word")?.innerText), startup: tag.closest(".session-item")?.getAttribute("data-startup") } : null;
`;
const startupTag = (bridge) => bridge.eval(READ_STARTUP_TAG);
// A restored terminal shows its old scrollback too (replayed while the new
// shell may already be printing), so every wait on a restored terminal
// looks for a line only this run can produce, never for a generic one.
async function firstRestoredTerminal(bridge) {
  return bridge.waitFor("the restored session's terminal", `
    const ids = window.__HERMES_E2E__.terminalIds();
    return ids.length >= 1 ? ids[0] : null;
  `, { timeoutMs: 30_000 });
}
/**
 * Waits until the terminal's rows, joined without the wrap boundaries and
 * with runs of blanks collapsed, satisfy `test`; returns that text. A shell
 * with a long prompt can wrap or redraw one typed line over two rows.
 */
async function waitForTerminalText(bridge, sessionId, test, what, { timeoutMs = 30_000 } = {}) {
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
/**
 * Whether the terminal text shows `line`: whole, or split at one point into
 * two fragments the shell drew apart. A shell with a long prompt (a CI
 * runner's bash) wraps the typed line and then, on the first resize, redraws
 * the prompt over the continuation row, leaving `…$ hi ru` and `n <id>` in
 * the other order. Where the row breaks depends on the prompt's length (the
 * runner's host name), so the first fragment can be as short as `hi r`.
 * Blanks are ignored. A split before the fourth character still leaves the
 * whole session id in the second fragment, and a split inside the id leaves
 * at least four characters of it on each side, so a stray "hi" elsewhere
 * never counts.
 */
function showsLine(text, line) {
  const t = text.replace(/\s+/g, "");
  const l = line.replace(/\s+/g, "");
  if (t.includes(l)) return true;
  for (let k = 1; k <= l.length - 4; k++) if (t.includes(l.slice(0, k)) && t.includes(l.slice(k))) return true;
  return false;
}
async function waitForSavedVendorId(bridge, sessionId, vendorId) {
  // The frontend saves the workspace every 10 s once something changed.
  await bridge.waitFor("the conversation id to be saved with the workspace", `
    const raw = await window.__TAURI_INTERNALS__.invoke("get_settings");
    if (!raw.saved_workspace) return null;
    const ws = JSON.parse(raw.saved_workspace);
    const s = ws.sessions.find((x) => x.id === ${JSON.stringify(sessionId)});
    return s && s.vendor_session_id === ${JSON.stringify(vendorId)} ? s : null;
  `, { timeoutMs: 25_000 });
}
async function setSetting(bridge, key, value) {
  await bridge.eval(`return await window.__TAURI_INTERNALS__.invoke("set_setting", { key: ${JSON.stringify(key)}, value: ${JSON.stringify(value)} });`);
}
async function quit(current) {
  const exit = await current.stop();
  log(`  app exited: ${JSON.stringify(exit)}`);
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");
}
const shellName = (shell) => basename(shell).toLowerCase();
/** Same folder, whatever symlinks (/var → /private/var) or letter case say. */
const sameFolder = (a, b) => {
  const norm = (p) => {
    try {
      p = realpathSync(p);
    } catch {
      /* keep as given */
    }
    return onWindows ? p.toLowerCase() : p;
  };
  return norm(a) === norm(b);
};
/** A shell other than `first` for the second half of the scenario. */
function otherShell(first) {
  if (onWindows) return "cmd.exe";
  const candidates = ["/bin/zsh", "/usr/bin/zsh", "/bin/bash", "/usr/bin/bash"];
  return candidates.find((p) => existsSync(p) && shellName(p) !== first) ?? null;
}

let app;
let failed = false;
const vendorBefore = vendorConfigSnapshot();
let secondShell;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   fake claude: ${fakeBin}`);
  undoRegistryPath = addFakeBinToRegistryPath();
  log(`  vendor config before: ${JSON.stringify(vendorBefore)}`);
  setFakeMode("normal");

  // ── run 0: flag off — the old typed launch (negative control) ─────
  log("run 0: fresh install, flag OFF: a Claude session starts the old way");
  app = await launch(0, { first: true });
  await completeOnboarding(app.bridge);
  const legacyId = await createClaudeSession(app.bridge);
  const legacy = (await waitForRecords(1))[0];
  log(`  fake saw argv ${JSON.stringify(legacy.argv)} (cwd ${legacy.cwd})`);
  assert(!legacy.argv.includes("--session-id") && !legacy.argv.includes("--settings"), "with the flag off the vendor command is typed as before: no session id, no settings file");
  const legacyLines = await app.bridge.readTerminal(legacyId);
  assert(!legacyLines.some((l) => /\bhi run\b/.test(l)), "with the flag off the terminal never shows `hi run`");
  const legacyData = await sessionData(app.bridge, legacyId);
  assert(!legacyData.vendor_session_id && !legacyData.agent_startup, "with the flag off Hermes records no conversation id and no startup state");
  await app.bridge.screenshot(join(evidenceDir, "00-flag-off-legacy-launch.png"));
  // Close it (the old path is not what the rest of the scenario restores).
  await app.bridge.click(".session-item .session-item-close");
  await sleep(300);
  if (await app.bridge.exists(".close-dialog")) await app.bridge.click(".close-dialog .close-dialog-btn-confirm");
  await app.bridge.waitFor("the session to close", `return e2e.all(".session-item").length === 0;`);
  log("  turning the launchHelper flag on (takes effect on next launch)");
  await setLaunchHelperOverride(app.bridge, "on");
  await quit(app);

  // ── run 1: flag on, first shell ───────────────────────────────────
  log("run 1: flag ON — a Claude session starts through `hi run`");
  app = await launch(1);
  await waitForReturningLaunch(app.bridge);
  const s1 = await createClaudeSession(app.bridge);
  log(`  session created: ${s1}`);
  const launchedAt = Date.now();
  // A long prompt (a CI runner's bash) wraps or redraws the typed line over
  // two rows, so the launch line is looked for in the rows' text as a whole.
  const typed = await waitForTerminalText(app.bridge, s1, (text) => showsLine(text, `hi run ${s1}`), `the launch line "hi run ${s1}"`);
  assert(showsLine(typed, `hi run ${s1}`), `the terminal shows the shell-neutral line "hi run ${s1}"`);
  assert(!/--session-id|--settings|--resume/.test(typed), "the terminal never shows the vendor's own flags: everything else is in the launch file");
  await app.bridge.waitForTerminal(s1, /fake-cli: ready/, { timeoutMs: 30_000 });
  const startedIn = await waitForStartup(app.bridge, s1, "started");
  log(`  started (exact) ${Date.now() - launchedAt} ms after the launch line`);

  const rec1 = (await waitForRecords(2)).at(-1);
  const d1 = await sessionData(app.bridge, s1);
  log(`  fake saw argv ${JSON.stringify(rec1.argv)}`);
  log(`  fake saw env ${JSON.stringify(rec1.env)}`);
  // What `hi run <id>` resolves to, independent of how the shell drew the line.
  const launchFile = JSON.parse(readFileSync(join(app.dataDir, "launch", s1, "launch.json"), "utf8"));
  assert(launchFile.program === "claude" && JSON.stringify(launchFile.args) === JSON.stringify(rec1.argv), `the launch file behind "hi run ${s1}" names ${launchFile.program} with exactly the arguments the agent received`);
  const sidAt = rec1.argv.indexOf("--session-id");
  const vendorId1 = sidAt >= 0 ? rec1.argv[sidAt + 1] : null;
  assert(vendorId1 && UUID.test(vendorId1), `the agent got a pre-assigned session id (${vendorId1})`);
  assert(!rec1.argv.includes("--resume"), "a new session is not a resume");
  const settingsAt = rec1.argv.indexOf("--settings");
  const settingsFile = settingsAt >= 0 ? rec1.argv[settingsAt + 1] : null;
  assert(settingsFile && settingsFile.startsWith(join(app.dataDir, "launch", s1)), `the settings file lives under the app's data folder (${settingsFile})`);
  assert(rec1.settings && Object.keys(rec1.settings).join() === "hooks", "the settings file holds hooks and nothing else");
  const startHook = rec1.settings.hooks.SessionStart?.[0]?.hooks?.[0];
  assert(
    startHook?.type === "command" && /\bhi(\.exe)?$/.test(startHook.command) && JSON.stringify(startHook.args) === JSON.stringify(["signal", "--agent", "claude"]),
    `the SessionStart hook calls hi signal in exec form ("${startHook?.command}" ${JSON.stringify(startHook?.args)})`,
  );
  assert(rec1.env.HERMES_SESSION_ID === s1, "HERMES_SESSION_ID is the Hermes session id");
  assert(rec1.env.HERMES_AGENT === "claude", "HERMES_AGENT names the agent");
  assert(typeof rec1.env.HERMES_SIGNAL_FILE === "string" && rec1.env.HERMES_SIGNAL_FILE.endsWith("signals.ndjson"), "HERMES_SIGNAL_FILE points at the session's signal spool");
  assert(/^[0-9a-f]{32}$/.test(rec1.env.HERMES_SIGNAL_NONCE || ""), "HERMES_SIGNAL_NONCE carries this launch's nonce for the spool lines");
  assert(rec1.env.TERM_PROGRAM === "HERMES-IDE", "the agent runs inside the Hermes terminal");
  assert(sameFolder(rec1.cwd, d1.working_directory), `the agent started in the session's folder (${rec1.cwd})`);
  const hookRun = rec1.hooksRan.find((h) => h.event === "SessionStart");
  assert(hookRun && hookRun.results.length === 1 && hookRun.results[0].code === 0, "the agent ran the SessionStart hook and hi signal exited 0");
  assert(d1.vendor_session_id === vendorId1, "Hermes remembers that session id as the conversation to resume");
  assert(d1.agent_startup.state === "started" && d1.agent_startup.confidence === "exact", `startup state is started/exact (took ${startedIn} ms)`);
  const firstShell = shellName(d1.shell);
  log(`  the session's shell: ${d1.shell}`);
  assert(onWindows ? /^(pwsh|powershell)(\.exe)?$/.test(firstShell) : /^(zsh|bash)$/.test(firstShell), `run 1 used ${firstShell}`);
  // Negative control for the startup-prompt guess: a normal start never shows it.
  const sinceLaunch = Date.now() - launchedAt;
  if (sinceLaunch < 6500) await sleep(6500 - sinceLaunch);
  assert((await startupTag(app.bridge)) === null, "a normally started agent is never reported as waiting at a startup prompt");
  const listed = await app.bridge.eval(`return e2e.first(".session-item")?.getAttribute("data-startup") ?? null;`);
  assert(listed === "started", `the session list carries data-startup="${listed}"`);
  await app.bridge.screenshot(join(evidenceDir, "01-hi-run-started.png"));
  await waitForSavedVendorId(app.bridge, s1, vendorId1);
  assert(JSON.stringify(vendorConfigSnapshot()) === JSON.stringify(vendorBefore), "nothing changed under the vendor's global config (~/.claude, ~/.claude.json, ~/.codex, ~/.gemini)");
  if (RESUME_MODE !== "normal") setFakeMode(RESUME_MODE);
  await quit(app);

  // ── run 2: relaunch, the conversation resumes ─────────────────────
  log("run 2: relaunch — the restored session resumes the same conversation");
  app = await launch(2);
  await waitForReturningLaunch(app.bridge);
  const s2 = await firstRestoredTerminal(app.bridge);
  // Run 1's scrollback says "(new)"; only this run's agent says it resumed.
  await app.bridge.waitForTerminal(s2, /\(resumed from /, { timeoutMs: 45_000 });
  const rec2 = (await waitForRecords(3)).at(-1);
  log(`  fake saw argv ${JSON.stringify(rec2.argv)}`);
  const resumeAt = rec2.argv.indexOf("--resume");
  assert(resumeAt >= 0 && rec2.argv[resumeAt + 1] === vendorId1, `the restored session resumes conversation ${vendorId1}`);
  assert(!rec2.argv.includes("--session-id"), "a resume pre-assigns no new id");
  const resumedLine = (await app.bridge.readTerminal(s2)).find((l) => l.includes("resumed from"));
  assert(resumedLine && resumedLine.includes(vendorId1), `the agent says it resumed ("${resumedLine?.trim()}")`);
  await waitForStartup(app.bridge, s2, "started");
  const d2 = await sessionData(app.bridge, s2);
  assert(d2.vendor_session_id === vendorId1, "the restored session keeps the same conversation id");
  assert(shellName(d2.shell) === firstShell, `the restored session runs in ${firstShell} again`);
  assert(!(await app.bridge.readTerminal(s2)).some((l) => l.includes("hermes: could not resume")), "a resume that works prints no restart line");
  await app.bridge.screenshot(join(evidenceDir, "02-resumed.png"));
  await waitForSavedVendorId(app.bridge, s2, vendorId1);

  // Prepare run 3: the other shell, and a vendor that rejects the resume.
  secondShell = otherShell(firstShell);
  if (secondShell) await setSetting(app.bridge, "default_shell", secondShell);
  else log(`  no second shell available on this machine; run 3 stays on ${firstShell}`);
  setFakeMode("resume-fails");
  await quit(app);

  // ── run 3: other shell, failed resume, then a trust prompt ────────
  log(`run 3: relaunch in ${secondShell ?? firstShell} — the vendor rejects the resume`);
  app = await launch(3);
  await waitForReturningLaunch(app.bridge);
  const s3 = await firstRestoredTerminal(app.bridge);
  await waitForStartup(app.bridge, s3, "started", { timeoutMs: 45_000 });
  const all3 = await waitForRecords(5);
  const [rejected, fresh] = all3.slice(-2);
  log(`  fake saw argv ${JSON.stringify(rejected.argv)} then ${JSON.stringify(fresh.argv)}`);
  assert(rejected.argv.includes("--resume") && rejected.exit?.code === 1, "the vendor rejected the resume (exit 1)");
  const freshAt = fresh.argv.indexOf("--session-id");
  const vendorId3 = freshAt >= 0 ? fresh.argv[freshAt + 1] : null;
  assert(vendorId3 && UUID.test(vendorId3) && vendorId3 !== vendorId1, `a fresh conversation started with a new id (${vendorId3})`);
  // The old scrollback (runs 1 and 2) never had a restart line or this id.
  await app.bridge.waitForTerminal(s3, new RegExp(`session ${vendorId3} \\(new\\)`), { timeoutMs: 30_000 });
  const lines3 = await app.bridge.readTerminal(s3);
  const notices = lines3.filter((l) => l.includes(EXPECT_NOTICE));
  assert(notices.length === 1, `exactly one visible line says so ("${EXPECT_NOTICE}"): "${notices[0]?.trim()}"`);
  assert(notices[0].includes("starting a new one"), "the line says a new conversation starts");
  const d3 = await sessionData(app.bridge, s3);
  assert(d3.vendor_session_id === vendorId3, "Hermes now remembers the new conversation id");
  if (secondShell) assert(shellName(d3.shell) === shellName(secondShell) && shellName(d3.shell) !== firstShell, `run 3 used ${shellName(d3.shell)} (run 1 used ${firstShell})`);
  else log(`  run 3 used ${shellName(d3.shell)}`);
  for (const l of lines3.slice(-8)) log(`    | ${l}`);
  await app.bridge.screenshot(join(evidenceDir, "03-resume-failed-fresh-start.png"));

  log("run 3, second session: the vendor sits at a folder-trust prompt");
  setFakeMode("trust-prompt");
  const s4 = await createClaudeSession(app.bridge);
  // This wait only marks when the launch line appeared (run 1 already proved
  // the line itself). zsh with a long prompt can erase the start of a wrapped
  // typed line when it redraws on a resize, leaving just `un <id>` on screen;
  // the Hermes session id appears nowhere but in the launch line, so a tail
  // that still holds the whole id counts too.
  await waitForTerminalText(app.bridge, s4, (text) => showsLine(text, `hi run ${s4}`) || text.replace(/\s+/g, "").includes(`un${s4}`), `the launch line "hi run ${s4}"`);
  const t4 = Date.now();
  await app.bridge.waitForTerminal(s4, /Do you trust the files in this folder\?/, { timeoutMs: 30_000 });
  const guessIn = await waitForStartup(app.bridge, s4, "waiting_at_startup_prompt", { timeoutMs: 15_000 });
  const sinceLaunchLine = Date.now() - t4;
  log(`  reported as waiting ${sinceLaunchLine} ms after the launch line (${guessIn} ms after the prompt was on screen)`);
  const d4 = await sessionData(app.bridge, s4);
  assert(d4.agent_startup.confidence === "guessed", "the startup-prompt report is marked as a guess");
  assert(sinceLaunchLine >= 4_000 && sinceLaunchLine <= 9_000, "the report came about 5 seconds after the launch, not sooner and not much later");
  const tag = await app.bridge.waitFor("the startup-prompt tag in the session list", READ_STARTUP_TAG);
  assert(tag.text === "waiting at a startup prompt" && tag.startup === "waiting_at_startup_prompt", `the session list says "${tag.text}"`);
  await app.bridge.screenshot(join(evidenceDir, "04-waiting-at-startup-prompt.png"));
  log("  answering the prompt with y");
  await app.bridge.typeInTerminal(s4, "y");
  await app.bridge.waitForTerminal(s4, /fake-cli: ready/, { timeoutMs: 20_000 });
  await waitForStartup(app.bridge, s4, "started");
  await app.bridge.waitFor("the startup-prompt tag to clear", `return !e2e.first(${JSON.stringify(STARTUP_TAG)});`);
  assert((await startupTag(app.bridge)) === null, "once the prompt is answered the agent counts as started and the tag is gone");
  await app.bridge.screenshot(join(evidenceDir, "05-trust-answered.png"));

  log("run 3, third session: the trust prompt is declined — the agent ends without ever starting");
  const s5 = await createClaudeSession(app.bridge);
  await app.bridge.waitForTerminal(s5, /Do you trust the files in this folder\?/, { timeoutMs: 30_000 });
  await waitForStartup(app.bridge, s5, "waiting_at_startup_prompt", { timeoutMs: 15_000 });
  log("  answering the prompt with n");
  await app.bridge.typeInTerminal(s5, "n");
  const endedIn = await waitForStartup(app.bridge, s5, "ended", { timeoutMs: 15_000 });
  const d5 = await sessionData(app.bridge, s5);
  assert(d5.agent_startup.confidence === "exact", `the end is exact (reported by the helper, ${endedIn} ms after n)`);
  const declined = (await waitForRecords(7)).at(-1);
  assert(declined.exit?.why === "declined-trust" && !declined.hooksRan.some((h) => h.event === "SessionStart"), "the vendor exited at the prompt without running any hook");
  await app.bridge.waitFor("the startup-prompt tag to clear after the decline", `return !e2e.first(${JSON.stringify(STARTUP_TAG)});`);
  assert((await app.bridge.eval(`return e2e.all(".session-item").map((el) => el.getAttribute("data-startup"));`)).every((v) => v !== "waiting_at_startup_prompt"), "no session is still reported as waiting at a startup prompt");
  await app.bridge.screenshot(join(evidenceDir, "06-trust-declined-ended.png"));

  log("run 3, fourth session: the vendor CLI is not installed");
  rmSync(join(fakeBin, onWindows ? "claude.cmd" : "claude"), { force: true });
  const s6 = await createClaudeSession(app.bridge);
  await app.bridge.waitForTerminal(s6, /hi: claude: command not found/, { timeoutMs: 30_000 });
  await waitForStartup(app.bridge, s6, "ended", { timeoutMs: 15_000 });
  const d6 = await sessionData(app.bridge, s6);
  assert(d6.agent_startup.confidence === "exact" && /command not found/.test(d6.agent_startup.detail ?? ""), `the state says why the agent is gone ("${d6.agent_startup.detail}")`);
  assert((await startupTag(app.bridge)) === null, "a missing command never shows as a startup prompt");
  await app.bridge.screenshot(join(evidenceDir, "07-command-not-found-ended.png"));
  assert(JSON.stringify(vendorConfigSnapshot()) === JSON.stringify(vendorBefore), "still nothing under the vendor's global config");
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      const dump = await app.bridge.eval(`
        return {
          buttons: e2e.all("button").map(e2e.nameOf).slice(0, 40),
          sessions: e2e.all(".session-item").map((el) => ({ text: e2e.norm(el.innerText).slice(0, 80), phase: el.getAttribute("data-phase"), startup: el.getAttribute("data-startup") })),
          terminals: window.__HERMES_E2E__.terminalIds().map((id) => ({ id, tail: (window.__HERMES_E2E__.readTerminal(id) || []).slice(-12) })),
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
  // Keep the fake's launch records with the evidence; drop the rest.
  try {
    cpSync(recordDir, join(evidenceDir, "fake-launch-records"), { recursive: true });
  } catch {
    /* best effort */
  }
  // The app's last writes (and its terminals' shells) can land a moment
  // after it quit; a cleanup race is not a test result.
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    log(`  (could not remove the scratch folder: ${e.message})`);
  }
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
