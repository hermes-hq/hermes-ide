// ─── Worktree storage (Settings > Storage) ──────────────────────────
//
// Old worktrees and their build output, per repo, and the safe ways to free
// that space. The rules (what is automatic, what needs the person, backups
// before any removal of work) live in src-tauri/src/git/hygiene.rs.

import { invoke } from "@tauri-apps/api/core";

export type LifeState = "open" | "active" | "idle" | "landed" | "orphaned";
export type AutoAction = "none" | "remove_build_output" | "remove_worktree";
export type NeedsReason = "changes" | "unpushed" | "repo_gone";

export interface WorkFacts {
  gitKnows: boolean;
  branch: string | null;
  detached: boolean;
  changedFiles: number;
  unpushedCommits: number;
  merged: boolean;
}

export interface StorageWorktree {
  path: string;
  repoPath: string | null;
  repoName: string;
  repoExists: boolean;
  branch: string | null;
  sessionIds: string[];
  state: LifeState;
  autoAction: AutoAction;
  needs: NeedsReason | null;
  backupBeforeRemoval: boolean;
  facts: WorkFacts;
  /** RFC 3339. */
  lastUsed: string | null;
  totalBytes: number;
  buildOutputBytes: number;
  autoBytes: number;
}

export interface HygieneSettings {
  autoCleanup: boolean;
  idleDays: number;
  lowDiskBytes: number;
}

export interface StorageReport {
  freeBytes: number | null;
  diskTotalBytes: number | null;
  guardBytes: number;
  settings: HygieneSettings;
  worktrees: StorageWorktree[];
  totalBytes: number;
  autoBytes: number;
  needsBytes: number;
  scannedAt: string;
}

export interface BackupRecord {
  refName: string;
  commit: string;
  repoPath: string;
  worktreePath: string;
  branch: string | null;
  createdAt: string;
  restoreCommand: string;
}

export interface CleanupOutcome {
  freedBytes: number;
  removedWorktrees: string[];
  clearedBuildOutput: string[];
  backups: BackupRecord[];
  skipped: { path: string; reason: string }[];
  report: StorageReport;
}

export interface PersonRemoval {
  path: string;
  removed: boolean;
  backup: BackupRecord | null;
  error: string | null;
  freedBytes: number;
}

export interface BuildOutputResult {
  path: string;
  removed: string[];
  freed_bytes: number;
  failed: string[];
}

/** Payload of the background pass's notice. */
export interface StorageNotice {
  kind: "low_disk" | "cleaned" | "reclaimable";
  freeBytes: number | null;
  worktreeBytes: number;
  autoBytes: number;
  needsBytes: number;
  freedBytes: number;
  removedWorktrees: number;
  clearedBuildOutput: number;
}

export const STORAGE_NOTICE_EVENT = "worktree-storage-notice";

export const SETTING_AUTO_CLEANUP = "worktree_auto_cleanup";
export const SETTING_IDLE_DAYS = "worktree_idle_days";
export const SETTING_LOW_DISK_GB = "worktree_low_disk_gb";

export function getStorageReport(): Promise<StorageReport> {
  return invoke<StorageReport>("worktree_storage_report");
}

/** Run the automatic rules now. */
export function cleanUpStorage(): Promise<CleanupOutcome> {
  return invoke<CleanupOutcome>("worktree_storage_clean_up");
}

export function removeStorageWorktree(path: string, allowUnrecoverable = false): Promise<PersonRemoval> {
  return invoke<PersonRemoval>("worktree_storage_remove", { path, allowUnrecoverable });
}

export function removeStorageBuildOutput(path: string): Promise<BuildOutputResult> {
  return invoke<BuildOutputResult>("worktree_storage_remove_build_output", { path });
}

export function listStorageBackups(): Promise<BackupRecord[]> {
  return invoke<BackupRecord[]>("worktree_storage_backups");
}

export interface RepoGroup {
  name: string;
  repoPath: string | null;
  worktrees: StorageWorktree[];
  totalBytes: number;
  autoBytes: number;
  needsYou: boolean;
}

/** Worktrees grouped by repo, biggest first; inside a repo, biggest first. */
export function groupByRepo(worktrees: StorageWorktree[]): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();
  for (const w of worktrees) {
    const key = w.repoPath ?? `?${w.repoName}`;
    let g = groups.get(key);
    if (!g) {
      g = { name: w.repoName, repoPath: w.repoPath, worktrees: [], totalBytes: 0, autoBytes: 0, needsYou: false };
      groups.set(key, g);
    }
    g.worktrees.push(w);
    g.totalBytes += w.totalBytes;
    g.autoBytes += w.autoBytes;
    g.needsYou ||= w.needs !== null;
  }
  const list = [...groups.values()];
  for (const g of list) g.worktrees.sort((a, b) => b.totalBytes - a.totalBytes);
  return list.sort((a, b) => b.totalBytes - a.totalBytes);
}

/** Whole days since `iso`, or null. */
export function daysSince(iso: string | null, now = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/** Decimal units ("4.2 GB"), as the OS shows disk space. */
export function formatStorageBytes(bytes: number): string {
  if (bytes < 1000) return `${Math.max(0, Math.round(bytes))} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value < 100 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
