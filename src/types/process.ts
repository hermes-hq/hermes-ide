// ─── Process Types (mirror Rust structs) ─────────────────────────────

export interface ProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  exe_path: string;
  cmd_line: string[];
  cpu_percent: number;
  memory_bytes: number;
  memory_percent: number;
  threads: number;
  user: string;
  status: string;
  start_time: number;
  fd_count: number | null;
  is_hermes_session: boolean;
  is_zombie: boolean;
  is_protected: boolean;
}

export interface ProcessSnapshot {
  processes: ProcessInfo[];
  total_cpu_percent: number;
  total_memory_bytes: number;
  total_memory_available: number;
  timestamp: number;
}

// ─── Sort & Filter ───────────────────────────────────────────────────

export type ProcessSortField =
  | "pid"
  | "name"
  | "cpu_percent"
  | "memory_bytes"
  | "memory_percent"
  | "threads"
  | "ppid"
  | "start_time"
  | "user"
  | "status";

export type SortDirection = "asc" | "desc";

export interface ProcessFilter {
  search: string;
  cpuThreshold: number;
  memThreshold: number;
  showHermesOnly: boolean;
  showZombiesOnly: boolean;
}
