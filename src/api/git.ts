import { invoke } from "@tauri-apps/api/core";
import type { GitSessionStatus, GitDiff, GitOperationResult } from "../types/git";

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
    authorName: authorName || null,
    authorEmail: authorEmail || null,
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
