import { invoke } from "@tauri-apps/api/core";
import type {
  GitSessionStatus, GitDiff, GitOperationResult, GitBranch, FileEntry, FileContent,
  SshFileEntry, SshFileContent,
  GitStashEntry, GitLogResult, GitCommitDetail, MergeStatus, ConflictContent, ConflictStrategy,
  SearchResponse,
  SessionWorktree, WorktreeInfo, BranchAvailability, WorktreeCreateResult,
  WorktreeChanges,
  WorktreeOverviewEntry, OrphanWorktree, CleanupResult,
} from "../types/git";

export function gitStatus(sessionId: string): Promise<GitSessionStatus> {
  return invoke<GitSessionStatus>("git_status", { sessionId });
}

export function gitStage(sessionId: string, projectId: string, paths: string[]): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_stage", { sessionId, projectId, paths });
}

export function gitUnstage(sessionId: string, projectId: string, paths: string[]): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_unstage", { sessionId, projectId, paths });
}

export function gitCommit(
  sessionId: string,
  projectId: string,
  message: string,
  authorName?: string,
  authorEmail?: string,
): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_commit", {
    sessionId,
    projectId,
    message,
    authorName: authorName ?? null,
    authorEmail: authorEmail ?? null,
  });
}

export function gitPush(sessionId: string, projectId: string, remote?: string): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_push", { sessionId, projectId, remote: remote || null });
}

export function gitPull(sessionId: string, projectId: string, remote?: string): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_pull", { sessionId, projectId, remote: remote || null });
}

export function gitDiff(sessionId: string, projectId: string, filePath: string, staged: boolean): Promise<GitDiff> {
  return invoke<GitDiff>("git_diff", { sessionId, projectId, filePath, staged });
}

export function gitOpenFile(sessionId: string, projectId: string, filePath: string): Promise<void> {
  return invoke("git_open_file", { sessionId, projectId, filePath });
}

export function gitListBranches(sessionId: string, projectId: string): Promise<GitBranch[]> {
  return invoke<GitBranch[]>("git_list_branches", { sessionId, projectId });
}

export function gitListBranchesForProject(projectId: string): Promise<GitBranch[]> {
  return invoke<GitBranch[]>("git_list_branches_for_project", { projectId });
}

export function gitBranchesAheadBehind(sessionId: string, projectId: string): Promise<Record<string, [number, number]>> {
  return invoke<Record<string, [number, number]>>("git_branches_ahead_behind", { sessionId, projectId });
}

export function gitCreateBranch(sessionId: string, projectId: string, name: string, checkout: boolean): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_create_branch", { sessionId, projectId, name, checkout });
}

export function gitCheckoutBranch(sessionId: string, projectId: string, name: string): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_checkout_branch", { sessionId, projectId, name });
}

export function gitDeleteBranch(sessionId: string, projectId: string, name: string, force: boolean): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_delete_branch", { sessionId, projectId, name, force });
}

export function listDirectory(sessionId: string, projectId: string, relativePath?: string): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("list_directory", { sessionId, projectId, relativePath: relativePath || null });
}

// ─── File Content API ────────────────────────────────────────────────

export function readFileContent(sessionId: string, projectId: string, filePath: string): Promise<FileContent> {
  return invoke<FileContent>("read_file_content", { sessionId, projectId, filePath });
}

export function writeFileContent(sessionId: string, projectId: string, filePath: string, content: string): Promise<number> {
  return invoke<number>("write_file_content", { sessionId, projectId, filePath, content });
}

export function openFileInEditor(sessionId: string, projectId: string, filePath: string, editor: string | null): Promise<void> {
  return invoke("open_file_in_editor", { sessionId, projectId, filePath, editor });
}

// ─── SSH File API ────────────────────────────────────────────────────

export function sshListDirectory(sessionId: string, path?: string): Promise<SshFileEntry[]> {
  return invoke<SshFileEntry[]>("ssh_list_directory", { sessionId, path: path || null });
}

export function sshReadFile(sessionId: string, filePath: string): Promise<SshFileContent> {
  return invoke<SshFileContent>("ssh_read_file", { sessionId, filePath });
}

export function sshWriteFile(sessionId: string, filePath: string, content: string): Promise<void> {
  return invoke("ssh_write_file", { sessionId, filePath, content });
}

// ─── Stash API ───────────────────────────────────────────────────────

export function gitStashList(sessionId: string, projectId: string): Promise<GitStashEntry[]> {
  return invoke<GitStashEntry[]>("git_stash_list", { sessionId, projectId });
}

export function gitStashSave(
  sessionId: string,
  projectId: string,
  message?: string,
  includeUntracked?: boolean,
): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_stash_save", {
    sessionId,
    projectId,
    message: message ?? null,
    includeUntracked: includeUntracked ?? true,
  });
}

export function gitStashApply(sessionId: string, projectId: string, index: number): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_stash_apply", { sessionId, projectId, index });
}

export function gitStashPop(sessionId: string, projectId: string, index: number): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_stash_pop", { sessionId, projectId, index });
}

