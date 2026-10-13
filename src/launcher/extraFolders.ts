// ─── A task's extra folders ────────────────────────────────────────────
//
// A launcher task runs in one main project (its branch, its worktree) and
// may take up to MAX_EXTRA_FOLDERS more folders, attached and edited in
// place on whatever branch they are on. Which folders cannot be one, and
// why, is decided here so the menu and the tests read the same rules.

import { getAgent } from "../catalog/agentCatalog";
import type { SessionMode } from "../types/session";

/** How many extra folders a task takes at most. */
export const MAX_EXTRA_FOLDERS = 5;

/** A folder as the rules see it: its path, its name, and its repository's main checkout when known. */
export interface FolderRef {
  path: string;
  name: string;
  /** The repository's main checkout (a worktree's too); null: not a repository; undefined: not known yet. */
  gitRoot?: string | null;
}

/** Why a folder cannot be added as an extra one. */
export type ExtraBlock =
  | { kind: "missing" }
  | { kind: "inside"; name: string }
  | { kind: "contains"; name: string }
  | { kind: "same-repo"; name: string }
  | { kind: "cap"; max: number };

function norm(path: string, windows: boolean): string {
  let p = path.trim().replace(/[\\/]+$/, "");
  if (windows) p = p.replace(/\//g, "\\").toLowerCase();
  return p;
}

function samePath(a: string, b: string, windows = false): boolean {
  return norm(a, windows) === norm(b, windows);
}

/** `child` is a folder inside `parent` (not the same folder). */
function isInside(child: string, parent: string, windows = false): boolean {
  const c = norm(child, windows);
  const p = norm(parent, windows);
  if (!p || c === p) return false;
  const sep = windows ? "\\" : "/";
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** The two folders are in the same repository (worktrees of one repository count). */
function sameRepo(a: FolderRef, b: FolderRef, windows: boolean): boolean {
  const ra = a.gitRoot ?? null;
  const rb = b.gitRoot ?? null;
  if (ra && rb && samePath(ra, rb, windows)) return true;
  // Known on one side only: the other folder is that repository's main checkout.
  if (ra && samePath(ra, b.path, windows)) return true;
  if (rb && samePath(rb, a.path, windows)) return true;
  return false;
}

/**
 * Why `candidate` cannot be checked as an extra folder now, or null when it
 * can. A folder that is already an extra is never blocked (it can always be
 * unchecked).
 */
export function extraBlock(
  candidate: FolderRef & { exists: boolean },
  ctx: { main: FolderRef | null; extras: readonly FolderRef[]; max?: number; windows?: boolean },
): ExtraBlock | null {
  const windows = ctx.windows ?? false;
  if (ctx.extras.some((e) => samePath(e.path, candidate.path, windows))) return null;
  if (!candidate.exists) return { kind: "missing" };
  const main = ctx.main;
  if (main) {
    if (isInside(candidate.path, main.path, windows)) return { kind: "inside", name: main.name };
    if (isInside(main.path, candidate.path, windows)) return { kind: "contains", name: main.name };
    if (sameRepo(candidate, main, windows)) return { kind: "same-repo", name: main.name };
  }
  const twin = ctx.extras.find((e) => sameRepo(candidate, e, windows));
  if (twin) return { kind: "same-repo", name: twin.name };
  const max = ctx.max ?? MAX_EXTRA_FOLDERS;
  if (ctx.extras.length >= max) return { kind: "cap", max };
  return null;
}

/**
 * Whether the agent can be given extra folders: Claude's Agent view (each
 * one an --add-dir of its process), or a terminal agent whose catalog entry
 * has a proven `add_dir` flag. Any other agent works in one folder.
 */
export function takesExtraFolders(agentId: string, mode: SessionMode): boolean {
  const agent = getAgent(agentId);
  if (!agent || agent.custom) return false;
  if (mode === "agent") return true;
  return (agent.terminal.add_dir?.length ?? 0) > 0;
}
