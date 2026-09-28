#!/usr/bin/env node
// Scenario F10 + F19: one status vocabulary, one event contract.
//
// Every session shows ONE status, derived from the SessionEvents its
// provider reports, as a glyph and a word (never colour alone), dimmed with
// the word "guessed" when Hermes only guessed it.
//
//   run 1  flag OFF (fresh install): an Agent-view session with a replayed
//          agent (tools/fake-agents/replay-stdio.mjs + the F13 cassette) asks
//          for approval; the session list shows the old phase tag and no
//          status tag. This is the negative control for the flag and records
//          what people saw before (a phase word, not "needs approval").
//          The `launchHelper` flag, which carries the status, is turned on
//          in Settings > Flags.
//   run 2  flag ON, same data:
//     A  a new Agent-view session asks for approval: its row and the status
//        strip say "! needs approval" (exact), the tooltip names the command.
//        Negative controls: a terminal guess that the agent is idle, and a
//        malformed event, both pushed through the Rust channel, change
//        nothing. Approving ends the turn: done (or idle when the window is
//        focused on it).
//     B  a plain terminal session (TerminalProvider, every agent): idle,
//        guessed, dimmed; the fake terminal agent (tools/fake-agents/
//        fake-agent.mjs) works after its approval box is answered: the row
//        says "working · guessed"; back to idle afterwards.
//     C  every status in the vocabulary, pushed through the Rust side of the
//        session-event channel (what the hook signals of F11 use), shows on
//        the background session's row with its own glyph and its own word;
//        a guessed one is dimmed and says so; a finished turn reads "done"
//        until the session is chosen, then "idle"; an exit words its code.
//     D  the attention summary lists the session that needs a person.
//
// Negative control on demand (must end in RESULT: FAIL):
//   HERMES_E2E_F10_EXPECT="ready"   expects the old word on the approval row.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F10-agent-status.mjs
//
// Evidence (log, screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/F10-agent-status.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";
import { PROBE_OUTPUT, classifyProbe, commandLine, probeCommand } from "../shells.mjs";

const SCENARIO = "F10-agent-status";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);
const onWindows = platform() === "win32";

const REPLAY = join(REPO_ROOT, "tools", "fake-agents", "replay-stdio.mjs");
const CASSETTE = join(REPO_ROOT, "e2e", "app", "fixtures", "F13-bash-approval.jsonl");
const FAKE_AGENT = join(REPO_ROOT, "tools", "fake-agents", "fake-agent.mjs");
/** The word the approval row must show. Override to prove the check can fail. */
const EXPECT_APPROVAL_WORD = process.env.HERMES_E2E_F10_EXPECT || "needs approval";

const KINDS = [
  "needs_approval",
  "needs_answer",
  "gate",
  "check_failed",
  "error",
  "limited",
  "plan_ready",
  "done_unread",
  "working",
  "startup_prompt",
  "starting",
  "idle",
  "exited",
];

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

// A home that survives the relaunch (macOS, Linux). Windows keeps app data
// under %APPDATA%, so there the harness uses the real home and keeps the
// test app's own data folder between the two launches.
const work = mkdtempSync(join(tmpdir(), "hermes-e2e-f10-"));
const privateHome = join(work, "home");
mkdirSync(privateHome, { recursive: true });
const appEnv = { HERMES_BRIDGE_PATH: REPLAY, HERMES_FAKE_CASSETTE: CASSETTE, HERMES_FAKE_SPEED: "0" };
function launch(run, { first = false } = {}) {
  const common = { runDir: join(evidenceDir, `run-${run}`), log, env: appEnv };
  return onWindows
    ? launchApp({ ...common, home: "real", resetData: first })
    : launchApp({ ...common, home: "private", homeDir: privateHome });
}

// ── UI steps ──────────────────────────────────────────────────────────

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

const listedSessionIds = (bridge) => bridge.eval(`return e2e.all(".session-item").map((el) => el.getAttribute("data-session-item-id"));`);

