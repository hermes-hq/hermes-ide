// Shortcut helpers.
//
// - visibleShortcutGroups: shared by ShortcutsPanel and the Settings
//   "Shortcuts" tab; both render src/generated/shortcuts.ts, filtered to the
//   shortcuts that actually apply on the current platform.
// - matchAppShortcut: the ONLY way App.tsx's global keydown handler recognises
//   its own (non-menu) shortcuts, so the bindings it acts on are exactly the
//   ones declared in src/shortcuts/app-shortcuts.json, which the generator
//   also lists in the panel and docs/shortcuts.md.
import { isMac } from "./platform";
import type { GeneratedShortcutGroup } from "../generated/shortcuts";
import appShortcuts from "../shortcuts/app-shortcuts.json";

/**
 * The generated groups as this platform sees them: shortcuts that only exist
 * on the other platform family are dropped, and `keys` is this platform's
 * chord (the Windows/Linux one can differ from the macOS one).
 */
export function visibleShortcutGroups(groups: GeneratedShortcutGroup[], mac: boolean = isMac): GeneratedShortcutGroup[] {
  return groups
    .map((group) => ({
      ...group,
      shortcuts: group.shortcuts
        .filter((s) => !s.platform || (s.platform === "macos" ? mac : !mac))
        .map((s) => (!mac && s.pcKeys ? { ...s, keys: s.pcKeys } : s)),
    }))
    .filter((group) => group.shortcuts.length > 0);
}

export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

interface ParsedAccelerator {
  mod: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** Accepted `KeyboardEvent.key` values, lower-cased. */
  keys: string[];
}

const NAMED_KEYS: Record<string, string> = {
  left: "arrowleft",
  right: "arrowright",
  up: "arrowup",
  down: "arrowdown",
};

/**
 * Parse a Tauri-style accelerator ("CmdOrCtrl+Alt+Right"). A key written as
 * a range of two single characters ("1-9") accepts every character in it.
 */
export function parseAccelerator(accelerator: string): ParsedAccelerator {
  const tokens = accelerator.split("+");
  const key = tokens.pop() ?? "";
  const mods = new Set(tokens.map((t) => t.toLowerCase()));
  let keys: string[];
  const range = /^(.)-(.)$/.exec(key);
  if (range) {
    keys = [];
    for (let c = range[1].charCodeAt(0); c <= range[2].charCodeAt(0); c++) keys.push(String.fromCharCode(c));
  } else {
    keys = [NAMED_KEYS[key.toLowerCase()] ?? key.toLowerCase()];
  }
  return {
    mod: mods.has("cmdorctrl") || mods.has("cmd"),
    ctrl: mods.has("ctrl"),
    shift: mods.has("shift"),
    alt: mods.has("alt"),
    keys,
  };
}

/**
 * True when the event is this accelerator: the key matches (case-insensitive,
 * like the handler always did), the platform's action modifier (⌘ on macOS,
 * Ctrl elsewhere) is held when required, and Shift / Alt are held exactly
 * when the accelerator names them.
 */
export function matchesAccelerator(e: KeyEventLike, accelerator: string, mac: boolean = isMac): boolean {
  const a = parseAccelerator(accelerator);
  if (mac) {
    if (a.mod !== e.metaKey) return false;
    if (a.ctrl && !e.ctrlKey) return false;
  } else if ((a.mod || a.ctrl) !== e.ctrlKey) {
    return false;
  }
  if (a.shift !== e.shiftKey || a.alt !== e.altKey) return false;
  return a.keys.includes(e.key.toLowerCase());
}

export interface AppShortcut {
  id: string;
  group: string;
  label: string;
  accelerators: string[];
  /** Windows/Linux accelerators when they differ from `accelerators` (a
   *  terminal owns Ctrl+letter there, so an app chord adds Shift). */
  pcAccelerators?: string[];
  note?: string;
}

export const APP_SHORTCUTS: AppShortcut[] = appShortcuts.shortcuts;

/** The id of the declared app shortcut this key event triggers, if any. */
export function matchAppShortcut(e: KeyEventLike, mac: boolean = isMac, shortcuts: AppShortcut[] = APP_SHORTCUTS): string | null {
  for (const s of shortcuts) {
    const accelerators = !mac && s.pcAccelerators ? s.pcAccelerators : s.accelerators;
    if (accelerators.some((acc) => matchesAccelerator(e, acc, mac))) return s.id;
  }
  return null;
}
