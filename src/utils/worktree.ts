/**
 * Checks if a path is inside a .hermes/worktrees/ directory,
 * indicating it's a linked worktree rather than the main checkout.
 */
export function isHermesWorktreePath(path: string): boolean {
  return path.includes('.hermes/worktrees/');
}
