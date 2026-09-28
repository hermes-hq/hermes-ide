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

/** F24: resident memory of one session's process tree (src-tauri/src/fleet.rs). */
export interface SessionMemory {
  sessionId: string;
  bytes: number;
  processes: number;
}

/** F24: the processes of one program in a breakdown. */
export interface ProgramMemory {
  name: string;
  processes: number;
  bytes: number;
}

/** F24: Hermes's own memory without its sessions, and each session's. */
export interface FleetMemory {
  appBytes: number;
  appProcesses: number;
  /** What appBytes is made of, by program, largest first. */
  appByProgram: ProgramMemory[];
  /** Strangers left by pid reuse that claim a parent in Hermes's tree; not counted. */
  disowned: ProgramMemory[];
  sessions: SessionMemory[];
}
