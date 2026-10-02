// One overlay at a time: the attention inbox, the command palette, the ⌘N
// task launcher, Settings, Keyboard Shortcuts, the cost dashboard and the
// classic New Session wizard.
//
// The rule, in one place: opening one of them closes the others. Each
// overlay calls `overlayOpened` when it opens, with how to close it, and the
// returned function when it closes. Before this, ⌘⇧P over the open inbox drew
// the palette on top of it, with both listening to the keyboard, and the
// Keyboard Shortcuts panel opened behind Settings while the keyboard stayed
// in the terminal behind both. The launcher keeps its draft when another
// overlay closes it.
//
// While one is open, the menu's window keys act on it rather than on the
// workspace behind it (see useNativeMenuEvents): ⌘W closes it, and the keys
// that would split or add a pane are ignored.

import { useEffect, useRef } from "react";

export type OverlayId = "inbox" | "palette" | "launcher" | "settings" | "shortcuts" | "cost" | "creator";

/**
 * An overlay whose open state lives in a parent (Settings, Keyboard
 * Shortcuts, the cost dashboard, the New Session wizard): it joins the rule
 * while `open`, and `close` is how another overlay opening closes it.
 */
export function useOverlay(id: OverlayId, open: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    return overlayOpened(id, () => closeRef.current());
  }, [id, open]);
}

const open = new Map<OverlayId, () => void>();

/**
 * `id` has opened: every other overlay is closed (through its own close), and
 * `close` is how `id` is closed when another one opens. Returns the function
 * to call when `id` closes by itself.
 */
export function overlayOpened(id: OverlayId, close: () => void): () => void {
  for (const [other, closeOther] of [...open]) {
    if (other === id) continue;
    open.delete(other);
    closeOther();
  }
  open.set(id, close);
  return () => {
    if (open.get(id) === close) open.delete(id);
  };
}

/** The overlays open now (for tests). */
export function openOverlays(): OverlayId[] {
  return [...open.keys()];
}

/** The overlay on top (the last one opened), or null when none is open. */
export function topOverlay(): OverlayId | null {
  const ids = [...open.keys()];
  return ids.length ? ids[ids.length - 1] : null;
}

/** Closes the overlay on top, as its own close would (the launcher keeps its draft). False when none is open. */
export function closeTopOverlay(): boolean {
  const id = topOverlay();
  if (!id) return false;
  const close = open.get(id);
  open.delete(id);
  close?.();
  return true;
}
