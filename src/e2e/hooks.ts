/**
 * Test-only hooks for the automation bridge (src-tauri/src/e2e_bridge.rs).
 *
 * Loaded only when the frontend is built with VITE_HERMES_E2E=1, so normal
 * builds never contain this file. It exposes READ access to what the terminal
 * is showing — the terminal draws to a canvas, so its text is not in the DOM.
 * Everything else (clicking, typing) goes through the real DOM on purpose.
 * The one write is a crash switch, used to prove crash containment.
 */
import { pool, getFocusedSessionId } from "../terminal/pool";
import { armCrash } from "../components/CrashProbe";
import { loadedViews } from "../utils/lazyView";
import { getI18nSnapshot } from "../i18n/registry";

function readLines(sessionId: string): string[] | null {
  const entry = pool.get(sessionId);
  if (!entry) return null;
  const buffer = entry.terminal.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    // A wrapped row continues the previous logical line.
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const hooks = {
  /**
   * Make one part of the UI throw on its next render, once — to prove the
   * crash stays inside it. Targets: "pane:<sessionId>",
   * "block:<messageId>:<blockIndex>".
   */
  crash: (target: string): void => armCrash(target),
  /** On-demand views whose code has been fetched so far (e.g. "Settings"). */
  loadedViews: (): string[] => loadedViews(),
  /** Languages whose translations are in memory ("en" is built in). */
  loadedLanguages: (): string[] =>
    getI18nSnapshot()
      .languages.filter((l) => Object.keys(l.messages).length > 0)
      .map((l) => l.locale)
      .sort(),
  /** Session ids that currently have a terminal. */
  terminalIds: (): string[] => [...pool.keys()],
  /** The session whose terminal has keyboard focus inside the app. */
  focusedSessionId: (): string | null => getFocusedSessionId(),
  /** Logical lines of the terminal buffer (scrollback + screen). */
  readTerminal: (sessionId: string): string[] | null => readLines(sessionId),
  terminalInfo: (sessionId: string) => {
    const entry = pool.get(sessionId);
    if (!entry) return null;
    return {
      cols: entry.terminal.cols,
      rows: entry.terminal.rows,
      attached: entry.attached,
      opened: entry.opened,
      cwd: entry.cwd,
      phase: entry.sessionPhase,
    };
  },
};

export type HermesE2EHooks = typeof hooks;

(window as unknown as { __HERMES_E2E__?: HermesE2EHooks }).__HERMES_E2E__ = hooks;
