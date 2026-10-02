// Shared steps for the QA-host-* scenarios (session host, PTY, agent
// signals, terminal keys and clipboard, quit, Agent view): an app with the
// fake agents on PATH, a fake Claude Code that blocks for real (its
// PermissionRequest hook), Windows/Linux keyboard rules on a Mac, a key
// logger in a terminal, and a clipboard the page cannot reach.

import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, sleep } from "./harness.mjs";
import * as L from "./launcher-steps.mjs";
import { classifyProbe, commandLine, probeCommand, PROBE_OUTPUT } from "./shells.mjs";

export const onWindows = platform() === "win32";

/**
 * The keyboard rules a Windows/Linux scenario runs with: natively on those
 * runners, emulated in the frontend on a Mac (HERMES_E2E_PLATFORM, or
 * `fallback` when unset).
 */
export function pcRules(fallback = "linux") {
  if (platform() !== "darwin") return null;
  return process.env.HERMES_E2E_PLATFORM || fallback;
}

/** Switch the frontend to Windows/Linux keyboard rules (test builds only). */
export async function emulatePlatform(bridge, rules, log) {
  if (!rules) return;
  log(`  frontend keyboard rules -> ${rules}`);
  await bridge.eval(`localStorage.setItem("hermes-e2e-platform", ${JSON.stringify(rules)}); return true;`);
  await bridge.reload();
  await bridge.waitFor(
    "the app UI to render again",
    `return document.readyState === "complete" && !!document.getElementById("root")?.firstElementChild && !!window.__HERMES_E2E__;`,
    { timeoutMs: 30_000 },
  );
}

/** A fresh app with the fake agents (launcher fixtures), past onboarding. */
export async function startApp(tag, evidenceDir, log, onCleanup, apps, launchOpts = {}) {
  const fx = L.launcherFixtures(tag, log);
  onCleanup(() => fx.cleanup());
  // Windows terminals rebuild PATH from the registry (see N12): the fake
  // agents must be on it there too (CI runners only).
  const undoPath = fx.addFakeBinToRegistryPath();
  if (undoPath) onCleanup(undoPath);
  const app = await fx.launch(evidenceDir, 1, { first: true, ...launchOpts });
  apps.push(app);
  await L.completeClassicOnboarding(app.bridge);
  return { fx, app, bridge: app.bridge };
}

/** A fake Claude Code session in `cwd`; waits for its launch record. */
export async function claude(bridge, fx, cwd, label, n) {
  const id = await bridge.eval(`return await window.__HERMES_E2E__.launchWithChoice(${JSON.stringify({ agentId: "claude", cwd, label })});`, { timeoutMs: 30_000 });
  await fx.waitForRecords(n);
  return id;
}

/** Type into a session through the backend (as a person typing). */
export const write = (bridge, id, data) =>
  bridge.eval(`await window.__TAURI_INTERNALS__.invoke("write_to_session", { sessionId: ${JSON.stringify(id)}, data: btoa(${JSON.stringify(data)}) }); return true;`);

/** The fake agent asks permission (key "p": its PermissionRequest hook). */
export async function block(bridge, id) {
  await write(bridge, id, "p");
  await bridge.waitFor("needs approval", `return window.__HERMES_E2E__.sessionStatus(${JSON.stringify(id)}).kind === "needs_approval";`, { timeoutMs: 15_000 });
}

export const status = (bridge, id) => bridge.eval(`return window.__HERMES_E2E__.sessionStatus(${JSON.stringify(id)});`);

/** Quit, wait for the quit question, and press one of its buttons. */
export async function quitAnswering(bridge, button, log) {
  await bridge.quit();
  await bridge.waitFor("the quit question", `return !!e2e.first('[data-testid="quit-with-agents-dialog"]');`, { timeoutMs: 10_000 });
  log?.(`  quit question: ${await bridge.eval(`return e2e.norm(e2e.first('[data-testid="quit-with-agents-dialog"]').innerText);`)}`);
  await bridge.click(`[data-testid="quit-with-agents-dialog"] .quit-dialog-btn-${button}`);
}

/**
 * Quit and report the quit question's text, or null when the app quit
 * without asking. Answers nothing: the caller decides.
 */
export async function quitAndReadQuestion(app, timeoutMs = 8000) {
  await app.bridge.quit();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && app.isRunning()) {
    const text = await app.bridge
      .eval(`return e2e.norm(e2e.first('[data-testid="quit-with-agents-dialog"]')?.innerText || "") || null;`, { timeoutMs: 2000 })
      .catch(() => null);
    if (text) return text;
    await sleep(200);
  }
  return null;
}

export const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

/** A plain shell session via the e2e hook; waits for its prompt. */
export async function newTerminal(bridge, label, cwd) {
  const id = await bridge.eval(`return await window.__HERMES_E2E__.newTerminal(${JSON.stringify({ label, cwd })});`, { timeoutMs: 30_000 });
  if (!id) throw new Error(`newTerminal(${label}) returned nothing`);
  await bridge.waitFor(`terminal ${label} to print its prompt`, `
    const lines = window.__HERMES_E2E__.readTerminal(${JSON.stringify(id)}) || [];
    const info = window.__HERMES_E2E__.terminalInfo(${JSON.stringify(id)});
    return info && info.opened && lines.some((l) => l.trim().length > 0);
  `, { timeoutMs: 30_000 });
  return id;
}

