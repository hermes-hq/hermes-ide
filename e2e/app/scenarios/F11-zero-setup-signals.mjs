#!/usr/bin/env node
// Scenario F11: zero-setup signals and the status strip.
//
// A fake `claude` (tools/fake-agents/fake-cli.mjs) stands in for the real
// CLI: it takes the per-launch `--settings` file Hermes writes, runs the
// hooks in it exactly as Claude Code does (exec form, matchers, JSON on
// stdin) and, on a key, does what a real agent does: asks permission, asks
// a question, finishes a turn, fails, starts sub-agents, prints a terminal
// notification, prints the in-band Hermes marker.
//
//   run 0  fresh install, flag OFF: a Claude session shows no status strip
//          (the negative control that the flag gates it). Turn the
//          `launchHelper` and `agentCatalog` flags on in Settings > Flags.
//   run 1  flag ON:
//          - the strip says "idle · hook, exact" once the agent started;
//          - a permission request shows "needs approval · hook, exact"
//            within one second of the agent asking, with the tool as detail;
//          - an ordinary tool does not fire the narrowed PreToolUse hook;
//          - question, plan, turn end, failure, prompt: each its own status;
//          - a denied permission puts the strip back to working (exact);
//          - two sub-agents started, one stopped: the counter says so;
//          - an OSC 9 notification printed by the agent (no hook) raises
//            "needs approval · notification, signal" — never exact;
//          - the Hermes marker with a forged nonce is attention only, the
//            one with this launch's nonce is exact;
//          - every hook printed nothing and exited 0 (Hermes never answers);
//          - `q`: the session is exited, exactly;
//          - switching the strip off in Settings removes it and leaves the
//            terminal's content untouched; a second session with the strip
//            off gets the same hooks and shows the same output as the first;
//          - a Custom agent (the fake terminal agent, no hooks) shows a
//            dimmed "guessed" strip, then "signal" from its notification;
//          - ~/.claude/settings.json (a seeded user file) is byte-identical
//            before and after, and nothing appeared under ~/.claude.
//
// Negative controls (each must end in RESULT: FAIL):
//   HERMES_E2E_F11_EXPECT_OSC_CONFIDENCE=exact   the notification check is real
//   HERMES_E2E_F11_EXPECT_HOOK_STDOUT=anything   the "hooks print nothing" check
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F11-zero-setup-signals.mjs
//
// Evidence (log, screenshots, the fake's launch records) goes to
// HERMES_E2E_EVIDENCE, or <out dir>/evidence/F11-zero-setup-signals.

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { REPO_ROOT, createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";

const SCENARIO = "F11-zero-setup-signals";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);
const onWindows = platform() === "win32";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** What a printed notification may be marked as. "exact" makes the check fail (negative control). */
const EXPECT_OSC_CONFIDENCE = process.env.HERMES_E2E_F11_EXPECT_OSC_CONFIDENCE || "signal";
/** What every hook must have printed. Anything but "" makes the check fail (negative control). */
const EXPECT_HOOK_STDOUT = process.env.HERMES_E2E_F11_EXPECT_HOOK_STDOUT ?? "";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

// ─── A fake `claude` on PATH, a record folder, a home that survives relaunches ──

