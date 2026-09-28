#!/usr/bin/env node
// Scenario N13: Ctrl-C at a resumed agent's startup prompt keeps the
// conversation, and the "waiting at a startup prompt" report never outlives
// the prompt.
//
// A fake `claude` (tools/fake-agents/fake-cli.mjs) stands in for the real CLI
// and records every launch. The `launchHelper` flag is on (agents start
// through the bundled `hi` helper).
//
//   run 0  fresh install: welcome screens, flag on, quit.
//   run 1  a Claude session starts; Hermes records its conversation id.
//   run 2  relaunch: the restored session resumes that conversation, and the
//          vendor sits at a folder-trust prompt. Ctrl-C there, at once (well
//          inside the 3 s in which an early exit used to count as a failed
//          resume), and the vendor exits 1 — the code it also uses for "no
//          such conversation", but without saying so. Nothing replaces the
//          conversation: no "could not resume" line, no second launch, the
//          session ends and still holds the same id.
//   run 3  relaunch: this time the vendor no longer knows the conversation
//          (it says so and exits 1), so hi starts a fresh one — and the
//          fresh agent is interrupted at its own trust prompt before it ever
//          starts. Hermes keeps the old conversation: a conversation that
//          never started does not replace it.
//   run 4  relaunch: the same conversation is resumed again.
//          Then a new session whose vendor, once its trust prompt is
//          answered, starts without a start signal (hooks off): "waiting at a
//          startup prompt" shows, the answer clears it, and it does not come
//          back. Then Ctrl-C at a trust prompt: the report ends with the exit.
//
// Negative control: run this scenario against a build of the code before
// the fix (hi falls back on any early non-zero exit, Hermes adopts the new
// id at once, and the report stays until a start signal): it must end in
// RESULT: FAIL at run 2 ("no second agent started ..."). A build in which
// Hermes adopts the fresh conversation as soon as hi falls back must end in
// RESULT: FAIL at run 3 ("the session still holds conversation ...").
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/N13-interrupted-resume.mjs
//
// Evidence (log, screenshots, the fake's launch records) goes to
// HERMES_E2E_EVIDENCE, or <out dir>/evidence/N13-interrupted-resume.

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { REPO_ROOT, createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "N13-interrupted-resume";
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
/** hi's window in which an early exit may count as a failed resume. */
const RESUME_WINDOW_MS = 3000;

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

// ─── A fake `claude` on PATH, a record folder, a home that survives relaunches ──

const work = mkdtempSync(join(tmpdir(), "hermes-e2e-n13-"));
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

// Windows terminals rebuild PATH from the registry, so there the fake has to
// be on the user's registry Path: changed only on a throwaway CI runner, and
// restored afterwards (the same arrangement as N12-launch-and-resume).
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
async function waitForExit(file, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rec = readRecord(file);
    if (rec.exit) return rec;
    if (Date.now() > deadline) throw new Error(`the fake launch ${file} never exited`);
    await sleep(100);
  }
}

