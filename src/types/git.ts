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
