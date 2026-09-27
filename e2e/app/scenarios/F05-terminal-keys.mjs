#!/usr/bin/env node
// Scenario F05: a focused terminal owns Ctrl+letter.
//
// A person runs a program in a Hermes terminal and presses Ctrl+A, Ctrl+D,
// Ctrl+E, Ctrl+W ... — every one must reach the program (it prints the bytes
// it receives), and none may run an app shortcut instead (no split, no closed
// pane, no panel). On Windows and Linux the app's own chords are
// Ctrl+Shift+letter: Ctrl+Shift+D from the terminal splits the pane. The
// Shortcuts panel shows the chords of the platform.
//
// The program is e2e/app/fixtures/keylogger.mjs, which records every byte the
// terminal delivers.
//
// Key input modes:
//   default               DOM key events on the terminal's input element
//                         (the rig's normal, hands-free way to type).
//   HERMES_E2E_OS_KEYS=1  REAL OS key presses (xdotool under Xvfb on Linux,
//                         SendInput on Windows) through the native menu and
//                         the webview. CI runners only; refused on macOS.
//   HERMES_E2E_PLATFORM=linux|win
//                         run the frontend with that platform's keyboard
//                         rules (test builds only) — lets a Mac check the
//                         Windows/Linux frontend path with DOM events.
//
//   node e2e/app/build.mjs
//   node e2e/app/scenarios/F05-terminal-keys.mjs

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, createLogger, finishScenario, launchApp, outDir, sleep } from "../harness.mjs";
import { osKeysAvailable, pressChords } from "../os-keys.mjs";

const SCENARIO = "F05-terminal-keys";
const startedAt = Date.now();
const evidenceDir = process.env.HERMES_E2E_EVIDENCE || join(outDir(), "evidence", SCENARIO);
const logFile = join(evidenceDir, "scenario.log");
rmSync(logFile, { force: true });
const log = createLogger(logFile);

const OS_KEYS = process.env.HERMES_E2E_OS_KEYS === "1";
const EMULATE = process.env.HERMES_E2E_PLATFORM || "";
const NATIVE = platform() === "darwin" ? "mac" : platform() === "win32" ? "win" : "linux";
const EFFECTIVE = EMULATE || NATIVE;
const PC = EFFECTIVE !== "mac";

// Ctrl+letter keys a shell, readline, an editor or an agent TUI relies on.
// Every one of them used to be (or could be) an app shortcut.
const LETTERS = ["a", "b", "c", "d", "e", "f", "g", "j", "k", "m", "n", "p", "t", "w", "x", "y", "z"];
const ctrlByte = (letter) => (letter.toUpperCase().charCodeAt(0) - 64).toString(16).padStart(2, "0");

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`  ok — ${message}`);
}

/**
 * A `hermeskeylog` command in `dir`, a folder this scenario owns, so running
 * it from a Hermes terminal starts the keylogger writing to `out`. Nothing is
 * written to the real home folder (the rig uses the real one on Windows).
 */
function installKeyloggerCommand(dir, out) {
  const script = join(REPO_ROOT, "e2e", "app", "fixtures", "keylogger.mjs");
  if (platform() === "win32") {
    const file = join(dir, "hermeskeylog.cmd");
    writeFileSync(file, `@"${process.execPath}" "${script}" "${out}"\r\n`);
    return;
  }
  const file = join(dir, "hermeskeylog");
  writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" "${out}"\n`);
  chmodSync(file, 0o755);
}

/** Bytes the keylogger recorded, as hex strings, in order. */
function keylogBytes(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\s+/).filter(Boolean);
}

async function waitForBytes(file, count, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let bytes = keylogBytes(file);
  while (bytes.length < count && Date.now() < deadline) {
    await sleep(100);
    bytes = keylogBytes(file);
  }
  return bytes;
}

// What a person would notice changing: panes, sessions, dialogs, panels.
const FINGERPRINT = `
  const panels = [...new Set(e2e.all('[class*="panel"]').map((el) => String(el.className).trim().split(/\\s+/)[0]))].sort();
  return {
    panes: e2e.all(".split-pane").length,
    sessions: e2e.all(".session-item").length,
    dialogs: e2e.all('[role="dialog"], .session-creator').length,
    panels,
  };
`;

