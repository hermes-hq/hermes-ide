// ─── "Open in Library": another screen asks the Library to show an entry ─
//
// The Prompts palette sets what to show (and whether "Add as a command"
// should be open) and asks the app to open the Library; the Library takes
// it once, when it mounts or when it is asked again while open.

export const OPEN_LIBRARY_EVENT = "hermes:open-library";

export interface LibraryFocus {
  id: string | null;
  install?: boolean;
}

let focus: LibraryFocus | null = null;

/** Asks the app to open the Library at `id` (null: its home). */
export function openLibraryAt(id: string | null, install = false): void {
  focus = { id, install };
  window.dispatchEvent(new CustomEvent(OPEN_LIBRARY_EVENT));
}

/** The pending request, once (the next call returns null). */
export function takeLibraryFocus(): LibraryFocus | null {
  const f = focus;
  focus = null;
  return f;
}
