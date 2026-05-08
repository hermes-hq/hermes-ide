/**
 * Memory path helpers.  Spec: §2 (M4) + §7.8.
 *
 * Memory files (CLAUDE.md and friends) come from a few sources:
 *   - user:    `~/.claude/CLAUDE.md` (and other files under ~/.claude/)
 *   - project: anything under the session's working directory tree
 */

export type MemoryClass = "user" | "project";

/** Classify a memory path as user (under ~/.claude) or project (everything
 *  else).  Pulls $HOME from `process.env` for SSR / tests; in browser we
 *  fall back to a sentinel that won't match. */
export function classifyMemoryPath(path: string): MemoryClass {
  // `process` is a Node global available in Vitest tests and in Tauri
  // (which runs the renderer in a context that exposes selected env
  // vars).  Guarded so this also runs in pure-browser previews.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proc = (globalThis as any).process as { env?: { HOME?: string } } | undefined;
  const home = proc?.env?.HOME ?? "/__no_home__";
  if (path.startsWith(`${home}/.claude/`) || path === `${home}/.claude/CLAUDE.md`) {
    return "user";
  }
  return "project";
}
