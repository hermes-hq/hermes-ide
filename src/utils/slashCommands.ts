/**
 * Slash-command parsing for the composer's `/` autocomplete.
 *
 * Rule: a slash command is active when the caret is on a line whose first
 * non-whitespace char is `/`, with no whitespace between the `/` and the caret.
 * That keeps shell paths like `/usr/bin/foo` from triggering the dropdown.
 */

export interface ActiveSlashCommand {
  /** Index of the leading `/` in the source string. */
  start: number;
  /** Index just past the end (exclusive) — the caret position. */
  end: number;
  /** Text after `/` and before the caret. May be empty (just typed `/`). */
  query: string;
}

export function getActiveSlashCommand(text: string, caret: number): ActiveSlashCommand | null {
  if (caret < 0 || caret > text.length) return null;
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const lineUpToCaret = text.slice(lineStart, caret);
  const slashIdx = lineUpToCaret.indexOf("/");
  if (slashIdx === -1) return null;
  if (!/^\s*$/.test(lineUpToCaret.slice(0, slashIdx))) return null;
  const between = lineUpToCaret.slice(slashIdx + 1);
  if (/\s/.test(between)) return null;
  // Reject anything that looks like a path (e.g. "/usr/bin") — slash commands
  // never contain a `/` after the leading one.
  if (between.includes("/")) return null;
  return {
    start: lineStart + slashIdx,
    end: caret,
    query: between,
  };
}

/**
 * Replace the active slash-command range with `replacement` and return the
 * new draft + caret position. The replacement is inserted as-is — caller
 * decides whether to append a space (e.g. for arg-taking commands).
 */
export function replaceSlashCommand(
  text: string,
  cmd: ActiveSlashCommand,
  replacement: string,
): { text: string; caret: number } {
  const newText = text.slice(0, cmd.start) + replacement + text.slice(cmd.end);
  return { text: newText, caret: cmd.start + replacement.length };
}
