// ─── App Keymap ─────────────────────────────────────────────────────
//
// Which key chord runs which app action, per platform. The same table
// (keymap.json) drives the native menu accelerators in Rust, so the menu,
// the Shortcuts panel and the keyboard always agree.
//
// Windows/Linux rule: a terminal owns Ctrl+letter (Ctrl+D is end-of-input,
// Ctrl+W deletes a word, Ctrl+E jumps to the end of the line, ...). App
// chords there are Ctrl+Shift+letter, like Windows Terminal. The older
// Ctrl+letter chords still work while no terminal has keyboard focus.
//
// macOS is unchanged: app chords use Cmd and never collide with Ctrl.

import keymapData from "./keymap.json";
import { PLATFORM, formatChord, type Platform } from "./platform";

export interface AppChord {
  /** Native menu item id / menu action id. */
  action: string;
  /** macOS chord, canonical tokens ({mod} = Cmd). */
  mac: string;
  /** Windows/Linux chord. Never a bare Ctrl+letter. */
  pc: string;
  /** Windows/Linux: legacy Ctrl+letter chord, honoured only outside a terminal. */
  pcOutsideTerminal?: string;
}

export const APP_CHORDS: readonly AppChord[] = keymapData.chords;

/**
 * Chords handled by the app's own keyboard listener rather than the menu.
 * They must also be kept away from the terminal on Windows/Linux.
 */
const EXTRA_PC_APP_CHORDS = ["{ctrl}{shift}P", "{ctrl}{shift}J"];

const byAction = new Map(APP_CHORDS.map((c) => [c.action, c]));

/** Canonical chord for an action on a platform (null if it has none). */
export function chordFor(action: string, platform: Platform = PLATFORM): string | null {
  const entry = byAction.get(action);
  if (!entry) return null;
  return platform === "mac" ? entry.mac : entry.pc;
}

/** Human-readable chord for an action ("⌘D", "Ctrl+Shift+D"), or "". */
export function shortcutLabel(action: string, platform: Platform = PLATFORM): string {
  const chord = chordFor(action, platform);
  return chord ? formatChord(chord, platform) : "";
}

interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * Canonical Windows/Linux chord for a key event with a letter key, e.g.
 * "{ctrl}{shift}D". The letter is the one the keyboard layout produces
 * (`key`), like the native menu accelerators, so on AZERTY or Dvorak the
 * chord sits where its letter is printed. Only when the layout produces no
 * Latin letter (Cyrillic, Greek, ...) does the physical key (`code`) decide.
 * Returns null for anything that is not Ctrl(+Shift)+letter.
 */
export function pcLetterChord(e: KeyLike): string | null {
  if (!e.ctrlKey || e.altKey || e.metaKey) return null;
  const fromKey = /^[a-z]$/i.test(e.key) ? e.key.toUpperCase() : undefined;
  const letter = fromKey ?? (e.code ? /^Key([A-Z])$/.exec(e.code)?.[1] : undefined);
  if (!letter) return null;
  return `{ctrl}${e.shiftKey ? "{shift}" : ""}${letter}`;
}

/**
 * Windows/Linux: the app action a Ctrl(+Shift)+letter key event should run,
 * or null when the key belongs to whatever has focus (e.g. the terminal).
 * macOS returns null: the native menu owns the Cmd chords there.
 */
export function matchAppChord(e: KeyLike, platform: Platform, focusInTerminal: boolean): string | null {
  if (platform === "mac") return null;
  const chord = pcLetterChord(e);
  if (!chord) return null;
  for (const c of APP_CHORDS) {
    if (c.pc === chord) return c.action;
  }
  if (focusInTerminal) return null;
  for (const c of APP_CHORDS) {
    if (c.pcOutsideTerminal === chord) return c.action;
  }
  return null;
}

/**
 * Windows/Linux: true when a key event inside a terminal is an app chord, so
 * the terminal must not turn it into a control character. Bare Ctrl+letter is
 * never an app chord inside a terminal.
 */
export function isAppChordInTerminal(e: KeyLike, platform: Platform): boolean {
  if (platform === "mac") return false;
  const chord = pcLetterChord(e);
  if (!chord) return false;
  return EXTRA_PC_APP_CHORDS.includes(chord) || APP_CHORDS.some((c) => c.pc === chord);
}

/** True when keyboard focus is inside a terminal. */
export function isTerminalFocused(el: Element | null | undefined): boolean {
  return !!el && typeof el.closest === "function" && !!el.closest(".xterm");
}
