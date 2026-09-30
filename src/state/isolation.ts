// ─── Honest isolation (F09) ───────────────────────────────────────────
//
// Pure helpers behind "two tasks never share a checkout by accident":
//
//   - new tasks default to their own branch, hermes/<slug>, cut from HEAD;
//   - a branch that is already checked out elsewhere is never shared
//     silently: the backend refuses with a BRANCH_IN_USE error and the user
//     picks reuse / a new branch / cancel;
//   - a restored session keeps its id (and with it its worktree link).
//
// Kept free of React so every decision is unit-tested directly.

import type { SessionWorktree, WorktreeCreateResult } from "../types/git";
import { findBranchClash } from "../utils/branchClash";

/** Prefix of the backend's "branch already checked out" error (git/worktree.rs). */
export const BRANCH_IN_USE_PREFIX = "BRANCH_IN_USE:";

/** Where a branch the user asked for is already checked out. */
export interface BranchInUse {
  branch: string;
  path: string;
  /** Session whose worktree has it, when Hermes made that worktree. */
  sessionId: string | null;
  /** True when it is the project folder itself. */
  projectFolder: boolean;
}

/** Parse a BRANCH_IN_USE error from `git_create_worktree`; null for any other error. */
export function parseBranchInUseError(err: unknown): BranchInUse | null {
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const at = text.indexOf(BRANCH_IN_USE_PREFIX);
  if (at < 0) return null;
  try {
    const v = JSON.parse(text.slice(at + BRANCH_IN_USE_PREFIX.length)) as Record<string, unknown>;
    if (typeof v.branch !== "string" || typeof v.path !== "string") return null;
    return {
      branch: v.branch,
      path: v.path,
      sessionId: typeof v.sessionId === "string" ? v.sessionId : null,
      projectFolder: v.projectFolder === true,
    };
  } catch {
    return null;
  }
}

/** Branch-name-safe slug: lowercase ASCII letters, digits and single dashes. */
export function slugify(text: string, maxLength = 40): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}

/** A short random slug for a task that has no name yet, e.g. "task-k3f9". */
export function randomTaskSlug(random: () => number = Math.random): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += alphabet[Math.floor(random() * alphabet.length) % alphabet.length];
  return `task-${s}`;
}

/**
 * The default branch for a new task: `hermes/<slug>`, made unique against
 * the branches that already exist (`-2`, `-3`, ...), letter case included:
 * next to `hermes/Fix` the default is never `hermes/fix` (on macOS and
 * Windows that is the same branch).
 */
export function defaultTaskBranch(slug: string, existing: Iterable<string>): string {
  const names = [...existing];
  // A folder that differs only in case is shared by every candidate; the
  // branch step shows that clash, so it does not count here.
  const taken = (name: string) => {
    const clash = findBranchClash(name, names);
    return clash !== null && clash.kind !== "folder";
  };
  const base = `hermes/${slugify(slug) || "task"}`;
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken(candidate)) return candidate;
  }
}

/**
 * Id to restore a saved session under: its own id, so its worktree link,
 * notes and history stay attached. A fresh id only when the saved one is
 * unusable or already taken in this restore.
 */
export function pickRestoreId(
  savedId: unknown,
  used: ReadonlySet<string>,
  fresh: () => string = () => crypto.randomUUID(),
): string {
  if (typeof savedId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(savedId) && !used.has(savedId)) {
    return savedId;
  }
  return fresh();
}

// ─── Creating a session's worktrees ───────────────────────────────────

export type BranchConflictChoice =
  | { kind: "reuse" }
  | { kind: "new-branch"; name: string }
  | { kind: "cancel" };

export interface BranchSelection {
  branch: string;
  createNew: boolean;
  fromRemote?: string;
  /** A new branch is cut from this one (default: the repository's current branch). */
  baseBranch?: string;
}

