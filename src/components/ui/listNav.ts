/**
 * Keyboard movement shared by Select and Menu: arrows without wrapping,
 * Home/End, PageUp/PageDown by ten, and type-ahead. Pure functions over a
 * list of items, so the rules are the same everywhere and easy to test.
 */

export interface NavItem {
  /** The text type-ahead matches against. */
  text: string;
  disabled?: boolean;
}

/** How long typed characters keep adding to one search. */
export const TYPEAHEAD_MS = 500;
/** How far PageUp / PageDown move. */
export const PAGE_SIZE = 10;

export function firstEnabled(items: readonly NavItem[]): number {
  return items.findIndex((i) => !i.disabled);
}

export function lastEnabled(items: readonly NavItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) if (!items[i].disabled) return i;
  return -1;
}

/**
 * The next enabled item `step` places away (negative moves up), stopping at
 * the ends instead of wrapping. From -1 (nothing active) a move down lands
 * on the first enabled item and a move up on the last.
 */
export function moveBy(items: readonly NavItem[], from: number, step: number): number {
  if (from < 0) return step > 0 ? firstEnabled(items) : lastEnabled(items);
  const dir = step > 0 ? 1 : -1;
  let remaining = Math.abs(step);
  let best = from;
  // Count enabled items only; stop at the last one there is.
  for (let i = from + dir; i >= 0 && i < items.length && remaining > 0; i += dir) {
    if (items[i].disabled) continue;
    best = i;
    remaining--;
  }
  return best;
}

/**
 * A type-ahead search: characters typed within TYPEAHEAD_MS of each other
 * form one case-insensitive prefix; typing the same letter again cycles
 * through the items that start with it.
 */
export function createTypeahead(timeoutMs = TYPEAHEAD_MS) {
  let buffer = "";
  let last = 0;
  return {
    /** Whether a search is under way (Space then types a space). */
    active(now: number): boolean {
      return buffer.length > 0 && now - last < timeoutMs;
    },
    reset() {
      buffer = "";
      last = 0;
    },
    /** The item to move to after typing `char`, or -1 when nothing matches. */
    type(char: string, items: readonly NavItem[], from: number, now: number): number {
      if (now - last >= timeoutMs) buffer = "";
      last = now;
      buffer += char.toLowerCase();
      const repeated = buffer.length > 1 && [...buffer].every((c) => c === buffer[0]);
      const needle = repeated ? buffer[0] : buffer;
      // A new or cycling search starts after the current item; a longer
      // prefix may still match the current one.
      const startAt = needle.length === 1 ? from + 1 : Math.max(from, 0);
      const n = items.length;
      for (let k = 0; k < n; k++) {
        const i = (((startAt + k) % n) + n) % n;
        const item = items[i];
        if (!item.disabled && item.text.toLowerCase().startsWith(needle)) return i;
      }
      return -1;
    },
  };
}

/** A key that types a character (not a shortcut). */
export function isPrintableKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
}
