// ─── Review Desk (F21): backend commands ─────────────────────────────
//
// Plain git on the Rust side (src-tauri/src/review/mod.rs): the diff from
// the merge-base to the worktree through a private index, a turn's revert,
// and the review file a terminal agent is asked to read.

import { invoke } from "@tauri-apps/api/core";

export type ReviewFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface ReviewFile {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: ReviewFileStatus;
  readonly isBinary: boolean;
  readonly executable: boolean;
  readonly additions: number;
  readonly deletions: number;
  /** This file's part of the unified diff, header included. */
  readonly patch: string;
  readonly truncated: boolean;
}

export interface ReviewDiff {
  readonly base: string;
  readonly baseRef: string;
  readonly head: string;
  readonly branch: string | null;
  readonly files: readonly ReviewFile[];
}

export interface RevertPreview {
  readonly clean: boolean;
  readonly message: string;
  readonly files: readonly ReviewFile[];
  /** The turn's changes are gone already (reverted before): nothing to undo. */
  readonly alreadyReverted?: boolean;
}

export interface RevertResult {
  readonly ok: boolean;
  readonly method: string;
  readonly message: string;
}

/**
 * True when the diff failed only because the folder is not a git
 * repository (git's "fatal: not a git repository ..."): the desk then shows
 * its plain "no repository" state instead of git's error text.
 */
export function isNotAGitRepository(error: unknown): boolean {
  return /not a git repository/i.test(String(error));
}

export function reviewDiff(path: string): Promise<ReviewDiff> {
  return invoke<ReviewDiff>("review_diff", { path });
}

export function reviewRevertPreview(path: string, patch: string): Promise<RevertPreview> {
  return invoke<RevertPreview>("review_revert_preview", { path, patch });
}

export function reviewRevertPatch(path: string, patch: string): Promise<RevertResult> {
  return invoke<RevertResult>("review_revert_patch", { path, patch });
}

/** Writes review-<n>.md for a session; resolves with its absolute path. */
export function reviewWriteFile(sessionId: string, n: number, content: string): Promise<string> {
  return invoke<string>("review_write_file", { sessionId, n, content });
}
