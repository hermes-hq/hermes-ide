#!/usr/bin/env node
// Scenario FIX-overlay-focus: the attention inbox gives the keyboard back to
// the terminal it came from, and only one overlay (the inbox, the command
// palette, the ⌘N launcher) is open at a time. On the REAL app, with fake
// `claude` and `codex` CLIs (tools/fake-agents) and a throwaway repository.
// No real account.
//
//   1. a task runs in a terminal; its agent is blocked on you (the badge
//      says 1); the terminal has the keyboard;
//   2. the inbox opened with ⌘⇧I (Ctrl+Shift+A) and closed with Esc: the
//      keyboard is back in that terminal (it used to end on <body>);
//   3. opened and closed with the same shortcut: back in the terminal;
//   4. opened and closed with the title-bar badge: back in the terminal;
//   5. one overlay at a time: ⌘⇧P over the open inbox opens the palette and
//      closes the inbox; ⌘⇧I over the palette opens the inbox and closes the
//      palette; ⌘N over the inbox opens the launcher and closes the inbox;
//      ⌘⇧P over the launcher (with a task typed) closes it, and ⌘N brings it
//      back with the task still there.
//
// Keys are sent to whatever has the keyboard, as key events (the rig sends
// no OS input on macOS). Negative control (must end in RESULT: FAIL): a build
// of main before the fix (the focus ends on <body>; the palette opens over
// the inbox).
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/FIX-overlay-focus.mjs

