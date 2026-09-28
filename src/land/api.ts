// ─── Land sheet (F22): backend calls ──────────────────────────────────
//
// Mirrors src-tauri/src/land/. Every call names the session and project;
// the backend finds the session's own worktree and refuses the project
// folder or a checkout another session shares.

import { invoke } from "@tauri-apps/api/core";
import type { Diffstat } from "../agent/contract/turns";

export type MergeCheck =
  | { kind: "fast_forward" }
  | { kind: "clean" }
  | { kind: "conflict"; files: string[] }
  | { kind: "nothing_to_merge" }
  | { kind: "no_base" };

export interface BaseState {
  name: string;
  head: string;
  checkedOutAt: string | null;
}

export type LandMode = "commit" | "pr" | "merge" | "archive";

export interface LandRecord {
  id: string;
  n: number;
  sessionId: string;
  projectId: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  label: string;
  mode: LandMode;
  createdAt: number;
  branchBefore: string;
  branchAfter: string | null;
  base: string | null;
  baseBefore: string | null;
  mergedCommit: string | null;
  remote: string | null;
  remoteBefore: string | null;
  pushed: string | null;
  prUrl: string | null;
  archived: boolean;
  undoneSteps: string[];
  undone: boolean;
}

export interface FeatureFile {
  folder: string;
  text: string;
}

export interface LandPreview {
  branch: string;
  head: string;
  uncommittedFiles: number;
  commitsAhead: number;
  diffstat: Diffstat;
  changedFiles: string[];
  base: BaseState | null;
  merge: MergeCheck;
  worktreePath: string;
  repoPath: string;
  shared: boolean;
  remote: string | null;
  worktreeToml: string | null;
  features: FeatureFile[];
  landings: LandRecord[];
}

export type GhState = "ready" | "missing" | "signed_out";

export interface GhStatus {
  state: GhState;
  detail: string;
}

export interface LandRequest {
  mode: Exclude<LandMode, "archive">;
  message: string;
  prTitle?: string;
  prBody?: string;
  label: string;
}

export interface LandOutcome {
  status: "landed" | "conflict" | "failed";
  record: LandRecord | null;
  conflictFiles: string[];
  error: string | null;
}

export interface ArchivePlan {
  record: LandRecord;
  totalBytes: number;
  buildOutputBytes: number;
}

export interface UndoOutcome {
  record: LandRecord;
  steps: string[];
  restored: {
    sessionId: string;
    projectId: string;
    worktreePath: string;
    branch: string;
    label: string;
  } | null;
}

export interface PrCheck {
  name: string;
  state: string;
  /** pass, fail, pending, skipping or cancel. */
  bucket: string;
  link: string;
  workflow: string;
}

export interface CiLogFile {
  relativePath: string;
  bytes: number;
}

export function landPreview(sessionId: string, projectId: string): Promise<LandPreview> {
  return invoke<LandPreview>("land_preview", { sessionId, projectId });
}

export function landGhStatus(sessionId: string, projectId: string): Promise<GhStatus> {
  return invoke<GhStatus>("land_gh_status", { sessionId, projectId });
}

export function landExecute(sessionId: string, projectId: string, request: LandRequest): Promise<LandOutcome> {
  return invoke<LandOutcome>("land_execute", { sessionId, projectId, request });
}

export function landArchive(
  sessionId: string,
  projectId: string,
  landId: string | null,
  label: string,
): Promise<ArchivePlan> {
  return invoke<ArchivePlan>("land_archive", { sessionId, projectId, landId, label });
}

export function landUndo(landId: string, restoreSessionId: string): Promise<UndoOutcome> {
  return invoke<UndoOutcome>("land_undo", { landId, restoreSessionId });
}

export function landPrChecks(landId: string): Promise<PrCheck[]> {
  return invoke<PrCheck[]>("land_pr_checks", { landId });
}

export function landCiLog(landId: string, checkName: string, link: string): Promise<CiLogFile> {
  return invoke<CiLogFile>("land_ci_log", { landId, checkName, link });
}
