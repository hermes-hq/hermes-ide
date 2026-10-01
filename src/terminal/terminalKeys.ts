// ─── Terminal keys that belong to the app, and terminal copy/paste ────
//
// Pure decisions for the terminal's key handler (pool.ts), kept apart so
// they can be tested without xterm:
//
// - Windows/Linux: a key that is one of the app's declared shortcuts
//   (Ctrl+1..9 to switch sessions, Alt+Arrow to move between panes, ...) is
//   not terminal input. xterm would turn Ctrl+3..8 into ESC, FS, GS, RS, US
//   and DEL and stop the event, so the switcher never saw it (XP-01, XP-09).
// - Windows/Linux copy and paste, as in Windows Terminal, GNOME Terminal and
//   VS Code: Ctrl+Shift+C copies the selection, Ctrl+Shift+V and
//   Shift+Insert paste (XP-02). On Windows, Ctrl+C with text selected copies
//   it instead of interrupting the program (XP-03); a setting turns that off.
// - The terminal font size from settings, kept to sizes a terminal can draw
//   (a "0" in settings used to freeze the window: CHAOS-01).

import type { Platform } from "../utils/platform";
import { matchAppShortcut, type KeyEventLike } from "../utils/shortcuts";

export interface TerminalKeyEvent extends KeyEventLike {
  type: string;
  code?: string;
}

/** Windows/Linux: true when the key runs a declared app shortcut. */
export function isAppShortcutInTerminal(e: TerminalKeyEvent, platform: Platform): boolean {
  if (platform === "mac") return false;
  return matchAppShortcut(e, false) !== null;
}

export type TerminalClipboardAction = "copy" | "paste" | null;

/** The setting that makes Ctrl+C copy a selection (Windows/Linux). */
export const CTRL_C_COPIES_SETTING = "ctrl_c_copies_selection";

/** Whether Ctrl+C copies a selection: the setting, else on for Windows. */
export function ctrlCCopiesSelection(settings: Record<string, string | undefined>, platform: Platform): boolean {
  if (platform === "mac") return false;
  const value = settings[CTRL_C_COPIES_SETTING];
  if (value === "true") return true;
  if (value === "false") return false;
  return platform === "win";
}

function isLetter(e: TerminalKeyEvent, letter: string): boolean {
  return e.key.toLowerCase() === letter || e.code === `Key${letter.toUpperCase()}`;
}

/**
 * Windows/Linux: what a keydown in a terminal does with the clipboard, or
 * null when it is ordinary terminal input. macOS keeps ⌘C / ⌘V (the menu).
 */
export function terminalClipboardAction(
  e: TerminalKeyEvent,
  platform: Platform,
  hasSelection: boolean,
  ctrlCCopies: boolean,
): TerminalClipboardAction {
  if (platform === "mac" || e.type !== "keydown" || e.metaKey) return null;
  if (e.ctrlKey && e.shiftKey && !e.altKey) {
    if (isLetter(e, "c")) return "copy";
    if (isLetter(e, "v")) return "paste";
    return null;
  }
  if (!e.ctrlKey && e.shiftKey && !e.altKey && e.key === "Insert") return "paste";
  if (e.ctrlKey && !e.shiftKey && !e.altKey && isLetter(e, "c") && hasSelection && ctrlCCopies) return "copy";
  return null;
}

export const DEFAULT_FONT_SIZE = 14;
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 40;

/** The terminal font size a setting means, between 8 and 40 (default 14). */
export function parseFontSize(value: string | undefined | null): number {
  const n = parseInt(value ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_FONT_SIZE;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, n));
}