import { mkdirSync, rmSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { createLogger, finishScenario, outDir, sleep } from "../harness.mjs";
import {
  completeTaskWelcome,
  launcherFixtures,
  newTerminals,
  openLauncher,
  pickInMenu,
  pressAppShortcut,
  typeInto,
  waitLaunchEnabled,
  waitLauncherClosed,
} from "../launcher-steps.mjs";

const SCENARIO = "FIX-overlay-focus";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
mkdirSync(evidenceDir, { recursive: true });
const log = createLogger(logFile);
const MAC = platform() === "darwin";

const problems = [];
function check(condition, message) {
  if (condition) log(`  ok — ${message}`);
  else {
    log(`  FAILED — ${message}`);
    problems.push(message);
  }
}

const INBOX = MAC ? { key: "I", code: "KeyI", metaKey: true, shiftKey: true } : { key: "A", code: "KeyA", ctrlKey: true, shiftKey: true };
const PALETTE = MAC ? { key: "P", code: "KeyP", metaKey: true, shiftKey: true } : { key: "P", code: "KeyP", ctrlKey: true, shiftKey: true };
const ESC = { key: "Escape", code: "Escape" };

/** A key the way the keyboard sends it, to whatever has the keyboard. */
function press(bridge, init) {
  return bridge.eval(`
    const target = document.activeElement || document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", { ...${JSON.stringify(init)}, bubbles: true, cancelable: true, composed: true, view: window }));
    target.dispatchEvent(new KeyboardEvent("keyup", { ...${JSON.stringify(init)}, bubbles: true, cancelable: true, composed: true, view: window }));
    return true;
  `);
}

/** Where the keyboard is: the session whose terminal has it, or what else. */
const focusNow = (bridge) =>
  bridge.eval(`
    const a = document.activeElement;
    const host = a?.closest?.("[data-session-id]");
    return {
      terminal: !!a?.closest?.(".xterm") && host ? host.dataset.sessionId : null,
      tag: a ? a.tagName : null,
      body: a === document.body,
      role: a?.getAttribute?.("role") ?? null,
    };
  `);

/** Which overlays are on screen. */
const overlays = (bridge) =>
  bridge.eval(`return {
    inbox: !!e2e.first(".attention-inbox"),
    palette: !!e2e.first(".command-palette"),
    launcher: !!e2e.first(".task-launcher-sheet"),
  };`);

async function waitOverlays(bridge, want, what) {
  const got = await bridge
    .waitFor(what, `
      const now = { inbox: !!e2e.first(".attention-inbox"), palette: !!e2e.first(".command-palette"), launcher: !!e2e.first(".task-launcher-sheet") };
      return ${JSON.stringify(Object.entries(want))}.every(([k, v]) => now[k] === v) ? now : false;
    `, { timeoutMs: 10_000 })
    .catch(async () => overlays(bridge));
  return got;
}

async function focusTerminal(bridge, sessionId) {
  await bridge.eval(`
    const ta = e2e.must(document.querySelector('[data-session-id=${JSON.stringify(sessionId)}] .xterm-helper-textarea'), "the terminal's input");
    ta.focus();
    return true;
  `);
  const f = await focusNow(bridge);
  if (f.terminal !== sessionId) throw new Error(`could not give the terminal the keyboard: ${JSON.stringify(f)}`);
}

/** After a close: the keyboard settles (a frame or two), then where it is. */
async function focusAfterClose(bridge, sessionId) {
  const f = await bridge
    .waitFor("the keyboard back in the terminal", `
      const a = document.activeElement;
      const host = a?.closest?.("[data-session-id]");
      return a?.closest?.(".xterm") && host?.dataset.sessionId === ${JSON.stringify(sessionId)} ? true : false;
    `, { timeoutMs: 3_000 })
    .then(() => focusNow(bridge))
    .catch(() => focusNow(bridge));
  return f;
}

const fx = launcherFixtures("fixoverlay", log);
let app = null;
let failed = false;
try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}`);
  // The real flag defaults: the attention inbox and the ⌘N launcher are on.
  app = await fx.launch(evidenceDir, 1, { first: true, flagDefaults: {} });
  const { bridge } = app;
  await completeTaskWelcome(bridge, fx.repo);
  await bridge.waitFor("the attention badge in the title bar", `return !!e2e.first(".topbar .attention-badge");`, { timeoutMs: 10_000 });

  log("step 1: a task in a terminal, its agent blocked on you");
  await openLauncher(bridge);
  await typeInto(bridge, ".task-launcher-task", "Look at the inbox");
  await pickInMenu(bridge, "where", '[data-where="current-checkout"]');
  await waitLaunchEnabled(bridge);
  const before = await bridge.terminalIds();
  await bridge.click(".task-launcher-launch");
  const [sessionId] = await newTerminals(bridge, before, 1, "the task's terminal");
  await waitLauncherClosed(bridge);
  await bridge.eval(`
    return window.__HERMES_E2E__.injectSessionEvent(${JSON.stringify(sessionId)}, {
      type: "status", at: Date.now(), source: "e2e",
      status: { kind: "needs_approval", confidence: "exact", detail: "Bash: npm test" },
    });
  `);
  await bridge.waitFor("the badge to say 1", `const b = e2e.first(".attention-badge"); return b && Number(b.dataset.count) === 1;`, { timeoutMs: 15_000 });
  await focusTerminal(bridge, sessionId);
  log(`  session ${sessionId}; its terminal has the keyboard`);

  const openInboxWithKey = async () => {
    await press(bridge, INBOX);
    return bridge
      .waitFor("the inbox to have the keyboard", `const lb = e2e.first('.attention-inbox [role="listbox"]'); return !!lb && document.activeElement === lb;`, { timeoutMs: 10_000 })
      .catch(() => false);
  };

  log("step 2: Esc closes the inbox and the terminal gets the keyboard back");
  check(await openInboxWithKey(), "⌘⇧I opens the inbox, which takes the keyboard");
  await press(bridge, ESC);
  let o = await waitOverlays(bridge, { inbox: false }, "the inbox to close");
  let f = await focusAfterClose(bridge, sessionId);
  log(`  after Esc: ${JSON.stringify({ o, f })}`);
  check(!o.inbox, "Esc closes the inbox");
  check(!f.body, "the keyboard is not left on <body>");
  check(f.terminal === sessionId, "the keyboard is back in the terminal it came from");

  log("step 3: the shortcut that opened it closes it, and the terminal gets the keyboard back");
  await focusTerminal(bridge, sessionId);
  check(await openInboxWithKey(), "⌘⇧I opens the inbox");
  await press(bridge, INBOX);
  o = await waitOverlays(bridge, { inbox: false }, "the inbox to close");
  f = await focusAfterClose(bridge, sessionId);
  log(`  after ⌘⇧I again: ${JSON.stringify({ o, f })}`);
  check(!o.inbox && f.terminal === sessionId, "closed by its shortcut: the keyboard is back in the terminal");

  log("step 4: the badge opens and closes it, and the terminal gets the keyboard back");
  await focusTerminal(bridge, sessionId);
  await bridge.click(".attention-badge");
  o = await waitOverlays(bridge, { inbox: true }, "the inbox to open");
  check(o.inbox, "the badge opens the inbox");
  await bridge.click(".attention-badge");
  o = await waitOverlays(bridge, { inbox: false }, "the inbox to close");
  f = await focusAfterClose(bridge, sessionId);
  log(`  after the badge: ${JSON.stringify({ o, f })}`);
  check(!o.inbox && f.terminal === sessionId, "closed by the badge: the keyboard is back in the terminal");

  log("step 5: one overlay at a time");
  await focusTerminal(bridge, sessionId);
  check(await openInboxWithKey(), "the inbox is open");
  await press(bridge, PALETTE);
  o = await waitOverlays(bridge, { palette: true, inbox: false }, "the palette instead of the inbox");
  log(`  ⌘⇧P over the inbox: ${JSON.stringify(o)}`);
  check(o.palette && !o.inbox, "⌘⇧P over the inbox: the palette opens and the inbox closes");
  await bridge.screenshot(join(evidenceDir, "01-palette-not-over-inbox.png"));

  await press(bridge, INBOX);
  o = await waitOverlays(bridge, { inbox: true, palette: false }, "the inbox instead of the palette");
  log(`  ⌘⇧I over the palette: ${JSON.stringify(o)}`);
  check(o.inbox && !o.palette, "⌘⇧I over the palette: the inbox opens and the palette closes");

  await pressAppShortcut(bridge, { action: "file.new-session", pcKey: "n" });
  o = await waitOverlays(bridge, { launcher: true, inbox: false }, "the launcher instead of the inbox");
  log(`  ⌘N over the inbox: ${JSON.stringify(o)}`);
  check(o.launcher && !o.inbox, "⌘N over the inbox: the launcher opens and the inbox closes");
  if (o.launcher) {
    await bridge.waitFor("the launcher's starting choice", `return e2e.first(".task-launcher")?.getAttribute("data-ready") === "true";`, { timeoutMs: 30_000 });
    await typeInto(bridge, ".task-launcher-task", "A task typed before the palette");
    await press(bridge, PALETTE);
    o = await waitOverlays(bridge, { palette: true, launcher: false }, "the palette instead of the launcher");
    log(`  ⌘⇧P over the launcher: ${JSON.stringify(o)}`);
    check(o.palette && !o.launcher, "⌘⇧P over the launcher: the palette opens and the launcher closes");
    await press(bridge, ESC);
    await waitOverlays(bridge, { palette: false }, "the palette to close");
    await openLauncher(bridge);
    const task = await bridge.eval(`return e2e.first(".task-launcher-task")?.value ?? null;`);
    check(task === "A task typed before the palette", `the launcher comes back with what was typed (${JSON.stringify(task)})`);
    await press(bridge, ESC);
    await sleep(300);
  }
  await bridge.screenshot(join(evidenceDir, "02-end.png"));
  if (problems.length) throw new Error(`${problems.length} check(s) failed:\n  - ${problems.join("\n  - ")}`);
  log("all checks passed");
} catch (err) {
  failed = true;
  log(`ERROR: ${err.stack || err.message || err}`);
  try {
    await app?.bridge.screenshot(join(evidenceDir, "failure.png"));
  } catch {
    /* none */
  }
} finally {
  if (app) await app.stop();
  fx.cleanup();
}
finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log });
