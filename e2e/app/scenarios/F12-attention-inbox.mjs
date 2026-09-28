#!/usr/bin/env node
// Scenario: F12 — the attention inbox on the REAL app.
//
// Three fake terminal agents (tools/fake-agents, the `approval` scenario)
// sit at an approval prompt in three sessions, next to a plain shell. Their
// statuses reach the app the way every agent's do, as SessionEvents; until
// the zero-setup signals (F11) are on main, the contract's e2e injector
// (docs/adr/004-2.0-contracts.md) delivers them. Then, like a person:
//
//   1. the flag is on: the title-bar badge is there and says 0
//   2. the plain shell, which is the session in front of you in a focused
//      window, asks something: no OS notification for it; the badge says 1
//      until it moves on
//   3. the three agents block in the order B, C, A (not the sidebar order):
//      the badge and the OS badge (dock label on macOS, urgency hint on
//      Linux, the count sent to the taskbar overlay on Windows) say 3; each
//      of the three gets one OS notification
//   4. ⌘I (Ctrl+Shift+I on Windows/Linux) visits B, C, A and wraps to B,
//      putting the keyboard in that session's terminal each time
//   5. ⌘⇧I (Ctrl+Shift+A) opens the inbox: a focused listbox, Blocked on
//      you oldest first, an aria-live summary; the window losing and
//      regaining focus (⌘Tab back, a notification click) leaves the keyboard
//      in the inbox, never in the terminal behind it; ↓ selects, Space peeks at
//      the request (read-only), Esc closes the peek, M mutes C for an hour
//      (badge 2, ⌘I skips it), Enter jumps to A and closes the inbox
//   6. B's agent is answered in its own terminal ("y"), works, finishes:
//      B moves to Ready for you; looking at B reads it
//   7. while a session works the machine is kept awake (the OS lists
//      Hermes's hold: pmset / systemd-inhibit / powercfg); when nothing
//      works the hold is gone
//   The sidebar order never changes, from the first step to the last.
//   8. an agent that only reports through its own terminal notifications
//      (the fake agent as it ships: OSC 9 / 99 / 777) blocks itself; answered
//      in its terminal, it leaves Blocked on you although it never says it
//      went back to work (its status is no longer "needs approval").
//
// The window's keyboard focus is stated through the test hooks
// (setWindowFocused): a hands-free test must not take the focus from
// whoever uses the machine.
//
// Negative control: HERMES_E2E_F12_NEGATIVE=1 leaves the attentionInbox
// flag off, so the badge never appears and the run must end in RESULT: FAIL.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F12-attention-inbox.mjs
//
// Evidence (log + screenshots) goes to HERMES_E2E_EVIDENCE, or
// <out dir>/evidence/F12-attention-inbox.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { REPO_ROOT, createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";
import { PROBE_OUTPUT, classifyProbe, commandLine, probeCommand } from "../shells.mjs";

const SCENARIO = "F12-attention-inbox";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);
const NEGATIVE = process.env.HERMES_E2E_F12_NEGATIVE === "1";
const FAKE_AGENT = join(REPO_ROOT, "tools", "fake-agents", "fake-agent.mjs");
const DB_FILE = "hermes_idea_v3.db";
const DETAIL = "Bash: rm -rf node_modules";
const MAC = platform() === "darwin";
const KEEP_AWAKE_REASON = "Hermes: an agent is working";

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

const onWindows = platform() === "win32";
const homeDir = onWindows ? undefined : mkdtempSync(join(tmpdir(), "hermes-e2e-f12-home-"));

function launch(run, { first = false } = {}) {
  const runDir = join(evidenceDir, `run-${run}`);
  return onWindows
    ? launchApp({ runDir, log, home: "real", resetData: first })
    : launchApp({ runDir, log, home: "private", homeDir });
}

async function dismissWhatsNew(bridge) {
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }
}

