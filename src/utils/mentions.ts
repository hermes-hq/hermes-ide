/**
 * Pure helpers for the composer's `@mention` feature.
 *
 * The composer tracks the caret position in its textarea and uses
 * `getActiveMention` to decide whether to render the suggestion popover.
 * `replaceMention` performs the actual text substitution when the user
 * picks a candidate.
 */

export interface ActiveMention {
  /** Index of the `@` character in the source string. */
  start: number;
  /** Index just past the end of the mention substring (exclusive). */
  end: number;
  /** The query — text after `@`, before whitespace/end. */
  query: string;
}

/**
 * Detect whether the caret in `text` is currently inside a mention
 * (i.e. there is an `@` to the left of the caret with no whitespace between).
 *
 * Returns null when no active mention.
 *
 * Rules:
 * - The `@` must either be at position 0 OR preceded by whitespace.
 *   (So `email@host` is NOT a mention — `@` after a non-space char is rejected.)
 *   A `@` directly preceded by another `@` is treated as the start of a fresh
 *   mention (so the closest-to-caret `@` always wins in runs like `@@`).
 * - The mention runs from the `@` up to the caret. Whitespace inside
 *   terminates the mention — if any whitespace appears between the `@` and
 *   the caret, return null.
 * - The query string is everything after `@` and before the caret.
 *   May be empty (just typed `@`).
 */
export function getActiveMention(text: string, caret: number): ActiveMention | null {
  if (caret <= 0 || caret > text.length) return null;

  let at = -1;
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (isWhitespace(ch)) return null;
    if (ch === "@") {
      at = i;
      break;
    }
  }
  if (at === -1) return null;

  if (at > 0) {
    const prev = text[at - 1];
    if (!isWhitespace(prev) && prev !== "@") return null;
  }

  return {
    start: at,
    end: caret,
    query: text.slice(at + 1, caret),
  };
}

/**
 * Replace the active mention in `text` with `replacement`, returning the
 * new text and the new caret position (placed right after the replacement).
 *
 * If `replacement` does not end with a space, one is appended so the user
 * can keep typing without manually adding it.
 */
export function replaceMention(
  text: string,
  mention: ActiveMention,
  replacement: string,
): { text: string; caret: number } {
  const insert = replacement.endsWith(" ") ? replacement : replacement + " ";
  const before = text.slice(0, mention.start);
  const after = text.slice(mention.end);
  const next = before + insert + after;
  return { text: next, caret: before.length + insert.length };
}

function isWhitespace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}
