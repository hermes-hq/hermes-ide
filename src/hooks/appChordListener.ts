import { isTerminalFocused, matchAppChord, pcLetterChord } from "../utils/keymap";
import type { Platform } from "../utils/platform";

/** The text-editing chords of every Windows/Linux text field (undo, redo,
 *  select all, cut, copy, paste): never an app chord there (XP-08). */
const EDITING_CHORDS = new Set([
  "{ctrl}Z",
  "{ctrl}{shift}Z",
  "{ctrl}Y",
  "{ctrl}A",
  "{ctrl}X",
  "{ctrl}C",
  "{ctrl}V",
  "{ctrl}{shift}V",
]);

/** A text field, a text area or editable content (not a terminal). */
export function isTextEditingTarget(el: Element | null | undefined): boolean {
  if (!el || isTerminalFocused(el)) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    const type = ((el as HTMLInputElement).type || "text").toLowerCase();
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(type);
  }
  return (el as HTMLElement).isContentEditable === true;
}

/**
 * Windows/Linux keydown handler for app chords (see utils/keymap.ts).
 * Runs `run(actionId)` and consumes the event when the key is an app chord
 * for where focus is; leaves every other key alone. Returns whether it ran.
 */
export function handleAppChordKeydown(
  e: KeyboardEvent,
  platform: Platform,
  run: (actionId: string) => void,
): boolean {
  if (e.defaultPrevented || e.repeat) return false;
  const target = e.target instanceof Element ? e.target : document.activeElement;
  if (isTextEditingTarget(target)) {
    const chord = pcLetterChord(e);
    if (chord && EDITING_CHORDS.has(chord)) return false;
  }
  const action = matchAppChord(e, platform, isTerminalFocused(target));
  if (!action) return false;
  e.preventDefault();
  e.stopPropagation();
  run(action);
  return true;
}

/** Install the app chord handler on a window. Returns the cleanup. */
export function installAppChordListener(
  win: Window,
  platform: Platform,
  run: (actionId: string) => void,
): () => void {
  if (platform === "mac") return () => {};
  const handler = (e: KeyboardEvent) => {
    handleAppChordKeydown(e, platform, run);
  };
  win.addEventListener("keydown", handler);
  return () => win.removeEventListener("keydown", handler);
}