async function completeOnboarding(bridge) {
  await bridge.waitFor("the welcome dialog", `return !!e2e.first(".onboarding-dialog");`);
  for (const _screen of ["welcome", "theme", "AI tools"]) {
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

function enableFlag(dataDir) {
  const db = new DatabaseSync(join(dataDir, DB_FILE));
  try {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('feature_flag_overrides', ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    ).run(JSON.stringify({ attentionInbox: true }));
  } finally {
    db.close();
  }
}

// ── sessions ─────────────────────────────────────────────────────────

async function createPlainTerminal(bridge) {
  if (await bridge.exists("button.es-tile-primary")) await bridge.click("button.es-tile-primary");
  else await bridge.clickByName("New session");
  await bridge.waitFor("the New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`, { timeoutMs: 20_000 });
  // "Plain shell" is always the last card.
  await bridge.clickWhenReady(`
    const cards = e2e.all(".session-creator-provider-card");
    return e2e.click(e2e.must(cards[cards.length - 1], "plain shell card"));
  `);
  const before = await bridge.terminalIds();
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
  return bridge.waitFor(
    "a terminal to appear",
    `const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
     return ids.length === 1 ? ids[0] : null;`,
    { timeoutMs: 20_000 },
  );
}

async function detectShell(bridge, sessionId) {
  await bridge.typeInTerminal(sessionId, `${probeCommand()}\n`);
  const { line } = await bridge.waitForTerminal(sessionId, PROBE_OUTPUT, { timeoutMs: 20_000 });
  return classifyProbe(line);
}

/**
 * The fake agent's approval scenario, waiting long enough for this run. Its
 * own terminal notifications (OSC 9 / 99 / 777, and the "Agent turn
 * complete" one it writes in pieces) are left out: with the
 * zero-setup signals (F11) each would make its session blocked by itself,
 * and this scenario sets the order the agents block in through the e2e
 * injector.
 */
function patientApprovalScenario() {
  const file = join(evidenceDir, "approval-patient.json");
  const scenario = JSON.parse(readFileSync(join(REPO_ROOT, "tools", "fake-agents", "scenarios", "approval.json"), "utf8"));
  const quiet = (steps) =>
    steps
      .filter((step) => !["osc9", "osc99", "osc777", "split"].includes(step.do))
      .map((step) => (step.branches ? { ...step, branches: Object.fromEntries(Object.entries(step.branches).map(([k, b]) => [k, { ...b, steps: quiet(b.steps ?? []) }])) } : step));
  scenario.steps = quiet(scenario.steps);
  for (const step of scenario.steps) if (step.do === "waitKey") step.timeoutMs = 600_000;
  writeFileSync(file, JSON.stringify(scenario, null, 2));
  return file;
}

/** The fake agent's approval scenario as it ships (its notifications included), waiting long enough. */
function oscApprovalScenario() {
  const file = join(evidenceDir, "approval-notifications.json");
  const scenario = JSON.parse(readFileSync(join(REPO_ROOT, "tools", "fake-agents", "scenarios", "approval.json"), "utf8"));
  for (const step of scenario.steps) if (step.do === "waitKey") step.timeoutMs = 600_000;
  writeFileSync(file, JSON.stringify(scenario, null, 2));
  return file;
}

async function startFakeAgent(bridge, sessionId, tag, scenarioFile) {
  const shell = await detectShell(bridge, sessionId);
  const agentLog = join(evidenceDir, `fake-agent-${tag}.jsonl`);
  rmSync(agentLog, { force: true });
  await bridge.typeInTerminal(sessionId, commandLine(shell, process.execPath, [FAKE_AGENT, "--scenario", scenarioFile, "--log", agentLog]) + "\n");
  await bridge.waitForTerminal(sessionId, /Allow Bash: rm -rf node_modules \?/, { timeoutMs: 20_000 });
  log(`  agent ${tag} (${sessionId}, ${shell}) is at its approval prompt`);
}

// ── what the app shows ───────────────────────────────────────────────

const sidebarOrder = (bridge) => bridge.eval(`return e2e.all(".session-item").map((el) => el.dataset.sessionItemId);`);
const activeSession = (bridge) => bridge.eval(`return e2e.first(".session-item-active")?.dataset.sessionItemId ?? null;`);
const badgeCount = (bridge) => bridge.eval(`const b = e2e.first(".attention-badge"); return b ? Number(b.dataset.count) : null;`);
const attention = (bridge) => bridge.eval(`return window.__HERMES_E2E__.attentionState();`);
const osState = (bridge) => bridge.eval(`return await window.__TAURI_INTERNALS__.invoke("attention_state_for_test");`);

function inject(bridge, sessionId, kind, detail = "") {
  return bridge.eval(`
    return window.__HERMES_E2E__.injectSessionEvent(${JSON.stringify(sessionId)}, {
      type: "status", at: Date.now(), source: "e2e",
      status: { kind: ${JSON.stringify(kind)}, confidence: "exact", detail: ${JSON.stringify(detail)} },
    });
  `);
}

/** A key the way the keyboard sends it, to whatever has the keyboard. */
function pressKey(bridge, init) {
  return bridge.eval(`
    const target = document.activeElement || document.body;
    const ev = new KeyboardEvent("keydown", { ...${JSON.stringify(init)}, bubbles: true, cancelable: true, composed: true, view: window });
    target.dispatchEvent(ev);
    target.dispatchEvent(new KeyboardEvent("keyup", { ...${JSON.stringify(init)}, bubbles: true, cancelable: true, composed: true, view: window }));
    return true;
  `);
}

const NEXT = MAC ? { key: "i", code: "KeyI", metaKey: true } : { key: "I", code: "KeyI", ctrlKey: true, shiftKey: true };
const INBOX = MAC ? { key: "I", code: "KeyI", metaKey: true, shiftKey: true } : { key: "A", code: "KeyA", ctrlKey: true, shiftKey: true };

async function waitBadge(bridge, n, what) {
  await bridge.waitFor(`the badge to say ${n} (${what})`, `const b = e2e.first(".attention-badge"); return b && Number(b.dataset.count) === ${n};`);
  const os = await bridge.waitFor(`the OS badge to follow (${n})`, `
    const s = await window.__TAURI_INTERNALS__.invoke("attention_state_for_test");
    return s.badge.count === ${n} ? s : null;
  `);
  if (MAC) {
    const want = n === 0 ? null : String(n);
    assert(os.badge.os.dockBadgeLabel === want, `the dock badge reads ${JSON.stringify(want)} (${what})`);
  } else if (platform() === "linux") {
    assert(os.badge.os.urgencyHint === n > 0, `the window's urgency hint is ${n > 0} (${what})`);
  } else {
    assert(os.badge.mechanism === "taskbar-overlay" && os.badge.count === n, `the taskbar overlay was set for ${n} (${what}); Windows cannot read an overlay back`);
  }
}

async function nextAndExpect(bridge, expected, names) {
  await pressKey(bridge, NEXT);
  const got = await bridge.waitFor(`⌘I to reach ${names[expected]}`, `
    const a = e2e.first(".session-item-active")?.dataset.sessionItemId;
    return a === ${JSON.stringify(expected)} ? a : null;
  `);
  const focusIn = await bridge.waitFor("the keyboard to be in that terminal", `
    const host = document.activeElement?.closest?.("[data-session-id]");
    return host?.dataset.sessionId === ${JSON.stringify(expected)} ? host.dataset.sessionId : null;
  `);
  assert(got === expected && focusIn === expected, `⌘I jumped to ${names[expected]} and its terminal has the keyboard`);
}

/** The OS's own list of who keeps the machine awake. */
function osKeepAwakeListing() {
  try {
    if (MAC) return execFileSync("pmset", ["-g", "assertions"], { encoding: "utf8" });
    if (platform() === "linux") return execFileSync("systemd-inhibit", ["--list", "--no-pager"], { encoding: "utf8" });
    return execFileSync("powercfg", ["/requests"], { encoding: "utf8" });
  } catch (e) {
    return `(could not list: ${e.message})`;
  }
}

function heldByHermes(listing, status) {
  if (MAC) return !!status.pid && new RegExp(`pid ${status.pid}\\(caffeinate\\)`).test(listing);
  return listing.includes(KEEP_AWAKE_REASON);
}

let app;
let failed = false;

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}${NEGATIVE ? "   NEGATIVE CONTROL (flag left off)" : ""}`);

  // ── run 1: first launch; turn the flag on while the app is closed ──
  app = await launch(1, { first: true });
  await completeOnboarding(app.bridge);
  const exit1 = await app.stop();
  assert(!exit1.forced && exit1.code === 0, "first launch quit cleanly");
  if (NEGATIVE) log("step 0: NEGATIVE CONTROL — leaving the attentionInbox flag off");
  else enableFlag(app.dataDir);

  // ── run 2 ──────────────────────────────────────────────────────────
  app = await launch(2);
  const { bridge } = app;
  await bridge.waitFor("the app UI (no onboarding this time)", `return !!e2e.first(".topbar") && !e2e.first(".onboarding-backdrop");`);
  await dismissWhatsNew(bridge);

  log("step 1: the title-bar badge is there and says 0");
  await bridge.waitFor("the attention badge in the title bar", `return !!e2e.first(".topbar .attention-badge");`, { timeoutMs: 10_000 });
  assert((await badgeCount(bridge)) === 0, "the badge says 0");

  log("step 2: three fake agents at an approval prompt, and a plain shell");
  const scenarioFile = patientApprovalScenario();
  const A = await createPlainTerminal(bridge);
  await startFakeAgent(bridge, A, "A", scenarioFile);
  const B = await createPlainTerminal(bridge);
  await startFakeAgent(bridge, B, "B", scenarioFile);
  const C = await createPlainTerminal(bridge);
  await startFakeAgent(bridge, C, "C", scenarioFile);
  const D = await createPlainTerminal(bridge);
  const names = { [A]: "A", [B]: "B", [C]: "C", [D]: "shell" };
  const order0 = await sidebarOrder(bridge);
  log(`  sidebar order: ${order0.map((id) => names[id]).join(", ")}`);
  assert(order0.length === 4, "four sessions in the sidebar");
  assert((await activeSession(bridge)) === D, "the plain shell is the session in front");
  await bridge.eval(`window.__HERMES_E2E__.setWindowFocused(true); return true;`);

  log("step 3: the session in front asks something: no notification for it");
  assert(await inject(bridge, D, "needs_answer", "Which database?"), "status injected for the shell");
  await waitBadge(bridge, 1, "the shell asks");
  let state = await attention(bridge);
  assert(state.decisions.length === 1 && state.decisions[0].sessionId === D && state.decisions[0].decision === "suppressed-focused", `decided: ${JSON.stringify(state.decisions)}`);
  assert(state.os.length === 0, "no OS notification was shown for the focused session");
  await inject(bridge, D, "idle");
  await waitBadge(bridge, 0, "the shell moved on");

  log("step 4: the agents block in the order B, C, A");
  await inject(bridge, B, "needs_approval", DETAIL);
  await sleep(50);
  await inject(bridge, C, "needs_approval", DETAIL);
  await sleep(50);
  await inject(bridge, A, "needs_approval", DETAIL);
  await waitBadge(bridge, 3, "three agents blocked");
  state = await attention(bridge);
  const sent = state.decisions.filter((d) => d.decision === "sent").map((d) => names[d.sessionId]);
  assert(JSON.stringify(sent) === JSON.stringify(["B", "C", "A"]), `one notification per blocked agent, in order (${sent.join(", ")})`);
  assert(state.os.length === 3 && state.os.every((n) => n.body.includes(DETAIL.split(":")[0])), "three OS notifications, each naming the request");
  assert(JSON.stringify(await sidebarOrder(bridge)) === JSON.stringify(order0), "the sidebar did not reorder");
  await bridge.screenshot(join(evidenceDir, "01-three-blocked.png"));

  log("step 5: ⌘I visits the agents oldest first and wraps");
  await nextAndExpect(bridge, B, names);
  await nextAndExpect(bridge, C, names);
  await nextAndExpect(bridge, A, names);
  await nextAndExpect(bridge, B, names);
  assert(JSON.stringify(await sidebarOrder(bridge)) === JSON.stringify(order0), "the sidebar did not reorder while jumping");

  log("step 6: the inbox, by keyboard only");
  // Evidence: every element the keyboard moves to from here to the check.
  await bridge.eval(`
    window.__f12FocusMoves = [];
    document.addEventListener("focusin", (e) => {
      const t = e.target;
      window.__f12FocusMoves.push(t.closest?.(".xterm") ? "terminal" : t.getAttribute?.("role") || t.tagName);
    }, true);
    return true;
  `);
  await pressKey(bridge, INBOX);
  const listbox = await bridge.waitFor("the inbox listbox to have the keyboard", `
    const lb = e2e.first('.attention-inbox [role="listbox"]');
    if (!lb || document.activeElement !== lb) return null;
    return {
      label: lb.getAttribute("aria-label"),
      options: [...lb.querySelectorAll('[role="option"]')].map((o) => ({ sid: o.dataset.sessionId, selected: o.getAttribute("aria-selected"), id: o.id })),
      active: lb.getAttribute("aria-activedescendant"),
      groups: [...lb.querySelectorAll('[role="group"]')].map((g) => g.dataset.section),
    };
  `);
  assert(listbox.label === "Attention inbox", "the listbox has a name");
  assert(JSON.stringify(listbox.groups) === JSON.stringify(["blocked"]), "one group: Blocked on you");
  assert(JSON.stringify(listbox.options.map((o) => names[o.sid])) === JSON.stringify(["B", "C", "A"]), "Blocked on you lists B, C, A (oldest first)");
  assert(listbox.options[0].selected === "true" && listbox.active === listbox.options[0].id, "the first option is selected and announced as active");
  const live = await bridge.waitFor("the aria-live summary", `
    const el = e2e.first('.attention-center [aria-live="polite"]') || document.querySelector('.attention-center [aria-live="polite"]');
    const t = el?.textContent ?? "";
    return t.includes("blocked on you") ? t : null;
  `);
  assert(live.includes("3 blocked on you"), `the live region says "${live}"`);

  // Coming back to the window: the app's "give the terminal its keyboard
  // back" must not take it from the open inbox. Watched on every frame for
  // half a second, so a steal that is later undone still counts.
  const regain = await bridge.eval(`
    const lb = document.querySelector('.attention-inbox [role="listbox"]');
    const where = () => {
      const a = document.activeElement;
      if (a === lb) return "listbox";
      return a?.closest?.("[data-session-id]") ? "terminal" : (a?.tagName ?? "none");
    };
    const seen = new Set();
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
    seen.add(where());
    document.dispatchEvent(new Event("visibilitychange"));
    seen.add(where());
    const end = performance.now() + 500;
    while (performance.now() < end) {
      await new Promise((r) => requestAnimationFrame(r));
      seen.add(where());
    }
    return { seen: [...seen], final: where() };
  `);
  log(`  after the window regained focus: ${JSON.stringify(regain)}`);
  log(`  keyboard moves since the inbox opened: ${JSON.stringify(await bridge.eval("return window.__f12FocusMoves;"))}`);
  assert(regain.final === "listbox" && !regain.seen.includes("terminal"), "the window regaining focus leaves the keyboard in the inbox, never in a terminal");
  const keyInList = (key) => bridge.eval(`
    const lb = document.querySelector('.attention-inbox [role="listbox"]');
    lb.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
    return true;
  `);
  const selectedIs = (sid, what) => bridge.waitFor(what, `
    return e2e.first('.attention-inbox [role="option"][aria-selected="true"]')?.dataset.sessionId === ${JSON.stringify(sid)};
  `);
  // ↓ sent to whatever has the keyboard: it reaches the inbox, not a terminal.
  await pressKey(bridge, { key: "ArrowDown", code: "ArrowDown" });
  await selectedIs(C, "↓ (to whatever has the keyboard) selects C");
  await keyInList(" ");
  const peek = await bridge.waitFor("the peek at C's request", `
    const p = e2e.first('.attention-peek[role="region"]');
    return p ? { text: e2e.norm(p.innerText), inputs: p.querySelectorAll("input, textarea, button, [contenteditable]").length } : null;
  `);
  assert(peek.text.includes(DETAIL) && peek.inputs === 0, "Space shows the request detail, read-only (nothing to type into or press)");
  await bridge.screenshot(join(evidenceDir, "02-inbox-peek.png"));
  await keyInList("Escape");
  await bridge.waitFor("the peek to close (the inbox stays)", `return !e2e.first(".attention-peek") && !!e2e.first(".attention-inbox");`);
  await keyInList("m");
  await waitBadge(bridge, 2, "C muted");
  const muted = await bridge.eval(`return e2e.all('.attention-inbox [role="option"]').map((o) => [o.dataset.sessionId, o.dataset.muted]);`);
  assert(muted.find(([sid]) => sid === C)?.[1] === "true", "C is still listed, marked muted");
  await keyInList("ArrowDown");
  await selectedIs(A, "↓ to select A");
  await keyInList("Enter");
  await bridge.waitFor("the inbox to close and A to be in front", `
    return !e2e.first(".attention-inbox") && e2e.first(".session-item-active")?.dataset.sessionItemId === ${JSON.stringify(A)};
  `);
  log("  Enter jumped to A and closed the inbox");
  await nextAndExpect(bridge, B, names);
  await nextAndExpect(bridge, A, names); // C is muted: skipped
  assert(JSON.stringify(await sidebarOrder(bridge)) === JSON.stringify(order0), "the sidebar did not reorder");

  log("step 7: B is answered in its own terminal, works, finishes: Ready for you");
  await nextAndExpect(bridge, B, names);
  await bridge.typeInTerminal(B, "y");
  await bridge.waitForTerminal(B, /fake-agent: approval granted/, { timeoutMs: 15_000 });
  await inject(bridge, B, "working");
  await waitBadge(bridge, 1, "B works; only A counts (C is muted)");

  log("step 8: while B works the machine is kept awake");
  const held = await bridge.waitFor("the keep-awake hold", `
    const s = await window.__TAURI_INTERNALS__.invoke("attention_state_for_test");
    return s.keepAwake.active ? s.keepAwake : null;
  `);
  log(`  hold: ${JSON.stringify(held)}`);
  const listing = osKeepAwakeListing();
  writeFileSync(join(evidenceDir, "keep-awake-held.txt"), listing);
  assert(heldByHermes(listing, held), `the OS lists Hermes's hold (${held.mechanism})`);

  // B finishes while you look at another session: it becomes Ready for you.
  await nextAndExpect(bridge, A, names);
  await bridge.waitForTerminal(B, /fake-agent: task done/, { timeoutMs: 15_000 }).catch(() => {});
  await inject(bridge, B, "done_unread");
  const ready = await bridge.waitFor("B in Ready for you", `
    const items = window.__HERMES_E2E__.inboxItems();
    return items.find((i) => i.kind === "ready" && i.sessionId === ${JSON.stringify(B)}) ?? null;
  `);
  assert(!!ready, "B's finished turn is listed in Ready for you");
  state = await attention(bridge);
  assert(state.decisions.some((d) => d.itemId === ready.id && d.decision === "sent"), `B's finished turn notified (you were looking at A) (${JSON.stringify(state.decisions.filter((d) => d.sessionId === B))})`);

  log("step 9: nothing works any more: the hold is released");
  const released = await bridge.waitFor("the hold to be released", `
    const s = await window.__TAURI_INTERNALS__.invoke("attention_state_for_test");
    return s.keepAwake.active ? null : s.keepAwake;
  `);
  const after = osKeepAwakeListing();
  writeFileSync(join(evidenceDir, "keep-awake-released.txt"), after);
  assert(!heldByHermes(after, held), `the OS no longer lists the hold (${JSON.stringify(released)})`);

  log("step 10: looking at B reads its Ready item");
  await pressKey(bridge, INBOX);
  await bridge.waitFor("the inbox with a Ready for you group", `return e2e.all('.attention-inbox [role="group"]').map((g) => g.dataset.section).includes("ready");`);
  await bridge.screenshot(join(evidenceDir, "03-inbox-ready.png"));
  await keyInList("End");
  const last = await bridge.waitFor("End to select B's Ready item", `
    const o = e2e.first('.attention-inbox [role="option"][aria-selected="true"]');
    return o?.dataset.sessionId === ${JSON.stringify(B)} && o.dataset.kind === "ready" ? o.dataset.sessionId : null;
  `);
  assert(last === B, "End selects the last row: B in Ready for you");
  await keyInList("Enter");
  await bridge.waitFor("B in front and its Ready item read", `
    return e2e.first(".session-item-active")?.dataset.sessionItemId === ${JSON.stringify(B)}
      && !window.__HERMES_E2E__.inboxItems().some((i) => i.kind === "ready");
  `);
  assert(JSON.stringify(await sidebarOrder(bridge)) === JSON.stringify(order0), "the sidebar order is the same as at the start");

  log("step 11: an agent that only reports through terminal notifications: answered in its terminal, it leaves Blocked on you");
  // The fake agent's approval scenario as it ships, notifications included:
  // nothing but its own OSC 9 / 99 / 777 says it needs approval, and
  // nothing says it went back to work.
  const E = await createPlainTerminal(bridge);
  await startFakeAgent(bridge, E, "E (notifications only)", oscApprovalScenario());
  const asked = await bridge.waitFor("E's notification in Blocked on you", `
    return window.__HERMES_E2E__.inboxItems().find((i) => i.sessionId === ${JSON.stringify(E)} && i.kind === "blocked") ?? null;
  `, { timeoutMs: 10_000 });
  const askedStatus = await bridge.eval(`return window.__HERMES_E2E__.sessionStatus(${JSON.stringify(E)});`);
  assert(askedStatus.kind === "needs_approval" && askedStatus.confidence === "signal", `E's own notification blocks it ("${asked.detail}", ${askedStatus.kind} · ${askedStatus.confidence})`);
  await bridge.screenshot(join(evidenceDir, "05-osc-agent-blocked.png"));
  await bridge.typeInTerminal(E, "y");
  await bridge.waitForTerminal(E, /fake-agent: approval granted/, { timeoutMs: 15_000 });
  const resumed = await bridge.waitFor("E to leave Blocked on you once answered", `
    const s = window.__HERMES_E2E__.sessionStatus(${JSON.stringify(E)});
    const blocked = window.__HERMES_E2E__.inboxItems().some((i) => i.sessionId === ${JSON.stringify(E)} && i.kind === "blocked");
    return !blocked && s.kind !== "needs_approval" ? s : null;
  `, { timeoutMs: 5_000 });
  assert(resumed.kind === "working" || resumed.kind === "done_unread" || resumed.kind === "idle", `answered in its terminal, E's approval is resolved and its status moved on (${resumed.kind} · ${resumed.confidence}, from ${resumed.source})`);
  await bridge.screenshot(join(evidenceDir, "06-osc-agent-answered.png"));

  const shot = MAC ? await osState(bridge) : null;
  if (shot) log(`  OS state at the end: ${JSON.stringify(shot)}`);
  await bridge.screenshot(join(evidenceDir, "04-end.png"));
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  if (app?.isRunning()) {
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
    if (!failed && (exit.forced || exit.code !== 0)) {
      failed = true;
      log("FAILED: the app did not quit cleanly");
    }
  }
  if (homeDir) rmSync(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
