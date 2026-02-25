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