const work = mkdtempSync(join(tmpdir(), "hermes-e2e-f11-"));
const fakeBin = join(work, "bin");
const recordDir = join(work, "records");
const privateHome = join(work, "home");
mkdirSync(fakeBin, { recursive: true });
mkdirSync(recordDir, { recursive: true });
mkdirSync(privateHome, { recursive: true });
const FAKE_CLI = join(REPO_ROOT, "tools", "fake-agents", "fake-cli.mjs");
const FAKE_AGENT = join(REPO_ROOT, "tools", "fake-agents", "fake-agent.mjs");
if (onWindows) {
  writeFileSync(join(fakeBin, "claude.cmd"), `@"${process.execPath}" "${FAKE_CLI}" %*\r\n`);
} else {
  writeFileSync(join(fakeBin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`);
  chmodSync(join(fakeBin, "claude"), 0o755);
}
const hasRealClaude = (dir) => ["claude", "claude.exe", "claude.cmd"].some((n) => existsSync(join(dir, n)));
process.env.PATH = [fakeBin, ...(process.env.PATH || "").split(delimiter).filter((d) => d && !hasRealClaude(d))].join(delimiter);
for (const name of Object.keys(process.env)) if (name.startsWith("ANTHROPIC_")) delete process.env[name];

// Windows terminals rebuild PATH from the registry (see N12); the fake goes
// on the user's registry Path, only on a throwaway CI runner.
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

/** The fake's launch records, oldest first. */
const records = () =>
  readdirSync(recordDir)
    .filter((f) => f.startsWith("launch-"))
    .sort()
    .map((f) => ({ file: f, ...JSON.parse(readFileSync(join(recordDir, f), "utf8")) }));
async function waitForRecords(count, { timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const all = records();
    if (all.length >= count) return all;
    if (Date.now() > deadline) throw new Error(`expected ${count} fake launch records, have ${all.length}`);
    await sleep(200);
  }
}

// The vendor's own config: a seeded user settings file that must survive
// byte for byte, and a folder nothing may appear in. On Windows the real
// home is used (app data lives under %APPDATA%), so the seed goes there only
// when there is no real file to protect.
const homeForVendor = onWindows ? homedir() : privateHome;
const userSettingsFile = join(homeForVendor, ".claude", "settings.json");
const SEED = JSON.stringify(
  { model: "fake-model", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo user-hook" }] }] }, permissions: { allow: ["Bash(ls:*)"] } },
  null,
  2,
) + "\n";
let seeded = false;
if (!existsSync(userSettingsFile)) {
  mkdirSync(join(homeForVendor, ".claude"), { recursive: true });
  writeFileSync(userSettingsFile, SEED);
  seeded = true;
}
const settingsBytesBefore = readFileSync(userSettingsFile);
function vendorSnapshot() {
  const dir = join(homeForVendor, ".claude");
  const walk = (d) =>
    readdirSync(d)
      .sort()
      .flatMap((name) => {
        const p = join(d, name);
        const st = statSync(p);
        return st.isDirectory() ? walk(p) : [`${p.slice(dir.length)}:${st.size}`];
      });
  return { entries: existsSync(dir) ? walk(dir) : [], claudeJson: existsSync(join(homeForVendor, ".claude.json")) };
}
const vendorBefore = vendorSnapshot();

function launch(run, { first = false } = {}) {
  const runDir = join(evidenceDir, `run-${run}`);
  const common = { runDir, log, env: { HERMES_FAKE_DIR: recordDir } };
  return onWindows ? launchApp({ ...common, home: "real", resetData: first }) : launchApp({ ...common, home: "private", homeDir: privateHome });
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

async function openSettings(bridge) {
  await bridge.clickByName("Settings");
  await bridge.waitFor("the Settings dialog", `return !!e2e.first('[role="dialog"] .settings-title');`);
}
async function closeSettings(bridge) {
  await bridge.click(".settings-close");
  await bridge.waitFor("the Settings dialog to close", `return !e2e.first(".settings-title");`);
}

/** Settings > (7 clicks on the title) > Flags: force flags on. */
async function setFlagOverrides(bridge, values) {
  await openSettings(bridge);
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
  for (const [id, value] of Object.entries(values)) {
    await bridge.waitFor(`the ${id} flag control`, `return !!e2e.first('select.settings-select[data-flag-id="${id}"]');`);
    await bridge.eval(`
      const sel = e2e.must(e2e.first('select.settings-select[data-flag-id="${id}"]'), "${id} select");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
      setter.call(sel, ${JSON.stringify(value)});
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return sel.value;
    `);
    await bridge.waitFor(`the ${id} override to be saved`, `
      const raw = await window.__TAURI_INTERNALS__.invoke("get_settings");
      const overrides = raw.feature_flag_overrides ? JSON.parse(raw.feature_flag_overrides) : {};
      return overrides[${JSON.stringify(id)}] === ${value === "on" ? "true" : "false"};
    `);
    log(`  flag ${id} forced ${value} (takes effect on next launch)`);
  }
  await closeSettings(bridge);
}

/** Settings > General: the status-strip checkbox. */
async function setStatusStrip(bridge, on) {
  await openSettings(bridge);
  await bridge.waitFor("the status strip checkbox", `return !!e2e.first('input[data-setting="status_strip"]');`);
  const state = await bridge.eval(`
    const box = e2e.must(e2e.first('input[data-setting="status_strip"]'), "status strip checkbox");
    if (box.checked !== ${on ? "true" : "false"}) e2e.click(box);
    return box.checked;
  `);
  assert(state === on, `the status strip setting is ${on ? "on" : "off"}`);
  await bridge.waitFor("the setting to be saved", `
    const raw = await window.__TAURI_INTERNALS__.invoke("get_settings");
    return (raw.status_strip || "on") === ${JSON.stringify(on ? "on" : "off")};
  `);
  await closeSettings(bridge);
}

/** New Session wizard: a Claude session in a terminal, default folder. */
async function createSession(bridge, { agent = "Claude", custom = null } = {}) {
  const before = await bridge.terminalIds();
  if (await bridge.exists("button.es-tile-primary")) await bridge.click("button.es-tile-primary");
  else await bridge.clickByName("New session");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  if (await bridge.exists('.session-creator-mode-card[data-category="universal"]')) {
    await bridge.click('.session-creator-mode-card[data-category="universal"]');
    await sleep(200);
    if (await bridge.exists(".session-creator-mode-step")) await bridge.click(".session-creator-actions .session-creator-btn-primary");
  }
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`, { timeoutMs: 20_000 });
  if (custom) {
    await bridge.click('.session-creator-provider-card[data-agent-id="custom"]');
    await bridge.waitFor("the custom agent fields", `return !!e2e.first("#session-creator-custom-agent-command");`);
    for (const [selector, value] of [
      ["#session-creator-custom-agent-name", custom.name],
      ["#session-creator-custom-agent-command", custom.command],
    ]) {
      await bridge.eval(`
        const input = e2e.must(e2e.first(${JSON.stringify(selector)}), ${JSON.stringify(selector)});
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return input.value;
      `);
    }
  } else {
    await bridge.clickWhenReady(`
      const card = e2e.all(".session-creator-provider-card").find((c) => c.innerText.trim().startsWith(${JSON.stringify(agent)}));
      return e2e.click(e2e.must(card, "the agent card"));
    `);
    await bridge.eval(`
      const box = e2e.first(".session-creator-agent-view input[type=checkbox]");
      if (box && box.checked) e2e.click(box);
      return true;
    `);
  }
  for (let i = 0; i < 8; i++) {
    if (!(await bridge.exists(".session-creator"))) break;
    await bridge.clickWhenReady(`
      if (!e2e.first(".session-creator")) return null;
      const b = e2e.must(
        e2e.first(".session-creator-actions .session-creator-btn-primary, .session-creator-footer-actions .session-creator-btn-primary"),
        "the wizard's primary button",
      );
      return e2e.click(b);
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

/** The strip of a session as the DOM shows it, or null when there is none. */
const stripOf = (bridge, sessionId) =>
  bridge.eval(`
    const el = e2e.first('.session-status-strip[data-strip-session="${sessionId}"]');
    if (!el) return null;
    return {
      kind: el.dataset.statusKind, confidence: el.dataset.confidence, source: el.dataset.source,
      subagents: Number(el.dataset.subagents), guessed: el.classList.contains("session-status-strip-guessed"),
      word: e2e.norm(el.querySelector(".session-status-strip-word")?.innerText ?? ""),
      sourceText: e2e.norm(el.querySelector(".session-status-strip-source")?.innerText ?? ""),
      detail: e2e.norm(el.querySelector(".session-status-strip-detail")?.innerText ?? ""),
      text: e2e.norm(el.innerText),
    };
  `);
/** Wait until the strip shows `kind` with `confidence`; returns the strip and how long it took. */
async function waitForStrip(bridge, sessionId, { kind, confidence, subagents }, { timeoutMs = 10_000 } = {}) {
  const t0 = Date.now();
  const strip = await bridge.waitFor(`the strip to show ${kind ?? ""} ${confidence ?? ""} ${subagents === undefined ? "" : `${subagents} sub-agents`}`, `
    const el = e2e.first('.session-status-strip[data-strip-session="${sessionId}"]');
    if (!el) return null;
    if (${JSON.stringify(kind ?? null)} !== null && el.dataset.statusKind !== ${JSON.stringify(kind ?? "")}) return null;
    if (${JSON.stringify(confidence ?? null)} !== null && el.dataset.confidence !== ${JSON.stringify(confidence ?? "")}) return null;
    if (${subagents === undefined ? "false" : "true"} && Number(el.dataset.subagents) !== ${subagents ?? 0}) return null;
    return { kind: el.dataset.statusKind, confidence: el.dataset.confidence, source: el.dataset.source, subagents: Number(el.dataset.subagents),
      guessed: el.classList.contains("session-status-strip-guessed"),
      word: e2e.norm(el.querySelector(".session-status-strip-word")?.innerText ?? ""),
      sourceText: e2e.norm(el.querySelector(".session-status-strip-source")?.innerText ?? ""),
      detail: e2e.norm(el.querySelector(".session-status-strip-detail")?.innerText ?? ""),
      text: e2e.norm(el.innerText) };
  `, { timeoutMs, intervalMs: 25 });
  return { strip, ms: Date.now() - t0 };
}
const snapshotOf = (bridge, sessionId) => bridge.eval(`return window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(sessionId)});`);
async function quit(current) {
  const exit = await current.stop();
  log(`  app exited: ${JSON.stringify(exit)}`);
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");
}
/** Terminal rows with the ids only this session has replaced, so two sessions compare. */
async function normalizedRows(bridge, sessionId, vendorId) {
  const rows = (await bridge.readTerminal(sessionId)) ?? [];
  return rows
    .map((r) => r.trimEnd().replaceAll(sessionId, "<sid>").replaceAll(vendorId ?? "<none>", "<vid>"))
    .filter((r) => !/^\s*$/.test(r) && !/\$\s*$|%\s*$|>\s*$/.test(r) && !r.includes("hi run"));
}

/** Drive one fake session through the same keys and collect what the strip said. */
async function driveSession(bridge, sessionId, { expectStrip }) {
  const seen = [];
  const step = async (key, expect, label) => {
    await bridge.typeInTerminal(sessionId, key);
    if (expectStrip) {
      const { strip, ms } = await waitForStrip(bridge, sessionId, expect);
      seen.push({ key, ...strip, ms });
      log(`  ${label}: ${strip.word} · ${strip.sourceText}${strip.detail ? ` (${strip.detail})` : ""} after ${ms} ms`);
      return strip;
    }
    await sleep(400);
    return null;
  };
  await step("?", { kind: "needs_answer", confidence: "exact" }, "question");
  await step("l", { kind: "plan_ready", confidence: "exact" }, "plan ready");
  await step("w", { kind: "working", confidence: "exact" }, "prompt submitted");
  await step("s", { kind: "done_unread", confidence: "exact" }, "turn done");
  await step("e", { kind: "error", confidence: "exact" }, "turn failed");
  return seen;
}

let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   fake claude: ${fakeBin}   seeded user settings: ${seeded}`);
  undoRegistryPath = addFakeBinToRegistryPath();

  // ── run 0: flag off — no strip (negative control), then flags on ──
  log("run 0: fresh install, flag OFF: a Claude session shows no status strip");
  app = await launch(0, { first: true });
  await completeOnboarding(app.bridge);
  const s0 = await createSession(app.bridge);
  await waitForRecords(1);
  await sleep(1500);
  assert((await stripOf(app.bridge, s0)) === null, "with the flag off there is no status strip above the session");
  await app.bridge.screenshot(join(evidenceDir, "00-flag-off-no-strip.png"));
  await app.bridge.click(".session-item .session-item-close");
  await sleep(300);
  if (await app.bridge.exists(".close-dialog")) await app.bridge.click(".close-dialog .close-dialog-btn-confirm");
  await app.bridge.waitFor("the session to close", `return e2e.all(".session-item").length === 0;`);
  await setFlagOverrides(app.bridge, { launchHelper: "on", agentCatalog: "on" });
  await quit(app);

  // ── run 1: flag on — every signal path ────────────────────────────
  log("run 1: flag ON — hooks, notifications, markers, sub-agents, the strip");
  app = await launch(1);
  await waitForReturningLaunch(app.bridge);
  const s1 = await createSession(app.bridge);
  log(`  session created: ${s1}`);
  await app.bridge.waitForTerminal(s1, /fake-cli: ready/, { timeoutMs: 30_000 });
  const rec1 = (await waitForRecords(2)).at(-1);
  const vendorId1 = rec1.argv[rec1.argv.indexOf("--session-id") + 1];
  assert(UUID.test(vendorId1 ?? ""), `the agent got a pre-assigned session id (${vendorId1})`);
  const hooks1 = rec1.settings?.hooks ?? {};
  assert(
    ["SessionStart", "PermissionRequest", "PreToolUse", "Stop", "StopFailure", "SubagentStart", "SubagentStop", "Notification", "SessionEnd"].every((e) => Array.isArray(hooks1[e])),
    `the per-launch settings file hooks every event Hermes reads (${Object.keys(hooks1).sort().join(", ")})`,
  );
  assert(hooks1.PreToolUse[0].matcher === "AskUserQuestion|ExitPlanMode", `PreToolUse is narrowed to the tools Hermes reads ("${hooks1.PreToolUse[0].matcher}")`);
  assert(Object.values(hooks1).every((groups) => groups.every((g) => g.hooks.every((h) => Array.isArray(h.args) && h.args[0] === "signal"))), "every hook is `hi signal` in exec form (no shell)");

  const { strip: started, ms: startedMs } = await waitForStrip(app.bridge, s1, { kind: "idle", confidence: "exact" }, { timeoutMs: 15_000 });
  assert(started.source === "hook" && started.sourceText === "hook, exact" && !started.guessed, `once started the strip says "${started.word} · ${started.sourceText}" (${startedMs} ms after ready)`);
  const snap0 = await snapshotOf(app.bridge, s1);
  assert(snap0.identity.vendorSessionId === vendorId1, "the store knows the agent's conversation id from its SessionStart hook");
  await app.bridge.screenshot(join(evidenceDir, "01-started-idle-exact.png"));

  // Approval: within one second of the agent asking.
  await app.bridge.typeInTerminal(s1, "p");
  const { strip: approval, ms: approvalMs } = await waitForStrip(app.bridge, s1, { kind: "needs_approval", confidence: "exact" });
  assert(approval.source === "hook" && approval.sourceText === "hook, exact", `a permission request shows "${approval.word} · ${approval.sourceText}"`);
  assert(approval.detail === "Bash", `with the tool as detail ("${approval.detail}")`);
  assert(approvalMs <= 1000, `and within one second of the agent asking (${approvalMs} ms, key press included)`);
  await app.bridge.screenshot(join(evidenceDir, "02-needs-approval-hook-exact.png"));
  await app.bridge.typeInTerminal(s1, "y");
  await waitForStrip(app.bridge, s1, { kind: "working", confidence: "exact" });
  log("  allowed: the strip says working again");

  // An ordinary tool never fires the narrowed hook.
  await app.bridge.typeInTerminal(s1, "t");
  await app.bridge.waitForTerminal(s1, /running an ordinary tool/, { timeoutMs: 10_000 });
  await sleep(600);
  const recT = records().at(-1);
  const preToolRuns = recT.hooksRan.filter((h) => h.event === "PreToolUse");
  assert(preToolRuns.some((h) => h.tool === "Bash" && h.results.length === 0), "PreToolUse for an ordinary tool ran no hook (the matcher held)");
  assert((await stripOf(app.bridge, s1)).kind === "working", "and the strip did not change");

  const seen1 = await driveSession(app.bridge, s1, { expectStrip: true });
  assert(seen1.find((s) => s.key === "e")?.detail === "rate_limit", "a failed turn shows the agent's own error as detail");
  assert(seen1.every((s) => s.source === "hook" && s.sourceText === "hook, exact"), "every hook-driven status is hook, exact");

  // A denied permission: the agent's PermissionDenied hook puts the strip
  // back to working instead of leaving it on "needs approval".
  await app.bridge.typeInTerminal(s1, "p");
  await waitForStrip(app.bridge, s1, { kind: "needs_approval", confidence: "exact" });
  await app.bridge.typeInTerminal(s1, "n");
  const { strip: denied, ms: deniedMs } = await waitForStrip(app.bridge, s1, { kind: "working", confidence: "exact" });
  assert(denied.source === "hook", `a denied permission puts the strip back to "${denied.word} · ${denied.sourceText}" (${deniedMs} ms)`);

  // Sub-agents.
  await app.bridge.typeInTerminal(s1, "u");
  await waitForStrip(app.bridge, s1, { subagents: 1 });
  await app.bridge.typeInTerminal(s1, "u");
  const { strip: two } = await waitForStrip(app.bridge, s1, { subagents: 2 });
  assert(two.text.includes("2 sub-agents"), `two sub-agents started: the strip says "2 sub-agents"`);
  await app.bridge.screenshot(join(evidenceDir, "03-two-subagents.png"));
  await app.bridge.typeInTerminal(s1, "d");
  await waitForStrip(app.bridge, s1, { subagents: 1 });
  log("  one stopped: the counter says 1");

  // A vendor notification printed to the terminal: never exact.
  await app.bridge.typeInTerminal(s1, "o");
  const { strip: osc } = await waitForStrip(app.bridge, s1, { kind: "needs_approval", confidence: EXPECT_OSC_CONFIDENCE });
  assert(osc.source === "osc" && osc.sourceText === "notification, signal", `a printed OSC 9 notification raises "${osc.word} · ${osc.sourceText}"`);
  assert(osc.confidence !== "exact", "and is never exact");
  await app.bridge.screenshot(join(evidenceDir, "04-osc-notification-signal.png"));

  // The Hermes marker: forged nonce is attention only; the real one is exact.
  await app.bridge.typeInTerminal(s1, "x");
  await app.bridge.waitFor("the forged marker to be recorded as attention", `
    const snap = window.__HERMES_E2E__.sessionEventSnapshot(${JSON.stringify(s1)});
    return snap.events.some((e) => e.type === "attention" && e.source === "osc" && e.detail.includes("(unverified)")) ? snap.status : null;
  `);
  const afterForged = await stripOf(app.bridge, s1);
  assert(afterForged.kind === "needs_approval" && afterForged.confidence === "signal", "a marker with a forged nonce changes nothing but the attention log (the strip still shows the notification, signal)");
  await app.bridge.typeInTerminal(s1, "m");
  const { strip: markerStrip } = await waitForStrip(app.bridge, s1, { kind: "done_unread", confidence: "exact" });
  assert(markerStrip.source === "hook", `the marker with this launch's nonce is exact ("${markerStrip.word} · ${markerStrip.sourceText}")`);
  const snapM = await snapshotOf(app.bridge, s1);
  assert(snapM.events.some((e) => e.type === "status" && e.source === "hook:claude:osc"), "and its source names the in-band hook path");

  // Every hook printed nothing: Hermes observes, never answers.
  const recH = records().at(-1);
  const allResults = recH.hooksRan.flatMap((h) => h.results);
  assert(allResults.length >= 10, `${allResults.length} hook runs so far`);
  assert(allResults.every((r) => r.code === 0), "every hook exited 0");
  assert(allResults.every((r) => r.stdout === EXPECT_HOOK_STDOUT), `every hook printed ${JSON.stringify(EXPECT_HOOK_STDOUT)}: no decision ever reaches the agent`);
  assert(allResults.every((r) => r.exec === true), "every hook ran in exec form (no shell)");
  const slowest = Math.max(...allResults.map((r) => r.ms ?? 0));
  assert(slowest < 2000, `the slowest hook took ${slowest} ms`);

  // The strip off: gone from the DOM, the terminal untouched.
  const rowsBefore = await normalizedRows(app.bridge, s1, vendorId1);
  await setStatusStrip(app.bridge, false);
  await app.bridge.waitFor("the strip to disappear", `return !e2e.first('.session-status-strip[data-strip-session="${s1}"]');`);
  const rowsAfter = await normalizedRows(app.bridge, s1, vendorId1);
  assert(JSON.stringify(rowsAfter) === JSON.stringify(rowsBefore), `switching the strip off leaves the terminal's content untouched (${rowsAfter.length} rows)`);
  await app.bridge.screenshot(join(evidenceDir, "05-strip-off.png"));

  // A second session with the strip off: same hooks, same output.
  const s2 = await createSession(app.bridge);
  await app.bridge.waitForTerminal(s2, /fake-cli: ready/, { timeoutMs: 30_000 });
  const rec2 = (await waitForRecords(3)).at(-1);
  const vendorId2 = rec2.argv[rec2.argv.indexOf("--session-id") + 1];
  assert((await stripOf(app.bridge, s2)) === null, "with the strip off a new session has none");
  await app.bridge.typeInTerminal(s2, "p");
  await app.bridge.waitForTerminal(s2, /asking permission/, { timeoutMs: 10_000 });
  await sleep(300);
  await app.bridge.typeInTerminal(s2, "y");
  await app.bridge.waitForTerminal(s2, /fake-cli: allowed/, { timeoutMs: 10_000 });
  await app.bridge.typeInTerminal(s2, "t");
  await app.bridge.waitForTerminal(s2, /running an ordinary tool/, { timeoutMs: 10_000 });
  await driveSession(app.bridge, s2, { expectStrip: false });
  await app.bridge.waitForTerminal(s2, /turn failed/, { timeoutMs: 10_000 });
  await sleep(800);
  const snap2 = await snapshotOf(app.bridge, s2);
  assert(snap2.status.kind === "error" && snap2.status.confidence === "exact", "the signals still arrive with the strip off (the store says error, exact)");
  const recA = records().find((r) => r.env?.HERMES_SESSION_ID === s1);
  const recB = records().find((r) => r.env?.HERMES_SESSION_ID === s2);
  const eventsA = recA.hooksRan.map((h) => `${h.event}:${h.tool ?? ""}:${h.results.length}`);
  const eventsB = recB.hooksRan.map((h) => `${h.event}:${h.tool ?? ""}:${h.results.length}`);
  const upToFailure = (list) => list.slice(0, list.indexOf("StopFailure::1") + 1);
  assert(JSON.stringify(upToFailure(eventsA)) === JSON.stringify(upToFailure(eventsB)), `both sessions ran the same hooks in the same order (${upToFailure(eventsB).length})`);
  const outA = (await normalizedRows(app.bridge, s1, vendorId1)).filter((r) => !/sub-agent|OSC 9|marker/.test(r));
  const outB = await normalizedRows(app.bridge, s2, vendorId2);
  // The agent's own output: from its banner to the failed turn. The rows
  // before it are the shell's (a login banner, the prompt with the command
  // wrapped wherever the runner's hostname makes it wrap) and differ per
  // session. On Windows the pseudo console keeps only what is on screen, so
  // the first session's banner may have scrolled away: compare the rows both
  // sessions still hold; the permission prompt through the failed turn (8
  // rows) is the least that must match.
  const cut = (rows) => {
    const end = rows.findIndex((r) => r.includes("turn failed"));
    const start = rows.findIndex((r) => r.includes("fake-cli"));
    return rows.slice(Math.max(start, 0), end + 1);
  };
  const sameA = cut(outA);
  const sameB = cut(outB);
  const n = Math.min(sameA.length, sameB.length);
  assert(n >= 8, `both sessions still show the permission prompt through the failed turn (${n} rows)`);
  if (JSON.stringify(sameA.slice(-n)) !== JSON.stringify(sameB.slice(-n))) {
    log(`  strip on : ${JSON.stringify(sameA.slice(-n))}`);
    log(`  strip off: ${JSON.stringify(sameB.slice(-n))}`);
  }
  assert(JSON.stringify(sameA.slice(-n)) === JSON.stringify(sameB.slice(-n)), `the agent's output is the same with the strip on or off (${n} rows)`);
  await app.bridge.screenshot(join(evidenceDir, "06-second-session-strip-off.png"));
  await setStatusStrip(app.bridge, true);
  await waitForStrip(app.bridge, s2, { kind: "error", confidence: "exact" });
  log("  strip back on: it shows the state the store already had");

  // Exit: exact. The first session's pane is behind the second one's; bring
  // it back (the session list shows two, the active one is the second).
  await app.bridge.clickWhenReady(`
    const wrappers = e2e.all(".session-item-wrapper");
    const inactive = wrappers.find((w) => !w.classList.contains("session-item-wrapper-active"));
    return e2e.click(e2e.must(inactive?.querySelector(".session-item"), "the first session's item"));
  `);
  await app.bridge.waitFor("the first session's terminal to show", `return !!document.querySelector('div[data-session-id="${s1}"] textarea.xterm-helper-textarea');`);
  await app.bridge.typeInTerminal(s1, "q");
  const { strip: exited } = await waitForStrip(app.bridge, s1, { kind: "exited", confidence: "exact" }, { timeoutMs: 15_000 });
  assert(exited.word === "exited", `after q the strip says "${exited.word}" (exact)`);
  const recQ = records().find((r) => r.env?.HERMES_SESSION_ID === s1);
  assert(recQ.hooksRan.some((h) => h.event === "SessionEnd"), "the agent ran its SessionEnd hook on the way out");

  // A Custom agent without hooks: guessed, then a signal from its notification.
  log("run 1, custom agent: no hooks, so a dimmed guess, then a notification");
  // A fake terminal agent that works quietly for a while (no signal at all),
  // then asks for approval with a notification, then finishes with one that
  // arrives split across writes.
  const agentScenario = join(work, "f11-agent.json");
  writeFileSync(
    agentScenario,
    JSON.stringify({
      name: "f11-custom",
      steps: [
        { do: "print", text: "fake-agent: working quietly\n" },
        { do: "sleep", ms: 4000 },
        { do: "box", lines: ["Allow Bash: rm -rf node_modules ?", "[y] yes   [n] no"] },
        { do: "osc9", text: "Approval requested: rm -rf node_modules" },
        { do: "waitKey", expect: ["y", "n"], timeoutMs: 60000 },
        { do: "print", text: "fake-agent: task done\n" },
        { do: "split", parts: ["1b5d393b41", "67656e74207475726e20636f6d706c657465", "07"], gapMs: 20 },
        { do: "exit", code: 0 },
      ],
    }),
  );
  const command = `${process.execPath} ${FAKE_AGENT} --scenario ${agentScenario}`;
  if ([process.execPath, FAKE_AGENT, agentScenario].some((p) => /\s/.test(p))) throw new Error(`the fake agent command would need quoting: ${command}`);
  const s3 = await createSession(app.bridge, { custom: { name: "Fake Agent", command } });
  await app.bridge.waitForTerminal(s3, /working quietly/, { timeoutMs: 30_000 });
  const guessed = await stripOf(app.bridge, s3);
  assert(guessed && guessed.guessed && guessed.sourceText === "guessed", `an agent with no signals shows "${guessed?.word} · ${guessed?.sourceText}", dimmed`);
  await app.bridge.screenshot(join(evidenceDir, "07a-custom-agent-guessed.png"));
  await app.bridge.waitForTerminal(s3, /Allow Bash: rm -rf node_modules/, { timeoutMs: 30_000 });
  const { strip: fromOsc } = await waitForStrip(app.bridge, s3, { kind: "needs_approval", confidence: "signal" });
  assert(fromOsc.source === "osc" && !fromOsc.guessed, `its OSC notification raises "${fromOsc.word} · ${fromOsc.sourceText}"`);
  await app.bridge.screenshot(join(evidenceDir, "07-custom-agent-guessed-then-signal.png"));
  await app.bridge.typeInTerminal(s3, "y");
  await app.bridge.waitForTerminal(s3, /fake-agent: task done/, { timeoutMs: 15_000 });
  const { strip: turnDone } = await waitForStrip(app.bridge, s3, { kind: "done_unread", confidence: "signal" });
  assert(turnDone.source === "osc", `its "Agent turn complete" notification (split across writes) says "${turnDone.word} · ${turnDone.sourceText}"`);

  await quit(app);
  const settingsBytesAfter = readFileSync(userSettingsFile);
  assert(Buffer.compare(settingsBytesBefore, settingsBytesAfter) === 0, `~/.claude/settings.json is byte-identical before and after (${settingsBytesAfter.length} bytes)`);
  assert(JSON.stringify(vendorSnapshot()) === JSON.stringify(vendorBefore), "nothing appeared or changed under ~/.claude and no ~/.claude.json was written");
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      const dump = await app.bridge.eval(`
        return {
          strips: e2e.all(".session-status-strip").map((el) => ({ sid: el.dataset.stripSession, kind: el.dataset.statusKind, confidence: el.dataset.confidence, source: el.dataset.source, text: e2e.norm(el.innerText) })),
          terminals: window.__HERMES_E2E__.terminalIds().map((id) => ({ id, tail: (window.__HERMES_E2E__.readTerminal(id) || []).slice(-12), snapshot: window.__HERMES_E2E__.sessionEventSnapshot(id).events.slice(-8) })),
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
  if (seeded && onWindows) rmSync(userSettingsFile, { force: true });
  try {
    cpSync(recordDir, join(evidenceDir, "fake-launch-records"), { recursive: true });
  } catch {
    /* best effort */
  }
  rmSync(work, { recursive: true, force: true });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
