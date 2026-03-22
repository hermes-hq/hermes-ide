// ─── Git Types (mirror Rust structs) ─────────────────────────────────

export type GitFileStatus = "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "conflicted";
export type GitFileArea = "staged" | "unstaged" | "untracked";

export interface GitFile {
  path: string;
  status: GitFileStatus;
  area: GitFileArea;
  old_path: string | null;
}

export interface GitProjectStatus {
  project_id: string;
  project_name: string;
  project_path: string;
  is_git_repo: boolean;
  branch: string | null;
  remote_branch: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
  has_conflicts: boolean;
  stash_count: number;
  error: string | null;
}

export interface GitSessionStatus {
  projects: GitProjectStatus[];
  timestamp: number;
}

export interface GitDiff {
  path: string;
  diff_text: string;
  is_binary: boolean;
  additions: number;
  deletions: number;
}

export interface GitOperationResult {
  success: boolean;
  message: string;
  error: string | null;
}

export interface GitBranch {
  name: string;
  is_current: boolean;
  is_remote: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  last_commit_summary: string | null;
}

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_hidden: boolean;
  size: number | null;
  git_status: string | null;
}

// ─── File Content Types ──────────────────────────────────────────────

export interface FileContent {
  content: string;
  file_name: string;
  language: string;
  is_binary: boolean;
  size: number;
  mtime: number;
}

// ─── SSH File Types ──────────────────────────────────────────────────

export interface SshFileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_hidden: boolean;
  size: number | null;
}

export interface SshFileContent {
  content: string;
  file_name: string;
  language: string;
  is_binary: boolean;
  size: number;
}

// ─── Stash Types ─────────────────────────────────────────────────────

export interface GitStashEntry {
  index: number;
  message: string;
  timestamp: number;
  branch_name: string;
}

// ─── Log / History Types ─────────────────────────────────────────────

export interface GitLogEntry {
  hash: string;
  short_hash: string;
  author_name: string;
  author_email: string;
  timestamp: number;
  message: string;
  summary: string;
  parent_count: number;
}

export interface GitLogResult {
  entries: GitLogEntry[];
  has_more: boolean;
  total_traversed: number;
}

export interface GitCommitFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  old_path: string | null;
}

export interface GitCommitDetail {
  hash: string;
  short_hash: string;
  author_name: string;
  author_email: string;
  timestamp: number;
  message: string;
  parent_count: number;
  files: GitCommitFile[];
  total_additions: number;
  total_deletions: number;
}

// ─── Project Search Types ────────────────────────────────────────────

export interface SearchMatch {
  line_number: number;
  line_content: string;
  match_start: number;
  match_end: number;
}

export interface SearchFileResult {
  path: string;
  matches: SearchMatch[];
}

export interface SearchResponse {
  results: SearchFileResult[];
  total_matches: number;
  truncated: boolean;
}

// ─── Merge Conflict Types ────────────────────────────────────────────

// ─── Worktree Types ─────────────────────────────────────────────────

export interface SessionWorktree {
  id: string;
  sessionId: string;
  projectId: string;
  worktreePath: string;
  branchName: string | null;
  isMainWorktree: boolean;
  createdAt: string;
}

export interface WorktreeInfo {
  sessionId: string;
  sessionLabel: string;
  branchName: string | null;
  worktreePath: string;
  isMainWorktree: boolean;
}

export interface BranchAvailability {
  available: boolean;
  usedBySession: string | null;
  branchName: string;
}

export interface WorktreeCreateResult {
  worktreePath: string;
  branchName: string;
  isMainWorktree: boolean;
  /** True when the worktree was reused from another session (branch already checked out). */
  isShared?: boolean;
}

// ─── Worktree Changes Types ──────────────────────────────────────────

export interface WorktreeChangedFile {
  path: string;
  status: string;
}

export interface WorktreeChanges {
  has_changes: boolean;
  files: WorktreeChangedFile[];
}

// ─── Merge Conflict Types ────────────────────────────────────────────

export type ConflictStrategy = "ours" | "theirs" | "manual";

export interface MergeStatus {
  in_merge: boolean;
  conflicted_files: string[];
  resolved_files: string[];
  total_conflicts: number;
  merge_message: string | null;
}

export interface ConflictContent {
  path: string;
  base: string | null;
  ours: string;
  theirs: string;
  working_tree: string;
  is_binary: boolean;
}

// ─── Worktree Overview & Cleanup Types ───────────────────────────────

export interface WorktreeOverviewEntry {
  worktree_path: string;
  branch_name: string | null;
  session_id: string;
  session_label: string;
  project_id: string;
  project_name: string;
  root_path: string;
  is_main_worktree: boolean;
  created_at: string;
  last_activity_at: string | null;
}

export interface OrphanWorktree {
  worktree_path: string;
  branch_name: string | null;
  kind: "directory_only" | "record_only";
  root_path: string | null;
  session_id: string | null;
}

export interface CleanupResult {
  path: string;
  success: boolean;
  error: string | null;
}