export interface WorktreeDeps {
  createWorktree(
    sessionId: string,
    projectId: string,
    branch: string,
    createNew: boolean,
    fromRemote?: string,
    baseBranch?: string,
  ): Promise<WorktreeCreateResult>;
  attachWorktree(sessionId: string, projectId: string, branch: string): Promise<WorktreeCreateResult>;
  /** Undo a worktree this call created (removes it from disk). */
  removeWorktree(sessionId: string, projectId: string): Promise<unknown>;
  /** Undo a link to someone else's checkout (never touches the disk). */
  detachWorktree(sessionId: string, projectId: string): Promise<unknown>;
  /** Ask the user what to do about a branch that is checked out elsewhere. */
  resolveConflict(conflict: BranchInUse & { projectId: string }): Promise<BranchConflictChoice>;
}

/** A checkout the user chose to reuse instead of getting one of their own. */
export interface ReusedCheckout {
  branch: string;
  path: string;
  /**
   * Who holds it: another Hermes session's worktree (`session`), the
   * project folder, or a checkout Hermes did not make (`outside`: made by
   * hand, or by another Hermes instance).
   */
  holder: "session" | "project-folder" | "outside";
}

export interface WorktreesOutcome {
  succeeded: number;
  errors: string[];
  /** Checkouts the user chose to reuse, and who holds each. */
  reused: ReusedCheckout[];
  /** The user cancelled: everything this call made was undone. */
  cancelled: boolean;
}

/** Who holds a checkout that is in use, from a BRANCH_IN_USE conflict. */
export function branchHolderKind(conflict: BranchInUse): ReusedCheckout["holder"] {
  if (conflict.projectFolder) return "project-folder";
  return conflict.sessionId ? "session" : "outside";
}

/**
 * One line telling the user what reusing a checkout means, by who holds it.
 * Only a checkout of another Hermes session is "shared with another
 * session"; the project folder and a checkout outside Hermes are not, and
 * saying so used to be misleading.
 */
export function reusedCheckoutMessage(r: ReusedCheckout): string {
  switch (r.holder) {
    case "session":
      return `Sharing worktree for ${r.branch} with another session. Changes to files will affect both sessions — avoid editing the same files.`;
    case "project-folder":
      return `Working on ${r.branch} in the project folder. Changes there are not isolated from the project.`;
    default:
      return `Working on ${r.branch} in a checkout outside Hermes (${r.path}). Hermes leaves it alone when the session closes: it is not cleaned up and its changes stay there.`;
  }
}

/** How often one project may bounce between "in use" and a new name. */
const MAX_CONFLICT_ROUNDS = 5;

/**
 * Create (or, when the user says so, reuse) a worktree for every project that
 * has a branch selection. A branch checked out elsewhere is never shared
 * without `resolveConflict` answering "reuse"; "cancel" undoes every worktree
 * made so far and reports `cancelled`.
 */
export async function createSessionWorktrees(
  sessionId: string,
  projectIds: readonly string[],
  selections: Readonly<Record<string, BranchSelection | undefined>>,
  deps: WorktreeDeps,
): Promise<WorktreesOutcome> {
  const outcome: WorktreesOutcome = { succeeded: 0, errors: [], reused: [], cancelled: false };
  const made: Array<{ projectId: string; attached: boolean }> = [];

  const undo = async () => {
    for (const m of made.reverse()) {
      try {
        if (m.attached) await deps.detachWorktree(sessionId, m.projectId);
        else await deps.removeWorktree(sessionId, m.projectId);
      } catch (e) {
        console.warn(`[isolation] could not undo the worktree for project ${m.projectId}:`, e);
      }
    }
  };

  for (const projectId of projectIds) {
    const sel = selections[projectId];
    if (!sel) continue;
    let branch = sel.branch;
    let createNew = sel.createNew;
    let fromRemote = sel.fromRemote;
    let baseBranch: string | undefined = sel.createNew && sel.baseBranch ? sel.baseBranch : undefined;

    for (let round = 0; ; round++) {
      try {
        await deps.createWorktree(sessionId, projectId, branch, createNew, fromRemote, baseBranch);
        made.push({ projectId, attached: false });
        outcome.succeeded++;
        break;
      } catch (err) {
        const conflict = parseBranchInUseError(err);
        if (!conflict || round >= MAX_CONFLICT_ROUNDS) {
          outcome.errors.push(`${projectId}: ${err instanceof Error ? err.message : String(err)}`);
          break;
        }
        const choice = await deps.resolveConflict({ ...conflict, projectId });
        if (choice.kind === "cancel") {
          await undo();
          outcome.cancelled = true;
          return outcome;
        }
        if (choice.kind === "reuse") {
          try {
            await deps.attachWorktree(sessionId, projectId, conflict.branch);
            made.push({ projectId, attached: true });
            outcome.succeeded++;
            outcome.reused.push({ branch: conflict.branch, path: conflict.path, holder: branchHolderKind(conflict) });
          } catch (attachErr) {
            outcome.errors.push(
              `${projectId}: ${attachErr instanceof Error ? attachErr.message : String(attachErr)}`,
            );
          }
          break;
        }
        // New branch cut from the one that is in use.
        baseBranch = conflict.branch;
        branch = choice.name;
        createNew = true;
        fromRemote = undefined;
      }
    }
  }
  return outcome;
}

