import { invoke } from "@tauri-apps/api/core";
import type {
  GitSessionStatus, GitDiff, GitOperationResult, GitBranch, FileEntry,
  GitStashEntry, GitLogResult, GitCommitDetail, MergeStatus, ConflictContent, ConflictStrategy,
  SearchResponse,
} from "../types/git";

export function gitStatus(sessionId: string): Promise<GitSessionStatus> {
  return invoke<GitSessionStatus>("git_status", { sessionId });
}

export function gitStage(projectPath: string, paths: string[]): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_stage", { projectPath, paths });
}

export function gitUnstage(projectPath: string, paths: string[]): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_unstage", { projectPath, paths });
}

export function gitCommit(
  projectPath: string,
  message: string,
  authorName?: string,
  authorEmail?: string,
): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_commit", {
    projectPath,
    message,
    authorName: authorName ?? null,
    authorEmail: authorEmail ?? null,
  });
}

export function gitPush(projectPath: string, remote?: string): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_push", { projectPath, remote: remote || null });
}

export function gitPull(projectPath: string, remote?: string): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_pull", { projectPath, remote: remote || null });
}

export function gitDiff(projectPath: string, filePath: string, staged: boolean): Promise<GitDiff> {
  return invoke<GitDiff>("git_diff", { projectPath, filePath, staged });
}

export function gitOpenFile(projectPath: string, filePath: string): Promise<void> {
  return invoke("git_open_file", { projectPath, filePath });
}

export function gitListBranches(projectPath: string): Promise<GitBranch[]> {
  return invoke<GitBranch[]>("git_list_branches", { projectPath });
}

export function gitCreateBranch(projectPath: string, name: string, checkout: boolean): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_create_branch", { projectPath, name, checkout });
}

export function gitCheckoutBranch(projectPath: string, name: string): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_checkout_branch", { projectPath, name });
}

export function gitDeleteBranch(projectPath: string, name: string, force: boolean): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_delete_branch", { projectPath, name, force });
}

export function listDirectory(projectPath: string, relativePath?: string): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("list_directory", { projectPath, relativePath: relativePath || null });
}

// ─── Stash API ───────────────────────────────────────────────────────

export function gitStashList(projectPath: string): Promise<GitStashEntry[]> {
  return invoke<GitStashEntry[]>("git_stash_list", { projectPath });
}

export function gitStashSave(
  projectPath: string,
  message?: string,
  includeUntracked?: boolean,
): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_stash_save", {
    projectPath,
    message: message ?? null,
    includeUntracked: includeUntracked ?? true,
  });
}

export function gitStashApply(projectPath: string, index: number): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_stash_apply", { projectPath, index });
}

export function gitStashPop(projectPath: string, index: number): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_stash_pop", { projectPath, index });
}

export function gitStashDrop(projectPath: string, index: number): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_stash_drop", { projectPath, index });
}

export function gitStashClear(projectPath: string): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_stash_clear", { projectPath });
}

// ─── Log / History API ───────────────────────────────────────────────

export function gitLog(projectPath: string, limit?: number, offset?: number): Promise<GitLogResult> {
  return invoke<GitLogResult>("git_log", {
    projectPath,
    limit: limit ?? null,
    offset: offset ?? null,
  });
}

export function gitCommitDetail(projectPath: string, commitHash: string): Promise<GitCommitDetail> {
  return invoke<GitCommitDetail>("git_commit_detail", { projectPath, commitHash });
}

// ─── Merge / Conflict API ────────────────────────────────────────────

export function gitMergeStatus(projectPath: string): Promise<MergeStatus> {
  return invoke<MergeStatus>("git_merge_status", { projectPath });
}

export function gitGetConflictContent(projectPath: string, filePath: string): Promise<ConflictContent> {
  return invoke<ConflictContent>("git_get_conflict_content", { projectPath, filePath });
}

export function gitResolveConflict(
  projectPath: string,
  filePath: string,
  strategy: ConflictStrategy,
  manualContent?: string,
): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_resolve_conflict", {
    projectPath,
    filePath,
    strategy,
    manualContent: manualContent ?? null,
  });
}

export function gitAbortMerge(projectPath: string): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_abort_merge", { projectPath });
}

export function gitContinueMerge(
  projectPath: string,
  message?: string,
  authorName?: string,
  authorEmail?: string,
): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_continue_merge", {
    projectPath,
    message: message ?? null,
    authorName: authorName ?? null,
    authorEmail: authorEmail ?? null,
  });
}

// ─── Project Search API ─────────────────────────────────────────────

export function searchProject(
  projectPath: string,
  query: string,
  isRegex: boolean,
  caseSensitive: boolean,
  maxResults?: number,
): Promise<SearchResponse> {
  return invoke<SearchResponse>("search_project", {
    projectPath,
    query,
    isRegex,
    caseSensitive,
    maxResults: maxResults ?? null,
  });
}
