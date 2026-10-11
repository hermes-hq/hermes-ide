/** Marks an element whose area takes dropped files itself (the task launcher): the pane or panel under it must not. */
export const FILE_DROP_TARGET = "data-file-drop-target";

/** Whether the page point (CSS pixels) is over an element that takes dropped files itself. */
export function isOverFileDropTarget(x: number, y: number): boolean {
  return !!document.elementFromPoint(x, y)?.closest(`[${FILE_DROP_TARGET}]`);
}

/**
 * A dropped file path as shell input. A POSIX path with anything a shell
 * would glob, expand or split on (`[slug]`, `it's`, `$HOME`, spaces) goes in
 * single quotes, a `'` written as `'\''`. A Windows path keeps the old rule
 * (double quotes when it has a space): cmd has no single quotes.
 */
export function quoteDroppedPath(path: string): string {
  if (/^[A-Za-z]:[\\/]|^\\\\/.test(path)) return path.includes(" ") ? `"${path}"` : path;
  if (/^[\w./-]+$/.test(path)) return path;
  return `'${path.replace(/'/g, "'\\''")}'`;
}