/** Commit message for the close dialog's "commit" and "archive" choices. */
export function closeCommitMessage(sessionLabel: string, kind: "session" | "archive"): string {
  const label = sessionLabel.trim() || "session";
  return kind === "archive"
    ? `Archive uncommitted work from Hermes session "${label}"`
    : `Work in progress from Hermes session "${label}"`;
}

/**
 * Whether closing a session must ask about uncommitted changes in one of its
 * projects. Closing deletes only a checkout the session owns alone, so:
 *
 *   - a checkout shared with another session is never asked about (its
 *     changes may be that session's work, and it stays on disk);
 *   - neither is a checkout Hermes did not make (`git worktree add` by
 *     hand) that the session reused on purpose: it is not deleted on close
 *     and its changes are whoever made it's;
 *   - with honest isolation, neither is the project folder or a project
 *     with no worktree link;
 *   - without it, everything else is checked as before.
 */
export function shouldAskAboutChangesOnClose(wt: SessionWorktree | null, honest: boolean): boolean {
  if (wt?.sharedWithOtherSessions) return false;
  if (wt && !wt.isMainWorktree && wt.ownedBySession === false) return false;
  if (!honest) return true;
  if (!wt || wt.isMainWorktree) return false;
  return wt.ownedBySession ?? true;
}

/**
 * Who holds the branch, for the Branch In Use dialog: the session whose
 * worktree has it, the project folder, or a checkout made outside Hermes
 * (`git worktree add` by hand). The dialog shows the checkout's folder
 * next to it, so the user can tell which one it is.
 */
export function describeBranchHolder(conflict: BranchInUse, holderLabel: string | null): string {
  if (conflict.projectFolder) return "the project folder";
  if (holderLabel) return `session "${holderLabel}"`;
  return "a checkout outside Hermes";
}

/** Payload of the backend's `session-working-directory-recovered` event. */
export interface WorkingDirectoryRecovery {
  sessionId: string;
  branchName: string | null;
  missingPath: string;
  path: string;
  outcome: "recreated" | "project-folder" | "folder" | "home";
}

/** One line telling the user where a session opened and why. */
export function workingDirectoryRecoveryMessage(r: WorkingDirectoryRecovery): string {
  const what = r.branchName ? `The working folder of branch '${r.branchName}'` : `The working folder '${r.missingPath}'`;
  switch (r.outcome) {
    case "recreated":
      return `${what} was missing and has been recreated.`;
    case "project-folder":
      return `${what} is gone; the session opened in the project folder instead.`;
    case "folder":
      return `${what} is gone; the session opened in '${r.path}' instead.`;
    default:
      return `${what} is gone; the session opened in your home folder instead.`;
  }
}

/**
 * The sessions to write into the saved workspace: the live ones, plus the
 * saved entries that could not be restored this launch (kept, so the next
 * launch tries them again and nothing is dropped over a passing error),
 * unless the user chose to forget one. A live session wins over a stale
 * entry with the same id.
 */
export function withUnrestoredSessions<T extends { id: string }>(live: T[], unrestored: T[]): T[] {
  const seen = new Set(live.map((s) => s.id));
  const kept = unrestored.filter((s) => !seen.has(s.id));
  return kept.length === 0 ? live : [...live, ...kept];
}
