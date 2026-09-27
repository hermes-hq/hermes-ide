// ─── Project Types ───────────────────────────────────────────────────

export interface Project {
  id: string;
  path: string;
  name: string;
  languages: string[];
  frameworks: string[];
  architecture: {
    pattern: string;
    layers: string[];
    entry_points: string[];
  } | null;
  conventions: { rule: string; source: string; confidence: number }[];
  scan_status: string;
  last_scanned_at: string | null;
  created_at: string;
  updated_at: string;
  worktree_base_path?: string | null;
}

export interface ProjectOrdered extends Project {
  session_count: number;
  last_opened_at: string | null;
  path_exists: boolean;
}
