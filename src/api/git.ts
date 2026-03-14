import { invoke } from "@tauri-apps/api/core";
import type {
  GitSessionStatus, GitDiff, GitOperationResult, GitBranch, FileEntry, FileContent,
  SshFileEntry, SshFileContent,
  GitStashEntry, GitLogResult, GitCommitDetail, MergeStatus, ConflictContent, ConflictStrategy,
  SearchResponse,
  SessionWorktree, WorktreeInfo, BranchAvailability, WorktreeCreateResult,
} from "../types/git";

export function gitStatus(sessionId: string): Promise<GitSessionStatus> {
  return invoke<GitSessionStatus>("git_status", { sessionId });
}

export function gitStage(sessionId: string, realmId: string, paths: string[]): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_stage", { sessionId, realmId, paths });
}

export function gitUnstage(sessionId: string, realmId: string, paths: string[]): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_unstage", { sessionId, realmId, paths });
}

export function gitCommit(
  sessionId: string,
  realmId: string,
  message: string,
  authorName?: string,
  authorEmail?: string,
): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_commit", {
    sessionId,
    realmId,
    message,
    authorName: authorName ?? null,
    authorEmail: authorEmail ?? null,
  });
}

export function gitPush(sessionId: string, realmId: string, remote?: string): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_push", { sessionId, realmId, remote: remote || null });
}

export function gitPull(sessionId: string, realmId: string, remote?: string): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_pull", { sessionId, realmId, remote: remote || null });
}

export function gitDiff(sessionId: string, realmId: string, filePath: string, staged: boolean): Promise<GitDiff> {
  return invoke<GitDiff>("git_diff", { sessionId, realmId, filePath, staged });
}

export function gitOpenFile(sessionId: string, realmId: string, filePath: string): Promise<void> {
  return invoke("git_open_file", { sessionId, realmId, filePath });
}

export function gitListBranches(sessionId: string, realmId: string): Promise<GitBranch[]> {
  return invoke<GitBranch[]>("git_list_branches", { sessionId, realmId });
}

export function gitListBranchesForRealm(realmId: string): Promise<GitBranch[]> {
  return invoke<GitBranch[]>("git_list_branches_for_realm", { realmId });
}

export function gitBranchesAheadBehind(sessionId: string, realmId: string): Promise<Record<string, [number, number]>> {
  return invoke<Record<string, [number, number]>>("git_branches_ahead_behind", { sessionId, realmId });
}

export function gitCreateBranch(sessionId: string, realmId: string, name: string, checkout: boolean): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_create_branch", { sessionId, realmId, name, checkout });
}

export function gitCheckoutBranch(sessionId: string, realmId: string, name: string): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_checkout_branch", { sessionId, realmId, name });
}

export function gitDeleteBranch(sessionId: string, realmId: string, name: string, force: boolean): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_delete_branch", { sessionId, realmId, name, force });
}

export function listDirectory(sessionId: string, realmId: string, relativePath?: string): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("list_directory", { sessionId, realmId, relativePath: relativePath || null });
}

// ─── File Content API ────────────────────────────────────────────────

export function readFileContent(sessionId: string, realmId: string, filePath: string): Promise<FileContent> {
  return invoke<FileContent>("read_file_content", { sessionId, realmId, filePath });
}

export function openFileInEditor(sessionId: string, realmId: string, filePath: string, editor: string | null): Promise<void> {
  return invoke("open_file_in_editor", { sessionId, realmId, filePath, editor });
}

// ─── SSH File API ────────────────────────────────────────────────────

export function sshListDirectory(sessionId: string, path?: string): Promise<SshFileEntry[]> {
  return invoke<SshFileEntry[]>("ssh_list_directory", { sessionId, path: path || null });
}

export function sshReadFile(sessionId: string, filePath: string): Promise<SshFileContent> {
  return invoke<SshFileContent>("ssh_read_file", { sessionId, filePath });
}

// ─── Stash API ───────────────────────────────────────────────────────

export function gitStashList(sessionId: string, realmId: string): Promise<GitStashEntry[]> {
  return invoke<GitStashEntry[]>("git_stash_list", { sessionId, realmId });
}

