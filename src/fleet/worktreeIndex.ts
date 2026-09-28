// ─── Which repository and feature branch each session works in ────────
//
// From the worktree rows the backend already keeps (git_list_all_worktrees):
//
//   - the repositories (projects) a session has checked out, so Collision
//     Radar only compares files inside the same repository;
//   - the feature a session belongs to: its own worktree's branch. In 2.0 a
//     feature is one hermes/<slug> branch with one worktree (F28), and every
//     session attached to that worktree works on it. A session in the
//     project folder itself belongs to no feature.

import type { WorktreeOverviewEntry } from "../types/git";
import type { FeatureRef } from "./spend";

export interface WorktreeIndex {
  /** sessionId -> project ids it has a checkout of. */
  readonly repos: ReadonlyMap<string, readonly string[]>;
  /** sessionId -> its feature branch, when it works in a worktree of its own. */
  readonly features: ReadonlyMap<string, FeatureRef>;
}

export const EMPTY_WORKTREE_INDEX: WorktreeIndex = Object.freeze({ repos: new Map(), features: new Map() });

export function buildWorktreeIndex(entries: readonly WorktreeOverviewEntry[]): WorktreeIndex {
  const repos = new Map<string, string[]>();
  const features = new Map<string, FeatureRef>();
  for (const e of entries) {
    const list = repos.get(e.session_id) ?? [];
    if (!list.includes(e.project_id)) list.push(e.project_id);
    repos.set(e.session_id, list);
    if (!e.is_main_worktree && e.branch_name && !features.has(e.session_id)) {
      features.set(e.session_id, { key: `${e.project_id}::${e.branch_name}`, label: e.branch_name });
    }
  }
  return { repos, features };
}