/** `hermeskeylog` (records every byte a program gets) in a fresh folder. */
export function installKeylogger() {
  const dir = mkdtempSync(join(tmpdir(), "hermes-e2e-keys-"));
  const out = join(dir, "keys.log");
  const script = join(REPO_ROOT, "e2e", "app", "fixtures", "keylogger.mjs");
  if (onWindows) {
    writeFileSync(join(dir, "hermeskeylog.cmd"), `@"${process.execPath}" "${script}" "${out}"\r\n`);
  } else {
    const file = join(dir, "hermeskeylog");
    writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" "${out}"\n`);
    chmodSync(file, 0o755);
  }
  return { dir, out };
}

export function keylogBytes(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\s+/).filter(Boolean);
}

export async function startKeylogger(bridge, sessionId, kl) {
  const run = onWindows ? `& '${join(kl.dir, "hermeskeylog.cmd")}'\n` : `cd '${kl.dir}' && ./hermeskeylog\n`;
  await bridge.typeInTerminal(sessionId, run);
  await bridge.waitForTerminal(sessionId, /^KEYLOG READY/, { timeoutMs: 20_000 });
}

/**
 * One keydown+keyup on a session's xterm input, with a real keyCode (xterm
 * reads keyCode). Returns whether the page consumed it.
 */
export async function domKey(bridge, sessionId, init, keyCode) {
  return bridge.eval(`
    const host = document.querySelector('div[data-session-id="' + CSS.escape(${JSON.stringify(sessionId)}) + '"]');
    const ta = host.querySelector("textarea.xterm-helper-textarea");
    ta.focus();
    const init = Object.assign({ bubbles: true, cancelable: true, composed: true, view: window }, ${JSON.stringify(init)});
    const make = (type) => {
      const ev = new KeyboardEvent(type, init);
      Object.defineProperty(ev, "keyCode", { get: () => ${keyCode} });
      Object.defineProperty(ev, "which", { get: () => ${keyCode} });
      return ev;
    };
    const notConsumed = ta.dispatchEvent(make("keydown"));
    ta.dispatchEvent(make("keyup"));
    return { consumedByPage: !notConsumed, active: document.activeElement?.className ?? null };
  `);
}

/** Sidebar order, the active row and the focused terminal. */
export function sidebarState(bridge) {
  return bridge.eval(`
    const items = e2e.all(".session-item");
    return {
      labels: items.map((el) => e2e.norm(el.innerText).split(" ")[0]),
      active: items.findIndex((el) => el.classList.contains("session-item-active")),
      focused: window.__HERMES_E2E__.focusedSessionId(),
    };
  `);
}

/** Record clipboard writes in the page instead of touching the real clipboard. */
export function trapClipboard(bridge) {
  return bridge.eval(`
    window.__QA_CLIP__ = [];
    const rec = (kind) => async (v) => { window.__QA_CLIP__.push({ kind, text: typeof v === "string" ? v : "[blob]" }); };
    try { navigator.clipboard.writeText = rec("writeText"); } catch {}
    try { navigator.clipboard.write = rec("write"); } catch {}
    return typeof navigator.clipboard.writeText;
  `);
}

export const clipWrites = (bridge) => bridge.eval(`return window.__QA_CLIP__ || [];`);

/**
 * Triple-click the last terminal row matching `pattern` (a RegExp source)
 * with the mouse, as a person selects a line; returns what a copy of the
 * selection would hold.
 */
export function selectLine(bridge, sessionId, pattern) {
  return bridge.eval(`
    const host = document.querySelector('div[data-session-id="' + CSS.escape(${JSON.stringify(sessionId)}) + '"]');
    const screen = host?.querySelector(".xterm-screen");
    if (!screen) return null;
    const r = screen.getBoundingClientRect();
    const opts = (x, y, buttons) => ({ bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons });
    const rows = Math.max(1, window.__HERMES_E2E__.terminalInfo(${JSON.stringify(sessionId)})?.rows || 24);
    const cellH = r.height / rows;
    // The rows on screen (the buffer's last rows), not joined: a long
    // prompt wraps, and scrollback sits above the screen.
    const lines = window.__HERMES_E2E__.terminalTail(${JSON.stringify(sessionId)}, rows) || [];
    const re = new RegExp(${JSON.stringify(pattern)});
    let row = -1;
    for (let i = lines.length - 1; i >= 0; i--) if (re.test(lines[i])) { row = i; break; }
    if (row < 0) return null;
    const y = r.top + cellH * (row + 0.5);
    for (const detail of [1, 2, 3]) {
      screen.dispatchEvent(new MouseEvent("mousedown", { ...opts(r.left + 20, y, 1), detail }));
      document.dispatchEvent(new MouseEvent("mouseup", { ...opts(r.left + 20, y, 0), detail }));
    }
    await new Promise((res) => setTimeout(res, 200));
    const dt = new DataTransfer();
    host.dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true }));
    return dt.getData("text/plain");
  `);
}

/** The New Session wizard: a plain shell, through to Create (from F05). */
export async function pickPlainShellAndCreate(bridge, what, log = () => {}) {
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

/** Run `node <script> <args>` in a terminal, in whatever shell it has. */
export async function runNodeIn(bridge, sessionId, script, args = []) {
  await bridge.typeInTerminal(sessionId, `${probeCommand()}\n`);
  const { line } = await bridge.waitForTerminal(sessionId, PROBE_OUTPUT, { timeoutMs: 30_000 });
  const shell = classifyProbe(line);
  await bridge.typeInTerminal(sessionId, `${commandLine(shell, process.execPath, [script, ...args])}\n`);
  return shell;
}
