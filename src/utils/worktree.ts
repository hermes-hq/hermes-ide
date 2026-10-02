/**
 * Worktree paths, the same on every OS. Windows paths come from the backend
 * with backslashes (C:\Users\…\hermes-worktrees\…), so every check here
 * reads a path with its separators made forward slashes first.
 */

/** `path` with every backslash turned into a forward slash. */
export function toForwardSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Checks if a path is inside the Hermes worktrees directory
 * (hermes-worktrees/), indicating it's a linked worktree rather
 * than the main checkout.
 */
export function isHermesWorktreePath(path: string): boolean {
  return toForwardSlashes(path).includes("hermes-worktrees/");
}

/** A Hermes worktree in the current layout or the legacy `.hermes/worktrees/` one. */
export function isAnyHermesWorktreePath(path: string): boolean {
  const p = toForwardSlashes(path);
  return p.includes("hermes-worktrees/") || p.includes(".hermes/worktrees/");
}

/** The last folder of a path (`…/<session>_<branch>` → `<session>_<branch>`). */
export function lastPathSegment(path: string): string {
  const parts = toForwardSlashes(path).replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] ?? "";
}

/**
 * Extract a user-friendly display name from a worktree path.
 * Worktree paths look like: .../hermes-worktrees/<hash>/<session>_<branch>
 * (backslashes on Windows). We extract the branch name (after the first
 * underscore in the directory name).
 */
export function friendlyWorktreeLabel(projectName: string, projectPath: string): string {
  if (!isHermesWorktreePath(projectPath)) return projectName;
  const dirName = lastPathSegment(projectPath);
  const underscoreIdx = dirName.indexOf("_");
  if (underscoreIdx >= 0) {
    const branchPart = dirName.slice(underscoreIdx + 1);
    if (branchPart) return `${projectName} (${branchPart})`;
  }
  return projectName;
}