function launch(run, { first = false } = {}) {
  const runDir = join(evidenceDir, `run-${run}`);
  const common = { runDir, log, env: { HERMES_FAKE_DIR: recordDir } };
  return onWindows
    ? launchApp({ ...common, home: "real", resetData: first })
    : launchApp({ ...common, home: "private", homeDir: privateHome });
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

async function waitForReturningLaunch(bridge) {
  await bridge.waitFor("the app UI to be ready (no onboarding this time)", `
    return !!e2e.first(".topbar-title, .topbar") && !e2e.first(".onboarding-backdrop");
  `);
  await dismissWhatsNew(bridge);
}

/** New Session wizard: a Claude session in a terminal, default folder. */
async function createClaudeSession(bridge) {
  const before = await bridge.terminalIds();
  if (await bridge.exists("button.es-tile-primary")) await bridge.click("button.es-tile-primary");
  else await bridge.clickByName("New session");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  if (await bridge.exists('.session-creator-mode-card[data-category="universal"]')) {
    await bridge.click('.session-creator-mode-card[data-category="universal"]');
    await sleep(200);
    if (await bridge.exists(".session-creator-mode-step")) {
      await bridge.click(".session-creator-actions .session-creator-btn-primary");
    }
  }
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`, { timeoutMs: 20_000 });
  await bridge.clickWhenReady(`
    const card = e2e.all(".session-creator-provider-card").find((c) => c.innerText.trim().startsWith("Claude"));
    return e2e.click(e2e.must(card, "the Claude card"));
  `);
  await bridge.eval(`
    const box = e2e.first(".session-creator-agent-view input[type=checkbox]");
    if (box && box.checked) e2e.click(box);
    return true;
  `);
  for (let i = 0; i < 8; i++) {
    if (!(await bridge.exists(".session-creator"))) break;
    await bridge.clickWhenReady(`
      if (!e2e.first(".session-creator")) return null;
      return e2e.click(e2e.must(
        e2e.first(".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary"),
        "the wizard's primary button",
      ));
    `);
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
/** The "waiting at a startup prompt" tags in the session list. */
const startupTags = (bridge) => bridge.eval(`return e2e.all(".session-startup-tag").map((t) => e2e.norm(t.innerText));`);
async function firstRestoredTerminal(bridge) {
  return bridge.waitFor("the restored session's terminal", `
    const ids = window.__HERMES_E2E__.terminalIds();
    return ids.length >= 1 ? ids[0] : null;
  `, { timeoutMs: 30_000 });
}
async function savedVendorId(bridge, sessionId) {
  const raw = await bridge.eval(`return await window.__TAURI_INTERNALS__.invoke("get_settings");`);
  if (!raw.saved_workspace) return undefined;
  const s = JSON.parse(raw.saved_workspace).sessions.find((x) => x.id === sessionId);
  return s ? s.vendor_session_id ?? null : undefined;
}
async function waitForSavedVendorId(bridge, sessionId, vendorId) {
  // The frontend saves the workspace every 10 s once something changed.
  await bridge.waitFor("the conversation id to be saved with the workspace", `
    const raw = await window.__TAURI_INTERNALS__.invoke("get_settings");
    if (!raw.saved_workspace) return null;
    const s = JSON.parse(raw.saved_workspace).sessions.find((x) => x.id === ${JSON.stringify(sessionId)});
    return s && s.vendor_session_id === ${JSON.stringify(vendorId)} ? s : null;
  `, { timeoutMs: 25_000 });
}
/** Ctrl-C the way a keyboard sends it: a key-down with the Control modifier. */
function pressCtrlC(bridge, sessionId) {
  return bridge.eval(`
    const host = document.querySelector('div[data-session-id="' + CSS.escape(${JSON.stringify(sessionId)}) + '"]');
    const ta = host.querySelector("textarea.xterm-helper-textarea");
    const mk = (type) => {
      const ev = new KeyboardEvent(type, { key: "c", code: "KeyC", ctrlKey: true, bubbles: true, cancelable: true, composed: true, view: window });
      Object.defineProperty(ev, "keyCode", { get: () => 67 });
      Object.defineProperty(ev, "which", { get: () => 67 });
      return ev;
    };
    ta.dispatchEvent(mk("keydown"));
    ta.dispatchEvent(mk("keyup"));
    return true;
  `);
}
async function quit(current) {
  const exit = await current.stop();
  log(`  app exited: ${JSON.stringify(exit)}`);
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");
}

let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   fake claude: ${fakeBin}`);
  undoRegistryPath = addFakeBinToRegistryPath();
  setFakeMode("normal");

  // ── run 0: fresh install, flag on ─────────────────────────────────
  log("run 0: fresh install; turn the launchHelper flag on (read at startup)");
  app = await launch(0, { first: true });
  await completeOnboarding(app.bridge);
  await app.bridge.eval(`return await window.__TAURI_INTERNALS__.invoke("set_setting", { key: "feature_flag_overrides", value: ${JSON.stringify(JSON.stringify({ launchHelper: true }))} });`);
  await quit(app);

  // ── run 1: a conversation to resume ───────────────────────────────
  log("run 1: a Claude session starts and Hermes records its conversation id");
  app = await launch(1);
  await waitForReturningLaunch(app.bridge);
  const s1 = await createClaudeSession(app.bridge);
  await app.bridge.waitForTerminal(s1, /fake-cli: ready/, { timeoutMs: 30_000 });
  await waitForStartup(app.bridge, s1, "started");
  const rec1 = (await waitForRecords(1)).at(-1);
  const sidAt = rec1.argv.indexOf("--session-id");
  const vendorId = sidAt >= 0 ? rec1.argv[sidAt + 1] : null;
  assert(vendorId && UUID.test(vendorId), `the agent started through hi with conversation id ${vendorId}`);
  assert((await sessionData(app.bridge, s1)).vendor_session_id === vendorId, "Hermes remembers that conversation");
  await waitForSavedVendorId(app.bridge, s1, vendorId);
  await app.bridge.screenshot(join(evidenceDir, "01-started.png"));
  setFakeMode("trust-prompt interrupt-exit-1");
  await quit(app);

  // ── run 2: Ctrl-C at the resumed agent's trust prompt ─────────────
  log("run 2: relaunch — the resumed agent sits at a trust prompt; Ctrl-C at once");
  app = await launch(2);
  await waitForReturningLaunch(app.bridge);
  const s2 = await firstRestoredTerminal(app.bridge);
  assert(s2 === s1, "the restored session keeps its id");
  // Run 1's scrollback never showed a trust prompt; this one is run 2's.
  await app.bridge.waitForTerminal(s2, /Do you trust the files in this folder\?/, { timeoutMs: 45_000 });
  await pressCtrlC(app.bridge, s2);
  const all2 = await waitForRecords(2);
  const resumed = await waitForExit(all2[1].file);
  log(`  fake saw argv ${JSON.stringify(resumed.argv)}; it ended ${JSON.stringify(resumed.exit)}`);
  const resumeAt = resumed.argv.indexOf("--resume");
  assert(resumeAt >= 0 && resumed.argv[resumeAt + 1] === vendorId, `the restored session resumed conversation ${vendorId}`);
  assert(/at-trust-prompt$/.test(resumed.exit.why) && resumed.exit.code === 1, `the vendor was interrupted at its trust prompt and exited 1 (${resumed.exit.why})`);
  assert(
    resumed.exit.t < RESUME_WINDOW_MS,
    `the interrupt came ${resumed.exit.t} ms after the agent started, inside the ${RESUME_WINDOW_MS} ms in which an early exit used to replace the conversation`,
  );
  const endedIn = await waitForStartup(app.bridge, s2, "ended", { timeoutMs: 15_000 });
  log(`  the session ended ${endedIn} ms after the check started`);
  // Give a fallback every chance to show up before looking.
  await sleep(RESUME_WINDOW_MS);
  const after2 = records();
  for (const r of after2.slice(2)) log(`  UNEXPECTED launch: ${JSON.stringify(r.argv)}`);
  assert(after2.length === 2, "no second agent started: the interrupt did not start a new conversation");
  const lines2 = await app.bridge.readTerminal(s2);
  assert(!lines2.some((l) => l.includes("hermes: could not resume")), "no \"could not resume\" line");
  const d2 = await sessionData(app.bridge, s2);
  assert(d2.vendor_session_id === vendorId, `the session still holds conversation ${vendorId} (holds ${d2.vendor_session_id})`);
  assert(d2.agent_startup.confidence === "exact", "the end came from the helper's exit report");
  assert((await startupTags(app.bridge)).length === 0, "no session is reported as waiting at a startup prompt");
  for (const l of lines2.slice(-6)) log(`    | ${l}`);
  await app.bridge.screenshot(join(evidenceDir, "02-interrupted-at-trust-prompt.png"));
  // What the next launch resumes is what the workspace saves (every 10 s
  // once something changed): it must still be the same conversation.
  await waitForSavedVendorId(app.bridge, s2, vendorId);
  assert((await savedVendorId(app.bridge, s2)) === vendorId, `the saved workspace holds conversation ${vendorId}`);
  setFakeMode("resume-fails trust-prompt");
  await quit(app);

  // ── run 3: a real fallback whose fresh agent never starts ─────────
  log("run 3: relaunch — the vendor rejects the conversation; the fresh agent hi falls back to is interrupted at its trust prompt");
  app = await launch(3);
  await waitForReturningLaunch(app.bridge);
  const s3 = await firstRestoredTerminal(app.bridge);
  assert(s3 === s1, "the restored session keeps its id");
  const all3 = await waitForRecords(4, { timeoutMs: 45_000 });
  const rejected = await waitForExit(all3[2].file);
  log(`  fake saw argv ${JSON.stringify(rejected.argv)}; it ended ${JSON.stringify(rejected.exit)}`);
  const rejectedAt = rejected.argv.indexOf("--resume");
  assert(rejectedAt >= 0 && rejected.argv[rejectedAt + 1] === vendorId && rejected.exit.why === "resume-rejected", `the vendor rejected conversation ${vendorId}`);
  // Only this run falls back (run 2 asserted no such line).
  await app.bridge.waitForTerminal(s3, /hermes: could not resume/, { timeoutMs: 20_000 });
  const freshFile = all3[3].file;
  {
    const deadline = Date.now() + 20_000;
    while (!readRecord(freshFile).events.some((e) => e.ev === "trust-prompt-shown")) {
      if (Date.now() > deadline) throw new Error("the fresh agent never showed its trust prompt");
      await sleep(100);
    }
  }
  await pressCtrlC(app.bridge, s3);
  const fresh = await waitForExit(freshFile);
  log(`  fake saw argv ${JSON.stringify(fresh.argv)}; it ended ${JSON.stringify(fresh.exit)}`);
  const freshAt = fresh.argv.indexOf("--session-id");
  const freshId = freshAt >= 0 ? fresh.argv[freshAt + 1] : null;
  assert(freshId && UUID.test(freshId) && freshId !== vendorId, `hi fell back to a fresh conversation ${freshId}`);
  assert(/at-trust-prompt$/.test(fresh.exit.why) && !fresh.hooksRan.some((h) => h.event === "SessionStart"), `the fresh agent was interrupted at its trust prompt before it started (${fresh.exit.why})`);
  await waitForStartup(app.bridge, s3, "ended", { timeoutMs: 15_000 });
  await sleep(RESUME_WINDOW_MS);
  const after3 = records();
  for (const r of after3.slice(4)) log(`  UNEXPECTED launch: ${JSON.stringify(r.argv)}`);
  assert(after3.length === 4, "no further agent started");
  const d3 = await sessionData(app.bridge, s3);
  assert(d3.vendor_session_id === vendorId, `the session still holds conversation ${vendorId}, not ${freshId} which never started (holds ${d3.vendor_session_id})`);
  for (const l of (await app.bridge.readTerminal(s3)).slice(-6)) log(`    | ${l}`);
  await app.bridge.screenshot(join(evidenceDir, "03-fallback-interrupted.png"));
  // Past the workspace's 10 s save, the saved id must still be the old one.
  await sleep(11_000);
  assert((await savedVendorId(app.bridge, s3)) === vendorId, `the saved workspace holds conversation ${vendorId}`);
  setFakeMode("normal");
  await quit(app);

  // ── run 4: the same conversation again ────────────────────────────
  log("run 4: relaunch — the same conversation is resumed");
  app = await launch(4);
  await waitForReturningLaunch(app.bridge);
  const s6 = await firstRestoredTerminal(app.bridge);
  // Only this run's agent says it resumed (run 1 said "(new)", runs 2 and 3
  // never got that far).
  await app.bridge.waitForTerminal(s6, /\(resumed from /, { timeoutMs: 45_000 });
  const rec6 = (await waitForRecords(5)).at(-1);
  log(`  fake saw argv ${JSON.stringify(rec6.argv)}`);
  const at6 = rec6.argv.indexOf("--resume");
  assert(at6 >= 0 && rec6.argv[at6 + 1] === vendorId, `the next launch resumes conversation ${vendorId} again`);
  await waitForStartup(app.bridge, s6, "started");
  await app.bridge.screenshot(join(evidenceDir, "04-resumed-again.png"));

  log("run 4, second session: past its trust prompt the vendor sends no start signal");
  setFakeMode("trust-prompt no-start-hook");
  const s4 = await createClaudeSession(app.bridge);
  await app.bridge.waitForTerminal(s4, /Do you trust the files in this folder\?/, { timeoutMs: 30_000 });
  await waitForStartup(app.bridge, s4, "waiting_at_startup_prompt", { timeoutMs: 15_000 });
  const tag = await app.bridge.waitFor("the startup-prompt tag", `
    const t = e2e.first(".session-startup-tag");
    return t ? e2e.norm(t.innerText) : null;
  `);
  assert(tag === "waiting at a startup prompt", `the session list says "${tag}"`);
  await app.bridge.screenshot(join(evidenceDir, "05-waiting.png"));
  log("  answering the prompt with y");
  await app.bridge.typeInTerminal(s4, "y");
  await app.bridge.waitForTerminal(s4, /fake-cli: ready/, { timeoutMs: 20_000 });
  const t4 = Date.now();
  await app.bridge.waitFor("the startup-prompt tag to clear", `return !e2e.first(".session-startup-tag");`, { timeoutMs: 5_000 });
  log(`  the tag cleared ${Date.now() - t4} ms after the agent was ready`);
  const d4 = await sessionData(app.bridge, s4);
  assert(d4.agent_startup.state === "launching", `once answered the state is "${d4.agent_startup.state}", not waiting`);
  const rec4 = records().at(-1);
  assert(!rec4.hooksRan.some((h) => h.event === "SessionStart") && rec4.events.some((e) => e.ev === "start-hook-skipped"), "the vendor proceeded without a start signal");
  // Longer than the 5 s the guess waits: it must not come back.
  await sleep(7_000);
  assert((await startupTags(app.bridge)).length === 0, "7 s later the agent is still not reported as waiting");
  assert((await sessionData(app.bridge, s4)).agent_startup.state !== "waiting_at_startup_prompt", "nor in the session data");
  await app.bridge.screenshot(join(evidenceDir, "06-answered-no-start-signal.png"));

  log("run 4, third session: Ctrl-C at the trust prompt ends the report");
  setFakeMode("trust-prompt");
  const s5 = await createClaudeSession(app.bridge);
  await app.bridge.waitForTerminal(s5, /Do you trust the files in this folder\?/, { timeoutMs: 30_000 });
  await waitForStartup(app.bridge, s5, "waiting_at_startup_prompt", { timeoutMs: 15_000 });
  await pressCtrlC(app.bridge, s5);
  await waitForStartup(app.bridge, s5, "ended", { timeoutMs: 15_000 });
  await app.bridge.waitFor("the startup-prompt tag to clear after the exit", `return !e2e.first(".session-startup-tag");`, { timeoutMs: 5_000 });
  const rec5 = await waitForExit(records().at(-1).file);
  assert(rec5.exit.code === 130 && /at-trust-prompt$/.test(rec5.exit.why), `the vendor exited at the prompt (${rec5.exit.code}, ${rec5.exit.why})`);
  assert((await startupTags(app.bridge)).length === 0, "after the exit no session is reported as waiting");
  await app.bridge.screenshot(join(evidenceDir, "07-interrupted-ended.png"));
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      const dump = await app.bridge.eval(`
        return {
          sessions: e2e.all(".session-item").map((el) => ({ text: e2e.norm(el.innerText).slice(0, 80), startup: el.getAttribute("data-startup") })),
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
  try {
    cpSync(recordDir, join(evidenceDir, "fake-launch-records"), { recursive: true });
  } catch {
    /* best effort */
  }
  rmSync(work, { recursive: true, force: true });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