export function gitStashSave(
  sessionId: string,
  realmId: string,
  message?: string,
  includeUntracked?: boolean,
): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_stash_save", {
    sessionId,
    realmId,
    message: message ?? null,
    includeUntracked: includeUntracked ?? true,
  });
}

export function gitStashApply(sessionId: string, realmId: string, index: number): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_stash_apply", { sessionId, realmId, index });
}

export function gitStashPop(sessionId: string, realmId: string, index: number): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_stash_pop", { sessionId, realmId, index });
}

export function gitStashDrop(sessionId: string, realmId: string, index: number): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_stash_drop", { sessionId, realmId, index });
}

export function gitStashClear(sessionId: string, realmId: string): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_stash_clear", { sessionId, realmId });
}

// ─── Log / History API ───────────────────────────────────────────────

export function gitLog(sessionId: string, realmId: string, limit?: number, offset?: number): Promise<GitLogResult> {
  return invoke<GitLogResult>("git_log", {
    sessionId,
    realmId,
    limit: limit ?? null,
    offset: offset ?? null,
  });
}

export function gitCommitDetail(sessionId: string, realmId: string, commitHash: string): Promise<GitCommitDetail> {
  return invoke<GitCommitDetail>("git_commit_detail", { sessionId, realmId, commitHash });
}

// ─── Merge / Conflict API ────────────────────────────────────────────

export function gitMergeStatus(sessionId: string, realmId: string): Promise<MergeStatus> {
  return invoke<MergeStatus>("git_merge_status", { sessionId, realmId });
}

export function gitGetConflictContent(sessionId: string, realmId: string, filePath: string): Promise<ConflictContent> {
  return invoke<ConflictContent>("git_get_conflict_content", { sessionId, realmId, filePath });
}

export function gitResolveConflict(
  sessionId: string,
  realmId: string,
  filePath: string,
  strategy: ConflictStrategy,
  manualContent?: string,
): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_resolve_conflict", {
    sessionId,
    realmId,
    filePath,
    strategy,
    manualContent: manualContent ?? null,
  });
}

export function gitAbortMerge(sessionId: string, realmId: string): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_abort_merge", { sessionId, realmId });
}

export function gitContinueMerge(
  sessionId: string,
  realmId: string,
  message?: string,
  authorName?: string,
  authorEmail?: string,
): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_continue_merge", {
    sessionId,
    realmId,
    message: message ?? null,
    authorName: authorName ?? null,
    authorEmail: authorEmail ?? null,
  });
}

// ─── Project Search API ─────────────────────────────────────────────

export function searchProject(
  sessionId: string,
  realmId: string,
  query: string,
  isRegex: boolean,
  caseSensitive: boolean,
  maxResults?: number,
): Promise<SearchResponse> {
  return invoke<SearchResponse>("search_project", {
    sessionId,
    realmId,
    query,
    isRegex,
    caseSensitive,
    maxResults: maxResults ?? null,
  });
}

// ─── Worktree API ───────────────────────────────────────────────────

export async function createWorktree(
  sessionId: string,
  realmId: string,
  branchName: string,
  createBranch: boolean = false,
): Promise<WorktreeCreateResult> {
  return invoke<WorktreeCreateResult>("git_create_worktree", {
    sessionId,
    realmId,
    branchName,
    createBranch,
  });
}

export async function removeWorktree(
  sessionId: string,
  realmId: string,
): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_remove_worktree", { sessionId, realmId });
}

export async function listWorktrees(
  realmId: string,
): Promise<WorktreeInfo[]> {
  return invoke<WorktreeInfo[]>("git_list_worktrees", { realmId });
}

export async function checkBranchAvailable(
  realmId: string,
  branchName: string,
): Promise<BranchAvailability> {
  return invoke<BranchAvailability>("git_check_branch_available", { realmId, branchName });
}

export async function getSessionWorktreeInfo(
  sessionId: string,
  realmId: string,
): Promise<SessionWorktree | null> {
  return invoke<SessionWorktree | null>("git_session_worktree_info", { sessionId, realmId });
}
