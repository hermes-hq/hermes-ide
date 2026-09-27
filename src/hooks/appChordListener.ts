import { isTerminalFocused, matchAppChord } from "../utils/keymap";
import type { Platform } from "../utils/platform";

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