async function pickPlainShellAndCreate(bridge, what) {
  await bridge.waitFor(`the New Session wizard (${what})`, `return !!e2e.first(".session-creator");`, { timeoutMs: 20_000 });
  if (await bridge.exists(".session-creator .session-creator-mode-step")) {
    await bridge.click('.session-creator-mode-card[data-category="universal"]');
    await bridge.waitFor("terminal mode to be selected", `
      return e2e.first('.session-creator-mode-card[data-category="universal"]')?.getAttribute("aria-checked") === "true";
    `);
    await bridge.click(".session-creator-actions .session-creator-btn-primary");
  }
  await bridge.waitFor("the agent picker", `return e2e.all(".session-creator-provider-card").length > 0;`);
  await bridge.clickWhenReady(`
    const cards = e2e.all(".session-creator-provider-card");
    return e2e.click(e2e.must(cards[cards.length - 1], "plain shell card"));
  `);
  await bridge.waitFor("plain shell to be selected", `
    const cards = e2e.all(".session-creator-provider-card");
    return cards[cards.length - 1].classList.contains("selected");
  `);
  for (let i = 0; i < 6; i++) {
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
}

/** Give the terminal keyboard focus inside the page. */
async function focusTerminal(bridge, sessionId) {
  return bridge.eval(`
    const host = document.querySelector('div[data-session-id="' + CSS.escape(${JSON.stringify(sessionId)}) + '"]');
    const ta = host && host.querySelector("textarea.xterm-helper-textarea");
    if (!ta) throw new Error("terminal has no input element");
    ta.focus();
    return { focused: document.activeElement === ta, pageHasFocus: document.hasFocus() };
  `);
}

/** Where to click to put keyboard focus in the terminal (page coordinates). */
async function terminalCenter(bridge, sessionId) {
  return bridge.eval(`
    const host = document.querySelector('div[data-session-id="' + CSS.escape(${JSON.stringify(sessionId)}) + '"]');
    const r = host.querySelector(".xterm-screen").getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + Math.min(r.height / 2, 120)),
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
    };
  `);
}

/** Press chords with DOM key events on the terminal's input element. */
async function domChords(bridge, sessionId, chords) {
  return bridge.eval(`
    const host = document.querySelector('div[data-session-id="' + CSS.escape(${JSON.stringify(sessionId)}) + '"]');
    const ta = host.querySelector("textarea.xterm-helper-textarea");
    ta.focus();
    const out = [];
    for (const chord of ${JSON.stringify(chords)}) {
      const parts = chord.split("+");
      const letter = parts[parts.length - 1];
      const shift = parts.includes("shift");
      const init = {
        key: shift ? letter.toUpperCase() : letter,
        code: "Key" + letter.toUpperCase(),
        ctrlKey: parts.includes("ctrl"),
        shiftKey: shift,
        altKey: parts.includes("alt"),
        bubbles: true, cancelable: true, composed: true, view: window,
      };
      const make = (type) => {
        const ev = new KeyboardEvent(type, init);
        const code = letter.toUpperCase().charCodeAt(0);
        Object.defineProperty(ev, "keyCode", { get: () => code });
        Object.defineProperty(ev, "which", { get: () => code });
        return ev;
      };
      const notConsumed = ta.dispatchEvent(make("keydown"));
      ta.dispatchEvent(make("keyup"));
      out.push({ chord, consumedByPage: !notConsumed });
      await new Promise((r) => setTimeout(r, 60));
    }
    return out;
  `, { timeoutMs: 30_000 });
}

let app;
let failed = false;
let commandDir = null;
const details = { mode: OS_KEYS ? "os-keys" : "dom-keys", platformRules: EFFECTIVE };

try {
  log(`scenario: ${SCENARIO}   platform: ${platform()}   keyboard rules: ${EFFECTIVE}${EMULATE ? " (emulated)" : ""}   input: ${OS_KEYS ? "REAL OS key presses" : "DOM key events"}`);
  if (OS_KEYS && !osKeysAvailable()) {
    throw new Error("HERMES_E2E_OS_KEYS=1 needs a Linux or Windows CI runner (CI=true); never on macOS");
  }
  if (OS_KEYS && EMULATE) throw new Error("HERMES_E2E_PLATFORM cannot be combined with real OS key presses");

  // ── 1. Launch with the keylogger command on PATH ─────────────────
  mkdirSync(evidenceDir, { recursive: true });
  const keylog = join(evidenceDir, "keylog.txt");
  rmSync(keylog, { force: true });

  commandDir = mkdtempSync(join(tmpdir(), "hermes-f05-"));
  installKeyloggerCommand(commandDir, keylog);

  log("step 1: launch the test app");
  app = await launchApp({ runDir: join(evidenceDir, "run"), log, home: process.env.HERMES_E2E_HOME || undefined });
  const { bridge } = app;

  if (EMULATE) {
    log(`  switching the frontend to ${EMULATE} keyboard rules and reloading`);
    await bridge.eval(`localStorage.setItem("hermes-e2e-platform", ${JSON.stringify(EMULATE)}); setTimeout(() => location.reload(), 50); return true;`);
    await sleep(1500);
    await bridge.waitFor("the app UI to render again", `
      return document.readyState === "complete" && !!document.getElementById("root")?.firstElementChild && !!window.__HERMES_E2E__;
    `, { timeoutMs: 30_000 });
  }

  const appLog = readFileSync(app.appLog, "utf8");
  assert(!/Failed to (build app menu|set menu)/.test(appLog), "the native menu bar was built and installed");

  // ── 2. First-launch welcome ──────────────────────────────────────
  log("step 2: go through the first-launch welcome screens");
  await bridge.waitFor("the welcome dialog", `return !!e2e.first(".onboarding-dialog");`, { timeoutMs: 30_000 });
  for (const screen of ["welcome", "theme", "AI tools"]) {
    const clicked = await bridge.click(".onboarding-actions .onboarding-btn-primary");
    log(`  ${screen}: clicked "${clicked.clicked}"`);
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
  if (await bridge.exists(".whatsnew-backdrop")) {
    await bridge.click(".whatsnew-footer .whatsnew-btn-primary");
    await bridge.waitFor("the what's-new dialog to close", `return !e2e.first(".whatsnew-backdrop");`);
  }

  // ── 3. A terminal running the keylogger ──────────────────────────
  log("step 3: create a plain terminal and start the keylogger in it");
  const before = await bridge.terminalIds();
  await bridge.click("button.es-tile-primary");
  await pickPlainShellAndCreate(bridge, "first terminal");
  const sessionId = await bridge.waitFor("a terminal to appear", `
    const ids = window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(before)}.includes(id));
    return ids.length === 1 ? ids[0] : null;
  `, { timeoutMs: 20_000 });
  await bridge.waitFor("the shell to print its prompt", `
    const lines = window.__HERMES_E2E__.readTerminal(${JSON.stringify(sessionId)}) || [];
    const info = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(sessionId)});
    return info && info.opened && lines.some((l) => l.trim().length > 0);
  `, { timeoutMs: 30_000 });
  await sleep(1000);
  // cd into the command's folder first: the shell may not keep a PATH the
  // app was started with (PowerShell on Windows rebuilds it).
  const runKeylogger =
    platform() === "win32" ? `cd "${commandDir}"; .\\hermeskeylog\n` : `cd '${commandDir}' && ./hermeskeylog\n`;
  await bridge.typeInTerminal(sessionId, runKeylogger);
  await bridge.waitForTerminal(sessionId, /^KEYLOG READY/, { timeoutMs: 20_000 });
  log("  keylogger is running");
  const start = await bridge.eval(FINGERPRINT);
  log(`  app state: ${JSON.stringify(start)}`);

  // ── 4. Ctrl+letter goes to the program, not to the app ───────────
  // One key at a time, so a key the app takes is named, and the check stops
  // before later keys land somewhere else.
  log(`step 4: press Ctrl+${LETTERS.map((l) => l.toUpperCase()).join(" Ctrl+")} in the focused terminal, one at a time`);
  const focus = await focusTerminal(bridge, sessionId);
  log(`  terminal input focused=${focus.focused}, page has focus=${focus.pageHasFocus}`);
  const verdicts = [];
  for (const letter of LETTERS) {
    const chord = `ctrl+${letter}`;
    const had = keylogBytes(keylog).length;
    if (OS_KEYS) {
      const diag = await pressChords(app.child.pid, [chord], { clickAt: await terminalCenter(bridge, sessionId) });
      if (verdicts.length === 0) log(`  real key presses go to: ${JSON.stringify(diag)}`);
    } else {
      await domChords(bridge, sessionId, [chord]);
    }
    const bytes = await waitForBytes(keylog, had + 1, 3_000);
    const state = await bridge.eval(FINGERPRINT);
    const changed = JSON.stringify(state) !== JSON.stringify(start);
    const verdict = {
      key: `Ctrl+${letter.toUpperCase()}`,
      expected: ctrlByte(letter),
      received: bytes.slice(had),
      appChanged: changed ? state : null,
    };
    verdicts.push(verdict);
    log(`  ${verdict.key}: program got ${verdict.received.map((b) => "0x" + b).join(" ") || "nothing"}${changed ? `; APP CHANGED: ${JSON.stringify(state)}` : ""}`);
    if (changed) break; // later keys would land in whatever the app opened
  }
  details.verdicts = verdicts;
  const taken = verdicts.filter((v) => v.received.join(" ") !== v.expected || v.appChanged);
  const expected = LETTERS.map(ctrlByte);
  const final = keylogBytes(keylog);
  log(`  keylogger received: ${final.join(" ")}`);
  log(`  expected:           ${expected.join(" ")}`);
  assert(
    taken.length === 0 && verdicts.length === LETTERS.length,
    `every Ctrl+letter reached the program byte for byte and ran no app action` +
      (taken.length ? ` — NOT: ${taken.map((v) => v.key).join(", ")}` : ""),
  );
  assert(final.join(" ") === expected.join(" "), "the program received exactly those bytes, nothing extra");
  log("  terminal content:");
  for (const l of ((await bridge.readTerminal(sessionId)) ?? []).slice(-6)) log(`    | ${l}`);
  await bridge.screenshot(join(evidenceDir, "01-ctrl-letters-reached-the-program.png"));

  // ── 5. The Shortcuts panel shows this platform's chords ──────────
  log("step 5: open the Shortcuts panel from the status bar");
  await bridge.click(".status-shortcuts-btn");
  await bridge.waitFor("the Shortcuts panel", `return !!e2e.first(".shortcuts-panel");`);
  const rows = await bridge.eval(`
    return e2e.all(".shortcuts-row").map((r) => ({
      id: r.dataset.shortcutId ?? "",
      action: e2e.norm(r.querySelector(".shortcuts-action")?.innerText),
      keys: e2e.norm(r.querySelector(".shortcuts-kbd")?.innerText),
    }));
  `);
  for (const r of rows) log(`    ${r.action.padEnd(28)} ${r.keys}`);
  // By id: an earlier scenario may have left the interface in another language.
  const split = rows.find((r) => r.id === "view.split-horizontal");
  assert(!!split, `the panel lists the split shortcut ("${split?.action}")`);
  assert(split.keys === (PC ? "Ctrl+Shift+D" : "⌘D"), `split shows ${PC ? "Ctrl+Shift+D" : "⌘D"} (shows "${split.keys}")`);
  if (PC) {
    const bare = rows.filter((r) => /(^|\/ )Ctrl\+[A-Z]($| )/.test(r.keys));
    assert(bare.length === 0, `no shortcut asks for a bare Ctrl+letter (${bare.map((r) => r.keys).join(", ") || "none"})`);
  }
  await bridge.screenshot(join(evidenceDir, "02-shortcuts-panel.png"));
  await bridge.click(".shortcuts-close");
  await bridge.waitFor("the Shortcuts panel to close", `return !e2e.first(".shortcuts-panel");`);

  // ── 6. Ctrl+Shift+D splits the pane (Windows/Linux) ──────────────
  if (PC) {
    log("step 6: press Ctrl+Shift+D in the focused terminal — it must split the pane");
    await focusTerminal(bridge, sessionId);
    if (OS_KEYS) {
      log(`  real key presses sent: ${JSON.stringify(await pressChords(app.child.pid, ["ctrl+shift+d"], { clickAt: await terminalCenter(bridge, sessionId) }))}`);
    } else {
      await domChords(bridge, sessionId, ["ctrl+shift+d"]);
    }
    await bridge.waitFor("the split's New Session wizard", `return !!e2e.first(".session-creator");`, { timeoutMs: 15_000 });
    assert(true, "Ctrl+Shift+D opened the split's New Session wizard");
    const extra = keylogBytes(keylog).slice(expected.length);
    assert(extra.length === 0, `Ctrl+Shift+D did not reach the program (extra bytes: ${extra.join(" ") || "none"})`);
    await bridge.screenshot(join(evidenceDir, "03-split-wizard.png"));
    const beforeSplit = await bridge.terminalIds();
    await pickPlainShellAndCreate(bridge, "split");
    await bridge.waitFor("a second terminal", `
      return window.__HERMES_E2E__.terminalIds().filter((id) => !${JSON.stringify(beforeSplit)}.includes(id)).length === 1;
    `, { timeoutMs: 20_000 });
    await bridge.waitFor("two panes side by side", `return e2e.all(".split-pane").length === 2;`, { timeoutMs: 15_000 });
    await sleep(800);
    const panes = await bridge.eval(`return e2e.all(".split-pane").length;`);
    assert(panes === 2, `the pane split exactly once (${panes} panes)`);
    await bridge.screenshot(join(evidenceDir, "04-split-done.png"));
  } else {
    log("step 6: macOS — app chords stay Cmd chords (native menu); Ctrl+Shift+D runs nothing, as before");
    await domChords(bridge, sessionId, ["ctrl+shift+d"]);
    await sleep(1000);
    const extra = keylogBytes(keylog).slice(expected.length);
    assert(extra.length === 0, `Ctrl+Shift+D sent nothing to the program (got ${extra.join(" ") || "nothing"})`);
    const end = await bridge.eval(FINGERPRINT);
    assert(JSON.stringify(end) === JSON.stringify(start), "Ctrl+Shift+D ran no app action on macOS (no split, no dialog)");
  }
} catch (e) {
  failed = true;
  log(`FAILED: ${e?.stack ?? e}`);
  try {
    if (app?.isRunning()) {
      await app.bridge.screenshot(join(evidenceDir, "99-failure.png"));
      const dump = await app.bridge.eval(`
        return {
          focus: document.activeElement?.className ?? null,
          pageHasFocus: document.hasFocus(),
          dialogs: [...document.querySelectorAll('[class*="backdrop"],[class*="overlay"],.session-creator')].map((e) => e.className),
          terminals: window.__HERMES_E2E__?.terminalIds() ?? [],
        };
      `);
      log(`  what the app showed: ${JSON.stringify(dump)}`);
    }
  } catch (inner) {
    log(`  (could not capture failure evidence: ${inner.message})`);
  }
} finally {
  if (app) {
    log("step 7: quit the app");
    const exit = await app.stop();
    log(`  app exited: ${JSON.stringify(exit)}`);
    if (!failed && (exit.forced || exit.code !== 0)) {
      failed = true;
      log("FAILED: the app did not quit cleanly");
    }
  }
  // After the app (and its shells, which sat in this folder) are gone.
  if (commandDir) {
    try {
      rmSync(commandDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (err) {
      log(`  (could not remove ${commandDir}: ${err.message})`);
    }
  }
}

finishScenario({ scenario: SCENARIO, evidenceDir, failed, startedAt, log, details });
