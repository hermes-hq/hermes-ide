// Branch names that collide with an existing branch, letter case included.
//
// Git keeps a branch as a file under .git/refs/heads/. On a file system that
// ignores letter case (macOS, Windows) `Develop` and `develop` are the same
// file: "creating" Develop next to develop silently hands back develop, and a
// commit made on it moves develop. A folder of branches works the same way
// (`Feature/x` next to `feature/y` lands in `feature/`). Hermes treats these
// names as taken on every OS, since a repository made on Linux is often
// cloned on a Mac. The backend refuses them too (BranchClash in
// src-tauri/src/git/worktree.rs); this is the same rule for the forms.

export type BranchClash =
  /** A branch with exactly this name exists. */
  | { kind: "same"; existing: string }
  /** A branch whose name differs only in letter case exists (its name). */
  | { kind: "case"; existing: string }
  /** A folder of the name differs only in case from one an existing branch uses (that branch). */
  | { kind: "folder"; existing: string };

/** How `name` collides with one of `existing`, or null when it does not. */
export function findBranchClash(name: string, existing: Iterable<string>): BranchClash | null {
  const lower = name.toLowerCase();
  const parts = name.split("/");
  let caseClash: string | null = null;
  let folderClash: string | null = null;
  for (const other of existing) {
    if (other === name) return { kind: "same", existing: other };
    if (caseClash === null && other.toLowerCase() === lower) {
      caseClash = other;
      continue;
    }
    if (folderClash === null) {
      // The first folder (or the name itself) where the two differ: when it
      // differs only in case, one folder on disk holds both.
      const otherParts = other.split("/");
      const n = Math.min(parts.length, otherParts.length);
      for (let i = 0; i < n; i++) {
        if (parts[i] === otherParts[i]) continue;
        if (parts[i].toLowerCase() === otherParts[i].toLowerCase()) folderClash = other;
        break;
      }
    }
  }
  if (caseClash !== null) return { kind: "case", existing: caseClash };
  if (folderClash !== null) return { kind: "folder", existing: folderClash };
  return null;
}
