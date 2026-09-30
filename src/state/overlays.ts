// One overlay at a time: the attention inbox, the command palette and the
// ⌘N task launcher.
//
// The rule, in one place: opening one of them closes the others. Each
// overlay calls `overlayOpened` when it opens, with how to close it, and the
// returned function when it closes. Before this, ⌘⇧P over the open inbox drew
// the palette on top of it, with both listening to the keyboard.

export type OverlayId = "inbox" | "palette" | "launcher";

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