export function gitStashDrop(sessionId: string, projectId: string, index: number): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_stash_drop", { sessionId, projectId, index });
}

export function gitStashClear(sessionId: string, projectId: string): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_stash_clear", { sessionId, projectId });
}

// ─── Log / History API ───────────────────────────────────────────────

export function gitLog(sessionId: string, projectId: string, limit?: number, offset?: number): Promise<GitLogResult> {
  return invoke<GitLogResult>("git_log", {
    sessionId,
    projectId,
    limit: limit ?? null,
    offset: offset ?? null,
  });
}

export function gitCommitDetail(sessionId: string, projectId: string, commitHash: string): Promise<GitCommitDetail> {
  return invoke<GitCommitDetail>("git_commit_detail", { sessionId, projectId, commitHash });
}

// ─── Merge / Conflict API ────────────────────────────────────────────

export function gitMergeStatus(sessionId: string, projectId: string): Promise<MergeStatus> {
  return invoke<MergeStatus>("git_merge_status", { sessionId, projectId });
}

export function gitGetConflictContent(sessionId: string, projectId: string, filePath: string): Promise<ConflictContent> {
  return invoke<ConflictContent>("git_get_conflict_content", { sessionId, projectId, filePath });
}

export function gitResolveConflict(
  sessionId: string,
  projectId: string,
  filePath: string,
  strategy: ConflictStrategy,
  manualContent?: string,
): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_resolve_conflict", {
    sessionId,
    projectId,
    filePath,
    strategy,
    manualContent: manualContent ?? null,
  });
}

export function gitAbortMerge(sessionId: string, projectId: string): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_abort_merge", { sessionId, projectId });
}

export function gitContinueMerge(
  sessionId: string,
  projectId: string,
  message?: string,
  authorName?: string,
  authorEmail?: string,
): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_continue_merge", {
    sessionId,
    projectId,
    message: message ?? null,
    authorName: authorName ?? null,
    authorEmail: authorEmail ?? null,
  });
}

// ─── Project Search API ─────────────────────────────────────────────

export function searchProject(
  sessionId: string,
  projectId: string,
  query: string,
  isRegex: boolean,
  caseSensitive: boolean,
  maxResults?: number,
): Promise<SearchResponse> {
  return invoke<SearchResponse>("search_project", {
    sessionId,
    projectId,
    query,
    isRegex,
    caseSensitive,
    maxResults: maxResults ?? null,
  });
}

// ─── Worktree API ───────────────────────────────────────────────────

export async function createWorktree(
  sessionId: string,
  projectId: string,
  branchName: string,
  createBranch: boolean = false,
): Promise<WorktreeCreateResult> {
  return invoke<WorktreeCreateResult>("git_create_worktree", {
    sessionId,
    projectId,
    branchName,
    createBranch,
  });
}

export async function removeWorktree(
  sessionId: string,
  projectId: string,
): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_remove_worktree", { sessionId, projectId });
}

export async function listWorktrees(
  projectId: string,
): Promise<WorktreeInfo[]> {
  return invoke<WorktreeInfo[]>("git_list_worktrees", { projectId });
}

export async function checkBranchAvailable(
  projectId: string,
  branchName: string,
): Promise<BranchAvailability> {
  return invoke<BranchAvailability>("git_check_branch_available", { projectId, branchName });
}

export async function getSessionWorktreeInfo(
  sessionId: string,
  projectId: string,
): Promise<SessionWorktree | null> {
  return invoke<SessionWorktree | null>("git_session_worktree_info", { sessionId, projectId });
}

export async function listBranchesForProjects(
  projectIds: string[],
): Promise<Record<string, GitBranch[]>> {
  return invoke<Record<string, GitBranch[]>>("git_list_branches_for_projects", { projectIds });
}

export async function isGitRepo(
  projectId: string,
): Promise<boolean> {
  return invoke<boolean>("git_is_git_repo", { projectId });
}

export async function worktreeHasChanges(
  sessionId: string,
  projectId: string,
): Promise<WorktreeChanges> {
  return invoke<WorktreeChanges>("git_worktree_has_changes", { sessionId, projectId });
}

export async function stashWorktree(
  sessionId: string,
  projectId: string,
  message?: string,
): Promise<GitOperationResult> {
  return invoke<GitOperationResult>("git_stash_worktree", { sessionId, projectId, message: message ?? null });
}

// ─── Worktree Overview & Cleanup API ─────────────────────────────────

export async function listAllWorktrees(): Promise<WorktreeOverviewEntry[]> {
  return invoke<WorktreeOverviewEntry[]>("git_list_all_worktrees");
}

export async function detectOrphanWorktrees(): Promise<OrphanWorktree[]> {
  return invoke<OrphanWorktree[]>("git_detect_orphan_worktrees");
}

export async function worktreeDiskUsage(worktreePath: string): Promise<number> {
  return invoke<number>("git_worktree_disk_usage", { worktreePath });
}

export async function cleanupOrphanWorktrees(paths: string[]): Promise<CleanupResult[]> {
  return invoke<CleanupResult[]>("git_cleanup_orphan_worktrees", { paths });
}
