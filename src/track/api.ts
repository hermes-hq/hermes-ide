// ─── Feature Tracks: the backend commands and the change event ────────
//
// F28. The Rust side (src-tauri/src/track/mod.rs) reads and writes the
// files under .hermes/features/<slug>/ with the same crate the `hi`
// helper uses; this file is the typed doorway.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const TRACK_CHANGED_EVENT = "hermes:track-changed";

export interface TrackFileInfo {
  readonly name: string;
  readonly lines: number;
  /** Epoch milliseconds. */
  readonly modifiedAt: number;
}

/** One feature folder as the watcher saw it: raw texts, parsed by the store. */
export interface TrackFeatureSnapshot {
  readonly slug: string;
  readonly featureText: string;
  readonly featureModifiedAt: number;
  /** feature.md's size in bytes. */
  readonly featureSize?: number;
  /** feature.md is too large to read whole: featureText is only its start. */
  readonly featureTruncated?: boolean;
  readonly questionsText: string | null;
  readonly files: readonly TrackFileInfo[];
}

export interface TrackWorktreeSnapshot {
  readonly worktreePath: string;
  readonly branch: string | null;
  readonly features: readonly TrackFeatureSnapshot[];
  readonly at: number;
}

export interface PhaseMove {
  readonly from: string;
  readonly to: string;
}

export interface ReviewOutcome {
  readonly path: string;
  readonly n: number;
  readonly line: string;
  readonly changedLines: number;
}

export interface PromoteOutcome {
  readonly created: boolean;
  readonly slug: string;
  readonly featureFile: string | null;
  /** What happened to the `hermes/<slug>` branch, or null outside a repository. */
  readonly branch: string | null;
  /** Every file written, so Undo removes exactly those. */
  readonly written: readonly WrittenFile[];
}

export interface WrittenFile {
  /** Relative to the worktree. */
  readonly path: string;
  readonly hash: string;
}

export interface UndoPromoteOutcome {
  readonly removed: readonly string[];
  /** Changed since they were written: kept. */
  readonly kept: readonly string[];
}

export function trackWatch(sessionId: string, worktreePath: string): Promise<TrackWorktreeSnapshot> {
  return invoke<TrackWorktreeSnapshot>("track_watch", { sessionId, worktreePath });
}

export function trackUnwatch(sessionId: string): Promise<void> {
  return invoke("track_unwatch", { sessionId });
}

export function trackApprove(worktreePath: string, slug: string): Promise<PhaseMove> {
  return invoke<PhaseMove>("track_approve", { worktreePath, slug });
}

export function trackSkip(worktreePath: string, slug: string): Promise<PhaseMove> {
  return invoke<PhaseMove>("track_skip", { worktreePath, slug });
}

export function trackRevertGate(worktreePath: string, slug: string, phase: string): Promise<void> {
  return invoke("track_revert_gate", { worktreePath, slug, phase });
}

export function trackPromote(worktreePath: string, slug: string, track: string, title: string | null): Promise<PromoteOutcome> {
  return invoke<PromoteOutcome>("track_promote", { worktreePath, slug, track, title });
}

/** The files "Make it a feature" would write now (for its confirmation). */
export function trackPromotePlan(worktreePath: string, slug: string, track: string): Promise<string[]> {
  return invoke<string[]>("track_promote_plan", { worktreePath, slug, track });
}

/** Undo "Make it a feature": removes the files it wrote that nobody changed since. */
export function trackUndoPromote(worktreePath: string, written: readonly WrittenFile[]): Promise<UndoPromoteOutcome> {
  return invoke<UndoPromoteOutcome>("track_undo_promote", { worktreePath, written });
}

export function trackReadFile(worktreePath: string, slug: string, name: string): Promise<string> {
  return invoke<string>("track_read_file", { worktreePath, slug, name });
}

export function trackFilePath(worktreePath: string, slug: string, name: string): Promise<string> {
  return invoke<string>("track_file_path", { worktreePath, slug, name });
}

export function trackWriteReview(worktreePath: string, slug: string, name: string, baseline: string | null): Promise<ReviewOutcome> {
  return invoke<ReviewOutcome>("track_write_review", { worktreePath, slug, name, baseline });
}

export function onTrackChanged(handler: (snapshot: TrackWorktreeSnapshot) => void): Promise<UnlistenFn> {
  return listen<TrackWorktreeSnapshot>(TRACK_CHANGED_EVENT, (e) => handler(e.payload));
}