async function openWizard(bridge) {
  if (await bridge.exists("button.es-tile-primary")) await bridge.click("button.es-tile-primary");
  else await bridge.clickByName("New session");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`);
}

async function finishWizard(bridge) {
  for (let i = 0; i < 6; i++) {
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
}

/** An Agent-view session in a fresh project folder; returns its id. */
async function createAgentViewSession(bridge, projectDir) {
  mkdirSync(projectDir, { recursive: true });
  const before = await listedSessionIds(bridge);
  await openWizard(bridge);
  await bridge.clickWhenReady(`
    const claude = e2e.all(".session-creator-provider-card").find((c) => c.innerText.trim().startsWith("Claude"));
    return e2e.click(e2e.must(claude, "the Claude card"));
  `);
  const box = `e2e.first(".session-creator-agent-view input[type=checkbox]")`;
  await bridge.waitFor("the Agent view option", `return !!${box};`);
  if (!(await bridge.eval(`return ${box}.checked;`))) await bridge.clickWhenReady(`return e2e.click(e2e.must(${box}, "the Agent view checkbox"));`);
  await bridge.waitFor("the Agent view to be chosen", `return ${box}?.checked === true;`);
  await bridge.click(".session-creator-actions .session-creator-btn-primary");
  await bridge.waitFor("the folder step", `return !!e2e.first(".workspace-scan-input");`);
  await bridge.eval(`
    const input = e2e.must(e2e.first(".workspace-scan-input"), "folder path input");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    input.focus();
    setter.call(input, ${JSON.stringify(projectDir)});
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    return true;
  `);
  await bridge.clickWhenReady(`
    const scan = e2e.all(".workspace-scan-btn").find((b) => !b.disabled && /scan/i.test(e2e.nameOf(b)));
    return e2e.click(e2e.must(scan, "the Scan button"));
  `);
  const folderName = projectDir.split(/[\\/]/).pop();
  await bridge.waitFor("the project folder to be attached", `
    return e2e.all(".project-picker-item-attached").some((el) => el.innerText.includes(${JSON.stringify(folderName)}));
  `);
  await finishWizard(bridge);
  await bridge.waitFor("the Agent view", `return !!e2e.first(".agent-session-view");`, { timeoutMs: 20_000 });
  return bridge.waitFor("the new session in the list", `
    const ids = e2e.all(".session-item").map((el) => el.getAttribute("data-session-item-id"));
    const fresh = ids.filter((id) => !${JSON.stringify(before)}.includes(id));
    return fresh.length === 1 ? fresh[0] : null;
  `);
}

/** Send one message from the Agent view composer; the replayed agent then asks for approval. */
async function askForApproval(bridge) {
  if (!(await bridge.exists(".session-composer-input"))) await bridge.click(".session-composer-fab");
  await bridge.waitFor("the composer", `return !!e2e.first(".session-composer-input");`);
  await bridge.click(".session-composer-input");
  // One key at a time into whatever has focus, like a keyboard (as in F13).
  await bridge.eval(`
    for (const ch of "please clean the build folder\\n") {
      const el = document.activeElement || document.body;
      const isEnter = ch === "\\n";
      const init = { key: isEnter ? "Enter" : ch, code: isEnter ? "Enter" : "", bubbles: true, cancelable: true, composed: true, view: window };
      const down = new KeyboardEvent("keydown", init);
      Object.defineProperty(down, "keyCode", { get: () => (isEnter ? 13 : ch.toUpperCase().charCodeAt(0)) });
      if (el.dispatchEvent(down) && el instanceof HTMLTextAreaElement && !isEnter) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set;
        const start = el.selectionStart ?? el.value.length;
        setter.call(el, el.value.slice(0, start) + ch + el.value.slice(el.selectionEnd ?? start));
        el.setSelectionRange(start + 1, start + 1);
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
      }
      el.dispatchEvent(new KeyboardEvent("keyup", init));
      await new Promise((r) => setTimeout(r, 10));
    }
    return true;
  `, { timeoutMs: 20_000 });
  await bridge.waitFor("the approval prompt", `return !!e2e.first(".perm-modal");`, { timeoutMs: 30_000 });
}

async function createPlainTerminal(bridge) {
  const before = await bridge.terminalIds();
  await openWizard(bridge);
  // "Plain shell" is always the last card.
  await bridge.clickWhenReady(`
    const cards = e2e.all(".session-creator-provider-card");
    return e2e.click(e2e.must(cards[cards.length - 1], "plain shell card"));
  `);
  await finishWizard(bridge);
  return bridge.waitFor("a terminal to appear", `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
    return ids.length === 1 ? ids[0] : null;
  `, { timeoutMs: 20_000 });
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

// ── Reading a row's status ────────────────────────────────────────────

const ROW = (id) => `.session-item[data-session-item-id=${JSON.stringify(id)}]`;

/** What a session's row shows: the status tag's parts, or the old phase tag. */
function readRow(bridge, id) {
  return bridge.eval(`
    const row = e2e.first(${JSON.stringify(ROW(id))});
    if (!row) return null;
    const tag = row.querySelector(".agent-status-tag");
    const phase = row.querySelector(".session-phase-tag");
    if (!tag) return { tag: null, phase: phase ? e2e.norm(phase.innerText) : null };
    return {
      tag: {
        status: tag.getAttribute("data-status"),
        confidence: tag.getAttribute("data-confidence"),
        glyph: tag.querySelector(".agent-status-glyph")?.textContent ?? "",
        word: e2e.norm(tag.querySelector(".agent-status-word")?.innerText ?? ""),
        guessed: tag.querySelector(".agent-status-guessed") ? e2e.norm(tag.querySelector(".agent-status-guessed").innerText) : null,
        title: tag.getAttribute("title") ?? "",
        opacity: Number(getComputedStyle(tag).opacity),
      },
      phase: phase ? e2e.norm(phase.innerText) : null,
    };
  `);
}

function waitForRowStatus(bridge, id, kinds, what, { timeoutMs = 15_000 } = {}) {
  const want = Array.isArray(kinds) ? kinds : [kinds];
  return bridge.waitFor(what, `
    const tag = e2e.first(${JSON.stringify(ROW(id) + " .agent-status-tag")});
    return tag && ${JSON.stringify(want)}.includes(tag.getAttribute("data-status")) ? tag.getAttribute("data-status") : null;
  `, { timeoutMs });
}

/** Push one SessionEvent through the Rust side of the channel (test build only). */
function emitFromRust(bridge, sessionId, event) {
  return bridge.eval(`
    const event = ${JSON.stringify(event)};
    if (event.at === "now") event.at = Date.now();
    try {
      await window.__TAURI_INTERNALS__.invoke("emit_session_event_for_test", { sessionId: ${JSON.stringify(sessionId)}, event });
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  `);
}

// ── Scenario ──────────────────────────────────────────────────────────

let app;
let failed = false;
try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}`);
  assert(existsSync(REPLAY) && existsSync(CASSETTE) && existsSync(FAKE_AGENT), "the fake agents and the approval cassette exist");

  // ── run 1: flag off ─────────────────────────────────────────────────
  log("run 1: fresh install, flag OFF — an agent waiting on approval, as people saw it before");
  app = await launch(1, { first: true });
  await completeOnboarding(app.bridge);
  const oldId = await createAgentViewSession(app.bridge, join(work, "f10-project-1"));
  await askForApproval(app.bridge);
  const oldRow = await readRow(app.bridge, oldId);
  log(`  the session list row while the agent waits on approval: ${JSON.stringify(oldRow)}`);
  assert(oldRow && oldRow.tag === null, "with the flag off there is no status tag (the flag gates it)");
  assert(!(await app.bridge.exists(".agent-status-tag")), "no status tag anywhere, the status strip included");
  assert(oldRow.phase !== "needs approval", `the old row does not say "needs approval" (it says "${oldRow.phase}")`);
  await app.bridge.screenshot(join(evidenceDir, "00-flag-off-old-phase-tag.png"));
  log("  turning the launchHelper flag on (it carries the session status; takes effect on next launch)");
  await setLaunchHelperOverride(app.bridge, "on");
  let exit = await app.stop({ keepFiles: false });
  assert(!exit.forced && exit.code === 0, "the app quit cleanly");

  // ── run 2: flag on ──────────────────────────────────────────────────
  log("run 2: flag ON");
  app = await launch(2);
  const { bridge } = app;
  await bridge.waitFor("the app UI to be ready (no onboarding this time)", `return !!e2e.first(".topbar-title, .topbar") && !e2e.first(".onboarding-backdrop");`);
  await dismissWhatsNew(bridge);
  await bridge.waitFor("the status hooks", `return typeof window.__HERMES_E2E__?.sessionStatus === "function";`);

  // A — Agent view: waiting on approval
  log("A: an Agent-view session waiting on approval says so, exactly");
  const agentId = await createAgentViewSession(bridge, join(work, "f10-project-2"));
  log(`  agent session: ${agentId}`);
  await askForApproval(bridge);
  await waitForRowStatus(bridge, agentId, "needs_approval", "the row to say needs approval");
  const approval = await readRow(bridge, agentId);
  log(`  row: ${JSON.stringify(approval)}`);
  assert(approval.tag.word === EXPECT_APPROVAL_WORD, `the row says "${approval.tag.word}" (expected "${EXPECT_APPROVAL_WORD}"), not "ready"`);
  assert(approval.tag.glyph === "!", `with its glyph "${approval.tag.glyph}" next to the word (not colour alone)`);
  assert(approval.tag.confidence === "exact" && approval.tag.guessed === null && approval.tag.opacity === 1, "exact: not dimmed, no 'guessed'");
  assert(/Bash: rm -rf build/.test(approval.tag.title), `the tooltip names the command (${JSON.stringify(approval.tag.title)})`);
  assert(approval.phase === null, "the old phase tag is gone");
  const strip = await bridge.eval(`
    const tag = e2e.first(".status-bar .agent-status-tag");
    return tag ? { status: tag.getAttribute("data-status"), word: e2e.norm(tag.querySelector(".agent-status-word").innerText) } : null;
  `);
  assert(strip?.status === "needs_approval" && strip.word === "needs approval", `the status strip agrees (${JSON.stringify(strip)})`);
  const derived = await bridge.eval(`return window.__HERMES_E2E__.sessionStatus(${JSON.stringify(agentId)});`);
  assert(derived.source === "agent-view" && derived.confidence === "exact", `it came from the Agent view provider through the event store (${JSON.stringify(derived)})`);
  await bridge.screenshot(join(evidenceDir, "01-needs-approval.png"));

  log("A: negative controls — a terminal guess and a malformed event change nothing");
  const guess = await emitFromRust(bridge, agentId, { type: "status", at: "now", source: "pty", status: { kind: "idle", confidence: "guessed", detail: "" } });
  assert(guess.ok, "Rust accepted the guessed idle event");
  const bad = await emitFromRust(bridge, agentId, { type: "status", at: "now", source: "e2e", status: { kind: "ready", confidence: "exact", detail: "" } });
  assert(!bad.ok && /not a SessionEvent/.test(bad.error), `Rust refused a status outside the vocabulary (${bad.error})`);
  await sleep(500);
  const held = await readRow(bridge, agentId);
  assert(held.tag.status === "needs_approval" && held.tag.confidence === "exact", "the row still says needs approval, exact");

  log("A: approve once — the turn finishes");
  await bridge.clickWhenReady(`return e2e.click(e2e.must(e2e.first(".perm-modal .perm-link-primary"), "Approve once"));`);
  const finished = await waitForRowStatus(bridge, agentId, ["done_unread", "idle"], "the turn to finish", { timeoutMs: 20_000 });
  log(`  after approval the row says: ${finished} (done until seen; idle when the window has focus on it)`);

  // B — a terminal session: the TerminalProvider, guessed
  log("B: a plain terminal session reports through the TerminalProvider, as a guess");
  const termId = await createPlainTerminal(bridge);
  log(`  terminal session: ${termId}`);
  await bridge.waitFor("the shell to print its prompt", `
    const lines = window.__HERMES_E2E__.readTerminal(${JSON.stringify(termId)}) || [];
    const info = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(termId)});
    return info && info.opened && lines.some((l) => l.trim().length > 0);
  `, { timeoutMs: 30_000 });
  await waitForRowStatus(bridge, termId, "idle", "the terminal row to say idle", { timeoutMs: 20_000 });
  const idleRow = await readRow(bridge, termId);
  log(`  row: ${JSON.stringify(idleRow)}`);
  assert(idleRow.tag.confidence === "guessed" && idleRow.tag.guessed === "guessed", "a terminal heuristic says 'guessed' in words");
  assert(idleRow.tag.opacity < 1, `and is dimmed (opacity ${idleRow.tag.opacity})`);
  await bridge.screenshot(join(evidenceDir, "02-terminal-idle-guessed.png"));
  await sleep(800);
  await bridge.typeInTerminal(termId, `${probeCommand()}\n`);
  const { line } = await bridge.waitForTerminal(termId, PROBE_OUTPUT, { timeoutMs: 20_000 });
  const shell = classifyProbe(line);
  log(`  the session's shell is ${shell}`);
  const agentLog = join(evidenceDir, "fake-agent.jsonl");
  rmSync(agentLog, { force: true });
  await bridge.typeInTerminal(termId, commandLine(shell, process.execPath, [FAKE_AGENT, "--scenario", "approval", "--log", agentLog]) + "\n");
  await bridge.waitForTerminal(termId, /Allow Bash: rm -rf node_modules \?/, { timeoutMs: 20_000 });
  const whileBox = await bridge.waitFor("the row to stop saying working while the box waits", `
    const s = e2e.first(${JSON.stringify(ROW(termId) + " .agent-status-tag")})?.getAttribute("data-status");
    return s && s !== "working" ? s : null;
  `, { timeoutMs: 10_000 });
  log(`  while the fake agent's approval box waits the row says: ${whileBox} (guessed)`);
  await bridge.typeInTerminal(termId, "y");
  await waitForRowStatus(bridge, termId, "working", "the row to say working while the fake agent works", { timeoutMs: 5_000 });
  const working = await readRow(bridge, termId);
  assert(working.tag.word === "working" && working.tag.guessed === "guessed" && working.tag.glyph.trim() !== "", `the row says "${working.tag.glyph} working · guessed"`);
  await bridge.screenshot(join(evidenceDir, "03-terminal-working-guessed.png"));
  await bridge.waitForTerminal(termId, /fake-agent: task done/, { timeoutMs: 20_000 });
  await waitForRowStatus(bridge, termId, ["idle", "needs_answer"], "the row to settle after the agent exits", { timeoutMs: 15_000 });

  // C — every status, through the Rust side of the channel
  log("C: every status in the vocabulary shows with its own glyph and word (agent session in the background)");
  const active = await bridge.eval(`return e2e.first(".session-item-active")?.getAttribute("data-session-item-id") ?? null;`);
  assert(active === termId, "the terminal session is the one on screen; the agent session is in the background");
  const shown = {};
  for (const kind of KINDS) {
    const detail = `F10 detail for ${kind}`;
    const r = await emitFromRust(bridge, agentId, { type: "status", at: "now", source: "hook:fake", status: { kind, confidence: "exact", detail } });
    assert(r.ok, `Rust emitted ${kind}`);
    await waitForRowStatus(bridge, agentId, kind, `the row to show ${kind}`);
    const row = await readRow(bridge, agentId);
    assert(row.tag.glyph.trim() !== "" && row.tag.word !== "", `${kind}: "${row.tag.glyph} ${row.tag.word}"`);
    assert(row.tag.confidence === "exact" && row.tag.guessed === null, `${kind}: exact, not dimmed`);
    assert(row.tag.title.startsWith(detail), `${kind}: the tooltip starts with the detail line`);
    shown[kind] = row.tag;
    if (kind === "needs_approval" || kind === "limited" || kind === "working") await bridge.screenshot(join(evidenceDir, `04-status-${kind}.png`));
  }
  assert(new Set(KINDS.map((k) => shown[k].glyph)).size === KINDS.length, "13 statuses, 13 different glyphs");
  assert(new Set(KINDS.map((k) => shown[k].word)).size === KINDS.length, "13 statuses, 13 different words");

  log("C: a guess from the same source is dimmed and says 'guessed'");
  await emitFromRust(bridge, agentId, { type: "status", at: "now", source: "hook:fake", status: { kind: "working", confidence: "guessed", detail: "" } });
  await bridge.waitFor("the row to show the guess", `return !!e2e.first(${JSON.stringify(ROW(agentId) + ' .agent-status-tag[data-confidence="guessed"]')});`);
  const guessed = await readRow(bridge, agentId);
  assert(guessed.tag.guessed === "guessed" && guessed.tag.opacity < 1, `"${guessed.tag.word} · ${guessed.tag.guessed}", opacity ${guessed.tag.opacity}`);

  log("C: a finished turn reads done until the session is chosen");
  await emitFromRust(bridge, agentId, { type: "turn_start", at: "now", source: "hook:fake", n: 1 });
  await waitForRowStatus(bridge, agentId, "working", "the turn to start");
  await emitFromRust(bridge, agentId, { type: "turn_end", at: "now", source: "hook:fake", n: 1 });
  await waitForRowStatus(bridge, agentId, "done_unread", "the row to say done");
  await bridge.screenshot(join(evidenceDir, "05-done-unread.png"));
  await bridge.click(ROW(agentId));
  await waitForRowStatus(bridge, agentId, "idle", "the row to say idle once chosen");
  await bridge.click(ROW(termId));
  await sleep(300);

  log("C: an exit words its code");
  await emitFromRust(bridge, agentId, { type: "exit", at: "now", source: "hook:fake", code: 3, signal: null });
  await waitForRowStatus(bridge, agentId, "exited", "the row to say exited");
  const exited = await readRow(bridge, agentId);
  assert(/^exit code 3\n/.test(exited.tag.title), `the tooltip says ${JSON.stringify(exited.tag.title.split("\n")[0])}`);

  // D — the attention summary
  log("D: the attention summary lists who needs a person");
  await emitFromRust(bridge, agentId, { type: "attention", at: "now", source: "osc", detail: "Which database?" });
  await waitForRowStatus(bridge, agentId, "exited", "an attention signal does not wake an exited session");
  await emitFromRust(bridge, agentId, { type: "status", at: "now", source: "hook:fake", status: { kind: "needs_answer", confidence: "exact", detail: "Which database?" } });
  await waitForRowStatus(bridge, agentId, "needs_answer", "the row to say asked you");
  const summary = await bridge.eval(`return window.__HERMES_E2E__.attentionSummary();`);
  log(`  summary: ${JSON.stringify({ needsYou: summary.needsYou.map((n) => [n.sessionId, n.status.kind]) })}`);
  assert(summary.needsYou.some((n) => n.sessionId === agentId && n.status.kind === "needs_answer"), "the agent session is listed as needing a person");
  assert(!summary.needsYou.some((n) => n.sessionId === termId), "the terminal session is not");
  await bridge.screenshot(join(evidenceDir, "06-needs-answer.png"));
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      const rows = await app.bridge.eval(`return e2e.all(".session-item").map((el) => e2e.norm(el.innerText).slice(0, 120));`);
      log(`  rows: ${JSON.stringify(rows)}`);
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
  rmSync(work, { recursive: true, force: true });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
