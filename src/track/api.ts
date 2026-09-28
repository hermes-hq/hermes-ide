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
